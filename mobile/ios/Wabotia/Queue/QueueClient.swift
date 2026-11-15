import Foundation

/// Recusa do Wabotia na fila, com o código do contrato (`queue_empty`, `kiosk_rate`, `invalid_transition`…), ou falha
/// de rede (`status == 0`).
struct QueueError: LocalizedError, Equatable {
    var status: Int
    var code: String
    var message: String

    var errorDescription: String? { message }

    /// Falha de rede ou servidor fora do ar: repetir com a mesma `Idempotency-Key` é seguro.
    var retryable: Bool { status == 0 || status == 408 || status >= 500 || code == "operation_unknown" }

    /// A credencial não vale mais (aparelho revogado ou sessão da pessoa encerrada).
    var unauthorized: Bool { status == 401 }

    /// O administrador desligou o módulo da fila (servidor com registro de módulos).
    var moduleDisabled: Bool { code == "module_disabled" }

    static let network = "network"

    static func describe(_ error: Error) -> String {
        (error as? QueueError)?.message ?? error.localizedDescription
    }
}

/// O HTTP da fila: tempos curtos (o totem não pode travar) e o protocolo da demonstração, para o guichê e o modo
/// aparelho abrirem sem servidor real (`demo.wabotia.localhost` nunca sai do aparelho).
enum QueueHTTP {
    static func makeSession(protocols: [AnyClass] = [DemoURLProtocol.self]) -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.protocolClasses = protocols + (config.protocolClasses ?? [])
        return URLSession(configuration: config)
    }

    static let shared = makeSession()

    static var userAgent: String {
        "Wabotia-iOS/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")"
    }

    /// O endereço da instalação sem barra no fim; aceita "wabotia.minhaempresa.com.br" sem https.
    static func normalize(_ base: String) -> String {
        var text = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if !text.hasPrefix("http://") && !text.hasPrefix("https://") { text = "https://" + text }
        return text
    }

    /// Corpo JSON sem as chaves nulas.
    static func body(_ pairs: [(String, Any?)]) -> Data {
        var object: [String: Any] = [:]
        for (key, value) in pairs { if let value { object[key] = value } }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    /// Executa e traduz o erro do contrato (`{error:{code,message}}`) em `QueueError`.
    static func send(_ session: URLSession, _ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw QueueError(status: 0, code: QueueError.network, message: "Sem conexão com o Wabotia.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw QueueError(status: 0, code: QueueError.network, message: "Sem resposta do Wabotia.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let info = try? JSONDecoder().decode(APIErrorBody.self, from: data).error
            let fallback: String
            switch http.statusCode {
            case 401: fallback = "A credencial não vale mais. Conecte de novo."
            case 403: fallback = "Sem permissão para esta ação na fila."
            default: fallback = "O Wabotia recusou (\(http.statusCode))."
            }
            let code = info?.code.isEmpty == false ? info!.code : "http_\(http.statusCode)"
            let message = info?.message.isEmpty == false ? info!.message : fallback
            throw QueueError(status: http.statusCode, code: code, message: message)
        }
        return data
    }

    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try QueueJSON.decoder.decode(T.self, from: data) }
        catch { throw QueueError(status: 200, code: "invalid_response", message: "Resposta inesperada do Wabotia.") }
    }

    static func request(_ url: URL, method: String, token: String?, key: String? = nil, body: Data? = nil) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        if let token, !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let key { r.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if let body {
            r.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            r.httpBody = body
        }
        return r
    }
}

/// O cliente da fila de uma área (`/api/v1/profiles/{p}/queue`). O token vem de quem usa: o do aparelho pareado
/// (`wab_…`) ou o da pessoa logada (`wabu_…`). Toda escrita leva `Idempotency-Key`; quem repete depois de uma queda de
/// rede passa a mesma chave e o Wabotia devolve a mesma resposta (nunca duas senhas, nunca duas chamadas).
final class QueueClient {
    static let ticketActions: Set<String> = ["recall", "start", "finish", "no-show", "cancel"]

