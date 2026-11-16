import SwiftUI
import UIKit

extension ConversationItemsRules {
    static func webStepColor(_ status: String?) -> Color {
        switch status {
        case "sent": return Theme.ticket
        case "opened": return Theme.warn
        case "completed": return Theme.ok
        default: return Theme.muted
        }
    }

    static func paymentColor(_ status: String?) -> Color {
        switch status {
        case "created": return Theme.warn
        case "paid": return Theme.ok
        case "expired", "refunded": return Theme.danger
        default: return Theme.muted
        }
    }

    /// Na faixa da conversa: o que está em andamento e o que mudou nas últimas 24 horas, até quatro.
    static func recent(steps: [WebStep], payments: [ConversationPayment], now: Int64) -> (steps: [WebStep], payments: [ConversationPayment]) {
        let day: Int64 = 86_400_000
        let s = steps.filter { isActive($0) || now - max($0.completed_at ?? 0, $0.created ?? 0) < day }
        let p = payments.filter { isActive($0) || now - max($0.paid_at ?? 0, $0.created ?? 0) < day }
        let pay = Array(p.prefix(2))
        return (Array(s.prefix(4 - pay.count)), pay)
    }
}

/// A faixa de links e cobranças no topo da conversa: um chip por item, com o estado. Toque abre os dados da conversa.
struct ConversationItemsBar: View {
    let steps: [WebStep]
    let payments: [ConversationPayment]
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(payments) { p in
                        chip(icon: p.method == "link" ? "link" : "qrcode", text: "\(Money.format(p.amount_cents ?? 0)) · \(ConversationItemsRules.paymentLabel(p.status))",
                             color: ConversationItemsRules.paymentColor(p.status))
                    }
                    ForEach(steps) { s in
                        chip(icon: "doc.text", text: "\(ConversationItemsRules.stepTitle(s)) · \(ConversationItemsRules.webStepLabel(s.status))",
                             color: ConversationItemsRules.webStepColor(s.status))
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 7)
            }
            .background(Theme.bar)
            .overlay(alignment: .bottom) { ThinDivider() }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Abre os dados da conversa")
        .accessibilityIdentifier("conversation.items")
    }

    private func chip(icon: String, text: String, color: Color) -> some View {
        Label(text, systemImage: icon)
            .font(Theme.font(12, .semibold)).foregroundStyle(color).lineLimit(1)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Capsule().fill(color.opacity(0.12)))
    }
}

/// Nos dados da conversa: todas as cobranças e links recentes, com estado, validade e o Pix ou link para copiar.
struct ConversationItemsCard: View {
    let steps: [WebStep]
    let payments: [ConversationPayment]
    let canForm: Bool
    let canCharge: Bool
    var onForm: () -> Void
    var onCharge: () -> Void

    var body: some View {
        SectionCard(title: "Formulários e cobranças", footer: "Pago só vale com a confirmação do Mercado Pago: mensagem ou comprovante do cliente não mudam o estado.") {
            if steps.isEmpty && payments.isEmpty {
                CardRow(title: "Nada enviado nesta conversa.", titleColor: Theme.textSecondary, divider: canForm || canCharge)
            }
            ForEach(payments) { p in paymentRow(p) }
            ForEach(steps) { s in
                CardRow(icon: "doc.text.fill", iconColor: ConversationItemsRules.webStepColor(s.status), title: ConversationItemsRules.stepTitle(s),
                        subtitle: stepSubtitle(s), value: ConversationItemsRules.webStepLabel(s.status))
            }
            if canForm {
                Button(action: onForm) { CardRow(icon: "doc.text", iconColor: Theme.brand, title: "Enviar formulário", chevron: true, divider: canCharge) }
                    .buttonStyle(.plain).accessibilityIdentifier("conversation.form")
            }
            if canCharge {
                Button(action: onCharge) { CardRow(icon: "creditcard", iconColor: Theme.brand, title: "Cobrar", chevron: true, divider: false) }
                    .buttonStyle(.plain).accessibilityIdentifier("conversation.charge")
            }
        }
        .accessibilityIdentifier("conversation.itemsCard")
    }

