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
        XCTAssertEqual(ids, ["queue", "agenda", "os", "reserva", "mensalidade", "pedido", "suporte", "forms", "payments",
                             "erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"])
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

/// Pedido (lanchonete) e Suporte pago na demonstração, pelo mesmo `DemoURLProtocol` do app.
final class DemoPedidoSuporteTests: XCTestCase {
    private let base = DemoMode.serverURL.absoluteString

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private var api: ProfileAPI { ProfileAPI(baseURL: base, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { "wabu_demo" } }

    /// O detalhe da conversa como o app lê (`GET /conversations/{id}`), direto do servidor da demonstração.
    private func detailOf(_ id: String) throws -> ConversationDetail {
        let url = URL(string: base + "/api/v1/profiles/\(DemoMode.profileId)/conversations/\(id)")!
        return try JSONDecoder.wabotia.decode(ConversationDetail.self, from: DemoServer.shared.handle(method: "GET", url: url, body: Data()).data)
    }

    func testLanchoneteBoardOrderAndTicket() async throws {
        let pedido = PedidoClient(api: api)
        let board = try await pedido.board()
        XCTAssertEqual(board.columns?.map(\.status), PedidoRules.active)
        XCTAssertTrue(board.columns?.flatMap { $0.orders ?? [] }.contains { $0.late == true } ?? false, "há pedido atrasado no quadro")
        let order = try await pedido.order("pd_44")
        XCTAssertEqual(order.lines?.filter { $0.itemId == "xburger" }.map(\.slot), [0, 1], "duas montagens do mesmo X-Burger")
        let ticket = try await pedido.ticket("pd_44", columns: 32)
        let lines = (ticket.text ?? "").components(separatedBy: "\n")
        XCTAssertTrue(lines.allSatisfy { $0.count <= 32 }, "nenhuma linha passa de 32 colunas")
        XCTAssertTrue(lines.contains { $0.hasPrefix("PEDIDO Nº 44") })
        // Recebido → em preparo → pronto; pagamento na retirada.
        _ = try await pedido.setStatus("pd_44", status: "preparing", note: nil, reason: nil, notify: true, key: "pd-a")
        let ready = try await pedido.setStatus("pd_44", status: "ready", note: nil, reason: nil, notify: true, key: "pd-b")
        XCTAssertEqual(ready.nextStatuses, ["delivered", "preparing", "cancelled"])
        let paid = try await pedido.markPaid("pd_44", note: nil, key: "pd-c")
        XCTAssertEqual(paid.payment?.status, "paid")
        do { _ = try await pedido.markPaid("pd_45", note: nil, key: "pd-d"); XCTFail("Pix aberto") } catch { XCTAssertEqual((error as? QueueError)?.code, "payment_online") }
        do { _ = try await pedido.setStatus("pd_38", status: "preparing", note: nil, reason: nil, notify: true, key: "pd-e"); XCTFail() } catch { XCTAssertEqual((error as? QueueError)?.code, "invalid_transition") }
        let chosen = try await pedido.setMethod("pd_46", method: "cash", key: "pd-f")
        XCTAssertEqual(chosen.payment?.method, "cash")
    }

    func testLanchoneteStoreAndMenu() async throws {
        let pedido = PedidoClient(api: api)
        let store = try await pedido.pause(true, message: "voltamos às 19h", key: "st-a")
        XCTAssertEqual(store.paused, true)
        let pausedBoard = try await pedido.board()
        XCTAssertEqual(PedidoRules.storeText(pausedBoard.store), "Loja pausada: não recebe pedidos agora")
        let menu = try await pedido.menu()
        XCTAssertEqual(menu.categories?.flatMap { $0.items ?? [] }.first { $0.id == "misto" }?.available, false)
        _ = try await pedido.setItemAvailable("misto", available: true, key: "st-b")
        _ = try await pedido.setOptionAvailable(groupId: "adicionais", optionId: "cheddar", available: true, key: "st-c")
        let after = try await pedido.menu()
        XCTAssertEqual(after.categories?.flatMap { $0.items ?? [] }.first { $0.id == "misto" }?.available, true)
        XCTAssertEqual(after.groups?.first { $0.id == "adicionais" }?.options?.first { $0.id == "cheddar" }?.available, true)
    }

    func testHandoffAndSuporteActions() async throws {
        let detail = try detailOf(DemoSuporte.conversationId)
        XCTAssertEqual(detail.handoff?.module, "suporte")
        XCTAssertTrue(detail.handoff?.visibleFlags.contains("telefone não vinculado ao pagador Ricardo Almeida") ?? false)
        let suporte = SuporteClient(api: api)
        let status = try await suporte.status(DemoSuporte.conversationId)
        XCTAssertTrue(SuporteRules.canLink(status))
        let linked = try await suporte.linkPhone(DemoSuporte.conversationId, key: "sp-a")
        XCTAssertFalse(SuporteRules.canLink(linked))
        let again = try detailOf(DemoSuporte.conversationId)
        XCTAssertFalse(again.handoff?.visibleFlags.contains { $0.hasPrefix("telefone não vinculado") } ?? true, "o marcador some depois de vincular")
        let courtesy = try await suporte.courtesy(DemoSuporte.conversationId, reason: "cliente antigo", hours: 24, key: "sp-b")
        XCTAssertEqual(courtesy.kindLabel, "Cortesia")
    }

    func testPayerInDemoSubscription() async throws {
        let ms = MensalidadeClient(api: api)
        let s = try await ms.subscription("ms_3")
        XCTAssertEqual(MensalidadeRules.documentText(s.payer?.documentDisplay), "CNPJ 12.345.678/0001-95")
        let payer = try await ms.payer(try XCTUnwrap(s.payer?.id))
        XCTAssertEqual(MensalidadeRules.payerPhones(payer).count, 2)
    }
}

/// Formulário e Cobrança na demonstração: o envio cria o link e a cobrança no detalhe da conversa.
final class DemoFormsPaymentsTests: XCTestCase {
    private let base = DemoMode.serverURL.absoluteString

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private func call(_ method: String, _ path: String, _ body: [String: Any] = [:]) -> DemoServer.Reply {
        let url = URL(string: base + "/api/v1/profiles/\(DemoMode.profileId)/" + path)!
        return DemoServer.shared.handle(method: method, url: url, body: (try? JSONSerialization.data(withJSONObject: body)) ?? Data(), key: UUID().uuidString)
    }

