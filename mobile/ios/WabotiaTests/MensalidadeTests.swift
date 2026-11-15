import XCTest
@testable import Wabotia

final class MensalidadeClientTests: XCTestCase {
    static let installmentJSON = #"{"id":"i1","subscription_id":"s1","period_key":"2026-11","period_label":"nov/2026","due_date":"2026-11-10","amount_cents":32000,"status":"overdue","status_label":"Vencida","customer":{"name":"Bia","phone":"5520900001111","phones":["5520900001111","5520900002222"]},"plan_name":"Inglês","payment":{"id":"p1","status":"created","expires_at":5,"pix_code":"000201","url":"https://pag.example/x","charged_at":4},"notices":{"before_at":1,"due_at":2,"overdue":1,"overdue_at":3,"error":null},"paid_at":null,"paid_via":null}"#

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> MensalidadeClient {
        StubURLProtocol.reset(handler)
        return MensalidadeClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testReadsDecode() async throws {
        let c = client { seen in
            switch seen.url.path {
            case let p where p.hasSuffix("/summary"):
                return .json(200, #"{"month":"2026-11","expected_cents":256000,"received_cents":128000,"overdue_cents":64000,"open_cents":64000,"waived_cents":0,"counts":{"open":2,"paid":4,"overdue":2,"cancelled":0,"waived":0},"received_in_month":{"count":4,"cents":128000},"overdue_total":{"count":3,"cents":96000,"subscriptions":2},"payments_ready":true}"#)
            case let p where p.hasSuffix("/delinquents"):
                return .json(200, #"{"data":[{"subscription_id":"s1","customer":{"name":"Bia","phone":"5520900001111","conversation_id":"c1"},"plan_name":"Inglês","subscription_status":"active","overdue_count":2,"overdue_cents":64000,"oldest_due_date":"2026-10-10","notices_sent":2}]}"#)
            case let p where p.hasSuffix("/subscriptions"):
                return .json(200, #"{"data":[{"id":"s1","plan_name":"Inglês","customer":{"name":"Bia"},"amount_cents":32000,"discount_cents":0,"charge_cents":32000,"due_day":10,"status":"active","status_label":"Ativa","overdue_count":2,"overdue_cents":64000}],"counts":{"active":1}}"#)
            default:
                return .json(200, #"{"month":"2026-11","data":[\#(Self.installmentJSON)],"next_cursor":null,"counts":{"overdue":1}}"#)
            }
        }
        let summary = try await c.summary(month: "2026-11")
        XCTAssertEqual(summary.counts?["overdue"], 2)
        XCTAssertEqual(summary.overdueTotal?.subscriptions, 2)
        let page = try await c.installments(month: "2026-11", statuses: ["overdue"], query: "bia")
        let i = try XCTUnwrap(page.data?.first)
        XCTAssertEqual(i.payment?.pixCode, "000201")
        XCTAssertEqual(i.customer?.phoneList, ["(20) 90000-1111", "(20) 90000-2222"], "vários telefones, sem repetir")
        let query = URLComponents(url: StubURLProtocol.seen[1].url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(query.first { $0.name == "status" }?.value, "overdue")
        XCTAssertEqual(query.first { $0.name == "month" }?.value, "2026-11")
        let subs = try await c.subscriptions(statuses: ["active"])
        XCTAssertEqual(subs.data?.first?.dueDay, 10)
        let late = try await c.delinquents()
        XCTAssertEqual(late.first?.oldestDueDate, "2026-10-10")
    }

    func testWritesCarryKeyAndBody() async throws {
        let c = client { seen in seen.url.path.contains("/subscriptions/") ? .json(200, #"{"id":"s1","status":"paused"}"#) : .json(200, Self.installmentJSON) }
        _ = try await c.charge("i1", key: "k1")
        _ = try await c.pay("i1", note: "dinheiro", paidAt: "2026-11-12", notify: false, key: "k2")
        _ = try await c.waive("i1", note: nil, key: "k3")
        _ = try await c.subscriptionAction("s1", "pause", key: "k4")
        let seen = StubURLProtocol.seen
        XCTAssertEqual(seen.map { $0.url.path.replacingOccurrences(of: "/api/v1/profiles/p1/mensalidade", with: "") },
                       ["/installments/i1/charge", "/installments/i1/pay", "/installments/i1/waive", "/subscriptions/s1/pause"])
        XCTAssertEqual(seen.map { $0.header("Idempotency-Key") }, ["k1", "k2", "k3", "k4"])
        XCTAssertEqual(seen[1].json["paid_at"] as? String, "2026-11-12")
        XCTAssertEqual(seen[1].json["notify"] as? Bool, false)
        XCTAssertNil(seen[2].json["note"])
    }
}

final class MensalidadeRulesTests: XCTestCase {
    func testMonthsAndActions() {
        XCTAssertEqual(MensalidadeRules.shiftMonth("2026-12", 1), "2027-01")
        XCTAssertEqual(MensalidadeRules.shiftMonth("2026-01", -1), "2025-12")
        XCTAssertEqual(MensalidadeRules.monthTitle("2026-03"), "março de 2026")
        XCTAssertEqual(MensalidadeRules.dueText("2026-11-05"), "05/11/2026")
        XCTAssertTrue(MensalidadeRules.canPay(Installment(id: "i", status: "overdue")))
        XCTAssertFalse(MensalidadeRules.canCharge(Installment(id: "i", status: "paid")))
        XCTAssertTrue(MensalidadeRules.canResume(Subscription(id: "s", status: "paused")))
        XCTAssertFalse(MensalidadeRules.canEnd(Subscription(id: "s", status: "ended")))
        XCTAssertTrue(MensalidadeRules.explain(QueueError(status: 409, code: "payments_not_configured", message: "x")).contains("Cobrança"))
    }
}

@MainActor
final class InstallmentViewModelTests: XCTestCase {
    func testPayRepeatsWithTheSameKeyAndExplainsRefusals() async {
        var posts: [String?] = []
        StubURLProtocol.reset { seen in
            guard seen.method == "POST" else { return .json(200, MensalidadeClientTests.installmentJSON) }
            posts.append(seen.header("Idempotency-Key"))
            switch posts.count {
            case 1: return .networkFailure
            case 2: return .json(200, MensalidadeClientTests.installmentJSON)
            default: return .json(409, #"{"error":{"code":"no_conversation","message":"x"}}"#)
            }
        }
        let client = MensalidadeClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "x" })
        let vm = InstallmentViewModel(id: "i1", client: client) { _ in }
        await vm.load()
        vm.pay(note: "", paidAt: Date(), notify: true)
        for _ in 0..<100 where !(vm.busy == nil && vm.notice != nil) { try? await Task.sleep(nanoseconds: 20_000_000) }
        vm.pay(note: "", paidAt: Date(), notify: true)
        for _ in 0..<100 where vm.done == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(posts[0], posts[1], "a mesma baixa repete com a mesma chave")
        vm.charge()
        for _ in 0..<100 where posts.count < 3 || vm.busy != nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(vm.notice?.contains("não tem conversa") == true)
    }
}
