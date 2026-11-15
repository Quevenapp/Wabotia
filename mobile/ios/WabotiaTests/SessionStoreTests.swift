import XCTest
@testable import Wabotia

final class SessionStoreTests: XCTestCase {
    func testNormalizeServerAcceptsBareHost() {
        XCTAssertEqual(SessionStore.normalizeServer("wabotia.queven.com.br")?.absoluteString, "https://wabotia.queven.com.br")
        XCTAssertEqual(SessionStore.normalizeServer(" https://wabotia.fagoo.com.br/app ")?.absoluteString, "https://wabotia.fagoo.com.br")
        XCTAssertEqual(SessionStore.normalizeServer("http://localhost:8787/", allowCleartext: true)?.absoluteString, "http://localhost:8787")
        XCTAssertEqual(SessionStore.normalizeServer("http://wabotia.local/", allowCleartext: false)?.absoluteString, "https://wabotia.local", "build de loja: nunca sem TLS")
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

    func testTokenIsBoundToTheServerThatIssuedIt() {
        let store = SessionStore(isolatedSuite: "br.com.queven.wabotia.tests.origin")
        store.serverURL = URL(string: "https://wabotia.empresa.example")
        store.token = "wabu_teste"
        XCTAssertEqual(store.token, "wabu_teste")
        XCTAssertEqual(store.token(for: URL(string: "https://WABOTIA.empresa.example")!), "wabu_teste")
        XCTAssertNil(store.token(for: URL(string: "https://wabotia.outra.example")!), "outro servidor não recebe o token")
        XCTAssertNil(store.token(for: URL(string: "http://wabotia.empresa.example")!), "nem a mesma máquina sem TLS")
        XCTAssertNil(store.token(for: URL(string: "https://wabotia.empresa.example:8443")!))
        store.serverURL = URL(string: "https://wabotia.outra.example")
        XCTAssertNil(store.token, "trocar o servidor não leva o token junto")
        store.serverURL = nil
        XCTAssertNil(store.token, "sem servidor (app reinstalado) não há token")
    }

    func testPublicRoutesNeverCarryTheToken() {
        let client = APIClient(baseURL: URL(string: "https://wabotia.empresa.example")!) { "wabu_teste" }
        XCTAssertNil(client.buildRequest(.get, "api/health", authorized: false).value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(client.buildRequest(.get, "api/v1/me").value(forHTTPHeaderField: "Authorization"), "Bearer wabu_teste")
    }

    func testKeychainIsClearedOnTheFirstLaunchOfANewInstall() {
        let suiteName = "br.com.queven.wabotia.tests.install"
        let service = "br.com.queven.wabotia.tests.install-keychain"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        Keychain.write("wab_antigo", service: service, account: "config")
        Keychain.write("1234", service: service, account: "pin")

        // Atualização: as preferências já existem, nada é apagado.
        defaults.set("https://wabotia.empresa.example", forKey: "server")
        SessionStore.resetKeychainAfterReinstall(defaults: defaults, domain: suiteName, services: [service])
        XCTAssertEqual(Keychain.read(service: service, account: "config"), "wab_antigo")

        // Instalação nova: preferências vazias (o iOS apagou), o Keychain que sobrou é apagado.
        defaults.removePersistentDomain(forName: suiteName)
        SessionStore.resetKeychainAfterReinstall(defaults: defaults, domain: suiteName, services: [service])
        XCTAssertNil(Keychain.read(service: service, account: "config"))
        XCTAssertNil(Keychain.read(service: service, account: "pin"))

        // Depois da marca, aberturas seguintes não apagam o que for gravado.
        Keychain.write("wab_novo", service: service, account: "config")
        SessionStore.resetKeychainAfterReinstall(defaults: defaults, domain: suiteName, services: [service])
        XCTAssertEqual(Keychain.read(service: service, account: "config"), "wab_novo")
        Keychain.deleteAll(service: service)
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testJSONStringColumns() {
        XCTAssertEqual(JSONValue.parseStringList("[\"a\",\"b\"]"), ["a", "b"])
        XCTAssertEqual(JSONValue.parse("{\"reply_to\":\"m1\"}")["reply_to"]?.stringValue, "m1")
        XCTAssertEqual(JSONValue.parse("garbage").objectValue?.isEmpty, true)
    }
}
