package br.com.queven.wabotia.ui

import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.ui.home.HomeTab
import br.com.queven.wabotia.ui.service.ServiceTexts
import br.com.queven.wabotia.ui.settings.SettingsTexts
import br.com.queven.wabotia.ui.tickets.TicketFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A aba Atendimento no lugar de Protocolos, e o que saiu de Ajustes. */
class ServiceTabTest {
    @Test fun barraInferiorTemAtendimentoNoLugarDeProtocolos() {
        assertEquals(listOf("Conversas", "Atendimento", "Equipe", "Ligações", "Ajustes"), HomeTab.entries.map { it.label })
        assertTrue(HomeTab.entries.none { it.label == "Protocolos" })
    }

    @Test fun resumoDosProtocolosAtivos() {
        assertEquals("Recebidos, em análise e aguardando", ServiceTexts.activeSummary(emptyMap()))
        assertEquals("Nenhum protocolo ativo agora", ServiceTexts.activeSummary(mapOf(TicketFilter.Active to 0, TicketFilter.Open to 0)))
        assertEquals(
            "1 recebido · 2 em análise",
            ServiceTexts.activeSummary(mapOf(TicketFilter.Active to 3, TicketFilter.Open to 1, TicketFilter.InProgress to 2, TicketFilter.Waiting to 0)),
        )
        assertEquals("3 recebidos · 1 aguardando", ServiceTexts.activeSummary(mapOf(TicketFilter.Open to 3, TicketFilter.Waiting to 1)))
    }

    @Test fun ferramentasSoDosModulosLigados() {
        assertEquals(emptyList<String>(), ServiceTexts.tools(emptySet()).map { it.id })
        val all = setOf(ModuleIds.PEDIDO, ModuleIds.QUEUE, ModuleIds.AGENDA, ModuleIds.SERVICE_ORDERS, ModuleIds.RESERVA, ModuleIds.MENSALIDADE)
        val tools = ServiceTexts.tools(all)
        assertEquals(listOf(ModuleIds.QUEUE, ModuleIds.AGENDA, ModuleIds.SERVICE_ORDERS, ModuleIds.RESERVA, ModuleIds.MENSALIDADE, ModuleIds.PEDIDO), tools.map { it.id })
        // O guichê tem rota própria; os módulos abrem pelas rotas dos módulos.
        assertNull(tools.first().route)
        assertEquals(ModuleRoutes.AGENDA, tools[1].route)
    }

    @Test fun presencaFalaOnlineEOffline() {
        assertEquals("Você está online", ServiceTexts.presenceTitle(true))
        assertEquals("Você está offline", ServiceTexts.presenceTitle(false))
        assertEquals("Consultando presença…", ServiceTexts.presenceTitle(null))
    }

    @Test fun impressoraFicaEmAjustesQuandoAlgumModuloImprime() {
        assertNull(SettingsTexts.printerSubtitle(emptySet()))
        assertNull(SettingsTexts.printerSubtitle(setOf(ModuleIds.AGENDA, ModuleIds.RESERVA)))
        assertEquals("Bluetooth, USB ou Wi-Fi, para imprimir a senha do totem", SettingsTexts.printerSubtitle(setOf(ModuleIds.QUEUE)))
        assertEquals(
            "Bluetooth, USB ou Wi-Fi, para imprimir a senha do totem, o comprovante da ordem de serviço e a comanda do pedido",
            SettingsTexts.printerSubtitle(setOf(ModuleIds.QUEUE, ModuleIds.SERVICE_ORDERS, ModuleIds.PEDIDO)),
        )
    }

    @Test fun atalhosDaDemonstracaoAbremAAbaEALista() {
        assertEquals("service", DemoMode.destination("service", null)?.tab)
        assertEquals("service", DemoMode.destination("atendimento", null)?.tab)
        val tickets = DemoMode.destination("tickets", "overdue")
        assertEquals("service", tickets?.tab)
        assertEquals("tickets?filter=overdue", tickets?.route)
        assertEquals("tickets", DemoMode.destination("tickets", null)?.route)
        // O nome do filtro na rota é o do enum, que a lista reconhece ignorando maiúsculas.
        assertTrue(TicketFilter.entries.any { it.name.equals("overdue", ignoreCase = true) })
    }
}
