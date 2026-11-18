import Foundation
import XCTest
@testable import Wabotia

/// Tarefa C: exemplos do CONTRATO-MOTOR §§2/5 e dos DTOs F0, ainda não capturas HTTP de M/O.
/// As mesmas fixtures ficam no Android. StubURLProtocol entrega bytes ao cliente real sem rede.
@MainActor
final class ServiceOrderMotorCompatibilityTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let bundle = Bundle(for: ServiceOrderMotorCompatibilityTests.self)
        // XcodeGen pode copiar recursos de grupos para a raiz do bundle.
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/WorkOrders")
            ?? bundle.url(forResource: name, withExtension: "json"), "Fixture ausente: \(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func objectFixture(_ name: String) throws -> [String: Any] {
        let text = try fixture(name)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func json(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func decode(_ object: [String: Any]) throws -> ServiceOrder {
        try QueueHTTP.decode(ServiceOrder.self, JSONSerialization.data(withJSONObject: object))
    }

    private func client(_ handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> ServiceOrderClient {
        StubURLProtocol.reset(handler)
        return ServiceOrderClient(api: ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" })
    }

    func testBuiltinAdditionsPreserveBaseStateQuoteAndActions() async throws {
        let text = try fixture("motor-builtin-quoted")
        let order = try await client { _ in .json(200, text) }.order("os_builtin")
        XCTAssertEqual(order.state, "quoted")
        XCTAssertEqual(order.label, "Orçamento enviado")
        XCTAssertEqual(order.number, 120)
        XCTAssertEqual(order.numberText, "nº 120")
        XCTAssertEqual(order.item, "Celular")
        XCTAssertEqual(order.problem, "Tela trincada")
        XCTAssertEqual(order.quote?.total, 45_000)
        XCTAssertEqual(order.quote?.items?.last?.totalCents, 10_000)
        XCTAssertEqual(order.customer?.conversationId, "c1")
        XCTAssertTrue(ServiceOrderRules.canEditQuote(order))
        XCTAssertEqual(ServiceOrderRules.actions(for: order).map(\.title),
                       ["Voltar para análise", "Enviar orçamento", "Cliente aprovou", "Cliente recusou", "Cancelar ordem"])
    }

    func testCustomOrderIgnoresExtrasAndDisplaysBaseStateAndGlobalNumber() async throws {
        let raw = try objectFixture("motor-custom-order")
        XCTAssertEqual(raw["stage"] as? String, "citacao")
        XCTAssertEqual(raw["display_number"] as? String, "PROC-12")
        let extra = try XCTUnwrap(raw["extra"] as? [String: Any])
        XCTAssertEqual(extra["urgente"] as? Bool, false)
        XCTAssertEqual(extra["audiencias"] as? Int, 0)
        let text = try json(raw)
        let order = try await client { _ in .json(200, text) }.order("os_custom")
        XCTAssertEqual(order.state, "in_progress")
        XCTAssertEqual(order.label, "Em execução")
        XCTAssertEqual(order.numberText, "nº 121")
        XCTAssertEqual(order.item, "Processo demonstrativo 2026/12")
        XCTAssertEqual(order.problem, "Revisão contratual")
        XCTAssertFalse(ServiceOrderRules.canEditQuote(order))
        XCTAssertEqual(ServiceOrderRules.actions(for: order).map(\.status), ["ready", "cancelled"])
        XCTAssertEqual(ServiceOrderRules.actions(for: order).map(\.title), ["Marcar como pronta", "Cancelar ordem"])
        // instruir troca entre etapas de in_progress e não vira botão legado.
        XCTAssertFalse((order.nextStatuses ?? []).contains("instrucao"))
        XCTAssertEqual(ServiceOrderRules.historyText(try XCTUnwrap(order.history?.first)), "Em execução")
        let receipt = ServiceOrderReceiptData.of(order, header: "Área", now: Date(timeIntervalSince1970: 1_794_763_800))
        XCTAssertEqual(receipt.number, "121")
        let fields = Dictionary(uniqueKeysWithValues: ServiceOrderReceiptText.fields(receipt))
        XCTAssertEqual(fields["Item"], order.item)
        XCTAssertEqual(fields["Problema"], order.problem)
        XCTAssertEqual(fields["Estado"], "Em execução")
    }

    func testMixedPageKeepsEveryRowExactSparseCountsAndTextCursor() async throws {
        let text = try fixture("motor-mixed-page")
        let c = client { _ in .json(200, text) }
        let page = try await c.list(open: true, query: "Processo")
        XCTAssertEqual(page.data?.map(\.id), ["os_custom", "os_builtin"])
        XCTAssertEqual(page.data?.map(\.label), ["Em execução", "Orçamento enviado"])
        XCTAssertEqual(page.counts, ["received": 2, "quoted": 1, "in_progress": 3, "delivered": 4, "cancelled": 1])
        XCTAssertNil(page.counts?["inProgress"])
        XCTAssertEqual(page.count("ready"), 0)
        XCTAssertEqual(page.nextCursor, "120")
        _ = try await c.list(cursor: page.nextCursor)
        let last = try XCTUnwrap(StubURLProtocol.seen.last)
        let query = URLComponents(url: last.url, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.first { $0.name == "cursor" }?.value, "120")
        // Totais são da área; não são recalculados pelas duas linhas nem pelas facetas.
        XCTAssertEqual(page.counts?.values.reduce(0, +), 11)
        let vm = ServiceOrdersViewModel(client: c) { _ in XCTFail("A página ampliada deve carregar") }
        await vm.load()
        XCTAssertNil(vm.error)
        XCTAssertEqual(vm.orders.count, 2)
        XCTAssertEqual(vm.count("open"), 6)
        XCTAssertEqual(vm.count("delivered"), 4)
        XCTAssertEqual(vm.count("ready"), 0)
    }

    func testEmptyPageAcceptsNullCursorAndMissingCountKeys() async throws {
        let text = try fixture("motor-empty-page")
        let c = client { _ in .json(200, text) }
        let page = try await c.list()
        XCTAssertEqual(page.data, [])
        XCTAssertNil(page.nextCursor)
        XCTAssertEqual(page.counts, [:])
        for status in ServiceOrderRules.statuses { XCTAssertEqual(page.count(status), 0) }
        let vm = ServiceOrdersViewModel(client: c) { _ in XCTFail("A página vazia deve carregar") }
        await vm.load()
        XCTAssertEqual(vm.count("open"), 0)
    }

    func testFallbackLabelAndMaximumSharedNumberRemainCompatible() throws {
        var raw = try objectFixture("motor-custom-order")
        raw.removeValue(forKey: "status_label")
        raw["number"] = 2_147_483_647
        let order = try decode(raw)
        XCTAssertEqual(order.label, "Em execução")
        XCTAssertEqual(order.numberText, "nº 2147483647")
        raw.removeValue(forKey: "status")
        XCTAssertEqual(try decode(raw).state, "received")
    }

    func testLegacyCreationOmitsTypeAndManualActionSendsBaseStatus() async throws {
        let text = try fixture("motor-builtin-quoted")
        let c = client { _ in .json(200, text) }
        _ = try await c.create(item: "Celular", problem: "Tela trincada", conversationId: "c1", phone: nil,
                               customerName: nil, notes: nil, dueAt: nil, key: "create-1")
        let created = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertNil(created.json["type_id"])
        XCTAssertEqual(created.json["item"] as? String, "Celular")
        XCTAssertEqual(created.json["problem"] as? String, "Tela trincada")
        _ = try await c.setStatus("os_custom", status: "ready", note: nil, key: "status-1")
        let changed = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(changed.url.path, "/api/v1/profiles/p1/service-orders/os_custom/status")
        XCTAssertEqual(changed.json["status"] as? String, "ready")
        XCTAssertNil(changed.json["transition_id"])
    }

    func testDecisionSendsApproveButDecodesApproved() async throws {
        let text = try fixture("motor-builtin-approved")
        let order = try await client { _ in .json(200, text) }.decide("os_builtin", approve: true, key: "decision-1")
        let sent = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(sent.url.path, "/api/v1/profiles/p1/service-orders/os_builtin/decision")
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.header("Idempotency-Key"), "decision-1")
        XCTAssertEqual(sent.json["decision"] as? String, "approve")
        XCTAssertEqual(order.decision?.decision, "approved")
        XCTAssertEqual(order.state, "approved")
        XCTAssertEqual(order.label, "Aprovada")
    }

    func testQuoteSendKeepsItsSpecialRoute() async throws {
        let text = try fixture("motor-builtin-quoted")
        let order = try await client { _ in .json(200, text) }.sendQuote("os_builtin", notify: false, key: "quote-1")
        let sent = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(sent.url.path, "/api/v1/profiles/p1/service-orders/os_builtin/quote/send")
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.json["notify"] as? Bool, false)
        XCTAssertEqual(order.state, "quoted")
        XCTAssertEqual(order.label, "Orçamento enviado")
    }

    // Desativados: expressam o resultado desejado e falham no app atual quando o skip é removido.
    // Payloads que violam §§2/5 são contraprovas, não propostas de mudança do servidor.
    func testFormattedNumberShouldNotLoseThePage() async throws {
        try XCTSkipIf(true, "Contrato §2: number textual impede decodificar a página iOS; manter número global inteiro.")
        var invalid = try objectFixture("motor-custom-order")
        invalid["number"] = "PROC-12"
        var page = try objectFixture("motor-mixed-page")
        page["data"] = [invalid, try objectFixture("motor-builtin-quoted")]
        let text = try json(page)
        let result = try await client { _ in .json(200, text) }.list() // Hoje lança erro de decodificação.
        XCTAssertEqual(result.data?.count, 2)
    }

    func testObjectCursorShouldNotBreakPagination() async throws {
        try XCTSkipIf(true, "Contrato §2: next_cursor objeto impede decodificar a página iOS; manter texto ou null.")
        var page = try objectFixture("motor-mixed-page")
        page["next_cursor"] = ["number": 120]
        let text = try json(page)
        let result = try await client { _ in .json(200, text) }.list() // Hoje lança erro de decodificação.
        XCTAssertEqual(result.nextCursor, "120")
    }

    func testStageCountsShouldNotZeroOpenOrders() async throws {
        try XCTSkipIf(true, "Contrato §2: counts por etapa não entra na soma de abertas; usar códigos de base.")
        var page = try objectFixture("motor-mixed-page")
        page["counts"] = ["citacao": 3]
        let text = try json(page)
        let vm = ServiceOrdersViewModel(client: client { _ in .json(200, text) }) { _ in XCTFail() }
        await vm.load()
        XCTAssertEqual(vm.count("open"), 3) // Hoje é zero.
    }

    func testStageInStatusShouldHaveAFilter() throws {
        try XCTSkipIf(true, "Contrato §2: status com ID de etapa não tem filtro legado; manter in_progress em status.")
        var raw = try objectFixture("motor-custom-order")
        raw["status"] = "citacao"
        let order = try decode(raw)
        XCTAssertTrue(ServiceOrderRules.filters.contains { $0.id == order.state }) // Hoje não existe.
    }

    func testStageInNextStatusesShouldResolveBaseAction() throws {
        try XCTSkipIf(true, "Contrato §2: etapa em next_statuses vira destino desconhecido; só enviar ações antigas não ambíguas.")
        var raw = try objectFixture("motor-custom-order")
        raw["next_statuses"] = ["conclusao"]
        XCTAssertEqual(ServiceOrderRules.actions(for: try decode(raw)).first?.status, "ready") // Hoje é conclusao.
    }

    func testApprovedReceiptShouldSayApproved() throws {
        try XCTSkipIf(true, "Divergência preexistente do contrato §2: comprovante compara approve, mas recebe approved. Correção móvel separada.")
        let order = try decode(objectFixture("motor-builtin-approved"))
        let receipt = ServiceOrderReceiptData.of(order, header: "Área", now: Date(timeIntervalSince1970: 1_794_763_800))
        XCTAssertTrue(ServiceOrderReceiptText.footer(receipt).contains("Orçamento aprovado")) // Hoje imprime recusado.
    }

    func testSentQuoteHistoryShouldSaySent() throws {
        try XCTSkipIf(true, "Falha preexistente iOS: historyText trata todo kind=quote como salvo, inclusive analyzing -> quoted. Correção móvel separada.")
        let order = try decode(objectFixture("motor-builtin-quoted"))
        let history = try XCTUnwrap(order.history?.first)
        XCTAssertEqual(ServiceOrderRules.historyText(history), "Orçamento enviado") // Hoje mostra salvo.
    }
}
