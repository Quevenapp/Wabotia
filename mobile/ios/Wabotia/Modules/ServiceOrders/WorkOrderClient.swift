import Foundation

/// O objeto do serviço escolhido na abertura: um já cadastrado (com a versão lida) ou um novo com os valores.
enum WorkObjectChoice: Equatable {
    case existing(id: String, version: Int)
    case new(typeId: String, values: [String: WorkValue])

    var json: [String: Any] {
        switch self {
        case let .existing(id, version): return ["mode": "existing", "id": id, "version": version]
        case let .new(typeId, values): return ["mode": "new", "type_id": typeId, "values": WorkFields.json(values)]
        }
    }
}

/// O que vai no `POST service-orders` de uma ordem por modelo.
struct WorkOrderDraft: Equatable {
    var typeId: String
    var item: String
    var problem: String
    var extra: [String: WorkValue]
    var notes: String?
    var contactId: String?
    var object: WorkObjectChoice?
    var customerName: String?
    var phone: String?
    var conversationId: String?

    /// Com objeto: `contact_id` + `object`. Sem objeto: nome e telefone do contato (sem `contact_id`). Da conversa:
    /// `conversation_id` e nunca nome nem telefone (o servidor usa o cliente da conversa), como no Android.
    /// `extra` só vai quando há valor.
    var body: [String: Any?] {
        var out: [String: Any?] = ["type_id": typeId, "item": item, "problem": problem]
        if !extra.isEmpty { out["extra"] = WorkFields.json(extra) }
        if let notes, !notes.isEmpty { out["notes"] = notes }
        if let conversationId { out["conversation_id"] = conversationId }
        if let object {
            out["contact_id"] = contactId
            out["object"] = object.json
        } else if conversationId == nil {
            if let customerName, !customerName.isEmpty { out["customer_name"] = customerName }
            if let phone, !phone.isEmpty { out["phone"] = phone }
        }
        return out
    }
}

/// As rotas da ordem por modelo de uma área (`/api/v1/profiles/{p}/service-orders/...`). Toda escrita leva a
/// `Idempotency-Key` da intenção.
final class WorkOrderClient {
    let api: ProfileAPI

    init(api: ProfileAPI) { self.api = api }

    private func get<T: Decodable>(_ path: String, _ query: [String: String?] = [:]) async throws -> T {
        try WorkJSON.decode(T.self, try await api.getData(path, query: query))
    }