    func testFormAndChargeShowInDetail() throws {
        let forms = try JSONDecoder.wabotia.decode(DataList<FormSummary>.self, from: call("GET", "forms").data)
        XCTAssertEqual(forms.data?.first?.displayName, "Dados para a coleta")
        var detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: call("GET", "conversations/c_rich").data)
        XCTAssertEqual(detail.payments?.first?.status, "created", "Pix do frete aguardando")
        XCTAssertEqual(detail.web_steps?.first?.status, "completed")
        XCTAssertEqual(call("POST", "conversations/c_rich/actions", ["action": "form", "form_id": "satisfacao"]).status, 200)
        XCTAssertEqual(call("POST", "conversations/c_rich/actions", ["action": "charge", "method": "link", "amount_cents": 4990, "description": "Consulta"]).status, 200)
        XCTAssertEqual(call("POST", "conversations/c_rich/actions", ["action": "charge", "method": "pix", "amount_cents": 0, "description": "x"]).status, 400)
        detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: call("GET", "conversations/c_rich").data)
        XCTAssertEqual(detail.web_steps?.first?.title, "Avaliação do atendimento")
        XCTAssertEqual(detail.web_steps?.first?.status, "sent")
        XCTAssertEqual(detail.payments?.first?.amount_cents, 4990)
        XCTAssertEqual(detail.payments?.first?.method, "link")
    }
}
