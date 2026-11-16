package br.com.queven.wabotia.modules

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.pedido.PedidoClient
import br.com.queven.wabotia.modules.pedido.PedidoDeps
import br.com.queven.wabotia.modules.pedido.PedidoOrder
import br.com.queven.wabotia.modules.pedido.PedidoOrderViewModel
import br.com.queven.wabotia.modules.pedido.PedidoPage
import br.com.queven.wabotia.modules.pedido.PedidoPayment
import br.com.queven.wabotia.modules.pedido.PedidoRules
import br.com.queven.wabotia.modules.pedido.PedidoStore
import br.com.queven.wabotia.modules.pedido.PedidoViewModel
import br.com.queven.wabotia.printing.PedidoTicketReceipt
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** O Pedido: regras dos botões, montagens por `slot`, comanda e o fluxo da cozinha contra a demonstração. */
@OptIn(ExperimentalCoroutinesApi::class)
class PedidoTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val client = PedidoClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http))
    private fun deps() = PedidoDeps(client, {})

    private suspend fun refusal(block: suspend () -> Unit): QueueException =
        runCatching { block() }.exceptionOrNull() as? QueueException ?: throw AssertionError("esperava uma recusa do servidor")

    private fun order(status: String, fulfillment: String = "pickup", next: List<String> = emptyList(), payment: String = "pending") =
        PedidoOrder("o", status = status, fulfillment = fulfillment, payment = PedidoPayment(status = payment), nextStatuses = next)

    @Before fun fresh() {
        DemoServer.reset()
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun main() = Dispatchers.resetMain()

    @Test fun botoesSeguemOsProximosEstados() {
        assertEquals(listOf("Pronto para retirada", "Voltar para novos", "Cancelar pedido"), PedidoRules.actions(order("preparing", next = listOf("ready", "received", "cancelled"))).map { it.second })
        assertEquals(listOf("Começar preparo", "Saiu para entrega", "Cancelar pedido"), PedidoRules.actions(order("received", "delivery", listOf("preparing", "out_for_delivery", "cancelled"))).map { it.second })
        assertEquals("Enviar para o preparo", PedidoRules.actions(order("awaiting_payment", next = listOf("received", "cancelled"))).first().second)
        assertEquals("Voltar para o preparo", PedidoRules.actions(order("ready", next = listOf("delivered", "preparing", "cancelled")))[1].second)
        assertTrue(PedidoRules.actions(order("delivered")).isEmpty())
    }

    @Test fun botoesDePagamento() {
        assertTrue(PedidoRules.canMarkPaid(order("ready", payment = "pending")))
        // Cobrança online aberta: só o provedor confirma.
        assertFalse(PedidoRules.canMarkPaid(order("awaiting_payment", payment = "awaiting")))
        assertFalse(PedidoRules.canMarkPaid(order("ready", payment = "paid")))
        assertFalse(PedidoRules.canMarkPaid(order("cancelled", payment = "pending")))
        assertTrue(PedidoRules.canChooseMethod(order("awaiting_payment", payment = "choosing")))
        assertTrue(PedidoRules.canChooseMethod(order("awaiting_payment", payment = "failed")))
        assertFalse(PedidoRules.canChooseMethod(order("received", payment = "choosing")))
    }

    @Test fun mesmoItemEmDuasMontagensNaoSeJunta() {
        val json = """{"id":"o1","number":42,"status":"preparing","lines":[
            {"item_id":"xb","slot":0,"name":"X-Burger","quantity":1,"unit_cents":3000,"options":[{"group_id":"ponto","group":"Ponto","id":"bem","name":"Bem passada","price_cents":0},{"group_id":"ad","group":"Adicionais","id":"bacon","name":"Bacon","price_cents":500}],"note":"sem cebola","total_cents":3000},
            {"item_id":"xb","slot":1,"name":"X-Burger","quantity":1,"unit_cents":2500,"options":[],"note":"","total_cents":2500},
            {"item_id":"suco","slot":0,"name":"Suco","quantity":2,"unit_cents":800,"options":[],"note":"","total_cents":1600}],
            "payment":{"method":"cash","status":"pending","change_for_cents":10000},"address":null,"next_statuses":["out_for_delivery","received","cancelled"]}"""
        val o = WabotiaJson.decodeFromString(PedidoOrder.serializer(), json)
        assertEquals(3, o.lines.size)
        assertEquals(listOf(0, 1, 0), o.lines.map { it.slot })
        assertEquals("Bem passada, Bacon", PedidoRules.optionsText(o.lines[0]))
        assertNull(PedidoRules.optionsText(o.lines[1]))
        assertEquals(listOf("montagem 1", "montagem 2", null), PedidoRules.assemblies(o).map { it.second })
        assertEquals(10_000L, o.payment?.changeForCents)
    }

    @Test fun contagemPelasChavesExatas() {
        val page = PedidoPage(emptyList(), null, mapOf("out_for_delivery" to 3, "received" to 2, "delivered" to 10))
        assertEquals(3, page.count("out_for_delivery"))
        assertEquals(0, page.count("cancelled"))
        assertEquals(5, PedidoRules.openCount(page))
    }

    @Test fun lojaTempoEComanda() {
        assertEquals("7 min", PedidoRules.elapsed(7))
        assertEquals("1 h 05", PedidoRules.elapsed(65))
        assertNull(PedidoRules.elapsed(null))
        assertEquals("Loja pausada: não recebe pedidos agora", PedidoRules.storeText(PedidoStore(open = false, paused = true)))
        assertEquals("Loja fechada pelo horário", PedidoRules.storeText(PedidoStore(open = false, paused = false)))
        // O quadro manda só `message` com a loja pausada (sem `pause_message`).
        assertEquals("Loja pausada agora. · Voltamos em 10 minutos", PedidoRules.pauseText(PedidoStore(open = false, paused = true, message = "Loja pausada agora.\n\nVoltamos em 10 minutos")))
        assertEquals("volto já", PedidoRules.pauseText(PedidoStore(paused = true, pauseMessage = "volto já", message = "x")))
        assertNull(PedidoRules.pauseText(PedidoStore(open = true, paused = false, message = "")))
        assertEquals(listOf(32, 42, 48, 48, 32), listOf(32, 42, 48, 64, 24).map(PedidoRules::ticketColumns))
        val texts = mapOf(32 to "a", 48 to "b")
        // Sem a de 42, a maior que cabe.
        assertEquals("a", PedidoTicketReceipt.text(42, texts))
        assertEquals("b", PedidoTicketReceipt.text(48, texts))
        assertTrue(PedidoTicketReceipt.isNumberLine("PEDIDO Nº 44      15/11/2026 19:30"))
    }

    @Test fun quadroEDetalheNaDemonstracao() = runTest {
        val board = client.board()
        assertEquals(PedidoRules.ACTIVE, board.columns.map { it.status })
        assertEquals(false, board.store?.paused)
        // Do mais antigo para o mais novo, com o atraso calculado pelo alerta do estado.
        val received = board.columns.first { it.status == "received" }.orders
        assertEquals(listOf(43, 44), received.map { it.number })
        assertEquals(true, received.first().late)
        assertEquals(false, received.last().late)
        val detail = client.order("pd-44")
        assertEquals(listOf("xburger", "xburger", "refri"), detail.lines.map { it.itemId })
        assertEquals(listOf(0, 1, 0), detail.lines.map { it.slot })
        assertTrue(detail.history.orEmpty().isNotEmpty())
        val page = client.list(open = true)
        assertTrue(page.data.none { it.state in PedidoRules.CLOSED })
        assertEquals(1, page.count("delivered"))
        assertEquals(listOf(42), client.list(query = "mariana").data.map { it.number })
    }

    @Test fun estadosPagamentoEComandaNaDemonstracao() = runTest {
        assertEquals("invalid_transition", refusal { client.setStatus("pd-44", "delivered", null, null, true, "s0") }.code)
        val preparing = client.setStatus("pd-44", "preparing", "na chapa", null, true, "s1")
        assertEquals("preparing", preparing.state)
        // Mesma chave e mesmo pedido: a mesma resposta, sem outra mudança.
        assertEquals("preparing", client.setStatus("pd-44", "preparing", "na chapa", null, true, "s1").state)
        assertEquals("ready", client.setStatus("pd-44", "ready", null, null, false, "s2").state)
        assertEquals("paid", client.markPaid("pd-44", "dinheiro", "p1").payment?.status)
        assertEquals("already_paid", refusal { client.markPaid("pd-44", null, "p2") }.code)
        assertEquals("payment_online", refusal { client.markPaid("pd-45", null, "p3") }.code)
        assertEquals("cash", client.setMethod("pd-46", "cash", "m1").payment?.method)
        assertEquals("payment_chosen", refusal { client.setMethod("pd-46", "card", "m2") }.code)
        val cancelled = client.setStatus("pd-43", "cancelled", null, "acabou o pão", true, "c1")
        assertEquals("acabou o pão", cancelled.cancelReason)
        val ticket = client.ticket("pd-44", 32)
        val lines = ticket.text.orEmpty().split("\n")
        assertTrue(lines.all { it.length <= 32 })
        assertTrue(lines.any { it.startsWith("PEDIDO Nº 44") })
        assertEquals(2, lines.count { it.startsWith("1x X-Burger") })
        assertTrue(lines.contains("   Obs: sem cebola"))
        assertTrue(lines.contains("*** PAGO ***"))
        assertEquals(400, refusal { client.ticket("pd-44", 40) }.status)
    }

    @Test fun pausaEEsgotadoPeloViewModel() = runTest {
        val vm = PedidoViewModel(deps())
        vm.load()
        assertEquals(2, vm.board?.columns?.first { it.status == "preparing" }?.orders?.size)
        vm.setPaused(true, "  voltamos às 19h  ")?.join()
        assertEquals(true, vm.store?.paused)
        assertEquals("Loja pausada", vm.done)
        // A pausa relê o quadro, que manda só `message`: a faixa continua com a mensagem da equipe.
        assertNull(vm.store?.pauseMessage)
        assertEquals("Estamos com a loja pausada agora. · voltamos às 19h", PedidoRules.pauseText(vm.store))
        assertEquals("voltamos às 19h", client.pause(true, "voltamos às 19h", "outra").pauseMessage)
        vm.setPaused(false)?.join()
        assertEquals(false, vm.store?.paused)
        vm.changeMode(PedidoViewModel.Mode.MENU)?.join()
        val misto = vm.menu!!.categories.flatMap { it.items }.first { it.id == "misto" }
        assertEquals(false, misto.available)
        vm.setItem(misto, true)?.join()
        assertEquals(true, vm.menu!!.categories.flatMap { it.items }.first { it.id == "misto" }.available)
        assertEquals("Misto quente disponível", vm.done)
        val group = vm.menu!!.groups.first { it.id == "adicionais" }
        vm.setOption(group, group.options.first { it.id == "bacon" }, false)?.join()
        assertEquals(false, client.menu().groups.first { it.id == "adicionais" }.options.first { it.id == "bacon" }.available)
        assertNull(vm.pendingKey("item:misto"))
        vm.changeMode(PedidoViewModel.Mode.LIST)?.join()
        assertTrue(vm.orders.isNotEmpty() && vm.orders.all { it.state in PedidoRules.ACTIVE })
        assertEquals(PedidoRules.openCount(vm.page!!), vm.count("open"))
        vm.changeFilter("cancelled")?.join()
        assertEquals(listOf(37), vm.orders.map { it.number })
    }

    @Test fun detalheRecusaERelê() = runTest {
        val vm = PedidoOrderViewModel("pd-40", deps())
        vm.load()
        assertEquals("ready", vm.order?.state)
        vm.perform("delivered", "retirou no balcão", null, notify = false)?.join()
        assertEquals("delivered", vm.order?.state)
        assertEquals("Pedido: Entregue", vm.done)
        // Entregue não tem próximos estados: a recusa explica e a tela relê.
        vm.perform("preparing", null, null, notify = false)?.join()
        assertTrue(vm.notice.orEmpty().startsWith("Esta mudança não vale"))
        assertNull(vm.pendingKey)
        vm.markPaid()?.join()
        assertEquals("paid", vm.order?.payment?.status)
        val texts = vm.tickets()
        assertEquals(setOf(32, 42, 48), texts.keys)
        assertTrue(texts.getValue(48).split("\n").all { it.length <= 48 })
    }

    @Test fun escritasLevamChaveCaminhoECorpo() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val order = """{"id":"o1","number":1,"status":"received"}"""
            server.enqueue(MockResponse().setBody(order))
            server.enqueue(MockResponse().setBody("""{"open":false,"reason":"paused","paused":true,"pause_message":"volto já"}"""))
            server.enqueue(MockResponse().setBody("""{"id":"ad","options":[{"id":"bacon","available":false}]}"""))
            server.enqueue(MockResponse().setBody("""{"columns":42,"text":"LANCHONETE"}"""))
            val remote = PedidoClient(ProfileApi(server.url("/").toString(), "p1", { "wabu_x" }))
            remote.setStatus("o1", "cancelled", null, "acabou o pão", true, "k1")
            assertEquals(true, remote.pause(true, "volto já", "k2").paused)
            remote.setOptionAvailable("ad", "bacon", false, "k3")
            assertEquals("LANCHONETE", remote.ticket("o1", 42).text)
            val seen = List(4) { server.takeRequest() }
            assertEquals(listOf("POST", "POST", "POST", "GET"), seen.map { it.method })
            assertEquals(
                listOf("/api/v1/profiles/p1/pedido/orders/o1/status", "/api/v1/profiles/p1/pedido/store/pause", "/api/v1/profiles/p1/pedido/groups/ad/availability", "/api/v1/profiles/p1/pedido/orders/o1/ticket?columns=42"),
                seen.map { it.path },
            )
            assertEquals(listOf("k1", "k2", "k3", null), seen.map { it.getHeader("Idempotency-Key") })
            val status = seen[0].body.readUtf8()
            assertTrue(status.contains("\"reason\":\"acabou o pão\"") && status.contains("\"notify\":true") && !status.contains("\"note\""))
            assertTrue(seen[2].body.readUtf8().contains("\"option_id\":\"bacon\""))
        } finally {
            server.shutdown()
        }
    }

    @Test fun dadosDoPedidoSaoFicticios() = runTest {
        client.list().data.forEach { o -> assertTrue(o.customer?.phone.orEmpty(), o.customer?.phone.orEmpty().matches(Regex("""552090\d{7}"""))) }
    }
}
