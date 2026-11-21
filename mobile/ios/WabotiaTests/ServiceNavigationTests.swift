import XCTest
@testable import Wabotia

/// A navegação nova: aba Atendimento no lugar de Ajustes, Ajustes pela engrenagem e quando a Gestão aparece. Mesmos
/// casos do Android (`ServiceNavigationTest.kt`).
final class ServiceNavigationTests: XCTestCase {
    private let erpParts: Set<String> = ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"]

    // MARK: Abas e atalhos

    func testBottomBarHasAttendanceInsteadOfSettings() {
        XCTAssertEqual(HomeTab.allCases.map(\.title), ["Conversas", "Protocolos", "Equipe", "Ligações", "Atendimento"])
        XCTAssertEqual(HomeTab.allCases.last, .service)
        XCTAssertEqual(HomeTab(rawValue: "service"), .service)
        XCTAssertNil(HomeTab(rawValue: "settings"), "Ajustes saiu da barra de baixo")
        XCTAssertFalse(HomeTab.allCases.contains { $0.title == "Ajustes" })
    }

    func testSettingsIsAScreenAndModuleShortcutsLandOnAttendance() {
        let saved = DemoMode.pendingScreen
        defer { DemoMode.pendingScreen = saved }
        func launch(_ screen: String) -> DemoMode.Launch? {
            DemoMode.pendingScreen = screen
            return DemoMode.consumeLaunch()
        }
        let settings = launch("settings")
        XCTAssertEqual(settings?.route, .settings)
        XCTAssertEqual(settings?.tab, "conversations", "Ajustes não é mais aba: abre por cima")
        XCTAssertEqual(launch("service")?.tab, "service")
        XCTAssertEqual(launch("atendimento")?.tab, "service")
        let caixa = launch("caixa")
        XCTAssertEqual(caixa?.tab, "service")
        XCTAssertEqual(caixa?.route, .caixa)
        XCTAssertEqual(launch("os")?.tab, "service")
        XCTAssertNotNil(HomeTab(rawValue: launch("counter")?.tab ?? ""))
    }

    // MARK: O que a aba Atendimento mostra

    func testAttendanceListsEnabledModulesBasicsAssistantAndLines() {
        let modules: Set<String> = Set(["queue", "agenda", "os", "reserva", "mensalidade", "pedido", "mesas", "entrega"]).union(erpParts)
        let entries = ServiceHub.entries(modules: modules, grants: [], isAdmin: true)
        XCTAssertEqual(entries.map(\.id), [
            "counter", "agenda", "mensalidade", "reserva", "mesas", "entrega", "pedido", "os",
            "caixa", "clientes", "equipamentos",
            "assistente", "web",
            "lines", "menus", "bot-lines",
        ])
        XCTAssertEqual(entries.first { $0.id == "counter" }?.route, .counter)
        XCTAssertEqual(entries.first { $0.id == "os" }?.route, .serviceOrders)
        XCTAssertEqual(entries.first { $0.id == "caixa" }?.route, .caixa)
        XCTAssertEqual(entries.first { $0.id == "assistente" }?.route, .assistente)
        XCTAssertEqual(entries.first { $0.id == "web" }?.webPath, "/app/erp")
        XCTAssertEqual(entries.first { $0.id == "menus" }?.route, .menus)
        XCTAssertEqual(ServiceHub.sections(entries).map(\.section), [.modules, .daily, .assistant, .lines])
        XCTAssertFalse(entries.contains { $0.id.hasPrefix("erp.") }, "o ERP saiu do app")
    }

    func testAttendanceHidesWhatIsOffOrNotAllowed() {
        let bare = ServiceHub.entries(modules: [], grants: [], isAdmin: false)
        XCTAssertEqual(bare.map(\.id), ["clientes", "equipamentos", "assistente", "web", "lines"])
        XCTAssertEqual(bare.first { $0.id == "web" }?.webPath, "/app/gestao/inicio")
        let os = ServiceHub.entries(modules: ["os"], grants: ["erp:vendas"], isAdmin: false).map(\.id)
        XCTAssertTrue(os.contains("os"))
        XCTAssertFalse(os.contains("caixa"))
        XCTAssertFalse(ServiceHub.entries(modules: erpParts, grants: ["erp:vendas"], isAdmin: false).map(\.id).contains("caixa"))
        XCTAssertTrue(ServiceHub.entries(modules: erpParts, grants: ["erp:financeiro"], isAdmin: false).map(\.id).contains("caixa"))
        XCTAssertFalse(ServiceHub.entries(modules: erpParts.subtracting(["erp-financeiro"]), grants: [], isAdmin: true).map(\.id).contains("caixa"))
    }

    func testWebPanelAddressesUseTheSessionServer() {
        XCTAssertEqual(WebPanel.url(server: "https://loja.exemplo/", path: "/app/erp")?.absoluteString, "https://loja.exemplo/app/erp")
        XCTAssertNil(WebPanel.url(server: nil, path: "/app/erp"))
        XCTAssertNil(WebPanel.url(server: DemoMode.serverURL.absoluteString, path: "/app/erp"), "a demonstração não tem painel")
        XCTAssertEqual(WebPanel.cash, "/app/erp/financeiro-empresa?area=controle-caixa")
    }

    // MARK: O administrador de verdade

