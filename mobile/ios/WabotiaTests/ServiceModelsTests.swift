import XCTest
@testable import Wabotia

final class ServiceModelsTests: XCTestCase {
    func testDefinitiveRejectionsReleaseEditsWithoutRepeatingAmbiguousWrites() {
        XCTAssertTrue(APIError(status: 422, code: "invalid", message: "Inválido").isDefinitiveWriteRejection)
        XCTAssertTrue(APIError(status: 403, code: "forbidden", message: "Sem acesso").isDefinitiveWriteRejection)
        XCTAssertFalse(APIError(status: 409, code: "operation_unknown", message: "Sem confirmação").isDefinitiveWriteRejection)
        XCTAssertFalse(APIError(status: 409, code: "idempotency_conflict", message: "Conflito").isDefinitiveWriteRejection)
        XCTAssertFalse(APIError(status: 429, code: "rate_limited", message: "Aguarde").isDefinitiveWriteRejection)
    }
    func testReadsInternalHistoryWithUnavailablePeer() throws {
        let data = Data(#"{"id":"chat1","peer":{"id":"bot:b1","kind":"bot","name":"Contato indisponível","online":false},"messages":[{"id":"m1","author":"u1","text":"Consulta interna","created":1794146400000,"status":"sent","run_id":null}]}"#.utf8)
        let chat = try JSONDecoder.wabotia.decode(InternalChat.self, from: data)
        XCTAssertEqual(chat.id, "chat1")
        XCTAssertEqual(chat.peer?.online, false)
        XCTAssertEqual(chat.messages?.first?.text, "Consulta interna")
    }

    func testLinePolicyAndManualMenuAreIndependent() throws {
        let data = Data(#"{"id":"n1","name":"Recepção","kind":"meta","mode":"direct","status":"active","number":"5511999999999","number_policy":{"pool":false,"human":true,"bots":false},"service":{"mode":"human","bot_id":null,"menu_mode":"manual"}}"#.utf8)
        let line = try JSONDecoder.wabotia.decode(ServiceLine.self, from: data)
        XCTAssertEqual(line.number_policy["pool"]?.boolValue, false)
        XCTAssertEqual(line.service.menu_mode, "manual")
        XCTAssertNil(line.service.bot_id)
        let body = try JSONEncoder.wabotia.encode(ActionRequest(action: "menu", menu_id: "submenu1"))
        XCTAssertEqual(try JSONDecoder.wabotia.decode(JSONValue.self, from: body)["menu_id"]?.stringValue, "submenu1")
    }
}
