import Foundation

/// A ligação do modo entregador com o servidor, isolada: as telas e o `CourierViewModel` só falam com este protocolo.
/// Quando o contrato do acesso sem login fechar, muda `HTTPCourierAPI`/`CourierRoutes`, não o resto.
@MainActor
protocol CourierAPI: AnyObject {
    /// Troca o código do QR pela credencial daquela entrega.
    func redeem(_ scan: CourierScan) async throws -> CourierGrant
    func delivery(_ grant: CourierGrant) async throws -> CourierDelivery
    /// Saída para a rota, com o destino geocodificado no aparelho quando o servidor ainda não tem.
    func start(_ grant: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery
    /// Lote de posições: sem `Idempotency-Key` (repetir é seguro).
    func positions(_ grant: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply
    func delivered(_ grant: CourierGrant) async throws
    func cancel(_ grant: CourierGrant, reason: String) async throws
    func messages(_ grant: CourierGrant, with peer: CourierPeer) async throws -> [CourierMessage]
    func send(_ grant: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage
}

/// Os caminhos e campos do contrato, num lugar só. Provisórios: seguem `docs/ENTREGA.md`/`docs/API.md` do
/// `feat/modulo-entrega` para as rotas da entrega; o resgate do QR e a conversa ainda não existem no servidor.
enum CourierRoutes {
    static let redeem = "/api/courier/redeem"
    static func delivery(_ g: CourierGrant) -> String { "/api/v1/profiles/\(g.profileId ?? "-")/entrega/deliveries/\(g.deliveryId)" }
    static func start(_ g: CourierGrant) -> String { delivery(g) + "/start" }
    static func positions(_ g: CourierGrant) -> String { delivery(g) + "/positions" }
    static func delivered(_ g: CourierGrant) -> String { delivery(g) + "/delivered" }
    static func cancel(_ g: CourierGrant) -> String { delivery(g) + "/cancel" }
    static func messages(_ g: CourierGrant, _ peer: CourierPeer) -> String { delivery(g) + "/messages?with=\(peer.rawValue)" }
    static func send(_ g: CourierGrant) -> String { delivery(g) + "/messages" }
    /// Códigos de recusa que querem dizer "esta credencial não vale mais".
    static let revokedCodes: Set<String> = ["revoked", "not_your_delivery", "delivery_closed", "invalid_token", "token_revoked", "module_disabled"]
}

/// O cliente HTTP provisório (o mesmo cuidado do resto do app: só https fora da depuração, token só para a origem).
final class HTTPCourierAPI: CourierAPI {
    private let session: URLSession
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    init(session: URLSession = QueueHTTP.shared) { self.session = session }

    private struct RedeemReply: Decodable { var token: String; var deliveryId: String; var profileId: String?; var label: String? }

    func redeem(_ scan: CourierScan) async throws -> CourierGrant {
        let data = try await call(scan.server.absoluteString, CourierRoutes.redeem, method: "POST", token: nil, body: ["code": scan.code], idempotent: true)
        let reply = try decode(RedeemReply.self, data)
        return CourierGrant(deliveryId: reply.deliveryId, server: scan.server.absoluteString, token: reply.token, profileId: reply.profileId,
                            label: reply.label ?? "Entrega")
    }

    func delivery(_ g: CourierGrant) async throws -> CourierDelivery {
        try decode(CourierDelivery.self, try await call(g.server, CourierRoutes.delivery(g), method: "GET", token: g.token))
    }

    func start(_ g: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery {
        var body: [String: Any] = [:]
        if let destination { body["destination"] = ["lat": destination.lat, "lng": destination.lng] }
        return try decode(CourierDelivery.self, try await call(g.server, CourierRoutes.start(g), method: "POST", token: g.token, body: body, idempotent: true))
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

    func delivered(_ g: CourierGrant) async throws {
        _ = try await call(g.server, CourierRoutes.delivered(g), method: "POST", token: g.token, body: [:], idempotent: true)
    }

    func cancel(_ g: CourierGrant, reason: String) async throws {
        _ = try await call(g.server, CourierRoutes.cancel(g), method: "POST", token: g.token, body: ["reason": reason], idempotent: true)
    }

    private struct MessagesReply: Decodable { var data: [CourierMessage] }

    func messages(_ g: CourierGrant, with peer: CourierPeer) async throws -> [CourierMessage] {
        try decode(MessagesReply.self, try await call(g.server, CourierRoutes.messages(g, peer), method: "GET", token: g.token)).data
    }

    func send(_ g: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage {
        try decode(CourierMessage.self, try await call(g.server, CourierRoutes.send(g), method: "POST", token: g.token, body: ["to": peer.rawValue, "text": text], idempotent: true))
    }

    // MARK: - HTTP

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) } catch { throw CourierError.server("Resposta inesperada do Wabotia.") }
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
        let message = error?["message"] as? String ?? "O Wabotia recusou (\(http.statusCode))."
        if http.statusCode == 401 || http.statusCode == 410 || CourierRoutes.revokedCodes.contains(code) { throw CourierError.revoked }
        if path == CourierRoutes.redeem { throw CourierError.invalidCode(message) }
        if http.statusCode >= 500 || http.statusCode == 429 { throw CourierError.network }
        throw CourierError.server(message)
    }
}