    private func paymentRow(_ p: ConversationPayment) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Label("\(ConversationItemsRules.methodLabel(p.method)) · \(Money.format(p.amount_cents ?? 0))", systemImage: p.method == "link" ? "link" : "qrcode")
                    .font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Pill(text: ConversationItemsRules.paymentLabel(p.status), color: ConversationItemsRules.paymentColor(p.status))
            }
            if let d = p.description, !d.isEmpty { Text(d).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
            Text(paymentDates(p)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
            if ConversationItemsRules.isActive(p) {
                HStack(spacing: 14) {
                    if let code = p.pix_code, !code.isEmpty { copyButton("Copiar Pix", code) }
                    if let url = p.url, !url.isEmpty { copyButton("Copiar link", url) }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottom) { ThinDivider().padding(.leading, 14) }
        .accessibilityElement(children: .contain)
    }

    private func copyButton(_ title: String, _ value: String) -> some View {
        Button {
            UIPasteboard.general.string = value
            Workspace.shared.show("\(title.replacingOccurrences(of: "Copiar ", with: "")) copiado")
        } label: { Label(title, systemImage: "doc.on.doc").font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand) }
        .buttonStyle(.plain)
    }

    private func paymentDates(_ p: ConversationPayment) -> String {
        var parts: [String] = []
        if let c = p.created { parts.append("Enviada \(BrasiliaTime.shortWithTime(c))") }
        if let paid = p.paid_at { parts.append("paga \(BrasiliaTime.shortWithTime(paid))") }
        else if let until = p.expires_at, p.status == "created" { parts.append("vale até \(BrasiliaTime.shortWithTime(until))") }
        return parts.joined(separator: " · ")
    }

    private func stepSubtitle(_ s: WebStep) -> String {
        if let at = s.completed_at { return "Respondido \(BrasiliaTime.shortWithTime(at))" }
        if let at = s.opened_at { return "Aberto \(BrasiliaTime.shortWithTime(at))" }
        if let until = s.expires_at, ConversationItemsRules.isActive(s) { return "Vale até \(BrasiliaTime.shortWithTime(until))" }
        return s.created.map { "Enviado \(BrasiliaTime.shortWithTime($0))" } ?? ""
    }
}

/// "Enviar formulário": a lista de formulários ativos da área; o cliente recebe um link de uso único.
struct FormPickerSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Enviar formulário", subtitle: "O cliente recebe um link de uso único.") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let error = vm.actionError ?? vm.formsError { InlineError(text: error) }
                    if let forms = vm.forms {
                        if forms.isEmpty {
                            Text("Nenhum formulário ativo. Um administrador cria em Gestão → Formulários.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                        }
                        ForEach(forms) { form in
                            Button {
                                Task { if await vm.sendForm(form) { dismiss() } }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(form.displayName).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
                                        Text("\(form.fields?.count ?? 0) campo(s)").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                                    }
                                    Spacer()
                                    if vm.busyAction == "form" { ProgressView() } else { Image(systemName: "paperplane.fill").foregroundStyle(Theme.brand) }
                                }
                                .card(padding: 14)
                            }
                            .buttonStyle(.plain)
                            .disabled(vm.busy)
                            .accessibilityIdentifier("form.\(form.id)")
                        }
                    } else if vm.formsError == nil {
                        ProgressView().frame(maxWidth: .infinity).padding()
                    }
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .task { await vm.loadForms() }
    }
}

/// "Cobrar": Pix (QR e copia e cola) ou link de pagamento, com valor e descrição. A confirmação é do provedor.
struct ChargeSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var method = "pix"
    @State private var amount = ""
    @State private var description = ""

    private var cents: Int? { ConversationItemsRules.amount(amount) }
    private var valid: Bool { cents != nil && !description.trimmingCharacters(in: .whitespaces).isEmpty && description.count <= 120 }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Cobrar", subtitle: "Pelo Mercado Pago, na conversa do cliente.") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Picker("Forma", selection: $method) {
                        Text("Pix").tag("pix")
                        Text("Link de pagamento").tag("link")
                    }
                    .pickerStyle(.segmented)
                    Text(method == "pix" ? "O cliente recebe o botão do QR Code e o código copia e cola numa mensagem separada." : "O cliente recebe o botão \"Pagar agora\" (cartão, Pix e outros meios).")
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    AuthField(label: "Valor (R$)") { TextField("0,00", text: $amount).keyboardType(.decimalPad).accessibilityIdentifier("charge.amount") }
                    AuthField(label: "Descrição") { TextField("Ex.: consulta, sinal, mensalidade", text: $description).accessibilityIdentifier("charge.description") }
                    if !amount.isEmpty, cents == nil { InlineError(text: "Valor entre R$ 0,01 e R$ 100.000,00. Use, por exemplo, 49,90.") }
                    if let error = vm.actionError { InlineError(text: error) }
                    PrimaryButton(title: "Enviar cobrança de \(Money.format(cents ?? 0))", icon: "paperplane.fill", busy: vm.busyAction == "charge", disabled: !valid) {
                        guard let cents else { return }
                        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { if await vm.charge(method: method, amountCents: cents, description: text) { dismiss() } }
                    }
                    .accessibilityIdentifier("charge.submit")
                    Text("O pagamento só é confirmado pelo Mercado Pago. \"Já paguei\" ou comprovante do cliente não mudam o estado.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }
}
