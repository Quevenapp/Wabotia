import SwiftUI

extension ServiceOrder {
    var statusColor: Color { ServiceOrderRules.color(state) }
}

extension ServiceOrderRules {
    static func color(_ status: String) -> Color {
        switch status {
        case "received", "analyzing": return Theme.ticket
        case "quoted": return Theme.bot
        case "approved", "in_progress": return Theme.warn
        case "ready": return Theme.ok
        case "declined", "cancelled": return Theme.muted
        case "delivered": return Theme.brand
        default: return Theme.textSecondary
        }
    }
}

/// Ordens de serviço (aba Atendimento): filtro por estado, busca e a lista por número.
struct ServiceOrdersView: View {
    @StateObject private var vm: ServiceOrdersViewModel
    @Environment(\.pushRoute) private var push
    @State private var search = ""
    @FocusState private var searching: Bool

    init(vm: ServiceOrdersViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? ServiceOrdersViewModel())
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                SearchField(placeholder: "Item, cliente, número ou telefone", text: $search, focused: $searching)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(ServiceOrderRules.filters, id: \.id) { f in
                            FilterChip(title: f.title, count: vm.count(f.id), selected: vm.filter == f.id) { vm.setFilter(f.id) }
                                .accessibilityIdentifier("os.filter.\(f.id)")
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.bar)
            .overlay(alignment: .bottom) { ThinDivider() }
            content.frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Ordens de serviço")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { push(.newServiceOrder(conversationId: nil, customer: nil)) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Nova ordem de serviço")
                    .accessibilityIdentifier("os.new")
            }
        }
        .onChange(of: search) { vm.search($0) }
        .task { vm.observeEvents(); await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if vm.loading && vm.orders.isEmpty {
            SkeletonList(rows: 6, avatar: false)
        } else if let error = vm.error, vm.orders.isEmpty {
            VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
        } else if vm.orders.isEmpty {
            EmptyStateView(title: "Nenhuma ordem aqui", systemImage: "wrench.and.screwdriver",
                           message: vm.query.isEmpty ? "Toque em + para abrir uma ordem no balcão, ou abra pela conversa do cliente." : "Nada encontrado para “\(vm.query)”.")
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(vm.orders) { order in
                        Button { push(.serviceOrder(id: order.id)) } label: { ServiceOrderRow(order: order) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("os.order.\(order.id)")
                            .onAppear { if order.id == vm.orders.last?.id { Task { await vm.loadMore() } } }
                    }
                    if vm.loadingMore { ProgressView().padding() }
                }
                .padding(16)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await vm.load() }
        }
    }
}

private struct ServiceOrderRow: View {
    let order: ServiceOrder

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(order.numberText).font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                Spacer()
                Pill(text: order.label, color: order.statusColor)
            }
            Text(order.item ?? "—").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
            Text(order.problem ?? "").font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(2)
            HStack(spacing: 6) {
                Image(systemName: "person.fill").font(.system(size: 11)).foregroundStyle(Theme.muted)
                Text(order.customerName).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Spacer()
                if let total = order.quote?.totalCents { Text(Money.format(total)).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary) }
                if let created = order.created { Text(BrasiliaTime.short(created)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
        .contentShape(Rectangle())
    }
}

/// Detalhe da ordem com histórico, mudança de estado, orçamento e entrega.
struct ServiceOrderDetailView: View {
    @StateObject private var vm: ServiceOrderViewModel
    @Environment(\.pushRoute) private var push
    @State private var editingQuote = false
    @State private var confirming: (status: String, title: String)?
    @State private var note = ""
    @State private var quoteNotify = true
    @State private var printState: TicketPrint?
    @State private var showPrinter = false
    @State private var confirmReprint = false

