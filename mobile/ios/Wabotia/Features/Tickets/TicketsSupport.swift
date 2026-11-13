import SwiftUI
import UIKit

/// Auxiliares da área de protocolos (reaproveitados pela área de bots): datas curtas, rótulos,
/// prazo com anel e tratamento padrão de erros (401 → volta ao login).
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

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = format
        return f
    }
    private static let timeFormatter = formatter("HH:mm")
    private static let dayFormatter = formatter("dd/MM HH:mm")
    private static let fullFormatter = formatter("dd/MM/yyyy HH:mm")

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

    /// Os seis estados, na ordem do seletor do detalhe.
    static let statuses = TicketStatus.all

    /// Recebido, Em análise, Aguardando cliente, Aguardando terceiro, Resolvido, Encerrado; desconhecido vira texto neutro.
    static func statusTitle(_ status: String) -> String { TicketStatus.label(status) }

    /// Recebido `ticket`, Em análise `warn`, os dois Aguardando `bot`, Resolvido `ok`, Encerrado e desconhecido `muted`.
    static func statusColor(_ status: String) -> Color {
        switch status {
        case TicketStatus.open: return Theme.ticket
        case TicketStatus.inProgress: return Theme.warn
        case TicketStatus.waitingCustomer, TicketStatus.waitingThird: return Theme.bot
        case TicketStatus.resolved: return Theme.ok
        default: return Theme.muted
        }
    }

    struct Due: Equatable {
        enum Kind: Equatable { case closed, answered, none, overdue, soon, scheduled }
        var kind: Kind
        var text: String
        /// Parte do prazo ainda disponível (1 = recém-aberto, 0 = vencido).
        var fraction: Double

        var color: Color {
            switch kind {
            case .overdue: return Theme.danger
            case .soon: return Theme.warn
            case .answered, .scheduled: return Theme.ok
            case .closed, .none: return Theme.muted
            }
        }
        var icon: String {
            switch kind {
            case .closed, .answered: return "checkmark"
            case .overdue: return "exclamationmark"
            case .none: return "minus"
            case .soon, .scheduled: return "clock.fill"
            }
        }
    }

    /// Prazo da primeira resposta: vermelho atrasado ("atrasado há 2h"), laranja abaixo de 1 h,
    /// "Respondido" quando já houve a primeira resposta, cinza sem prazo.
    static func due(for ticket: Ticket, now: Date = Date()) -> Due {
        if !ticket.isActive { return Due(kind: .closed, text: statusTitle(ticket.status), fraction: 1) }
        if ticket.first_response_at != nil { return Due(kind: .answered, text: "Respondido", fraction: 1) }
        guard let dueDate = date(ticket.response_due_at) else { return Due(kind: .none, text: "Sem prazo", fraction: 0) }
        let remaining = dueDate.timeIntervalSince(now)
        if remaining < 0 { return Due(kind: .overdue, text: "atrasado há \(span(-remaining))", fraction: 0) }
        let total = max(60, dueDate.timeIntervalSince(date(ticket.created) ?? now))
        let fraction = min(1, max(0.04, remaining / total))
        if remaining < 3600 { return Due(kind: .soon, text: "vence em \(max(1, Int(remaining / 60))) min", fraction: fraction) }
        return Due(kind: .scheduled, text: "vence \(shortDate(dueDate).lowercased())", fraction: fraction)
    }

    /// "12 min", "2h", "3 dias".
    static func span(_ seconds: TimeInterval) -> String {
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(max(1, minutes)) min" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h" }
        return "\(hours / 24) dias"
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
        if let p = c["phone"]?.stringValue, !p.isEmpty { return ConversationFormatting.phone(p) }
        return c["external_id"]?.stringValue ?? "Conversa"
    }
}

/// Filtros da lista de protocolos (mobile/README.md, seção Protocolos).
enum TicketFilter: String, CaseIterable, Identifiable {
    case active, open, inProgress, waiting, overdue, resolved, all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .active: return "Ativos"
        case .open: return "Recebidos"
        case .inProgress: return "Em análise"
        case .waiting: return "Aguardando"
        case .overdue: return "Atrasados"
        case .resolved: return "Resolvidos"
        case .all: return "Todos"
        }
    }

    /// Valores do parâmetro `status` da API. Vazio = sem filtro de estado; com mais de um valor a lista junta uma
    /// consulta por estado (o servidor aceita um estado por consulta).
    var statuses: [String] {
        switch self {
        case .open: return [TicketStatus.open]
        case .inProgress: return [TicketStatus.inProgress]
        case .waiting: return TicketStatus.waiting
        case .resolved: return TicketStatus.finished
        case .active, .overdue, .all: return []
        }
    }

    /// Usa `active=1` (servidor 0.14+).
    var activeOnly: Bool { self == .active }
    var overdue: Bool { self == .overdue }

    /// O que o filtro mostra, aplicado também no app: um servidor 0.13 ignora `active=1` e devolve tudo.
    func matches(_ ticket: Ticket, now: Date = Date()) -> Bool {
        switch self {
        case .overdue: return ticket.isOverdue(at: now)
        case .active: return ticket.isActive
        case .all: return true
        default: return statuses.contains(ticket.status)
        }
    }
}

/// Pílula de estado do protocolo.
struct TicketStatusBadge: View {
    let status: String
    var body: some View { Pill(text: TicketsSupport.statusTitle(status), color: TicketsSupport.statusColor(status)) }
}

/// Categoria do protocolo (aplicativo ou assunto): ícone + nome em texto secundário, sem competir com a pílula de estado.
struct TicketCategoryTag: View {
    let name: String
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "square.grid.2x2.fill").font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
            Text(name).font(Theme.font(13, .medium)).foregroundStyle(Theme.textSecondary).lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Categoria: \(name)")
    }
}

/// Escolha da categoria ao abrir um protocolo: chips em linha rolável, "Sem categoria" primeiro.
/// Só as habilitadas são oferecidas. `selection` nulo = sem categoria.
struct TicketCategoryChips: View {
    let categories: [TicketCategory]
    @Binding var selection: String?
    var disabled = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("Sem categoria", id: nil)
                ForEach(categories.filter(\.enabled)) { category in chip(category.name, id: category.id) }
            }
            .padding(.vertical, 1)
        }
        .disabled(disabled)
    }

    private func chip(_ title: String, id: String?) -> some View {
        let selected = selection == id
        return Button { selection = id } label: {
            Text(title)
                .font(Theme.font(14, selected ? .semibold : .medium))
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(minHeight: 34)
                .foregroundStyle(selected ? Theme.ticket : Theme.textSecondary)
                .background(Capsule().fill(selected ? Theme.ticket.opacity(0.16) : Theme.field))
                .overlay(Capsule().stroke(selected ? Color.clear : Theme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Prazo com o mesmo anel do relógio da janela.
struct TicketDueView: View {
    let due: TicketsSupport.Due
    var size: CGFloat = 20

    var body: some View {
        HStack(spacing: 5) {
            ProgressRing(fraction: due.fraction, color: due.color, size: size) {
                Image(systemName: due.icon).font(.system(size: size * 0.42, weight: .bold)).foregroundStyle(due.color)
            }
            Text(due.text).font(Theme.font(13, .semibold)).foregroundStyle(due.kind == .none || due.kind == .closed ? Theme.textSecondary : due.color).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Prazo: \(due.text)")
    }
}
