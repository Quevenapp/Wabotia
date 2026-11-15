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
        XCTAssertEqual(ids, ["queue", "agenda", "os"])
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
