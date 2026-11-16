import Foundation

/// A ligação do modo entregador com o servidor, isolada: as telas e o `CourierViewModel` só falam com este protocolo.
/// Contrato em docs/ENTREGA.md ("Contrato do app do entregador") e docs/API.md ("Entrega"), `feat/modulo-entrega`.
@MainActor
protocol CourierAPI: AnyObject {
    /// Leitura pública do QR, sem gastar o código: a loja e o servidor, para o entregador confirmar.
    func preview(_ scan: CourierScan) async throws -> CourierPreview
    /// Troca o código do QR (`https://<servidor>/c/<código>`) por um token `wabx_` só daquela entrega.
    func claim(_ scan: CourierScan, name: String, device: String) async throws -> CourierClaim
    /// `GET …/deliveries/{id}/courier`.
    func delivery(_ grant: CourierGrant) async throws -> CourierDelivery
    /// Saída para a rota, com o destino geocodificado no aparelho quando o servidor ainda não tem.
    func start(_ grant: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery?
    /// Corrigir o pino do destino.
    func setDestination(_ grant: CourierGrant, _ destination: CourierCoordinate) async throws
    /// Lote de posições: sem `Idempotency-Key` (repetir é seguro).
    func positions(_ grant: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply
    func delivered(_ grant: CourierGrant, note: String?) async throws
    func cancel(_ grant: CourierGrant, reason: String) async throws
    /// As mensagens dos dois canais depois de `after`.
    func messages(_ grant: CourierGrant, after: Int) async throws -> CourierMessagesPage
    func send(_ grant: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage
}

/// Os caminhos do contrato, num lugar só.
enum CourierRoutes {
    /// Fora de `/api/v1` e sem autenticação.
    static let claim = "/api/credentials/claim"
    /// Leitura pública (`Accept: application/json`), sem gastar o código. Sempre este caminho, montado do host e do
    /// código, mesmo quando o QR lido é do formato antigo (`/c/<código>`, que não chega ao Worker).
    static func preview(_ code: String) -> String { "/api/public/c/\(code)" }
    static func delivery(_ g: CourierGrant) -> String { "/api/v1/profiles/\(g.profileId ?? "-")/entrega/deliveries/\(g.deliveryId)" }
    static func courier(_ g: CourierGrant) -> String { delivery(g) + "/courier" }
    static func start(_ g: CourierGrant) -> String { delivery(g) + "/start" }
    static func destination(_ g: CourierGrant) -> String { delivery(g) + "/destination" }
    static func positions(_ g: CourierGrant) -> String { delivery(g) + "/positions" }
    static func delivered(_ g: CourierGrant) -> String { delivery(g) + "/delivered" }
    static func cancel(_ g: CourierGrant) -> String { delivery(g) + "/cancel" }
    static func messages(_ g: CourierGrant, after: Int) -> String { delivery(g) + "/messages?after=\(after)" }
    static func send(_ g: CourierGrant) -> String { delivery(g) + "/messages" }
}

/// O cliente HTTP do entregador (o mesmo cuidado do resto do app: só https fora da depuração, token só para a origem).
final class HTTPCourierAPI: CourierAPI {
    private let session: URLSession
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    init(session: URLSession = QueueHTTP.shared) { self.session = session }

    private struct ClaimReply: Decodable {
        struct Payload: Decodable { var delivery: CourierDelivery?; var app: CourierRhythm? }
        var token: String
        var expiresAt: Int64?
        var profile: String
        var module: String?
        var subject: String
        var data: Payload?
    }

    func preview(_ scan: CourierScan) async throws -> CourierPreview {
        guard let url = URL(string: QueueHTTP.normalize(scan.server.absoluteString) + CourierRoutes.preview(scan.code)) else { throw CourierError.server("Endereço inválido.") }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw CourierError.network }
        guard let http = response as? HTTPURLResponse else { throw CourierError.network }
        return try CourierPreviewReply.read(status: http.statusCode, contentType: http.value(forHTTPHeaderField: "Content-Type"), data: data)
    }

    func claim(_ scan: CourierScan, name: String, device: String) async throws -> CourierClaim {
        let data = try await call(scan.server.absoluteString, CourierRoutes.claim, method: "POST", token: nil,
                                  body: ["code": scan.code, "name": name, "device": device], idempotent: false)
        let reply = try decode(ClaimReply.self, data)
        if let module = reply.module, module != "entrega" { throw CourierError.invalidCode("Este QR não é de uma entrega.") }
        var delivery = reply.data?.delivery
        if delivery?.app == nil { delivery?.app = reply.data?.app }
        let grant = CourierGrant(deliveryId: reply.subject, server: scan.server.absoluteString, token: reply.token, profileId: reply.profile,
                                 label: delivery?.label ?? "Entrega", expiresAt: reply.expiresAt)
        return CourierClaim(grant: grant, delivery: delivery)
    }

    func delivery(_ g: CourierGrant) async throws -> CourierDelivery {
        try decode(CourierDelivery.self, try await call(g.server, CourierRoutes.courier(g), method: "GET", token: g.token))
    }

    func start(_ g: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery? {
        var body: [String: Any] = [:]
        if let destination { body["destination"] = ["lat": destination.lat, "lng": destination.lng] }
        return deliveryIn(try await call(g.server, CourierRoutes.start(g), method: "POST", token: g.token, body: body, idempotent: true))
    }

    func setDestination(_ g: CourierGrant, _ destination: CourierCoordinate) async throws {
        _ = try await call(g.server, CourierRoutes.destination(g), method: "POST", token: g.token,
                           body: ["lat": destination.lat, "lng": destination.lng], idempotent: true)
    }

    func positions(_ g: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply {
        var body: [String: Any] = ["points": points.map { p -> [String: Any] in
            var row: [String: Any] = ["t": p.t, "lat": p.lat, "lng": p.lng]
            if let a = p.accuracy { row["accuracy"] = a }
            if let s = p.speed, s >= 0 { row["speed"] = s }
            return row
        }]
        if let battery { body["battery"] = battery }
        return try decode(CourierPositionsReply.self, try await call(g.server, CourierRoutes.positions(g), method: "POST", token: g.token, body: body, idempotent: false))
    }

    func delivered(_ g: CourierGrant, note: String?) async throws {
        var body: [String: Any] = [:]
        if let note, !note.isEmpty { body["note"] = note }
        _ = try await call(g.server, CourierRoutes.delivered(g), method: "POST", token: g.token, body: body, idempotent: true)
    }

    func cancel(_ g: CourierGrant, reason: String) async throws {
        _ = try await call(g.server, CourierRoutes.cancel(g), method: "POST", token: g.token, body: ["reason": reason], idempotent: true)
    }

    func messages(_ g: CourierGrant, after: Int) async throws -> CourierMessagesPage {
        try decode(CourierMessagesPage.self, try await call(g.server, CourierRoutes.messages(g, after: after), method: "GET", token: g.token))
    }

    func send(_ g: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage {
        try decode(CourierMessage.self, try await call(g.server, CourierRoutes.send(g), method: "POST", token: g.token,
                                                         body: ["channel": peer.rawValue, "text": text], idempotent: true))
    }

    // MARK: - HTTP

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) } catch { throw CourierError.server("Resposta inesperada do Wabotia.") }
    }

    /// A entrega na resposta (no topo ou em `delivery`), quando vier.
    private func deliveryIn(_ data: Data) -> CourierDelivery? {
        struct Wrapped: Decodable { var delivery: CourierDelivery }
        return (try? decoder.decode(CourierDelivery.self, from: data)) ?? (try? decoder.decode(Wrapped.self, from: data))?.delivery
    }

    private func call(_ base: String, _ path: String, method: String, token: String?, body: [String: Any]? = nil, idempotent: Bool = false) async throws -> Data {
        guard let url = URL(string: QueueHTTP.normalize(base) + path) else { throw CourierError.server("Endereço inválido.") }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        if idempotent { request.setValue("courier-\(UUID().uuidString)", forHTTPHeaderField: "Idempotency-Key") }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw CourierError.network }
        guard let http = response as? HTTPURLResponse else { throw CourierError.network }
        if (200..<300).contains(http.statusCode) { return data }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = object?["error"] as? [String: Any]
        let code = error?["code"] as? String ?? ""
        let message = error?["message"] as? String
        throw CourierHTTPError.map(status: http.statusCode, code: code, message: message, claim: path == CourierRoutes.claim || path.hasPrefix("/c/"))
    }
}

/// A resposta da leitura pública do QR (testável sem rede).
enum CourierPreviewReply {
    static let outdated = "Este servidor não respondeu como um Wabotia atualizado, ou o QR não é de um pedido. Peça outro QR à loja; se continuar, a loja precisa atualizar o Wabotia."
    static let tooMany = "Muitas tentativas de leitura. Aguarde alguns minutos e tente de novo."

