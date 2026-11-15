import XCTest
@testable import Wabotia

final class PanelCallAnnouncerTests: XCTestCase {
    private func call(_ id: String, _ number: String, desk: String? = "Guichê 2", at: Int64, recalls: Int = 0, rank: Int? = nil) -> StationCall {
        StationCall(ticketId: id, publicNumber: number, stationLabel: desk, calledAt: String(at), recalls: recalls, recentRank: rank, at: at)
    }

    func testFirstReadingIsSilent() {
        let announcer = PanelCallAnnouncer()
        XCTAssertEqual(announcer.announce([call("t1", "N001", at: 1)]), .silent, "a tela que abre não recita as chamadas antigas")
        XCTAssertTrue(announcer.primed)
    }

    func testNewCallIsSpokenOnceAndNotRepeated() {
        let announcer = PanelCallAnnouncer()
        announcer.prime([call("t1", "N001", at: 1)])
        let first = announcer.announce([call("t2", "N023", at: 2), call("t1", "N001", at: 1)])
        XCTAssertTrue(first.chime)
        XCTAssertEqual(first.spoken, ["Senha N 23. Guichê 2."])
        XCTAssertEqual(first.latest?.ticketId, "t2")
        // O quadro `call` e o `snapshot` seguinte trazem a mesma chamada: não fala de novo.
        XCTAssertEqual(announcer.announce([call("t2", "N023", at: 2)]), .silent)
        XCTAssertEqual(announcer.announce([call("t2", "N023", at: 2), call("t1", "N001", at: 1)]), .silent)
    }

    func testRecallIsSpokenAgain() {
        let announcer = PanelCallAnnouncer()
        announcer.prime([call("t1", "P004", at: 1)])
        let recall = announcer.announce([call("t1", "P004", at: 5, recalls: 1)])
        XCTAssertEqual(recall.spoken, ["Senha P 4. Guichê 2."])
    }

    func testSeveralCallsAreSpokenInCallOrderUpToThree() {
        let announcer = PanelCallAnnouncer()
        announcer.prime([])
        let calls = (1...5).map { call("t\($0)", "N00\($0)", at: Int64($0), rank: 5 - $0) }
        let announcement = announcer.announce(calls)
        XCTAssertEqual(announcement.spoken, ["Senha N 3. Guichê 2.", "Senha N 4. Guichê 2.", "Senha N 5. Guichê 2."])
        XCTAssertEqual(announcement.latest?.ticketId, "t5")
    }

    func testBurstAfterReconnectOnlyChimes() {
        let announcer = PanelCallAnnouncer()
        announcer.prime([])
        let calls = (1...8).map { call("t\($0)", "N0\($0)", at: Int64($0), rank: 8 - $0) }
        let announcement = announcer.announce(calls)
        XCTAssertTrue(announcement.chime)
        XCTAssertEqual(announcement.spoken, [])
        XCTAssertEqual(announcement.latest?.ticketId, "t8")
    }

    func testSpokenNumberAndText() {
        XCTAssertEqual(PanelCallAnnouncer.spokenTicketNumber("A024"), "A 24")
        XCTAssertEqual(PanelCallAnnouncer.spokenTicketNumber("ab000"), "A B 0")
        XCTAssertEqual(PanelCallAnnouncer.spokenTicketNumber("Senha livre"), "SENHA LIVRE")
        XCTAssertEqual(PanelCallAnnouncer.announcementText(call("t", "N7", desk: nil, at: 1)), "Senha N 7.")
    }

    func testCallFrameBecomesStationCall() {
        let frame = CallFrame(ticketId: "t1", code: "N023", preferential: false, queueId: "q1", queueName: "Geral", counterId: "c1", counterName: "Guichê 2", callCount: 3, recall: true, at: 99, speech: nil)
        let station = frame.stationCall(rank: 0)
        XCTAssertEqual(station.recalls, 2)
        XCTAssertEqual(station.calledAt, "99")
        XCTAssertEqual(station.stationLabel, "Guichê 2")
    }

    func testDestinationAndQueueColor() {
        XCTAssertEqual(PanelDestination.split("Guichê 3"), .init(label: "Guichê", value: "3", long: false))
        XCTAssertEqual(PanelDestination.split("Caixa"), .init(label: "Dirija-se ao", value: "Caixa", long: true))
        XCTAssertEqual(PanelDestination.split(nil).value, "Balcão")
        XCTAssertEqual(PanelQueueLetter.colorIndex("G"), 1)
        XCTAssertEqual(PanelQueueLetter.colorIndex("P"), 3)
        XCTAssertNotEqual(PanelQueueLetter.colorIndex("G"), PanelQueueLetter.colorIndex("C"))
        XCTAssertEqual(PanelQueueLetter.of("b042"), "B")
        XCTAssertNil(PanelQueueLetter.of("123"))
    }
}

final class PanelPinTests: XCTestCase {
    func testObviousPinsAreRefused() {
        XCTAssertNotNil(PanelPin.problem("123"))
        XCTAssertNotNil(PanelPin.problem("12a4"))
        XCTAssertNotNil(PanelPin.problem("1111"))
        XCTAssertNotNil(PanelPin.problem("1234"))
        XCTAssertNotNil(PanelPin.problem("9876"))
        XCTAssertNil(PanelPin.problem("2580"))
    }

    func testSealAndMatch() {
        let sealed = PanelPin.seal("2580")
        XCTAssertFalse(sealed.contains("2580"))
        XCTAssertTrue(PanelPin.matches("2580", sealed: sealed))
        XCTAssertFalse(PanelPin.matches("2581", sealed: sealed))
        XCTAssertNotEqual(PanelPin.seal("2580"), sealed, "sal novo a cada vez")
        XCTAssertFalse(PanelPin.matches("2580", sealed: "lixo"))
    }

    func testFiveFailuresLockForThirtySeconds() {
        var now = Date(timeIntervalSince1970: 0)
        let attempts = PanelPinAttempts { now }
        for _ in 0..<4 { XCTAssertNil(attempts.fail()) }
        XCTAssertFalse(attempts.locked)
        XCTAssertNotNil(attempts.fail())
        XCTAssertTrue(attempts.locked)
        now = now.addingTimeInterval(31)
        XCTAssertFalse(attempts.locked)
    }
}
