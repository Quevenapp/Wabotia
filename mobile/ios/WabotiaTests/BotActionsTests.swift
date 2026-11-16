import XCTest
@testable import Wabotia

/// Ações pelo bot na conversa interna e pedidos de aprovação (docs/API.md, `feat/bot-acoes`).
final class BotActionsModelTests: XCTestCase {
    private func message(_ json: String) throws -> InternalMessage {
        try JSONDecoder.wabotia.decode(InternalMessage.self, from: Data(json.utf8))
    }

    func testProposalResultAndApprovalBecomeCardsAndUnknownKindsStayText() throws {
        let proposal = try message(#"""
        {"id":"proposal:5f0c","author":"bot:3a1e","kind":"proposal","created":1,"text":"Proposta do bot: Mudar a OS nº 12 para Pronta",
         "payload":{"operation_summary":"Mudar o estado da ordem de serviço","module":"os","actions":["confirm","cancel"],
                    "proposal":{"id":"5f0c","status":"pending","operation":"os.status","summary":"Mudar a OS nº 12 para Pronta",
                                "params":{"id":"os_12","status":"ready"},"sensitive":false,"expires_at":1794840000000,"decided_at":null,
                                "result":null,"error":null,"bot_id":"3a1e","chat_id":"ic","created":1794839400000}}}
        """#)
        guard case let .proposal(p, operationSummary)? = proposal.card else { return XCTFail("cartão de proposta") }
        XCTAssertEqual(p.summary, "Mudar a OS nº 12 para Pronta")
        XCTAssertEqual(operationSummary, "Mudar o estado da ordem de serviço")
        XCTAssertEqual(BotActionText.params(p.params).map(\.0), ["id", "status"])

        let unknown = try message(#"{"id":"m","author":"bot:1","kind":"poll","created":1,"text":"Enquete: escolha uma opção","payload":{"options":[1,2]}}"#)
        XCTAssertNil(unknown.card, "tipo novo aparece como o texto de reserva")
        XCTAssertEqual(unknown.text, "Enquete: escolha uma opção")
        let broken = try message(#"{"id":"m2","author":"bot:1","kind":"proposal","created":1,"text":"Proposta do bot: …","payload":{"proposal":"???"}}"#)
        XCTAssertNil(broken.card, "payload que o app não entende não derruba a conversa")
        let old = try message(#"{"id":"m3","author":"u_1","text":"Oi","created":1,"status":"sent","run_id":null}"#)
        XCTAssertNil(old.card)
    }

    func testServerDescriptionIsWhatCountsAndTheBotTextStaysApart() throws {
        let m = try message(#"""
        {"id":"proposal:1","author":"bot:1","kind":"proposal","created":1,"text":"Proposta do bot:\nMudar o estado da ordem de serviço",
         "payload":{"operation_summary":"Mudar o estado da ordem de serviço","proposal":{"id":"1","status":"pending",
         "description":"Mudar o estado da ordem de serviço\n• id: os_12\n• status: ready","summary":"Dar 90% de desconto (o bot inventou)",
         "params":{"id":"os_12","status":"ready"}}}}
        """#)
        guard case let .proposal(p, op)? = m.card else { return XCTFail() }
        XCTAssertTrue(p.hasServerDescription)
        XCTAssertEqual(p.headline(operationSummary: op), "Mudar o estado da ordem de serviço", "o título vem do servidor, nunca do texto do bot")
        XCTAssertEqual(p.summary, "Dar 90% de desconto (o bot inventou)", "o texto do bot só à parte")
        let old = BotProposal(id: "2", status: "done", summary: "Texto do bot")
        XCTAssertFalse(old.hasServerDescription, "proposta antiga: mostra os parâmetros")
        XCTAssertEqual(old.headline(operationSummary: "Mudar o estado"), "Mudar o estado")
        XCTAssertEqual(BotProposal(id: "3", status: "done").headline(operationSummary: nil), "Ação proposta pelo bot")
    }

    func testDecidingIsTransient() {
        let a = BotApproval(id: "a", status: "deciding", can_decide: true)
        XCTAssertTrue(a.deciding)
        XCTAssertFalse(a.decidable(now: 0), "em decisão: sem botões, o cartão espera e relê")
        XCTAssertEqual(a.statusText(now: 0), "Em decisão")
    }

    func testProposalDeadlineAndStatus() {
        let p = BotProposal(id: "p", status: "pending", expires_at: 10 * 60_000)
        XCTAssertTrue(p.actionable(now: 0))
        XCTAssertEqual(p.expiryText(now: 3 * 60_000), "vence em 7 min")
        XCTAssertEqual(p.statusText(now: 10 * 60_000), "Venceu", "venceu no aparelho antes da próxima leitura")
        XCTAssertFalse(p.actionable(now: 10 * 60_000))
        var failed = p
        failed.status = "failed"
        failed.error = .object(["message": .string("A OS já está entregue.")])
        XCTAssertEqual(failed.outcomeText, "A OS já está entregue.")
        XCTAssertEqual(failed.statusText(now: 0), "Não foi possível")
    }

    func testApprovalShowsWhoDecided() throws {
        let a = try JSONDecoder.wabotia.decode(BotApproval.self, from: Data(#"""
        {"id":"ap","title":"Desconto","status":"approved","fields":[{"key":"total","label":"Total de tabela","value":"R$ 62,00"}],"hidden_fields":1,
         "model_summary":"Cliente frequente","adjust":{"label":"Desconto (R$)","type":"money","min":0,"max":6.2},"can_decide":true,
         "value":5,"reason":null,"decided_by":{"id":"u_ana","name":"Ana Souza"},"decided_at":1,"expires_at":2,"created":0}
        """#.utf8))
        XCTAssertEqual(a.decidedByName, "Ana Souza")
        XCTAssertFalse(a.decidable(now: 0), "decidido: sem botões")
        XCTAssertEqual(a.statusText(now: 0), "Aprovado")
        XCTAssertEqual(a.adjust?.max, 6.2)
    }

    func testContractRefusalsBecomeWhatTheScreenDoes() {
        XCTAssertEqual(BotActions.map(APIError(status: 403, code: "mfa_required", message: "")), .needsSecondFactor)
        XCTAssertEqual(BotActions.map(APIError(status: 409, code: "proposal_expired", message: "")), .expired)
        XCTAssertEqual(BotActions.map(APIError(status: 409, code: "proposal_closed", message: "x")), .reload("x"))
        XCTAssertEqual(BotActions.map(APIError(status: 409, code: "approval_closed", message: "y")), .reload("y"))
        XCTAssertEqual(BotActions.map(APIError(status: 404, code: "not_found", message: "")), .gone)
        XCTAssertEqual(BotActions.map(APIError(status: 403, code: "approval_forbidden", message: "Sem permissão")), .failed("Sem permissão"))
    }
}

@MainActor
final class FakeBotActionsAPI: BotActionsAPI {
    var stored = BotApproval(id: "ap", status: "pending", can_decide: true)
    var closeOnDecide = false
    var keys: [String] = []
    func confirmProposal(chatId: String, proposalId: String, key: String) async throws -> BotProposal {
        keys.append(key)
        return BotProposal(id: proposalId, status: "done")
    }
    func cancelProposal(chatId: String, proposalId: String, key: String) async throws -> BotProposal { BotProposal(id: proposalId, status: "cancelled") }
    func approval(_ id: String) async throws -> BotApproval { stored }
    func decide(_ id: String, decision: String, value: Double?, reason: String?, key: String) async throws -> BotApproval {
        keys.append(key)
        if closeOnDecide { throw APIError(status: 409, code: "approval_closed", message: "Outra pessoa já decidiu.") }
        stored.status = decision == "approve" ? "approved" : decision
        stored.value = value
        return stored
    }
}

@MainActor
final class BotActionsFlowTests: XCTestCase {
    func testFirstToDecideWinsAndTheOthersSeeWho() async {
        let api = FakeBotActionsAPI()
        api.closeOnDecide = true
        api.stored = BotApproval(id: "ap", status: "approved", can_decide: true, decided_by: .object(["id": .string("u_ana"), "name": .string("Ana Souza")]))
        let outcome = await BotActions(api: api).decide(BotApproval(id: "ap", status: "pending", can_decide: true), decision: "approve", value: 3)
        guard case .approval(let fresh) = outcome else { return XCTFail("relê o pedido") }
        XCTAssertEqual(fresh.decidedByName, "Ana Souza")
        XCTAssertEqual(api.keys, ["decide:ap:approve"], "a mesma decisão repete a mesma chave")
    }

    func testEveryConfirmAttemptUsesANewKey() async {
        let api = FakeBotActionsAPI()
        let actions = BotActions(api: api)
        let outcome = await actions.confirm(chatId: "ic", BotProposal(id: "p1", status: "pending"))
        XCTAssertEqual(outcome, .proposal(BotProposal(id: "p1", status: "done")))
        _ = await actions.confirm(chatId: "ic", BotProposal(id: "p1", status: "pending"))
        XCTAssertEqual(api.keys.count, 2)
        XCTAssertTrue(api.keys.allSatisfy { $0.hasPrefix("confirm:p1:") })
        XCTAssertNotEqual(api.keys[0], api.keys[1], "a tentativa depois do 403 mfa_required não reaproveita a chave da recusada")
    }
}

/// A demonstração responde ao contrato: proposta, segundo fator, resultado e aprovação disputada.
final class DemoBotActionsTests: XCTestCase {
    private let base = "api/v1/profiles/\(DemoMode.profileId)"

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> (status: Int, json: [String: Any]) {
        var components = URLComponents(url: DemoMode.serverURL.appendingPathComponent(path.components(separatedBy: "?")[0]), resolvingAgainstBaseURL: false)!
        if let query = path.components(separatedBy: "?").dropFirst().first { components.query = query }
        let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let reply = DemoServer.queue.sync { DemoServer.shared.handle(method: method, url: components.url!, body: data) }
        return (reply.status, (try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any] ?? [:])
    }

    private func messages() throws -> [InternalMessage] {
        let (_, json) = call("GET", "\(base)/internal-chats/\(DemoBotActions.chatId)")
        let data = try JSONSerialization.data(withJSONObject: json["messages"] ?? [])
        return try JSONDecoder.wabotia.decode([InternalMessage].self, from: data)
    }

    func testTheChatWithTheBotShowsTheCards() throws {
        let cards = try messages().compactMap(\.card)
        XCTAssertTrue(cards.contains { if case .proposal(let p, _) = $0 { return p.id == "pr_os12" && p.status == "pending" }; return false })
        XCTAssertTrue(cards.contains { if case .proposal(let p, _) = $0 { return p.sensitive == true }; return false })
        XCTAssertTrue(cards.contains { if case .approval(let a) = $0 { return a.id == "ap_128" && a.can_decide == true }; return false })
        XCTAssertTrue(cards.contains { if case .approval(let a) = $0 { return a.decidedByName == "Ana Souza" }; return false })
    }

    func testConfirmingWritesTheResultAndSensitiveAsksTheSecondFactor() throws {
        XCTAssertEqual(call("POST", "\(base)/internal-chats/\(DemoBotActions.chatId)/proposals/pr_os12/confirm", [:]).status, 200)
        XCTAssertTrue(try messages().contains { if case .result(let p)? = $0.card { return p.id == "pr_os12" && p.status == "done" }; return false })
        let sensitive = call("POST", "\(base)/internal-chats/\(DemoBotActions.chatId)/proposals/pr_parcela/confirm", [:])
        XCTAssertEqual(sensitive.status, 403)
        XCTAssertEqual((sensitive.json["error"] as? [String: Any])?["code"] as? String, "mfa_required")
        XCTAssertEqual(call("POST", "api/v1/account/mfa/challenge", ["code": "000000"]).status, 400)
        XCTAssertEqual(call("POST", "api/v1/account/mfa/challenge", ["code": DemoBotActions.mfaCode]).status, 200)
        XCTAssertEqual(call("POST", "\(base)/internal-chats/\(DemoBotActions.chatId)/proposals/pr_parcela/confirm", [:]).json["status"] as? String, "done")
    }

    func testApprovalIsDecidedOnceAndAdjustHasLimits() {
        XCTAssertEqual(call("GET", "\(base)/approvals?status=pending").json["data"].map { ($0 as? [Any])?.count ?? 0 }, 1)
        XCTAssertEqual(call("POST", "\(base)/approvals/ap_128/decide", ["decision": "approve", "value": 9.0]).status, 400, "acima do máximo")
        let approved = call("POST", "\(base)/approvals/ap_128/decide", ["decision": "approve", "value": 5.0])
        XCTAssertEqual(approved.json["status"] as? String, "approved")
        XCTAssertEqual(call("POST", "\(base)/approvals/ap_128/decide", ["decision": "decline"]).status, 409, "o primeiro a decidir vence")
        XCTAssertEqual(call("POST", "\(base)/approvals/ap_128/decide", ["decision": "approve", "value": 5.0]).status, 200, "repetir a mesma decisão devolve o mesmo")
    }

    func testAskingTheBotCreatesAProposal() throws {
        XCTAssertEqual(call("POST", "\(base)/internal-chats/\(DemoBotActions.chatId)/messages", ["text": "Dispensa a parcela de março"]).status, 200)
        let proposals = try messages().compactMap { m -> BotProposal? in if case .proposal(let p, _)? = m.card { return p }; return nil }
        XCTAssertEqual(proposals.filter { $0.sensitive == true }.count, 2)
    }
}
