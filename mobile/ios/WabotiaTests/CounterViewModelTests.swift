import XCTest
@testable import Wabotia

@MainActor
final class CounterViewModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var unauthorized = 0
    private var messages: [String] = []

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "wabotia.tests.counter")
        defaults.removePersistentDomain(forName: "wabotia.tests.counter")
        unauthorized = 0
        messages = []
    }

    private func overview(status: String = "open", current: String? = nil) -> String {
        let ticket = current.map { #"{"id":"t1","queue_id":"q1","queue_name":"Geral","code":"N001","status":"\#($0)","call_count":1,"phone":"5520900001234","window_open":false}"# } ?? "null"
        return #"{"queues":[{"id":"q1","name":"Geral","waiting":{"normal":3,"preferential":1}},{"id":"q2","name":"Retirada"}],"counters":[{"id":"c1","name":"Guichê 1","queue_ids":["q1"],"status":"\#(status)","current":\#(ticket)},{"id":"c2","name":"Guichê 2","queue_ids":["q2"],"status":"closed"}],"recent_calls":[]}"#
    }

    private func model(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> CounterViewModel {
        StubURLProtocol.reset(handler)
        let client = QueueClient(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_pessoa" }
        return CounterViewModel(client: client, demo: false, defaults: defaults, onUnauthorized: { [unowned self] in self.unauthorized += 1 },
                                onMessage: { [unowned self] in self.messages.append($0) })
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<150 where !condition() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testChosenCounterIsKeptPerProfile() async {
        let vm = model { _ in .json(200, self.overview()) }
        await vm.reload()
        XCTAssertNil(vm.counter)
        vm.chooseCounter("c1")
        XCTAssertEqual(vm.counter?.displayName, "Guichê 1")
        XCTAssertEqual(vm.servedQueues.map(\.id), ["q1"])
        XCTAssertEqual(defaults.string(forKey: "queue.counter.p1"), "c1")
        let again = model { _ in .json(200, self.overview()) }
        XCTAssertEqual(again.counterId, "c1")
    }

    func testDeletedCounterGoesBackToTheChoice() async {
        defaults.set("c9", forKey: "queue.counter.p1")
        let vm = model { _ in .json(200, self.overview()) }
        await vm.reload()
        XCTAssertNil(vm.counterId)
        XCTAssertNil(defaults.string(forKey: "queue.counter.p1"))
    }

    func testCallNextRepeatsWithTheSameKeyAfterNetworkLossThenUsesANewOne() async {
        var posts: [String?] = []
        var failNext = true
        let vm = model { seen in
            if seen.method == "POST" {
                posts.append(seen.header("Idempotency-Key"))
                XCTAssertEqual(seen.header("Authorization"), "Bearer wabu_pessoa")
                if failNext { failNext = false; return .networkFailure }
                return .json(200, #"{"id":"t1","code":"N001","status":"called","call_count":1}"#)
            }
            return .json(200, self.overview())
        }
        await vm.reload()
        vm.chooseCounter("c1")
        vm.callNext()
        await waitUntil { vm.busy == nil && vm.notice != nil }
        XCTAssertTrue(vm.notice?.contains("Toque de novo") == true)
        let saved = vm.pendingKey
        XCTAssertNotNil(saved)
        vm.callNext()
        await waitUntil { vm.busy == nil && !messages.isEmpty }
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts[0], posts[1], "a mesma intenção repete com a mesma chave")
        XCTAssertEqual(messages.last, "Senha N001 chamada")
        XCTAssertNil(vm.pendingKey)
        vm.callNext()
        await waitUntil { posts.count == 3 && vm.busy == nil }
        XCTAssertNotEqual(posts[2], posts[0], "depois da confirmação, intenção nova, chave nova")
        XCTAssertTrue(StubURLProtocol.seen.first { $0.method == "POST" }!.url.path.hasSuffix("/queue/counters/c1/call-next"))
    }

    func testDefinitiveRefusalReleasesTheKey() async {
        var posts: [String?] = []
        let vm = model { seen in
            if seen.method == "POST" {
                posts.append(seen.header("Idempotency-Key"))
                return .json(404, #"{"error":{"code":"queue_empty","message":"Nenhuma senha aguardando nas filas deste guichê."}}"#)
            }
            return .json(200, self.overview())
        }
        await vm.reload()
        vm.chooseCounter("c1")
        vm.callNext()
        await waitUntil { vm.notice != nil && vm.busy == nil }
        XCTAssertEqual(vm.notice, "Nenhuma senha aguardando nas filas deste guichê.")
        XCTAssertNil(vm.pendingKey)
        vm.callNext()
        await waitUntil { posts.count == 2 && vm.busy == nil }
        XCTAssertNotEqual(posts[0], posts[1])
    }

    func testStateChangeSeenInTheNextReadingSettlesThePendingKey() async {
        var reads = 0
        let vm = model { seen in
            if seen.method == "POST" { return .json(503, #"{"error":{"code":"unavailable","message":"Fora do ar."}}"#) }
            reads += 1
            return .json(200, reads == 1 ? self.overview() : self.overview(current: "called"))
        }
        await vm.reload()
        vm.chooseCounter("c1")
        vm.callNext()
        await waitUntil { vm.busy == nil && vm.notice != nil }
        XCTAssertNotNil(vm.pendingKey)
        await vm.reload()
        XCTAssertEqual(vm.current?.state, "called")
        XCTAssertNil(vm.pendingKey, "a chamada apareceu na leitura: o próximo toque é intenção nova")
    }

    func testTicketActionsAndTransfer() async {
        let vm = model { seen in
            seen.method == "POST" ? .json(200, #"{"id":"t1","code":"N001","status":"waiting"}"#) : .json(200, self.overview(current: "called"))
        }
        await vm.reload()
        vm.chooseCounter("c1")
        XCTAssertEqual(vm.current?.windowOpen, false)
        vm.act("no-show")
        await waitUntil { messages.count == 1 }
        vm.transfer(queueId: nil, counterId: "c2")
        await waitUntil { messages.count == 2 }
        let posts = StubURLProtocol.seen.filter { $0.method == "POST" }
        XCTAssertTrue(posts[0].url.path.hasSuffix("/queue/tickets/t1/no-show"))
        XCTAssertTrue(posts[1].url.path.hasSuffix("/queue/tickets/t1/transfer"))
        XCTAssertEqual(posts[1].json["counter_id"] as? String, "c2")
        XCTAssertEqual(messages, ["N001 marcada como ausente", "Senha N001 transferida"])
    }

    func testUnauthorizedReturnsToLogin() async {
        let vm = model { _ in .json(401, #"{"error":{"code":"unauthorized","message":"Sessão expirada."}}"#) }
        await vm.reload()
        XCTAssertEqual(unauthorized, 1)
        XCTAssertEqual(vm.error, "Sessão expirada.")
    }

    func testModuleOffExplainsItself() async {
        let vm = model { _ in .json(409, #"{"error":{"code":"module_disabled","message":"Desligado"}}"#) }
        await vm.reload()
        XCTAssertTrue(vm.error?.contains("desligada") == true)
    }
}