    init(id: String, vm: ServiceOrderViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? ServiceOrderViewModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let order = vm.order {
                    header(order)
                    actions(order)
                    quoteSection(order)
                    customerSection(order)
                    historySection(order)
                    extraActions(order)
                } else if vm.loading {
                    SkeletonList(rows: 4, avatar: false)
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.order.map { "Ordem \($0.numberText)" } ?? "Ordem de serviço")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task {
            vm.observeEvents()
            await vm.load()
            await vm.loadPeople()
            #if DEBUG
            // WABOTIA_DEMO_ACTION=quote (só depuração): abre o editor de orçamento, para conferir por print.
            if AppContainer.shared.isDemo, DemoMode.action == "quote" { editingQuote = true }
            #endif
        }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .sheet(isPresented: $editingQuote) {
            QuoteEditorSheet(order: vm.order, canSend: vm.order?.customer?.conversationId != nil) { items, days, note, send in
                editingQuote = false
                vm.saveQuote(items: items, validDays: days, note: note, thenSend: send)
            }
        }
        .sheet(isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            if let confirming { confirmSheet(confirming) }
        }
    }

    private func header(_ o: ServiceOrder) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(o.numberText).font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                Spacer()
                Pill(text: o.label, color: o.statusColor, filled: true)
            }
            Text(o.item ?? "—").font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
            Text(o.problem ?? "").font(Theme.font(15)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            if let notes = o.notes, !notes.isEmpty {
                Label(notes, systemImage: "lock.fill").font(Theme.font(13)).foregroundStyle(Theme.noteText)
                    .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubbleNote))
                    .accessibilityLabel("Observação interna: \(notes)")
            }
            HStack(spacing: 14) {
                if let created = o.created { Label(BrasiliaTime.short(created), systemImage: "calendar") }
                if let due = o.dueAt { Label("Previsão \(BrasiliaTime.short(due))", systemImage: "clock") }
                if let warranty = o.warrantyUntil { Label("Garantia até \(BrasiliaTime.short(warranty))", systemImage: "checkmark.shield") }
            }
            .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
        }
        .card(padding: 16)
    }

    @ViewBuilder
    private func actions(_ o: ServiceOrder) -> some View {
        let list = ServiceOrderRules.actions(for: o)
        if !list.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(list, id: \.status) { action in
                    let color = action.status == "cancelled" ? Theme.danger : ServiceOrderRules.color(action.status)
                    Button {
                        note = ""
                        quoteNotify = o.customer?.conversationId != nil
                        confirming = action
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busy?.contains(action.status) == true { ProgressView().scaleEffect(0.7) }
                            Text(action.title).font(Theme.font(14, .semibold)).lineLimit(2).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(color)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.12)))
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(vm.busy != nil || (action.status == "approved" && ServiceOrderRules.quoteExpired(o)))
                    .accessibilityIdentifier("os.action.\(action.status)")
                }
            }
        }
    }

    private func confirmSheet(_ action: (status: String, title: String)) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: action.title) { confirming = nil }
            switch action.status {
            case "quoted":
                Text("O cliente recebe os itens, o total e a validade, e responde Aprovar ou Recusar.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                if vm.order?.customer?.conversationId != nil {
                    Toggle("Enviar pelo WhatsApp", isOn: $quoteNotify)
                } else {
                    Text("Sem conversa ligada: o envio é só registrado (orçamento entregue em mãos).").font(Theme.font(13)).foregroundStyle(Theme.warn)
                }
            case "approved", "declined":
                Text("Registra a resposta do cliente dada no balcão ou por telefone.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
            case "delivered":
                Text("A ordem é encerrada e a garantia começa a contar. O cliente recebe o aviso de entrega.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                AuthField(label: "Observação (opcional)") { TextField("Ex.: retirado por Maria", text: $note) }
            default:
                AuthField(label: "Observação no histórico (opcional)") { TextField("Ex.: aguardando peça", text: $note) }
            }
            PrimaryButton(title: action.title, color: action.status == "cancelled" ? Theme.danger : Theme.brand) {
                let status = action.status
                confirming = nil
                vm.perform(status, note: note, notify: quoteNotify && vm.order?.customer?.conversationId != nil)
            }
            .accessibilityIdentifier("os.confirm")
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
    }

    @ViewBuilder
    private func quoteSection(_ o: ServiceOrder) -> some View {
        if let quote = o.quote {
            SectionCard(title: "Orçamento", footer: quoteFooter(o)) {
                ForEach(Array((quote.items ?? []).enumerated()), id: \.offset) { index, item in
                    CardRow(title: item.description, subtitle: item.quantity > 1 ? "\(item.quantity) × \(Money.format(item.unitCents))" : nil, value: Money.format(item.totalCents))
                }
                CardRow(title: "Total", value: Money.format(quote.total), titleColor: Theme.textPrimary, divider: ServiceOrderRules.canEditQuote(o))
                if ServiceOrderRules.canEditQuote(o) {
                    Button { editingQuote = true } label: { CardRow(icon: "pencil", iconColor: Theme.ticket, title: "Alterar orçamento", chevron: true, divider: false) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("os.quote.edit")
                }
            }
        } else if ServiceOrderRules.canEditQuote(o) {
            SecondaryButton(title: "Montar orçamento", icon: "list.bullet.rectangle") { editingQuote = true }
                .accessibilityIdentifier("os.quote.new")
        }
    }

    private func quoteFooter(_ o: ServiceOrder) -> String? {
        var parts: [String] = []
        if let sent = o.quote?.sentAt { parts.append("Enviado em \(BrasiliaTime.shortWithTime(sent))") } else { parts.append("Ainda não enviado") }
        if let until = o.quote?.validUntil { parts.append((ServiceOrderRules.quoteExpired(o) ? "venceu em " : "válido até ") + BrasiliaTime.short(until)) }
        if let decision = o.decision?.decision {
            let via = o.decision?.via == "whatsapp" ? " pelo WhatsApp" : ""
            parts.append((decision == "approve" ? "aprovado" : "recusado") + via + (o.decision?.at.map { " em \(BrasiliaTime.shortWithTime($0))" } ?? ""))
        }
        if let note = o.quote?.note, !note.isEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }

    private func assigneeRow(_ o: ServiceOrder) -> some View {
        Menu {
            Button("Sem responsável") { vm.assign(nil) }
            ForEach(vm.people) { p in Button(p.displayName) { vm.assign(p.id) } }
        } label: {
            CardRow(icon: "person.crop.circle.badge.checkmark", iconColor: Theme.bot, title: "Responsável", value: vm.assigneeName ?? "Ninguém", chevron: !vm.people.isEmpty)
        }
        .disabled(vm.people.isEmpty || vm.busy != nil || ServiceOrderRules.closed.contains(o.state))
        .accessibilityIdentifier("os.assignee")
    }

    private func customerSection(_ o: ServiceOrder) -> some View {
        SectionCard(title: "Cliente") {
            assigneeRow(o)
            CardRow(icon: "person.fill", iconColor: Theme.brand, title: o.customerName, subtitle: PhoneText.display(o.customer?.phone))
            if let conversation = o.customer?.conversationId {
                Button { push(.conversation(id: conversation)) } label: {
                    CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true)
                }
                .buttonStyle(.plain)
            }
            if let accepted = o.terms?.acceptedAt {
                CardRow(icon: "checkmark.seal.fill", iconColor: Theme.muted, title: "Termos aceitos", value: BrasiliaTime.shortWithTime(accepted), divider: false)
            } else {
                CardRow(icon: "tray.and.arrow.down.fill", iconColor: Theme.muted, title: "Aberta por", value: sourceLabel(o.source), divider: false)
            }
        }
    }

    private func historySection(_ o: ServiceOrder) -> some View {
        SectionCard(title: "Histórico") {
            let entries = (o.history ?? []).reversed()
            if entries.isEmpty { CardRow(title: "Sem registros ainda.", divider: false) }
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, h in
                CardRow(icon: "clock.arrow.circlepath", iconColor: ServiceOrderRules.color(h.toStatus ?? ""), title: ServiceOrderRules.historyText(h),
                        subtitle: [h.note, actorLabel(h.actor)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                        value: h.created.map(BrasiliaTime.shortWithTime), divider: index < entries.count - 1)
            }
        }
    }

    /// O comprovante impresso na impressora escolhida no app (a mesma do totem).
    @ViewBuilder
    private func extraActions(_ o: ServiceOrder) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SecondaryButton(title: "Imprimir comprovante", icon: "printer.fill", busy: printState == .printing) {
                print(o, confirmed: false)
            }
            .accessibilityIdentifier("os.print")
            if let text = printMessage {
                Text(text).font(Theme.font(13)).foregroundStyle(printState?.isFailure == true ? Theme.danger : Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if printState == .noPrinter {
                Button("Escolher impressora") { showPrinter = true }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
            }
        }
        .sheet(isPresented: $showPrinter) { PrinterScreen { showPrinter = false } }
        .confirmationDialog("O comprovante saiu?", isPresented: $confirmReprint, titleVisibility: .visible) {
            Button("Nada saiu, imprimir") { print(o, confirmed: true) }
            Button("Saiu, cancelar", role: .cancel) {}
        } message: {
            Text("A impressora pode ter impresso sem confirmar. Imprima de novo só se nada saiu.")
        }
    }

    private var printMessage: String? {
        switch printState {
        case .printing?: return "Imprimindo…"
        case .printed?: return "Enviado à impressora. Confira o papel."
        case .noPrinter?: return "Nenhuma impressora escolhida neste aparelho."
        case let .failed(message, _)?: return "O comprovante não saiu: \(message)"
        case nil: return nil
        }
    }

    private func print(_ o: ServiceOrder, confirmed: Bool) {
        // Resultado incerto da vez anterior: a segunda via só com confirmação, para não sair papel duplicado.
        if case let .failed(_, needsConfirmation)? = printState, needsConfirmation, !confirmed {
            confirmReprint = true
            return
        }
        let header = Workspace.shared.profileName
        printState = .printing
        Task {
            let establishment = await vm.establishment()
            printState = await WabotiaPrinting.shared.print(ServiceOrderReceiptData.of(o, header: header, establishment: establishment))
        }
    }

    private func actorLabel(_ actor: String?) -> String? {
        guard let actor else { return nil }
        if actor == "customer" { return "pelo cliente" }
        if actor.hasPrefix("system") || actor == "module" { return "automático" }
        return nil
    }

    private func sourceLabel(_ source: String?) -> String {
        switch source {
        case "whatsapp", "web": return "Cliente pelo WhatsApp"
        case "panel", "staff": return "Equipe"
        case "api": return "Integração"
        default: return source ?? "—"
        }
    }
}

