package br.com.queven.wabotia.ui

import br.com.queven.wabotia.core.AccessRules
import br.com.queven.wabotia.core.AccessTab
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.ui.home.HomeTab
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A navegação montada a partir da lista de acessos da pessoa (contrato em aberto; sem lista, tudo como antes). */
class AccessRulesTest {
    private val all = setOf(ModuleIds.QUEUE, ModuleIds.AGENDA, ModuleIds.PEDIDO, ModuleIds.SERVICE_ORDERS)

    @After fun reset() {
        DemoMode.access = null
    }

    @Test fun semListaTudoComoAntes() {
        assertNull(AccessRules.parse(WabotiaJson.parseToJsonElement("""{"profiles":[{"id":"p1","modules":[]}]}"""), "p1"))
        assertNull(AccessRules.parse(WabotiaJson.parseToJsonElement("""{"profiles":[{"id":"p1","access":null}]}"""), "p1"))
        assertEquals(AccessTab.entries.toList(), AccessRules.tabs(null, all))
        assertEquals(all, AccessRules.modules(null, all))
    }

    @Test fun listaNaAreaNoTopoOuEmUser() {
        assertEquals(setOf("caixa"), AccessRules.parse(WabotiaJson.parseToJsonElement("""{"profiles":[{"id":"p1","access":["Caixa"]},{"id":"p2","access":["team"]}]}"""), "p1"))
        assertEquals(setOf("garcom", "tickets"), AccessRules.parse(WabotiaJson.parseToJsonElement("""{"access":["garcom"," tickets "]}"""), "p1"))
        assertEquals(setOf("calls"), AccessRules.parse(WabotiaJson.parseToJsonElement("""{"user":{"access":["calls"]}}"""), null))
        assertEquals(setOf("team"), AccessRules.parse(WabotiaJson.parseToJsonElement("""{"data":{"access":["team"]}}"""), null))
    }

    @Test fun soGarcomVeOPedidoNaAbaAtendimentoEAjustes() {
        val access = setOf("garcom")
        assertEquals(listOf(AccessTab.SERVICE, AccessTab.SETTINGS), AccessRules.tabs(access, all))
        assertEquals(setOf(ModuleIds.PEDIDO), AccessRules.modules(access, all))
        assertEquals(listOf(HomeTab.Service, HomeTab.Settings), AccessRules.tabs(access, all).map(HomeTab::of))
    }

    @Test fun soCaixaSemTelaAindaMostraAvisoNaAbaAtendimento() {
        val access = setOf("caixa")
        assertEquals(listOf(AccessTab.SERVICE, AccessTab.SETTINGS), AccessRules.tabs(access, all))
        assertEquals(emptySet<String>(), AccessRules.modules(access, all))
        assertEquals(listOf("caixa"), AccessRules.unavailable(access))
    }

    @Test fun moduloDesligadoNaAreaNaoApareceMesmoNaLista() {
        assertEquals(listOf(AccessTab.SETTINGS), AccessRules.tabs(setOf("reserva"), all))
    }

    @Test fun atendenteDeConversasEProtocolos() {
        assertEquals(
            listOf(AccessTab.CONVERSATIONS, AccessTab.SERVICE, AccessTab.SETTINGS),
            AccessRules.tabs(setOf("conversations", "tickets"), all),
        )
    }

    @Test fun atalhoDaDemonstracao() {
        assertEquals("service", DemoMode.destination("access", "caixa, pedido")?.tab)
        assertEquals(listOf("caixa", "pedido"), DemoMode.access)
        DemoMode.destination("access", "all")
        assertNull(DemoMode.access)
    }
}
