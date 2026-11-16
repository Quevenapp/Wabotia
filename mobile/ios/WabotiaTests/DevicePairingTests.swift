import XCTest
@testable import Wabotia

final class DevicePairingTests: XCTestCase {
    private let startJSON = #"{"device_code":"dev-1","user_code":"ABCD-2345","verification_uri":"https://w.example/app","expires_in":600,"interval":5,"scopes":["queue:read","queue:issue"]}"#

    private func flow(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> (DevicePairingFlow, () -> [TimeInterval]) {
        StubURLProtocol.reset(handler)
        var waits: [TimeInterval] = []
        var clock = Date(timeIntervalSince1970: 1_000)
        var f = DevicePairingFlow(pairing: QueuePairing(session: StubURLProtocol.session()))
        f.sleep = { seconds in waits.append(seconds); clock = clock.addingTimeInterval(seconds) }
        f.now = { clock }
        return (f, { waits })
    }

    func testStartAsksSenhappWithReadAndIssueOnly() async throws {
        StubURLProtocol.reset { _ in .json(200, self.startJSON) }
        let start = try await QueuePairing(session: StubURLProtocol.session()).start(baseURL: "w.example", instanceName: "  Totem da entrada ")
        XCTAssertEqual(start.userCode, "ABCD-2345")
        let seen = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertEqual(seen.url.absoluteString, "https://w.example/api/pairing/start")
        XCTAssertEqual(seen.json["client"] as? String, "senhapp")
        XCTAssertEqual(seen.json["instance_name"] as? String, "Totem da entrada")
        XCTAssertEqual(seen.json["scopes"] as? [String], ["queue:read", "queue:issue"])
        XCTAssertNil(seen.header("Authorization"), "o pedido de código é anônimo")
    }

    func testFlowWaitsPendingSlowsDownAndConnects() async throws {
        var polls = 0
        let (f, waits) = flow { seen in
            if seen.url.path == "/api/pairing/start" { return .json(200, self.startJSON) }
            polls += 1
            XCTAssertEqual(seen.json["device_code"] as? String, "dev-1")
            XCTAssertEqual(seen.json["client"] as? String, "senhapp")
            switch polls {
            case 1: return .json(200, #"{"status":"authorization_pending","interval":5}"#)
            case 2: return .json(429, #"{"error":{"code":"slow_down","message":"Aguarde"}}"#)
            case 3: return .networkFailure
            default: return .json(200, #"{"status":"connected","access_token":"wab_novo","token_type":"Bearer","expires_in":31536000,"profile_id":"p1","scopes":["queue:read","queue:issue"]}"#)
            }
        }
        var shown: String?
        let config = try await f.run(baseURL: "w.example", name: "Totem", demo: false) { shown = $0.userCode }
        XCTAssertEqual(shown, "ABCD-2345")
        XCTAssertEqual(config.token, "wab_novo")
        XCTAssertEqual(config.profileId, "p1")
        XCTAssertEqual(config.baseUrl, "https://w.example")
        XCTAssertEqual(config.scopes, ["queue:read", "queue:issue"])
        XCTAssertNil(config.role)
        XCTAssertTrue(config.canIssue)
        XCTAssertFalse(config.allows(DeviceScopes.operate))
        XCTAssertEqual(waits(), [5, 5, 10, 10], "nunca abaixo de 5 s; slow_down soma 5 s")
    }

    func testIntervalNeverBelowFiveSecondsOnRealServer() async throws {
        let (f, waits) = flow { seen in
            seen.url.path == "/api/pairing/start"
                ? .json(200, #"{"device_code":"d","user_code":"X","expires_in":600,"interval":1}"#)
                : .json(200, #"{"status":"connected","access_token":"wab_t","profile_id":"p1"}"#)
        }
        let config = try await f.run(baseURL: "w.example", name: "Painel", demo: false) { _ in }
        XCTAssertNil(config.scopes, "servidor antigo: sem escopos na resposta")
        XCTAssertTrue(config.canIssue)
        XCTAssertEqual(waits(), [5])
    }

    func testConnectedWithoutReadScopeIsRefused() async {
        let (f, _) = flow { seen in
            seen.url.path == "/api/pairing/start"
                ? .json(200, self.startJSON)
                : .json(200, #"{"status":"connected","access_token":"wab_t","profile_id":"p1","scopes":["queue:issue"]}"#)
        }
        do {
            _ = try await f.run(baseURL: "w.example", name: "Totem", demo: false) { _ in }
            XCTFail("sem leitura da fila não serve")
        } catch {
            XCTAssertEqual(DevicePairingFlow.message(for: error), DevicePairingFlow.missingReadMessage)
        }
    }

    func testDeniedAndExpired() async {
        let (denied, _) = flow { seen in
            seen.url.path == "/api/pairing/start" ? .json(200, self.startJSON) : .json(403, #"{"error":{"code":"access_denied","message":"Recusado"}}"#)
        }
        do { _ = try await denied.run(baseURL: "w.example", name: "T", demo: false) { _ in }; XCTFail() } catch {
            XCTAssertEqual(DevicePairingFlow.message(for: error), "O administrador recusou este aparelho. Gere outro código se foi engano.")
        }

        let (expired, waits) = flow { seen in
            seen.url.path == "/api/pairing/start"
                ? .json(200, #"{"device_code":"d","user_code":"X","expires_in":12,"interval":5}"#)
                : .json(200, #"{"status":"authorization_pending"}"#)
        }
        do { _ = try await expired.run(baseURL: "w.example", name: "T", demo: false) { _ in }; XCTFail() } catch {
            XCTAssertEqual(DevicePairingFlow.message(for: error), DevicePairingFlow.expiredMessage)
            XCTAssertEqual(waits(), [5, 5, 5])
        }
    }

    func testDisconnectUsesTheDeviceCredential() async throws {
        StubURLProtocol.reset { _ in .json(200, #"{"ok":true}"#) }
        try await QueuePairing(session: StubURLProtocol.session()).disconnect(baseURL: "https://w.example", token: "wab_t")
        let seen = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertEqual(seen.url.path, "/api/v1/pairings/disconnect")
        XCTAssertEqual(seen.header("Authorization"), "Bearer wab_t")
        XCTAssertNotNil(seen.header("Idempotency-Key"))
    }

    func testDeviceConfigNeverPrintsTheToken() {
        let config = DeviceConfig(deviceId: "d", baseUrl: "https://w.example", token: "wab_secreto", profileId: "p1", name: "Totem")
        XCTAssertFalse(config.description.contains("wab_secreto"))
        XCTAssertFalse("\(config)".contains("wab_secreto"))
    }

    /// A credencial do aparelho mora num serviço do Keychain separado do token da pessoa.
    func testKeychainStoreIsSeparateFromThePersonSession() {
        XCTAssertNotEqual(KeychainDeviceConfigStore.productionService, "br.com.queven.wabotia.session")
        let store = KeychainDeviceConfigStore(service: "br.com.queven.wabotia.device.tests")
        store.save(nil)
        XCTAssertNil(store.load())
        var config = DeviceConfig(deviceId: "d", baseUrl: "https://w.example", token: "wab_t", profileId: "p1", name: "Totem", role: .hybrid, scopes: DeviceScopes.requested)
        store.save(config)
        XCTAssertEqual(store.load(), config)
        config.demo = true
        store.save(config)
        XCTAssertNil(store.load(), "aparelho da demonstração nunca é gravado")
        store.save(nil)
    }
}