/// Montar ou alterar o orçamento: itens com quantidade e valor, validade em dias e observação ao cliente.
private struct QuoteEditorSheet: View {
    let canSend: Bool
    let onSave: ([QuoteItem], Int?, String, Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: QuoteDraft
    @State private var error: String?

    init(order: ServiceOrder?, canSend: Bool, onSave: @escaping ([QuoteItem], Int?, String, Bool) -> Void) {
        self.canSend = canSend
        self.onSave = onSave
        _draft = State(initialValue: QuoteDraft(order: order))
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Orçamento", subtitle: "Total \(Money.format(draft.total))") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach($draft.lines) { $line in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                TextField("Descrição (ex.: troca de tela)", text: $line.description).font(Theme.font(15))
                                if draft.lines.count > 1 {
                                    Button { draft.lines.removeAll { $0.id == line.id } } label: { Image(systemName: "trash").foregroundStyle(Theme.danger) }
                                        .accessibilityLabel("Remover item")
                                }
                            }
                            HStack {
                                Stepper("Qtd. \(line.quantity)", value: $line.quantity, in: 1...999).font(Theme.font(14)).fixedSize()
                                Spacer()
                                Text("R$").foregroundStyle(Theme.textSecondary)
                                TextField("0,00", text: $line.value).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width: 110)
                            }
                        }
                        .card(padding: 12)
                    }
                    Button { draft.lines.append(.init()) } label: { Label("Adicionar item", systemImage: "plus.circle.fill").font(Theme.font(15, .semibold)) }
                        .foregroundStyle(Theme.brand)
                    AuthField(label: "Validade (dias)") { TextField("7", text: $draft.validDays).keyboardType(.numberPad) }
                    AuthField(label: "Observação ao cliente (opcional)") { TextField("Ex.: peça original, garantia de 90 dias", text: $draft.note) }
                    if let error { InlineError(text: error) }
                    if canSend {
                        PrimaryButton(title: "Salvar e enviar ao cliente", icon: "paperplane.fill") { save(send: true) }
                            .accessibilityIdentifier("os.quote.saveSend")
                    }
                    SecondaryButton(title: "Só salvar", icon: "tray.and.arrow.down") { save(send: false) }
                        .accessibilityIdentifier("os.quote.save")
                    Text("Mudar um orçamento já enviado volta a ordem para Em análise até o novo envio.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private func save(send: Bool) {
        switch draft.items() {
        case .failure(let e): error = e.message
        case .success(let items):
            guard let days = draft.days else { error = "Validade de 1 a 90 dias."; return }
            onSave(items, days, draft.note, send)
        }
    }
}

