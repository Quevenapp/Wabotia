package br.com.queven.wabotia.modules

import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.suporte.ModuleHandoff
import br.com.queven.wabotia.modules.suporte.SuporteClient
import br.com.queven.wabotia.modules.suporte.SuporteDeps
import br.com.queven.wabotia.modules.suporte.SuporteRelease
import br.com.queven.wabotia.modules.suporte.SuporteRules
import br.com.queven.wabotia.modules.suporte.SuporteStatus
import br.com.queven.wabotia.modules.suporte.SuporteUnlinked
import br.com.queven.wabotia.modules.suporte.SuporteViewModel
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A faixa da passagem por módulo e o Suporte pago: regras, o `handoff` do detalhe e as ações contra a demonstração. */
@OptIn(ExperimentalCoroutinesApi::class)
class SuporteTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val api = ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http)
    private val client = SuporteClient(api)
    private fun deps(enabled: Boolean = true, failures: MutableList<Throwable> = mutableListOf()) = SuporteDeps(client, { failures += it }, { enabled })

    private suspend fun refusal(block: suspend () -> Unit): QueueException =
        runCatching { block() }.exceptionOrNull() as? QueueException ?: throw AssertionError("esperava uma recusa do servidor")

    @Before fun fresh() {
        DemoServer.reset()
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun main() = Dispatchers.resetMain()

    @Test fun passagemDoDetalhe() {
        assertNull(ModuleHandoff.of(null))
        assertNull(ModuleHandoff.of(JsonNull))
        assertNull(ModuleHandoff.of(JsonPrimitive("x")))
        // Sem resumo nem marcadores, não há o que mostrar.
        assertNull(ModuleHandoff.of(buildJsonObject { put("module", "suporte"); put("summary", "  "); putJsonArray("flags") { add(JsonPrimitive(" ")) } }))
        val h = ModuleHandoff.of(buildJsonObject { put("module", "suporte"); put("summary", "Comprou o avulso"); putJsonArray("flags") { add(JsonPrimitive(" telefone não vinculado ")); add(JsonPrimitive("")) }; put("at", 5) })!!
        assertEquals(listOf("telefone não vinculado"), h.visibleFlags)
        assertEquals("Suporte pago", SuporteRules.moduleName(h.module))
        assertEquals("Ordem de serviço", SuporteRules.moduleName("os"))
        assertEquals("Fidelidade", SuporteRules.moduleName("fidelidade"))
        assertEquals("Módulo", SuporteRules.moduleName(null))
        // A faixa: conversa aberta; a passagem do Suporte pago, só com o módulo ligado.
        assertTrue(SuporteRules.showBand(h, "waiting", suporteEnabled = true))
        assertFalse(SuporteRules.showBand(h, "waiting", suporteEnabled = false))
        assertFalse(SuporteRules.showBand(h, "closed", suporteEnabled = true))
        assertTrue(SuporteRules.showBand(h.copy(module = "pedido"), "human", suporteEnabled = false))
        assertFalse(SuporteRules.showBand(null, "human", suporteEnabled = true))
    }

    @Test fun situacaoEBotoes() {
        val awaiting = SuporteStatus(allowed = false, reason = "payment_required", awaitingTeam = true, unlinkedPhone = SuporteUnlinked("py", " Renato "))
        assertEquals("Aguardando a equipe confirmar e liberar", SuporteRules.statusText(awaiting))
        assertTrue(SuporteRules.canLink(awaiting) && SuporteRules.canConfirm(awaiting) && SuporteRules.canCourtesy(awaiting))
        assertEquals("Vincular telefone a Renato", SuporteRules.linkTitle(awaiting))
        assertEquals("Vincular telefone ao pagador", SuporteRules.linkTitle(null))
        val released = SuporteStatus(allowed = true, reason = "released", release = SuporteRelease(kindLabel = "Suporte avulso", payerName = "Renato", untilTicket = true, status = "active"))
        assertEquals("Suporte avulso · Renato · até o protocolo fechar", SuporteRules.statusText(released))
        assertFalse(SuporteRules.canLink(released) || SuporteRules.canConfirm(released) || SuporteRules.canCourtesy(released))
        assertEquals("Assinatura em dia", SuporteRules.statusText(SuporteStatus(allowed = true, reason = "subscription")))
        assertEquals("Sem liberação: pagamento pendente", SuporteRules.statusText(SuporteStatus(allowed = false, reason = "payment_required")))
        assertTrue(SuporteRules.canCourtesy(SuporteStatus(allowed = false)))
        assertFalse(SuporteRules.canCourtesy(null))
        assertEquals(listOf(null, 24, 72, 168), SuporteRules.COURTESY_OPTIONS.map { it.first })
        assertTrue(SuporteRules.explain(QueueException(409, "nothing_to_link", "")).startsWith("Não há pagador"))
    }

    @Test fun detalheDaConversaTrazAPassagem() = runTest {
        val detail = api.raw("conversations/${Ids.C_SUPORTE}") as JsonObject
        val h = ModuleHandoff.of(detail["handoff"])
        assertNotNull(h)
        assertEquals("suporte", h!!.module)
        assertTrue(h.visibleFlags.any { it.startsWith("telefone não vinculado") })
        // As outras conversas não têm passagem.
        assertNull(ModuleHandoff.of((api.raw("conversations/${Ids.C_RICH}") as JsonObject)["handoff"]))
    }

    @Test fun vincularConfirmarECortesiaNaDemonstracao() = runTest {
        val start = client.status(Ids.C_SUPORTE)
        assertEquals(true, start.awaitingTeam)
        assertEquals(false, start.allowed)
        assertEquals("py-almeida", start.unlinkedPhone?.payerId)
        val linked = client.linkPhone(Ids.C_SUPORTE, "l1")
        assertNull(linked.unlinkedPhone)
        // Mesma chave, mesmo pedido: a mesma resposta; outra chave: nada mais a vincular.
        assertNull(client.linkPhone(Ids.C_SUPORTE, "l1").unlinkedPhone)
        assertEquals("nothing_to_link", refusal { client.linkPhone(Ids.C_SUPORTE, "l2") }.code)
        assertEquals(400, refusal { client.courtesy(Ids.C_SUPORTE, " ", null, "c0") }.status)
        assertEquals(400, refusal { client.courtesy(Ids.C_SUPORTE, "cliente antigo", 0, "c1") }.status)
        val release = client.confirm(Ids.C_SUPORTE, true, "k1")
        assertEquals("team", release.kind)
        assertEquals(true, release.untilTicket)
        assertEquals("nothing_to_confirm", refusal { client.confirm(Ids.C_SUPORTE, true, "k2") }.code)
        assertEquals(true, client.status(Ids.C_SUPORTE).allowed)
        val courtesy = client.courtesy(Ids.C_SUPORTE, "cliente antigo", 24, "c2")
        assertEquals("Cortesia", courtesy.kindLabel)
        assertNotNull(courtesy.validUntil)
        // Conversa sem atendimento do suporte: só a situação, sem ações.
        assertEquals("payment_required", client.status(Ids.C_RICH).reason)
        assertEquals(404, refusal { client.linkPhone(Ids.C_RICH, "x1") }.status)
    }

    @Test fun viewModelDaConversa() = runTest {
        val off = SuporteViewModel(Ids.C_SUPORTE, deps(enabled = false))
        off.load()
        assertNull(off.status)
        val vm = SuporteViewModel(Ids.C_SUPORTE, deps())
        vm.load()
        assertTrue(SuporteRules.canConfirm(vm.status))
        vm.link()?.join()
        assertEquals("Telefone vinculado ao pagador", vm.done)
        assertFalse(SuporteRules.canLink(vm.status))
        assertNull(vm.courtesy("   ", null))
        assertEquals("Informe o motivo da cortesia.", vm.notice)
        vm.confirm()?.join()
        assertEquals("Confirmado e liberado", vm.done)
        assertEquals(true, vm.status?.allowed)
        assertFalse(SuporteRules.canConfirm(vm.status))
        assertNull(vm.pendingKey)
        // Já liberada: confirmar de novo é recusado e a faixa relê.
        vm.confirm()?.join()
        assertTrue(vm.notice.orEmpty().startsWith("Esta conversa não espera mais confirmação"))
        vm.courtesy("cliente antigo", null)?.join()
        assertEquals("Liberado como cortesia", vm.done)
        assertEquals("Cortesia", vm.status?.release?.kindLabel)
    }
}
