import XCTest
@testable import Wabotia

/// Relógio da janela de 24 horas (mobile/DESIGN.md, seção 2): tempo restante, limites de cor e textos.
final class WindowClockTests: XCTestCase {
    private let hour: Int64 = 3_600_000
    private let minute: Int64 = 60_000
    private let now: Int64 = 1_794_146_400_000

    private func clock(remaining: Int64) -> WindowClock {
        WindowClock(lastCustomer: now - WindowClock.windowMillis + remaining, now: now)
    }

    func testRemainingAndExpiry() {
        let c = WindowClock(lastCustomer: now - 46 * minute, now: now)
        XCTAssertEqual(c.expires, now - 46 * minute + 24 * hour)
        XCTAssertEqual(c.remaining, 23 * hour + 14 * minute)
        XCTAssertFalse(c.isClosed)
        XCTAssertEqual(c.fraction, Double(23 * hour + 14 * minute) / Double(24 * hour), accuracy: 0.0001)
    }

    func testClosedWhenCustomerNeverWroteOrTimeRanOut() {
        XCTAssertTrue(WindowClock(lastCustomer: 0, now: now).isClosed)
        XCTAssertEqual(WindowClock(lastCustomer: 0, now: now).remaining, 0)
        XCTAssertEqual(WindowClock(lastCustomer: 0, now: now).level, .closed)
        XCTAssertTrue(clock(remaining: 0).isClosed)
        XCTAssertTrue(WindowClock(lastCustomer: now - 30 * hour, now: now).isClosed)
        XCTAssertEqual(WindowClock(lastCustomer: now - 30 * hour, now: now).fraction, 0)
        XCTAssertEqual(WindowClock(lastCustomer: now - 30 * hour, now: now).label, "Janela fechada")
        XCTAssertEqual(WindowClock(lastCustomer: now - 30 * hour, now: now).compact, "")
    }

    func testColourThresholds() {
        XCTAssertEqual(clock(remaining: 24 * hour).level, .ok)
        XCTAssertEqual(clock(remaining: 6 * hour + 1).level, .ok)
        XCTAssertEqual(clock(remaining: 6 * hour).level, .warn)
        XCTAssertEqual(clock(remaining: 5 * hour + 2 * minute).level, .warn)
        XCTAssertEqual(clock(remaining: hour).level, .warn)
        XCTAssertEqual(clock(remaining: hour - 1).level, .danger)
        XCTAssertEqual(clock(remaining: 42 * minute).level, .danger)
        XCTAssertEqual(clock(remaining: 1).level, .danger)
        XCTAssertEqual(clock(remaining: 0).level, .closed)
        XCTAssertEqual(clock(remaining: -5 * minute).level, .closed)
    }

    func testLabels() {
        XCTAssertEqual(clock(remaining: 23 * hour + 14 * minute).label, "23h 14min")
        XCTAssertEqual(clock(remaining: 5 * hour + 2 * minute + 30_000).label, "5h 02min")
        XCTAssertEqual(clock(remaining: hour).label, "1h 00min")
        XCTAssertEqual(clock(remaining: 42 * minute + 59_000).label, "42 min")
        XCTAssertEqual(clock(remaining: minute).label, "1 min")
        XCTAssertEqual(clock(remaining: 59_000).label, "menos de 1 min")
        XCTAssertEqual(clock(remaining: 0).label, "Janela fechada")
    }

    func testCompactLabels() {
        XCTAssertEqual(clock(remaining: 23 * hour + 14 * minute).compact, "23h")
        XCTAssertEqual(clock(remaining: 5 * hour + 2 * minute).compact, "5h")
        XCTAssertEqual(clock(remaining: 42 * minute).compact, "42m")
        XCTAssertEqual(clock(remaining: 20_000).compact, "1m")
        XCTAssertEqual(clock(remaining: 0).compact, "")
    }