    private func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any?], key: String) async throws -> T {
        try WorkJSON.decode(T.self, try await api.sendData(method, path, body, key: key))
    }

    private func enc(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id }

    // MARK: Leitura

    func types() async throws -> WorkTypeCatalog { try await get("service-orders/types") }
    func type(_ id: String) async throws -> WorkTypeView { try await get("service-orders/types/\(enc(id))") }
    func objectTypes() async throws -> [ServiceObjectType] { (try await get("service-orders/object-types") as WorkPage<ServiceObjectType>).data ?? [] }

    func objects(contactId: String, typeId: String) async throws -> WorkPage<ServiceObjectView> {
        try await get("service-orders/objects", ["contact_id": contactId, "type_id": typeId, "include_archived": "0", "limit": "30"])
    }

    func list(_ query: [String: String], cursor: String? = nil, limit: Int = 50) async throws -> WorkOrderPage {
        var q: [String: String?] = query.mapValues { Optional($0) }
        q["cursor"] = cursor
        q["limit"] = String(limit)
        return try await get("service-orders", q)
    }

    func order(_ id: String) async throws -> WorkOrder { try await get("service-orders/\(enc(id))", ["history": "none"]) }

    func history(_ id: String, cursor: String? = nil) async throws -> WorkHistoryPage {
        try await get("service-orders/\(enc(id))/history", ["limit": "50", "cursor": cursor])
    }

    func requirements(_ id: String, transitionId: String) async throws -> OrderRequirements {
        try await get("service-orders/\(enc(id))/requirements", ["transition_id": transitionId])
    }

    func contacts(_ text: String) async throws -> [WorkContact] {
        let page: WorkPage<WorkContact> = try await get("contacts", ["q": text, "identity": "all", "namespace": "team", "limit": "30"])
        return (page.data ?? []).filter(\.selectable)
    }

    func documentContent(orderId: String, documentId: String) async throws -> Data {
        try await api.download("service-orders/\(enc(orderId))/documents/\(enc(documentId))/content")
    }

    // MARK: Escrita

    func create(_ draft: WorkOrderDraft, key: String) async throws -> WorkOrder {
        try await send("POST", "service-orders", draft.body, key: key)
    }

    func changeStage(_ id: String, transitionId: String, version: Int, note: String?, key: String) async throws -> WorkOrder {
        try await send("POST", "service-orders/\(enc(id))/stage", ["transition_id": transitionId, "version": version, "note": note], key: key)
    }

    func requestApproval(_ id: String, transitionId: String, version: Int, key: String) async throws -> WorkOrder {
        try await send("POST", "service-orders/\(enc(id))/stage-approval", ["transition_id": transitionId, "version": version], key: key)
    }

    /// `extra` completo dos campos comuns; nulo explícito apaga o valor.
    func updateExtra(_ id: String, version: Int, extra: [String: WorkValue], key: String) async throws -> WorkOrder {
        try await send("PATCH", "service-orders/\(enc(id))", ["version": version, "extra": WorkFields.json(extra)], key: key)
    }

    func markChecklist(_ id: String, version: Int, itemId: String, done: Bool, photoDocumentId: String? = nil, key: String) async throws -> WorkOrder {
        try await send("POST", "service-orders/\(enc(id))/checklist", ["version": version, "item_id": itemId, "done": done, "photo_document_id": photoDocumentId], key: key)
    }

    func sendQuote(_ id: String, key: String) async throws -> WorkOrder {
        try await send("POST", "service-orders/\(enc(id))/quote/send", ["notify": true], key: key)
    }

    func reserveDocument(_ id: String, name: String, mimeType: String, bytes: Int, key: String) async throws -> DocumentReservation {
        try await send("POST", "service-orders/\(enc(id))/documents", [
            "name": name, "mime_type": mimeType, "expected_bytes": bytes, "client_visible": false, "sensitive": false,
        ], key: key)
    }

    func uploadDocument(_ reservation: DocumentReservation, data: Data, mimeType: String, key: String) async throws -> DocumentUploadResult {
        let raw = try await api.upload(reservation.uploadUrl ?? "", data: data, contentType: mimeType, key: key,
                                       headers: ["Upload-Version": String(reservation.version ?? 0)])
        return try WorkJSON.decode(DocumentUploadResult.self, raw)
    }

    func completeDocument(_ id: String, documentId: String, version: Int, uploadAttempt: String, key: String) async throws -> MutationRef {
        try await send("POST", "service-orders/\(enc(id))/documents/\(enc(documentId))/complete", ["version": version, "upload_attempt": uploadAttempt], key: key)
    }

    /// Foto do checklist: reserva, envio, conclusão, releitura da ordem (versão atual) e marcação com a foto.
    func markWithPhoto(_ id: String, itemId: String, jpeg: Data, progress: @escaping (String) -> Void = { _ in }) async throws -> WorkOrder {
        let ms = BrasiliaTime.millis(Date())
        progress("Enviando a foto…")
        let reservation = try await reserveDocument(id, name: "checklist-\(itemId)-\(ms).jpg", mimeType: "image/jpeg", bytes: jpeg.count, key: QueueClient.newKey())
        let uploaded = try await uploadDocument(reservation, data: jpeg, mimeType: "image/jpeg", key: QueueClient.newKey())
        _ = try await completeDocument(id, documentId: reservation.id, version: uploaded.version ?? 0, uploadAttempt: uploaded.uploadAttempt ?? "", key: QueueClient.newKey())
        progress("Marcando o item…")
        let fresh = try await order(id)
        return try await markChecklist(id, version: fresh.version ?? 0, itemId: itemId, done: true, photoDocumentId: reservation.id, key: QueueClient.newKey())
    }
}
