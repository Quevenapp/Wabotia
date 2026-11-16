import XCTest
@testable import Wabotia

/// Acesso por pessoa (docs/API.md, "Acesso por pessoa", `feat/acessos-pessoa`).
final class AppAccessTests: XCTestCase {
    private func json(_ text: String) -> Any { try! JSONSerialization.jsonObject(with: Data(text.utf8)) }

    func testNullOrMissingAccessMeansModulesAndScopesAsBefore() {
        XCTAssertNil(AppAccess.parse(json(#"{"features":["modules"],"profiles":[{"id":"p1","modules":["queue"]}]}"#), profileId: "p1"))
        XCTAssertNil(AppAccess.parse(json(#"{"features":["person_access"],"profiles":[{"id":"p1","access":null}]}"#), profileId: "p1"),
                     "aparelho pareado e aplicação: access null")
        XCTAssertEqual(AppAccess.all.tabs, [.conversations, .attendance, .team, .calls, .settings])
    }

    func testReadsTheListOfTheOpenArea() {
        let caps = json(#"{"features":["person_access"],"profiles":[{"id":"p2","access":["team"]},{"id":"p1","access":["os","os:technician"]}]}"#)
        XCTAssertEqual(AppAccess.parse(caps, profileId: "p1")?.areas, ["os", "os:technician"])
    }

    func testTechnicianSeesOnlyServiceOrders() {
        let tech = AppAccess(areas: ["os", "os:technician"])
        XCTAssertEqual(tech.tabs, [.attendance, .settings])
        XCTAssertTrue(tech.allows(ModuleId.serviceOrders))
        XCTAssertTrue(tech.allows("os:technician"))
        XCTAssertFalse(tech.allows(AppAccess.Area.tickets))
        XCTAssertTrue(tech.withoutScreen.isEmpty, "a OS tem tela no app")
    }

    func testWaiterOnlyIsExplainedAsPanel() {
        let waiter = AppAccess(areas: ["mesas", "mesas:waiter"])
        XCTAssertEqual(waiter.tabs, [.attendance, .settings], "nada de conversas, equipe nem ligações")
        XCTAssertEqual(waiter.withoutScreen, ["mesas"], "um item por módulo, mesmo com o papel")
    }

    func testFullAttendantGetsEverythingButRoles() {
        let full = AppAccess(areas: ["*"])
        XCTAssertEqual(full.tabs, AppAccess.all.tabs)
        XCTAssertTrue(full.allows(ModuleId.agenda))
        XCTAssertFalse(full.allows("entrega:courier"), "\"*\" não dá papéis")
        XCTAssertTrue(AppAccess(areas: ["*", "os:technician"]).allows("os:technician"))
        let expanded = AppAccess(areas: ["conversations", "tickets", "contacts", "calls", "team", "reports", "queue"])
        XCTAssertEqual(expanded.tabs, AppAccess.all.tabs, "lista expandida do atendente completo")
        XCTAssertTrue(expanded.withoutScreen.isEmpty, "contatos e relatórios ficam no painel sem aviso")
    }

    @MainActor
    func testModulesNeedTheAreaAndTheAccess() {
        let feature = ModuleFeature()
        feature.apply([ModuleId.queue, ModuleId.agenda], profile: "p1", access: AppAccess(areas: [ModuleId.queue]))
        XCTAssertTrue(feature.isAvailable(ModuleId.queue, "p1"))
        XCTAssertFalse(feature.isAvailable(ModuleId.agenda, "p1"), "ligado na área, mas fora do acesso desta pessoa")
        feature.apply([ModuleId.queue, ModuleId.agenda], profile: "p1")
        XCTAssertTrue(feature.isAvailable(ModuleId.agenda, "p1"), "sem lista, vale o módulo")
    }
}
