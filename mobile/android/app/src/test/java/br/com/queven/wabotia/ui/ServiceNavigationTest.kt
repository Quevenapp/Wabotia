package br.com.queven.wabotia.ui

import br.com.queven.wabotia.core.AdminRole
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.modules.BasicRoutes
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.queue.ModuleCapabilities
import br.com.queven.wabotia.ui.home.HomeTab
import br.com.queven.wabotia.ui.nav.Routes
import br.com.queven.wabotia.ui.service.ServiceHub
import br.com.queven.wabotia.ui.service.ServiceSection
import br.com.queven.wabotia.ui.service.WebPanel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A navegação nova: aba Atendimento no lugar de Ajustes, Ajustes pela engrenagem e quando a Gestão aparece. */
class ServiceNavigationTest {
    private val erpParts = setOf("erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro")

    // ------------------------------------------------------------------ abas e atalhos

    @Test fun bottomBarHasAttendanceInsteadOfSettings() {
        assertEquals(listOf("Conversas", "Protocolos", "Equipe", "Ligações", "Atendimento"), HomeTab.entries.map { it.label })
        assertEquals(HomeTab.Service, HomeTab.entries.last())
        assertEquals("service", HomeTab.Service.key)
        assertFalse("Ajustes saiu da barra de baixo", HomeTab.entries.any { it.label == "Ajustes" || it.key == "settings" })
    }

    @Test fun settingsIsItsOwnScreenAndAttendanceIsATab() {
        assertEquals("settings", Routes.SETTINGS)
        val settings = DemoMode.destination("settings", null)
        assertEquals(Routes.SETTINGS, settings?.route)
        assertNull("Ajustes não é mais aba", settings?.tab)
        assertEquals("service", DemoMode.destination("service", null)?.tab)
        assertEquals("service", DemoMode.destination("atendimento", null)?.tab)
        assertEquals(HomeTab.Service, HomeTab.entries.firstOrNull { it.key == DemoMode.destination("service", null)?.tab })
    }

    // ------------------------------------------------------------------ o que a aba Atendimento mostra

    @Test fun attendanceListsEnabledModulesBasicsAssistantAndLines() {
        val modules = setOf("queue", "agenda", "os", "reserva", "mensalidade", "pedido", "mesas", "entrega") + erpParts
        val entries = ServiceHub.entries(modules, emptySet(), isAdmin = true)
        assertEquals(
            listOf(
                "counter", "agenda", "mensalidade", "reserva", "mesas", "entrega", "pedido", "os",
                "caixa", "clientes", "equipamentos",
                "assistente", "web",
                "lines", "menus", "bot-lines",
            ),
            entries.map { it.id },
        )
        assertEquals(Routes.COUNTER, entries.first { it.id == "counter" }.route)
        assertEquals(ModuleRoutes.SERVICE_ORDERS, entries.first { it.id == "os" }.route)
        assertEquals(BasicRoutes.CAIXA, entries.first { it.id == "caixa" }.route)
        assertEquals(BasicRoutes.ASSISTENTE, entries.first { it.id == "assistente" }.route)
        assertEquals("/app/erp", entries.first { it.id == "web" }.webPath)
        assertEquals(Routes.MENUS, entries.first { it.id == "menus" }.route)
        assertEquals(
            listOf(ServiceSection.MODULES, ServiceSection.DAILY, ServiceSection.ASSISTANT, ServiceSection.LINES),
            ServiceHub.sections(entries).map { it.first },
        )
        assertFalse("o ERP saiu do app", entries.any { it.id.startsWith("erp.") })
    }

    @Test fun attendanceHidesWhatIsOffOrNotAllowed() {
        // Nada ligado e atendente: clientes, equipamentos, o assistente, o navegador e as linhas (consulta).
        val bare = ServiceHub.entries(emptySet(), emptySet(), isAdmin = false)
        assertEquals(listOf("clientes", "equipamentos", "assistente", "web", "lines"), bare.map { it.id })
        assertEquals("/app/gestao/inicio", bare.first { it.id == "web" }.webPath)
        // Ordens de serviço ligadas, ERP desligado: sem caixa.
        val os = ServiceHub.entries(setOf("os"), setOf("erp:vendas"), isAdmin = false).map { it.id }
        assertTrue("os" in os)
        assertFalse("caixa" in os)
        // Financeiro ligado: o caixa é do papel Financeiro (ou administrador), não de Vendas.
        assertFalse("caixa" in ServiceHub.entries(erpParts, setOf("erp:vendas"), isAdmin = false).map { it.id })
        assertTrue("caixa" in ServiceHub.entries(erpParts, setOf("erp:financeiro"), isAdmin = false).map { it.id })
        // Financeiro desligado: nem o administrador vê o caixa.
        assertFalse("caixa" in ServiceHub.entries(erpParts - "erp-financeiro", emptySet(), isAdmin = true).map { it.id })
    }

