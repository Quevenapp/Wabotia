import XCTest
@testable import Wabotia

final class FormsAndPaymentsTests: XCTestCase {
    private let conversation = #"{"id":"c1","profile_id":"p1","external_namespace":"wa","external_id":"5520900003333","state":"human","epoch":1,"last_customer":1,"created":1,"updated":1}"#

    func testDetailCarriesPaymentsAndWebSteps() throws {
        let json = #"{"conversation":\#(conversation),"media":[],"messages":[],"deliveries":[],"payments":[{"id":"pay1","conversation_id":"c1","provider":"mercadopago","method":"pix","module_id":null,"ref_id":null,"description":"Consulta","amount_cents":4990,"currency":"BRL","status":"created","provider_status":"pending","pix_code":"000201","url":"https://mp.example/qr","trigger":"agent","actor":"u1","expires_at":10,"paid_at":null,"created":5,"updated":5}],"web_steps":[{"id":"ws1","conversation_id":"c1","module_id":"forms","kind":"form","ref_id":"cadastro","title":"Cadastro","status":"opened","trigger":"agent","actor":"u1","expires_at":20,"opened_at":7,"completed_at":null,"ticket_id":null,"contact_id":null,"answers":null}]}"#
        let detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.payments?.first?.amount_cents, 4990)
        XCTAssertEqual(detail.payments?.first?.pix_code, "000201")
        XCTAssertEqual(detail.web_steps?.first?.status, "opened")
        XCTAssertEqual(ConversationItemsRules.stepTitle(detail.web_steps![0]), "Cadastro")
        XCTAssertTrue(ConversationItemsRules.isActive(detail.payments![0]))
    }

    func testOldServerWithoutFieldsStillDecodes() throws {
        let json = #"{"conversation":\#(conversation),"media":[],"messages":[],"deliveries":[]}"#
        let detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.payments)
        XCTAssertNil(detail.web_steps)
    }

    func testActionBodies() throws {
        let charge = ActionRequest(action: "charge", method: "pix", amount_cents: 4990, description: "Consulta")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder.wabotia.encode(charge)) as? [String: Any])
        XCTAssertEqual(body["action"] as? String, "charge")
        XCTAssertEqual(body["amount_cents"] as? Int, 4990)
        XCTAssertNil(body["form_id"], "campos vazios não vão")
        let form = ActionRequest(action: "form", form_id: "cadastro")
        let formBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder.wabotia.encode(form)) as? [String: Any])
        XCTAssertEqual(formBody["form_id"] as? String, "cadastro")
        XCTAssertNil(formBody["method"])
    }

    func testRules() {
        XCTAssertEqual(ConversationItemsRules.amount("49,90"), 4990)
        XCTAssertNil(ConversationItemsRules.amount("0"))
        XCTAssertNil(ConversationItemsRules.amount("100.000,01"))
        XCTAssertEqual(ConversationItemsRules.paymentLabel("created"), "Aguardando pagamento")
        XCTAssertEqual(ConversationItemsRules.paymentLabel("expired"), "Vencida")
        XCTAssertEqual(ConversationItemsRules.webStepLabel("completed"), "Concluído")
        XCTAssertTrue(ConversationItemsRules.explain(APIError(status: 409, code: "payments_not_configured", message: "x")).contains("Mercado Pago"))
    }

    func testBarShowsActiveAndRecentOnly() {
        let now: Int64 = 10 * 86_400_000
        let steps = [WebStep(id: "old", status: "completed", completed_at: now - 3 * 86_400_000, created: now - 4 * 86_400_000),
                     WebStep(id: "open", status: "sent", created: now - 5 * 86_400_000),
                     WebStep(id: "today", status: "completed", completed_at: now - 3_600_000, created: now - 7_200_000)]
        let payments = [ConversationPayment(id: "p1", status: "paid", paid_at: now - 60_000, created: now - 600_000)]
        let recent = ConversationItemsRules.recent(steps: steps, payments: payments, now: now)
        XCTAssertEqual(recent.steps.map(\.id), ["open", "today"])
        XCTAssertEqual(recent.payments.map(\.id), ["p1"])
    }
}
