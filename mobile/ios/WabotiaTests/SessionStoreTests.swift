import XCTest
@testable import Wabotia

final class SessionStoreTests: XCTestCase {
    func testNormalizeServerAcceptsBareHost() {
        XCTAssertEqual(SessionStore.normalizeServer("wabotia.queven.com.br")?.absoluteString, "https://wabotia.queven.com.br")
        XCTAssertEqual(SessionStore.normalizeServer(" https://wabotia.fagoo.com.br/app ")?.absoluteString, "https://wabotia.fagoo.com.br")
        XCTAssertEqual(SessionStore.normalizeServer("http://localhost:8787/")?.absoluteString, "http://localhost:8787")
        XCTAssertNil(SessionStore.normalizeServer(""))
        XCTAssertNil(SessionStore.normalizeServer("ftp://x"))
    }

    func testDeepLinkParsing() {
        let link = DeepLink(url: URL(string: "wabotia://open/ticket?profile=p1&ticket=t1")!)
        XCTAssertEqual(link?.type, "ticket")
        XCTAssertEqual(link?.profileId, "p1")
        XCTAssertEqual(link?.ticketId, "t1")
        XCTAssertNil(DeepLink(url: URL(string: "https://example.com")!))
    }

    func testCallDeepLinkKeepsConversation() {
        let link = DeepLink(userInfo: ["type": "call", "profile_id": "p1", "conversation_id": "c1", "call_id": "k1"])
        XCTAssertEqual(link?.type, "call")
        XCTAssertEqual(link?.conversationId, "c1")
    }

    func testClearSessionRemovesCustomerData() {
        let store = SessionStore(isolatedSuite: "br.com.queven.wabotia.tests.session")
        store.serverURL = URL(string: "https://wabotia.exemplo.com.br")
        store.token = "wabu_teste"
        store.profileId = "p1"
        store.pushToken = "fcm"
        store.registeredPushToken = "fcm"
        store.setCachedData(Data("previa".utf8), "workspace.p1")
        store.setEventCursor(42, profileId: "p1")
        let deviceId = store.deviceId

        store.clearSession(keepServer: true)

        XCTAssertNil(store.token)
        XCTAssertNil(store.profileId)
        XCTAssertNil(store.pushToken)
        XCTAssertNil(store.registeredPushToken)
        XCTAssertNil(store.cachedData("workspace.p1"))
        XCTAssertEqual(store.eventCursor(profileId: "p1"), 0)
        XCTAssertEqual(store.serverURL?.absoluteString, "https://wabotia.exemplo.com.br")
        XCTAssertEqual(store.deviceId, deviceId)

        store.clearSession(keepServer: false)
        XCTAssertNil(store.serverURL)
    }

    func testJSONStringColumns() {
        XCTAssertEqual(JSONValue.parseStringList("[\"a\",\"b\"]"), ["a", "b"])
        XCTAssertEqual(JSONValue.parse("{\"reply_to\":\"m1\"}")["reply_to"]?.stringValue, "m1")
        XCTAssertEqual(JSONValue.parse("garbage").objectValue?.isEmpty, true)
    }
}
