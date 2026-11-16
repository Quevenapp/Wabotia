import Foundation

/// Ações pelo bot na conversa interna, na demonstração (docs/API.md, "Ações pelo bot na conversa interna"): na conversa
/// com o bot Vendas há uma proposta (mudar a OS nº 12 para Pronta), uma proposta sensível (dispensar uma parcela, que
/// pede o código do autenticador: na demonstração, 123456), um pedido de aprovação de desconto pendente e um já
/// decidido por Ana. Pedir ao bot algo com "OS" ou "parcela" gera outra proposta. Tudo em memória.
final class DemoBotActions {
    typealias Row = [String: Any]

    static let chatId = "ic_vendas"
    static let bot = "bot:b_vendas"
    static let mfaCode = "123456"

    private var proposals: [String: Row] = [:]
    private var approvals: [String: Row] = [:]
    /// As mensagens estruturadas da conversa (o payload é montado na leitura, sempre atual).
    private var messages: [Row] = []
    private var mfaVerified = false
    private var seq = 0
    private let me = DemoMode.meId

    init(t0: Int64) {
        let minute: Int64 = 60_000
        addProposal("pr_os12", summary: "Mudar a OS nº 12 para Pronta", operation: "os.status", operationSummary: "Mudar o estado da ordem de serviço",
                    module: "os", params: ["ordem": "nº 12", "status": "ready"], sensitive: false, at: t0 - minute, request: "Marque a OS nº 12 como pronta.")
        addProposal("pr_parcela", summary: "Dispensar a parcela de dezembro de Escola Exemplo", operation: "mensalidade.waive",
                    operationSummary: "Dispensar uma parcela da mensalidade", module: "mensalidade",
                    params: ["parcela": "dezembro", "pagador": "Escola Exemplo", "valor": "R$ 99,00"], sensitive: true, at: t0 - minute / 2,
                    request: "Dispensa a parcela de dezembro da Escola Exemplo, eles pagaram em dinheiro.")
        approvals["ap_128"] = ["id": "ap_128", "module_id": "pedido", "kind": "desconto", "ref_id": "pd_128", "conversation_id": "c_rich",
                               "title": "Desconto de 10% no pedido nº 128 de Mariana Costa", "status": "pending",
                               "fields": [["key": "items", "label": "Itens", "value": "2× X-Burger, 1× Suco natural"],
                                          ["key": "total", "label": "Total de tabela", "value": "R$ 62,00"],
                                          ["key": "asked", "label": "O cliente pediu", "value": "10% de desconto (R$ 6,20)"],
                                          ["key": "history", "label": "Últimas compras", "value": "4 pedidos em 30 dias (R$ 231,00)"]] as [Row],
                               "hidden_fields": 1, "model_summary": "Cliente frequente; diz que o concorrente cobra menos.",
                               "adjust": ["label": "Desconto concedido (R$)", "type": "money", "min": 0, "max": 6.2] as Row,
                               "can_decide": true, "value": NSNull(), "reason": NSNull(), "decided_by": NSNull(), "decided_at": NSNull(),
                               "expires_at": t0 + 25 * minute, "created": t0 - 2 * minute]
        approvals["ap_120"] = ["id": "ap_120", "module_id": "mensalidade", "kind": "dispensa", "ref_id": "mi_4", "conversation_id": "c_rich",
                               "title": "Dispensar a multa de atraso de Escola Exemplo", "status": "approved",
                               "fields": [["key": "fine", "label": "Multa", "value": "R$ 9,90"]] as [Row], "hidden_fields": 0,
                               "model_summary": "Atraso de um dia por feriado bancário.", "adjust": NSNull(), "can_decide": true,
                               "value": NSNull(), "reason": "Feriado bancário", "decided_by": ["id": "u_ana", "name": "Ana Souza"] as Row,
                               "decided_at": t0 - 50 * minute, "expires_at": t0 - 30 * minute, "created": t0 - 60 * minute]
        messages.append(structured("approval", id: "ap_120", text: "Pedido de aprovação: Dispensar a multa de atraso de Escola Exemplo. Decida no painel ou no app atualizado.", at: t0 - 60 * minute))
        messages.append(structured("approval", id: "ap_128", text: "Pedido de aprovação: Desconto de 10% no pedido nº 128 de Mariana Costa. Decida no painel ou no app atualizado.", at: t0 - 2 * minute))
    }

