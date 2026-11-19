import XCTest
@testable import Wabotia

/// XCTest executável no Mac. Inspeção de fonte em Windows não equivale a compilação.
final class ChannelsSecondWaveDemoTests: XCTestCase {
    private typealias Row = [String: Any]
    private let now: Int64 = 1_800_000_000_000
    private var demo: ChannelsSecondWave!
    private var effects: [Row] = []

    override func setUp() {
        super.setUp()
        demo = ChannelsSecondWave(t0: now)
        effects = []
        URLProtocol.registerClass(RejectSecondWaveNetwork.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(RejectSecondWaveNetwork.self)
        DemoServer.reset(channelScenario: .legacy, secondWave: false)
        super.tearDown()
    }

    private func call(_ id: String, action: Row? = nil, key: String? = nil) -> DemoServer.Reply {
        let parts = ["api", "v1", "profiles", "demo", "conversations", id] + (action == nil ? [] : ["message-actions"])
        return demo.route(method: action == nil ? "GET" : "POST", parts: parts,
                          body: action.map { ["action": "channel", "channel_action": $0] } ?? [:], key: key, now: now,
                          emit: { [unowned self] _, payload in self.effects.append(payload) })!
    }

    private func object(_ result: DemoServer.Reply, status: Int = 200, file: StaticString = #filePath, line: UInt = #line) -> Row {
        XCTAssertEqual(result.status, status, file: file, line: line)
        return (try? JSONSerialization.jsonObject(with: result.data)) as? Row ?? [:]
    }

    private func metadata(_ id: String) -> Row {
        ((object(call(id))["channel_extension"] as? Row)?["metadata"] as? Row) ?? [:]
    }

    private func error(_ result: DemoServer.Reply, status: Int = 422) -> String? { (object(result, status: status)["error"] as? Row)?["code"] as? String }
    private func messageCount(_ id: String) -> Int { (object(call(id))["messages"] as? [Row] ?? []).count }

    func testUnusedChannelKeepsLegacyDemoAndExplicitOptInAddsFixtures() throws {
        DemoServer.reset(channelScenario: .legacy, secondWave: false)
        let base = DemoMode.serverURL.appendingPathComponent("api/v1/profiles/demo/status")
        let old = DemoServer.queue.sync { DemoServer.shared.handle(method: "GET", url: base, body: Data()) }
        XCTAssertNil(object(old)["channel_extensions"])
        XCTAssertNil(DemoServer.queue.sync { DemoServer.shared.secondWave })
        let enabledURL = try XCTUnwrap(URL(string: base.absoluteString + "?canais=2"))
        let active = DemoServer.queue.sync { DemoServer.shared.handle(method: "GET", url: enabledURL, body: Data()) }
        let status = object(active)
        XCTAssertTrue((status["conversation_channels"] as? [String] ?? []).contains("email"))
        XCTAssertFalse((status["conversation_channels"] as? [String] ?? []).contains("googlebusiness"))
        let listingURL = DemoMode.serverURL.appendingPathComponent("api/v1/profiles/demo/conversations")
        let listing = DemoServer.queue.sync { DemoServer.shared.handle(method: "GET", url: listingURL, body: Data()) }
        let rows = object(listing)["data"] as? [Row] ?? []
        XCTAssertTrue(rows.contains { $0["id"] as? String == "c_rich" })
        XCTAssertTrue(rows.contains { $0["id"] as? String == "c2_email" })
    }

    func testEveryFixtureDecodesAndUnknownNeverSends() throws {
        for row in demo.conversationRows(now: now) {
            let id = try XCTUnwrap(row["id"] as? String)
            let detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: call(id).data)
            XCTAssertEqual(detail.conversation.id, id)
            XCTAssertFalse(detail.allowsModules)
            if id == "c2_email" { XCTAssertTrue(detail.canChannelAction("email.send", now: now)) }
            if id == "c2_telegram" || id == "c2_tiktok_nine" { XCTAssertTrue(detail.canHumanReply(now: now)) }
            if id == "c2_comment_available" {
                XCTAssertFalse(detail.canHumanReply(now: now))
                XCTAssertTrue(detail.canChannelAction("comment.reply", commentId: "comment-\(id)", now: now))
            }
            if id == "c2_unknown" || id == "c2_telegram_blocked" || id == "c2_tiktok_full" || id == "c2_tiktok_expired" {
                XCTAssertFalse(detail.canHumanReply(now: now))
            }
        }
        XCTAssertEqual(error(call("c2_unknown", action: ["type": "message.send", "text": "Olá"], key: "unknown")), "provider_unknown")
        XCTAssertEqual(demo.reservations, 0)
        XCTAssertTrue(effects.isEmpty)
    }

