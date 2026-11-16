import SwiftUI

/// A faixa no topo da conversa quando um módulo passou o cliente à equipe: de onde veio, o resumo e os marcadores
/// como avisos ao atendente. Toque abre as informações da conversa com tudo.
struct HandoffBanner: View {
    let handoff: ModuleHandoff
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "person.badge.shield.checkmark.fill").font(.system(size: 16)).foregroundStyle(Theme.bot)
                    .frame(width: 22).padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Passada pelo \(SuporteRules.moduleName(handoff.module))").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary)
                    if let summary = handoff.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                        Text(summary).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(2).multilineTextAlignment(.leading)
                    }
                    // Na faixa, um aviso por linha (o texto inteiro fica nos dados da conversa).
                    if !handoff.visibleFlags.isEmpty { HandoffFlags(flags: handoff.visibleFlags, lineLimit: 1) }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted).padding(.top, 2)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bot.opacity(0.08))
            .overlay(alignment: .bottom) { ThinDivider() }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Abre os dados da conversa")
        .accessibilityIdentifier("conversation.handoff")
    }
}

/// Os marcadores ("telefone não vinculado ao pagador X", "suporte avulso pago") como avisos.
struct HandoffFlags: View {
    let flags: [String]
    var lineLimit: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(flags, id: \.self) { flag in
                Label(flag, systemImage: "exclamationmark.triangle.fill")
                    .lineLimit(lineLimit)
                    .font(Theme.font(12, .semibold)).foregroundStyle(Theme.warn)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Theme.warn.opacity(0.12)))
            }
        }
    }
}

/// Nos dados da conversa: a passagem completa e a situação do Suporte pago, com as ações do atendente.
struct HandoffInfoCard: View {
    let handoff: ModuleHandoff?
    let suporte: SuporteStatus?
    let canAct: Bool
    let busy: String?
    var onLink: () -> Void
    var onConfirm: () -> Void
    var onCourtesy: () -> Void

    var body: some View {
        SectionCard(title: handoff != nil ? "Passagem para a equipe" : "Suporte pago") {
            if let h = handoff {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(SuporteRules.moduleName(h.module)).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        if let at = h.at { Text(BrasiliaTime.shortWithTime(at)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                    }
                    if let summary = h.summary, !summary.isEmpty {
                        Text(summary).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                    }
                    if !h.visibleFlags.isEmpty { HandoffFlags(flags: h.visibleFlags) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                if suporte != nil { ThinDivider().padding(.leading, 14) }
            }
            if let s = suporte {
                CardRow(icon: "checkmark.shield.fill", iconColor: s.allowed == true ? Theme.ok : Theme.warn, title: "Suporte pago", subtitle: SuporteRules.statusText(s),
                        divider: canAct && (SuporteRules.canLink(s) || SuporteRules.canConfirm(s) || SuporteRules.canCourtesy(s)))
                if canAct {
                    if SuporteRules.canLink(s) {
                        actionRow(SuporteRules.linkTitle(s), "link", Theme.brand, "link", divider: SuporteRules.canConfirm(s) || SuporteRules.canCourtesy(s), action: onLink)
                    }
                    if SuporteRules.canConfirm(s) {
                        actionRow("Confirmar e liberar", "checkmark.circle.fill", Theme.ok, "confirm", divider: SuporteRules.canCourtesy(s), action: onConfirm)
                    }
                    if SuporteRules.canCourtesy(s) {
                        actionRow("Liberar como cortesia", "gift.fill", Theme.bot, "courtesy", divider: false, action: onCourtesy)
                    }
                }
            }
        }
        .accessibilityIdentifier("conversation.handoffCard")
    }

    private func actionRow(_ title: String, _ icon: String, _ color: Color, _ id: String, divider: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                CardRow(icon: icon, iconColor: color, title: title, chevron: busy == nil, divider: divider)
                if busy == id { ProgressView().padding(.trailing, 14) }
            }
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
        .accessibilityIdentifier("suporte.\(id)")
    }
}

/// Liberar sem pagamento: o motivo fica registrado e a validade é até o protocolo fechar ou por horas.
struct CourtesySheet: View {
    let onRelease: (String, Int?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var hours: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Liberar como cortesia") { dismiss() }
            Text("O cliente é atendido sem pagar desta vez. Fica registrado quem liberou, o motivo e até quando.")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            AuthField(label: "Motivo") { TextField("Ex.: cliente antigo, problema nosso", text: $reason) }
                .accessibilityIdentifier("suporte.courtesy.reason")
            HStack {
                Text("Validade").font(Theme.font(15))
                Spacer()
                Menu {
                    ForEach(SuporteRules.courtesyOptions, id: \.title) { option in Button(option.title) { hours = option.hours } }
                } label: {
                    Text(SuporteRules.courtesyOptions.first { $0.hours == hours }?.title ?? "Até o protocolo fechar").font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                }
            }
            .frame(minHeight: Theme.touch)
            PrimaryButton(title: "Liberar", icon: "gift.fill", disabled: reason.trimmingCharacters(in: .whitespaces).isEmpty) {
                onRelease(reason.trimmingCharacters(in: .whitespacesAndNewlines), hours)
            }
            .accessibilityIdentifier("suporte.courtesy.confirm")
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
    }
}
