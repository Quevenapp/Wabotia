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
import org.junit.Assert.assertTrue
import org.junit.Test

/** A navegação montada pelo acesso por pessoa (docs/API.md, "Acesso por pessoa", feat/acessos-pessoa de186dd). */
class AccessRulesTest {
    private val enabled = setOf(ModuleIds.QUEUE, ModuleIds.AGENDA, ModuleIds.PEDIDO, ModuleIds.SERVICE_ORDERS, "mesas", "entrega")

    @After fun reset() {
        DemoMode.access = null
    }

    private fun caps(access: String) = WabotiaJson.parseToJsonElement(
        """{"features":["modules","person_access"],"profiles":[{"id":"p1","modules":[],"access":$access},{"id":"p2","access":["team"]}]}""",
    )

    @Test fun listaDaAreaPedida() {
        assertEquals(setOf("mesas", "mesas:waiter"), AccessRules.parse(caps("""["mesas","mesas:waiter"]"""), "p1"))
        assertEquals(setOf("team"), AccessRules.parse(caps("[]"), "p2"))
        // Aparelho pareado, aplicação ou servidor antigo: sem lista, vale `modules`.
        assertNull(AccessRules.parse(caps("null"), "p1"))
        assertNull(AccessRules.parse(WabotiaJson.parseToJsonElement("""{"profiles":[{"id":"p1","modules":[]}]}"""), "p1"))
    }

    @Test fun semListaOuAtendenteCompletoVeTudo() {
        assertEquals(AccessTab.entries.toList(), AccessRules.tabs(null, enabled))
        assertEquals(AccessTab.entries.toList(), AccessRules.tabs(setOf("*"), enabled))
        assertEquals(enabled, AccessRules.modules(setOf("*"), enabled))
        assertTrue(AccessRules.unavailable(setOf("*")).isEmpty())
    }

    @Test fun soGarcomAindaSemTelaMostraAvisoNaAbaAtendimento() {
        val access = setOf("mesas", "mesas:waiter")
        assertEquals(listOf(AccessTab.SERVICE, AccessTab.SETTINGS), AccessRules.tabs(access, enabled))
        assertEquals(listOf("mesas:waiter"), AccessRules.unavailable(access))
        assertEquals("Garçom", AccessRules.label("mesas:waiter"))
        assertEquals(listOf(HomeTab.Service, HomeTab.Settings), AccessRules.tabs(access, enabled).map(HomeTab::of))
    }

    @Test fun tecnicoUsaATelaDaOrdemDeServico() {
        val access = setOf("os", "os:technician")
        assertEquals(listOf(AccessTab.SERVICE, AccessTab.SETTINGS), AccessRules.tabs(access, enabled))
        assertEquals(setOf(ModuleIds.SERVICE_ORDERS), AccessRules.modules(access, enabled))
        assertTrue(AccessRules.unavailable(access).isEmpty())
    }

    @Test fun soCaixa() {
        val access = setOf("caixa:cashier")
        assertEquals(listOf(AccessTab.SERVICE, AccessTab.SETTINGS), AccessRules.tabs(access, enabled))
        assertEquals("Caixa", AccessRules.label("caixa:cashier"))
    }

    @Test fun atendenteDeConversasEProtocolos() {
        assertEquals(
            listOf(AccessTab.CONVERSATIONS, AccessTab.SERVICE, AccessTab.SETTINGS),
            AccessRules.tabs(setOf("conversations", "tickets"), enabled),
        )
        assertEquals(listOf(AccessTab.TEAM, AccessTab.CALLS, AccessTab.SETTINGS), AccessRules.tabs(setOf("team", "calls"), enabled))
    }

    @Test fun moduloForaDaListaNaoAparece() {
        assertEquals(setOf(ModuleIds.AGENDA), AccessRules.modules(setOf("agenda", "tickets"), enabled))
    }

    @Test fun atalhoDaDemonstracao() {
        assertEquals("service", DemoMode.destination("access", "mesas,mesas:waiter")?.tab)
        assertEquals(listOf("mesas", "mesas:waiter"), DemoMode.access)
        DemoMode.destination("access", "all")
        assertNull(DemoMode.access)
    }
}