    func testCommentsKeepAuthorAndPostScopesAndRequireExplicitTarget() throws {
        let a = try XCTUnwrap(metadata("c2_comment_available")["comment"] as? Row)
        let b = try XCTUnwrap(metadata("c2_comment_other_author")["comment"] as? Row)
        let c = try XCTUnwrap(metadata("c2_comment_other_post")["comment"] as? Row)
        XCTAssertEqual(a["postId"] as? String, b["postId"] as? String)
        XCTAssertNotEqual(a["postId"] as? String, c["postId"] as? String)
        XCTAssertEqual(error(call("c2_comment_available", action: ["type": "message.send", "text": "Não publicar"], key: "generic")), "invalid_channel_action")
        XCTAssertEqual(error(call("c2_comment_available", action: ["type": "comment.reply", "commentId": b["id"]!, "text": "Alvo errado"], key: "wrong-target")), "invalid_channel_action")
        let action: Row = ["type": "comment.reply", "commentId": a["id"]!, "text": "Olá! Vamos conferir."]
        let first = call("c2_comment_available", action: action, key: "public")
        let retry = call("c2_comment_available", action: action, key: "public")
        XCTAssertEqual(first.data, retry.data)
        XCTAssertEqual(messageCount("c2_comment_available"), 2)
        XCTAssertEqual(messageCount("c2_comment_other_author"), 1)
        XCTAssertEqual(demo.reservations, 1)
    }

    func testPrivateReplyConsumesAttemptAndVisibilityIsExplicit() throws {
        let id = "c2_comment_available", target = "comment-\(id)"
        let action: Row = ["type": "comment.private", "commentId": target, "text": "Podemos continuar no privado."]
        XCTAssertEqual(call(id, action: action, key: "private").status, 200)
        XCTAssertEqual(call(id, action: action, key: "private").status, 200)
        XCTAssertEqual(error(call(id, action: action, key: "another-private")), "private_reply_used")
        XCTAssertEqual((metadata(id)["comment"] as? Row)?["privateLinkPending"] as? Bool, true)
        for used in ["c2_comment_sent", "c2_comment_failed"] {
            XCTAssertEqual(error(call(used, action: ["type": "comment.private", "commentId": "comment-\(used)", "text": "Olá"], key: used)), "private_reply_used")
        }
        XCTAssertEqual(error(call("c2_comment_expired", action: ["type": "comment.private", "commentId": "comment-c2_comment_expired", "text": "Olá"], key: "expired")), "private_reply_expired")
        XCTAssertEqual(call(id, action: ["type": "comment.visibility", "commentId": target, "hidden": true], key: "hide").status, 200)
        XCTAssertEqual((metadata(id)["comment"] as? Row)?["hidden"] as? Bool, true)
        XCTAssertEqual(call(id, action: ["type": "comment.visibility", "commentId": target, "hidden": false], key: "show").status, 200)
        XCTAssertEqual((metadata(id)["comment"] as? Row)?["hidden"] as? Bool, false)
    }

    func testEmailSubjectIsFrozenWithRetryAndHostileHTMLIsOnlySafeText() throws {
        let detail = call("c2_email")
        XCTAssertFalse(String(data: detail.data, encoding: .utf8)!.contains("<script"))
        XCTAssertFalse(String(data: detail.data, encoding: .utf8)!.contains("<img"))
        XCTAssertEqual((metadata("c2_email")["email"] as? Row)?["identityTrust"] as? String, "unverified_sender")
        let request: Row = ["type": "email.send", "subject": "Re: Pedido #123 · confirmação", "text": "Olá! Vamos conferir."]
        let first = call("c2_email", action: request, key: "email")
        XCTAssertEqual(first.data, call("c2_email", action: request, key: "email").data)
        XCTAssertEqual(messageCount("c2_email"), 2)
        var changed = request
        changed["subject"] = "Outro assunto"
        XCTAssertEqual(error(call("c2_email", action: changed, key: "email"), status: 409), "idempotency_conflict")
        changed["subject"] = "Assunto\r\nBcc: terceiro@cliente.example"
        XCTAssertEqual(error(call("c2_email", action: changed, key: "invalid")), "subject_invalid")
        let unknown = call("c2_email_unknown", action: request, key: "uncertain")
        XCTAssertEqual(object(unknown)["status"] as? String, "unknown")
        XCTAssertEqual(unknown.data, call("c2_email_unknown", action: request, key: "uncertain").data)
        XCTAssertEqual(messageCount("c2_email_unknown"), 1)
        XCTAssertEqual(demo.reservations, 2)
    }

