import SwiftUI

extension MensalidadeRules {
    static func color(_ status: String) -> Color {
        switch status {
        case "paid", "active": return Theme.ok
        case "overdue": return Theme.danger
        case "open": return Theme.ticket
        case "paused": return Theme.warn
        default: return Theme.muted
        }
    }
}

/// Mensalidades (Ajustes → Atendimento): resumo do mês com as parcelas, assinaturas e inadimplentes.
struct MensalidadeView: View {
    @StateObject private var vm: MensalidadeViewModel
    @Environment(\.pushRoute) private var push
    @State private var search = ""
    @FocusState private var searching: Bool

    init(vm: MensalidadeViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? MensalidadeViewModel())
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Picker("Visão", selection: Binding(get: { vm.mode }, set: { vm.setMode($0) })) {
                    ForEach(MensalidadeViewModel.Mode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                if vm.mode == .month {
                    HStack {
                        IconButton(systemName: "chevron.left", label: "Mês anterior") { vm.shiftMonth(-1) }
                        Text(MensalidadeRules.monthTitle(vm.month).prefix(1).uppercased() + MensalidadeRules.monthTitle(vm.month).dropFirst()).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).frame(maxWidth: .infinity)
                        IconButton(systemName: "chevron.right", label: "Próximo mês") { vm.shiftMonth(1) }
                    }
                }
                if vm.mode != .delinquents {
                    SearchField(placeholder: "Aluno, cliente ou telefone", text: $search, focused: $searching)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            if vm.mode == .month {
                                ForEach(MensalidadeRules.filters, id: \.id) { f in
                                    FilterChip(title: f.title, count: f.id == "all" ? nil : vm.summary?.counts?[f.id], selected: vm.filter == f.id,
                                               attention: f.id == "overdue" && (vm.summary?.counts?["overdue"] ?? 0) > 0 ? Theme.danger : nil) { vm.setFilter(f.id) }
                                }
                            } else {
                                ForEach(["active", "paused", "ended", "all"], id: \.self) { s in
                                    FilterChip(title: s == "all" ? "Todas" : MensalidadeRules.subscriptionLabel(s), selected: vm.subscriptionFilter == s) { vm.setSubscriptionFilter(s) }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.bar)
            .overlay(alignment: .bottom) { ThinDivider() }
            Group {
                if vm.loading {
                    SkeletonList(rows: 6, avatar: false)
                } else if let error = vm.error {
                    VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            switch vm.mode {
                            case .month: monthBody
                            case .subscriptions: subscriptionsBody
                            case .delinquents: delinquentsBody
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: 720)
                        .frame(maxWidth: .infinity)
                    }
                    .refreshable { await vm.load() }
                }
            }
            .frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Mensalidades")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .onChange(of: search) { vm.search($0) }
        .task {
            vm.observeEvents()
            #if DEBUG
            if AppContainer.shared.isDemo, DemoMode.action == "subscriptions" { vm.setMode(.subscriptions); return }
            if AppContainer.shared.isDemo, DemoMode.action == "delinquents" { vm.setMode(.delinquents); return }
            #endif
            await vm.load()
        }
    }

    @ViewBuilder
    private var monthBody: some View {
        if let s = vm.summary {
            if s.paymentsReady == false {
                DeviceNotice(text: "A Cobrança (Pix e link) não está configurada: as parcelas não são cobradas pelo WhatsApp até um administrador configurar.", color: Theme.warn)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                tile("Previsto", s.expectedCents, Theme.textPrimary)
                tile("Recebido", s.receivedCents, Theme.ok)
                tile("Em aberto", s.openCents, Theme.ticket)
                tile("Vencido", s.overdueCents, Theme.danger)
            }
            if let total = s.overdueTotal, (total.count ?? 0) > 0 {
                Text("Em atraso no total: \(Money.format(total.cents ?? 0)) em \(total.count ?? 0) parcela(s) de \(total.subscriptions ?? 0) assinatura(s).")
                    .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            }
        }
        if vm.installments.isEmpty {
            EmptyStateView(title: "Nenhuma parcela aqui", systemImage: "creditcard", message: "As parcelas do mês aparecem conforme as assinaturas.")
        }
        ForEach(vm.installments) { i in
            Button { push(.installment(id: i.id)) } label: { InstallmentRow(installment: i) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mensalidade.installment.\(i.id)")
        }
    }

    private func tile(_ title: String, _ cents: Int?, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
            Text(Money.format(cents ?? 0)).font(Theme.font(18, .bold)).foregroundStyle(color).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }

    @ViewBuilder
    private var subscriptionsBody: some View {
        if vm.subscriptions.isEmpty {
            EmptyStateView(title: "Nenhuma assinatura aqui", systemImage: "person.2", message: "As assinaturas são criadas e importadas no painel do Wabotia.")
        }
        ForEach(vm.subscriptions) { s in
            Button { push(.subscription(id: s.id)) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(s.customer?.displayName ?? "Cliente").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        Pill(text: s.label, color: MensalidadeRules.color(s.state))
                    }
                    HStack {
                        Text([s.planName, s.dueDay.map { "vence dia \($0)" }].compactMap { $0 }.joined(separator: " · ")).font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                        Spacer()
                        Text(Money.format(s.chargeCents ?? s.amountCents ?? 0)).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary)
                    }
                    if let overdue = s.overdueCount, overdue > 0 {
                        Text("\(overdue) vencida(s) · \(Money.format(s.overdueCents ?? 0))").font(Theme.font(12, .semibold)).foregroundStyle(Theme.danger)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("mensalidade.subscription.\(s.id)")
        }
    }

    @ViewBuilder
    private var delinquentsBody: some View {
        if vm.delinquents.isEmpty {
            EmptyStateView(title: "Ninguém em atraso", systemImage: "checkmark.seal", message: "Todas as parcelas vencidas foram pagas ou isentas.")
        }
        ForEach(vm.delinquents) { d in
            Button { push(.subscription(id: d.subscriptionId)) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(d.customer?.displayName ?? "Cliente").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        Text(Money.format(d.overdueCents ?? 0)).font(Theme.font(15, .bold)).foregroundStyle(Theme.danger)
                    }
                    Text([d.planName, "\(d.overdueCount ?? 0) parcela(s)", "desde \(MensalidadeRules.dueText(d.oldestDueDate))"].compactMap { $0 }.joined(separator: " · "))
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    if let notices = d.noticesSent, notices > 0 { Text("\(notices) aviso(s) de atraso enviado(s)").font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

private struct InstallmentRow: View {
    let installment: Installment

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(installment.customer?.displayName ?? "Cliente").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text([installment.planName, installment.periodLabel].compactMap { $0 }.joined(separator: " · ")).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Text("Vence \(MensalidadeRules.dueText(installment.dueDate))").font(Theme.font(12)).foregroundStyle(installment.state == "overdue" ? Theme.danger : Theme.textSecondary)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 6) {
                Text(Money.format(installment.amountCents ?? 0)).font(Theme.font(15, .bold)).foregroundStyle(Theme.textPrimary)
                Pill(text: installment.label, color: MensalidadeRules.color(installment.state))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
        .contentShape(Rectangle())
    }
}

/// Parcela: cobrança (Pix e link), avisos, baixa e as ações.
struct InstallmentDetailView: View {
    @StateObject private var vm: InstallmentViewModel
    @Environment(\.pushRoute) private var push
    @State private var sheet: String?
    @State private var note = ""
    @State private var paidAt = Date()
    @State private var notify = true

    init(id: String, vm: InstallmentViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? InstallmentViewModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let i = vm.installment {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(Money.format(i.amountCents ?? 0)).font(Theme.font(26, .bold)).foregroundStyle(Theme.textPrimary)
                            Spacer()
                            Pill(text: i.label, color: MensalidadeRules.color(i.state), filled: true)
                        }
                        Text(i.customer?.displayName ?? "Cliente").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                        Text([i.planName, i.periodLabel].compactMap { $0 }.joined(separator: " · ")).font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                        Text("Vence \(MensalidadeRules.dueText(i.dueDate))").font(Theme.font(14)).foregroundStyle(i.state == "overdue" ? Theme.danger : Theme.textSecondary)
                    }
                    .card(padding: 16)
                    actions(i)
                    SectionCard(title: "Cobrança") {
                        CardRow(title: "Situação", value: i.payment?.status.map(paymentLabel) ?? "Não enviada")
                        if let charged = i.payment?.chargedAt { CardRow(title: "Enviada em", value: BrasiliaTime.shortWithTime(charged)) }
                        if let expires = i.payment?.expiresAt { CardRow(title: "Vale até", value: BrasiliaTime.shortWithTime(expires)) }
                        if let error = i.notices?.error, !error.isEmpty { CardRow(title: "Último aviso", subtitle: error) }
                        CardRow(title: "Avisos de atraso", value: "\(i.notices?.overdue ?? 0)", divider: i.paidAt != nil)
                        if let paid = i.paidAt {
                            CardRow(title: "Paga em", subtitle: [MensalidadeRules.paidVia(i.paidVia), i.paidNote].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "), value: BrasiliaTime.shortWithTime(paid), divider: false)
                        }
                    }
                    SectionCard(title: "Cliente") {
                        ForEach(i.customer?.phoneList ?? [], id: \.self) { phone in CardRow(icon: "phone.fill", iconColor: Theme.brand, title: phone) }
                        if let conversation = i.customer?.conversationId {
                            Button { push(.conversation(id: conversation)) } label: { CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true) }
                                .buttonStyle(.plain)
                        }
                        if let sub = i.subscriptionId {
                            Button { push(.subscription(id: sub)) } label: { CardRow(icon: "person.text.rectangle", iconColor: Theme.ticket, title: "Ver assinatura", chevron: true, divider: false) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Parcela")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .sheet(isPresented: Binding(get: { sheet != nil }, set: { if !$0 { sheet = nil } })) {
            VStack(alignment: .leading, spacing: 14) {
                SheetHeader(title: sheet == "pay" ? "Dar baixa" : "Isentar parcela") { sheet = nil }
                if sheet == "pay" {
                    Text("Para pagamento recebido fora do Pix ou do link (dinheiro, transferência).").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    DatePicker("Pago em", selection: $paidAt, in: ...Date(), displayedComponents: .date).environment(\.locale, Locale(identifier: "pt_BR"))
                    Toggle("Enviar o comprovante ao cliente", isOn: $notify)
                } else {
                    Text("A parcela deixa de ser cobrada e não conta como atraso.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                }
                AuthField(label: "Observação (opcional)") { TextField(sheet == "pay" ? "Ex.: pago em dinheiro" : "Ex.: bolsa de estudos", text: $note) }
                PrimaryButton(title: sheet == "pay" ? "Dar baixa" : "Isentar", color: sheet == "pay" ? Theme.ok : Theme.warn) {
                    let action = sheet
                    sheet = nil
                    if action == "pay" { vm.pay(note: note, paidAt: paidAt, notify: notify) } else { vm.waive(note: note) }
                }
                .accessibilityIdentifier("mensalidade.confirm")
                Spacer()
            }
            .padding(.horizontal, 20)
            .background(Theme.background.ignoresSafeArea())
        }
    }

    @ViewBuilder
    private func actions(_ i: Installment) -> some View {
        let buttons = [
            MensalidadeRules.canCharge(i) ? ActionButton(title: "Reenviar cobrança", action: "charge", icon: "paperplane.fill", color: Theme.ticket) : nil,
            MensalidadeRules.canPay(i) ? ActionButton(title: "Dar baixa", action: "pay", icon: "checkmark.circle.fill", color: Theme.ok) : nil,
            MensalidadeRules.canWaive(i) ? ActionButton(title: "Isentar", action: "waive", icon: "gift.fill", color: Theme.warn) : nil,
        ].compactMap { $0 }
        if !buttons.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(buttons) { button in
                    Button {
                        if button.action == "charge" { vm.charge() } else { note = ""; paidAt = Date(); notify = true; sheet = button.action }
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busy == button.action { ProgressView().scaleEffect(0.7) } else { Image(systemName: button.icon).font(.system(size: 13, weight: .semibold)) }
                            Text(button.title).font(Theme.font(14, .semibold))
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(button.color)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(button.color.opacity(0.12)))
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(vm.busy != nil)
                    .accessibilityIdentifier("mensalidade.\(button.action)")
                }
            }
        }
    }

    private func paymentLabel(_ status: String) -> String {
        switch status {
        case "created": return "Enviada, aguardando pagamento"
        case "paid": return "Paga"
        case "expired": return "Venceu"
        case "cancelled": return "Cancelada"
        case "refunded": return "Devolvida"
        default: return status
        }
    }
}

/// Assinatura: dados, parcelas e pausar, retomar ou encerrar.
struct SubscriptionDetailView: View {
    @StateObject private var vm: SubscriptionViewModel
    @Environment(\.pushRoute) private var push
    @State private var confirming: String?

    init(id: String, vm: SubscriptionViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? SubscriptionViewModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let s = vm.subscription {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(s.customer?.displayName ?? "Cliente").font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
                            Spacer()
                            Pill(text: s.label, color: MensalidadeRules.color(s.state), filled: true)
                        }
                        Text([s.planName, s.periodLabel].compactMap { $0 }.joined(separator: " · ")).font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
                        Text("\(Money.format(s.chargeCents ?? s.amountCents ?? 0))\(s.dueDay.map { " · vence dia \($0)" } ?? "")").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                        if let discount = s.discountCents, discount > 0 { Text("Desconto de \(Money.format(discount))").font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                        if let notes = s.notes, !notes.isEmpty {
                            Label(notes, systemImage: "lock.fill").font(Theme.font(13)).foregroundStyle(Theme.noteText)
                                .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubbleNote))
                        }
                    }
                    .card(padding: 16)
                    HStack(spacing: 8) {
                        if MensalidadeRules.canPause(s) { action("Pausar", "pause", Theme.warn) }
                        if MensalidadeRules.canResume(s) { action("Retomar", "resume", Theme.ok) }
                        if MensalidadeRules.canEnd(s) { action("Encerrar", "end", Theme.danger) }
                    }
                    SectionCard(title: "Cliente") {
                        ForEach(s.customer?.phoneList ?? [], id: \.self) { phone in CardRow(icon: "phone.fill", iconColor: Theme.brand, title: phone) }
                        if let conversation = s.customer?.conversationId {
                            Button { push(.conversation(id: conversation)) } label: { CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true) }
                                .buttonStyle(.plain)
                        }
                        CardRow(title: "Início", value: MensalidadeRules.dueText(s.startDate), divider: s.endDate != nil)
                        if let end = s.endDate { CardRow(title: "Fim", value: MensalidadeRules.dueText(end), divider: false) }
                    }
                    let items = s.installments ?? []
                    if !items.isEmpty {
                        Text("PARCELAS").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
                        ForEach(items) { i in
                            Button { push(.installment(id: i.id)) } label: { InstallmentRow(installment: i) }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Assinatura")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button(confirming == "end" ? "Encerrar" : (confirming == "pause" ? "Pausar" : "Retomar"), role: confirming == "end" ? .destructive : nil) {
                if let action = confirming { vm.perform(action) }
            }
            Button("Voltar", role: .cancel) {}
        } message: {
            Text(confirming == "resume" ? "As próximas parcelas voltam a ser geradas; a pausa não é cobrada." : "As parcelas em aberto ainda não vencidas são canceladas.")
        }
    }

    private var confirmTitle: String {
        switch confirming {
        case "pause": return "Pausar a assinatura?"
        case "resume": return "Retomar a assinatura?"
        default: return "Encerrar a assinatura?"
        }
    }

    private func action(_ title: String, _ action: String, _ color: Color) -> some View {
        Button { confirming = action } label: {
            HStack(spacing: 6) {
                if vm.busy == action { ProgressView().scaleEffect(0.7) }
                Text(title).font(Theme.font(14, .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(color)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.12)))
        }
        .buttonStyle(PressScaleStyle())
        .disabled(vm.busy != nil)
        .accessibilityIdentifier("mensalidade.subscription.\(action)")
    }
}
