import XCTest
@testable import Wabotia

/// Demonstração pública (todos os builds): o servidor fictício responde, sem rede, aos fluxos principais (fila,
/// assumir, responder, transferir, protocolos, equipe, ligações) e os dados de exemplo são fictícios.
/// Nada aqui toca na sessão real do app (`AppContainer.shared`): só o servidor em memória e um `SessionStore` isolado.
final class DemoModeTests: XCTestCase {
    private let base = "api/v1/profiles/\(DemoMode.profileId)"

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    /// Chamada direta ao servidor fictício, na fila dele (como faz o `DemoURLProtocol`).
    @discardableResult
    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil, file: StaticString = #filePath, line: UInt = #line) -> Any {
        let url = DemoMode.serverURL.appendingPathComponent(path.components(separatedBy: "?")[0])
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if let query = path.components(separatedBy: "?").dropFirst().first { components.query = query }
        let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let reply = DemoServer.queue.sync { DemoServer.shared.handle(method: method, url: components.url!, body: data) }
        XCTAssertEqual(reply.status, 200, "\(method) \(path)", file: file, line: line)
        return (try? JSONSerialization.jsonObject(with: reply.data)) ?? [:]
    }

    @discardableResult
    private func object(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> [String: Any] {
        call(method, path, body) as? [String: Any] ?? [:]
    }

    private func list(_ path: String) -> [[String: Any]] {
        object("GET", path)["data"] as? [[String: Any]] ?? []
    }

    private func text(_ path: String) -> String {
        let value = call("GET", path)
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }

    func testRecognizesTheDemoServerAndTheTypedShortcut() {
        XCTAssertTrue(DemoMode.isDemo(DemoMode.serverURL))
        XCTAssertTrue(DemoMode.isDemo(URL(string: "https://demo.wabotia.localhost")))
        XCTAssertFalse(DemoMode.isDemo(URL(string: "https://wabotia.empresa.example")))
        XCTAssertFalse(DemoMode.isDemo(nil))
        XCTAssertTrue(DemoMode.wantsDemo(" Demo "))
        XCTAssertFalse(DemoMode.wantsDemo("demo.empresa.example"))
    }

    func testURLProtocolAnswersOnlyTheDemoHost() {
        XCTAssertTrue(DemoURLProtocol.canInit(with: URLRequest(url: DemoMode.serverURL.appendingPathComponent("api/health"))))
        XCTAssertFalse(DemoURLProtocol.canInit(with: URLRequest(url: URL(string: "https://wabotia.empresa.example/api/health")!)))
    }

    func testQueueClaimReplyAndTransfer() {
        XCTAssertTrue(list("\(base)/conversations?state=waiting").contains { $0["id"] as? String == "c_queue" })

        let claimed = object("POST", "\(base)/conversations/c_queue/actions", ["action": "claim"])
        XCTAssertEqual(claimed["state"] as? String, "human")
        XCTAssertEqual(claimed["owner"] as? String, DemoMode.meId)

        let reply = object("POST", "\(base)/conversations/c_queue/actions", ["action": "reply", "text": "Olá! Já estou vendo isso."])
        XCTAssertNotNil(reply["delivery_id"])
        let messages = object("GET", "\(base)/conversations/c_queue")["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(messages.last { $0["direction"] as? String == "outbound" }?["text"] as? String, "Olá! Já estou vendo isso.")

        let transferred = object("POST", "\(base)/conversations/c_rich/actions", ["action": "transfer", "target": "u_ana"])
        XCTAssertEqual(transferred["owner"] as? String, "u_ana")
    }

    func testTicketsTeamAndCalls() {
        XCTAssertTrue(list("\(base)/tickets?active=1").contains { $0["id"] as? String == "t_troca" })
        object("PATCH", "\(base)/tickets/t_troca", ["text": "Andamento registrado na demonstração."])
        let updates = object("GET", "\(base)/tickets/t_troca")["updates"] as? [[String: Any]] ?? []
        XCTAssertEqual(updates.last?["text"] as? String, "Andamento registrado na demonstração.")

        let team = list("\(base)/team")
        XCTAssertTrue(team.contains { $0["kind"] as? String == "user" })
        XCTAssertTrue(team.contains { $0["kind"] as? String == "bot" })
        XCTAssertEqual(list("\(base)/calls").count, 4)
    }

    func testEventsOfANewRunAreNeverBehindACursorSavedBefore() {
        let saved = (object("GET", "\(base)/events?after=0")["cursor"] as? NSNumber)?.int64Value ?? 0
        XCTAssertGreaterThan(saved, 1_700_000_000_000, "o cursor parte do relógio, não de um número fixo")
        DemoServer.reset()
        object("POST", "\(base)/conversations/c_queue/actions", ["action": "claim"])
        let fresh = list("\(base)/events?after=\(saved)")
        XCTAssertTrue(fresh.contains { $0["kind"] as? String == "conversation.updated" })
    }

    func testSampleDataIsFictitious() {
        var all = ""
        let conversations = list("\(base)/conversations")
        XCTAssertFalse(conversations.isEmpty)
        all += text("\(base)/conversations")
        for conversation in conversations { all += text("\(base)/conversations/\(conversation["id"] as? String ?? "")") }
        for path in ["tickets", "team", "lines", "bots", "bot-runs", "calls", "internal-chats", "status", "presence", "menus"] { all += text("\(base)/\(path)") }
        all += text("api/v1/profiles") + text("api/v1/me")

        // Pessoas e empresas reais (inclusive a Queven e os produtos dela) não aparecem nos dados de exemplo.
        for word in ["Queven", "Bruno", "Fagoo", "Printher", "Vinki", "Paulista", ".com.br"] {
            XCTAssertNil(all.range(of: word, options: .caseInsensitive), "\"\(word)\" nos dados de exemplo")
        }
        // Telefones: DDD 20 (inexistente no Brasil) e número começando por 9 0 (faixa sem celulares).
        let phones = matches(#"\b55\d{10,11}\b"#, in: all)
        XCTAssertFalse(phones.isEmpty)
        for phone in phones { XCTAssertTrue(phone.hasPrefix("552090") && phone.count == 13, "telefone \(phone)") }
        // E-mails e links só no domínio reservado .example.
        for email in matches(#"[\w.+-]+@[\w-]+(\.[\w-]+)+"#, in: all) { XCTAssertTrue(email.hasSuffix(".example"), "e-mail \(email)") }
        for link in matches(#"https?:[\\/]+[\w.-]+"#, in: all) { XCTAssertTrue(link.hasSuffix(".example"), "link \(link)") }
        XCTAssertEqual(object("GET", "api/v1/me")["name"] as? String, DemoMode.meName)
    }

    func testVoiceMessagesPlayFromALocalCopy() throws {
        let url = try XCTUnwrap(DemoServer.localFile(mediaId: "md_voz"))
        XCTAssertTrue(url.isFileURL)
        XCTAssertEqual(url.pathExtension, "wav")
        let header = try Data(contentsOf: url).prefix(4)
        XCTAssertEqual(String(data: header, encoding: .ascii), "RIFF")
        XCTAssertNil(DemoServer.localFile(mediaId: "nao-existe"))
    }

    func testRelaunchClearsOnlyTheDemoLocalState() {
        let store = SessionStore(isolatedSuite: "br.com.queven.wabotia.tests.demo")
        store.serverURL = DemoMode.serverURL
        store.token = "wabu_demo"
        store.setCachedData(Data("previa".utf8), "workspace.demo")
        store.setEventCursor(42, profileId: "demo")
        DemoMode.prepareRelaunch(store)
        XCTAssertNil(store.cachedData("workspace.demo"))
        XCTAssertEqual(store.eventCursor(profileId: "demo"), 0)
        XCTAssertEqual(store.token, "wabu_demo", "a sessão da demonstração continua aberta")

        store.serverURL = URL(string: "https://wabotia.empresa.example")
        store.setCachedData(Data("previa".utf8), "workspace.p1")
        DemoMode.prepareRelaunch(store)
        XCTAssertNotNil(store.cachedData("workspace.p1"), "servidor real: nada é apagado")
    }

    private func matches(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range, in: text).map { String(text[$0]) } }
    }
}
