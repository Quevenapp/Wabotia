package br.com.queven.wabotia.ui

import br.com.queven.wabotia.core.AdminRole
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.modules.erp.ErpAccess
import br.com.queven.wabotia.modules.erp.ErpRole
import br.com.queven.wabotia.modules.erp.ErpRoutes
import br.com.queven.wabotia.queue.ModuleCapabilities
import br.com.queven.wabotia.ui.home.HomeTab
import br.com.queven.wabotia.ui.nav.Routes
import br.com.queven.wabotia.ui.service.ServiceHub
import br.com.queven.wabotia.ui.service.ServiceSection
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

    @Test fun attendanceListsEnabledModulesManagementAndLines() {
        val modules = setOf("queue", "agenda", "os", "reserva", "mensalidade", "pedido") + erpParts
        val erp = ErpAccess.of(modules, emptySet(), isAdmin = true)
        val entries = ServiceHub.entries(modules, erp, isAdmin = true)
        assertEquals(
            listOf(
                "counter", "agenda", "os", "reserva", "mensalidade", "pedido",
                "erp.customers", "erp.products", "erp.order", "erp.bills",
                "lines", "menus", "bot-lines",
            ),
            entries.map { it.id },
        )
        assertEquals(Routes.COUNTER, entries.first { it.id == "counter" }.route)
        assertEquals(ModuleRoutes.SERVICE_ORDERS, entries.first { it.id == "os" }.route)
        assertEquals(ErpRoutes.CUSTOMERS, entries.first { it.id == "erp.customers" }.route)
        assertEquals(ErpRoutes.ORDER, entries.first { it.id == "erp.order" }.route)
        assertEquals(Routes.MENUS, entries.first { it.id == "menus" }.route)
        assertEquals(
            listOf(ServiceSection.MODULES, ServiceSection.MANAGEMENT, ServiceSection.LINES),
            ServiceHub.sections(entries).map { it.first },
        )
    }

    @Test fun attendanceHidesWhatIsOffOrNotAllowed() {
        // Nada ligado e atendente: só as linhas de atendimento (consulta), sem menus nem linhas dos bots.
        val bare = ServiceHub.entries(emptySet(), null, isAdmin = false)
        assertEquals(listOf("lines"), bare.map { it.id })
        assertEquals(listOf(ServiceSection.LINES), ServiceHub.sections(bare).map { it.first })
        // Ordens de serviço ligadas, ERP desligado: sem Gestão.
        val os = ServiceHub.entries(setOf("os"), ErpAccess.of(setOf("os"), setOf("erp:vendas"), false), isAdmin = false)
        assertEquals(listOf("os", "lines"), os.map { it.id })
        // Papel de vendas: clientes, produtos e pedido rápido; contas não.
        val vendas = ErpAccess.of(erpParts, setOf("erp:vendas"), isAdmin = false)
        val ids = ServiceHub.entries(erpParts, vendas, isAdmin = false).map { it.id }
        assertEquals(listOf("erp.customers", "erp.products", "erp.order", "lines"), ids)
        // Só Cadastros ligado: Gestão com Clientes.
        val onlyCustomers = ServiceHub.entries(setOf("erp"), ErpAccess.of(setOf("erp"), emptySet(), true), isAdmin = true).map { it.id }
        assertTrue("erp.customers" in onlyCustomers)
        assertFalse("erp.products" in onlyCustomers)
    }

    // ------------------------------------------------------------------ Gestão para o administrador de verdade

    /** O que o servidor manda hoje para um administrador (src/modules/capabilities.ts): sem papel erp:* em `grants`. */
    private val adminCapabilities = """
        {"capabilities_version":1,"features":["modules","module_grants","person_access"],
         "actor":{"id":"u1","kind":"user","role":"admin"},
         "profiles":[{"id":"p1","name":"Loja","enabled":true,
           "modules":[{"id":"queue"},{"id":"erp"},{"id":"erp-produtos"},{"id":"erp-vendas"}],
           "grants":[],"access":["conversations","erp","erp-produtos","erp-vendas"]}],
         "modules":[{"id":"queue"},{"id":"erp"},{"id":"erp-produtos"},{"id":"erp-vendas"}]}
    """.trimIndent()

    @Test fun adminSeesManagementFromWhatTheServerSends() {
        val json = WabotiaJson.parseToJsonElement(adminCapabilities)
        val modules = ModuleCapabilities.enabledModules(json, "p1")!!
        val grants = ModuleCapabilities.grants(json, "p1")
        assertEquals(emptySet<String>(), grants)
        assertEquals("admin", ModuleCapabilities.actorRole(json))
        // Login gravado como atendente (promovido depois): o papel atual do servidor vale.
        val admin = AdminRole.isAdmin(ModuleCapabilities.actorRole(json), sessionRole = "operator")
        assertTrue(admin)
        val erp = ErpAccess.of(modules, grants, admin)
        assertNotNull("Gestão aparece para o administrador sem papel erp:*", erp)
        assertEquals(ErpRole.ADMIN, erp!!.role)
        val ids = ServiceHub.entries(modules, erp, admin).map { it.id }
        assertTrue(ids.containsAll(listOf("erp.customers", "erp.products", "erp.order")))
        assertFalse("Financeiro desligado: sem Contas", "erp.bills" in ids)
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

    @Test fun personWithoutErpRoleNeverSeesManagement() {
        val json = WabotiaJson.parseToJsonElement(
            """{"actor":{"kind":"user","role":"operator"},"profiles":[{"id":"p1","modules":[{"id":"erp"}],"grants":["os:technician"]}]}""",
        )
        val admin = AdminRole.isAdmin(ModuleCapabilities.actorRole(json), "operator")
        assertNull(ErpAccess.of(ModuleCapabilities.enabledModules(json, "p1")!!, ModuleCapabilities.grants(json, "p1"), admin))
        assertFalse(ServiceHub.entries(setOf("erp"), null, admin).any { it.section == ServiceSection.MANAGEMENT })
    }
}
