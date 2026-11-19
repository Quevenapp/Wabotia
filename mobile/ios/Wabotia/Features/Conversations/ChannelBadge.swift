import SwiftUI

/// Selo separado do estado do atendimento; um canal desconhecido permanece neutro.
struct ChannelBadge: View {
    let channel: ChannelID?
    var size: CGFloat = 18

    private var symbol: String {
        switch channel?.rawValue {
        case "whatsapp": return "phone.fill"
        case "instagram": return "camera.fill"
        case "facebook": return "bubble.left.fill"
        default: return "questionmark"
        }
    }

    private var color: Color {
        switch channel?.rawValue {
        case "whatsapp": return Theme.ok
        case "instagram": return .purple
        case "facebook": return .blue
        default: return Theme.muted
        }
    }

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.52, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(width: size, height: size)
            .background(Circle().fill(color))
            .accessibilityLabel(channel?.label ?? "Canal desconhecido")
    }
}

/// Projeção de prazos absolutos recebidos do servidor, sem renovar a janela pelo recebimento local.
struct ChannelWindowSummary: View {
    let window: ChannelWindowState

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(window.label, systemImage: window.showsClock ? (window.canHumanText ? "clock" : "lock.fill") : "info.circle")
                .font(Theme.font(13, .semibold))
            if window.isHumanTextOnly {
                Text("Até 7 dias, somente texto escrito por uma pessoa. Anexos e automações ficam bloqueados.")
                    .font(Theme.font(12))
            } else if window.showsClock, window.state == "open" {
                Text("Resposta humana e automação disponíveis nas primeiras 24 horas.")
                    .font(Theme.font(12))
            }
            if let end = window.isHumanTextOnly ? window.humanTextClosesAt : window.closesAt, window.canHumanText {
                Text("Até \(ConversationFormatting.date(end))").font(Theme.font(12))
            }
        }
        .foregroundStyle(window.canHumanText ? Theme.textSecondary : Theme.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.background)
        .accessibilityElement(children: .combine)
    }
}
