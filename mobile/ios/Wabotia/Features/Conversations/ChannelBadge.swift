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
        case "telegram": return "paperplane.fill"
        case "email": return "envelope.fill"
        case "tiktok": return "music.note"
        default: return "questionmark"
        }
    }

    private var color: Color {
        switch channel?.rawValue {
        case "whatsapp": return Theme.ok
        case "instagram": return .purple
        case "facebook": return .blue
        case "telegram": return .cyan
        case "email": return Theme.warn
        case "tiktok": return .black
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
    var channel: ChannelID? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(window.label(for: channel),
                  systemImage: window.showsClock ? (window.canHumanText ? "clock" : "lock.fill") : "info.circle")
                .font(Theme.font(13, .semibold))
            if window.isHumanTextOnly {
                Text("Até 7 dias, somente texto escrito por uma pessoa. Anexos e automações ficam bloqueados.")
                    .font(Theme.font(12))
            } else if channel == .tiktok {
                Text("O prazo depende da última entrada válida do cliente.").font(Theme.font(12))
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

/// Apenas a projeção normalizada do servidor; nenhum HTML ou imagem remota de e-mail/publicação.
struct ChannelSecondWaveSummary: View {
    let detail: ConversationDetail
    let now: Int64
    var compact = false

    var body: some View {
        if detail.usesSecondWave {
            VStack(alignment: .leading, spacing: 5) {
                if detail.isComment {
                    Label("Comentário", systemImage: "text.bubble").font(Theme.font(13, .semibold))
                    if let comment = detail.commentContext {
                        if let text = comment.postText, !text.isEmpty { Text(text).lineLimit(compact ? 2 : nil) }
                        if let url = comment.safePermalink { Link("Abrir publicação", destination: url) }
                        Text(comment.hidden == true ? "Comentário oculto" : "Comentário visível")
                        Text(comment.privateStatusLabel(at: max(now, detail.server_now ?? 0)))
                        if let expires = comment.privateExpiresAt {
                            Text("Prazo da tentativa privada: \(ConversationFormatting.date(expires))")
                        }
                    }
                }
                if detail.resolvedChannel == .email {
                    if let subject = detail.emailSubject, !subject.isEmpty { Text("Assunto: \(subject)").font(Theme.font(13, .semibold)) }
                    Label("Remetente não confirmado", systemImage: "person.crop.circle.badge.questionmark")
                    if !compact, let email = detail.channel_extension?.metadata?.email {
                        if let sender = email.sender { Text("Remetente do envelope: \(sender)") }
                        if let from = email.from { Text("De: \(from)") }
                        if let replyTo = email.replyTo { Text("Responder para informado: \(replyTo)") }
                        ForEach(Array((email.authentication ?? []).enumerated()), id: \.offset) { _, value in
                            Text("\(value.method ?? "Autenticação"): \(value.result ?? "não informada")")
                        }
                        Text("Cabeçalhos recebidos não comprovam a identidade da pessoa.")
                        ForEach(Array((email.attachmentWarnings ?? []).enumerated()), id: \.offset) { _, warning in Text(warning) }
                    }
                }
                if detail.resolvedChannel == .tiktok {
                    if let quota = detail.tiktokContext?.remainingLabel {
                        Text(quota).font(Theme.font(13, .semibold))
                    } else { Text("Contador indisponível · envio bloqueado") }
                    Text("Regra conservadora: até dez envios ou tentativas nas últimas 48 horas. Nova entrada não zera o contador.")
                    if let closesAt = detail.tiktokContext?.closesAt {
                        Text("Prazo de resposta: \(ConversationFormatting.date(closesAt))")
                    }
                }
                if detail.resolvedChannel == .telegram, let telegram = detail.telegramContext {
                    if telegram.blocked == true { Text("Bot bloqueado pelo cliente").foregroundStyle(Theme.danger) }
                    if !compact {
                        Text(telegram.webhookConfigured == true ? "Webhook configurado" : "Webhook pendente")
                        if let raw = telegram.botUrl, let url = URL(string: raw), url.scheme == "https", url.host == "t.me", url.user == nil, url.password == nil {
                            Link("Abrir bot no Telegram", destination: url)
                        }
                        if let phone = telegram.phoneSuggestion?.masked {
                            Text("Telefone sugerido: \(phone). A equipe pode conferir no painel; isso não comprova identidade nem junta contatos.")
                        }
                    }
                }
            }
            .font(Theme.font(12))
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.background)
        }
    }
}
