package br.com.queven.wabotia.modules

import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.mensalidade.Installment
import br.com.queven.wabotia.modules.mensalidade.InstallmentViewModel
import br.com.queven.wabotia.modules.mensalidade.MensalidadeClient
import br.com.queven.wabotia.modules.mensalidade.MensalidadeCustomer
import br.com.queven.wabotia.modules.mensalidade.MensalidadeDeps
import br.com.queven.wabotia.modules.mensalidade.MensalidadeRules
import br.com.queven.wabotia.modules.mensalidade.MensalidadeViewModel
import br.com.queven.wabotia.modules.mensalidade.Payer
import br.com.queven.wabotia.modules.mensalidade.PayerPhone
import br.com.queven.wabotia.modules.mensalidade.Subscription
import br.com.queven.wabotia.modules.mensalidade.SubscriptionViewModel
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A Mensalidade: regras da tela e o cliente contra a demonstração (mesmos códigos de erro do servidor). */
@OptIn(ExperimentalCoroutinesApi::class)
class MensalidadeTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val client = MensalidadeClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http))
    private val today get() = BrasiliaTime.today()
    private fun deps(admin: Boolean = true) = MensalidadeDeps(client, {}, { admin }, { today })

    private suspend fun refusal(block: suspend () -> Unit): QueueException =
        runCatching { block() }.exceptionOrNull() as? QueueException ?: throw AssertionError("esperava uma recusa do servidor")

    @Before fun fresh() {
        DemoServer.reset()
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun main() = Dispatchers.resetMain()

    @Test fun regrasDosBotoesEDoAdministrador() {
        val open = Installment(id = "i", status = "open")
        assertTrue(MensalidadeRules.canCharge(open))
        assertTrue(MensalidadeRules.canPay(open, admin = true))
        assertFalse(MensalidadeRules.canPay(open, admin = false))
        assertFalse(MensalidadeRules.canWaive(open, admin = false))
        assertTrue(MensalidadeRules.canWaive(open.copy(status = "cancelled"), admin = true))
        listOf("paid", "waived").forEach { s ->
            assertFalse(MensalidadeRules.canCharge(open.copy(status = s)))
            assertFalse(MensalidadeRules.canPay(open.copy(status = s), admin = true))
        }
        val active = Subscription(id = "s", status = "active")
        assertTrue(MensalidadeRules.canPause(active, admin = true))
        assertFalse(MensalidadeRules.canPause(active, admin = false))
        assertFalse(MensalidadeRules.canResume(active, admin = true))
        assertTrue(MensalidadeRules.canResume(active.copy(status = "paused"), admin = true))
        assertTrue(MensalidadeRules.canEnd(active.copy(status = "paused"), admin = true))
        assertFalse(MensalidadeRules.canEnd(active.copy(status = "ended"), admin = true))
        assertEquals(MensalidadeRules.ADMIN_ONLY, MensalidadeRules.explain(QueueException(403, "admin_required", "Somente administradores podem fazer isto.")))
        assertTrue(MensalidadeRules.explain(QueueException(409, "no_conversation", "")).contains("conversa no WhatsApp"))
        assertTrue(MensalidadeRules.explain(QueueException(409, "payments_not_configured", "")).contains("Cobrança"))
        assertEquals(7, MensalidadeRules.count(mapOf("open" to 3, "paid" to 4), "all"))
        assertEquals(0, MensalidadeRules.count(mapOf("open" to 3), "overdue"))
    }

    @Test fun dataDaBaixaETelefonesDoPagador() {
        assertEquals("2026-11-15", MensalidadeRules.paidDate("15/11/2026", "2026-11-20"))
        assertEquals("2026-11-05", MensalidadeRules.paidDate("5/11", "2026-11-20"))
        assertEquals("2026-11-20", MensalidadeRules.paidDate("2026-11-20", "2026-11-20"))
        assertNull(MensalidadeRules.paidDate("21/11/2026", "2026-11-20"))
        assertNull(MensalidadeRules.paidDate("31/02/2026", "2026-11-20"))
        assertNull(MensalidadeRules.paidDate("ontem", "2026-11-20"))
        val payer = Payer("p", phones = listOf(PayerPhone("5520907742222", "Helena"), PayerPhone("5520907741111", "Gabriel (filho)")))
        val phones = MensalidadeRules.phones(payer, MensalidadeCustomer(phone = "5520907741111"))
        assertEquals(listOf("(20) 90774-2222" to "Helena", "(20) 90774-1111" to "Gabriel (filho)"), phones)
        // Sem pagador (servidor antigo): o telefone da assinatura.
        assertEquals(listOf("(20) 90774-1111" to null), MensalidadeRules.phones(null, MensalidadeCustomer(phone = "5520907741111")))
    }

    @Test fun mesNaDemonstracao() = runTest {
        val month = today.take(7)
        val summary = client.summary(month)
        assertEquals(month, summary.month)
        assertEquals(true, summary.paymentsReady)
        assertTrue((summary.overdueTotal?.count ?: 0) >= 1)
        val page = client.installments(month)
        assertEquals(8, page.data.size)
        assertEquals(page.data.size, page.counts.values.sum())
        assertTrue(client.installments(month, listOf("paid")).data.all { it.state == "paid" })
        assertEquals(listOf("Patrícia Nunes"), client.installments(month, query = "patr").data.map { it.customerName })
        val vm = MensalidadeViewModel(deps())
        vm.load()
        assertEquals(8, vm.count("all"))
        assertEquals(vm.installments.size, 8)
        // Espera a leitura que a troca dispara (solta, voltaria ao Main depois do `resetMain`).
        vm.changeMode(MensalidadeViewModel.Mode.DELINQUENTS)?.join()
        val delinquent = vm.delinquents.first { it.subscriptionId == "ms-3" }
        assertTrue((delinquent.overdueCount ?: 0) >= 1)
        assertEquals(vm.delinquents.map { it.oldestDueDate }, vm.delinquents.map { it.oldestDueDate }.sortedBy { it })
    }

    @Test fun cobrarDarBaixaEIsentar() = runTest {
        // Patrícia tem conversa: a cobrança sai; Gabriel (pago pela mãe) não tem conversa.
        assertNotNull(client.charge("mi-5", "c1").payment)
        assertEquals("no_conversation", refusal { client.charge("mi-4", "c2") }.code)
        val vm = InstallmentViewModel("mi-5", deps())
        vm.load()
        assertTrue(MensalidadeRules.canPay(vm.installment!!, vm.isAdmin))
        vm.perform("pay", "Baixa registrada") { client.pay("mi-5", "Pagou em dinheiro", today, true, it) }
        assertEquals("paid", vm.installment?.state)
        assertEquals("manual", vm.installment?.paidVia)
        assertEquals("Pagou em dinheiro", vm.installment?.paidNote)
        assertEquals("Baixa registrada", vm.done)
        // Já paga: a recusa explica e a tela relê.
        vm.perform("charge", "Cobrança enviada") { client.charge("mi-5", it) }
        assertTrue(vm.notice.orEmpty().startsWith("Esta parcela não está mais em aberto"))
        assertEquals("installment_not_payable", refusal { client.pay("mi-5", null, null, false, "p2") }.code)
        assertEquals("waived", client.waive("mi-6", "Acordo", "w1").state)
        // Data futura: recusada antes de olhar a parcela.
        assertEquals(400, refusal { client.pay("mi-8", null, BrasiliaTime.addDays(today, 1), false, "p3") }.status)
    }

    @Test fun pagadorComVariosTelefones() = runTest {
        val sub = client.subscription("ms-2")
        assertEquals("py-2", sub.payer?.id)
        assertEquals("Helena Prado", sub.payer?.name)
        val payer = client.payer("py-2")
        assertEquals(2, payer.phones.size)
        assertEquals(listOf("ms-2", "ms-5"), payer.subscriptions?.map { it.id })
        assertNull(payer.documentText)
        val vm = InstallmentViewModel("mi-3", deps(admin = false))
        vm.load()
        assertEquals("py-2", vm.payer?.id)
        val phones = MensalidadeRules.phones(vm.payer, vm.subscription?.customer)
        assertEquals(2, phones.size)
        assertTrue(phones.any { it.second == "Gabriel (filho)" })
        // Quem não é administrador não vê baixa nem isenção.
        assertFalse(MensalidadeRules.canPay(vm.installment!!.copy(status = "open"), vm.isAdmin))
    }

    @Test fun pausarRetomarEEncerrar() = runTest {
        val vm = SubscriptionViewModel("ms-4", deps())
        vm.load()
        vm.perform("pause")
        assertEquals("paused", vm.subscription?.state)
        assertEquals("Assinatura pausada", vm.done)
        assertTrue(vm.subscription?.installments.orEmpty().none { it.state == "open" && (it.dueDate ?: "") >= today })
        vm.perform("resume")
        assertEquals("active", vm.subscription?.state)
        vm.perform("end")
        assertEquals("ended", vm.subscription?.state)
        vm.perform("end")
        assertTrue(vm.notice.orEmpty().contains("Encerrada"))
        assertEquals("invalid_transition", refusal { client.subscriptionAction("ms-8", "resume", "x1") }.code)
        val counts = client.subscriptions().counts
        assertEquals(2, counts["ended"])
    }

    @Test fun recusa403ViraAvisoDeAdministrador() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val installment = """{"id":"i1","subscription_id":null,"status":"open","amount_cents":1000,"due_date":"2026-11-10"}"""
            server.enqueue(MockResponse().setBody(installment))
            server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"admin_required","message":"Somente administradores podem fazer isto."}}"""))
            server.enqueue(MockResponse().setBody(installment))
            val remote = MensalidadeClient(ProfileApi(server.url("/").toString(), "area-1", { "wabu_x" }))
            val failures = mutableListOf<Throwable>()
            val vm = InstallmentViewModel("i1", MensalidadeDeps(remote, { failures += it }, { true }, { "2026-11-15" }))
            vm.load()
            vm.perform("pay", "Baixa registrada") { remote.pay("i1", null, "2026-11-15", true, it) }
            assertEquals(MensalidadeRules.ADMIN_ONLY, vm.notice)
            assertEquals("open", vm.installment?.state)
            assertEquals(403, (failures.single() as QueueException).status)
            assertNull(vm.pendingKey)
        } finally {
            server.shutdown()
        }
    }

    @Test fun dadosDaMensalidadeSaoFicticios() = runTest {
        val subs = client.subscriptions().data
        assertEquals(8, subs.size)
        val phone = Regex("""552090\d{7}""")
        subs.forEach { s ->
            assertTrue(s.customer?.phone.orEmpty(), s.customer?.phone.orEmpty().matches(phone))
            val payer = client.payer(s.payer!!.id)
            assertNull(payer.document)
            payer.phones.forEach { assertTrue(it.phone, it.phone.matches(phone)) }
        }
    }
}