    let base: String
    let profileId: String
    private let token: () -> String?
    private let session: URLSession

    init(baseURL: String, profileId: String, session: URLSession = QueueHTTP.shared, token: @escaping () -> String?) {
        self.base = QueueHTTP.normalize(baseURL)
        self.profileId = profileId
        self.token = token
        self.session = session
    }

    private var root: String { base + "/api/v1/profiles/\(profileId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profileId)" }

    /// Chave nova por intenção (toque); repetir a mesma intenção reutiliza a chave.
    static func newKey() -> String { "wabotia-" + UUID().uuidString.lowercased() }

    func overview() async throws -> QueueOverview { try await get("/queue") }

    func ticket(_ id: String) async throws -> QueueTicket { try await get("/queue/tickets/\(id)") }

    /// Cabeçalho e rodapé do cupom (`GET /establishment`, aceita o aparelho pareado).
    func establishment() async throws -> Establishment { try await get("/establishment") }

    /// Emite uma senha (totem: `source` omitido vira `kiosk` no servidor pareado; a equipe manda `staff`).
    func issue(queueId: String, preferential: Bool, key: String = QueueClient.newKey(), source: String? = nil) async throws -> QueueTicket {
        try await post("/queue/tickets", [("queue_id", queueId), ("preferential", preferential), ("source", source)], key: key)
    }

    /// `open`, `paused` ou `closed`. A resposta muda de servidor para servidor; só o sucesso importa.
    func counterState(_ counterId: String, status: String, key: String = QueueClient.newKey()) async throws {
        _ = try await postRaw("/queue/counters/\(counterId)/state", [("status", status)], key: key)
    }

    /// A próxima senha deste guichê; `404 queue_empty` quando não há ninguém.
    func callNext(_ counterId: String, key: String = QueueClient.newKey()) async throws -> QueueTicket {
        try await post("/queue/counters/\(counterId)/call-next", [], key: key)
    }

    /// `recall`, `start`, `finish`, `no-show` ou `cancel`.
    func ticketAction(_ ticketId: String, _ action: String, key: String = QueueClient.newKey()) async throws -> QueueTicket {
        precondition(Self.ticketActions.contains(action), "Ação desconhecida: \(action)")
        return try await post("/queue/tickets/\(ticketId)/\(action)", [], key: key)
    }

    /// Para outra fila (`queue_id`) ou outro guichê (`counter_id`), mantendo a ordem de emissão.
    func transfer(_ ticketId: String, queueId: String? = nil, counterId: String? = nil, key: String = QueueClient.newKey()) async throws -> QueueTicket {
        precondition((queueId == nil) != (counterId == nil), "Escolha uma fila ou um guichê.")
        return try await post("/queue/tickets/\(ticketId)/transfer", [("queue_id", queueId), ("counter_id", counterId)], key: key)
    }

    /// O pedido do WebSocket da fila (`snapshot`, `call`, `pong`), com o mesmo `Authorization`.
    func socketRequest() -> URLRequest? {
        let ws = root.replacingOccurrences(of: "https://", with: "wss://", options: .anchored)
            .replacingOccurrences(of: "http://", with: "ws://", options: .anchored)
        guard let url = URL(string: ws + "/queue/ws") else { return nil }
        var r = QueueHTTP.request(url, method: "GET", token: token())
        r.timeoutInterval = 20
        return r
    }

    private func url(_ path: String) throws -> URL {
        guard let url = URL(string: root + path) else { throw QueueError(status: 0, code: "invalid_url", message: "Endereço do Wabotia inválido.") }
        return url
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await QueueHTTP.send(session, QueueHTTP.request(try url(path), method: "GET", token: token()))
        return try QueueHTTP.decode(T.self, data)
    }

    private func post<T: Decodable>(_ path: String, _ body: [(String, Any?)], key: String) async throws -> T {
        try QueueHTTP.decode(T.self, try await postRaw(path, body, key: key))
    }

