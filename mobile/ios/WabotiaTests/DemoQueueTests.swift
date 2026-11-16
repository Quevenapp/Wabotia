import XCTest
@testable import Wabotia

/// A fila da demonstração responde pelo mesmo `DemoURLProtocol` do app: guichê, totem, painel e pareamento abrem sem
/// servidor real, e nada sai do aparelho.
final class DemoQueueTests: XCTestCase {
    private let base = DemoMode.serverURL.absoluteString

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private func client(_ token: String = DemoQueue.deviceToken) -> QueueClient {
        QueueClient(baseURL: base, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { token }
    }

    func testOverviewHasQueuesCountersAndCalls() async throws {
        let overview = try await client().overview()
        XCTAssertEqual(overview.queues?.map(\.id), ["dq-geral", "dq-retirada"])
        XCTAssertEqual(overview.kioskQueues.count, 2)
        XCTAssertEqual(overview.counters?.count, 3)
        XCTAssertFalse(overview.recentCalls?.isEmpty ?? true, "o painel abre com chamadas da manhã")
        XCTAssertGreaterThan(overview.queues?.first?.waiting?.total ?? 0, 0)
    }

    func testKioskIssueIsIdempotent() async throws {
        let c = client()
        let first = try await c.issue(queueId: "dq-geral", preferential: true, key: "demo-key-1")
        let again = try await c.issue(queueId: "dq-geral", preferential: true, key: "demo-key-1")
        XCTAssertEqual(first.id, again.id, "a mesma chave devolve a mesma senha")
        XCTAssertTrue(first.code?.hasPrefix("P") == true)
        XCTAssertEqual(first.source, "kiosk")
        XCTAssertTrue(first.whatsappLink?.hasPrefix("https://wa.me/5520") == true, "linha fictícia, DDD 20")
        let other = try await c.issue(queueId: "dq-geral", preferential: true, key: "demo-key-2")
        XCTAssertNotEqual(other.id, first.id)
        do {
            _ = try await c.issue(queueId: "dq-geral", preferential: false, key: "demo-key-1")
            XCTFail("mesma chave com outro pedido")
        } catch let e as QueueError { XCTAssertEqual(e.code, "idempotency_conflict") }
    }

    func testCounterCycle() async throws {
        let c = client("wabu_demo")
        do {
            _ = try await c.callNext("dc-1")
            XCTFail("guichê fechado não chama")
        } catch let e as QueueError { XCTAssertEqual(e.code, "counter_closed") }
        try await c.counterState("dc-1", status: "open")
        let called = try await c.callNext("dc-1")
        XCTAssertEqual(called.state, "called")
        XCTAssertEqual(called.counterName, "Guichê 1")
        let recalled = try await c.ticketAction(called.id, "recall")
        XCTAssertEqual(recalled.callCount, 2)
        let serving = try await c.ticketAction(called.id, "start")
        XCTAssertEqual(serving.state, "serving")
        do {
            _ = try await c.ticketAction(called.id, "no-show")
            XCTFail("ausente só vale para chamada")
        } catch let e as QueueError { XCTAssertEqual(e.code, "invalid_transition") }
        let moved = try await c.transfer(called.id, counterId: "dc-3")
        XCTAssertEqual(moved.state, "waiting")
        let overview = try await c.overview()
        XCTAssertNil(overview.counters?.first { $0.id == "dc-1" }?.current)
        XCTAssertEqual(overview.recentCalls?.first?.ticketId, called.id, "a rechamada aparece no painel")
        let phones = (try await c.ticket(called.id)).phone
        if let phones { XCTAssertTrue(phones.hasPrefix("552090")) }
    }

    func testDemoServerOffersTheQueueModule() async {
        let result = await QueueAvailabilityProbe(baseURL: base, profileId: DemoMode.profileId, token: { "wabu_demo" }, session: QueueHTTP.makeSession()).check()
        XCTAssertEqual(result, .available)
    }

    func testPairingIsApprovedOnTheSecondPoll() async throws {
        var flow = DevicePairingFlow(pairing: QueuePairing(session: QueueHTTP.makeSession()))
        flow.minimumInterval = 0
        flow.sleep = { _ in }
        var code: String?
        let config = try await flow.run(baseURL: base, name: "Totem da recepção", demo: true) { code = $0.userCode }
        XCTAssertEqual(code, DemoQueue.userCode)
        XCTAssertEqual(config.token, DemoQueue.deviceToken)
        XCTAssertEqual(config.profileId, DemoMode.profileId)
        XCTAssertEqual(config.scopes, DeviceScopes.requested)
        XCTAssertTrue(config.demo)
        try await QueuePairing(session: QueueHTTP.makeSession()).disconnect(baseURL: base, token: config.token)
    }

    @MainActor
    func testDemoPanelReadsAndAnnouncesWithoutServer() async {
        let audio = RecordingAudio()
        var services = DeviceServices.demo(role: .hybrid)
        services.audio = { audio }
        services.pollInterval = 0.05
        let vm = DeviceViewModel(services: services)
        for _ in 0..<100 where vm.overview == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotNil(vm.overview)
        XCTAssertFalse(vm.offline)
        XCTAssertEqual(vm.config?.role, .hybrid)
        vm.chooseQueue("dq-retirada")
        XCTAssertEqual(vm.choosing?.id, "dq-retirada")
        vm.close()
        XCTAssertTrue(audio.spoken.isEmpty, "as chamadas da manhã não são recitadas ao abrir")
    }
}
