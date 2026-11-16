import XCTest
@testable import Wabotia

final class ModuleBasicsTests: XCTestCase {
    func testBrasiliaDayAndWeek() {
        // 2026-11-15 é domingo; 02:30 UTC ainda é dia 14 em Brasília.
        let late = BrasiliaTime.date(Int64(1_763_173_800_000)) // 2025-11-15 02:30 UTC
        XCTAssertEqual(BrasiliaTime.day(late), "2025-11-14")
        XCTAssertEqual(BrasiliaTime.weekStart("2026-11-15"), "2026-11-09")
        XCTAssertEqual(BrasiliaTime.weekStart("2026-11-09"), "2026-11-09")
        XCTAssertEqual(BrasiliaTime.addDays("2026-11-30", 1), "2026-12-01")
        let range = BrasiliaTime.range(from: "2026-11-15")!
        XCTAssertEqual(range.to - range.from, 86_400_000)
        XCTAssertEqual(BrasiliaTime.clock(range.from), "00:00")
        XCTAssertEqual(BrasiliaTime.day(range.from), "2026-11-15")
        XCTAssertEqual(BrasiliaTime.range(from: "2026-11-09", days: 7)!.to, BrasiliaTime.range(from: "2026-11-16")!.from)
    }

    func testMoney() {
        XCTAssertEqual(Money.format(4500), "R$ 45,00")
        XCTAssertEqual(Money.format(123_456_789), "R$ 1.234.567,89")
        XCTAssertEqual(Money.format(5), "R$ 0,05")
        XCTAssertEqual(Money.parse("45"), 4500)
        XCTAssertEqual(Money.parse("45,9"), 4590)
        XCTAssertEqual(Money.parse("R$ 1.234,56"), 123_456)
        XCTAssertNil(Money.parse("abc"))
        XCTAssertNil(Money.parse("1,234"))
        XCTAssertNil(Money.parse(""))
    }

    func testIntentKeysKeepTheKeyOnlyForRetryableFailures() {
        let keys = IntentKeys()
        let first = keys.key(for: "a")
        keys.settle(QueueError(status: 0, code: "network", message: "x"))
        XCTAssertEqual(keys.key(for: "a"), first)
        XCTAssertNotEqual(keys.key(for: "b"), first, "outra intenção, outra chave")
        let b = keys.key(for: "b")
        keys.settle(QueueError(status: 409, code: "slot_taken", message: "x"))
        XCTAssertNotEqual(keys.key(for: "b"), b)
        keys.settle(nil)
        XCTAssertNil(keys.pendingKey)
    }
}