    // MARK: - Leitura

    /// As mensagens estruturadas desta conversa, com o payload atual.
    func rows(chatId: String, now: Int64) -> [Row] {
        guard chatId == Self.chatId else { return [] }
        return messages.map { message in
            var row = message
            let ref = message["ref"] as? String ?? ""
            switch message["kind"] as? String {
            case "proposal", "result":
                if var p = proposals[ref] {
                    p["status"] = status(of: p, now: now)
                    row["payload"] = ["operation_summary": p["operation_summary"] ?? NSNull(), "module": p["module"] ?? NSNull(),
                                      "actions": ["confirm", "cancel"], "proposal": p.filter { $0.key != "operation_summary" && $0.key != "module" }] as Row
                }
            case "approval":
                if var a = approvals[ref] {
                    a["status"] = approvalStatus(a, now: now)
                    row["payload"] = ["approval": a] as Row
                }
            default: break
            }
            row["ref"] = nil
            return row
        }
    }

    private func status(of p: Row, now: Int64) -> String {
        let s = p["status"] as? String ?? "pending"
        if s == "pending", let e = p["expires_at"] as? Int64, now >= e { return "expired" }
        return s
    }

    private func approvalStatus(_ a: Row, now: Int64) -> String {
        let s = a["status"] as? String ?? "pending"
        if s == "pending", let e = a["expires_at"] as? Int64, now >= e { return "expired" }
        return s
    }

    // MARK: - Rotas

    /// Segundo fator na demonstração: começa sem fator (Ajustes → Segurança mostra o cadastro); o código é sempre 123456.
    private(set) var hasFactor = false
    var aal: Int { mfaVerified ? 2 : 1 }
    var mfaState: Row { ["policy": "off", "factor": hasFactor, "next": NSNull()] }

    private func recoveryCodes() -> [String] {
        (1...10).map { i in String(format: "DEMO-%04d-%04d", (i * 7919) % 10_000, (i * 104_729) % 10_000) }
    }

