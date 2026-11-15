import Foundation

/*
 Passagem feita por módulo e Suporte pago (docs/API.md "Passagem feita por módulo", docs/SUPORTE.md). O núcleo grava
 no detalhe da conversa o `handoff` de quem passou a conversa à equipe (resumo e marcadores, como "telefone não
 vinculado ao pagador X"); o Suporte expõe o estado da conversa e as ações do atendente: vincular o telefone ao
 pagador, confirmar e liberar, e liberar como cortesia. Só a equipe libera; "já paguei" do cliente nunca libera.
 */

/// `handoff` do detail da conversa: só para quem lê notas internas; some na próxima passagem sem módulo e ao encerrar.
struct ModuleHandoff: Codable, Equatable {
    var module: String?
    var summary: String?
    var flags: [String]?
    var at: Int64?

    var visibleFlags: [String] { (flags ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    var hasContent: Bool { !(summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !visibleFlags.isEmpty }
}

struct SuporteRelease: Codable, Equatable {
    var id: String?
    var payerId: String?
    var payerName: String?
    var kind: String?
    var kindLabel: String?
    var phoneLinked: Bool?
    var validUntil: Int64?
    var untilTicket: Bool?
    var reason: String?
    var status: String?
}

struct SuporteSession: Codable, Equatable {
    var status: String?
    var step: String?
    var payerId: String?
    var name: String?
    var phoneLinked: Bool?
}

struct SuporteUnlinked: Codable, Equatable {
    var payerId: String?
    var payerName: String?
}

/// `GET /suporte/conversations/{id}`.
struct SuporteStatus: Codable, Equatable {
    var conversationId: String?
    var phone: String?
    var allowed: Bool?
    /// `released`, `subscription`, `payment_required`, `module_disabled`…
    var reason: String?
    var release: SuporteRelease?
    var session: SuporteSession?
    var awaitingTeam: Bool?
    var unlinkedPhone: SuporteUnlinked?
}

final class SuporteClient {
    let api: ProfileAPI
    init(api: ProfileAPI) { self.api = api }

    func status(_ conversationId: String) async throws -> SuporteStatus { try await api.get("suporte/conversations/\(conversationId)") }

    /// Autoriza o telefone da conversa no pagador identificado ("Vincular ao pagador").
    func linkPhone(_ conversationId: String, key: String) async throws -> SuporteStatus {
        try await api.send("POST", "suporte/conversations/\(conversationId)/link-phone", [:], key: key)
    }

    /// Modo "só telefone vinculado": a equipe confirma (e vincula) e libera.
    func confirm(_ conversationId: String, link: Bool, key: String) async throws -> SuporteRelease {
        try await api.send("POST", "suporte/conversations/\(conversationId)/confirm", ["link": link], key: key)
    }

    /// Libera sem pagamento, com motivo; `hours` nil vale até o protocolo fechar.
    func courtesy(_ conversationId: String, reason: String, hours: Int?, key: String) async throws -> SuporteRelease {
        try await api.send("POST", "suporte/conversations/\(conversationId)/courtesy", ["reason": reason, "hours": hours], key: key)
    }
}

/// Regras da faixa da passagem e das ações do Suporte, sem tela, para testar.
enum SuporteRules {
    static func moduleName(_ module: String?) -> String {
        switch module {
        case "suporte": return "Suporte pago"
        case "mensalidade": return "Mensalidade"
        case "pedido": return "Pedido"
        case "agenda": return "Agenda"
        case "os": return "Ordem de serviço"
        case "reserva": return "Reserva"
        case let m?: return m.prefix(1).uppercased() + m.dropFirst()
        default: return "Módulo"
        }
    }

    /// A situação do suporte numa linha, para as informações da conversa.
    static func statusText(_ s: SuporteStatus) -> String {
        if s.awaitingTeam == true { return "Aguardando a equipe confirmar e liberar" }
        if let r = s.release, r.status == nil || r.status == "active" {
            var parts = [r.kindLabel ?? "Liberado"]
            if let name = r.payerName, !name.isEmpty { parts.append(name) }
            if let until = r.validUntil { parts.append("até \(BrasiliaTime.shortWithTime(until))") } else if r.untilTicket == true { parts.append("até o protocolo fechar") }
            return parts.joined(separator: " · ")
        }
        switch s.reason {
        case "subscription": return "Assinatura em dia"
        case "released": return "Liberado"
        case "payment_required": return "Sem liberação: pagamento pendente"
        case "module_disabled": return "Suporte pago desligado"
        default: return s.allowed == true ? "Liberado" : "Sem liberação"
        }
    }

    static func canLink(_ s: SuporteStatus?) -> Bool { s?.unlinkedPhone?.payerId != nil }
    static func canConfirm(_ s: SuporteStatus?) -> Bool { s?.awaitingTeam == true }
    /// Cortesia quando o cliente ainda não está liberado (ou aguarda a equipe).
    static func canCourtesy(_ s: SuporteStatus?) -> Bool { guard let s else { return false }; return s.allowed != true || s.awaitingTeam == true }

    static func linkTitle(_ s: SuporteStatus?) -> String {
        let name = s?.unlinkedPhone?.payerName?.trimmingCharacters(in: .whitespaces) ?? ""
        return name.isEmpty ? "Vincular telefone ao pagador" : "Vincular telefone a \(name)"
    }

    /// Validades da cortesia: até o protocolo fechar (nil) ou por horas.
    static let courtesyOptions: [(hours: Int?, title: String)] = [(nil, "Até o protocolo fechar"), (24, "24 horas"), (72, "3 dias"), (168, "7 dias")]
}
