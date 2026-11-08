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

    func testJSONStringColumns() {
        XCTAssertEqual(JSONValue.parseStringList("[\"a\",\"b\"]"), ["a", "b"])
        XCTAssertEqual(JSONValue.parse("{\"reply_to\":\"m1\"}")["reply_to"]?.stringValue, "m1")
        XCTAssertEqual(JSONValue.parse("garbage").objectValue?.isEmpty, true)
    }
}
