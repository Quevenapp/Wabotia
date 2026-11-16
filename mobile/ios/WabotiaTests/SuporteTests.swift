import XCTest
@testable import Wabotia

final class HandoffTests: XCTestCase {
    func testConversationDetailCarriesHandoff() throws {
        let json = #"{"conversation":{"id":"c1","profile_id":"p1","external_namespace":"wa","external_id":"5520900003333","state":"waiting","epoch":1,"last_customer":1,"created":1,"updated":1},"handoff":{"module":"suporte","summary":"Pagador Zé Comércio (CNPJ 12.345.678/0001-95). Suporte avulso pago.","flags":["telefone não vinculado ao pagador Zé Comércio"," "],"at":1763000000000},"media":[],"messages":[],"deliveries":[]}"#
        let detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: Data(json.utf8))
        let h = try XCTUnwrap(detail.handoff)
        XCTAssertEqual(h.module, "suporte")
        XCTAssertEqual(h.visibleFlags, ["telefone não vinculado ao pagador Zé Comércio"], "marcador vazio some")
        XCTAssertTrue(h.hasContent)
        XCTAssertEqual(SuporteRules.moduleName(h.module), "Suporte pago")
    }

    func testDetailWithoutHandoffStillDecodes() throws {
        let json = #"{"conversation":{"id":"c1","profile_id":"p1","external_namespace":"wa","external_id":"5520900003333","state":"human","epoch":1,"last_customer":1,"created":1,"updated":1},"handoff":null,"media":[],"messages":[],"deliveries":[]}"#
        let detail = try JSONDecoder.wabotia.decode(ConversationDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.handoff)
        XCTAssertFalse(ModuleHandoff(summary: "  ", flags: []).hasContent)
    }
}

final class SuporteClientTests: XCTestCase {
    static let statusJSON = #"{"conversation_id":"c1","phone":"5520900003333","allowed":true,"reason":"released","release":{"id":"r1","payer_id":"y1","payer_name":"Zé Comércio","kind":"package","kind_label":"Suporte avulso","phone_linked":false,"valid_until":null,"until_ticket":true,"status":"active"},"session":{"status":"active","payer_id":"y1","name":"Zé Comércio","phone_linked":false},"awaiting_team":false,"unlinked_phone":{"payer_id":"y1","payer_name":"Zé Comércio"},"purchases":[]}"#

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> SuporteClient {
        StubURLProtocol.reset(handler)
        return SuporteClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testStatusAndRules() async throws {
        let c = client { _ in .json(200, Self.statusJSON) }
        let s = try await c.status("c1")
        XCTAssertEqual(s.release?.kindLabel, "Suporte avulso")
        XCTAssertEqual(s.unlinkedPhone?.payerName, "Zé Comércio")
        XCTAssertTrue(SuporteRules.canLink(s))
        XCTAssertFalse(SuporteRules.canConfirm(s))
        XCTAssertFalse(SuporteRules.canCourtesy(s), "já liberado: sem cortesia")
        XCTAssertEqual(SuporteRules.linkTitle(s), "Vincular telefone a Zé Comércio")
        XCTAssertEqual(SuporteRules.statusText(s), "Suporte avulso · Zé Comércio · até o protocolo fechar")
        XCTAssertTrue(StubURLProtocol.seen.last!.url.path.hasSuffix("/suporte/conversations/c1"))
    }

    func testAwaitingTeamAndBlocked() {
        let waiting = SuporteStatus(allowed: false, reason: "payment_required", awaitingTeam: true)
        XCTAssertTrue(SuporteRules.canConfirm(waiting))
        XCTAssertTrue(SuporteRules.canCourtesy(waiting))
        XCTAssertEqual(SuporteRules.statusText(waiting), "Aguardando a equipe confirmar e liberar")
        let blocked = SuporteStatus(allowed: false, reason: "payment_required")
        XCTAssertEqual(SuporteRules.statusText(blocked), "Sem liberação: pagamento pendente")
        XCTAssertTrue(SuporteRules.canCourtesy(blocked))
        XCTAssertFalse(SuporteRules.canLink(blocked))
    }

    func testWritesCarryKeyPathsAndBodies() async throws {
        let c = client { seen in
            seen.url.path.hasSuffix("/link-phone") ? .json(200, Self.statusJSON) : .json(200, #"{"id":"r2","kind":"courtesy","kind_label":"Cortesia","status":"active"}"#)
        }
        _ = try await c.linkPhone("c1", key: "k1")
        _ = try await c.confirm("c1", link: true, key: "k2")
        let release = try await c.courtesy("c1", reason: "cliente antigo", hours: 24, key: "k3")
        _ = try await c.courtesy("c1", reason: "problema nosso", hours: nil, key: "k4")
        XCTAssertEqual(release.kindLabel, "Cortesia")
        let seen = StubURLProtocol.seen
        XCTAssertEqual(seen.map(\.method), ["POST", "POST", "POST", "POST"])
        XCTAssertEqual(seen.map { $0.url.path.replacingOccurrences(of: "/api/v1/profiles/p1/suporte/conversations/c1/", with: "") }, ["link-phone", "confirm", "courtesy", "courtesy"])
        XCTAssertEqual(seen.map { $0.header("Idempotency-Key") }, ["k1", "k2", "k3", "k4"])
        XCTAssertEqual(seen[1].json["link"] as? Bool, true)
        XCTAssertEqual(seen[2].json["reason"] as? String, "cliente antigo")
        XCTAssertEqual(seen[2].json["hours"] as? Int, 24)
        XCTAssertNil(seen[3].json["hours"], "sem horas: até o protocolo fechar")
    }
}