    /// O que o servidor manda hoje para um administrador (src/modules/capabilities.ts): sem papel erp:* em `grants`.
    private var adminCapabilities: [String: Any] {
        let modules: [[String: Any]] = [["id": "queue"], ["id": "erp"], ["id": "erp-produtos"], ["id": "erp-vendas"]]
        return [
            "capabilities_version": 1,
            "features": ["modules", "module_grants", "person_access"],
            "actor": ["id": "u1", "kind": "user", "role": "admin"],
            "profiles": [["id": "p1", "name": "Loja", "enabled": true, "modules": modules, "grants": [String](),
                          "access": ["conversations", "erp", "erp-produtos", "erp-vendas"]] as [String: Any]],
            "modules": modules,
        ]
    }

    func testAdminSeesAdminEntriesFromWhatTheServerSends() {
        let json = adminCapabilities
        let modules = ModuleCapabilities.enabledIds(json, profileId: "p1") ?? []
        let grants = ModuleCapabilities.grants(json, profileId: "p1")
        XCTAssertEqual(grants, [])
        XCTAssertEqual(ModuleCapabilities.actorRole(json), "admin")
        // Login gravado como atendente (promovido depois): o papel atual do servidor vale.
        let admin = AdminRole.isAdmin(serverRole: ModuleCapabilities.actorRole(json), sessionIsAdmin: false)
        XCTAssertTrue(admin)
        let ids = ServiceHub.entries(modules: modules, grants: grants, isAdmin: admin).map(\.id)
        XCTAssertTrue(["counter", "assistente", "web", "menus", "bot-lines"].allSatisfy(ids.contains))
        XCTAssertFalse(ids.contains("caixa"), "Financeiro desligado: sem caixa")
    }

    @MainActor
    func testModuleFeatureUsesTheCurrentServerRole() {
        let feature = ModuleFeature()
        feature.apply(["erp", "erp-financeiro"], profile: "p1")
        feature.applyGrants([], profile: "p1")
        XCTAssertFalse(feature.cashAllowed("p1", isAdmin: false), "sem papel e sem administrador: some")
        feature.applyRole("admin", profile: "p1")
        XCTAssertTrue(feature.cashAllowed("p1", isAdmin: false), "promovido depois do login: aparece")
        XCTAssertTrue(feature.isAdmin("p1", sessionIsAdmin: false))
        feature.applyRole("operator", profile: "p1")
        XCTAssertFalse(feature.cashAllowed("p1", isAdmin: true), "rebaixado depois do login: some")
        feature.applyRole(nil, profile: "p1")
        XCTAssertTrue(feature.cashAllowed("p1", isAdmin: true), "servidor antigo sem actor: vale o do login")
    }

    func testCurrentServerRoleWinsOverTheStoredOne() {
        XCTAssertTrue(AdminRole.isAdmin(serverRole: "admin", sessionIsAdmin: false))
        XCTAssertFalse(AdminRole.isAdmin(serverRole: "operator", sessionIsAdmin: true))
        XCTAssertTrue(AdminRole.isAdmin(serverRole: nil, sessionIsAdmin: true))
        XCTAssertFalse(AdminRole.isAdmin(serverRole: nil, sessionIsAdmin: false))
        XCTAssertTrue(AdminRole.isAdmin(serverRole: "", sessionIsAdmin: true))
    }

    func testActorRoleOnlyForPeople() {
        XCTAssertEqual(ModuleCapabilities.actorRole(["actor": ["kind": "user", "role": "operator"]]), "operator")
        XCTAssertEqual(ModuleCapabilities.actorRole(["actor": ["role": "admin"]]), "admin")
        XCTAssertNil(ModuleCapabilities.actorRole(["actor": ["kind": "app", "role": "admin"]]), "aplicação não é pessoa")
        XCTAssertNil(ModuleCapabilities.actorRole(["modules": ["erp"]]))
        XCTAssertNil(ModuleCapabilities.actorRole(["actor": ["kind": "user", "role": ""]]))
    }

    func testPersonWithoutFinanceRoleNeverSeesTheCash() {
        let json: [String: Any] = [
            "actor": ["kind": "user", "role": "operator"],
            "profiles": [["id": "p1", "modules": [["id": "erp"], ["id": "erp-financeiro"]], "grants": ["os:technician"]] as [String: Any]],
        ]
        let admin = AdminRole.isAdmin(serverRole: ModuleCapabilities.actorRole(json), sessionIsAdmin: false)
        let modules = ModuleCapabilities.enabledIds(json, profileId: "p1") ?? []
        XCTAssertFalse(ServiceHub.cashAllowed(modules: modules, grants: ModuleCapabilities.grants(json, profileId: "p1"), isAdmin: admin))
        XCTAssertFalse(ServiceHub.entries(modules: modules, grants: ModuleCapabilities.grants(json, profileId: "p1"), isAdmin: admin).contains { $0.id == "caixa" })
    }

    @MainActor
    func testDemoCapabilitiesSayTheDemoPersonIsAdmin() async {
        DemoServer.reset()
        let snapshot = await ModulesProbe(baseURL: DemoMode.serverURL.absoluteString, profileId: DemoMode.profileId, token: { "wabu_demo" }, session: QueueHTTP.makeSession()).snapshot()
        XCTAssertEqual(snapshot?.role, "admin")
    }
}
