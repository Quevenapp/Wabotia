import XCTest
@testable import Wabotia

final class ReservaClientTests: XCTestCase {
    static let bookingJSON = #"{"id":"b1","number":7,"unit_id":"u1","unit_name":"Suíte Mar","mode":"daily","start_date":"2026-11-20","end_date":"2026-11-23","starts":1,"ends":2,"arrival_time":"14:00","departure_time":"11:00","nights":3,"duration_minutes":null,"guests":2,"status":"pending_payment","conversation_id":"c1","customer_name":"Bia","customer_phone":"5520900001111","notes":"","source":"panel","price_cents":90000,"deposit_cents":27000,"payment_id":"p1","payment_status":"created","payment_error":null,"payment_due_at":5,"paid_at":null,"confirmed_at":null,"checkin_status":"none","checkin_answers":{},"changes":0,"created":1,"updated":1}"#

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> ReservaClient {
        StubURLProtocol.reset(handler)
        return ReservaClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testCalendarAvailabilityAndBookingDecode() async throws {
        let c = client { seen in
            switch seen.url.path {
            case let p where p.hasSuffix("/calendar"):
                return .json(200, #"{"from_date":"2026-11-20","to_date":"2026-11-21","days":["2026-11-20","2026-11-21"],"units":[{"unit_id":"u1","name":"Suíte Mar","mode":"daily","active":true,"cells":[{"date":"2026-11-20","state":"pending_payment","booking_ids":["b1"],"block_ids":[]},{"date":"2026-11-21","state":"free","booking_ids":[],"block_ids":[]}]}],"bookings":[\#(Self.bookingJSON)]}"#)
            case let p where p.hasSuffix("/availability"):
                if seen.url.query?.contains("duration_minutes") == true {
                    return .json(200, #"{"date":"2026-11-20","duration_minutes":120,"units":[{"unit_id":"u9","name":"Salão","capacity":40,"price_cents":30000,"slots":[{"starts":10,"ends":20,"time":"14:00","price_cents":30000}]}]}"#)
                }
                return .json(200, #"{"start_date":"2026-11-20","end_date":"2026-11-23","units":[{"unit_id":"u1","name":"Suíte Mar","capacity":2,"available":false,"reason":"unit_unavailable","message":"Ocupada no período.","price_cents":90000,"deposit_cents":27000,"nights":3}]}"#)
            default:
                return .json(200, #"{"data":[\#(Self.bookingJSON)]}"#)
            }
        }
        let calendar = try await c.calendar(from: "2026-11-20", to: "2026-11-21")
        XCTAssertEqual(calendar.units?.first?.cells?.first?.bookingIds, ["b1"])
        XCTAssertEqual(calendar.bookings?.first?.depositCents, 27_000)
        XCTAssertEqual(calendar.bookings?.first?.periodText, "20/11 a 23/11 · 3 diárias")
        let daily = try await c.dailyAvailability(start: "2026-11-20", nights: 3, guests: 2)
        XCTAssertEqual(daily.units?.first?.available, false)
        XCTAssertEqual(daily.units?.first?.message, "Ocupada no período.")
        let hourly = try await c.hourlyAvailability(date: "2026-11-20", minutes: 120, unitId: "u9")
        XCTAssertEqual(hourly.units?.first?.slots?.first?.clock, "14:00")
        let list = try await c.bookings(statuses: ["pending_payment", "confirmed"], query: "bia")
        XCTAssertEqual(list.first?.number, 7)
        let query = Dictionary(uniqueKeysWithValues: URLComponents(url: StubURLProtocol.seen.last!.url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["status"], "pending_payment,confirmed")
        XCTAssertEqual(query["q"], "bia")
        let dailyQuery = StubURLProtocol.seen[1].url.query ?? ""
        XCTAssertTrue(dailyQuery.contains("staff=1") && dailyQuery.contains("nights=3") && dailyQuery.contains("guests=2"))
    }

    func testWritesCarryKeyAndPaths() async throws {
        let c = client { _ in .json(200, Self.bookingJSON) }
        _ = try await c.create(["unit_id": "u1", "start_date": "2026-11-20", "nights": 3, "conversation_id": "c1", "deposit": true], key: "k1")
        _ = try await c.update("b1", ["guests": 3], key: "k2")
        _ = try await c.cancel("b1", reason: nil, key: "k3")
        _ = try await c.confirm("b1", key: "k4")
        _ = try await c.deposit("b1", key: "k5")
        _ = try await c.checkin("b1", key: "k6")
        let seen = StubURLProtocol.seen
        XCTAssertEqual(seen.map(\.method), ["POST", "PATCH", "POST", "POST", "POST", "POST"])
        XCTAssertEqual(seen.map { $0.url.path.replacingOccurrences(of: "/api/v1/profiles/p1/reserva/bookings", with: "") }, ["", "/b1", "/b1/cancel", "/b1/confirm", "/b1/deposit", "/b1/checkin"])
        XCTAssertEqual(seen.map { $0.header("Idempotency-Key") }, ["k1", "k2", "k3", "k4", "k5", "k6"])
        XCTAssertEqual(seen[0].json["nights"] as? Int, 3)
        XCTAssertEqual(seen[0].json["deposit"] as? Bool, true)
        XCTAssertNil(seen[2].json["reason"])
    }
}

final class ReservaRulesTests: XCTestCase {
    private func booking(_ status: String, conversation: String? = "c1", checkin: String? = "none") -> Booking {
        Booking(id: "b", status: status, conversationId: conversation, checkinStatus: checkin)
    }

    func testActionsByState() {
        XCTAssertTrue(ReservaRules.canConfirm(booking("pending_payment")))
        XCTAssertTrue(ReservaRules.canChargeDeposit(booking("pending_payment")))
        XCTAssertFalse(ReservaRules.canChargeDeposit(booking("pending_payment", conversation: nil)), "sinal só pela conversa")
        XCTAssertTrue(ReservaRules.canSendCheckin(booking("confirmed")))
        XCTAssertFalse(ReservaRules.canSendCheckin(booking("confirmed", checkin: "completed")))
        XCTAssertFalse(ReservaRules.canEdit(booking("expired")) || ReservaRules.canCancel(booking("completed")))
        XCTAssertEqual(ReservaRules.statusLabel("pending_payment"), "Aguardando sinal")
    }

    func testConflictsAreExplained() {
        for code in ["unit_unavailable", "unit_blocked", "outside_rules", "booking_closed"] {
            let error = QueueError(status: 409, code: code, message: "Estadia mínima de 2 diárias.")
            XCTAssertTrue(ReservaRules.isConflict(error))
            XCTAssertFalse(ReservaRules.explain(error).isEmpty)
        }
        XCTAssertTrue(ReservaRules.explain(QueueError(status: 409, code: "outside_rules", message: "Estadia mínima de 2 diárias.")).contains("Estadia mínima"))
        XCTAssertFalse(ReservaRules.isConflict(QueueError(status: 0, code: "network", message: "x")))
        XCTAssertEqual(ReservaRules.shortDay("2026-11-05"), "05/11")
    }
}

@MainActor
final class BookingFormViewModelTests: XCTestCase {
    private let overview = #"{"config":{},"units":[{"id":"u1","name":"Suíte Mar","mode":"daily","capacity":2,"price_cents":30000,"active":true,"position":0},{"id":"u9","name":"Salão","mode":"hourly","capacity":40,"price_cents":15000,"active":true,"position":1}],"deposit":{"available":true,"reason":null,"message":null}}"#

    func testUnavailableUnitReloadsAndExplains() async {
        var dailyReads = 0
        var posts = 0
        StubURLProtocol.reset { seen in
            if seen.url.path.hasSuffix("/reserva") { return .json(200, self.overview) }
            if seen.url.path.hasSuffix("/availability") {
                dailyReads += 1
                let available = dailyReads == 1
                return .json(200, #"{"units":[{"unit_id":"u1","name":"Suíte Mar","available":\#(available),"reason":\#(available ? "null" : "\"unit_unavailable\""),"message":\#(available ? "null" : "\"Ocupada no período.\""),"price_cents":60000,"nights":2}]}"#)
            }
            posts += 1
            return .json(409, #"{"error":{"code":"unit_unavailable","message":"Unidade ocupada."}}"#)
        }
        let client = ReservaClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "x" })
        let vm = BookingFormViewModel(purpose: .new(conversationId: "c1", customer: "Bia", unitId: nil, date: nil), client: client, today: "2026-11-20") { _ in }
        await vm.load()
        XCTAssertEqual(vm.unitId, "u1")
        XCTAssertTrue(vm.canSubmit)
        let body = vm.body()
        XCTAssertEqual(body["conversation_id"] as? String, "c1")
        XCTAssertEqual(body["deposit"] as? Bool, true, "sinal pela conversa quando a Cobrança está pronta")
        XCTAssertNil(body["customer_name"] ?? nil)
        await vm.submit()
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(dailyReads, 2, "a disponibilidade foi lida de novo")
        XCTAssertEqual(vm.chosenDaily?.available, false)
        XCTAssertFalse(vm.canSubmit, "a unidade ocupada não pode ser reservada")
        XCTAssertTrue(vm.notice?.contains("acabou de ser reservada") == true)
    }

    func testHourlyNeedsASlotAndEditSendsOnlyChanges() async {
        StubURLProtocol.reset { seen in
            if seen.url.path.hasSuffix("/reserva") { return .json(200, self.overview) }
            if seen.url.path.hasSuffix("/availability") { return .json(200, #"{"units":[{"unit_id":"u9","slots":[{"starts":1000,"ends":2000,"time":"14:00"}]}]}"#) }
            return .json(200, ReservaClientTests.bookingJSON)
        }
        let client = ReservaClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "x" })
        let walkIn = BookingFormViewModel(purpose: .new(conversationId: nil, customer: nil, unitId: "u9", date: nil), client: client, today: "2026-11-20") { _ in }
        await walkIn.load()
        XCTAssertTrue(walkIn.isHourly)
        walkIn.customerName = "Festa da Ana"
        XCTAssertFalse(walkIn.canSubmit)
        walkIn.slot = walkIn.slots.first
        XCTAssertTrue(walkIn.canSubmit)
        XCTAssertEqual(walkIn.body()["starts"] as? Int64, 1000)
        XCTAssertEqual(walkIn.body()["duration_minutes"] as? Int, 60)

        let existing = try! QueueJSON.decoder.decode(Booking.self, from: Data(ReservaClientTests.bookingJSON.utf8))
        let edit = BookingFormViewModel(purpose: .edit(existing), client: client, today: "2026-11-20") { _ in }
        await edit.load()
        XCTAssertEqual(edit.nights, 3)
        await edit.submit()
        let patch = StubURLProtocol.seen.first { $0.method == "PATCH" }
        XCTAssertNotNil(patch)
        XCTAssertNil(patch?.json["conversation_id"], "alterar não troca a conversa")
        XCTAssertNil(patch?.json["deposit"])
        XCTAssertNotNil(edit.result)
    }
}
