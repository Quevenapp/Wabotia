package br.com.queven.wabotia.modules

import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.os.QuoteDraft
import br.com.queven.wabotia.modules.os.QuoteItem
import br.com.queven.wabotia.modules.os.ServiceOrder
import br.com.queven.wabotia.modules.os.ServiceOrderClient
import br.com.queven.wabotia.modules.os.ServiceOrderCustomer
import br.com.queven.wabotia.modules.os.ServiceOrderPage
import br.com.queven.wabotia.modules.os.ServiceOrderQuote
import br.com.queven.wabotia.modules.os.ServiceOrderRules
import br.com.queven.wabotia.printing.ServiceOrderReceiptData
import br.com.queven.wabotia.printing.ServiceOrderReceiptText
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A Ordem de Serviço: botões por próximo estado, `counts`, orçamento, comprovante e o fluxo contra a demonstração. */
class ServiceOrderTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val client = ServiceOrderClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http))

    @Before fun fresh() {
        DemoServer.reset()
    }

    @Test fun botoesPorProximoEstado() {
        val quoted = ServiceOrder("o", status = "quoted", nextStatuses = listOf("approved", "declined", "analyzing", "cancelled"))
        assertEquals(listOf("Cliente aprovou", "Cliente recusou", "Voltar para análise", "Cancelar ordem"), ServiceOrderRules.actions(quoted).map { it.second })
        val declined = ServiceOrder("o", status = "declined", nextStatuses = listOf("ready", "cancelled"))
        assertEquals("Devolver sem conserto", ServiceOrderRules.actions(declined).first().second)
        assertTrue(ServiceOrderRules.canEditQuote(declined))
        assertFalse(ServiceOrderRules.canEditQuote(ServiceOrder("o", status = "in_progress")))
        assertTrue(ServiceOrderRules.quoteExpired(ServiceOrder("o", quote = ServiceOrderQuote(validUntil = 100)), now = 100))
    }

    @Test fun contagemComChaveAusenteEAbertas() {
        val page = ServiceOrderPage(emptyList(), null, mapOf("received" to 3, "in_progress" to 4, "delivered" to 12, "readyNow" to 1))
        assertEquals(4, page.count("in_progress"))
        assertEquals(0, page.count("quoted"))
        assertEquals(7, ServiceOrderRules.openCount(page))
    }

    @Test fun rascunhoDoOrcamento() {
        val draft = QuoteDraft(listOf(QuoteDraft.Line(description = "Tela", quantity = 2, value = "150,5"), QuoteDraft.Line()), "10", "")
        assertEquals(listOf(QuoteItem("Tela", 2, 15050)), draft.items().getOrThrow())
        assertEquals(30100L, draft.total)
        assertEquals("Valor do item 1 inválido. Use, por exemplo, 45,90.", QuoteDraft(listOf(QuoteDraft.Line(description = "X", value = "abc")), "7", "").items().exceptionOrNull()?.message)
        assertEquals(null, QuoteDraft(listOf(QuoteDraft.Line()), "120", "").days)
    }

    @Test fun comprovanteSemObservacaoInterna() {
        val order = ServiceOrder(
            "o", number = 12, status = "ready", customer = ServiceOrderCustomer(name = "Cliente Exemplo", phone = "5520906543210"),
            item = "Celular", problem = "Tela", notes = "SEGREDO DA EQUIPE", created = 1794763800000,
            quote = ServiceOrderQuote(items = listOf(QuoteItem("Tela nova", 1, 32000), QuoteItem("Película", 2, 1500)), validUntil = 1795000000000),
        )
        val e = Establishment(name = "Assistência Exemplo", documentType = "cnpj", documentDisplay = "11.222.333/0001-81", footer = "Garantia de 90 dias.")
        val d = ServiceOrderReceiptData.of(order, "Área", e, now = 1794763800000)
        assertEquals("Assistência Exemplo", d.header)
        assertEquals(listOf("CNPJ 11.222.333/0001-81"), d.headerLines)
        val text = (ServiceOrderReceiptText.fields(d).map { "${it.first}: ${it.second}" } + ServiceOrderReceiptText.footer(d) + d.footerLines).joinToString("\n")
        assertTrue(text.contains("Telefone: (20) 90654-3210"))
        assertTrue(text.contains("Orçamento válido até"))
        assertFalse(text.contains("SEGREDO"))
        assertEquals(listOf("Tela nova" to "R$ 320,00", "2x Película" to "R$ 30,00"), ServiceOrderReceiptText.quoteLines(d))
        assertEquals(35000L, d.total)
        assertEquals("Tela nova         R$ 320,00", ServiceOrderReceiptText.valueLine("Tela nova", "R$ 320,00", 27))
        assertEquals("Troca de tela com\npelicula    R$ 320,00", ServiceOrderReceiptText.valueLine("Troca de tela com pelicula", "R$ 320,00", 21))
        assertEquals("Troca de tela com\n        R$ 320,00", ServiceOrderReceiptText.valueLine("Troca de tela com", "R$ 320,00", 17))
        assertEquals("Área", ServiceOrderReceiptData.of(order, "Área", null).header)
    }

    @Test fun fluxoDaOrdemNaDemonstracao() = runTest {
        val page = client.list(open = true)
        assertTrue(page.data.none { it.state in ServiceOrderRules.CLOSED })
        assertEquals(1, page.count("quoted"))
        val created = client.create("Tablet Exemplo", "Não liga", null, "20900001111", "Cliente Balcão", "interno", null, Ids.ANA, "k1")
        assertEquals("received", created.state)
        assertEquals(created.id, client.create("Tablet Exemplo", "Não liga", null, "20900001111", "Cliente Balcão", "interno", null, Ids.ANA, "k1").id)
        val error = runCatching { client.setStatus(created.id, "delivered", null, "k2") }.exceptionOrNull() as QueueException
        assertEquals("invalid_transition", error.code)
        client.saveQuote(created.id, listOf(QuoteItem("Placa", 1, 25000)), 7, null, "k3")
        val noConversation = runCatching { client.sendQuote(created.id, true, "k4") }.exceptionOrNull() as QueueException
        assertEquals("no_conversation", noConversation.code)
        assertEquals("quoted", client.sendQuote(created.id, false, "k5").state)
        assertEquals("approved", client.decide(created.id, true, "k6").state)
        assertEquals("in_progress", client.setStatus(created.id, "in_progress", null, "k7").state)
        assertEquals("ready", client.setStatus(created.id, "ready", null, "k8").state)
        val delivered = client.setStatus(created.id, "delivered", "Retirou", "k9")
        assertTrue((delivered.warrantyUntil ?: 0) > 0)
        assertTrue(client.order(created.id).history!!.size >= 6)
        assertEquals(null, client.assign(created.id, null, "k10").assignee)
        assertEquals(1, client.list(query = "Cliente Balcão").data.size)
    }
}
