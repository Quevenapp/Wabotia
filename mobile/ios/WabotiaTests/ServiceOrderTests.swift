import XCTest
@testable import Wabotia

final class ServiceOrderClientTests: XCTestCase {
    static let orderJSON = #"{"id":"o1","number":12,"status":"quoted","status_label":"Orçamento enviado","customer":{"name":"Bia","phone":"5520900001111","contact_id":null,"conversation_id":"c1"},"item":"Celular","problem":"Tela trincada","notes":"interno","assignee":null,"due_at":null,"source":"panel","terms":null,"quote":{"items":[{"description":"Tela","quantity":1,"unit_cents":35000},{"description":"Mão de obra","quantity":2,"unit_cents":5000}],"total_cents":45000,"note":"","valid_days":7,"valid_until":1900000000000,"sent_at":1763000000000,"version":1,"expired":false},"decision":null,"ready_at":null,"delivered_at":null,"warranty_until":null,"next_statuses":["analyzing","cancelled","quoted","approved","declined"],"created_by":"u1","created":1763000000000,"updated":1763000000000,"history":[{"id":"h1","kind":"opened","from_status":null,"to_status":"received","actor":"u1","note":null,"created":1}]}"#

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> ServiceOrderClient {
        StubURLProtocol.reset(handler)
        return ServiceOrderClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testListDecodesPageAndCounts() async throws {
        let c = client { _ in .json(200, #"{"data":[\#(Self.orderJSON)],"next_cursor":"11","counts":{"received":2,"in_progress":3,"quoted":1}}"#) }
        let page = try await c.list(open: true, query: " tela ")
        XCTAssertEqual(page.data?.first?.number, 12)
        XCTAssertEqual(page.data?.first?.quote?.items?.last?.totalCents, 10_000)
        XCTAssertEqual(page.data?.first?.customer?.conversationId, "c1")
        XCTAssertEqual(page.nextCursor, "11")
        XCTAssertEqual(page.count("in_progress"), 3, "o mapa de contagem pode chegar convertido para camelCase")
        XCTAssertEqual(page.count("received"), 2)
        let query = Dictionary(uniqueKeysWithValues: URLComponents(url: StubURLProtocol.seen[0].url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["open"], "1")
        XCTAssertEqual(query["q"], " tela ")
        XCTAssertNil(query["status"])
        XCTAssertEqual(StubURLProtocol.seen[0].url.path, "/api/v1/profiles/p1/service-orders")
    }

    func testStatusFilterWinsOverOpen() async throws {
        let c = client { _ in .json(200, #"{"data":[]}"#) }
        _ = try await c.list(statuses: ["ready"], open: true)
        let items = URLComponents(url: StubURLProtocol.seen[0].url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "status" }?.value, "ready")
        XCTAssertNil(items.first { $0.name == "open" })
    }

    func testWritesCarryKeyAndBody() async throws {
        let c = client { _ in .json(200, Self.orderJSON) }
        _ = try await c.create(item: "Celular", problem: "Tela", conversationId: nil, phone: "5520900001111", customerName: "Bia", notes: nil, dueAt: 5, key: "k1")
        _ = try await c.setStatus("o1", status: "delivered", note: "retirado", key: "k2")
        _ = try await c.saveQuote("o1", items: [QuoteItem(description: "Tela", quantity: 2, unitCents: 100)], validDays: 7, note: nil, key: "k3")
        _ = try await c.sendQuote("o1", notify: false, key: "k4")
        _ = try await c.decide("o1", approve: true, key: "k5")
        let seen = StubURLProtocol.seen
        XCTAssertEqual(seen.map(\.method), ["POST", "POST", "PUT", "POST", "POST"])
        XCTAssertEqual(seen.map(\.url.path), ["/api/v1/profiles/p1/service-orders", "/api/v1/profiles/p1/service-orders/o1/status",
                                              "/api/v1/profiles/p1/service-orders/o1/quote", "/api/v1/profiles/p1/service-orders/o1/quote/send",
                                              "/api/v1/profiles/p1/service-orders/o1/decision"])
        XCTAssertEqual(seen.map { $0.header("Idempotency-Key") }, ["k1", "k2", "k3", "k4", "k5"])
        XCTAssertEqual(seen[0].json["phone"] as? String, "5520900001111")
        XCTAssertNil(seen[0].json["conversation_id"])
        XCTAssertEqual(seen[0].json["due_at"] as? Int, 5)
        XCTAssertEqual(seen[1].json["status"] as? String, "delivered")
        let items = seen[2].json["items"] as? [[String: Any]]
        XCTAssertEqual(items?.first?["unit_cents"] as? Int, 100, "valores em centavos, chaves do contrato")
        XCTAssertEqual(items?.first?["quantity"] as? Int, 2)
        XCTAssertEqual(seen[3].json["notify"] as? Bool, false)
        XCTAssertEqual(seen[4].json["decision"] as? String, "approve")
    }
}

final class ServiceOrderRulesTests: XCTestCase {
    private func order(_ status: String, next: [String], quote: ServiceOrderQuote? = nil) -> ServiceOrder {
        ServiceOrder(id: "o", number: 1, status: status, quote: quote, nextStatuses: next)
    }

    func testActionsFollowNextStatuses() {
        let quoted = order("quoted", next: ["analyzing", "cancelled", "quoted", "approved", "declined"])
        XCTAssertEqual(ServiceOrderRules.actions(for: quoted).map(\.title), ["Voltar para análise", "Enviar orçamento", "Cliente aprovou", "Cliente recusou", "Cancelar ordem"])
        let ready = order("ready", next: ["delivered", "in_progress", "cancelled"])
        XCTAssertEqual(ServiceOrderRules.actions(for: ready).map(\.status), ["delivered", "in_progress", "cancelled"])
        XCTAssertEqual(ServiceOrderRules.actions(for: ready).first?.title, "Registrar entrega")
        XCTAssertEqual(ServiceOrderRules.actions(for: order("declined", next: ["analyzing", "ready", "cancelled"]))[1].title, "Devolver sem conserto")
        XCTAssertTrue(ServiceOrderRules.actions(for: order("delivered", next: [])).isEmpty)
    }

    func testQuoteEditingAndExpiry() {
        XCTAssertTrue(ServiceOrderRules.canEditQuote(order("received", next: [])))
        XCTAssertFalse(ServiceOrderRules.canEditQuote(order("in_progress", next: [])))
        let expired = order("quoted", next: [], quote: ServiceOrderQuote(validUntil: 1000))
        XCTAssertTrue(ServiceOrderRules.quoteExpired(expired, now: Date(timeIntervalSince1970: 2)))
        XCTAssertFalse(ServiceOrderRules.quoteExpired(expired, now: Date(timeIntervalSince1970: 0.5)))
        XCTAssertEqual(ServiceOrderRules.statusLabel("in_progress"), "Em execução")
        XCTAssertEqual(ServiceOrderRules.camel("in_progress"), "inProgress")
        XCTAssertEqual(ServiceOrderRules.filters.first?.id, "open")
        XCTAssertEqual(ServiceOrderRules.filters.count, 11)
    }

    func testQuoteDraft() {
        var draft = QuoteDraft(order: nil)
        XCTAssertEqual(draft.lines.count, 1)
        XCTAssertEqual(try? draft.items().get(), nil)
        draft.lines[0].description = "Tela"
        draft.lines[0].value = "350"
        draft.lines.append(.init(description: "Mão de obra", quantity: 2, value: "45,5"))
        draft.lines.append(.init())
        XCTAssertEqual(try draft.items().get(), [QuoteItem(description: "Tela", quantity: 1, unitCents: 35_000), QuoteItem(description: "Mão de obra", quantity: 2, unitCents: 4_550)])
        XCTAssertEqual(draft.total, 44_100)
        draft.lines[1].value = "abc"
        if case let .failure(e) = draft.items() { XCTAssertTrue(e.message.contains("item 2")) } else { XCTFail() }
        draft.validDays = "0"
        XCTAssertNil(draft.days)

        let existing = ServiceOrder(id: "o", quote: ServiceOrderQuote(items: [QuoteItem(description: "Peça", quantity: 1, unitCents: 123_456)], validDays: 10))
        let reopened = QuoteDraft(order: existing)
        XCTAssertEqual(reopened.lines.first?.value, "1.234,56")
        XCTAssertEqual(reopened.days, 10)
        XCTAssertEqual(try reopened.items().get().first?.unitCents, 123_456)
    }
}

@MainActor
final class ServiceOrderViewModelTests: XCTestCase {
    private var failures: [QueueError] = []

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> ServiceOrderClient {
        StubURLProtocol.reset(handler)
        failures = []
        return ServiceOrderClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<150 where !condition() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testDeliverRepeatsWithTheSameKeyAfterNetworkLoss() async {
        var posts: [String?] = []
        let c = client { seen in
            guard seen.method == "POST" else { return .json(200, ServiceOrderClientTests.orderJSON) }
            posts.append(seen.header("Idempotency-Key"))
            return posts.count == 1 ? .networkFailure : .json(200, ServiceOrderClientTests.orderJSON)
        }
        let vm = ServiceOrderViewModel(id: "o1", client: c) { [unowned self] in self.failures.append($0) }
        await vm.load()
        XCTAssertEqual(vm.order?.history?.count, 1)
        vm.perform("delivered", note: "  ")
        await waitUntil { vm.busy == nil && vm.notice != nil }
        XCTAssertTrue(vm.notice?.contains("repetir com segurança") == true)
        vm.perform("delivered", note: nil)
        await waitUntil { vm.busy == nil && vm.done != nil }
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts[0], posts[1])
        XCTAssertNil(StubURLProtocol.seen.first { $0.method == "POST" }?.json["note"], "observação em branco não vai")
        XCTAssertEqual(vm.done, "Entrega registrada")
    }

    func testExpiredQuoteExplainsItself() async {
        let c = client { seen in
            seen.method == "POST" ? .json(409, #"{"error":{"code":"quote_expired","message":"x"}}"#) : .json(200, ServiceOrderClientTests.orderJSON)
        }
        let vm = ServiceOrderViewModel(id: "o1", client: c) { _ in }
        await vm.load()
        vm.perform("approved")
        await waitUntil { vm.busy == nil && vm.notice != nil }
        XCTAssertEqual(vm.notice, "O orçamento venceu e não pode mais ser aprovado. Envie de novo.")
        XCTAssertTrue(StubURLProtocol.seen.contains { $0.url.path.hasSuffix("/decision") })
    }

    func testSaveAndSendQuoteUsesTwoRequests() async {
        let c = client { _ in .json(200, ServiceOrderClientTests.orderJSON) }
        let vm = ServiceOrderViewModel(id: "o1", client: c) { _ in }
        await vm.load()
        vm.saveQuote(items: [QuoteItem(description: "Tela", quantity: 1, unitCents: 35_000)], validDays: 7, note: "", thenSend: true)
        await waitUntil { vm.done != nil && vm.busy == nil }
        let writes = StubURLProtocol.seen.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.url.path).map { $0.replacingOccurrences(of: "/api/v1/profiles/p1/service-orders/o1", with: "") }, ["/quote", "/quote/send"])
        XCTAssertNotEqual(writes[0].header("Idempotency-Key"), writes[1].header("Idempotency-Key"))
        XCTAssertEqual(vm.done, "Orçamento enviado ao cliente")
    }

    func testNewOrderAtTheCounterNeedsAPhone() async {
        let c = client { _ in .json(200, ServiceOrderClientTests.orderJSON) }
        let vm = NewServiceOrderViewModel(conversationId: nil, customer: nil, client: c) { _ in }
        vm.item = "Notebook"
        vm.problem = "Não liga"
        XCTAssertFalse(vm.canSubmit)
        vm.phone = "(20) 90000-1111"
        XCTAssertTrue(vm.canSubmit)
        await vm.submit()
        XCTAssertNotNil(vm.result)
        XCTAssertEqual(StubURLProtocol.seen.first?.json["phone"] as? String, "20900001111")

        let fromChat = NewServiceOrderViewModel(conversationId: "c1", customer: "Bia", client: c) { _ in }
        fromChat.item = "Celular"
        fromChat.problem = "Bateria"
        XCTAssertTrue(fromChat.canSubmit, "pela conversa não precisa de telefone")
    }

    func testListFilterAndModuleOff() async {
        let c = client { seen in
            seen.url.query?.contains("status=ready") == true
                ? .json(409, #"{"error":{"code":"module_disabled","message":"x"}}"#)
                : .json(200, #"{"data":[\#(ServiceOrderClientTests.orderJSON)],"counts":{"received":2,"ready":1,"delivered":4}}"#)
        }
        var reported: [QueueError] = []
        let vm = ServiceOrdersViewModel(client: c) { reported.append($0) }
        await vm.load()
        XCTAssertEqual(vm.orders.count, 1)
        XCTAssertEqual(vm.count("open"), 3, "abertas: sem entregues e canceladas")
        XCTAssertEqual(vm.count("delivered"), 4)
        vm.setFilter("ready")
        await waitUntil { vm.error != nil }
        XCTAssertEqual(reported.first?.moduleDisabled, true)
        XCTAssertEqual(vm.error, ModuleFailure.disabledMessage)
    }
}