    @Test fun webPanelAddressesUseTheSessionServer() {
        assertEquals("https://loja.exemplo/app/erp", WebPanel.url("https://loja.exemplo/", "/app/erp"))
        assertNull("demonstração, sem servidor", WebPanel.url(null, "/app/erp"))
        assertNull(WebPanel.url("demo", "/app/erp"))
        assertNull("a demonstração não tem painel", WebPanel.url(DemoMode.SERVER, "/app/erp"))
        assertEquals("/app/erp/financeiro-empresa?area=controle-caixa", WebPanel.CASH)
    }

    // ------------------------------------------------------------------ o administrador de verdade

    /** O que o servidor manda hoje para um administrador (src/modules/capabilities.ts): sem papel erp:* em `grants`. */
    private val adminCapabilities = """
        {"capabilities_version":1,"features":["modules","module_grants","person_access"],
         "actor":{"id":"u1","kind":"user","role":"admin"},
         "profiles":[{"id":"p1","name":"Loja","enabled":true,
           "modules":[{"id":"queue"},{"id":"erp"},{"id":"erp-produtos"},{"id":"erp-vendas"}],
           "grants":[],"access":["conversations","erp","erp-produtos","erp-vendas"]}],
         "modules":[{"id":"queue"},{"id":"erp"},{"id":"erp-produtos"},{"id":"erp-vendas"}]}
    """.trimIndent()

    @Test fun adminSeesAdminEntriesFromWhatTheServerSends() {
        val json = WabotiaJson.parseToJsonElement(adminCapabilities)
        val modules = ModuleCapabilities.enabledModules(json, "p1")!!
        val grants = ModuleCapabilities.grants(json, "p1")
        assertEquals(emptySet<String>(), grants)
        assertEquals("admin", ModuleCapabilities.actorRole(json))
        // Login gravado como atendente (promovido depois): o papel atual do servidor vale.
        val admin = AdminRole.isAdmin(ModuleCapabilities.actorRole(json), sessionRole = "operator")
        assertTrue(admin)
        val ids = ServiceHub.entries(modules, grants, admin).map { it.id }
        assertTrue(ids.containsAll(listOf("counter", "assistente", "menus", "bot-lines")))
        assertFalse("Financeiro desligado: sem caixa", "caixa" in ids)
        assertNotNull(ServiceHub.entries(modules, grants, admin).firstOrNull { it.id == "web" })
    }

    @Test fun currentServerRoleWinsOverTheStoredOne() {
        assertTrue(AdminRole.isAdmin("admin", "operator"))
        assertFalse("rebaixado depois do login: some", AdminRole.isAdmin("operator", "admin"))
        assertTrue("servidor antigo sem actor: vale o do login", AdminRole.isAdmin(null, "admin"))
        assertFalse(AdminRole.isAdmin(null, "operator"))
        assertFalse(AdminRole.isAdmin(null, null))
        assertTrue(AdminRole.isAdmin("", "admin"))
    }

    @Test fun actorRoleOnlyForPeople() {
        fun role(text: String) = ModuleCapabilities.actorRole(WabotiaJson.parseToJsonElement(text))
        assertEquals("operator", role("""{"actor":{"kind":"user","role":"operator"}}"""))
        assertEquals("admin", role("""{"actor":{"role":"admin"}}"""))
        assertNull("aplicação não é pessoa", role("""{"actor":{"kind":"app","role":"admin"}}"""))
        assertNull(role("""{"modules":["erp"]}"""))
        assertNull(role("""{"actor":{"kind":"user","role":""}}"""))
    }

    @Test fun personWithoutFinanceRoleNeverSeesTheCash() {
        val json = WabotiaJson.parseToJsonElement(
            """{"actor":{"kind":"user","role":"operator"},"profiles":[{"id":"p1","modules":[{"id":"erp"},{"id":"erp-financeiro"}],"grants":["os:technician"]}]}""",
        )
        val admin = AdminRole.isAdmin(ModuleCapabilities.actorRole(json), "operator")
        val modules = ModuleCapabilities.enabledModules(json, "p1")!!
        assertFalse(ServiceHub.cashAllowed(modules, ModuleCapabilities.grants(json, "p1"), admin))
        assertFalse(ServiceHub.entries(modules, ModuleCapabilities.grants(json, "p1"), admin).any { it.id == "caixa" })
    }
}
