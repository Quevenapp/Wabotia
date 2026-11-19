import XCTest
@testable import Wabotia

/// Pendente de compilação e execução em macOS. Inspeção de fonte não substitui XCTest.
final class ChannelsSecondWaveTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000
    private let hour: Int64 = 3_600_000

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder.wabotia.decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    private func detail(channel: String = "telegram", context: String = "direct",
                        metadata: [String: Any] = [:], extra: [String: Any] = [:]) throws -> ConversationDetail {
        var result: [String: Any] = [
            "conversation": ["id": "c", "profile_id": "p", "connection_id": "line", "external_namespace": "channel:line",
                             "external_id": "subject", "state": "human", "epoch": 1, "last_customer": now,
                             "created": now, "updated": now, "channel": channel, "chat_type": context],
            "media": [], "messages": [], "deliveries": [], "server_now": now,
            "capabilities": ["text": true, "image": true, "modules": true, "subject": channel == "email", "public_reply": context == "comment"],
            "window": ["kind": "none", "state": "open", "serverNow": now, "canHumanText": true, "canAutomation": true],
            "channel_extension": ["key": "\(channel)/\(context)",
                                  "capabilities": ["enabled": true, "text": ["enabled": true, "maxChars": 4096],
                                                   "contexts": [context: ["enabled": true, "bot": true, "publicReply": context == "comment"]],
                                                   "subject": channel == "email", "replyTo": false], "metadata": metadata],
        ]
        for (key, value) in extra { result[key] = value }
        return try decode(ConversationDetail.self, result)
    }

    func testUnusedChannelKeepsWhatsAppPresentation() {
        var detail = ConversationDetail(conversation: Conversation(id: "wa", connection_id: "line", external_namespace: "channel:line"))
        detail.connection_kind = "meta"
        XCTAssertFalse(detail.usesSecondWave)
        XCTAssertNil(detail.channel_extension)
        XCTAssertNil(detail.emailSubject)
        XCTAssertNil(detail.commentContext)
        XCTAssertNil(detail.tiktokContext)
        XCTAssertTrue(detail.canHumanReply(now: now))
        XCTAssertTrue(detail.modulesAllowed(fallbackKind: nil))
        XCTAssertFalse(detail.isMultichannel)
    }

    func testAbsentFieldsAndUnknownChannelFailClosed() throws {
        let empty: [String: Any] = [:]
        let projection = try decode(ChannelExtensionView.self, empty)
        XCTAssertNil(projection.key)
        XCTAssertNil(projection.capabilities)
        XCTAssertNil(projection.metadata)
        let partial = try decode(ChannelExtensionView.self, ["capabilities": ["menu": empty, "text": empty, "window": empty]])
        XCTAssertEqual(partial.capabilities?.menu?.buttons, 0)
        XCTAssertEqual(partial.capabilities?.menu?.fallback, "")
        let partialWindow = try decode(ChannelWindowState.self, ["kind": "none"])
        XCTAssertFalse(partialWindow.projected(at: now).canHumanText)
        var missing = try detail()
        missing.channel_extension = nil
        XCTAssertFalse(missing.canHumanReply(now: now))
        missing = try detail()
        missing.window = nil
        XCTAssertFalse(missing.canHumanReply(now: now))
        let unknown = try detail(channel: "future_network")
        XCTAssertEqual(unknown.resolvedChannel?.rawValue, "future_network")
        XCTAssertFalse(unknown.canHumanReply(now: now))
        XCTAssertFalse(unknown.canChannelAction("message.send", now: now))
        XCTAssertFalse(unknown.allowsChannelFeature("image", now: now))
        XCTAssertFalse(unknown.allowsModules)
    }

    func testCapabilitiesAndPermissionsAreExplicit() throws {
        var telegram = try detail()
        XCTAssertTrue(telegram.canHumanReply(now: now))
        XCTAssertTrue(telegram.canChannelAction("message.send", now: now))
        XCTAssertFalse(telegram.allowsModules)
        XCTAssertFalse(telegram.allowsChannelFeature("reply", now: now))
        telegram.capabilities?["text"] = .bool(false)
        XCTAssertFalse(telegram.canHumanReply(now: now))
        telegram = try detail(metadata: ["telegram": ["blocked": true]])
        XCTAssertFalse(telegram.canHumanReply(now: now))
        telegram = try detail()
        telegram.channel_extension?.capabilities?.enabled = false
        XCTAssertFalse(telegram.canHumanReply(now: now))
        telegram = try detail()
        telegram.channel_extension?.key = "email/direct"
        XCTAssertFalse(telegram.canHumanReply(now: now))
        telegram = try detail()
        telegram.channel_extension?.capabilities?.contexts?["direct"]?.bot = false
        XCTAssertFalse(telegram.channelAutomationAllowed(now: now))
        XCTAssertTrue(telegram.canHumanReply(now: now))
    }

    func testEmailSubjectAndUnverifiedSenderMetadata() throws {
        let email = try detail(channel: "email", metadata: ["email": ["subject": "Re: RE: Pedido 123 — https://example.test",
            "sender": "pessoa@example.test", "from": "Outro <outro@example.test>", "replyTo": "terceiro@example.test",
            "identityTrust": "unverified_sender", "authentication": [["method": "dmarc", "result": "pass"]]]])
        XCTAssertEqual(email.replySubject, "Re: Pedido 123 — https://example.test")
        XCTAssertEqual(email.emailContext?.identityTrust, "unverified_sender")
        XCTAssertEqual(email.emailContext?.authentication?.first?.result, "pass")
        XCTAssertTrue(email.canChannelAction("email.send", now: now))
        XCTAssertFalse(email.canChannelAction("message.send", now: now))
        XCTAssertFalse(email.allowsModules)
        var disabledSubject = email
        disabledSubject.capabilities?["subject"] = .bool(false)
        XCTAssertFalse(disabledSubject.canHumanReply(now: now))
        XCTAssertFalse(disabledSubject.canChannelAction("email.send", now: now))
        XCTAssertTrue(ChannelEmailMetadata.validSubject(String(repeating: "á", count: 200)))
        XCTAssertFalse(ChannelEmailMetadata.validSubject(String(repeating: "a", count: 201)))
        for invalid in ["Assunto\rNovo", "Assunto\nNovo", "Assunto\0Novo"] {
            XCTAssertFalse(ChannelEmailMetadata.validSubject(invalid))
        }
        var message = Message(id: "mail")
        message.content = #"{"email":{"subject":"Assunto alterado"},"html":"<img src='https://example.test/pixel'>"}"#
        XCTAssertEqual(message.channelSubject, "Assunto alterado")
        XCTAssertNil(message.channelComment)
    }

    func testCommentRequiresExplicitActionTargetAndPrivateDeadline() throws {
        let comment: [String: Any] = ["id": "comment-1", "postId": "post-1", "text": "Tem em azul?", "postText": "Novidades",
                                      "hidden": false, "privateState": "available", "privateExpiresAt": now + hour,
                                      "permalink": "https://example.test/publicacao"]
        var value = try detail(channel: "instagram", context: "comment", metadata: ["comment": comment])
        XCTAssertTrue(value.isComment)
        var storedContext = value.conversation
        storedContext.chat_type = "direct"
        storedContext.channel_context = #"{"context":"comment"}"#
        XCTAssertTrue(storedContext.isComment)
        var message = Message(id: "comment-message")
        message.content = #"{"comment":{"id":"comment-1"},"channel_action":"comment.reply"}"#
        XCTAssertTrue(message.isPublicComment)
        XCTAssertFalse(message.isPrivateComment)
        message.content = #"{"comment":{"id":"comment-1"},"channel_action":"comment.private"}"#
        XCTAssertFalse(message.isPublicComment)
        XCTAssertTrue(message.isPrivateComment)
        message.content = #"{"comment":{"id":"comment-1"},"channel_action":{"type":"comment.private"}}"#
        XCTAssertFalse(message.isPublicComment)
        XCTAssertTrue(message.isPrivateComment)
        XCTAssertFalse(value.canHumanReply(now: now))
        XCTAssertFalse(value.channelAutomationAllowed(now: now))
        XCTAssertFalse(value.allowsChannelFeature("menu", now: now))
        XCTAssertFalse(value.canChannelAction("message.send", now: now))
        XCTAssertFalse(value.canChannelAction("comment.reply", now: now))
        XCTAssertFalse(value.canChannelAction("comment.reply", commentId: "unknown", now: now))
        XCTAssertTrue(value.canChannelAction("comment.reply", commentId: "comment-1", now: now))
        XCTAssertTrue(value.canChannelAction("comment.private", commentId: "comment-1", now: now))
        XCTAssertFalse(value.canChannelAction("comment.private", commentId: "comment-1", now: now + hour))
        XCTAssertEqual(value.commentContext?.privateStatusLabel(at: now + hour), "Prazo da resposta privada encerrado")
        var missingDeadline = value.commentContext
        missingDeadline?.privateExpiresAt = nil
        XCTAssertEqual(missingDeadline?.privateStatusLabel(at: now), "Prazo da resposta privada indisponível")
        value.window = nil // Resposta pública não usa a janela de DM.
        XCTAssertTrue(value.canChannelAction("comment.reply", commentId: "comment-1", now: now))
        value.channel_extension?.metadata?.comment?.privateState = "failed"
        XCTAssertFalse(value.canChannelAction("comment.private", commentId: "comment-1", now: now))
        XCTAssertTrue(value.commentContext?.privateStatusLabel.contains("consumida") == true)
        XCTAssertNotNil(value.commentContext?.safePermalink)
        value.channel_extension?.metadata?.comment?.permalink = "javascript:alert(1)"
        XCTAssertNil(value.commentContext?.safePermalink)
        value.capabilities?["public_reply"] = .bool(false)
        XCTAssertFalse(value.canChannelAction("comment.reply", commentId: "comment-1", now: now))
    }

    func testTikTokCounterDeadlineAndNoQuotaReset() throws {
        var value = try detail(channel: "tiktok", metadata: ["tiktok": ["remainingMessages": 1, "closesAt": now + 48 * hour, "conservativeQuota": true]])
        value.window = ChannelWindowState(kind: "customer", state: "open", serverNow: now, closesAt: now + 48 * hour,
                                         remainingMessages: 1, canHumanText: true, canAutomation: true)
        XCTAssertTrue(value.canHumanReply(now: now))
        XCTAssertEqual(value.tiktokContext?.remainingLabel, "Restam 1 de 10 mensagens")
        XCTAssertTrue(WindowClock.channelLabel(value.window!, now: now, channel: .tiktok).contains("48h"))
        XCTAssertFalse(value.canHumanReply(now: now + 48 * hour))
        value.channel_extension?.metadata?.tiktok?.remainingMessages = 0
        value.conversation.last_customer = now + hour
        XCTAssertFalse(value.canHumanReply(now: now + hour)) // Entrada nova não zera a contagem.
        value.channel_extension?.metadata?.tiktok?.remainingMessages = 11
        XCTAssertNil(value.tiktokContext?.remainingLabel)
        XCTAssertFalse(value.canHumanReply(now: now))
        value.channel_extension?.metadata?.tiktok?.remainingMessages = nil
        value.window?.remainingMessages = nil
        XCTAssertFalse(value.canHumanReply(now: now))
    }

    func testRetryFreezesSubjectTargetAndAttachments() throws {
        var action = ChannelAction(type: "email.send", text: "Olá!", subject: "Pedido 123",
            attachments: [ChannelSendAttachment(mediaId: "media-1", kind: "document", mimeType: "application/pdf", bytes: 100, name: "pedido.pdf")])
        let first = ChannelActionAttempt(body: ChannelActionRequest(channel_action: action), key: "same-key")
        action.subject = "Pedido alterado"
        XCTAssertEqual(first.body.channel_action.subject, "Pedido 123")
        XCTAssertEqual(ChannelActionAttempt.reusing(first, body: first.body).key, "same-key")
        XCTAssertNotEqual(ChannelActionAttempt.reusing(first, body: ChannelActionRequest(channel_action: action)).key, "same-key")
        let json = try JSONDecoder.wabotia.decode(JSONValue.self, from: JSONEncoder.wabotia.encode(first.body))
        XCTAssertEqual(json["action"]?.stringValue, "channel")
        XCTAssertEqual(json["channel_action"]?["subject"]?.stringValue, "Pedido 123")
        XCTAssertEqual(json["channel_action"]?["attachments"]?.arrayValue?.first?["mediaId"]?.stringValue, "media-1")
        XCTAssertNil(json["actor"])
        XCTAssertNil(json["origin"])
        XCTAssertNil(json["channel_action"]?["recipient"])
        var comment = ChannelAction(type: "comment.private", text: "Resposta", commentId: "target-1")
        let frozen = ChannelActionAttempt(body: ChannelActionRequest(channel_action: comment), key: "private-key")
        comment.commentId = "target-2"
        XCTAssertEqual(frozen.body.channel_action.commentId, "target-1")
        XCTAssertNotEqual(ChannelActionAttempt.reusing(frozen, body: ChannelActionRequest(channel_action: comment)).key, frozen.key)
    }

    func testOnlyActivatedConversationChannelsAppearInFilter() {
        var status = ProfileStatus()
        status.conversation_channels = [.whatsapp, .telegram, .email, .tiktok, .googlebusiness]
        XCTAssertEqual(status.channelFilterOptions, [.whatsapp])
        status.channel_extensions = ["telegram/direct", "email/direct", "tiktok/direct", "googlebusiness/review"]
        XCTAssertEqual(status.channelFilterOptions, [.whatsapp, .telegram, .email, .tiktok])
        status.conversation_channels = [.whatsapp, .googlebusiness]
        XCTAssertFalse(status.showsChannelFilter)
    }
}
