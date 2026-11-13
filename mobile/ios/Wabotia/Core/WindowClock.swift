import Foundation

/// Relógio da janela de 24 horas do WhatsApp (mobile/DESIGN.md, seção 2).
/// `expira = last_customer + 24 h`; `restante = expira − agora`. Tudo em milissegundos Unix.
/// Só cálculo e texto: as cores e o anel ficam em `WindowRing` (Core/Theme).
struct WindowClock: Equatable {
    enum Level: Equatable { case ok, warn, danger, closed }

    static let windowMillis: Int64 = 24 * 60 * 60 * 1000
    private static let hour: Int64 = 60 * 60 * 1000
    private static let minute: Int64 = 60 * 1000

    /// Horário da última mensagem do cliente (0 = nunca escreveu).
    let lastCustomer: Int64
    let now: Int64

    init(lastCustomer: Int64, now: Int64) {
        self.lastCustomer = lastCustomer
        self.now = now
    }

    init(lastCustomer: Int64, now: Date) {
        self.init(lastCustomer: lastCustomer, now: Int64((now.timeIntervalSince1970 * 1000).rounded()))
    }

    var expires: Int64 { lastCustomer + Self.windowMillis }
    /// Milissegundos restantes; 0 quando a janela está fechada.
    var remaining: Int64 { lastCustomer <= 0 ? 0 : max(0, expires - now) }
    var isClosed: Bool { remaining <= 0 }

    /// `ok` acima de 6 h, `warn` de 1 h a 6 h, `danger` abaixo de 1 h, `closed` sem prazo.
    var level: Level {
        let left = remaining
        if left <= 0 { return .closed }
        if left > 6 * Self.hour { return .ok }
        if left >= Self.hour { return .warn }
        return .danger
    }

    /// Parte do anel ainda cheia (1 = 24 h, 0 = fechada).
    var fraction: Double {
        min(1, max(0, Double(remaining) / Double(Self.windowMillis)))
    }

    /// "23h 14min", "5h 02min", "42 min", "menos de 1 min" ou "Janela fechada".
    var label: String {
        let left = remaining
        if left <= 0 { return "Janela fechada" }
        let hours = left / Self.hour
        let minutes = (left % Self.hour) / Self.minute
        if hours >= 1 { return "\(hours)h \(String(format: "%02d", minutes))min" }
        if minutes >= 1 { return "\(minutes) min" }
        return "menos de 1 min"
    }

    /// Forma compacta da lista: "23h", "5h", "42m"; vazio quando fechada (a lista mostra o cadeado).
    var compact: String {
        let left = remaining
        if left <= 0 { return "" }
        let hours = left / Self.hour
        if hours >= 1 { return "\(hours)h" }
        return "\(max(1, left / Self.minute))m"
    }

    /// Texto da faixa da conversa.
    var bannerText: String {
        switch level {
        case .closed: return "Janela fechada · só volta quando o cliente escrever"
        case .danger: return "Janela fecha em \(label)"
        case .ok, .warn: return "Janela de 24h · \(label) restantes"
        }
    }

    /// "até 14:32" quando expira hoje, "até amanhã 09:10" quando expira no dia seguinte; nil se fechada.
    func untilLabel(calendar: Calendar = .current) -> String? {
        guard !isClosed else { return nil }
        let end = Date(timeIntervalSince1970: Double(expires) / 1000)
        let today = Date(timeIntervalSince1970: Double(now) / 1000)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pt_BR")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        let time = formatter.string(from: end)
        if calendar.isDate(end, inSameDayAs: today) { return "até \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: today), calendar.isDate(end, inSameDayAs: tomorrow) {
            return "até amanhã \(time)"
        }
        formatter.dateFormat = "dd/MM HH:mm"
        return "até \(formatter.string(from: end))"
    }

    /// A janela vale para conversa direta em linha oficial do WhatsApp (`meta` ou `zernio`).
    /// Tipo de linha desconhecido (ainda não carregado): mostra o relógio. Grupos e outras linhas: nada.
    static func applies(chatType: String?, connectionKind: String?) -> Bool {
        if chatType == "group" { return false }
        guard let kind = connectionKind, !kind.isEmpty else { return true }
        return kind == "meta" || kind == "zernio"
    }
}