    static func read(status: Int, contentType: String?, data: Data) throws -> CourierPreview {
        if status == 429 { throw CourierError.invalidCode(tooMany) }
        if status >= 500 { throw CourierError.network }
        // HTML (a rota caiu no painel) ou outro conteúdo: servidor desatualizado ou QR inválido, nunca "erro genérico".
        guard (contentType ?? "").lowercased().contains("json") else { throw CourierError.invalidCode(outdated) }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard (200..<300).contains(status), let preview = try? decoder.decode(CourierPreview.self, from: data) else {
            throw CourierError.invalidCode(status == 404 ? outdated : "O Wabotia da loja recusou a leitura (\(status)).")
        }
        return preview
    }
}

/// Como cada recusa do servidor vira um `CourierError` (testável sem rede).
enum CourierHTTPError {
    static func map(status: Int, code: String, message: String?, claim: Bool) -> CourierError {
        if claim {
            switch (status, code) {
            case (404, _): return .invalidCode("Este QR não vale. Peça à loja o QR da entrega.")
            case (410, "claim_used"): return .invalidCode("Este QR já foi lido. Se foi você, a entrega já está neste aparelho; senão, peça um novo à loja.")
            case (410, "claim_expired"): return .invalidCode("Este QR venceu. Peça à loja um novo.")
            case (410, "delivery_closed"): return .invalidCode("Esta entrega já terminou.")
            case (429, _): return .invalidCode("Muitas leituras seguidas. Espere alguns minutos e tente de novo.")
            default: return status >= 500 ? .network : .invalidCode(message ?? "O Wabotia recusou o QR (\(status)).")
            }
        }
        // Qualquer 401 (invalid_token): entrega concluída ou cancelada, QR substituído, prazo vencido.
        if status == 401 { return .revoked }
        if status >= 500 || status == 429 { return .network }
        return .server(message ?? "O Wabotia recusou (\(status)).")
    }
}
