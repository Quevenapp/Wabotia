import XCTest
@testable import Wabotia

@MainActor
final class QueueLiveFeedTests: XCTestCase {
    private func feed(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> QueueLiveFeed {
        StubURLProtocol.reset(handler)
        let client = QueueClient(baseURL: "w.example", profileId: "p1", session: StubURLProtocol.session()) { "wab_t" }
        return QueueLiveFeed(client: client, useSocket: false, pollInterval: 0.05)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(nanoseconds: 30_000_000) }
    }

    func testPollingDeliversSnapshotsWithoutSocket() async {
        let f = feed { _ in .json(200, #"{"queues":[{"id":"q1","channels":["kiosk"]}],"counters":[],"recent_calls":[]}"#) }
        var snapshots = 0
        f.onEvent = { if case .snapshot = $0 { snapshots += 1 } }
        f.start()
        await waitUntil { snapshots >= 3 }
        f.stop()
        XCTAssertGreaterThanOrEqual(snapshots, 3, "sem WebSocket, a fila é lida de novo a cada intervalo")
        XCTAssertFalse(f.live)
        let after = StubURLProtocol.seen.count
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(StubURLProtocol.seen.count, after, "parada, a tela não consulta mais")
    }

    func testFailureIsReportedAndRetried() async {
        var calls = 0
        let f = feed { _ in
            calls += 1
            return calls == 1 ? .json(401, #"{"error":{"code":"unauthorized","message":"Credencial revogada"}}"#) : .json(200, #"{"queues":[]}"#)
        }
        var failure: QueueError?
        var recovered = false
        f.onEvent = { event in
            switch event {
            case .failure(let e): failure = e
            case .snapshot: recovered = true
            default: break
            }
        }
        f.start()
        await waitUntil { recovered }
        f.stop()
        XCTAssertEqual(failure?.unauthorized, true)
        XCTAssertTrue(recovered, "depois da falha a leitura volta sozinha (espera de 1 s)")
    }
}
