import XCTest
@testable import Wabotia

final class QueueAvailabilityTests: XCTestCase {
    private func json(_ text: String) -> Any { try! JSONSerialization.jsonObject(with: Data(text.utf8)) }

    func testRealContractPerArea() {
        let answer = json(#"{"capabilities_version":1,"server":{"service":"wabotia","version":"0.20.0"},"features":["modules","web_steps"],"actor":{"id":"u1","kind":"user","role":"admin"},"profiles":[{"id":"p1","name":"Loja","enabled":true,"modules":[{"id":"queue","name":"Fila presencial","version":"1.0.0"}]}],"modules":[{"id":"queue","name":"Fila presencial","version":"1.0.0"}]}"#)
        XCTAssertEqual(ModuleCapabilities.hasModule(answer, profileId: "p1"), true)
    }

    func testRealContractWithoutQueue() {
        let answer = json(#"{"capabilities_version":1,"profiles":[{"id":"p1","modules":[{"id":"forms","name":"Formulários","version":"1.0.0"}]}],"modules":[{"id":"forms"}]}"#)
        XCTAssertEqual(ModuleCapabilities.hasModule(answer, profileId: "p1"), false)
    }

    func testProfilesListWithoutTopLevelModules() {
        let answer = json(#"{"capabilities_version":1,"profiles":[{"id":"p0","modules":[]},{"id":"p1","modules":[{"id":"queue"}]}]}"#)
        XCTAssertEqual(ModuleCapabilities.hasModule(answer, profileId: "p1"), true)
        XCTAssertEqual(ModuleCapabilities.hasModule(answer, profileId: "p0"), false)
        XCTAssertEqual(ModuleCapabilities.hasModule(answer, profileId: "p9"), false, "área fora do alcance da credencial")
    }

    func testTolerantFormats() {
        XCTAssertEqual(ModuleCapabilities.hasModule(json(#"{"modules":["forms","queue"]}"#)), true)
        XCTAssertEqual(ModuleCapabilities.hasModule(json(#"{"modules":{"queue":{"enabled":false}}}"#)), false)
        XCTAssertEqual(ModuleCapabilities.hasModule(json(#"{"modules":{"fila":true}}"#)), true)
        XCTAssertEqual(ModuleCapabilities.hasModule(json(#"{"data":{"modules":[{"id":"queue","enabled":1}]}}"#)), true)
        XCTAssertEqual(ModuleCapabilities.hasModule(json(#"{"modules":[{"id":"queue","active":0}]}"#)), false)
        XCTAssertNil(ModuleCapabilities.hasModule(json(#"{"version":"0.19.3"}"#)), "não fala de módulos")
    }

    private func probe(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) async -> QueueAvailability {
        StubURLProtocol.reset(handler)
        return await QueueAvailabilityProbe(baseURL: "https://w.example", profileId: "p1", token: { "wabu_x" }, session: StubURLProtocol.session()).check()
    }

    func testCapabilitiesDecideWithoutTouchingTheQueue() async {
        let off = await probe { seen in
            seen.url.path == "/api/v1/profiles/p1/capabilities" ? .json(200, #"{"modules":[{"id":"forms"}]}"#) : .json(200, "{}")
        }
        XCTAssertEqual(off, .unavailable)
        XCTAssertEqual(StubURLProtocol.seen.count, 1)
        XCTAssertEqual(StubURLProtocol.seen.first?.header("Authorization"), "Bearer wabu_x")

        let on = await probe { _ in .json(200, #"{"modules":[{"id":"queue","name":"Fila presencial","version":"1.0.0"}]}"#) }
        XCTAssertEqual(on, .available)
    }

    func testSecondCapabilitiesPath() async {
        let result = await probe { seen in
            if seen.url.path == "/api/v1/capabilities" {
                XCTAssertEqual(URLComponents(url: seen.url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "p1")
                return .json(200, #"{"profiles":[{"id":"p1","modules":[{"id":"queue"}]}]}"#)
            }
            return .json(404, #"{"error":{"code":"not_found","message":"x"}}"#)
        }
        XCTAssertEqual(result, .available)
    }

    func testOldServerFallsBackToGetQueue() async {
        let on = await probe { seen in
            seen.url.path.hasSuffix("/queue") ? .json(200, #"{"queues":[]}"#) : .json(404, #"{"error":{"code":"not_found","message":"x"}}"#)
        }
        XCTAssertEqual(on, .available)
        XCTAssertEqual(StubURLProtocol.seen.map(\.url.path), ["/api/v1/profiles/p1/capabilities", "/api/v1/capabilities", "/api/v1/profiles/p1/queue"])

        let off = await probe { _ in .json(404, #"{"error":{"code":"not_found","message":"x"}}"#) }
        XCTAssertEqual(off, .unavailable)

        let disabled = await probe { seen in
            seen.url.path.hasSuffix("/queue") ? .json(409, #"{"error":{"code":"module_disabled","message":"x"}}"#) : .json(404, "{}")
        }
        XCTAssertEqual(disabled, .unavailable)
    }

    func testNetworkFailureDecidesNothing() async {
        let result = await probe { _ in .networkFailure }
        XCTAssertEqual(result, .unknown)
        let busy = await probe { seen in seen.url.path.hasSuffix("/queue") ? .json(503, "{}") : .json(404, "{}") }
        XCTAssertEqual(busy, .unknown)
    }

    @MainActor
    func testFeatureKeepsWhatItKnewWhenUnknown() {
        let feature = QueueFeature()
        feature.apply(.available, profile: "p1")
        XCTAssertTrue(feature.isAvailable("p1"))
        feature.apply(.unknown, profile: "p1")
        XCTAssertTrue(feature.isAvailable("p1"))
        feature.markDisabled("p1")
        XCTAssertFalse(feature.isAvailable("p1"))
        XCTAssertFalse(feature.isAvailable(nil))
        feature.clear()
        XCTAssertFalse(feature.isAvailable("p1"))
    }
}
