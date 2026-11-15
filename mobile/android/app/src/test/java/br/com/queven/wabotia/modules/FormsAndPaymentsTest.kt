package br.com.queven.wabotia.modules

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.cobranca.ConversationItems
import br.com.queven.wabotia.modules.cobranca.ConversationItemsRules
import br.com.queven.wabotia.modules.cobranca.ConversationPayment
import br.com.queven.wabotia.modules.cobranca.FormsPaymentsClient
import br.com.queven.wabotia.modules.cobranca.FormsPaymentsDeps
import br.com.queven.wabotia.modules.cobranca.FormsPaymentsViewModel
import br.com.queven.wabotia.modules.cobranca.WebStep
import br.com.queven.wabotia.modules.cobranca.WebStepField
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
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

/** "Enviar formulário" e "Cobrar" na conversa: regras, o estado de cada link e cobrança e as recusas do servidor. */
@OptIn(ExperimentalCoroutinesApi::class)
class FormsAndPaymentsTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val api = ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http)
    private val client = FormsPaymentsClient(api)

    private suspend fun refusal(block: suspend () -> Unit): QueueException =
        runCatching { block() }.exceptionOrNull() as? QueueException ?: throw AssertionError("esperava uma recusa do servidor")

    private suspend fun detail(id: String) = api.raw("conversations/$id") as JsonObject

    @Before fun fresh() {
        DemoServer.reset()
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun main() = Dispatchers.resetMain()

    @Test fun textosERegras() {
        assertEquals(listOf("Enviado", "Aberto", "Concluído", "Expirado", "Cancelado"), listOf("sent", "opened", "completed", "expired", "cancelled").map(ConversationItemsRules::webStepLabel))
        assertEquals(listOf("Aguardando pagamento", "Pago", "Vencida", "Cancelada", "Estornada"), listOf("created", "paid", "expired", "cancelled", "refunded").map(ConversationItemsRules::paymentLabel))
        assertEquals("Link de pagamento", ConversationItemsRules.methodLabel("link"))
        assertEquals("Pix", ConversationItemsRules.methodLabel("pix"))
        assertEquals("Check-in", ConversationItemsRules.stepTitle(WebStep("w", kind = "checkin", title = " ")))
        assertEquals("Dados", ConversationItemsRules.stepTitle(WebStep("w", kind = "form", title = "Dados")))
        assertEquals(4990L, ConversationItemsRules.amount("49,90"))
        assertNull(ConversationItemsRules.amount("0"))
        assertNull(ConversationItemsRules.amount("100.000,01"))
        assertEquals(10_000_000L, ConversationItemsRules.amount("100.000,00"))
        assertFalse(ConversationItemsRules.validDescription("  "))
        assertFalse(ConversationItemsRules.validDescription("x".repeat(121)))
        assertTrue(ConversationItemsRules.validDescription("Consulta"))
        assertTrue(ConversationItemsRules.isActive(WebStep("w", status = "opened")))
        assertFalse(ConversationItemsRules.isActive(ConversationPayment("p", status = "paid")))
    }

    @Test fun respostasDoFormulario() {
        val answers = buildJsonObject {
            put("extra", "valor solto")
            put("periodo", "Manhã")
            put("endereco", "Rua Exemplo, 1")
            put("aceite", true)
            putJsonArray("dias") { add(JsonPrimitive("seg")); add(JsonPrimitive("qua")) }
            put("vazio", "  ")
        }
        val step = WebStep(
            "w", kind = "form", page = "form", answers = answers,
            fields = listOf(WebStepField("endereco", label = "Endereço"), WebStepField("periodo", label = "Período"), WebStepField("dias", label = "Dias"), WebStepField("aceite", label = "")),
        )
        assertEquals(
            listOf("Endereço" to "Rua Exemplo, 1", "Período" to "Manhã", "Dias" to "seg, qua", "aceite" to "sim", "extra" to "valor solto"),
            ConversationItemsRules.answers(step),
        )
        // O carrinho do pedido não é formulário.
        assertTrue(ConversationItemsRules.answers(step.copy(page = "cart")).isEmpty())
        assertTrue(ConversationItemsRules.answers(step.copy(answers = null)).isEmpty())
    }

    @Test fun faixaMostraOEmAndamentoEORecente() {
        val now = 10 * 86_400_000L
        val day = 86_400_000L
        val steps = listOf(
            WebStep("s1", status = "sent", created = now - 3 * day),
            WebStep("s2", status = "completed", created = now - 3 * day, completedAt = now - 2 * day),
            WebStep("s3", status = "completed", created = now - day, completedAt = now - 60_000),
            WebStep("s4", status = "opened", created = now - 2 * day),
        )
        val payments = listOf(
            ConversationPayment("p1", status = "created", created = now - 5 * day),
            ConversationPayment("p2", status = "paid", created = now - 2 * day, paidAt = now - 1_000),
            ConversationPayment("p3", status = "expired", created = now - 3 * day),
        )
        val (s, p) = ConversationItemsRules.recent(steps, payments, now)
        assertEquals(listOf("p1", "p2"), p.map { it.id })
        assertEquals(listOf("s1", "s3"), s.map { it.id })
    }

    @Test fun detalheTrazLinksECobrancas() = runTest {
        val d = detail(Ids.C_RICH)
        val steps = ConversationItems.steps(d["web_steps"])
        val payments = ConversationItems.payments(d["payments"])
        assertEquals("completed", steps.single().status)
        assertEquals(listOf("Endereço da coleta" to "Rua Exemplo, 100 — Centro", "Período" to "Manhã"), ConversationItemsRules.answers(steps.single()))
        assertEquals("created", payments.single().status)
        assertEquals(1890L, payments.single().amountCents)
        assertNotNull(payments.single().pixCode)
        // Campo ausente ou nulo (servidor antigo): listas vazias.
        assertTrue(ConversationItems.steps(null).isEmpty())
        assertTrue(ConversationItems.payments(JsonPrimitive("x")).isEmpty())
    }

    @Test fun enviarFormularioECobrarNaDemonstracao() = runTest {
        val forms = client.forms()
        assertEquals(listOf("coleta", "satisfacao"), forms.map { it.id })
        assertEquals("Dados para a coleta", forms.first().displayName)
        val step = client.sendForm(Ids.C_5H, "satisfacao", "f1")
        assertEquals("sent", step.status)
        assertEquals("Avaliação do atendimento", step.title)
        // Mesma chave, mesmo pedido: o mesmo link.
        assertEquals(step.id, client.sendForm(Ids.C_5H, "satisfacao", "f1").id)
        assertEquals(400, refusal { client.sendForm(Ids.C_5H, "nao-existe", "f2") }.status)
        val pay = client.charge(Ids.C_5H, "link", 4990, "Consulta", "c1")
        assertEquals("created", pay.status)
        assertNotNull(pay.url)
        assertNull(pay.pixCode)
        assertEquals(400, refusal { client.charge(Ids.C_5H, "boleto", 4990, "Consulta", "c2") }.status)
        assertEquals(400, refusal { client.charge(Ids.C_5H, "pix", 0, "Consulta", "c3") }.status)
        // Janela de 24 horas fechada numa linha oficial: nem link nem cobrança.
        assertEquals("window_closed", refusal { client.charge(Ids.C_WINDOW_CLOSED, "pix", 1000, "Consulta", "c4") }.code)
        assertEquals("window_closed", refusal { client.sendForm(Ids.C_WINDOW_CLOSED, "coleta", "f3") }.code)
        assertEquals(400, refusal { client.charge(Ids.C_GROUP, "pix", 1000, "Rateio", "c5") }.status)
        val d = detail(Ids.C_5H)
        assertEquals(listOf(step.id), ConversationItems.steps(d["web_steps"]).map { it.id })
        assertEquals(listOf(pay.id), ConversationItems.payments(d["payments"]).map { it.id })
    }

    @Test fun viewModelConfereAntesEExplicaARecusa() = runTest {
        val failures = mutableListOf<Pair<String, Throwable>>()
        val vm = FormsPaymentsViewModel(Ids.C_RICH, FormsPaymentsDeps(client, { m, e -> failures += m to e }))
        vm.loadForms()
        assertEquals(2, vm.forms?.size)
        assertNull(vm.charge("pix", "0,00", "Consulta"))
        assertTrue(vm.error.orEmpty().startsWith("Valor entre"))
        assertNull(vm.charge("pix", "10", " "))
        assertTrue(vm.error.orEmpty().startsWith("Informe a descrição"))
        var closed = false
        vm.charge("pix", "49,90", " Consulta ", onSent = { closed = true })?.join()
        assertTrue(closed)
        assertEquals("Cobrança de R$ 49,90 enviada", vm.done)
        assertNull(vm.error)
        vm.sendForm(vm.forms!!.first())?.join()
        assertEquals("Formulário \"Dados para a coleta\" enviado ao cliente", vm.done)
        val inClosed = FormsPaymentsViewModel(Ids.C_WINDOW_CLOSED, FormsPaymentsDeps(client, { m, e -> failures += m to e }))
        inClosed.charge("link", "10", "Sinal")?.join()
        assertTrue(inClosed.error.orEmpty().startsWith("A janela de 24 horas está fechada"))
        assertNull(inClosed.pendingChargeKey)
        assertEquals("payments", failures.single().first)
    }

    @Test fun cobrancaNaoConfiguradaEModuloDesligado() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"payments_not_configured","message":"Configure a conta de pagamento em Gestão → Cobrança."}}"""))
            server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"module_disabled","message":"Módulo desligado."}}"""))
            server.enqueue(MockResponse().setBody("""{"id":"ws1","status":"sent","kind":"form"}"""))
            val remote = FormsPaymentsClient(ProfileApi(server.url("/").toString(), "p1", { "wabu_x" }))
            val failures = mutableListOf<Pair<String, Throwable>>()
            val vm = FormsPaymentsViewModel("c1", FormsPaymentsDeps(remote, { m, e -> failures += m to e }))
            vm.charge("pix", "25", "Consulta")?.join()
            assertTrue(vm.error.orEmpty().startsWith("A Cobrança não está configurada"))
            vm.loadForms()
            assertEquals(ModuleFailure.DISABLED_MESSAGE, vm.formsError)
            assertEquals(listOf("payments", "forms"), failures.map { it.first })
            assertEquals("ws1", remote.sendForm("c1", "coleta", "k9").id)
            val seen = List(3) { server.takeRequest() }
            assertEquals(listOf("/api/v1/profiles/p1/conversations/c1/actions", "/api/v1/profiles/p1/forms", "/api/v1/profiles/p1/conversations/c1/actions"), seen.map { it.path })
            val charge = WabotiaJson.parseToJsonElement(seen[0].body.readUtf8()) as JsonObject
            assertEquals(JsonPrimitive("charge"), charge["action"])
            assertEquals(JsonPrimitive(2500), charge["amount_cents"])
            assertEquals(JsonPrimitive("Consulta"), charge["description"])
            assertNotNull(seen[0].getHeader("Idempotency-Key"))
            val form = WabotiaJson.parseToJsonElement(seen[2].body.readUtf8()) as JsonObject
            assertEquals(JsonPrimitive("form"), form["action"])
            assertEquals(JsonPrimitive("coleta"), form["form_id"])
        } finally {
            server.shutdown()
        }
    }
}
