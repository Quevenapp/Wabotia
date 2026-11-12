import Foundation

/// Contrato REST do Wabotia consumido pelo aplicativo (docs/API.md + docs/MOBILE.md).
/// Escritas exigem Idempotency-Key: gere uma chave por intenção e reutilize a mesma ao repetir após falha de rede.
extension APIClient {
    // MARK: Descoberta e autenticação
    func health() async throws -> HealthInfo { try await request(.get, "api/health") }
    func authStatus() async throws -> AuthStatus { try await request(.get, "api/auth/status") }
    func mobileLogin(_ body: MobileLoginRequest) async throws -> MobileSession { try await request(.post, "api/auth/mobile/login", body: body) }
    func refresh(key: String = APIClient.newIdempotencyKey()) async throws -> MobileSession { try await request(.post, "api/v1/auth/mobile/refresh", body: [String: String](), key: key) }
    func logout(key: String = APIClient.newIdempotencyKey()) async throws -> OK { try await request(.post, "api/v1/logout", body: [String: String](), key: key) }
    func me() async throws -> Me { try await request(.get, "api/v1/me") }
    func profiles() async throws -> [Profile] { try await request(.get, "api/v1/profiles") }

    // MARK: Dispositivos / push
    func registerDevice(id: String, _ body: DeviceRegistration) async throws -> Device { try await request(.put, "api/v1/devices/\(id)", body: body) }
    /// GET /api/v1/devices devolve `{data:[Device]}`.
    func devices() async throws -> [Device] { try await request(.get, "api/v1/devices", as: Page<Device>.self).data }
    func deleteDevice(id: String) async throws -> OK { try await request(.delete, "api/v1/devices/\(id)") }
    func testDevice(id: String, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.post, "api/v1/devices/\(id)/test", body: [String: String](), key: key) }

    // MARK: Perfil
    func profileStatus(_ p: String) async throws -> ProfileStatus { try await request(.get, "api/v1/profiles/\(p)/status") }
    func presence(_ p: String) async throws -> [PresenceEntry] { try await request(.get, "api/v1/profiles/\(p)/presence") }
    func setPresence(_ p: String, present: Bool, key: String = APIClient.newIdempotencyKey()) async throws -> PresenceResult { try await request(.put, "api/v1/profiles/\(p)/presence", body: PresenceRequest(present: present), key: key) }
    func events(_ p: String, after: Int64) async throws -> Events { try await request(.get, "api/v1/profiles/\(p)/events", query: ["after": String(after)]) }

    // MARK: Conversas
    func conversations(_ p: String, state: String? = nil, q: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> Page<Conversation> {
        try await request(.get, "api/v1/profiles/\(p)/conversations", query: ["state": state, "q": q, "cursor": cursor, "limit": String(limit)])
    }
    func conversation(_ p: String, id: String) async throws -> ConversationDetail { try await request(.get, "api/v1/profiles/\(p)/conversations/\(id)") }
    func act(_ p: String, conversation id: String, _ body: ActionRequest, key: String) async throws -> JSONValue { try await request(.post, "api/v1/profiles/\(p)/conversations/\(id)/actions", body: body, key: key) }
    func messageAction(_ p: String, conversation id: String, _ body: MessageActionRequest, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.post, "api/v1/profiles/\(p)/conversations/\(id)/message-actions", body: body, key: key) }
    func groupPolicy(_ p: String, conversation id: String, policy: String, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.put, "api/v1/profiles/\(p)/groups/\(id)/policy", body: GroupPolicyRequest(bot_policy: policy), key: key) }
    func contact(_ p: String, id: String) async throws -> JSONValue { try await request(.get, "api/v1/profiles/\(p)/contacts/\(id)") }
    /// PUT /conversations/{id}/contact: cria/vincula o cliente na agenda do perfil (apenas conversas diretas).
    func saveConversationContact(_ p: String, conversation id: String, name: String, phone: String?, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue {
        var body: [String: String] = ["name": name]
        if let phone, !phone.isEmpty { body["phone"] = phone }
        return try await request(.put, "api/v1/profiles/\(p)/conversations/\(id)/contact", body: body, key: key)
    }

    // MARK: Mídia (upload em partes de 5 MiB)
    func uploadCreate(_ p: String, _ body: UploadInit, key: String = APIClient.newIdempotencyKey()) async throws -> UploadCreated { try await request(.post, "api/v1/profiles/\(p)/media/uploads", body: body, key: key) }
    func uploadPart(_ p: String, upload id: String, part: Int, data: Data) async throws {
        try await raw(.put, "api/v1/profiles/\(p)/media/uploads/\(id)/parts/\(part)", body: data, contentType: "application/octet-stream", key: "\(id):\(part)")
    }
    func uploadComplete(_ p: String, upload id: String, key: String = APIClient.newIdempotencyKey()) async throws -> UploadDone { try await request(.post, "api/v1/profiles/\(p)/media/uploads/\(id)/complete", body: [String: String](), key: key) }
    func uploadAbort(_ p: String, upload id: String, key: String = APIClient.newIdempotencyKey()) async throws -> UploadDone { try await request(.post, "api/v1/profiles/\(p)/media/uploads/\(id)/abort", body: [String: String](), key: key) }

    /// Envia um arquivo inteiro em partes e devolve o ID da mídia para usar em `attachments`.
    func uploadFile(_ p: String, data: Data, name: String, type: String, progress: ((Double) -> Void)? = nil) async throws -> String {
        let created = try await uploadCreate(p, UploadInit(name: name, type: type, size: Int64(data.count)))
        do {
            let partSize = Int(created.part_size)
            for part in 0..<created.parts {
                let start = part * partSize
                let end = min(start + partSize, data.count)
                try await uploadPart(p, upload: created.id, part: part + 1, data: data.subdata(in: start..<end))
                progress?(Double(part + 1) / Double(created.parts))
            }
            return try await uploadComplete(p, upload: created.id).id
        } catch {
            _ = try? await uploadAbort(p, upload: created.id)
            throw error
        }
    }

    // MARK: Protocolos
    /// `q`: número do protocolo (`WA-…`) ou dígitos do telefone do cliente.
    /// `active` (servidor 0.14+): só protocolos ativos, nem `resolved` nem `closed`; servidores antigos ignoram.
    /// `category` (0.14+): `id` da categoria.
    func tickets(_ p: String, status: String? = nil, overdue: Bool = false, q: String? = nil, cursor: String? = nil, active: Bool = false, category: String? = nil) async throws -> Page<Ticket> {
        try await request(.get, "api/v1/profiles/\(p)/tickets", query: ["status": status, "overdue": overdue ? "1" : nil, "active": active ? "1" : nil, "category": category, "q": q, "cursor": cursor, "limit": "100"])
    }
    func ticket(_ p: String, id: String) async throws -> TicketDetail { try await request(.get, "api/v1/profiles/\(p)/tickets/\(id)") }
    func createTicket(_ p: String, _ body: TicketCreate, key: String = APIClient.newIdempotencyKey()) async throws -> Ticket { try await request(.post, "api/v1/profiles/\(p)/tickets", body: body, key: key) }
    /// `fields` livre porque `response_due_at: null` e `category: null` precisam ser enviados explicitamente para limpar o campo.
    func updateTicket(_ p: String, id: String, fields: [String: JSONValue], key: String = APIClient.newIdempotencyKey()) async throws -> Ticket { try await request(.patch, "api/v1/profiles/\(p)/tickets/\(id)", body: fields, key: key) }

    // MARK: Bots
    func bots(_ p: String) async throws -> Page<Bot> { try await request(.get, "api/v1/profiles/\(p)/bots") }
    func botRuns(_ p: String, cursor: String? = nil) async throws -> Page<BotRun> { try await request(.get, "api/v1/profiles/\(p)/bot-runs", query: ["cursor": cursor, "limit": "100"]) }
    func startBotRun(_ body: BotRunRequest, key: String = APIClient.newIdempotencyKey()) async throws -> BotRun { try await request(.post, "api/v1/bot-runs", body: body, key: key) }
    func botRun(id: String) async throws -> BotRun { try await request(.get, "api/v1/bot-runs/\(id)") }
    func cancelBotRun(_ p: String, id: String, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.post, "api/v1/profiles/\(p)/bot-runs/\(id)/cancel", body: [String: String](), key: key) }

    // MARK: Ligações (Meta Calling API, sinalização WebRTC)
    func calls(_ p: String, conversationId: String? = nil, limit: Int = 30, cursor: String? = nil) async throws -> Page<Call> {
        try await request(.get, "api/v1/profiles/\(p)/calls", query: ["conversation_id": conversationId, "limit": String(limit), "cursor": cursor])
    }
    func call(_ p: String, id: String, session: Bool = false) async throws -> Call { try await request(.get, "api/v1/profiles/\(p)/calls/\(id)", query: ["session": session ? "1" : nil]) }
    func callPermission(_ p: String, conversation id: String) async throws -> JSONValue { try await request(.get, "api/v1/profiles/\(p)/conversations/\(id)/call-permission") }
    func requestCallPermission(_ p: String, conversation id: String, key: String = APIClient.newIdempotencyKey()) async throws -> CallActionResult { try await request(.post, "api/v1/profiles/\(p)/calls/permission", body: CallPermissionRequest(conversation_id: id), key: key) }
    func startCall(_ p: String, _ body: CallStart, key: String = APIClient.newIdempotencyKey()) async throws -> Call { try await request(.post, "api/v1/profiles/\(p)/calls", body: body, key: key) }
    func claimCall(_ p: String, id: String, key: String = APIClient.newIdempotencyKey()) async throws -> Call { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/claim", body: [String: String](), key: key) }
    func preAcceptCall(_ p: String, id: String, session: CallSession, key: String = APIClient.newIdempotencyKey()) async throws -> CallActionResult { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/pre_accept", body: CallAccept(session: session), key: key) }
    func acceptCall(_ p: String, id: String, session: CallSession, key: String = APIClient.newIdempotencyKey()) async throws -> CallActionResult { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/accept", body: CallAccept(session: session), key: key) }
    func rejectCall(_ p: String, id: String, key: String = APIClient.newIdempotencyKey()) async throws -> CallActionResult { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/reject", body: [String: String](), key: key) }
    func terminateCall(_ p: String, id: String, key: String = APIClient.newIdempotencyKey()) async throws -> CallActionResult { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/terminate", body: [String: String](), key: key) }
    func keepaliveCall(_ p: String, id: String, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/keepalive", body: [String: String](), key: key) }
    func reconcileCall(_ p: String, id: String, key: String = APIClient.newIdempotencyKey()) async throws -> CallActionResult { try await request(.post, "api/v1/profiles/\(p)/calls/\(id)/reconcile", body: CallReconcile(), key: key) }
}
