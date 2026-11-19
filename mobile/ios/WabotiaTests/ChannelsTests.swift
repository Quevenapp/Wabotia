import XCTest
@testable import Wabotia

/// Pendente de execução no Mac. Vitest verifica fontes/contratos; não compila Swift nem substitui XCTest.
final class ChannelsTests: XCTestCase {
    private let hour: Int64 = 3_600_000
    private let start: Int64 = 1_794_146_400_000

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder.wabotia.decode(type, from: Data(json.utf8))
    }

    private func legacyConversation() -> Conversation {
        Conversation(id: "c1", connection_id: "line1", external_namespace: "channel:line1", external_id: "5520900003333")
    }

    private func socialWindow() -> ChannelWindowState {
        ChannelWindowState(kind: "customer", state: "open", serverNow: start,
                           closesAt: start + 24 * hour, humanTextClosesAt: start + 168 * hour,
                           remainingMessages: nil, canHumanText: true, canAutomation: true, reason: nil)
    }

    func testOldDTOStillDecodesAndOnlyRecognizedTransportUsesWhatsApp() throws {
        let json = #"{"conversation":{"id":"c1","profile_id":"p1","connection_id":"line1","external_namespace":"channel:line1","external_id":"5520900003333","state":"human","epoch":1,"last_customer":1,"created":1,"updated":1},"connection_kind":"meta","capabilities":{"image":true},"media":[],"messages":[],"deliveries":[]}"#
        let detail = try decode(ConversationDetail.self, json)
        XCTAssertEqual(detail.resolvedChannel, .whatsapp)
        XCTAssertFalse(detail.isMultichannel)
        XCTAssertNil(detail.email_transcript)
        XCTAssertNil(detail.other_conversations)
        XCTAssertTrue(detail.allowsModules)
        XCTAssertTrue(detail.allowsChannelFeature("image", now: start))
        XCTAssertNil(detail.channelWindow)
        XCTAssertTrue(WindowClock.applies(chatType: "direct", connectionKind: "meta", channel: detail.resolvedChannel, window: nil))
        XCTAssertFalse(WindowClock.applies(chatType: "direct", connectionKind: "qr", channel: .whatsapp, window: nil))
    }

    func testUnknownAndInternalOriginsDoNotBecomeWhatsApp() {
        var conversation = legacyConversation()
        XCTAssertNil(conversation.resolvedChannel(connectionKind: nil))
        XCTAssertNil(conversation.resolvedChannel(connectionKind: "ai"))
        XCTAssertNil(conversation.resolvedChannel(connectionKind: "future_transport"))
        conversation.external_namespace = "unknown"
        XCTAssertNil(conversation.resolvedChannel(connectionKind: "zernio"))
        conversation.external_namespace = "app:crm"
        conversation.channel = .whatsapp
        XCTAssertNil(conversation.resolvedChannel(connectionKind: "zernio"))
        conversation.external_namespace = "channel:line1"
        conversation.channel = .instagram
        XCTAssertEqual(conversation.resolvedChannel(connectionKind: "zernio"), .instagram)
        XCTAssertNil(conversation.resolvedChannel(connectionKind: "ai"))
    }

    func testWhatsAppClosedWindowPreservesCompositionAndQueueing() {
        var detail = ConversationDetail(conversation: legacyConversation())
        detail.connection_kind = "zernio"
        var window = socialWindow()
        window.state = "closed"
        window.canHumanText = false
        window.canAutomation = false
        window.humanTextClosesAt = nil
        detail.window = window
        XCTAssertTrue(detail.canHumanReply(now: start + 25 * hour))
        XCTAssertTrue(detail.allowsModules)
        XCTAssertFalse(detail.isMultichannel)
        detail.capabilities = ["text": .bool(false)]
        XCTAssertFalse(detail.canHumanReply(now: start + 25 * hour))
    }

    func testUnknownChannelPreservesRawValueAndFailsClosed() throws {
        let channel = try decode(ChannelID.self, #""future_network""#)
        XCTAssertEqual(channel.rawValue, "future_network")
        XCTAssertEqual(channel.label, "Canal desconhecido")
        XCTAssertFalse(channel.isKnown)
        var conversation = legacyConversation()
        conversation.channel = channel
        conversation.phone = nil
        XCTAssertEqual(conversation.displayName, "Contato do Canal desconhecido")
        var detail = ConversationDetail(conversation: conversation)
        detail.capabilities = ["image": .bool(true), "modules": .bool(true), "text": .bool(true)]
        XCTAssertEqual(detail.resolvedChannel, channel)
        XCTAssertFalse(detail.canHumanReply(now: start))
        XCTAssertFalse(detail.allowsChannelFeature("image", now: start))
        XCTAssertFalse(detail.allowsModules)
        XCTAssertFalse(WindowClock.applies(chatType: "direct", connectionKind: "zernio", channel: channel, window: nil))
    }

    func testSocialWindowBoundaries24And168Hours() {
        let window = socialWindow()
        XCTAssertEqual(window.projected(at: start + 24 * hour - 1).state, "open")
        let at24 = window.projected(at: start + 24 * hour)
        XCTAssertEqual(at24.state, "human_text_only")
        XCTAssertTrue(at24.canHumanText)
        XCTAssertFalse(at24.canAutomation)
        XCTAssertEqual(at24.reason, "human_only")
        XCTAssertEqual(window.projected(at: start + 25 * hour).state, "human_text_only")
        XCTAssertEqual(window.projected(at: start + 168 * hour - 1).state, "human_text_only")
        let at168 = window.projected(at: start + 168 * hour)
        XCTAssertEqual(at168.state, "closed")
        XCTAssertFalse(at168.canHumanText)
        XCTAssertFalse(at168.canAutomation)
        XCTAssertEqual(at168.reason, "window_closed")
    }

    func testProjectionCannotReopenOrGrantPermissions() {
        var window = socialWindow()
        window.state = "closed"
        window.canHumanText = true // Mesmo DTO inconsistente não abre janela fechada.
        XCTAssertFalse(window.projected(at: start - hour).canHumanText)
        window = socialWindow()
        window.serverNow = start + 168 * hour
        XCTAssertEqual(window.projected(at: start).state, "closed")
        window = socialWindow()
        window.canHumanText = false
        XCTAssertFalse(window.projected(at: start + 25 * hour).canHumanText)
        window = socialWindow()
        window.closesAt = nil
        XCTAssertEqual(window.projected(at: start).state, "closed")
        window = socialWindow()
        window.state = "future_state"
        XCTAssertFalse(window.projected(at: start).canAutomation)
        window = socialWindow()
        window.serverNow = 0
        XCTAssertFalse(window.projected(at: start).canHumanText)
    }

    func testSocialExtensionOnlyAllowsHumanTextAndNeverModules() {
        var conversation = legacyConversation()
        conversation.channel = .instagram
        var detail = ConversationDetail(conversation: conversation)
        detail.window = socialWindow()
        detail.modules = true
        detail.capabilities = ["text": .bool(true), "image": .bool(true), "reaction": .bool(true), "reply": .bool(true)]
        XCTAssertTrue(detail.canHumanReply(now: start + hour))
        XCTAssertTrue(detail.allowsChannelFeature("image", now: start + hour))
        XCTAssertFalse(detail.allowsChannelFeature("reply", now: start + hour))
        XCTAssertFalse(detail.allowsModules)
        XCTAssertTrue(detail.canHumanReply(now: start + 25 * hour))
        XCTAssertFalse(detail.allowsChannelFeature("image", now: start + 25 * hour))
        XCTAssertFalse(detail.allowsChannelFeature("reaction", now: start + 25 * hour))
        XCTAssertFalse(detail.canHumanReply(now: start + 168 * hour))
        detail.window = nil
        XCTAssertFalse(detail.canHumanReply(now: start))
        detail.window = socialWindow()
        detail.conversation.chat_type = "comment"
        XCTAssertFalse(detail.canHumanReply(now: start))
        XCTAssertFalse(detail.allowsChannelFeature("image", now: start))
        detail.conversation.chat_type = "direct"
        detail.window?.kind = "none"
        XCTAssertFalse(detail.canHumanReply(now: start))
    }

    func testNoDeadlineHasNoClockAndFutureChannelsRemainDisabled() {
        let window = ChannelWindowState(kind: "none", state: "open", serverNow: start,
                                        canHumanText: true, canAutomation: true)
        XCTAssertFalse(window.showsClock)
        XCTAssertEqual(WindowClock.channelLabel(window, now: start), "Sem prazo de resposta")
        for channel in [ChannelID.tiktok, .googlebusiness, .telegram, .email] {
            XCTAssertTrue(channel.isKnown)
            XCTAssertFalse(channel.enabled)
        }
    }

    func testWhatsAppOnlyHasNoFilterAndOldStatusDecodes() throws {
        let old = try decode(ProfileStatus.self, #"{"conversations":[],"deliveries":[],"connections":[]}"#)
        XCTAssertFalse(old.showsChannelFilter)
        var status = old
        status.conversation_channels = [.whatsapp]
        XCTAssertFalse(status.showsChannelFilter)
        status.conversation_channels = [.whatsapp, .instagram, .facebook, .instagram, .telegram]
        XCTAssertTrue(status.showsChannelFilter)
        XCTAssertEqual(status.channelFilterOptions, [.whatsapp, .instagram, .facebook])
    }

    @MainActor
    func testChannelParticipatesInListCacheKey() {
        let whatsapp = ConversationsViewModel.cacheKey(profile: "p", channel: .whatsapp, filter: .all, query: "")
        let instagram = ConversationsViewModel.cacheKey(profile: "p", channel: .instagram, filter: .all, query: "")
        let all = ConversationsViewModel.cacheKey(profile: "p", channel: nil, filter: .all, query: "")
        XCTAssertNotEqual(whatsapp, instagram)
        XCTAssertNotEqual(whatsapp, all)
        XCTAssertNotEqual(instagram, ConversationsViewModel.cacheKey(profile: "other", channel: .instagram, filter: .all, query: ""))
        XCTAssertNotEqual(instagram, ConversationsViewModel.cacheKey(profile: "p", channel: .instagram, filter: .queue, query: ""))
        XCTAssertNotEqual(instagram, ConversationsViewModel.cacheKey(profile: "p", channel: .instagram, filter: .all, query: "Ana"))
    }

    func testTranscriptUsesContractBodiesAndPreservesRetryKey() throws {
        let preview = TranscriptPreviewRequest(destination: TranscriptDestination(kind: "custom", address: "ana@example.test"),
                                               range: TranscriptRange(kind: "dates", from: start, to: start + hour))
        let value = try JSONDecoder.wabotia.decode(JSONValue.self, from: JSONEncoder.wabotia.encode(preview))
        XCTAssertEqual(value["destination"]?["address"]?.stringValue, "ana@example.test")
        XCTAssertEqual(value["range"]?["from"]?.intValue, start)
        let body = TranscriptSendRequest(previewToken: "signed-preview", confirmedRecipient: "ana@example.test", customerRequested: true)
        let first = TranscriptAttempt(body: body, key: "same-attempt")
        XCTAssertEqual(TranscriptAttempt.reusing(first, body: body).key, "same-attempt")
        XCTAssertEqual(TranscriptAttempt.reusing(first, body: body).body, body)
        var changed = body
        changed.previewToken = "new-preview"
        XCTAssertNotEqual(TranscriptAttempt.reusing(first, body: changed).key, first.key)
        let sent = try JSONDecoder.wabotia.decode(JSONValue.self, from: JSONEncoder.wabotia.encode(body))
        XCTAssertNil(sent["origin"])
        XCTAssertNil(sent["human"])
        XCTAssertNil(sent["messageTag"])
        XCTAssertEqual(sent["customerRequested"]?.boolValue, true)
        let unknown = TranscriptSendResult(id: "r1", status: "unknown", to_masked: "a***@example.test", duplicate: false)
        XCTAssertTrue(unknown.mustNotRetry)
        XCTAssertTrue(unknown.statusLabel.contains("indeterminado"))
    }

    func testContactOnlyUsesAuthorizedChannelsAndConversationsFromDTO() throws {
        let profile = try decode(ContactChannelsProfile.self, #"{"readable":true,"channels":[{"id":"local-id","channel":"instagram","account_label":"@loja","display_name":"Ana","username":"ana","state":"ready","subject_masked":"***123"}],"other_conversations":[{"id":"allowed","channel":"facebook","account_label":"Loja","title":"Ana","state":"human","updated":1}]}"#)
        XCTAssertEqual(profile.channels?.first?.id, "local-id")
        XCTAssertEqual(profile.channels?.first?.subject_masked, "***123")
        XCTAssertEqual(profile.other_conversations?.map(\.id), ["allowed"])
        XCTAssertEqual(profile.channels?.first?.stateLabel, "Verificado")
    }
}
