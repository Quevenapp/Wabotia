import XCTest
@testable import Wabotia

/// Login e segundo fator (docs/API.md, "Login e segundo fator", `feat/login-mfa`).
final class SecondFactorModelTests: XCTestCase {
    func testLoginSendsTheCodeOnlyInTheSecondStep() throws {
        let device = DeviceInfo(name: "iPhone", app_version: "0.18.0")
        let first = try JSONSerialization.jsonObject(with: JSONEncoder.wabotia.encode(MobileLoginRequest(email: "a@b.c", password: "x", device: device))) as? [String: Any]
        XCTAssertNil(first?["totp"], "primeiro pedido sem código")
        var second = MobileLoginRequest(email: "a@b.c", password: "x", device: device)
        second.totp = "123456"
        let body = try JSONSerialization.jsonObject(with: JSONEncoder.wabotia.encode(second)) as? [String: Any]
        XCTAssertEqual(body?["totp"] as? String, "123456")
        XCTAssertNil(body?["recovery_code"])
        XCTAssertTrue(LoginStep.needsCode(APIError(status: 401, code: "mfa_required", message: "")))
        XCTAssertFalse(LoginStep.needsCode(APIError(status: 401, code: "invalid_code", message: "")), "código errado é erro, não a segunda etapa")
    }

    func testSessionCarriesTheLevelAndThePolicy() throws {
        let json = #"{"token":"wabu_x","expires":1,"user":{"id":"u","name":"Ana","email":"a@b.c","role":"operator","profiles":["p"]},"aal":1,"mfa":{"policy":"all","factor":false,"next":"enroll"}}"#
        let s = try JSONDecoder.wabotia.decode(MobileSession.self, from: Data(json.utf8))
        XCTAssertEqual(s.aal, 1)
        XCTAssertEqual(s.mfa, MFAState(policy: "all", factor: false, next: "enroll"))
        let old = try JSONDecoder.wabotia.decode(MobileSession.self, from: Data(#"{"token":"wabu_x","expires":1,"user":{"id":"u","name":"Ana","email":"a@b.c","role":"operator","profiles":["p"]}}"#.utf8))
        XCTAssertNil(old.mfa, "servidor sem o recurso: como antes")
    }

    func testMessagesForTheSecondFactorRefusals() {
        XCTAssertTrue(MFAText.describe(APIError(status: 401, code: "invalid_code", message: "")).contains("incorreto"))
        XCTAssertTrue(MFAText.describe(APIError(status: 429, code: "mfa_locked", message: "")).contains("15 minutos"))
        XCTAssertEqual(MFAText.describe(APIError(status: 403, code: "outside_schedule", message: "Fora do horário (08:00–18:00).")), "Fora do horário (08:00–18:00).")
        XCTAssertEqual(MFAEnrollView.grouped("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP")
    }
}

@MainActor
final class MFAGateTests: XCTestCase {
    override func setUp() async throws { MFAGate.shared.reset() }

    func testEnrollmentRequiredRightAfterLogin() {
        MFAGate.shared.remember(MFAState(policy: "all", factor: false, next: "enroll"), aal: 1)
        XCTAssertEqual(MFAGate.shared.prompt, .enroll, "política all sem fator: o cadastro aparece sem deslogar")
        MFAGate.shared.reset()
        MFAGate.shared.remember(MFAState(policy: "off", factor: true, next: nil), aal: 2)
        XCTAssertNil(MFAGate.shared.prompt)
        XCTAssertEqual(MFAGate.shared.aal, 2)
    }

    func testCardsThatAskTheCodeThemselvesKeepTheGateClosed() async {
        await MFAGate.$handledLocally.withValue(true) {
            MFAGate.report(status: 403, code: "mfa_required")
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(MFAGate.shared.prompt, "o cartão do bot pede o código e repete; a porta central não abre outra janela")
        MFAGate.report(status: 403, code: "access_denied")
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(MFAGate.shared.prompt, "outros 403 não são do segundo fator")
    }
}

/// A demonstração abre o login em duas etapas, o cadastro e os códigos de recuperação.
final class DemoSecondFactorTests: XCTestCase {
    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> (status: Int, json: [String: Any]) {
        let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let reply = DemoServer.queue.sync { DemoServer.shared.handle(method: method, url: DemoMode.serverURL.appendingPathComponent(path), body: data) }
        return (reply.status, (try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any] ?? [:])
    }

    private func code(_ r: (status: Int, json: [String: Any])) -> String? { (r.json["error"] as? [String: Any])?["code"] as? String }

    func testLoginInTwoSteps() {
        let first = call("POST", "api/auth/mobile/login", ["email": "diego@empresa.example", "password": "mfa"])
        XCTAssertEqual(first.status, 401)
        XCTAssertEqual(code(first), "mfa_required")
        XCTAssertEqual(code(call("POST", "api/auth/mobile/login", ["email": "d", "password": "mfa", "totp": "000000"])), "invalid_code")
        let second = call("POST", "api/auth/mobile/login", ["email": "d", "password": "mfa", "totp": DemoBotActions.mfaCode])
        XCTAssertEqual(second.status, 200)
        XCTAssertEqual(second.json["aal"] as? Int, 2)
    }

    func testEnrollmentGivesRecoveryCodesOnce() {
        XCTAssertEqual((call("GET", "api/v1/me").json["mfa"] as? [String: Any])?["factor"] as? Bool, false)
        XCTAssertEqual(code(call("POST", "api/v1/account/mfa/recovery-codes", [:])), "mfa_required", "códigos novos exigem aal2")
        let enroll = call("POST", "api/v1/account/mfa/enroll", ["password": "qualquer"])
        XCTAssertTrue((enroll.json["otpauth_url"] as? String)?.hasPrefix("otpauth://totp/") == true)
        let verify = call("POST", "api/v1/account/mfa/verify", ["factor_id": enroll.json["factor_id"] ?? "", "code": DemoBotActions.mfaCode])
        XCTAssertEqual((verify.json["recovery_codes"] as? [String])?.count, 10)
        XCTAssertEqual((call("GET", "api/v1/me").json["mfa"] as? [String: Any])?["factor"] as? Bool, true)
        XCTAssertEqual(call("GET", "api/v1/me").json["aal"] as? Int, 2)
        XCTAssertEqual(call("POST", "api/v1/account/mfa/recovery-codes", [:]).status, 200)
    }
}