    func route(method: String, parts: [String], body: Row, query: [String: String], now: Int64) -> DemoServer.Reply? {
        if parts.count >= 4, Array(parts.prefix(4)) == ["api", "v1", "account", "mfa"] {
            let rest = Array(parts.dropFirst(4))
            if method == "GET", rest.isEmpty { return ok(["aal": aal, "mfa": mfaState]) }
            if method == "POST", rest == ["enroll"] {
                guard (body["password"] as? String)?.isEmpty == false else { return fail(400, "invalid", "Digite a sua senha.") }
                if hasFactor, !mfaVerified { return fail(403, "mfa_required", "Confirme que é você para trocar o fator.") }
                let secret = "JBSWY3DPEHPK3PXP"
                return ok(["factor_id": "fa_demo", "secret": secret,
                           "otpauth_url": "otpauth://totp/Wabotia%20(demonstra%C3%A7%C3%A3o):\(DemoMode.meEmail)?secret=\(secret)&issuer=Wabotia"])
            }
            if method == "POST", rest == ["verify"] {
                guard body["code"] as? String == Self.mfaCode else { return fail(401, "invalid_code", "Código incorreto. Na demonstração, use \(Self.mfaCode).") }
                hasFactor = true
                mfaVerified = true
                return ok(["aal": 2, "recovery_codes": recoveryCodes()])
            }
            if method == "POST", rest == ["recovery-codes"] {
                guard mfaVerified else { return fail(403, "mfa_required", "Confirme que é você.") }
                return ok(["aal": 2, "recovery_codes": Array(recoveryCodes().reversed())])
            }
        }
        // POST /api/v1/account/mfa/challenge {code | recovery_code}
        if method == "POST", parts == ["api", "v1", "account", "mfa", "challenge"] {
            let code = (body["code"] as? String) ?? (body["recovery_code"] as? String) ?? ""
            guard code == Self.mfaCode || (body["recovery_code"] as? String)?.count ?? 0 >= 8 else {
                return fail(400, "invalid_code", "Código incorreto. Na demonstração, use \(Self.mfaCode).")
            }
            mfaVerified = true
            return ok(["aal": "aal2", "expires_at": now + 15 * 60_000])
        }
        guard parts.count >= 5, Array(parts.prefix(3)) == ["api", "v1", "profiles"] else { return nil }
        let rest = Array(parts.dropFirst(4))
        // POST …/internal-chats/{chat}/proposals/{id}/confirm|cancel
        if method == "POST", rest.count == 5, rest[0] == "internal-chats", rest[2] == "proposals", ["confirm", "cancel"].contains(rest[4]) {
            return decideProposal(rest[3], confirm: rest[4] == "confirm", now: now)
        }
        if method == "GET", rest == ["approvals"] {
            let status = query["status"]
            let list = approvals.values.map { a -> Row in var a = a; a["status"] = approvalStatus(a, now: now); return a }
                .filter { status == nil || status == "" || ($0["status"] as? String) == status }
                .sorted { ($0["created"] as? Int64 ?? 0) > ($1["created"] as? Int64 ?? 0) }
            return ok(["data": list])
        }
        if method == "GET", rest.count == 2, rest[0] == "approvals" {
            guard var a = approvals[rest[1]] else { return fail(404, "not_found", "Pedido não encontrado.") }
            a["status"] = approvalStatus(a, now: now)
            return ok(a)
        }
        if method == "POST", rest.count == 3, rest[0] == "approvals", rest[2] == "decide" {
            return decide(rest[1], body: body, now: now)
        }
        return nil
    }

    /// A pessoa escreveu ao bot: com "OS"/"ordem" ou "parcela", ele responde com uma proposta. `true` quando respondeu.
    func respond(chatId: String, text: String, now: Int64) -> Bool {
        guard chatId == Self.chatId else { return false }
        let t = text.lowercased()
        seq += 1
        if t.contains("parcela") {
            addProposal("pr_n\(seq)", summary: "Dispensar a parcela de dezembro de Escola Exemplo", operation: "mensalidade.waive",
                        operationSummary: "Dispensar uma parcela da mensalidade", module: "mensalidade", params: ["parcela": "dezembro", "pagador": "Escola Exemplo"],
                        sensitive: true, at: now + 1500, request: nil)
            return true
        }
        if t.contains("os ") || t.contains(" os") || t.contains("ordem") {
            addProposal("pr_n\(seq)", summary: "Mudar a OS nº 12 para Pronta", operation: "os.status", operationSummary: "Mudar o estado da ordem de serviço",
                        module: "os", params: ["ordem": "nº 12", "status": "ready"], sensitive: false, at: now + 1500, request: nil)
            return true
        }
        return false
    }

    // MARK: - Decisões

    private func decideProposal(_ id: String, confirm: Bool, now: Int64) -> DemoServer.Reply {
        guard var p = proposals[id] else { return fail(404, "not_found", "Proposta não encontrada.") }
        switch status(of: p, now: now) {
        case "expired": return fail(409, "proposal_expired", "A proposta venceu. Peça de novo ao bot.")
        case "cancelled": return fail(409, "proposal_cancelled", "A proposta já foi cancelada.")
        case "pending": break
        default:
            // Confirmar de novo devolve o mesmo resultado, sem rodar outra vez.
            if confirm { return ok(view(p)) }
            return fail(409, "proposal_closed", "A proposta já foi confirmada.")
        }
        if confirm, p["sensitive"] as? Bool == true, !mfaVerified {
            return fail(403, "mfa_required", "Esta ação pede o código do autenticador.")
        }
        p["status"] = confirm ? "done" : "cancelled"
        p["decided_at"] = now
        if confirm {
            p["result"] = ["message": (p["operation"] as? String) == "os.status" ? "A OS nº 12 agora está Pronta." : "A parcela de dezembro foi dispensada."] as Row
        }
        proposals[id] = p
        let summary = p["summary"] as? String ?? ""
        messages.append(structured("result", id: id, text: confirm ? "Feito: \(summary)." : "Cancelada: \(summary).", at: now + 500))
        return ok(view(p))
    }

