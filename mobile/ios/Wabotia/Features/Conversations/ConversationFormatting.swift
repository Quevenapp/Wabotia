import SwiftUI

/// Textos e formatação compartilhados pelas telas de conversa (pt-BR, fuso do aparelho).
enum ConversationFormatting {
    static func date(_ ms: Int64?) -> String {
        guard let ms, ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let cal = Calendar.current
        let time = timeFormatter.string(from: d)
        if cal.isDateInToday(d) { return "Hoje \(time)" }
        if cal.isDateInYesterday(d) { return "Ontem \(time)" }
        return "\(dayFormatter.string(from: d)) \(time)"
    }

    /// Para a lista: só a hora quando é hoje, "Ontem" ou a data curta.
    static func listDate(_ ms: Int64?) -> String {
        guard let ms, ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return timeFormatter.string(from: d) }
        if cal.isDateInYesterday(d) { return "Ontem" }
        return dayFormatter.string(from: d)
    }

    static func time(_ ms: Int64?) -> String {
        guard let ms, ms > 0 else { return "" }
        return timeFormatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    /// Chip de data da conversa: "Hoje", "Ontem", "12 de novembro" (com o ano quando não é o atual).
    static func dayChip(_ ms: Int64) -> String {
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Hoje" }
        if cal.isDateInYesterday(d) { return "Ontem" }
        return (cal.isDate(d, equalTo: Date(), toGranularity: .year) ? longDayFormatter : longDayYearFormatter).string(from: d)
    }

    /// Chave do dia (para agrupar mensagens).
    static func dayKey(_ ms: Int64) -> Int {
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return (c.year ?? 0) * 10_000 + (c.month ?? 0) * 100 + (c.day ?? 0)
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter(); f.locale = Locale(identifier: "pt_BR"); f.dateFormat = format; return f
    }
    private static let timeFormatter = formatter("HH:mm")
    private static let dayFormatter = formatter("dd/MM")
    private static let longDayFormatter = formatter("d 'de' MMMM")
    private static let longDayYearFormatter = formatter("d 'de' MMMM 'de' yyyy")

    /// "4 min", "1 h 20 min", "2 dias": tempo decorrido desde `ms`.
    static func elapsed(since ms: Int64, now: Int64) -> String {
        let minutes = max(0, (now - ms) / 60_000)
        if minutes < 1 { return "menos de 1 min" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 24 { return minutes % 60 == 0 ? "\(hours) h" : "\(hours) h \(minutes % 60) min" }
        let days = hours / 24
        return days == 1 ? "1 dia" : "\(days) dias"
    }

    static func stateLabel(_ state: String) -> String {
        switch state {
        case "ai": return "Com o bot"
        case "waiting": return "Na fila"
        case "human": return "Em atendimento"
        case "closed": return "Concluída"
        default: return state
        }
    }

    static func deliveryLabel(_ status: String?) -> String? {
        guard let status, !status.isEmpty else { return nil }
        switch status {
        case "sent": return "Enviada"
        case "delivered": return "Entregue"
        case "read": return "Lida"
        case "played": return "Ouvida"
        case "pending": return "Na fila"
        case "sending": return "Enviando"
        case "failed": return "Falhou"
        case "unknown": return "Sem confirmação"
        case "cancelled": return "Cancelada"
        default: return status
        }
    }

    static func policyLabel(_ policy: String?) -> String {
        switch policy ?? "mentions" {
        case "off": return "Somente atendimento humano"
        case "all": return "Todas as mensagens"
        default: return "Quando mencionado ou /bot"
        }
    }

    static func callStatusLabel(_ status: String) -> String { CallLabels.status(status) }

    static func bytes(_ count: Int64) -> String { ByteCountFormatter.string(fromByteCount: count, countStyle: .file) }

    /// Telefone legível: "+55 11 98765-4321" para números do Brasil; os demais só ganham o "+".
    static func phone(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        let digits = raw.filter(\.isNumber)
        guard digits.count >= 8, digits.count <= 15, raw.allSatisfy({ $0.isNumber || "+ -()".contains($0) }) else { return raw }
        if digits.hasPrefix("55"), digits.count == 12 || digits.count == 13 {
            let ddd = digits.dropFirst(2).prefix(2)
            let rest = String(digits.dropFirst(4))
            let split = rest.count - 4
            return "+55 \(ddd) \(rest.prefix(split))-\(rest.suffix(4))"
        }
        return "+\(digits)"
    }
}

// MARK: - Quem está com a conversa

@MainActor
extension Workspace {
    /// Nome do bot que atende a conversa, quando conhecido.
    func assignedBotName(_ c: Conversation) -> String? { botName(c.assigned_bot_id) }

    /// Texto curto do responsável na lista: "Com você", "Com Ana", "Bot Vendas", "Setor Financeiro".
    func ownerLabel(_ c: Conversation) -> String {
        switch c.role(me: meId) {
        case .mine: return "Com você"
        case .other: return "Com \(firstName(personName(c.owner)))"
        case .bot: return assignedBotName(c).map { "Bot \($0)" } ?? "Com o bot"
        case .waiting: return department(c.department_id).map { "Setor \($0.name)" } ?? "Na fila"
        case .closed: return "Concluída"
        }
    }

    /// Subtítulo da barra da conversa: "Com você", "Na fila há 4 min", "Com o bot Vendas", "Com Ana · Online".
    func headerStatus(_ c: Conversation) -> String {
        switch c.role(me: meId) {
        case .mine: return "Com você"
        case .other:
            let name = firstName(personName(c.owner))
            return "Com \(name) · \(isOnline(c.owner) ? "Online" : "Offline")"
        case .bot: return assignedBotName(c).map { "Com o bot \($0)" } ?? "Com o atendimento automático"
        case .waiting: return "Na fila há \(ConversationFormatting.elapsed(since: c.updated, now: nowMillis))"
        case .closed: return "Concluída"
        }
    }

    /// Frase usada como prévia quando ainda não há mensagem conhecida.
    func statusSentence(_ c: Conversation) -> String {
        switch c.role(me: meId) {
        case .mine: return "Em atendimento com você"
        case .other: return "Em atendimento com \(firstName(personName(c.owner)))"
        case .bot: return assignedBotName(c).map { "Em atendimento com o bot \($0)" } ?? "Em atendimento automático"
        case .waiting: return "Aguardando atendente"
        case .closed: return "Conversa concluída"
        }
    }

    func firstName(_ name: String) -> String {
        name.split(separator: " ").first.map(String.init) ?? name
    }
}

/// Etiqueta pequena (tags).
struct TagChip: View {
    let text: String
    var body: some View { Pill(text: text, color: Theme.textSecondary) }
}
