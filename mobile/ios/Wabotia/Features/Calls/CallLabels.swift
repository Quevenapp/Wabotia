import Foundation

/// Textos e formatos do histórico da aba Ligações (pt-BR), alinhados ao painel web.
enum CallLabels {
    static func status(_ status: String?) -> String {
        switch status ?? "" {
        case "ringing": return "Recebendo ligação"
        case "dialing": return "Chamando"
        case "connecting": return "Conectando áudio"
        case "preaccepted": return "Preparando áudio"
        case "active": return "Em ligação"
        case "completed": return "Encerrada"
        case "missed": return "Não atendida"
        case "rejected": return "Recusada"
        case "failed": return "Falhou"
        case "unknown": return "Sem confirmação"
        default:
            if let status, !status.isEmpty { return status }
            return "—"
        }
    }

    static func direction(_ direction: String) -> String { direction == "inbound" ? "Recebida" : "Realizada" }

    static func directionIcon(_ direction: String) -> String { direction == "inbound" ? "phone.arrow.down.left" : "phone.arrow.up.right" }

    /// Duração em segundos → "mm:ss" ou "h:mm:ss"; nil quando não houve conversa.
    static func duration(_ seconds: Int64?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        return elapsed(Int(seconds))
    }

    static func elapsed(_ total: Int) -> String {
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }

    /// "Hoje 14:32", "Ontem 09:10", "08/11 10:00" no fuso do aparelho.
    static func dateLabel(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let time = timeFormatter.string(from: date)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Hoje \(time)" }
        if calendar.isDateInYesterday(date) { return "Ontem \(time)" }
        return "\(dayFormatter.string(from: date)) \(time)"
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
        f.dateFormat = "dd/MM"
        return f
    }()
}
