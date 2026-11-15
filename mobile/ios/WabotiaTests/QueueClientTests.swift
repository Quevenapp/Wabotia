import XCTest
@testable import Wabotia

final class QueueClientTests: XCTestCase {
    private let ticketJSON = """
    {"id":"t1","queue_id":"q1","queue_name":"Geral","code":"N023","preferential":false,"source":"kiosk","status":"waiting",
     "counter_id":null,"counter_name":null,"call_count":0,"ahead":3,"wait_minutes":null,"created_at":1763200000000,
     "service_day":"2026-11-15","public_token":"abc","whatsapp_link":"https://wa.me/552090000000?text=SENHA%20N023%20AB12","novo_campo":1}
    """

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> QueueClient {
        StubURLProtocol.reset(handler)
        return QueueClient(baseURL: "wabotia.exemplo.example/", profileId: "p1", session: StubURLProtocol.session()) { "wab_token" }
    }

    func testOverviewDecodesContractAndSendsBearer() async throws {
        let c = client { _ in
            .json(200, """
            {"day":"2026-11-15","settings":{"front_door":true,"notify_ahead":2},
             "queues":[{"id":"q1","name":"Geral","prefix_normal":"N","prefix_preferential":"P","normals_per_preferential":2,
                        "wait_mode":"off","channels":["whatsapp","kiosk"],"enabled":true,"waiting":{"normal":4,"preferential":2},
                        "wait_minutes":{"normal":null,"preferential":null},"open_counters":2},
                       {"id":"q2","name":"Só WhatsApp","channels":["whatsapp"]}],
             "counters":[{"id":"c1","name":"Guichê 2","queue_ids":["q1"],"status":"open","user_id":"u1","user_name":"Ana","current":null}],
             "recent_calls":[{"ticket_id":"t9","code":"N020","queue_id":"q1","counter_id":"c1","counter_name":"Guichê 2","call_count":2,"recall":true,"at":1763200000000,"speech":"Senha N 20, Guichê 2"}]}
            """)
        }
        let overview = try await c.overview()
        XCTAssertEqual(overview.queues?.count, 2)
        XCTAssertEqual(overview.queues?.first?.waiting?.total, 6)
        XCTAssertNil(overview.queues?.first?.waitMinutes?.normal)
        XCTAssertEqual(overview.queues?.filter(\.kiosk).map(\.id), ["q1"])
        XCTAssertEqual(overview.counters?.first?.queueIds, ["q1"])
        XCTAssertEqual(overview.recentCalls?.first?.key, "t9#2")
        XCTAssertEqual(overview.settings?.notifyAhead, 2)

        let seen = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertEqual(seen.method, "GET")
        XCTAssertEqual(seen.url.absoluteString, "https://wabotia.exemplo.example/api/v1/profiles/p1/queue")
        XCTAssertEqual(seen.header("Authorization"), "Bearer wab_token")
        XCTAssertNil(seen.header("Idempotency-Key"))
    }

    func testIssueSendsKeyAndBodyWithoutNulls() async throws {
        let c = client { _ in .json(200, self.ticketJSON) }
        let ticket = try await c.issue(queueId: "q1", preferential: true, key: "k-1")
        XCTAssertEqual(ticket.code, "N023")
        XCTAssertEqual(ticket.ahead, 3)
        XCTAssertNil(ticket.waitMinutes)
        XCTAssertEqual(ticket.createdAt, 1_763_200_000_000)

        let seen = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertEqual(seen.method, "POST")
        XCTAssertTrue(seen.url.path.hasSuffix("/api/v1/profiles/p1/queue/tickets"))
        XCTAssertEqual(seen.header("Idempotency-Key"), "k-1")
        XCTAssertEqual(seen.json["queue_id"] as? String, "q1")
        XCTAssertEqual(seen.json["preferential"] as? Bool, true)
        XCTAssertNil(seen.json["source"], "source omitido vira kiosk no servidor pareado")
    }