    func testTikTokTwoSlotsAreRejectedThenTenthAllowedAndEleventhBlocked() throws {
        let id = "c2_tiktok_nine"
        let image: Row = ["mediaId": "image-demo", "kind": "image", "mimeType": "image/png", "bytes": 1000]
        XCTAssertEqual(error(call(id, action: ["type": "message.send", "text": "Legenda", "attachments": [image]], key: "two")), "quota_exhausted")
        XCTAssertEqual((metadata(id)["tiktok"] as? Row)?["remainingMessages"] as? Int, 1)
        let action: Row = ["type": "message.send", "text": "Décima mensagem"]
        let sent = call(id, action: action, key: "tenth")
        XCTAssertEqual(sent.status, 200)
        XCTAssertEqual(sent.data, call(id, action: action, key: "tenth").data)
        XCTAssertEqual(error(call(id, action: action, key: "eleventh")), "quota_exhausted")
        XCTAssertEqual((metadata(id)["tiktok"] as? Row)?["remainingMessages"] as? Int, 0)
        XCTAssertEqual(error(call("c2_tiktok_expired", action: action, key: "expired")), "window_closed")
        XCTAssertEqual(messageCount(id), 2)
    }

    func testRepeatedInboundAndLocalEchoDoNotDuplicateOrResetTikTokQuota() {
        let id = "c2_tiktok_nine"
        XCTAssertTrue(demo.receive(eventId: "received", remoteId: "remote", conversationId: id, text: "Nova entrada", occurredAt: now))
        XCTAssertFalse(demo.receive(eventId: "received", remoteId: "remote", conversationId: id, text: "Repetição", occurredAt: now))
        XCTAssertFalse(demo.receive(eventId: "other-event", remoteId: "remote", conversationId: id, text: "Mesmo ID", occurredAt: now))
        XCTAssertEqual((metadata(id)["tiktok"] as? Row)?["remainingMessages"] as? Int, 1)
        XCTAssertEqual(call(id, action: ["type": "message.send", "text": "Décima"], key: "send").status, 200)
        demo.observeTikTokSend(conversationId: id, remoteId: "echo", localSlot: "local-1-0")
        demo.observeTikTokSend(conversationId: id, remoteId: "echo", localSlot: "local-1-0")
        XCTAssertEqual((metadata(id)["tiktok"] as? Row)?["remainingMessages"] as? Int, 0)
        XCTAssertEqual(messageCount(id), 3)
        demo.observeTikTokSend(conversationId: "c2_tiktok_expired", remoteId: "external")
        demo.observeTikTokSend(conversationId: "c2_tiktok_expired", remoteId: "external")
        XCTAssertEqual((metadata("c2_tiktok_expired")["tiktok"] as? Row)?["remainingMessages"] as? Int, 7)
    }

    func testTelegramBlockedAndRateLimitedDoNotSendAndPhoneIsOnlySuggestion() {
        let action: Row = ["type": "message.send", "text": "Olá"]
        XCTAssertEqual(error(call("c2_telegram_blocked", action: action, key: "blocked")), "cannot_initiate")
        XCTAssertEqual(object(call("c2_telegram_rate", action: action, key: "rate"))["code"] as? String, "rate_limited")
        let telegram = metadata("c2_telegram")["telegram"] as? Row
        XCTAssertEqual((telegram?["phoneSuggestion"] as? Row)?["confirmedByHuman"] as? Bool, false)
        XCTAssertEqual(demo.reservations, 0)
        XCTAssertTrue(effects.isEmpty)
    }
}

private final class RejectSecondWaveNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { !DemoURLProtocol.canInit(with: request) }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Chamada inesperada à rede na demo da segunda leva")
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
    }
    override func stopLoading() {}
}
