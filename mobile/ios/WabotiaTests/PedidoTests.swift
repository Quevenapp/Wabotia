import XCTest
@testable import Wabotia

final class PedidoClientTests: XCTestCase {
    /// Duas montagens do mesmo X-Burger (`slot` 0 e 1) e um suco: as linhas vêm separadas e assim ficam.
    static let orderJSON = #"{"id":"o1","number":42,"status":"preparing","status_label":"Em preparo","status_at":1,"customer":{"name":"Bia","phone":"5520900001111","contact_id":null,"conversation_id":"c1"},"source":"cart","fulfillment":"delivery","fulfillment_label":"Entrega","address":{"street":"Rua A, 10","district":"Centro","complement":"Apto 2","reference":"portão azul"},"address_text":"Rua A, 10 - Centro, Apto 2 (portão azul)","lines":[{"item_id":"xb","slot":0,"name":"X-Burger","quantity":1,"unit_cents":3000,"options":[{"group_id":"ponto","group":"Ponto","id":"bem","name":"Bem passada","price_cents":0},{"group_id":"ad","group":"Adicionais","id":"bacon","name":"Bacon","price_cents":500}],"note":"sem cebola","total_cents":3000},{"item_id":"xb","slot":1,"name":"X-Burger","quantity":1,"unit_cents":2500,"options":[],"note":"","total_cents":2500},{"item_id":"suco","slot":0,"name":"Suco","quantity":2,"unit_cents":800,"options":[],"note":"","total_cents":1600}],"item_count":4,"subtotal_cents":7100,"delivery_fee_cents":700,"total_cents":7800,"note":"Troco para 100","notes":"cliente antigo","eta_minutes":45,"eta_at":9,"payment":{"method":"cash","method_label":"Dinheiro na entrega ou retirada","online":false,"status":"pending","status_label":"Pagar na entrega","payment_id":null,"due_at":null,"paid_at":null,"paid_by":null,"error":null,"change_for_cents":10000,"needs_refund":false},"next_statuses":["out_for_delivery","received","cancelled"],"cancel_reason":null,"created":1,"updated":2}"#

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> PedidoClient {
        StubURLProtocol.reset(handler)
        return PedidoClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testBoardAndOrderDecodeWithoutGroupingLines() async throws {
        let c = client { seen in
            if seen.url.path.hasSuffix("/board") {
                return .json(200, #"{"generated_at":5,"store":{"open":true,"reason":"open","paused":false,"message":""},"columns":[{"status":"awaiting_payment","label":"Aguardando pagamento","orders":[]},{"status":"preparing","label":"Em preparo","orders":[\#(String(Self.orderJSON.dropLast())),"minutes_in_status":47,"late":true}]}],"today":{"since":0,"orders":9,"delivered":5,"cancelled":1,"total_cents":45600}}"#)
            }
            return .json(200, Self.orderJSON)
        }
        let board = try await c.board()
        XCTAssertEqual(board.columns?.count, 2)
        let card = try XCTUnwrap(board.columns?[1].orders?.first)
        XCTAssertEqual(card.minutesInStatus, 47)
        XCTAssertEqual(card.late, true)
        XCTAssertEqual(board.today?.totalCents, 45_600)
        let order = try await c.order("o1")
        XCTAssertEqual(order.lines?.count, 3, "o mesmo item em duas montagens fica em duas linhas")
        XCTAssertEqual(order.lines?.map(\.slot), [0, 1, 0])
        XCTAssertEqual(PedidoRules.optionsText(order.lines![0]), "Bem passada, Bacon")
        XCTAssertNil(PedidoRules.optionsText(order.lines![1]))
        XCTAssertEqual(order.payment?.changeForCents, 10_000)
        XCTAssertEqual(order.address?.reference, "portão azul")
        XCTAssertTrue(order.delivery)
    }

    func testListReadsCountsWithExactKeys() async throws {
        let c = client { _ in .json(200, #"{"data":[\#(Self.orderJSON)],"next_cursor":"42","counts":{"out_for_delivery":3,"received":2,"delivered":10}}"#) }
        let page = try await c.list(open: true, query: "bia")
        XCTAssertEqual(page.count("out_for_delivery"), 3)
        XCTAssertEqual(page.count("cancelled"), 0)
        XCTAssertEqual(page.nextCursor, "42")
        let query = StubURLProtocol.seen.last!.url.query ?? ""
        XCTAssertTrue(query.contains("open=1") && query.contains("q=bia"))
    }

    func testWritesCarryKeyPathsAndBodies() async throws {
        let c = client { seen in
            if seen.url.path.hasSuffix("/pause") { return .json(200, #"{"open":false,"reason":"paused","paused":true,"pause_message":"volto já"}"#) }
            if seen.url.path.contains("/items/") { return .json(200, #"{"id":"xb","name":"X-Burger","available":false}"#) }
            if seen.url.path.contains("/groups/") { return .json(200, #"{"id":"ad","name":"Adicionais","options":[{"id":"bacon","name":"Bacon","price_cents":500,"available":false}]}"#) }
            return .json(200, Self.orderJSON)
        }
        _ = try await c.setStatus("o1", status: "cancelled", note: nil, reason: "acabou o pão", notify: true, key: "k1")
        _ = try await c.markPaid("o1", note: nil, key: "k2")
        _ = try await c.setMethod("o1", method: "card", key: "k3")
        let store = try await c.pause(true, message: "volto já", key: "k4")
        _ = try await c.setItemAvailable("xb", available: false, key: "k5")
        _ = try await c.setOptionAvailable(groupId: "ad", optionId: "bacon", available: false, key: "k6")
        XCTAssertEqual(store.paused, true)
        let seen = StubURLProtocol.seen
        XCTAssertEqual(seen.map(\.method), Array(repeating: "POST", count: 6))
        XCTAssertEqual(seen.map { $0.url.path.replacingOccurrences(of: "/api/v1/profiles/p1/pedido/", with: "") },
                       ["orders/o1/status", "orders/o1/paid", "orders/o1/payment", "store/pause", "items/xb/availability", "groups/ad/availability"])
        XCTAssertEqual(seen.map { $0.header("Idempotency-Key") }, ["k1", "k2", "k3", "k4", "k5", "k6"])
        XCTAssertEqual(seen[0].json["reason"] as? String, "acabou o pão")
        XCTAssertEqual(seen[0].json["notify"] as? Bool, true)
        XCTAssertNil(seen[0].json["note"])
        XCTAssertEqual(seen[2].json["method"] as? String, "card")
        XCTAssertEqual(seen[5].json["option_id"] as? String, "bacon")
        XCTAssertEqual(seen[5].json["available"] as? Bool, false)
    }

    func testTicketAsksTheColumns() async throws {
        let c = client { seen in .json(200, #"{"columns":42,"text":"LANCHONETE\n------"}"#) }
        let ticket = try await c.ticket("o1", columns: 42)
        XCTAssertEqual(ticket.text, "LANCHONETE\n------")
        XCTAssertTrue(StubURLProtocol.seen.last!.url.absoluteString.hasSuffix("/pedido/orders/o1/ticket?columns=42"))
    }
}

final class PedidoRulesTests: XCTestCase {
    private func order(_ status: String, fulfillment: String = "pickup", next: [String], payment: String = "pending") -> PedidoOrder {
        PedidoOrder(id: "o", status: status, fulfillment: fulfillment, payment: PedidoPayment(status: payment), nextStatuses: next)
    }

    func testActionsFollowNextStatusesWithBackStepsAndCancelLast() {
        let preparing = PedidoRules.actions(for: order("preparing", next: ["ready", "received", "cancelled"]))
        XCTAssertEqual(preparing.map(\.title), ["Pronto para retirada", "Voltar para novos", "Cancelar pedido"])
        let received = PedidoRules.actions(for: order("received", fulfillment: "delivery", next: ["preparing", "out_for_delivery", "cancelled"]))
        XCTAssertEqual(received.map(\.title), ["Começar preparo", "Saiu para entrega", "Cancelar pedido"])
        let awaiting = PedidoRules.actions(for: order("awaiting_payment", next: ["received", "cancelled"]))
        XCTAssertEqual(awaiting.first?.title, "Enviar para o preparo")
        XCTAssertTrue(PedidoRules.actions(for: order("delivered", next: [])).isEmpty)
    }

    func testPaymentButtons() {
        XCTAssertTrue(PedidoRules.canMarkPaid(order("ready", next: [], payment: "pending")))
        XCTAssertFalse(PedidoRules.canMarkPaid(order("awaiting_payment", next: [], payment: "awaiting")), "cobrança online aberta: só o provedor confirma")
        XCTAssertFalse(PedidoRules.canMarkPaid(order("ready", next: [], payment: "paid")))
        XCTAssertFalse(PedidoRules.canMarkPaid(order("cancelled", next: [], payment: "pending")))
        XCTAssertTrue(PedidoRules.canChooseMethod(order("awaiting_payment", next: [], payment: "choosing")))
        XCTAssertFalse(PedidoRules.canChooseMethod(order("received", next: [], payment: "choosing")))
    }

    func testTicketWidthFitsThePrinter() {
        XCTAssertEqual(PedidoRules.ticketColumns(for: 32), 32)
        XCTAssertEqual(PedidoRules.ticketColumns(for: 42), 42)
        XCTAssertEqual(PedidoRules.ticketColumns(for: 48), 48)
        XCTAssertEqual(PedidoRules.ticketColumns(for: 64), 48)
        XCTAssertEqual(PedidoRules.ticketColumns(for: 24), 32)
        let texts = [32: "a", 48: "b"]
        XCTAssertEqual(PedidoTicketReceipt.text(for: 42, in: texts), "a", "sem a de 42, a maior que cabe")
        XCTAssertEqual(PedidoTicketReceipt.text(for: 48, in: texts), "b")
    }

    func testElapsedAndStoreText() {
        XCTAssertEqual(PedidoRules.elapsed(7), "7 min")
        XCTAssertEqual(PedidoRules.elapsed(65), "1 h 05")
        XCTAssertNil(PedidoRules.elapsed(nil))
        XCTAssertEqual(PedidoRules.storeText(PedidoStore(open: false, paused: true)), "Loja pausada: não recebe pedidos agora")
        XCTAssertEqual(PedidoRules.storeText(PedidoStore(open: false, paused: false)), "Loja fechada pelo horário")
        // O quadro manda só `message` com a loja pausada (sem `pause_message`).
        XCTAssertEqual(PedidoRules.pauseText(PedidoStore(open: false, paused: true, message: "Loja pausada agora.\n\nVoltamos em 10 minutos")),
                       "Loja pausada agora. · Voltamos em 10 minutos")
        XCTAssertEqual(PedidoRules.pauseText(PedidoStore(paused: true, pauseMessage: "volto já", message: "x")), "volto já")
        XCTAssertNil(PedidoRules.pauseText(PedidoStore(open: true, paused: false, message: "")))
    }
}
