package br.com.queven.wabotia.modules

import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.caixa.CaixaClient
import br.com.queven.wabotia.modules.caixa.CashMethod
import br.com.queven.wabotia.modules.caixa.CashMove
import br.com.queven.wabotia.modules.caixa.CashRules
import br.com.queven.wabotia.modules.caixa.CashSession
import br.com.queven.wabotia.modules.clientes.ClientesClient
import br.com.queven.wabotia.modules.clientes.ContactForm
import br.com.queven.wabotia.modules.mesas.DiningTable
import br.com.queven.wabotia.modules.mesas.MesasText
import br.com.queven.wabotia.modules.mesas.TabBill
import br.com.queven.wabotia.modules.mesas.TableTab
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.ui.service.AssistantRules
import br.com.queven.wabotia.ui.service.EquipmentRules
import br.com.queven.wabotia.ui.service.PairedDevice
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** O básico do atendimento no app: caixa simples, clientes, mesas, equipamentos e o assistente. */
class AtendimentoBasicoTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val api = ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http)
    private val methods = listOf("Dinheiro", "Pix", "Cartão de débito")

    @Before fun fresh() {
        DemoServer.reset()
    }

    private fun move(kind: String, cents: Long, note: String?) = CashMove(UUID.randomUUID().toString(), kind, "2026-11-21", note, cents.toString())

    // ------------------------------------------------------------------ caixa: regras

    @Test fun cashNoteCarriesMethodAndDescription() {
        assertEquals("Pix · Corte e barba", CashRules.note("Pix", "  Corte e barba "))
        assertEquals("Dinheiro", CashRules.note("Dinheiro", ""))
        assertEquals(CashRules.NOTE_LIMIT, CashRules.note("Pix", "x".repeat(400)).length)
        assertEquals("Pix · a b", CashRules.note("Pix", "a\nb"))
        assertEquals("Pix", CashRules.methodOf("Pix · Corte", methods))
        assertEquals("Corte", CashRules.descriptionOf("Pix · Corte", methods))
        assertNull("observação de outro lugar (painel): sem forma", CashRules.methodOf("Troco do dia", methods))
        assertEquals("Troco do dia", CashRules.descriptionOf("Troco do dia", methods))
        assertTrue(UUID.fromString(CashRules.newKey()) != null)
    }

    @Test fun drawerCountsOnlyCash() {
        val session = CashSession(
            id = "s", accountId = "a", changeCents = "5000", version = 1,
            moves = listOf(
                move("supply", 4000, "Dinheiro · Corte"),
                move("supply", 6000, "Pix · Corte e barba"),
                move("withdrawal", 1500, "Dinheiro · Lâminas"),
                move("supply", 1000, "Troco do painel"),
            ),
        )
        // Troco 50 + 40 + 10 (sem forma = dinheiro) − 15; o Pix não passa pela gaveta.
        assertEquals(8500, CashRules.expectedDrawer(session, methods))
        assertEquals(listOf("Dinheiro" to 3500L, "Pix" to 6000L), CashRules.totalsByMethod(session.moves, methods))
        assertEquals("Confere com o esperado", CashRules.difference(8500, 8500))
        assertEquals("Faltou R$ 5,00", CashRules.difference(8500, 8000))
        assertEquals("Sobrou R$ 2,00", CashRules.difference(8500, 8700))
    }

    @Test fun closingSendsCountedCashAndTheOtherMethods() {
        val server = listOf(CashMethod("m-din", "Dinheiro", "01"), CashMethod("m-pix", "Pix", "17"), CashMethod("m-deb", "Cartão de débito", "04"))
        val session = CashSession("s", "a", changeCents = "0", moves = listOf(move("supply", 6000, "Pix · Corte"), move("supply", 3000, "Dinheiro · Barba")))
        assertEquals(listOf("m-din" to 2900L, "m-pix" to 6000L), CashRules.closingValues(server, session, counted = 2900))
        assertEquals("sem formas do servidor, vai vazio", emptyList<Pair<String, Long>>(), CashRules.closingValues(emptyList(), session, 2900))
    }

    @Test fun cashRefusalsSayWhatToDo() {
        assertTrue(CashRules.message(QueueException(409, "module_disabled", "x")).contains("Financeiro"))
        assertTrue(CashRules.message(QueueException(409, "erp_finance_cash_session_open", "x")).contains("já tem um caixa aberto"))
        assertTrue(CashRules.message(QueueException(403, "ERP_FORBIDDEN", "x")).contains("papel Financeiro"))
        assertTrue(CashRules.message(QueueException(0, QueueException.NETWORK, "x")).contains("Sem conexão"))
        assertFalse(CashRules.message(QueueException(400, "algo", "Mensagem do servidor.")).contains("Não foi possível concluir"))
    }

    // ------------------------------------------------------------------ caixa: o caminho do barbeiro na demonstração

    @Test fun openLaunchAndCloseTheCash() = runTest {
        val client = CaixaClient(api)
        val accounts = client.accounts()
        assertEquals("só contas do tipo Caixa", listOf("Caixa do salão"), accounts.map { it.name })
        assertNull("começa fechado", client.openSession())
        val opened = client.open(accounts.single().id, 5000)
        assertTrue(opened.isOpen)
        assertEquals(opened.id, client.openSession()?.id)
        val withEntry = client.move(opened, entry = true, cents = 4000, note = CashRules.note("Dinheiro", "Corte"), day = "2026-11-21")
        val withPix = client.move(withEntry, entry = true, cents = 6000, note = CashRules.note("Pix", "Corte e barba"), day = "2026-11-21")
        val withExit = client.move(withPix, entry = false, cents = 1500, note = CashRules.note("Dinheiro", "Lâminas"), day = "2026-11-21")
        assertEquals(10000L, withExit.entries)
        assertEquals(1500L, withExit.exits)
        assertEquals(7500L, CashRules.expectedDrawer(withExit, client.methods().map { it.description }))
        // A versão antiga é recusada: outro aparelho mexeu no caixa.
        val stale = runCatching { client.move(withPix, true, 100, "Pix", "2026-11-21") }.exceptionOrNull() as QueueException
        assertEquals(409, stale.status)
        val methodsFromServer = client.methods()
        val closed = client.close(withExit, CashRules.closingValues(methodsFromServer, withExit, counted = 7500))
        assertFalse(closed.isOpen)
        assertEquals("13500", closed.informedCents)
        assertNull(client.openSession())
    }

    @Test fun repeatingTheSameCommandDoesNotLaunchTwice() = runTest {
        val client = CaixaClient(api)
        val opened = client.open(client.accounts().single().id, 0)
        val key = CashRules.newKey()
        val first = client.move(opened, true, 1000, "Pix · Corte", "2026-11-21", key)
        val again = client.move(opened, true, 1000, "Pix · Corte", "2026-11-21", key)
        assertEquals(first.version, again.version)
        assertEquals(1, client.session(opened.id).moves.size)
    }

    // ------------------------------------------------------------------ clientes

    @Test fun contactFormChecksBeforeSending() {
        assertEquals("Informe o nome do cliente.", ContactForm.problem(" ", "", "", ""))
        assertEquals("Telefone: informe de 8 a 15 dígitos, com DDD.", ContactForm.problem("Ana", "123", "", ""))
        assertEquals("E-mail inválido.", ContactForm.problem("Ana", "", "ana@", ""))
        assertNull(ContactForm.problem("Ana", "(20) 90000-1101", "ana@exemplo.com", "Prefere sábado"))
        val body = ContactForm.body(" Ana ", "(20) 90000-1101", "", "", version = 3)
        assertEquals(setOf("name", "phone", "email", "notes", "phone_mode", "expected_version"), body.keys)
        assertEquals(JsonPrimitive("Ana"), body["name"])
        assertEquals(JsonPrimitive("human_br"), body["phone_mode"])
        assertFalse("cadastro novo sem versão", ContactForm.body("Ana", "", "", "").containsKey("expected_version"))
    }

    @Test fun registerAndEditACustomerInTheDemo() = runTest {
        val client = ClientesClient(api)
        val before = client.list("").size
        val created = client.create(ContactForm.body("Cliente Barbearia", "(20) 90000-1188", "cliente@exemplo.com", "Corte a cada 15 dias"), QueueClient.newKey())
        assertEquals(before + 1, client.list("").size)
        val edited = client.update(created.id, ContactForm.body("Cliente Barbearia", "(20) 90000-1188", "", "Só aos sábados", created.version), QueueClient.newKey())
        assertEquals("Só aos sábados", edited.notes)
        assertEquals(created.version + 1, edited.version)
    }

    // ------------------------------------------------------------------ mesas, equipamentos e assistente

    @Test fun tableSubtitleSaysStateGuestsAndTotal() {
        assertEquals("Livre · 4 lugares", MesasText.subtitle(DiningTable("t1", "Mesa 1", seats = 4)))
        val busy = DiningTable("t2", "Mesa 2", state = "occupied", stateLabel = "Ocupada", tab = TableTab("tab", 12, guests = 3, bill = TabBill(12000, 12000), minutesOpen = 25, readyCount = 1))
        assertEquals("Ocupada · 3 pessoas · 25 min · R$ 120,00 · 1 pronto(s) para servir", MesasText.subtitle(busy))
    }

    @Test fun pairingCodeAndApproval() {
        assertEquals("ABCD2345", EquipmentRules.normalizeCode("abcd-2345"))
        assertTrue(EquipmentRules.validCode("ABCD2345"))
        assertFalse("sem 0, 1, I e O", EquipmentRules.validCode("ABCD0145"))
        val panel = PairedDevice("p", EquipmentRules.PANEL_CLIENT, status = "approved", profileId = "area", allowedScopes = listOf("queue:read", "queue:issue"), requestedScopes = listOf("queue:read"))
        val other = PairedDevice("v", "vinki", status = "approved", profileId = "area")
        val elsewhere = PairedDevice("x", EquipmentRules.PANEL_CLIENT, status = "approved", profileId = "outra")
        assertEquals(listOf("p"), EquipmentRules.panels(listOf(panel, other, elsewhere), "area").map { it.id })
        val body = EquipmentRules.approveBody("area", panel)
        assertEquals(JsonPrimitive("area"), body["profile_id"])
        assertEquals("libera só o que o aparelho pediu", JsonArray(listOf(JsonPrimitive("queue:read"))), body["scopes"])
        assertEquals(JsonArray(listOf(JsonPrimitive("queue:read"), JsonPrimitive("queue:issue"))), EquipmentRules.approveBody("area", panel.copy(requestedScopes = null))["scopes"])
        assertEquals("Desligado", EquipmentRules.situation(panel.copy(status = "revoked")))
        assertEquals("Pareado", EquipmentRules.situation(panel.copy(status = "expired")))
    }

    @Test fun assistantOpensTheOnlyBotOrLetsChoose() {
        val sales = TeamContact("bot:vendas", "bot", "Assistente de vendas", true, bot_id = "vendas")
        val off = TeamContact("bot:velho", "bot", "Bot antigo", false, bot_id = "velho", enabled = false)
        val person = TeamContact("u1", "user", "Ana", true)
        assertEquals("bot:vendas", AssistantRules.direct(listOf(sales, off, person)))
        val support = TeamContact("suporte", "bot", "Atendimento", true, bot_id = "suporte")
        assertNull("dois bots: a pessoa escolhe", AssistantRules.direct(listOf(sales, support)))
        assertEquals(listOf("Assistente de vendas", "Atendimento"), AssistantRules.candidates(listOf(support, sales, person)).map { it.name })
        assertEquals("bot:suporte", AssistantRules.peerId(support))
        assertNull(AssistantRules.direct(listOf(person)))
    }
}
