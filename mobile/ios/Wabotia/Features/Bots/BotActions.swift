import Foundation

// Ações pelo bot na conversa interna (docs/API.md, "Ações pelo bot na conversa interna", `feat/bot-acoes`): a pessoa
// pede em linguagem natural; o bot consulta direto e, para escrever, propõe (`kind: proposal`), e só a pessoa confirma.
// O resultado vem em `kind: result`. Pedidos de clientes que precisam da equipe (desconto, dispensa de parcela) vêm em
// `kind: approval`. Toda mensagem traz `text` de reserva: tipo desconhecido aparece como texto.

/// Proposta do bot (`payload.proposal`), sempre atual na leitura.
struct BotProposal: Codable, Equatable, Identifiable {
    var id: String
    /// `pending`, `running`, `done`, `failed`, `cancelled`, `expired`.
    var status: String
    var operation: String?
    var summary: String?
    var params: [String: JSONValue]?
    var sensitive: Bool?
    var expires_at: Int64?
    var decided_at: Int64?
    var result: JSONValue?
    var error: JSONValue?
    var bot_id: String?
    var chat_id: String?
    var created: Int64?

    /// Ainda dá para confirmar ou cancelar (o servidor confere o prazo de novo).
    func actionable(now: Int64) -> Bool { status == "pending" && (expires_at.map { now < $0 } ?? true) }

    /// O estado como a pessoa lê, já contando o prazo vencido no aparelho.
    func statusText(now: Int64) -> String {
        if status == "pending", let e = expires_at, now >= e { return "Venceu" }
        switch status {
        case "pending": return "Aguardando você"
        case "running": return "Executando…"
        case "done": return "Feito"
        case "failed": return "Não foi possível"
        case "cancelled": return "Cancelada"
        case "expired": return "Venceu"
        default: return status
        }
    }

    /// "vence em 7 min".
    func expiryText(now: Int64) -> String? {
        guard status == "pending", let e = expires_at, now < e else { return nil }
        let minutes = Int(((Double(e - now)) / 60_000).rounded(.up))
        return minutes <= 1 ? "vence em menos de 1 min" : "vence em \(minutes) min"
    }

    /// O que foi feito ou o erro, como texto.
    var outcomeText: String? {
        if let e = error { return BotActionText.describe(e) }
        if let r = result { return BotActionText.describe(r) }
        return nil
    }
}

/// Campo do pedido de aprovação, montado pelo módulo com dados lidos por código.
struct ApprovalField: Codable, Equatable, Identifiable {
    var key: String?
    var label: String?
    var value: JSONValue?
    var id: String { key ?? label ?? UUID().uuidString }
}

/// O ajuste que a pessoa pode dar ao aprovar (`adjust`).
struct ApprovalAdjust: Codable, Equatable {
    var label: String?
    /// `money`, `percent`, `number`…
    var type: String?
    var min: Double?
    var max: Double?
}

/// Pedido de aprovação (`payload.approval` ou `GET …/approvals/{id}`), já filtrado para quem lê.
struct BotApproval: Codable, Equatable, Identifiable {
    var id: String
    var module_id: String?
    var kind: String?
    var ref_id: String?
    var conversation_id: String?
    var title: String?
    /// `pending`, `deciding`, `approved`, `declined`, `handoff`, `expired`.
    var status: String
    var fields: [ApprovalField]?
    var hidden_fields: Int?
    var model_summary: String?
    var adjust: ApprovalAdjust?
    var can_decide: Bool?
    var value: Double?
    var reason: String?
    var decided_by: JSONValue?
    var decided_at: Int64?
    var expires_at: Int64?
    var created: Int64?

    func decidable(now: Int64) -> Bool { status == "pending" && can_decide == true && (expires_at.map { now < $0 } ?? true) }

    func statusText(now: Int64) -> String {
        if status == "pending", let e = expires_at, now >= e { return "Venceu" }
        switch status {
        case "pending": return "Aguardando a equipe"
        case "deciding": return "Em decisão"
        case "approved": return "Aprovado"
        case "declined": return "Recusado"
        case "handoff": return "Conversa assumida"
        case "expired": return "Venceu"
        default: return status
        }
    }

    /// Quem decidiu: o nome (objeto `{id, name}` ou texto).
    var decidedByName: String? {
        if let name = decided_by?.objectValue?["name"]?.stringValue { return name }
        return decided_by?.stringValue
    }
}

/// O que vem em `payload` de uma mensagem da conversa interna.
struct InternalPayload: Codable, Equatable {
    var operation_summary: String?
    var module: String?
    var actions: [String]?
    var proposal: BotProposal?
    var approval: BotApproval?
}

extension InternalMessage {
    /// O cartão a desenhar; `nil` = texto (tipos que o app não conhece também).
    enum Card: Equatable {
        case proposal(BotProposal, operationSummary: String?)
        case result(BotProposal)
        case approval(BotApproval)
    }

    var card: Card? {
        switch kind {
        case "proposal": return payload?.proposal.map { .proposal($0, operationSummary: payload?.operation_summary) }
        case "result": return payload?.proposal.map { .result($0) }
        case "approval": return payload?.approval.map { .approval($0) }
        default: return nil
        }
    }
}

