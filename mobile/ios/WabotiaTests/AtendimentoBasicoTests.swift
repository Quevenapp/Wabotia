import XCTest
@testable import Wabotia

/// O básico do atendimento no app: caixa simples, clientes, mesas, equipamentos e o assistente (igual ao Android,
/// `modules/AtendimentoBasicoTest.kt`).
final class AtendimentoBasicoTests: XCTestCase {
    private let base = DemoMode.serverURL.absoluteString
    private let methods = ["Dinheiro", "Pix", "Cartão de débito"]

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private var api: ProfileAPI { ProfileAPI(baseURL: base, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { "wabu_demo" } }

    private func move(_ kind: String, _ cents: Int, _ note: String?) -> CashMove {
        CashMove(id: UUID().uuidString, kind: kind, postedOn: "2026-11-21", note: note, amountCents: String(cents))
    }

    // MARK: Caixa: regras

    func testCashNoteCarriesMethodAndDescription() {
        XCTAssertEqual(CashRules.note("Pix", "  Corte e barba "), "Pix · Corte e barba")
        XCTAssertEqual(CashRules.note("Dinheiro", ""), "Dinheiro")
        XCTAssertEqual(CashRules.note("Pix", String(repeating: "x", count: 400)).count, CashRules.noteLimit)
        XCTAssertEqual(CashRules.note("Pix", "a\nb"), "Pix · a b")
        XCTAssertEqual(CashRules.methodOf("Pix · Corte", known: methods), "Pix")
        XCTAssertEqual(CashRules.descriptionOf("Pix · Corte", known: methods), "Corte")
        XCTAssertNil(CashRules.methodOf("Troco do dia", known: methods), "observação de outro lugar (painel): sem forma")
        XCTAssertEqual(CashRules.descriptionOf("Troco do dia", known: methods), "Troco do dia")
        XCTAssertNotNil(UUID(uuidString: CashRules.newKey()))
    }

    func testDrawerCountsOnlyCash() {
        let session = CashSession(id: "s", accountId: "a", changeCents: "5000", moves: [
            move("supply", 4000, "Dinheiro · Corte"),
            move("supply", 6000, "Pix · Corte e barba"),
            move("withdrawal", 1500, "Dinheiro · Lâminas"),
            move("supply", 1000, "Troco do painel"),
        ])
        XCTAssertEqual(CashRules.expectedDrawer(session, known: methods), 8500)
        let totals = CashRules.totalsByMethod(session.moveList, known: methods)
        XCTAssertEqual(totals.map(\.name), ["Dinheiro", "Pix"])
        XCTAssertEqual(totals.map(\.cents), [3500, 6000])
        XCTAssertEqual(CashRules.difference(expected: 8500, counted: 8500), "Confere com o esperado")
        XCTAssertEqual(CashRules.difference(expected: 8500, counted: 8000), "Faltou R$ 5,00")
        XCTAssertEqual(CashRules.difference(expected: 8500, counted: 8700), "Sobrou R$ 2,00")
    }

    func testClosingSendsCountedCashAndTheOtherMethods() {
        let server = [CashMethod(id: "m-din", description: "Dinheiro", paymentType: "01"), CashMethod(id: "m-pix", description: "Pix", paymentType: "17"), CashMethod(id: "m-deb", description: "Cartão de débito", paymentType: "04")]
        let session = CashSession(id: "s", accountId: "a", changeCents: "0", moves: [move("supply", 6000, "Pix · Corte"), move("supply", 3000, "Dinheiro · Barba")])
        let values = CashRules.closingValues(server, session: session, counted: 2900)
        XCTAssertEqual(values.map(\.id), ["m-din", "m-pix"])
        XCTAssertEqual(values.map(\.cents), [2900, 6000])
        XCTAssertTrue(CashRules.closingValues([], session: session, counted: 2900).isEmpty, "sem formas do servidor, vai vazio")
    }

    func testCashRefusalsSayWhatToDo() {
        XCTAssertTrue(CashRules.message(QueueError(status: 409, code: "module_disabled", message: "x")).contains("Financeiro"))
        XCTAssertTrue(CashRules.message(QueueError(status: 409, code: "erp_finance_cash_session_open", message: "x")).contains("já tem um caixa aberto"))
        XCTAssertTrue(CashRules.message(QueueError(status: 403, code: "ERP_FORBIDDEN", message: "x")).contains("papel Financeiro"))
        XCTAssertTrue(CashRules.message(QueueError(status: 0, code: "network", message: "x")).contains("Sem conexão"))
    }

    // MARK: Caixa: o caminho do barbeiro na demonstração

    func testOpenLaunchAndCloseTheCash() async throws {
        let client = CaixaClient(api: api)
        let accounts = try await client.accounts()
        XCTAssertEqual(accounts.map(\.name), ["Caixa do salão"], "só contas do tipo Caixa")
        let none = try await client.openSession()
        XCTAssertNil(none, "começa fechado")
        let opened = try await client.open(accountId: accounts[0].id, changeCents: 5000)
        XCTAssertTrue(opened.isOpen)
        let current = try await client.openSession()
        XCTAssertEqual(current?.id, opened.id)
        let a = try await client.move(opened, entry: true, cents: 4000, note: CashRules.note("Dinheiro", "Corte"), day: "2026-11-21")
        let b = try await client.move(a, entry: true, cents: 6000, note: CashRules.note("Pix", "Corte e barba"), day: "2026-11-21")
        let c = try await client.move(b, entry: false, cents: 1500, note: CashRules.note("Dinheiro", "Lâminas"), day: "2026-11-21")
        XCTAssertEqual(c.entries, 10000)
        XCTAssertEqual(c.exits, 1500)
        let serverMethods = try await client.methods()
        XCTAssertEqual(CashRules.expectedDrawer(c, known: serverMethods.map(\.description)), 7500)
        do {
            _ = try await client.move(b, entry: true, cents: 100, note: "Pix", day: "2026-11-21")
            XCTFail("versão antiga deveria ser recusada")
        } catch let e as QueueError {
            XCTAssertEqual(e.status, 409)
        }
        let closed = try await client.close(c, values: CashRules.closingValues(serverMethods, session: c, counted: 7500))
        XCTAssertFalse(closed.isOpen)
        XCTAssertEqual(closed.informedCents, "13500")
        let after = try await client.openSession()
        XCTAssertNil(after)
    }

    func testRepeatingTheSameCommandDoesNotLaunchTwice() async throws {
        let client = CaixaClient(api: api)
        let account = try await client.accounts()[0]
        let opened = try await client.open(accountId: account.id, changeCents: 0)
        let key = CashRules.newKey()
        let first = try await client.move(opened, entry: true, cents: 1000, note: "Pix · Corte", day: "2026-11-21", key: key)
        let again = try await client.move(opened, entry: true, cents: 1000, note: "Pix · Corte", day: "2026-11-21", key: key)
        XCTAssertEqual(first.version, again.version)
        let session = try await client.session(opened.id)
        XCTAssertEqual(session.moveList.count, 1)
    }

    // MARK: Clientes

    func testContactFormChecksBeforeSending() {
        XCTAssertEqual(ContactForm.problem(name: " ", phone: "", email: "", notes: ""), "Informe o nome do cliente.")
        XCTAssertEqual(ContactForm.problem(name: "Ana", phone: "123", email: "", notes: ""), "Telefone: informe de 8 a 15 dígitos, com DDD.")
        XCTAssertEqual(ContactForm.problem(name: "Ana", phone: "", email: "ana@", notes: ""), "E-mail inválido.")
        XCTAssertNil(ContactForm.problem(name: "Ana", phone: "(20) 90000-1101", email: "ana@exemplo.com", notes: "Prefere sábado"))
        let body = ContactForm.body(name: " Ana ", phone: "(20) 90000-1101", email: "", notes: "", version: 3)
        XCTAssertEqual(body["name"] as? String, "Ana")
        XCTAssertEqual(body["phone_mode"] as? String, "human_br")
        XCTAssertEqual(body["expected_version"] as? Int, 3)
        XCTAssertNil(ContactForm.body(name: "Ana", phone: "", email: "", notes: "")["expected_version"] as? Int, "cadastro novo sem versão")
    }

    func testRegisterAndEditACustomerInTheDemo() async throws {
        let client = ClientesClient(api: api)
        let before = try await client.list("").count
        let created = try await client.create(ContactForm.body(name: "Cliente Barbearia", phone: "(20) 90000-1188", email: "cliente@exemplo.com", notes: "Corte a cada 15 dias"), key: QueueClient.newKey())
        let after = try await client.list("").count
        XCTAssertEqual(after, before + 1)
        let edited = try await client.update(created.id, ContactForm.body(name: "Cliente Barbearia", phone: "(20) 90000-1188", email: "", notes: "Só aos sábados", version: created.version), key: QueueClient.newKey())
        XCTAssertEqual(edited.notes, "Só aos sábados")
        XCTAssertEqual(edited.version, (created.version ?? 1) + 1)
    }

    // MARK: Mesas, equipamentos e assistente

    func testTableSubtitleSaysStateGuestsAndTotal() {
        XCTAssertEqual(MesasText.subtitle(DiningTable(id: "t1", name: "Mesa 1", seats: 4)), "Livre · 4 lugares")
        let busy = DiningTable(id: "t2", name: "Mesa 2", state: "occupied", stateLabel: "Ocupada",
                               tab: TableTab(id: "tab", number: 12, guests: 3, bill: TabBill(totalCents: 12000, dueCents: 12000), minutesOpen: 25, readyCount: 1))
        XCTAssertEqual(MesasText.subtitle(busy), "Ocupada · 3 pessoas · 25 min · R$ 120,00 · 1 pronto(s) para servir")
    }

    func testPairingCodeAndApproval() {
        XCTAssertEqual(EquipmentRules.normalizeCode("abcd-2345"), "ABCD2345")
        XCTAssertTrue(EquipmentRules.validCode("ABCD2345"))
        XCTAssertFalse(EquipmentRules.validCode("ABCD0145"), "sem 0, 1, I e O")
        let panel = PairedDevice(id: "p", client: EquipmentRules.panelClient, status: "approved", profile_id: "area", allowed_scopes: ["queue:read", "queue:issue"], requested_scopes: ["queue:read"])
        let other = PairedDevice(id: "v", client: "vinki", status: "approved", profile_id: "area")
        let elsewhere = PairedDevice(id: "x", client: EquipmentRules.panelClient, status: "approved", profile_id: "outra")
        XCTAssertEqual(EquipmentRules.panels([panel, other, elsewhere], profileId: "area").map(\.id), ["p"])
        XCTAssertEqual(EquipmentRules.scopes(panel), ["queue:read"], "libera só o que o aparelho pediu")
        var noRequest = panel
        noRequest.requested_scopes = nil
        XCTAssertEqual(EquipmentRules.scopes(noRequest), ["queue:read", "queue:issue"])
        var revoked = panel
        revoked.status = "revoked"
        XCTAssertEqual(EquipmentRules.situation(revoked), "Desligado")
    }

    func testAssistantOpensTheOnlyBotOrLetsChoose() {
        let sales = TeamContact(id: "bot:vendas", kind: "bot", name: "Assistente de vendas", online: true, bot_id: "vendas")
        let off = TeamContact(id: "bot:velho", kind: "bot", name: "Bot antigo", online: false, bot_id: "velho", enabled: false)
        let person = TeamContact(id: "u1", kind: "user", name: "Ana", online: true)
        XCTAssertEqual(AssistantRules.direct([sales, off, person])?.id, "bot:vendas")
        let support = TeamContact(id: "bot:suporte", kind: "bot", name: "Atendimento", online: true, bot_id: "suporte")
        XCTAssertNil(AssistantRules.direct([sales, support]), "dois bots: a pessoa escolhe")
        XCTAssertEqual(AssistantRules.candidates([support, sales, person]).map(\.name), ["Assistente de vendas", "Atendimento"])
        XCTAssertNil(AssistantRules.direct([person]))
    }
}
