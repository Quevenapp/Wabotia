import XCTest
@testable import Wabotia

/// Contratos executáveis da demonstração local. Compilar e executar no Mac/Xcode;
/// os testes TypeScript não compilam Swift nem substituem estes XCTest.
final class ChannelsDemoTests: XCTestCase {
    private typealias Row = [String: Any]
    private let base = "api/v1/profiles/demo"

    override func setUp() {
        super.setUp()
        DemoServer.reset(channelScenario: .multichannel)
        URLProtocol.registerClass(RejectChannelsNetwork.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(RejectChannelsNetwork.self)
        DemoServer.reset(channelScenario: .legacy)
        super.tearDown()
    }

    private func call(_ method: String, _ path: String, _ body: Row? = nil, key: String? = nil) -> DemoServer.Reply {
        var url = URLComponents(url: DemoMode.serverURL.appendingPathComponent(path.components(separatedBy: "?")[0]), resolvingAgainstBaseURL: false)!
        url.query = path.components(separatedBy: "?").dropFirst().first
        let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        return DemoServer.queue.sync { DemoServer.shared.handle(method: method, url: url.url!, body: data, key: key) }
    }

    private func object(_ reply: DemoServer.Reply, status: Int = 200, file: StaticString = #filePath, line: UInt = #line) -> Row {
        XCTAssertEqual(reply.status, status, file: file, line: line)
        return (try? JSONSerialization.jsonObject(with: reply.data)) as? Row ?? [:]
    }

    private func detail(_ id: String) -> Row { object(call("GET", "\(base)/conversations/\(id)")) }

    private func preview(_ id: String = "c_ig_open", destination: Row = ["kind": "self"], key: String = "preview") -> Row {
        object(call("POST", "\(base)/conversations/\(id)/email/preview", ["destination": destination, "range": ["kind": "session"]], key: key))
    }

    func testOnlyWhatsAppKeepsOldDTOAndNewWhatsAppSchemaKeepsSingleChannel() throws {
        DemoServer.reset(channelScenario: .legacy)
        let old = call("GET", "\(base)/conversations/c_rich")
        let decoded = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: old.data)
        XCTAssertEqual(decoded.conversation.id, "c_rich")
        XCTAssertTrue(decoded.allows("image"))
        XCTAssertNil(object(old)["multichannel"])
        XCTAssertNil(object(old)["email_transcript"])
        XCTAssertNil(object(call("GET", "\(base)/status"))["conversation_channels"])

        DemoServer.reset(channelScenario: .whatsappOnly)
        let status = object(call("GET", "\(base)/status"))
        XCTAssertEqual(status["conversation_channels"] as? [String], ["whatsapp"])
        XCTAssertEqual(status["multichannel"] as? Bool, false)
        XCTAssertEqual(detail("c_rich")["modules"] as? Bool, true)
        XCTAssertEqual((detail("c_rich")["email_transcript"] as? Row)?["available"] as? Bool, true)
        XCTAssertFalse((object(call("GET", "\(base)/conversations"))["data"] as? [Row] ?? []).contains { $0["channel"] as? String != "whatsapp" })
    }