    func testContractErrorBecomesQueueError() async {
        let c = client { _ in .json(404, #"{"error":{"code":"queue_empty","message":"Nenhuma senha aguardando."}}"#) }
        do {
            _ = try await c.callNext("c1")
            XCTFail("devia recusar")
        } catch let error as QueueError {
            XCTAssertEqual(error.status, 404)
            XCTAssertEqual(error.code, "queue_empty")
            XCTAssertEqual(error.message, "Nenhuma senha aguardando.")
            XCTAssertFalse(error.retryable)
        } catch { XCTFail("erro inesperado: \(error)") }
    }

    func testNetworkFailureIsRetryable() async {
        let c = client { _ in .networkFailure }
        do {
            _ = try await c.overview()
            XCTFail("devia falhar")
        } catch let error as QueueError {
            XCTAssertEqual(error.status, 0)
            XCTAssertTrue(error.retryable)
        } catch { XCTFail("erro inesperado: \(error)") }
    }

    func testModuleDisabledIsRecognized() async {
        let c = client { _ in .json(409, #"{"error":{"code":"module_disabled","message":"O módulo Fila presencial está desligado."}}"#) }
        do { _ = try await c.overview(); XCTFail("devia recusar") } catch let error as QueueError {
            XCTAssertTrue(error.moduleDisabled)
            XCTAssertFalse(error.retryable)
        } catch { XCTFail("erro inesperado: \(error)") }
    }

    func testIssueOnceRepeatsWithTheSameKeyAfterServerFailure() async throws {
        var calls = 0
        let c = client { _ in
            calls += 1
            return calls == 1 ? .json(503, #"{"error":{"code":"unavailable","message":"Fora do ar"}}"#) : .json(200, self.ticketJSON)
        }
        let ticket = try await issueOnce(c, queueId: "q1", preferential: false, key: "k-same", pause: 1_000_000)
        XCTAssertEqual(ticket.id, "t1")
        let keys = StubURLProtocol.seen.map { $0.header("Idempotency-Key") }
        XCTAssertEqual(keys, ["k-same", "k-same"], "a repetição usa a mesma chave: nunca duas senhas")
    }

    func testIssueOnceRepeatsAfterNetworkLoss() async throws {
        var calls = 0
        let c = client { _ in
            calls += 1
            return calls == 1 ? .networkFailure : .json(200, self.ticketJSON)
        }
        _ = try await issueOnce(c, queueId: "q1", preferential: false, key: "k-net", pause: 1_000_000)
        XCTAssertEqual(StubURLProtocol.seen.count, 2)
        XCTAssertEqual(Set(StubURLProtocol.seen.compactMap { $0.header("Idempotency-Key") }), ["k-net"])
    }

    func testIssueOnceDoesNotRepeatContractRefusal() async {
        let c = client { _ in .json(429, #"{"error":{"code":"kiosk_rate","message":"Aguarde um pouco."}}"#) }
        do {
            _ = try await issueOnce(c, queueId: "q1", preferential: false, pause: 1_000_000)
            XCTFail("devia recusar")
        } catch let error as QueueError {
            XCTAssertEqual(error.code, "kiosk_rate")
        } catch { XCTFail("erro inesperado: \(error)") }
        XCTAssertEqual(StubURLProtocol.seen.count, 1)
    }

    func testTransferSendsOnlyTheChosenTarget() async throws {
        let c = client { _ in .json(200, self.ticketJSON) }
        _ = try await c.transfer("t1", counterId: "c2", key: "k")
        let body = try XCTUnwrap(StubURLProtocol.seen.first).json
        XCTAssertEqual(body["counter_id"] as? String, "c2")
        XCTAssertNil(body["queue_id"])
    }

    func testTicketActionAndCounterStatePaths() async throws {
        let c = client { _ in .json(200, self.ticketJSON) }
        _ = try await c.ticketAction("t1", "no-show", key: "k1")
        try await c.counterState("c1", status: "paused", key: "k2")
        let seen = StubURLProtocol.seen
        XCTAssertTrue(seen[0].url.path.hasSuffix("/queue/tickets/t1/no-show"))
        XCTAssertTrue(seen[1].url.path.hasSuffix("/queue/counters/c1/state"))
        XCTAssertEqual(seen[1].json["status"] as? String, "paused")
        XCTAssertEqual(seen[1].header("Idempotency-Key"), "k2")
    }

    func testSocketRequestUsesWssAndBearer() throws {
        let c = QueueClient(baseURL: "https://wabotia.exemplo.example", profileId: "p1") { "wabu_x" }
        let request = try XCTUnwrap(c.socketRequest())
        XCTAssertEqual(request.url?.absoluteString, "wss://wabotia.exemplo.example/api/v1/profiles/p1/queue/ws")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer wabu_x")
    }

    func testFrameParsing() {
        XCTAssertEqual(QueueFrame.parse(#"{"type":"pong"}"#), .pong)
        if case let .call(call)? = QueueFrame.parse(#"{"type":"call","data":{"ticket_id":"t1","code":"N001","call_count":1,"counter_name":"Guichê 1","at":5}}"#) {
            XCTAssertEqual(call.code, "N001")
            XCTAssertEqual(call.counterName, "Guichê 1")
        } else { XCTFail("quadro call") }
        if case let .snapshot(overview)? = QueueFrame.parse(#"{"type":"snapshot","data":{"queues":[],"counters":[],"recent_calls":[]}}"#) {
            XCTAssertEqual(overview.queues, [])
        } else { XCTFail("quadro snapshot") }
        XCTAssertNil(QueueFrame.parse("não é json"))
        XCTAssertNil(QueueFrame.parse(#"{"type":"desconhecido","data":{}}"#))
    }

    func testNormalizeBaseURL() {
        XCTAssertEqual(QueueHTTP.normalize(" wabotia.exemplo.example/ "), "https://wabotia.exemplo.example")
        XCTAssertEqual(QueueHTTP.normalize("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
    }
}
