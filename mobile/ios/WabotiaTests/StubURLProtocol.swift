import Foundation
@testable import Wabotia

/// Servidor de mentira para os testes da fila: cada pedido passa pelo `handler`, e os pedidos ficam guardados (com o
/// corpo lido do stream) para o teste conferir cabeçalhos e corpo.
final class StubURLProtocol: URLProtocol {
    struct Seen {
        let method: String
        let url: URL
        let headers: [String: String]
        let body: Data

        var json: [String: Any] { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:] }
        func header(_ name: String) -> String? { headers.first { $0.key.lowercased() == name.lowercased() }?.value }
    }

    enum Answer {
        case json(Int, String)
        case networkFailure
    }

    private static let lock = NSLock()
    private static var _handler: (Seen) -> Answer = { _ in .json(404, "{}") }
    private static var _seen: [Seen] = []

    static var handler: (Seen) -> Answer {
        get { lock.lock(); defer { lock.unlock() }; return _handler }
        set { lock.lock(); _handler = newValue; lock.unlock() }
    }

    static var seen: [Seen] {
        lock.lock(); defer { lock.unlock() }
        return _seen
    }

    static func reset(_ handler: @escaping (Seen) -> Answer) {
        lock.lock()
        _seen = []
        _handler = handler
        lock.unlock()
    }

    static func session() -> URLSession { QueueHTTP.makeSession(protocols: [StubURLProtocol.self]) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let seen = Seen(
            method: request.httpMethod ?? "GET",
            url: request.url!,
            headers: request.allHTTPHeaderFields ?? [:],
            body: Self.readBody(request)
        )
        Self.lock.lock()
        Self._seen.append(seen)
        let handler = Self._handler
        Self.lock.unlock()
        switch handler(seen) {
        case .networkFailure:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        case let .json(status, text):
            let data = Data(text.utf8)
            let response = HTTPURLResponse(url: seen.url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}