    private func decide(_ id: String, body: Row, now: Int64) -> DemoServer.Reply {
        guard var a = approvals[id] else { return fail(404, "not_found", "Pedido não encontrado.") }
        let decision = body["decision"] as? String ?? ""
        guard ["approve", "decline", "handoff"].contains(decision) else { return fail(400, "invalid", "decision: approve, decline ou handoff.") }
        switch approvalStatus(a, now: now) {
        case "pending": break
        case "expired": return fail(409, "approval_expired", "O prazo deste pedido venceu.")
        default:
            // A mesma pessoa repetindo a mesma decisão recebe o mesmo resultado; outra decisão, o pedido já decidido.
            if (a["decided_by"] as? Row)?["id"] as? String == me, a["status"] as? String == ["approve": "approved", "decline": "declined", "handoff": "handoff"][decision] { return ok(a) }
            return fail(409, "approval_closed", "Outra pessoa já decidiu este pedido.")
        }
        if decision == "approve", let value = body["value"] as? Double {
            let adjust = a["adjust"] as? Row
            if let min = adjust?["min"] as? Double, value < min { return fail(400, "invalid", "Ajuste abaixo do mínimo.") }
            if let max = adjust?["max"] as? Double, value > max { return fail(400, "invalid", "Ajuste acima do máximo.") }
            a["value"] = value
        }
        if decision == "decline", let reason = body["reason"] as? String, !reason.isEmpty { a["reason"] = reason }
        a["status"] = ["approve": "approved", "decline": "declined", "handoff": "handoff"][decision]
        a["decided_by"] = ["id": me, "name": DemoMode.meName] as Row
        a["decided_at"] = now
        approvals[id] = a
        return ok(a)
    }

    // MARK: - Apoio

    private func addProposal(_ id: String, summary: String, operation: String, operationSummary: String, module: String, params: Row,
                             sensitive: Bool, at: Int64, request: String?) {
        if let request {
            messages.append(["id": "im_req_\(id)", "author": me, "text": request, "created": at - 20_000, "status": "completed", "run_id": NSNull(), "kind": "text", "payload": NSNull()])
        }
        proposals[id] = ["id": id, "status": "pending", "operation": operation, "summary": summary, "params": params, "sensitive": sensitive,
                         "expires_at": at + 10 * 60_000, "decided_at": NSNull(), "result": NSNull(), "error": NSNull(), "bot_id": "b_vendas",
                         "chat_id": Self.chatId, "created": at, "operation_summary": operationSummary, "module": module]
        let text = "Proposta do bot: \(summary)\nOperação: \(operationSummary)\nConfirme no painel ou no app atualizado (vale 10 minutos)."
        messages.append(structured("proposal", id: id, text: text, at: at))
    }

    private func structured(_ kind: String, id: String, text: String, at: Int64) -> Row {
        ["id": "\(kind):\(id)", "author": Self.bot, "text": text, "created": at, "status": "sent", "run_id": NSNull(), "kind": kind, "payload": NSNull(), "ref": id]
    }

    private func view(_ p: Row) -> Row { p.filter { $0.key != "operation_summary" && $0.key != "module" } }

    private func ok(_ value: Any) -> DemoServer.Reply { DemoServer.Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
    private func fail(_ status: Int, _ code: String, _ message: String) -> DemoServer.Reply {
        DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
    }
}
