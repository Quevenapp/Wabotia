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
        let erp = launch("erp-order")
        XCTAssertEqual(erp?.tab, "service")
        XCTAssertEqual(erp?.route, .erpOrder)
        XCTAssertEqual(launch("os")?.tab, "service")
        XCTAssertNotNil(HomeTab(rawValue: launch("counter")?.tab ?? ""))
    }

    // MARK: O que a aba Atendimento mostra

    func testAttendanceListsEnabledModulesManagementAndLines() {
        let modules: Set<String> = Set(["queue", "agenda", "os", "reserva", "mensalidade", "pedido"]).union(erpParts)
        let erp = ErpAccess.of(modules: modules, grants: [], isAdmin: true)
        let entries = ServiceHub.entries(modules: modules, erp: erp, isAdmin: true)
        XCTAssertEqual(entries.map(\.id), [
            "counter", "agenda", "os", "reserva", "mensalidade", "pedido",
            "erp.customers", "erp.products", "erp.order", "erp.bills",
            "lines", "menus", "bot-lines",
        ])
        XCTAssertEqual(entries.first { $0.id == "counter" }?.route, .counter)
        XCTAssertEqual(entries.first { $0.id == "os" }?.route, .serviceOrders)
        XCTAssertEqual(entries.first { $0.id == "erp.customers" }?.route, .erpCustomers)
        XCTAssertEqual(entries.first { $0.id == "erp.order" }?.route, .erpOrder)
        XCTAssertEqual(entries.first { $0.id == "menus" }?.route, .menus)
        XCTAssertEqual(ServiceHub.sections(entries).map(\.section), [.modules, .management, .lines])
    }

    func testAttendanceHidesWhatIsOffOrNotAllowed() {
        let bare = ServiceHub.entries(modules: [], erp: nil, isAdmin: false)
        XCTAssertEqual(bare.map(\.id), ["lines"])
        XCTAssertEqual(ServiceHub.sections(bare).map(\.section), [.lines])
        let os = ServiceHub.entries(modules: ["os"], erp: ErpAccess.of(modules: ["os"], grants: ["erp:vendas"], isAdmin: false), isAdmin: false)
        XCTAssertEqual(os.map(\.id), ["os", "lines"])
        let vendas = ErpAccess.of(modules: erpParts, grants: ["erp:vendas"], isAdmin: false)
        XCTAssertEqual(ServiceHub.entries(modules: erpParts, erp: vendas, isAdmin: false).map(\.id), ["erp.customers", "erp.products", "erp.order", "lines"])
        let onlyCustomers = ServiceHub.entries(modules: ["erp"], erp: ErpAccess.of(modules: ["erp"], grants: [], isAdmin: true), isAdmin: true).map(\.id)
        XCTAssertTrue(onlyCustomers.contains("erp.customers"))
        XCTAssertFalse(onlyCustomers.contains("erp.products"))
    }

    // MARK: Gestão para o administrador de verdade

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

    func testAdminSeesManagementFromWhatTheServerSends() {
        let json = adminCapabilities
        let modules = ModuleCapabilities.enabledIds(json, profileId: "p1") ?? []
        let grants = ModuleCapabilities.grants(json, profileId: "p1")
        XCTAssertEqual(grants, [])
        XCTAssertEqual(ModuleCapabilities.actorRole(json), "admin")
        // Login gravado como atendente (promovido depois): o papel atual do servidor vale.
        let admin = AdminRole.isAdmin(serverRole: ModuleCapabilities.actorRole(json), sessionIsAdmin: false)
        XCTAssertTrue(admin)
        let erp = ErpAccess.of(modules: modules, grants: grants, isAdmin: admin)
        XCTAssertEqual(erp?.role, .admin, "Gestão aparece para o administrador sem papel erp:*")
        let ids = ServiceHub.entries(modules: modules, erp: erp, isAdmin: admin).map(\.id)
        XCTAssertTrue(["erp.customers", "erp.products", "erp.order"].allSatisfy(ids.contains))
        XCTAssertFalse(ids.contains("erp.bills"), "Financeiro desligado: sem Contas")
    }

    @MainActor
    func testModuleFeatureUsesTheCurrentServerRole() {
        let feature = ModuleFeature()
        feature.apply(["erp", "erp-produtos"], profile: "p1")
        feature.applyGrants([], profile: "p1")
        XCTAssertNil(feature.erpAccess("p1", isAdmin: false), "sem papel e sem administrador: some")
        feature.applyRole("admin", profile: "p1")
        XCTAssertEqual(feature.erpAccess("p1", isAdmin: false)?.role, .admin, "promovido depois do login: aparece")
        XCTAssertTrue(feature.isAdmin("p1", sessionIsAdmin: false))
        feature.applyRole("operator", profile: "p1")
        XCTAssertNil(feature.erpAccess("p1", isAdmin: true), "rebaixado depois do login: some")
        feature.applyRole(nil, profile: "p1")
        XCTAssertEqual(feature.erpAccess("p1", isAdmin: true)?.role, .admin, "servidor antigo sem actor: vale o do login")
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

    func testPersonWithoutErpRoleNeverSeesManagement() {
        let json: [String: Any] = [
            "actor": ["kind": "user", "role": "operator"],
            "profiles": [["id": "p1", "modules": [["id": "erp"]], "grants": ["os:technician"]] as [String: Any]],
        ]
        let admin = AdminRole.isAdmin(serverRole: ModuleCapabilities.actorRole(json), sessionIsAdmin: false)
        XCTAssertNil(ErpAccess.of(modules: ModuleCapabilities.enabledIds(json, profileId: "p1") ?? [], grants: ModuleCapabilities.grants(json, profileId: "p1"), isAdmin: admin))
        XCTAssertFalse(ServiceHub.entries(modules: ["erp"], erp: nil, isAdmin: admin).contains { $0.section == .management })
    }

    @MainActor
    func testDemoCapabilitiesSayTheDemoPersonIsAdmin() async {
        DemoServer.reset()
        let snapshot = await ModulesProbe(baseURL: DemoMode.serverURL.absoluteString, profileId: DemoMode.profileId, token: { "wabu_demo" }, session: QueueHTTP.makeSession()).snapshot()
        XCTAssertEqual(snapshot?.role, "admin")
    }
}
