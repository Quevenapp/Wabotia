import XCTest
@testable import Wabotia

final class AppAccessTests: XCTestCase {
    private func json(_ text: String) -> Any { try! JSONSerialization.jsonObject(with: Data(text.utf8)) }

    func testNoListMeansEverythingAsBefore() {
        XCTAssertNil(AppAccess.parse(json(#"{"profiles":[{"id":"p1","modules":["queue"]}]}"#), profileId: "p1"))
        XCTAssertEqual(AppAccess.all.tabs, [.conversations, .attendance, .team, .calls, .settings])
    }

    func testReadsTheListFromTheAreaTheActorOrTheTop() {
        XCTAssertEqual(AppAccess.parse(json(#"{"profiles":[{"id":"p2","access":["team"]},{"id":"p1","access":["Caixa"]}]}"#), profileId: "p1")?.areas, ["caixa"],
                       "a lista da área aberta, sem maiúsculas")
        XCTAssertEqual(AppAccess.parse(json(#"{"actor":{"access":[{"id":"garçom"}]}}"#), profileId: "p1")?.areas, ["mesas"], "garçom é a área de mesas")
        XCTAssertEqual(AppAccess.parse(json(#"{"access":{"conversations":true,"calls":false}}"#), profileId: nil)?.areas, ["conversations"])
    }

    func testOnlyCashierShowsAttendanceExplainingAndSettings() {
        let cashier = AppAccess(areas: AppAccess.normalize(["caixa"]))
        XCTAssertEqual(cashier.tabs, [.attendance, .settings], "nada de conversas, equipe nem ligações")
        XCTAssertEqual(cashier.withoutScreen, ["caixa"], "o Atendimento diz que o caixa fica no painel")
        XCTAssertFalse(cashier.allows(AppAccess.Area.tickets))
    }

    func testOnlyConversationsAndQueue() {
        let access = AppAccess(areas: AppAccess.normalize(["conversas", "fila"]))
        XCTAssertEqual(access.tabs, [.conversations, .attendance, .settings])
        XCTAssertTrue(access.allows(ModuleId.queue))
        XCTAssertFalse(access.allows(ModuleId.agenda))
        XCTAssertTrue(access.withoutScreen.isEmpty)
        XCTAssertEqual(AppAccess(areas: ["*"]).tabs, AppAccess.all.tabs, "\"*\" é tudo")
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
