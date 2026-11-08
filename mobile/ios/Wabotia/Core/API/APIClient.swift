import Foundation

/// Erro devolvido pela API no formato {"error":{"code","message","request_id"}} ou falha de rede traduzida.
struct APIError: LocalizedError, Equatable {
    var status: Int
    var code: String
    var message: String
    var requestId: String?
    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
    var isIdempotencyConflict: Bool { code == "idempotency_conflict" }

    static func describe(_ error: Error) -> String {
        if let e = error as? APIError { return e.message }
        if let e = error as? URLError {
            switch e.code {
            case .cannotFindHost, .dnsLookupFailed: return "Servidor não encontrado. Confira o endereço e a conexão."
            case .timedOut: return "O servidor demorou a responder."
            case .serverCertificateUntrusted, .secureConnectionFailed, .serverCertificateHasBadDate: return "Falha de certificado HTTPS no servidor."
            case .notConnectedToInternet, .networkConnectionLost: return "Sem conexão com a internet."
            default: return "Falha de rede. Verifique sua conexão."
            }
        }
        return error.localizedDescription
    }
}

/// Cliente HTTP para um servidor Wabotia. Acrescenta Authorization: Bearer e Idempotency-Key.
final class APIClient {
    let baseURL: URL
    private let tokenProvider: () -> String?
    let session: URLSession

    init(baseURL: URL, tokenProvider: @escaping () -> String?) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = false
        config.httpAdditionalHeaders = ["Accept": "application/json", "User-Agent": "Wabotia-iOS/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")"]
        self.session = URLSession(configuration: config)
    }

    static func newIdempotencyKey() -> String { UUID().uuidString.lowercased() }

    enum Method: String { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

    /// Requisição JSON genérica. `key` é a Idempotency-Key (obrigatória nas escritas, exceto PUT /devices).
    func request<T: Decodable>(_ method: Method, _ path: String, query: [String: String?] = [:], body: (any Encodable)? = nil, key: String? = nil, as type: T.Type = T.self) async throws -> T {
        let data = try await raw(method, path, query: query, body: body.map { try JSONEncoder.wabotia.encode(AnyEncodable($0)) }, contentType: "application/json", key: key)
        if T.self == OK.self, data.isEmpty { return OK() as! T }
        do { return try JSONDecoder.wabotia.decode(T.self, from: data) }
        catch { throw APIError(status: 200, code: "invalid_response", message: "Resposta inesperada do servidor.") }
    }

    /// Requisição com corpo binário (partes de upload) ou sem decodificação.
    @discardableResult
    func raw(_ method: Method, _ path: String, query: [String: String?] = [:], body: Data? = nil, contentType: String? = nil, key: String? = nil) async throws -> Data {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        if !items.isEmpty { components.queryItems = items }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method.rawValue
        if let token = tokenProvider(), !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, code: "no_response", message: "Sem resposta do servidor.") }
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? JSONDecoder.wabotia.decode(APIErrorBody.self, from: data).error
            let fallback: String
            switch http.statusCode {
            case 401: fallback = "Sessão expirada. Entre novamente."
            case 403: fallback = "Sem permissão para esta ação."
            case 404: fallback = "Recurso não encontrado."
            case 429: fallback = "Muitas requisições. Aguarde um instante."
            default: fallback = "Não foi possível concluir a operação (HTTP \(http.statusCode))."
            }
            throw APIError(status: http.statusCode, code: parsed?.code ?? "http_\(http.statusCode)", message: parsed?.message ?? fallback, requestId: parsed?.request_id)
        }
        return data
    }

    /// URL absoluta de um anexo privado (exige Authorization; use `authorizedRequest`).
    func mediaURL(profileId: String, mediaId: String, inline: Bool = true) -> URL {
        var c = URLComponents(url: baseURL.appendingPathComponent("api/v1/profiles/\(profileId)/media/\(mediaId)/content"), resolvingAgainstBaseURL: false)!
        if inline { c.queryItems = [URLQueryItem(name: "inline", value: "1")] }
        return c.url!
    }

    func authorizedRequest(_ url: URL) -> URLRequest {
        var r = URLRequest(url: url)
        if let token = tokenProvider() { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return r
    }

    /// Cabeçalhos para players (AVPlayer) que não aceitam URLRequest.
    var authorizationHeaders: [String: String] {
        guard let token = tokenProvider() else { return [:] }
        return ["Authorization": "Bearer \(token)"]
    }
}

private struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
