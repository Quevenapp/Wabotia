import SwiftUI
import UIKit

/// Auxiliares da área de protocolos (reaproveitados pela área de bots): datas curtas, rótulos,
/// cores de prazo e tratamento padrão de erros (401 → volta ao login).
enum TicketsSupport {
    // MARK: Datas (Unix em milissegundos → texto curto no fuso do aparelho)

    static func date(_ ms: Int64?) -> Date? {
        guard let ms else { return nil }
        return Date(timeIntervalSince1970: Double(ms) / 1000)
    }

    static func millis(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

    /// "Hoje 14:32", "Ontem 09:10", "Amanhã 08:00", "08/11 14:32" ou "08/11/2025 14:32".
    static func shortDate(_ ms: Int64?) -> String {
        guard let d = date(ms) else { return "" }
        return shortDate(d)
    }

    static func shortDate(_ d: Date) -> String {
        let calendar = Calendar.current
        let time = timeFormatter.string(from: d)
        if calendar.isDateInToday(d) { return "Hoje \(time)" }
        if calendar.isDateInYesterday(d) { return "Ontem \(time)" }
        if calendar.isDateInTomorrow(d) { return "Amanhã \(time)" }
        let sameYear = calendar.isDate(d, equalTo: Date(), toGranularity: .year)
        return (sameYear ? dayFormatter : fullFormatter).string(from: d)
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "HH:mm"
        return f
    }()
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "dd/MM HH:mm"
        return f
    }()
    private static let fullFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "dd/MM/yyyy HH:mm"
        return f
    }()

    // MARK: Erros

    /// Traduz o erro para exibição e trata 401 (sessão rejeitada → login).
    /// Devolve nil quando a tarefa foi apenas cancelada (nada a mostrar).
    @MainActor
    static func failure(_ error: Error) -> String? {
        if error is CancellationError { return nil }
        if let e = error as? URLError, e.code == .cancelled { return nil }
        if let e = error as? APIError, e.isUnauthorized { AppContainer.shared.handleUnauthorized() }
        return APIError.describe(error)
    }

    // MARK: Estados e prazos

    static let statuses = ["open", "in_progress", "closed"]

    static func statusTitle(_ status: String) -> String {
        switch status {
        case "open": return "Aberto"
        case "in_progress": return "Em andamento"
        case "closed": return "Concluído"
        default: return status
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "open": return .blue
        case "in_progress": return .orange
        case "closed": return .green
        default: return .secondary
        }
    }

    struct Due {
        var text: String
        var color: Color
        var icon: String
    }

    /// Texto e cor do prazo: vermelho atrasado, laranja vence em menos de 1 h, cinza sem prazo;
    /// "Respondido" quando já houve a primeira resposta.
    static func due(for ticket: Ticket, now: Date = Date()) -> Due {
        if ticket.status == "closed" {
            return Due(text: "Concluído \(shortDate(ticket.updated))", color: .secondary, icon: "checkmark.circle")
        }
        if let first = ticket.first_response_at {
            return Due(text: "Respondido \(shortDate(first))", color: .green, icon: "checkmark.bubble")
        }
        guard let dueDate = date(ticket.response_due_at) else {
            return Due(text: "Sem prazo", color: .secondary, icon: "clock")
        }
        let remaining = dueDate.timeIntervalSince(now)
        if remaining < 0 {
            return Due(text: "Atrasado desde \(shortDate(dueDate))", color: .red, icon: "exclamationmark.circle")
        }
        if remaining < 3600 {
            return Due(text: "Vence em \(max(1, Int(remaining / 60))) min", color: .orange, icon: "clock.badge.exclamationmark")
        }
        return Due(text: "Vence \(shortDate(dueDate))", color: .secondary, icon: "clock")
    }

    // MARK: Pessoas

    /// Nome de um ator a partir da lista de presença do perfil.
    static func actorName(_ actor: String?, presence: [PresenceEntry]) -> String {
        guard let actor, !actor.isEmpty else { return "Sem responsável" }
        if actor == "system" { return "Sistema" }
        if let entry = presence.first(where: { $0.actor == actor }), !entry.name.isEmpty { return entry.name }
        return "Atendente \(actor.prefix(8))"
    }

    /// Nome da conversa vinda do detalhe do protocolo ({id, phone, external_id, title, state, owner, contact_name}).
    static func conversationName(_ conversation: JSONValue?) -> String {
        guard let c = conversation else { return "Conversa" }
        if let n = c["contact_name"]?.stringValue, !n.isEmpty { return n }
        if let t = c["title"]?.stringValue, !t.isEmpty { return t }
        if let p = c["phone"]?.stringValue, !p.isEmpty { return p }
        return c["external_id"]?.stringValue ?? "Conversa"
    }

    static func conversationStateTitle(_ state: String?) -> String {
        switch state {
        case "ai": return "Com a IA"
        case "waiting": return "Na fila"
        case "human": return "Com atendente"
        case "closed": return "Concluída"
        default: return ""
        }
    }
}

/// Filtros da lista de protocolos (mobile/README.md, seção Protocolos).
enum TicketFilter: String, CaseIterable, Identifiable {
    case open, inProgress, overdue, closed, all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .open: return "Abertos"
        case .inProgress: return "Em andamento"
        case .overdue: return "Atrasados"
        case .closed: return "Concluídos"
        case .all: return "Todos"
        }
    }

    /// Parâmetro `status` da API (nil para Atrasados e Todos).
    var status: String? {
        switch self {
        case .open: return "open"
        case .inProgress: return "in_progress"
        case .closed: return "closed"
        case .overdue, .all: return nil
        }
    }

    var overdue: Bool { self == .overdue }
}

/// Chip de estado do protocolo.
struct TicketStatusBadge: View {
    let status: String

    var body: some View {
        Text(TicketsSupport.statusTitle(status))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(TicketsSupport.statusColor(status).opacity(0.15))
            .foregroundStyle(TicketsSupport.statusColor(status))
            .clipShape(Capsule())
    }
}

/// Chip de filtro (barra horizontal acima da lista).
struct TicketFilterChipView: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundStyle(selected ? Color.white : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
