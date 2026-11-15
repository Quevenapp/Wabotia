import Combine
import XCTest
@testable import Wabotia

/// Os dois módulos abrem na demonstração, sem servidor real, pelo mesmo `DemoURLProtocol` do app.
final class DemoModulesTests: XCTestCase {
    private let base = DemoMode.serverURL.absoluteString

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private var api: ProfileAPI { ProfileAPI(baseURL: base, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { "wabu_demo" } }

    func testCapabilitiesListBothModules() async {
        let ids = await ModulesProbe(baseURL: base, profileId: DemoMode.profileId, token: { "wabu_demo" }, session: QueueHTTP.makeSession()).check()
        XCTAssertEqual(ids, ["queue", "agenda", "os", "reserva", "mensalidade"])
    }

    func testReservaDemo() async throws {
        let reserva = ReservaClient(api: api)
        let today = BrasiliaTime.today()
        let calendar = try await reserva.calendar(from: today, to: BrasiliaTime.addDays(today, 13))
        XCTAssertEqual(calendar.units?.count, 4)
        XCTAssertTrue(calendar.units?.contains { $0.cells?.contains { $0.state == "blocked" } ?? false } ?? false, "há um bloqueio de manutenção")
        XCTAssertTrue(calendar.bookings?.contains { $0.state == "pending_payment" } ?? false)
        let free = try await reserva.dailyAvailability(start: today, nights: 2, guests: 2)
        XCTAssertEqual(free.units?.first { $0.unitId == "u_mar" }?.available, false, "a suíte está ocupada hoje")
        let available = try XCTUnwrap(free.units?.first { $0.available == true })
        let created = try await reserva.create(["unit_id": available.unitId, "start_date": today, "nights": 2, "guests": 2, "customer_name": "Hóspede de teste"], key: "rs-a")
        XCTAssertEqual(created.state, "confirmed")
        do {
            _ = try await reserva.create(["unit_id": available.unitId, "start_date": today, "nights": 2, "guests": 2, "customer_name": "Outro"], key: "rs-b")
            XCTFail("mesma unidade, mesmo período")
        } catch { XCTAssertEqual((error as? QueueError)?.code, "unit_unavailable") }
        do {
            _ = try await reserva.create(["unit_id": "u_mar", "start_date": today, "nights": 20, "guests": 2, "customer_name": "Longa"], key: "rs-c")
            XCTFail("acima da estadia máxima")
        } catch { XCTAssertTrue(ReservaRules.isConflict(error)) }
        _ = try await reserva.cancel(created.id, reason: nil, key: "rs-d")
        do { _ = try await reserva.confirm(created.id, key: "rs-e"); XCTFail() } catch { XCTAssertEqual((error as? QueueError)?.code, "booking_closed") }
        let hourly = try await reserva.hourlyAvailability(date: BrasiliaTime.addDays(today, 3), minutes: 120, unitId: "u_salao")
        XCTAssertFalse(hourly.units?.first?.slots?.isEmpty ?? true)
    }

    func testMensalidadeDemo() async throws {
        let ms = MensalidadeClient(api: api)
        let month = MensalidadeRules.currentMonth()
        let summary = try await ms.summary(month: month)
        XCTAssertGreaterThan(summary.receivedCents ?? 0, 0)
        XCTAssertGreaterThan(summary.overdueCents ?? 0, 0)
        let page = try await ms.installments(month: month, statuses: ["open"])
        XCTAssertEqual(page.data?.count, 2)
        let late = try await ms.delinquents()
        XCTAssertEqual(late.first?.overdueCount, 2, "a aluna com duas parcelas vencidas vem primeiro")
        let open = try XCTUnwrap(page.data?.first)
        let paid = try await ms.pay(open.id, note: "dinheiro", paidAt: BrasiliaTime.today(), notify: false, key: "ms-a")
        XCTAssertEqual(paid.state, "paid")
        do { _ = try await ms.waive(open.id, note: nil, key: "ms-b"); XCTFail() } catch { XCTAssertEqual((error as? QueueError)?.code, "installment_not_payable") }
        let paused = try await ms.subscriptionAction("ms_1", "pause", key: "ms-c")
        XCTAssertEqual(paused.state, "paused")
        let detail = try await ms.subscription("ms_3")
        XCTAssertEqual(detail.installments?.count, 2)
    }

    func testAgendaDayAvailabilityAndConflict() async throws {
        let agenda = AgendaClient(api: api)
        let catalog = try await agenda.catalog()
        XCTAssertEqual(catalog.professionals?.count, 2)
        let today = BrasiliaTime.range(from: BrasiliaTime.today())!
        let list = try await agenda.appointments(from: today.from, to: today.to)
        XCTAssertGreaterThanOrEqual(list.count, 5, "a barbearia tem o dia cheio")
        XCTAssertTrue(list.contains { $0.conversationId == "c_rich" })
        XCTAssertTrue(list.allSatisfy { $0.customerPhone?.hasPrefix("552090") ?? true }, "telefones fictícios")

        let tomorrow = BrasiliaTime.addDays(BrasiliaTime.today(), 1)
        let free = try await agenda.availability(serviceId: "s_corte", professionalId: "p_leo", date: tomorrow)
        let slot = try XCTUnwrap(free.days?.first?.slots?.first)
        let booked = try await agenda.book(serviceId: "s_corte", starts: slot.starts, professionalId: "p_leo", conversationId: nil, customerName: "Cliente de teste", customerPhone: nil, notes: nil, key: "demo-a")
        XCTAssertEqual(booked.professionalName, "Léo Prado")
        do {
            _ = try await agenda.book(serviceId: "s_corte", starts: slot.starts, professionalId: "p_leo", conversationId: nil, customerName: "Outro", customerPhone: nil, notes: nil, key: "demo-b")
            XCTFail("mesmo horário do mesmo profissional")
        } catch { XCTAssertTrue(AgendaRules.isSlotConflict(error)) }
        let again = try await agenda.availability(serviceId: "s_corte", professionalId: "p_leo", date: tomorrow)
        XCTAssertFalse(again.days?.first?.slots?.contains { $0.starts == slot.starts } ?? true, "o horário ocupado sai da lista")
        let confirmed = try await agenda.confirm(booked.id, key: "demo-c")
        XCTAssertEqual(confirmed.state, "confirmed")
        let cancelled = try await agenda.cancel(booked.id, reason: "teste", key: "demo-d")
        XCTAssertEqual(cancelled.state, "cancelled")
        do { _ = try await agenda.confirm(booked.id, key: "demo-e"); XCTFail() } catch { XCTAssertEqual((error as? QueueError)?.code, "appointment_closed") }
    }

    func testServiceOrdersFlow() async throws {
        let os = ServiceOrderClient(api: api)
        let open = try await os.list(open: true)
        XCTAssertEqual(open.data?.count, 7, "abertas: todas menos entregue e cancelada")
        XCTAssertEqual(open.data?.first?.number, 8)
        XCTAssertEqual(open.count("delivered"), 1)
        let search = try await os.list(query: "iphone")
        XCTAssertEqual(search.data?.map(\.number), [6])

        let quoted = try await os.order("os_6")
        XCTAssertEqual(quoted.quote?.total, 36_900)
        XCTAssertEqual(ServiceOrderRules.actions(for: quoted).map(\.status), ["analyzing", "quoted", "approved", "declined", "cancelled"])
        XCTAssertFalse(quoted.history?.isEmpty ?? true)

        let created = try await os.create(item: "Fone de ouvido", problem: "Lado direito mudo", conversationId: nil, phone: "20900007777", customerName: "Clara", notes: "interno", dueAt: nil, key: "os-1")
        XCTAssertEqual(created.number, 9)
        XCTAssertEqual(created.state, "received")
        do { _ = try await os.setStatus(created.id, status: "delivered", note: nil, key: "os-2"); XCTFail() } catch { XCTAssertEqual((error as? QueueError)?.code, "invalid_transition") }
        _ = try await os.saveQuote(created.id, items: [QuoteItem(description: "Driver", quantity: 1, unitCents: 9_000)], validDays: 5, note: nil, key: "os-3")
        do { _ = try await os.sendQuote(created.id, notify: true, key: "os-4"); XCTFail() } catch { XCTAssertEqual((error as? QueueError)?.code, "no_conversation") }
        let sent = try await os.sendQuote(created.id, notify: false, key: "os-5")
        XCTAssertEqual(sent.state, "quoted")
        let approved = try await os.decide(created.id, approve: true, key: "os-6")
        XCTAssertEqual(approved.state, "approved")
        for (i, status) in ["in_progress", "ready", "delivered"].enumerated() { _ = try await os.setStatus(created.id, status: status, note: nil, key: "os-s\(i)") }
        let delivered = try await os.order(created.id)
        XCTAssertEqual(delivered.state, "delivered")
        XCTAssertNotNil(delivered.warrantyUntil)
        XCTAssertTrue(delivered.nextStatuses?.isEmpty ?? false)
    }

    func testDemoEmitsModuleEvents() {
        var kinds: [String] = []
        let agenda = DemoAgenda(t0: 0)
        let emit: DemoEmit = { kind, _ in kinds.append(kind) }
        // t0 = 0: o cliente fictício já marcou pelo WhatsApp na primeira consulta.
        _ = agenda.route(method: "GET", parts: ["api", "v1", "profiles", "demo", "agenda"], body: [:], query: [:], key: nil, now: BrasiliaTime.millis(Date()), emit: emit)
        XCTAssertEqual(kinds, ["agenda.booked"])
        let orders = DemoServiceOrders(t0: 0)
        _ = orders.route(method: "GET", parts: ["api", "v1", "profiles", "demo", "service-orders"], body: [:], query: [:], key: nil, now: 0, emit: emit)
        XCTAssertEqual(kinds, ["agenda.booked"], "antes do minuto, nada")
        _ = orders.route(method: "GET", parts: ["api", "v1", "profiles", "demo", "service-orders"], body: [:], query: [:], key: nil, now: 61_000, emit: emit)
        XCTAssertEqual(kinds, ["agenda.booked", "os.approved"])
    }
}

@MainActor
final class ModuleEventsTests: XCTestCase {
    func testReloadsOnlyForItsModuleAndOncePerBurst() async {
        let subject = PassthroughSubject<[Event], Never>()
        var reloads = 0
        let events = ModuleEvents(prefix: "os.", publisher: subject.eraseToAnyPublisher()) { reloads += 1 }
        subject.send([Event(id: 1, kind: "message.received")])
        subject.send([Event(id: 2, kind: "agenda.booked")])
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(reloads, 0)
        subject.send([Event(id: 3, kind: "os.opened")])
        subject.send([Event(id: 4, kind: "os.status_changed"), Event(id: 5, kind: "os.quoted")])
        try? await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(reloads, 1, "uma rajada vira uma leitura só")
        withExtendedLifetime(events) {}
    }
}