/// Abrir ordem pela conversa ou no balcão.
struct NewServiceOrderView: View {
    @StateObject private var vm: NewServiceOrderViewModel
    @Environment(\.dismiss) private var dismiss

    init(conversationId: String?, customer: String?, vm: NewServiceOrderViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? NewServiceOrderViewModel(conversationId: conversationId, customer: customer))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if vm.conversationId != nil {
                    DeviceNotice(text: "Para \(vm.customerLabel ?? "o cliente desta conversa"): ele recebe o número da ordem pelo WhatsApp.", color: Theme.ok)
                } else {
                    AuthField(label: "Telefone do cliente") { TextField("(11) 90000-0000", text: $vm.phone).keyboardType(.phonePad).accessibilityIdentifier("os.new.phone") }
                    AuthField(label: "Nome (opcional)") { TextField("Nome do cliente", text: $vm.customerName) }
                }
                AuthField(label: "Item") { TextField("Ex.: celular, notebook, bicicleta", text: $vm.item).accessibilityIdentifier("os.new.item") }
                AuthField(label: "Problema") { TextField("O que o cliente relatou", text: $vm.problem).accessibilityIdentifier("os.new.problem") }
                AuthField(label: "Observação interna (opcional)") { TextField("Não vai para o cliente", text: $vm.notes) }
                if !vm.people.isEmpty {
                    HStack {
                        Text("Responsável").font(Theme.font(15))
                        Spacer()
                        Menu {
                            Button("Sem responsável") { vm.assignee = nil }
                            ForEach(vm.people) { p in Button(p.displayName) { vm.assignee = p.id } }
                        } label: {
                            Text(vm.people.first { $0.id == vm.assignee }?.displayName ?? "Sem responsável").font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                        }
                        .accessibilityIdentifier("os.new.assignee")
                    }
                    .frame(minHeight: Theme.touch)
                }
                Toggle("Prazo previsto", isOn: $vm.hasDue).font(Theme.font(15))
                if vm.hasDue {
                    DatePicker("Previsão", selection: $vm.due, in: Date()..., displayedComponents: .date)
                        .environment(\.locale, Locale(identifier: "pt_BR"))
                }
                if let notice = vm.notice { InlineError(text: notice) }
                PrimaryButton(title: "Abrir ordem", icon: "wrench.and.screwdriver.fill", busy: vm.busy, disabled: !vm.canSubmit) { Task { await vm.submit() } }
                    .accessibilityIdentifier("os.new.submit")
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .task { await vm.loadPeople() }
        .navigationTitle("Nova ordem de serviço")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .onChange(of: vm.result) { order in
            guard let order else { return }
            Workspace.shared.show("Ordem \(order.numberText) aberta", style: .success)
            dismiss()
        }
    }
}