enum BotActionText {
    /// Um valor de `result`/`error`/`fields[].value` em texto: o `message`/`summary` quando houver, senão o próprio valor.
    static func describe(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int64(n)) : String(n).replacingOccurrences(of: ".", with: ",")
        case .bool(let b): return b ? "sim" : "não"
        case .null: return "—"
        case .array(let list): return list.map(describe).joined(separator: ", ")
        case .object(let o):
            for key in ["message", "summary", "text", "label"] { if let s = o[key]?.stringValue { return s } }
            return o.keys.sorted().map { "\($0): \(describe(o[$0]!))" }.joined(separator: " · ")
        }
    }

    /// Os parâmetros da proposta, para a pessoa conferir.
    static func params(_ params: [String: JSONValue]?) -> [(String, String)] {
        (params ?? [:]).keys.sorted().map { ($0, describe(params![$0]!)) }
    }
}

// MARK: - Servidor

/// As rotas das ações pelo bot e das aprovações, isoladas para os testes.
@MainActor
protocol BotActionsAPI: AnyObject {
    func confirmProposal(chatId: String, proposalId: String, key: String) async throws -> BotProposal
    func cancelProposal(chatId: String, proposalId: String, key: String) async throws -> BotProposal
    func approval(_ id: String) async throws -> BotApproval
    func decide(_ id: String, decision: String, value: Double?, reason: String?, key: String) async throws -> BotApproval
}

/// O cliente de verdade, sobre o `APIClient` da sessão (só sessão de pessoa).
@MainActor
final class LiveBotActionsAPI: BotActionsAPI {
    let api: APIClient
    let profile: String
    init(api: APIClient, profile: String) { self.api = api; self.profile = profile }

    private var base: String { "api/v1/profiles/\(profile)" }

    func confirmProposal(chatId: String, proposalId: String, key: String) async throws -> BotProposal {
        try await api.request(.post, "\(base)/internal-chats/\(chatId)/proposals/\(proposalId)/confirm", body: [String: String](), key: key)
    }

    func cancelProposal(chatId: String, proposalId: String, key: String) async throws -> BotProposal {
        try await api.request(.post, "\(base)/internal-chats/\(chatId)/proposals/\(proposalId)/cancel", body: [String: String](), key: key)
    }

    func approval(_ id: String) async throws -> BotApproval { try await api.request(.get, "\(base)/approvals/\(id)") }

    func decide(_ id: String, decision: String, value: Double?, reason: String?, key: String) async throws -> BotApproval {
        var body: [String: JSONValue] = ["decision": .string(decision)]
        if let value { body["value"] = .number(value) }
        if let reason, !reason.isEmpty { body["reason"] = .string(reason) }
        return try await api.request(.post, "\(base)/approvals/\(id)/decide", body: body, key: key)
    }
}

/// O que a tela faz depois de um toque.
enum BotActionOutcome: Equatable {
    case proposal(BotProposal)
    case approval(BotApproval)
    /// 409 `proposal_expired`/`approval_expired`: mostra "Venceu".
    case expired
    /// 409 `proposal_cancelled`/`proposal_closed`/`approval_closed`: recarrega (o cartão mostra quem decidiu).
    case reload(String?)
    /// 404: some com os botões.
    case gone
    /// 403 `mfa_required`: pede o código do autenticador e repete o toque.
    case needsSecondFactor
    case failed(String)
}

/// Confirmar, cancelar e decidir, com as recusas do contrato traduzidas.
@MainActor
struct BotActions {
    let api: BotActionsAPI

    func confirm(chatId: String, _ p: BotProposal) async -> BotActionOutcome {
        await run { try await api.confirmProposal(chatId: chatId, proposalId: p.id, key: "confirm:\(p.id)") }
    }

    func cancel(chatId: String, _ p: BotProposal) async -> BotActionOutcome {
        await run { try await api.cancelProposal(chatId: chatId, proposalId: p.id, key: "cancel:\(p.id)") }
    }

    /// `decision`: `approve`, `decline` ou `handoff`. A chave repete a mesma decisão sem decidir duas vezes.
    func decide(_ a: BotApproval, decision: String, value: Double? = nil, reason: String? = nil) async -> BotActionOutcome {
        do {
            return .approval(try await api.decide(a.id, decision: decision, value: value, reason: reason, key: "decide:\(a.id):\(decision)"))
        } catch {
            let outcome = Self.map(error)
            // Outra pessoa decidiu antes: o cartão relido mostra quem foi.
            if case .reload = outcome, let fresh = try? await api.approval(a.id) { return .approval(fresh) }
            if case .expired = outcome, let fresh = try? await api.approval(a.id) { return .approval(fresh) }
            return outcome
        }
    }

    private func run(_ call: () async throws -> BotProposal) async -> BotActionOutcome {
        do { return .proposal(try await call()) } catch { return Self.map(error) }
    }

    nonisolated static func map(_ error: Error) -> BotActionOutcome {
        guard let e = error as? APIError else { return .failed(APIError.describe(error)) }
        switch (e.status, e.code) {
        case (403, "mfa_required"): return .needsSecondFactor
        case (409, "proposal_expired"), (409, "approval_expired"): return .expired
        case (409, "proposal_cancelled"), (409, "proposal_closed"), (409, "approval_closed"): return .reload(e.message)
        case (404, _): return .gone
        default: return .failed(e.message)
        }
    }
}