    func testBannerText() {
        XCTAssertEqual(clock(remaining: 21 * hour + 14 * minute).bannerText, "Janela de 24h · 21h 14min restantes")
        XCTAssertEqual(clock(remaining: 3 * hour).bannerText, "Janela de 24h · 3h 00min restantes")
        XCTAssertEqual(clock(remaining: 42 * minute).bannerText, "Janela fecha em 42 min")
        XCTAssertEqual(clock(remaining: 0).bannerText, "Janela fechada · só volta quando o cliente escrever")
    }

    func testUntilLabelTodayAndTomorrow() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Sao_Paulo")!
        // 10/11/2026 12:00 em São Paulo.
        let noon = Int64(calendar.date(from: DateComponents(year: 2026, month: 11, day: 10, hour: 12))!.timeIntervalSince1970 * 1000)
        // Expira hoje às 14:32.
        let today = WindowClock(lastCustomer: noon - 24 * hour + 2 * hour + 32 * minute, now: noon)
        XCTAssertEqual(today.untilLabel(calendar: calendar), "até 14:32")
        // Expira amanhã às 09:10.
        let tomorrow = WindowClock(lastCustomer: noon - 24 * hour + 21 * hour + 10 * minute, now: noon)
        XCTAssertEqual(tomorrow.untilLabel(calendar: calendar), "até amanhã 09:10")
        XCTAssertNil(WindowClock(lastCustomer: 0, now: noon).untilLabel(calendar: calendar))
    }

    func testAppliesOnlyToDirectChatsOnOfficialLines() {
        XCTAssertTrue(WindowClock.applies(chatType: "direct", connectionKind: "meta"))
        XCTAssertTrue(WindowClock.applies(chatType: "direct", connectionKind: "zernio"))
        XCTAssertTrue(WindowClock.applies(chatType: nil, connectionKind: nil), "tipo de linha desconhecido mostra o relógio")
        XCTAssertTrue(WindowClock.applies(chatType: "direct", connectionKind: ""))
        XCTAssertFalse(WindowClock.applies(chatType: "group", connectionKind: "meta"))
        XCTAssertFalse(WindowClock.applies(chatType: "direct", connectionKind: "telegram"))
    }

    func testDateInitializerMatchesMillis() {
        let date = Date(timeIntervalSince1970: Double(now) / 1000)
        XCTAssertEqual(WindowClock(lastCustomer: now - hour, now: date), WindowClock(lastCustomer: now - hour, now: now))
    }

    func testActionRequestEncodesDepartmentWithoutTarget() throws {
        let body = try JSONEncoder.wabotia.encode(ActionRequest(action: "transfer", department_id: "dep1"))
        let json = try JSONDecoder.wabotia.decode(JSONValue.self, from: body)
        XCTAssertEqual(json["department_id"]?.stringValue, "dep1")
        XCTAssertNil(json["target"])
        let protocols = try JSONDecoder.wabotia.decode(JSONValue.self, from: JSONEncoder.wabotia.encode(ActionRequest(action: "protocols", number: "WA-ABC-1234")))
        XCTAssertEqual(protocols["number"]?.stringValue, "WA-ABC-1234")
    }

    func testDepartmentsAndConnectionKindFromStatus() throws {
        let data = Data(#"{"settings":{"departments":[{"id":"d1","name":"Financeiro","enabled":true,"members":["u1","u2"]},{"id":"d2","name":"Antigo","enabled":false,"members":[]}]},"conversations":[{"state":"waiting","count":3}],"deliveries":[],"connections":[{"id":"n1","name":"Principal","kind":"meta","status":"active"}]}"#.utf8)
        let status = try JSONDecoder.wabotia.decode(ProfileStatus.self, from: data)
        XCTAssertEqual(status.departments.count, 2)
        XCTAssertEqual(status.departments.first?.members, ["u1", "u2"])
        XCTAssertEqual(status.departments.filter(\.enabled).map(\.name), ["Financeiro"])
        XCTAssertEqual(status.conversationCount("waiting"), 3)
        XCTAssertEqual(status.conversationCount("ai"), 0)
        XCTAssertEqual(status.connectionKind("n1"), "meta")
        XCTAssertNil(status.connectionKind("outro"))
    }
}
