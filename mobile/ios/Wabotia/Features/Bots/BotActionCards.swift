import SwiftUI

private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// Moldura comum dos cartões da conversa interna com o bot.
private struct BotCardFrame<Content: View>: View {
    let icon: String
    let color: Color
    let title: String
    let status: String
    let statusColor: Color
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundStyle(color)
                Text(title).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).textCase(.uppercase)
                Spacer(minLength: 6)
                Text(status).font(Theme.font(12, .semibold)).foregroundStyle(statusColor)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(statusColor.opacity(0.14)))
            }
            content()
        }
        .padding(12)
        .frame(maxWidth: 520, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.divider, lineWidth: 1))
    }
}

/// Proposta de ação: o que o bot vai fazer, a operação do catálogo, os parâmetros, o prazo e Confirmar/Cancelar.
struct ProposalCardView: View {
    let proposal: BotProposal
    let operationSummary: String?
    var busy = false
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        // O prazo anda sozinho na tela (vale 10 minutos).
        TimelineView(.periodic(from: .now, by: 20)) { _ in
            let now = nowMs
            BotCardFrame(icon: "wand.and.stars", color: Theme.bot, title: "Proposta do bot", status: proposal.statusText(now: now),
                         statusColor: color(now)) {
                Text(proposal.summary ?? "Ação proposta pelo bot").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let operationSummary { Label(operationSummary, systemImage: "list.bullet.rectangle").font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                let params = BotActionText.params(proposal.params)
                if !params.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(params, id: \.0) { key, value in
                            (Text(key + ": ").font(Theme.font(12, .semibold)) + Text(value).font(Theme.font(12)))
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                }
                if proposal.sensitive == true, proposal.actionable(now: now) {
                    Label("Ação sensível: o código do autenticador será pedido.", systemImage: "lock.shield").font(Theme.font(12)).foregroundStyle(Theme.warn)
                }
                if let expiry = proposal.expiryText(now: now) { Text(expiry).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                if proposal.status == "failed", let outcome = proposal.outcomeText { Text(outcome).font(Theme.font(13)).foregroundStyle(Theme.danger) }
                if proposal.statusText(now: now) == "Venceu" {
                    Text("Peça de novo ao bot para gerar outra proposta.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
                if proposal.actionable(now: now) {
                    HStack(spacing: 10) {
                        Button(action: onCancel) {
                            Text("Cancelar").font(Theme.font(15, .semibold)).foregroundStyle(Theme.danger)
                                .frame(maxWidth: .infinity, minHeight: 40)
                                .background(Capsule().stroke(Theme.danger, lineWidth: 1.5))
                        }
                        .accessibilityIdentifier("proposal.cancel")
                        Button(action: onConfirm) {
                            Group { if busy { ProgressView().tint(Theme.onBrand) } else { Text("Confirmar").font(Theme.font(15, .semibold)) } }
                                .foregroundStyle(Theme.onBrand)
                                .frame(maxWidth: .infinity, minHeight: 40)
                                .background(Capsule().fill(Theme.brand))
                        }
                        .accessibilityIdentifier("proposal.confirm")
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                }
            }
        }
    }

    private func color(_ now: Int64) -> Color {
        switch proposal.statusText(now: now) {
        case "Feito": return Theme.ok
        case "Não foi possível", "Venceu": return Theme.danger
        case "Cancelada": return Theme.muted
        default: return Theme.brand
        }
    }
}

/// Resultado: o que foi feito ou o erro.
struct ResultCardView: View {
    let proposal: BotProposal

    var body: some View {
        let done = proposal.status == "done"
        BotCardFrame(icon: done ? "checkmark.circle.fill" : (proposal.status == "cancelled" ? "xmark.circle" : "exclamationmark.triangle.fill"),
                     color: done ? Theme.ok : (proposal.status == "cancelled" ? Theme.muted : Theme.danger),
                     title: "Resultado", status: proposal.statusText(now: nowMs),
                     statusColor: done ? Theme.ok : (proposal.status == "cancelled" ? Theme.muted : Theme.danger)) {
            Text(proposal.summary ?? "Ação do bot").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let outcome = proposal.outcomeText {
                Text(outcome).font(Theme.font(14)).foregroundStyle(done ? Theme.textPrimary : Theme.danger).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Pedido de aprovação: o contexto lido por código, o resumo do bot à parte, e Aprovar/Recusar/Assumir.
struct ApprovalCardView: View {
    let approval: BotApproval
    var busy = false
    let onApprove: (Double?) -> Void
    let onDecline: (String?) -> Void
    let onHandoff: () -> Void
    @State private var sheet: Mode?

    enum Mode: Identifiable { case approve, decline; var id: Self { self } }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            let now = nowMs
            BotCardFrame(icon: "hand.raised.fill", color: Theme.warn, title: "Pedido de aprovação", status: approval.statusText(now: now),
                         statusColor: statusColor(now)) {
                Text(approval.title ?? "Pedido de cliente").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let fields = approval.fields, !fields.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(fields) { f in
                            HStack(alignment: .top) {
                                Text(f.label ?? f.key ?? "").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                                Spacer(minLength: 8)
                                Text(f.value.map(BotActionText.describe) ?? "—").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary)
                                    .multilineTextAlignment(.trailing)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
                if let hidden = approval.hidden_fields, hidden > 0 {
                    Text(hidden == 1 ? "1 campo restrito não aparece para você." : "\(hidden) campos restritos não aparecem para você.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
                if let summary = approval.model_summary, !summary.isEmpty {
                    // Nunca junto dos números: é o que o bot escreveu.
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Resumo do bot (não verificado)").font(Theme.font(11, .semibold)).foregroundStyle(Theme.textSecondary)
                        Text(summary).font(Theme.font(13)).italic().foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                }
                decided
                if approval.decidable(now: now) {
                    if let e = approval.expires_at {
                        Text("Vence às \(ConversationFormatting.time(e))").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                    }
                    HStack(spacing: 8) {
                        button("Recusar", Theme.danger, filled: false) { sheet = .decline }.accessibilityIdentifier("approval.decline")
                        button("Aprovar", Theme.ok, filled: true) { sheet = .approve }.accessibilityIdentifier("approval.approve")
                    }
                    button("Assumir a conversa", Theme.brand, filled: false, action: onHandoff).accessibilityIdentifier("approval.handoff")
                } else if approval.status == "pending", approval.can_decide == false {
                    Text("Aguardando quem pode decidir.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .sheet(item: $sheet) { mode in
            ApprovalDecisionSheet(mode: mode, adjust: approval.adjust) { value, reason in
                sheet = nil
                if mode == .approve { onApprove(value) } else { onDecline(reason) }
            } onClose: { sheet = nil }
        }
    }

    @ViewBuilder private var decided: some View {
        if ["approved", "declined", "handoff"].contains(approval.status) {
            VStack(alignment: .leading, spacing: 2) {
                if let who = approval.decidedByName {
                    Text("\(approval.status == "handoff" ? "Assumida" : "Decidido") por \(who)\(approval.decided_at.map { " às \(ConversationFormatting.time($0))" } ?? "")")
                        .font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary)
                }
                if let value = approval.value { Text("\(approval.adjust?.label ?? "Valor"): \(format(value))").font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                if let reason = approval.reason, !reason.isEmpty { Text("Motivo: \(reason)").font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
            }
        }
    }

    private func format(_ value: Double) -> String {
        approval.adjust?.type == "money" ? Money.format(Int((value * 100).rounded())) : BotActionText.describe(.number(value))
    }

    private func statusColor(_ now: Int64) -> Color {
        switch approval.status {
        case "approved": return Theme.ok
        case "declined", "expired": return Theme.danger
        case "handoff": return Theme.brand
        default: return approval.statusText(now: now) == "Venceu" ? Theme.danger : Theme.warn
        }
    }

    private func button(_ title: String, _ color: Color, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group { if busy && filled { ProgressView().tint(Theme.onBrand) } else { Text(title).font(Theme.font(15, .semibold)) } }
                .foregroundStyle(filled ? Theme.onBrand : color)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Capsule().fill(filled ? color : Color.clear))
                .overlay(Capsule().stroke(color, lineWidth: filled ? 0 : 1.5))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

/// Aprovar (com o ajuste opcional, dentro dos limites) ou recusar (com motivo opcional).
struct ApprovalDecisionSheet: View {
    let mode: ApprovalCardView.Mode
    let adjust: ApprovalAdjust?
    let onConfirm: (Double?, String?) -> Void
    let onClose: () -> Void
    @State private var text = ""

    /// O ajuste digitado ("6,20"), `nil` quando vazio; inválido quando fora dos limites.
    private var value: Double? { Double(text.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)) }
    private var invalid: Bool {
        guard mode == .approve, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        guard let v = value else { return true }
        if let min = adjust?.min, v < min { return true }
        if let max = adjust?.max, v > max { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: mode == .approve ? "Aprovar" : "Recusar", onClose: onClose)
            if mode == .approve, let adjust {
                AuthField(label: (adjust.label ?? "Ajuste") + " (opcional)", error: invalid) {
                    TextField(limits(adjust), text: $text).keyboardType(.decimalPad).accessibilityIdentifier("approval.value")
                }
                if invalid { InlineError(text: "Fora dos limites: \(limits(adjust)).") }
            } else if mode == .decline {
                AuthField(label: "Motivo (opcional)") {
                    TextField("Ex.: desconto acima da política", text: $text).accessibilityIdentifier("approval.reason")
                }
            }
            PrimaryButton(title: mode == .approve ? "Aprovar" : "Recusar", color: mode == .approve ? Theme.ok : Theme.danger, disabled: invalid) {
                let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
                onConfirm(mode == .approve ? value : nil, mode == .decline && !clean.isEmpty ? clean : nil)
            }
            Text("O primeiro a decidir vence: se outra pessoa decidir antes, o cartão mostra quem foi.")
                .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
    }

    private func limits(_ a: ApprovalAdjust) -> String {
        func f(_ v: Double) -> String { a.type == "money" ? Money.format(Int((v * 100).rounded())) : BotActionText.describe(.number(v)) }
        switch (a.min, a.max) {
        case let (min?, max?): return "de \(f(min)) a \(f(max))"
        case let (nil, max?): return "até \(f(max))"
        case let (min?, nil): return "a partir de \(f(min))"
        default: return "valor"
        }
    }
}