final class AgendaClientTests: XCTestCase {
    static let appointmentJSON = #"{"id":"a1","service_id":"s1","service_name":"Corte","professional_id":"p1","professional_name":"Rui","starts":1763211600000,"ends":1763213400000,"date":"2025-11-15","time":"10:00","status":"booked","conversation_id":"c1","contact_id":null,"customer_name":"Bia","customer_phone":"5520900001111","notes":"","source":"whatsapp","price_cents":4500,"booked_at":1763100000000,"reminded_at":null,"confirmed_at":null,"cancelled_at":null,"cancelled_by":null,"cancel_reason":"","no_show_at":null,"moves":0,"created_by":"customer","created":1,"updated":2}"#

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> AgendaClient {
        StubURLProtocol.reset(handler)
        return AgendaClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testCatalogAndAppointmentsDecode() async throws {
        let c = client { seen in
            if seen.url.path.hasSuffix("/agenda") {
                return .json(200, #"{"config":{"slot_minutes":30},"services":[{"id":"s1","name":"Corte","description":"","duration_minutes":30,"price_cents":4500,"active":true,"position":0}],"professionals":[{"id":"p1","name":"Rui","user_id":null,"active":true,"position":0,"service_ids":["s1"],"hours":[{"weekday":2,"start":"09:00","end":"12:00"}]}]}"#)
            }
            return .json(200, #"{"data":[\#(Self.appointmentJSON)]}"#)
        }
        let catalog = try await c.catalog()
        XCTAssertEqual(catalog.services?.first?.durationMinutes, 30)
        XCTAssertEqual(catalog.professionals?.first?.serviceIds, ["s1"])
        XCTAssertEqual(catalog.professionals?.first?.hours?.first?.start, "09:00")
        let list = try await c.appointments(from: 10, to: 20, professionalId: "p1")
        XCTAssertEqual(list.first?.clock, "10:00")
        XCTAssertEqual(list.first?.priceCents, 4500)
        XCTAssertEqual(list.first?.customer, "Bia")
        let seen = StubURLProtocol.seen[1]
        XCTAssertEqual(seen.url.path, "/api/v1/profiles/p1/agenda/appointments")
        let query = Dictionary(uniqueKeysWithValues: URLComponents(url: seen.url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query, ["from": "10", "to": "20", "professional_id": "p1"])
        XCTAssertEqual(seen.header("Authorization"), "Bearer wabu_x")
    }

    func testAvailabilityAsksAsStaff() async throws {
        let c = client { _ in .json(200, #"{"service_id":"s1","professional_id":null,"days":[{"date":"2026-11-17","slots":[{"starts":1,"ends":2,"time":"09:00","professional_ids":["p1","p2"]}]}]}"#) }
        let found = try await c.availability(serviceId: "s1", professionalId: nil, date: "2026-11-17")
        XCTAssertEqual(found.days?.first?.slots?.first?.professionalIds, ["p1", "p2"])
        let query = URLComponents(url: StubURLProtocol.seen[0].url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(Set(query.map(\.name)), ["service_id", "date", "staff"])
        XCTAssertEqual(query.first { $0.name == "staff" }?.value, "1")
    }

    func testWritesCarryKeyAndBody() async throws {
        let c = client { _ in .json(200, Self.appointmentJSON) }
        _ = try await c.book(serviceId: "s1", starts: 99, professionalId: nil, conversationId: "c1", customerName: nil, customerPhone: nil, notes: nil, key: "k1")
        _ = try await c.move("a1", starts: 100, professionalId: "p2", key: "k2")
        _ = try await c.cancel("a1", reason: "cliente pediu", key: "k3")
        _ = try await c.confirm("a1", key: "k4")
        _ = try await c.noShow("a1", key: "k5")
        let seen = StubURLProtocol.seen
        XCTAssertEqual(seen.map(\.url.path), ["/api/v1/profiles/p1/agenda/appointments", "/api/v1/profiles/p1/agenda/appointments/a1/move",
                                              "/api/v1/profiles/p1/agenda/appointments/a1/cancel", "/api/v1/profiles/p1/agenda/appointments/a1/confirm",
                                              "/api/v1/profiles/p1/agenda/appointments/a1/no-show"])
        XCTAssertEqual(seen.map { $0.header("Idempotency-Key") }, ["k1", "k2", "k3", "k4", "k5"])
        XCTAssertEqual(seen[0].json["service_id"] as? String, "s1")
        XCTAssertEqual(seen[0].json["conversation_id"] as? String, "c1")
        XCTAssertNil(seen[0].json["professional_id"], "sem profissional: quem estiver livre")
        XCTAssertNil(seen[0].json["customer_name"])
        XCTAssertEqual(seen[1].json["professional_id"] as? String, "p2")
        XCTAssertEqual(seen[2].json["reason"] as? String, "cliente pediu")
    }
}

final class AgendaRulesTests: XCTestCase {
    private func appointment(_ id: String, professional: String, at hour: Int, status: String = "booked", day: String = "2026-11-17") -> Appointment {
        let starts = BrasiliaTime.range(from: day)!.from + Int64(hour) * 3_600_000
        return Appointment(id: id, professionalId: professional, starts: starts, ends: starts + 1_800_000, status: status)
    }

    func testActionsByStateAndTime() {
        let future = appointment("a", professional: "p1", at: 10)
        let before = BrasiliaTime.date(future.starts - 60_000), after = BrasiliaTime.date(future.starts + 60_000)
        XCTAssertTrue(AgendaRules.canConfirm(future))
        XCTAssertFalse(AgendaRules.canMarkNoShow(future, now: before), "ausência só depois do início")
        XCTAssertTrue(AgendaRules.canMarkNoShow(future, now: after))
        let confirmed = appointment("b", professional: "p1", at: 10, status: "confirmed")
        XCTAssertFalse(AgendaRules.canConfirm(confirmed))
        XCTAssertTrue(AgendaRules.canMove(confirmed))
        let cancelled = appointment("c", professional: "p1", at: 10, status: "cancelled")
        XCTAssertFalse(AgendaRules.canMove(cancelled) || AgendaRules.canCancel(cancelled) || AgendaRules.canMarkNoShow(cancelled, now: after))
        XCTAssertEqual(AgendaRules.statusLabel("no_show"), "Ausente")
    }

    func testColumnsPerProfessionalAndWeek() {
        let pros = [AgendaProfessional(id: "p2", name: "Léo", position: 1), AgendaProfessional(id: "p1", name: "Rui", position: 0),
                    AgendaProfessional(id: "p3", name: "Arquivado", active: false)]
        let list = [appointment("x", professional: "p1", at: 15), appointment("y", professional: "p1", at: 9), appointment("z", professional: "p9", at: 11)]
        let columns = AgendaRules.columns(list, professionals: pros)
        XCTAssertEqual(columns.map(\.professional.id), ["p1", "p2", "p9"])
        XCTAssertEqual(columns[0].items.map(\.id), ["y", "x"])
        XCTAssertTrue(columns[1].items.isEmpty)

        let week = AgendaRules.week(list + [appointment("w", professional: "p2", at: 9, day: "2026-11-21")], start: "2026-11-16")
        XCTAssertEqual(week.map(\.day).first, "2026-11-16")
        XCTAssertEqual(week.count, 7)
        XCTAssertEqual(week[1].items.count, 3)
        XCTAssertEqual(week[5].items.map(\.id), ["w"])
    }

    func testProfessionalsForService() {
        let pros = [AgendaProfessional(id: "p1", name: "Rui", serviceIds: ["s1"]), AgendaProfessional(id: "p2", name: "Léo", serviceIds: ["s2"]),
                    AgendaProfessional(id: "p3", name: "Ana", serviceIds: []), AgendaProfessional(id: "p4", name: "Fora", active: false)]
        XCTAssertEqual(AgendaRules.professionals(for: "s1", in: pros).map(\.id).sorted(), ["p1", "p3"])
        XCTAssertEqual(AgendaRules.professionals(for: nil, in: pros).count, 3)
    }
}

@MainActor
final class BookingViewModelTests: XCTestCase {
    private var failures: [QueueError] = []

    private func model(_ purpose: BookingViewModel.Purpose, _ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> BookingViewModel {
        StubURLProtocol.reset(handler)
        failures = []
        let client = AgendaClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
        return BookingViewModel(purpose: purpose, client: client, today: "2026-11-17") { [unowned self] in self.failures.append($0) }
    }

    private let catalog = #"{"services":[{"id":"s1","name":"Corte","duration_minutes":30}],"professionals":[{"id":"p1","name":"Rui","service_ids":["s1"]}]}"#

    func testSlotTakenReloadsTheSlotsAndAsksForAnother() async {
        var availabilityReads = 0
        var bookKeys: [String?] = []
        let vm = model(.new(conversationId: "c1", customer: "Bia")) { seen in
            if seen.url.path.hasSuffix("/agenda") { return .json(200, self.catalog) }
            if seen.url.path.hasSuffix("/availability") {
                availabilityReads += 1
                let slots = availabilityReads == 1
                    ? #"[{"starts":1000,"time":"09:00","professional_ids":["p1"]},{"starts":2000,"time":"09:30","professional_ids":["p1"]}]"#
                    : #"[{"starts":2000,"time":"09:30","professional_ids":["p1"]}]"#
                return .json(200, #"{"days":[{"date":"2026-11-17","slots":\#(slots)}]}"#)
            }
            bookKeys.append(seen.header("Idempotency-Key"))
            return bookKeys.count == 1
                ? .json(409, #"{"error":{"code":"slot_taken","message":"Horário ocupado."}}"#)
                : .json(200, AgendaClientTests.appointmentJSON)
        }
        await vm.load()
        XCTAssertEqual(vm.serviceId, "s1")
        XCTAssertEqual(vm.slots.count, 2)
        vm.slot = vm.slots.first
        XCTAssertTrue(vm.canSubmit, "da conversa não precisa de nome")
        await vm.submit()
        XCTAssertEqual(vm.notice, BookingViewModel.conflictMessage)
        XCTAssertNil(vm.slot)
        XCTAssertEqual(vm.slots.map(\.starts), [2000], "os horários foram lidos de novo")
        XCTAssertNil(vm.result)
        let body = StubURLProtocol.seen.first { $0.method == "POST" }!.json
        XCTAssertEqual(body["conversation_id"] as? String, "c1")
        XCTAssertEqual(body["starts"] as? Int, 1000)
        vm.slot = vm.slots.first
        await vm.submit()
        XCTAssertNotNil(vm.result)
        XCTAssertNotEqual(bookKeys[0], bookKeys[1], "pedido novo depois da recusa")
    }

    func testWalkInNeedsANameAndMoveUsesTheMoveRoute() async {
        let walkIn = model(.new(conversationId: nil, customer: nil)) { seen in
            seen.url.path.hasSuffix("/agenda") ? .json(200, self.catalog) : .json(200, #"{"days":[{"date":"2026-11-17","slots":[{"starts":5000}]}]}"#)
        }
        await walkIn.load()
        walkIn.slot = walkIn.slots.first
        XCTAssertFalse(walkIn.canSubmit)
        walkIn.customerName = "Carlos"
        XCTAssertTrue(walkIn.canSubmit)

        let a = Appointment(id: "a1", serviceId: "s1", professionalId: "p1", starts: 1, status: "booked")
        let move = model(.move(a)) { seen in
            if seen.method == "POST" { return .json(200, AgendaClientTests.appointmentJSON) }
            return seen.url.path.hasSuffix("/agenda") ? .json(200, self.catalog) : .json(200, #"{"days":[{"date":"2026-11-17","slots":[{"starts":7000}]}]}"#)
        }
        await move.load()
        XCTAssertEqual(move.professionalId, "p1")
        move.slot = move.slots.first
        await move.submit()
        let post = StubURLProtocol.seen.first { $0.method == "POST" }!
        XCTAssertTrue(post.url.path.hasSuffix("/agenda/appointments/a1/move"))
        XCTAssertEqual(post.json["starts"] as? Int, 7000)
    }

    func testModuleDisabledIsReported() async {
        let vm = model(.new(conversationId: nil, customer: nil)) { _ in .json(409, #"{"error":{"code":"module_disabled","message":"x"}}"#) }
        await vm.load()
        XCTAssertEqual(failures.first?.moduleDisabled, true)
        XCTAssertEqual(vm.notice, ModuleFailure.disabledMessage)
    }
}