    func testFiltersBeforePaginationAndDeclaresFutureChannelsDisabled() throws {
        let status = object(call("GET", "\(base)/status"))
        XCTAssertEqual(status["conversation_channels"] as? [String], ["whatsapp", "instagram", "facebook"])
        let future = status["future_channels"] as? [Row] ?? []
        XCTAssertEqual(future.count, 4)
        XCTAssertTrue(future.allSatisfy { $0["enabled"] as? Bool == false })
        let first = object(call("GET", "\(base)/conversations?channel=instagram&limit=1"))
        let rows = first["data"] as? [Row] ?? []
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?["channel"] as? String, "instagram")
        let cursor = try XCTUnwrap(first["next_cursor"] as? String)
        let second = object(call("GET", "\(base)/conversations?channel=instagram&limit=1&cursor=\(cursor)"))["data"] as? [Row] ?? []
        XCTAssertEqual(second.count, 1)
        XCTAssertNotEqual(second.first?["id"] as? String, rows.first?["id"] as? String)
        XCTAssertEqual(second.first?["channel"] as? String, "instagram")
        XCTAssertEqual(call("GET", "\(base)/conversations?channel=unknown").status, 400)
        XCTAssertEqual((object(call("GET", "\(base)/conversations?channel=telegram"))["data"] as? [Row])?.count, 0)
    }

    func testSocialWindowsModulesAndUnavailableMedia() throws {
        for (id, state) in [("c_ig_open", "open"), ("c_ig_human", "human_text_only"), ("c_fb_closed", "closed")] {
            let data = call("GET", "\(base)/conversations/\(id)")
            _ = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: data.data)
            let row = object(data)
            XCTAssertEqual((row["window"] as? Row)?["state"] as? String, state)
            XCTAssertEqual(row["modules"] as? Bool, false)
            XCTAssertTrue((row["conversation"] as? Row)?["phone"] is NSNull)
        }
        let messages = detail("c_ig_human")["messages"] as? [Row] ?? []
        XCTAssertTrue(messages.first?["text"] as? String == "O anexo ficou indisponível. Ainda preciso de ajuda.")
        XCTAssertEqual(messages.first?["attachments"] as? String, "[]")
        XCTAssertFalse(String(data: call("GET", "\(base)/conversations/c_ig_human").data, encoding: .utf8)?.contains("https://") ?? true)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_human/actions", ["action": "reply", "text": "Resposta humana"], key: "text").status, 200)
        // Formato exato que o composer envia; type=text continua sendo texto humano simples.
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_human/actions", ["action": "reply", "text": "Resposta do aplicativo", "content": ["type": "text"]], key: "app-text").status, 200)
        for (key, content) in [("quoted-text", ["type": "text", "reply_to": "remote-message"]),
                               ("menu-text", ["type": "text", "menu_id": "m_vendas"]),
                               ("location-text", ["type": "location"])] {
            XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_human/actions", ["action": "reply", "text": "Conteúdo adicional", "content": content], key: key).status, 409)
        }
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_human/actions", ["action": "reply", "text": "", "attachments": ["md_foto"]], key: "media").status, 409)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_human/actions", ["action": "menu"], key: "menu").status, 409)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_fb_closed/actions", ["action": "reply", "text": "Tarde demais"], key: "closed").status, 409)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_open/actions", ["action": "form", "form_id": "coleta"], key: "module").status, 400)
    }

    func testProfileHasAuthorizedOtherConversationWithoutMixingMessages() {
        let row = detail("c_ig_open")
        let other = row["other_conversations"] as? [Row] ?? []
        XCTAssertEqual(other.compactMap { $0["id"] as? String }, ["c_rich"])
        XCTAssertTrue((row["messages"] as? [Row] ?? []).allSatisfy { $0["conversation_id"] as? String == "c_ig_open" })
        let profile = object(call("GET", "\(base)/contacts/ct_c_rich/profile"))
        XCTAssertEqual((profile["channels"] as? [Row])?.count, 2)
        XCTAssertEqual(Set((profile["other_conversations"] as? [Row] ?? []).compactMap { $0["id"] as? String }), Set(["c_rich", "c_ig_open"]))
        XCTAssertNil(profile["merge"])
        XCTAssertFalse(String(data: call("GET", "\(base)/contacts/ct_c_rich/profile").data, encoding: .utf8)?.contains("synthetic-subject-") ?? true)
    }

    func testRepeatedConcurrentEventAndRepeatedCommandProduceOneMessage() {
        let before = (detail("c_ig_open")["messages"] as? [Row] ?? []).count
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000) - 1000
        DispatchQueue.concurrentPerform(iterations: 2) { _ in
            DemoServer.queue.sync {
                DemoServer.shared.receiveChannelEvent(eventId: "event-one", messageId: "remote-one", conversationId: "c_ig_open", text: "Evento repetido", occurredAt: timestamp)
            }
        }
        let after = detail("c_ig_open")
        XCTAssertEqual((after["messages"] as? [Row])?.count, before + 1)
        XCTAssertEqual(((after["conversation"] as? Row)?["last_customer"] as? NSNumber)?.int64Value, timestamp)
        let events = object(call("GET", "\(base)/events?after=0"))["data"] as? [Row] ?? []
        XCTAssertEqual(events.filter { ($0["payload"] as? Row)?["message_id"] as? String == "remote-one" }.count, 1)
        let command: Row = ["action": "reply", "text": "Uma única resposta"]
        let first = object(call("POST", "\(base)/conversations/c_ig_open/actions", command, key: "same-command"))
        let second = object(call("POST", "\(base)/conversations/c_ig_open/actions", command, key: "same-command"))
        XCTAssertEqual(first["delivery_id"] as? String, second["delivery_id"] as? String)
        XCTAssertEqual((detail("c_ig_open")["messages"] as? [Row] ?? []).filter { $0["text"] as? String == "Uma única resposta" }.count, 1)
    }

    func testTranscriptPreviewConfirmationAndIdempotentSend() throws {
        let p = preview(destination: ["kind": "contact"])
        XCTAssertEqual(p["messageCount"] as? Int, 1, "Notas internas ficam fora da seleção")
        XCTAssertEqual(p["requiresCustomerRequest"] as? Bool, true)
        let token = try XCTUnwrap(p["previewToken"] as? String)
        let recipient = try XCTUnwrap(p["recipient"] as? String)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_open/email", ["previewToken": token], key: "send").status, 400)
        let body: Row = ["previewToken": token, "confirmedRecipient": recipient, "customerRequested": true]
        let first = object(call("POST", "\(base)/conversations/c_ig_open/email", body, key: "send"))
        let replay = object(call("POST", "\(base)/conversations/c_ig_open/email", body, key: "send"))
        XCTAssertEqual(first["id"] as? String, replay["id"] as? String)
        XCTAssertEqual(replay["duplicate"] as? Bool, true)
        XCTAssertNotEqual(first["to_masked"] as? String, recipient)
        XCTAssertEqual(DemoServer.queue.sync { DemoServer.shared.transcriptReservations }, 1)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_open/email", ["previewToken": token, "confirmedRecipient": "different@cliente.example"], key: "send").status, 409)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_open/email", body).status, 400)
    }

    func testTranscriptSessionSurvivesHumanReplyAndWhatsAppCommandIsIdempotent() {
        let reply: Row = ["action": "reply", "text": "Resposta da equipe", "content": ["type": "text"]]
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_human/actions", reply, key: "human-session").status, 200)
        let transcript = preview("c_ig_human")
        XCTAssertEqual(transcript["messageCount"] as? Int, 2, "Mantém a entrada e a resposta na mesma sessão, sem a nota interna")
        DemoServer.reset(channelScenario: .whatsappOnly)
        let path = "\(base)/conversations/c_rich/actions"
        let first = object(call("POST", path, reply, key: "whatsapp-replay"))
        let replay = object(call("POST", path, reply, key: "whatsapp-replay"))
        XCTAssertEqual(first["delivery_id"] as? String, replay["delivery_id"] as? String)
        XCTAssertEqual((detail("c_rich")["messages"] as? [Row] ?? []).filter { $0["text"] as? String == "Resposta da equipe" }.count, 1)
    }

    func testRequestBuilderPreservesIdempotencyKeyForSameTranscriptAttempt() throws {
        let client = APIClient(baseURL: DemoMode.serverURL, tokenProvider: { "wabu_demo" })
        let body = TranscriptSendRequest(previewToken: "demo-preview", confirmedRecipient: "destino@empresa.example", customerRequested: true)
        let first = TranscriptAttempt.reusing(nil, body: body)
        let retry = TranscriptAttempt.reusing(first, body: body)
        let path = "\(base)/conversations/c_ig_open/email"
        let original = client.buildRequest(.post, path, body: try JSONEncoder.wabotia.encode(first.body), contentType: "application/json", key: first.key)
        let repeated = client.buildRequest(.post, path, body: try JSONEncoder.wabotia.encode(retry.body), contentType: "application/json", key: retry.key)
        XCTAssertEqual(original.value(forHTTPHeaderField: "Idempotency-Key"), repeated.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertEqual(original.value(forHTTPHeaderField: "Idempotency-Key"), first.key)
        let originalBody = try JSONDecoder.wabotia.decode(TranscriptSendRequest.self, from: XCTUnwrap(original.httpBody))
        let repeatedBody = try JSONDecoder.wabotia.decode(TranscriptSendRequest.self, from: XCTUnwrap(repeated.httpBody))
        XCTAssertEqual(originalBody, repeatedBody)
        XCTAssertEqual(repeated.url?.host, DemoMode.host)
        client.session.invalidateAndCancel()
    }

    func testLegacySessionRequiresDatesAndCustomRecipientNeedsConfirmation() throws {
        XCTAssertEqual(call("POST", "\(base)/conversations/c_rich/email/preview", ["destination": ["kind": "self"], "range": ["kind": "session"]], key: "legacy-preview").status, 409)
        let dates: Row = ["destination": ["kind": "self"], "range": ["kind": "dates", "from": 1, "to": Int64(Date().timeIntervalSince1970 * 1000)]]
        XCTAssertEqual(call("POST", "\(base)/conversations/c_rich/email/preview", dates, key: "date-preview").status, 200)
        let custom = preview(destination: ["kind": "custom", "address": "destino@empresa.example"])
        XCTAssertEqual(custom["requiresConfirmation"] as? Bool, true)
        let token = try XCTUnwrap(custom["previewToken"] as? String)
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_open/email", ["previewToken": token], key: "custom-send").status, 400)
    }

    func testUnavailableUnauthorizedAndUnknownDeliveryAreDistinct() throws {
        DemoServer.reset(channelScenario: .unavailableEmail)
        let unavailable = detail("c_ig_open")["email_transcript"] as? Row
        XCTAssertEqual(unavailable?["available"] as? Bool, false)
        XCTAssertTrue(unavailable?["reason"] as? String == "Configure em Gestão → Sistema → E-mail.")
        DemoServer.reset(channelScenario: .noEmailPermission)
        XCTAssertEqual((detail("c_ig_open")["email_transcript"] as? Row)?["destinations"] as? [String], [])
        XCTAssertEqual(call("POST", "\(base)/conversations/c_ig_open/email/preview", ["destination": ["kind": "self"], "range": ["kind": "session"]], key: "forbidden").status, 403)
        DemoServer.reset(channelScenario: .unknownEmailResult)
        let token = try XCTUnwrap(preview()["previewToken"] as? String)
        let first = object(call("POST", "\(base)/conversations/c_ig_open/email", ["previewToken": token], key: "unknown"))
        let retry = object(call("POST", "\(base)/conversations/c_ig_open/email", ["previewToken": token], key: "unknown"))
        XCTAssertEqual(first["status"] as? String, "unknown")
        XCTAssertEqual(retry["status"] as? String, "unknown")
        XCTAssertEqual(first["id"] as? String, retry["id"] as? String)
        XCTAssertEqual(DemoServer.queue.sync { DemoServer.shared.transcriptReservations }, 1)
    }
}

/// Se algum fluxo deixar o servidor em memória, o teste falha antes de abrir conexão.
private final class RejectChannelsNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { !DemoURLProtocol.canInit(with: request) }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Chamada inesperada à rede nos cenários de canais")
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
    }
    override func stopLoading() {}
}