    private func postRaw(_ path: String, _ body: [(String, Any?)], key: String) async throws -> Data {
        try await QueueHTTP.send(session, QueueHTTP.request(try url(path), method: "POST", token: token(), key: key, body: QueueHTTP.body(body)))
    }
}

/// Emite a senha do totem. Uma queda de rede (ou erro 5xx) repete uma vez com a **mesma** `Idempotency-Key`: o
/// Wabotia devolve a mesma senha em vez de emitir outra. Recusa do contrato (`kiosk_rate`, `queue_closed`…) não repete.
func issueOnce(_ client: QueueClient, queueId: String, preferential: Bool, key: String = QueueClient.newKey(), pause: UInt64 = 1_500_000_000) async throws -> QueueTicket {
    do {
        return try await client.issue(queueId: queueId, preferential: preferential, key: key)
    } catch let error as QueueError where error.retryable {
        try await Task.sleep(nanoseconds: pause)
        return try await client.issue(queueId: queueId, preferential: preferential, key: key)
    }
}

/// O pareamento por código (RFC 8628, docs/PAREAMENTO.md) com `client=senhapp`, usado pelo modo aparelho.
final class QueuePairing {
    static let client = "senhapp"
    private let session: URLSession

    init(session: URLSession = QueueHTTP.shared) { self.session = session }

    /// Pede o código. `scopes` diz o que o aparelho precisa (ler e emitir): o servidor com `scopes` no pareamento
    /// pré-marca só isso e recusa permissões a mais; o antigo ignora o campo e quem aprova decide.
    func start(baseURL: String, instanceName: String, scopes: [String] = DeviceScopes.requested) async throws -> PairingStart {
        let body = QueueHTTP.body([("client", Self.client), ("instance_name", instanceName.trimmingCharacters(in: .whitespacesAndNewlines)), ("scopes", scopes)])
        let data = try await QueueHTTP.send(session, QueueHTTP.request(try url(baseURL, "/api/pairing/start"), method: "POST", token: nil, body: body))
        return try QueueHTTP.decode(PairingStart.self, data)
    }

    /// `authorization_pending` enquanto o administrador não aprova; `slow_down` (429) pede mais intervalo.
    func poll(baseURL: String, deviceCode: String) async throws -> PairingToken {
        let body = QueueHTTP.body([("client", Self.client), ("device_code", deviceCode)])
        let data = try await QueueHTTP.send(session, QueueHTTP.request(try url(baseURL, "/api/pairing/token"), method: "POST", token: nil, body: body))
        return try QueueHTTP.decode(PairingToken.self, data)
    }

    /// Desfaz o vínculo no servidor (`POST /api/v1/pairings/disconnect` com a própria credencial).
    func disconnect(baseURL: String, token: String) async throws {
        _ = try await QueueHTTP.send(session, QueueHTTP.request(try url(baseURL, "/api/v1/pairings/disconnect"), method: "POST", token: token, key: QueueClient.newKey(), body: Data("{}".utf8)))
    }

    private func url(_ base: String, _ path: String) throws -> URL {
        guard let url = URL(string: QueueHTTP.normalize(base) + path) else { throw QueueError(status: 0, code: "invalid_url", message: "Endereço do Wabotia inválido.") }
        return url
    }
}

/// Um quadro do WebSocket: `snapshot`, `call` ou `pong`.
enum QueueFrame: Equatable {
    case snapshot(QueueOverview)
    case call(CallFrame)
    case pong

    static func parse(_ text: String) -> QueueFrame? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        if type == "pong" { return .pong }
        guard let payload = object["data"], let raw = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        switch type {
        case "snapshot": return (try? QueueJSON.decoder.decode(QueueOverview.self, from: raw)).map(QueueFrame.snapshot)
        case "call": return (try? QueueJSON.decoder.decode(CallFrame.self, from: raw)).map(QueueFrame.call)
        default: return nil
        }
    }
}
