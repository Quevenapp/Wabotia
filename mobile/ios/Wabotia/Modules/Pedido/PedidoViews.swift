import SwiftUI

extension PedidoRules {
    static func color(_ status: String) -> Color {
        switch status {
        case "awaiting_payment": return Theme.warn
        case "received": return Theme.brand
        case "preparing": return Theme.bot
        case "ready": return Theme.ok
        case "out_for_delivery": return Theme.ticket
        default: return Theme.muted
        }
    }

    static func paymentColor(_ status: String?) -> Color {
        switch status {
        case "paid": return Theme.ok
        case "choosing", "awaiting": return Theme.warn
        case "expired", "failed": return Theme.danger
        default: return Theme.muted
        }
    }
}

/// Pedidos (Ajustes → Atendimento): o quadro da cozinha, a lista e o cardápio com os esgotados, com a situação da loja.
struct PedidoView: View {
    @StateObject private var vm: PedidoViewModel
    @Environment(\.pushRoute) private var push
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var search = ""
    @FocusState private var searching: Bool
    @State private var pausing = false

    init(vm: PedidoViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? PedidoViewModel())
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Picker("Visão", selection: Binding(get: { vm.mode }, set: { vm.setMode($0) })) {
                    ForEach(PedidoViewModel.Mode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("pedido.mode")
                if vm.mode == .list {
                    SearchField(placeholder: "Cliente, número ou telefone", text: $search, focused: $searching)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(PedidoRules.filters, id: \.id) { f in
                                FilterChip(title: f.title, count: vm.count(f.id), selected: vm.filter == f.id) { vm.setFilter(f.id) }
                                    .accessibilityIdentifier("pedido.filter.\(f.id)")
                            }
                        }
                    }
                }
                if let store = vm.store { storeBanner(store) }
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.bar)
            .overlay(alignment: .bottom) { ThinDivider() }
            content.frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Pedidos")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .onChange(of: search) { vm.search($0) }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .task {
            vm.observeEvents()
            #if DEBUG
            if AppContainer.shared.isDemo, let action = DemoMode.action {
                if action == "list" { vm.setMode(.list); return }
                if action == "menu" { vm.setMode(.menu); return }
            }
            #endif
            await vm.load()
            #if DEBUG
            if !AppContainer.shared.isDemo, let script = DemoMode.pedidoScript { await runScript(script) }
            #endif
        }
        .task { await vm.tick() }
        .refreshable { await vm.load() }
        .sheet(isPresented: $pausing) { PauseStoreSheet { message in pausing = false; vm.setPaused(true, message: message) } }
    }

    #if DEBUG
    /// `WABOTIA_PEDIDO` no quadro (só depuração, sessão de verdade): os passos com o resultado no console.
    private func runScript(_ script: String) async {
        for step in script.split(separator: ",").map(String.init) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
            let arg = parts.count > 1 ? parts[1] : ""
            switch parts.first ?? "" {
            case "mode": vm.setMode(PedidoViewModel.Mode(rawValue: arg) ?? .board)
            case "pause": vm.setPaused(true, message: arg)
            case "resume": vm.setPaused(false, message: "")
            case "off", "on":
                if vm.mode != .menu { vm.setMode(.menu) }
                for _ in 0..<50 where vm.menu == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
                let items = (vm.menu?.categories ?? []).flatMap { $0.items ?? [] }
                if let item = items.first(where: { $0.id == arg || ($0.name ?? "").lowercased() == arg.lowercased() }) {
                    vm.setItem(item, available: parts[0] == "on")
                } else { print("[Vinki] pedido: item \(arg) não está no cardápio") }
            default: break
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
            for _ in 0..<80 where !vm.busy.isEmpty { try? await Task.sleep(nanoseconds: 100_000_000) }
            try? await Task.sleep(nanoseconds: 800_000_000)
            let items = (vm.menu?.categories ?? []).flatMap { $0.items ?? [] }.map { "\($0.name ?? $0.id)=\($0.available == false ? "esgotado" : "ok")" }
            print("[Vinki] pedido: \(step) → \(vm.notice ?? vm.done ?? "-") · \(PedidoRules.storeText(vm.store))\(items.isEmpty ? "" : " · " + items.joined(separator: ", "))")
        }
    }
    #endif

    private func storeBanner(_ store: PedidoStore) -> some View {
        let paused = store.paused == true
        let color = paused ? Theme.danger : (store.open == false ? Theme.warn : Theme.ok)
        return HStack(spacing: 10) {
            Circle().fill(color).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(PedidoRules.storeText(store)).font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary)
                if let message = PedidoRules.pauseText(store) {
                    Text(message).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(3)
                } else if let today = vm.board?.today, vm.mode == .board {
                    Text("Hoje: \(today.orders ?? 0) pedido(s) · \(today.delivered ?? 0) entregue(s) · \(Money.format(today.totalCents ?? 0))")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
            }
            Spacer(minLength: 6)
            Button {
                if paused { vm.setPaused(false, message: "") } else { pausing = true }
            } label: {
                HStack(spacing: 4) {
                    if vm.busy.contains("pause") { ProgressView().scaleEffect(0.7) }
                    Text(paused ? "Voltar a receber" : "Pausar a loja").font(Theme.font(13, .semibold))
                }
                .padding(.horizontal, 10).frame(minHeight: 34)
                .foregroundStyle(paused ? Theme.ok : Theme.danger)
                .background(Capsule().fill((paused ? Theme.ok : Theme.danger).opacity(0.12)))
            }
            .buttonStyle(.plain)
            .disabled(vm.busy.contains("pause"))
            .accessibilityIdentifier("pedido.pause")
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.08)))
    }

    @ViewBuilder
    private var content: some View {
        if vm.loading && vm.board == nil && vm.orders.isEmpty && vm.menu == nil {
            SkeletonList(rows: 6, avatar: false)
        } else if let error = vm.error {
            VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
        } else {
            switch vm.mode {
            case .board: boardView
            case .list: listView
            case .menu: menuView
            }
        }
    }

    // MARK: Quadro

    @ViewBuilder
    private var boardView: some View {
        if vm.boardCount == 0 {
            EmptyStateView(title: "Nenhum pedido em andamento", systemImage: "takeoutbag.and.cup.and.straw",
                           message: "Os pedidos novos do WhatsApp aparecem aqui assim que o cliente conclui o carrinho.")
        } else if sizeClass == .regular {
            // iPad: uma coluna por estado, lado a lado, como no painel.
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(vm.columns) { column in
                        VStack(alignment: .leading, spacing: 10) {
                            columnHeader(column)
                            ScrollView {
                                LazyVStack(spacing: 10) { ForEach(column.orders ?? []) { order in card(order) } }
                            }
                        }
                        .frame(width: 290)
                    }
                }
                .padding(16)
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10, pinnedViews: [.sectionHeaders]) {
                    ForEach(vm.columns.filter { !($0.orders ?? []).isEmpty }) { column in
                        Section {
                            ForEach(column.orders ?? []) { order in card(order) }
                        } header: {
                            columnHeader(column).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading).background(Theme.background)
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
    }

    private func columnHeader(_ column: PedidoColumn) -> some View {
        HStack(spacing: 8) {
            Circle().fill(PedidoRules.color(column.status)).frame(width: 8, height: 8)
            Text(PedidoRules.columnLabel(column.status)).font(Theme.font(14, .bold)).foregroundStyle(Theme.textPrimary)
            Text("\(column.orders?.count ?? 0)").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
        }
    }

    private func card(_ order: PedidoOrder) -> some View {
        Button { push(.pedidoOrder(id: order.id)) } label: { PedidoCard(order: order) }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pedido.order.\(order.id)")
    }

    // MARK: Lista

    @ViewBuilder
    private var listView: some View {
        if vm.orders.isEmpty {
            EmptyStateView(title: "Nenhum pedido aqui", systemImage: "takeoutbag.and.cup.and.straw",
                           message: vm.query.isEmpty ? "Troque o filtro para ver pedidos entregues ou cancelados." : "Nada encontrado para “\(vm.query)”.")
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(vm.orders) { order in
                        card(order).onAppear { if order.id == vm.orders.last?.id { Task { await vm.loadMore() } } }
                    }
                    if vm.loadingMore { ProgressView().padding() }
                }
                .padding(16)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: Cardápio

    @ViewBuilder
    private var menuView: some View {
        let categories = vm.menu?.categories ?? []
        let groups = vm.menu?.groups ?? []
        if categories.isEmpty && groups.isEmpty {
            EmptyStateView(title: "Cardápio vazio", systemImage: "menucard", message: "O cardápio é montado no painel, em Cardápio e loja.")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Desligue o que acabou: o item aparece no carrinho sem quantidade até voltar.")
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    ForEach(categories) { category in
                        SectionCard(title: category.name ?? "Categoria") {
                            let items = category.items ?? []
                            if items.isEmpty { CardRow(title: "Sem itens.", divider: false) }
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                availabilityRow(title: item.name ?? "Item", subtitle: item.priceCents.map(Money.format), available: item.available != false,
                                                busy: vm.busy.contains("item:\(item.id)"), divider: index < items.count - 1,
                                                id: "pedido.item.\(item.id)") { vm.setItem(item, available: $0) }
                            }
                        }
                    }
                    ForEach(groups) { group in
                        SectionCard(title: group.name ?? "Adicionais", footer: groupFooter(group)) {
                            let options = group.options ?? []
                            ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                                availabilityRow(title: option.name ?? "Opção", subtitle: (option.priceCents ?? 0) > 0 ? "+ " + Money.format(option.priceCents ?? 0) : nil,
                                                available: option.available != false, busy: vm.busy.contains("option:\(group.id):\(option.id)"),
                                                divider: index < options.count - 1, id: "pedido.option.\(group.id).\(option.id)") { vm.setOption(group: group, option: option, available: $0) }
                            }
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func groupFooter(_ g: PedidoMenuGroup) -> String {
        let min = g.min ?? 0, max = g.max ?? 1
        if min >= 1 && max == 1 { return "Escolha única obrigatória" }
        return min == 0 ? "Opcional, até \(max)" : "De \(min) a \(max)"
    }

    private func availabilityRow(title: String, subtitle: String?, available: Bool, busy: Bool, divider: Bool, id: String, onChange: @escaping (Bool) -> Void) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).strikethrough(!available).font(Theme.font(15, .semibold)).foregroundStyle(available ? Theme.textPrimary : Theme.textSecondary)
                    HStack(spacing: 6) {
                        if let subtitle { Text(subtitle).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                        if !available { Pill(text: "Esgotado", color: Theme.danger) }
                    }
                }
                Spacer()
                if busy { ProgressView().scaleEffect(0.7) }
                Toggle("Disponível", isOn: Binding(get: { available }, set: onChange)).labelsHidden().tint(Theme.ok).disabled(busy)
                    .accessibilityLabel("\(title) disponível")
                    .accessibilityIdentifier(id)
            }
            .padding(.horizontal, 14).frame(minHeight: 56)
            if divider { ThinDivider().padding(.leading, 14) }
        }
    }
}

/// O cartão do pedido no quadro e na lista: número, cliente, itens, tempo no estado (vermelho quando atrasa), total.
struct PedidoCard: View {
    let order: PedidoOrder

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(order.numberText).font(.system(size: 17, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                Image(systemName: order.delivery ? "bicycle" : "bag.fill").font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                    .accessibilityLabel(order.fulfillmentLabel ?? (order.delivery ? "Entrega" : "Retirada"))
                Spacer()
                if let minutes = PedidoRules.elapsed(order.minutesInStatus) {
                    Label(minutes, systemImage: "clock").font(Theme.font(12, .semibold))
                        .foregroundStyle(order.late == true ? Theme.danger : Theme.textSecondary)
                } else {
                    Pill(text: order.label, color: PedidoRules.color(order.state))
                }
            }
            Text(order.customerName).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array((order.lines ?? []).prefix(4).enumerated()), id: \.offset) { _, line in
                    Text("\(line.quantity ?? 1)x \(line.name ?? "Item")" + (PedidoRules.optionsText(line).map { " · \($0)" } ?? ""))
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
                if (order.lines?.count ?? 0) > 4 {
                    Text("e mais \((order.lines?.count ?? 0) - 4)…").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
            }
            HStack(spacing: 6) {
                Pill(text: order.payment?.status == "paid" ? "Pago" : (order.payment?.methodLabel ?? "Pagamento a definir"),
                     color: PedidoRules.paymentColor(order.payment?.status))
                Spacer()
                Text(Money.format(order.totalCents ?? 0)).font(Theme.font(14, .bold)).foregroundStyle(Theme.textPrimary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(Theme.danger, lineWidth: order.late == true ? 1.5 : 0))
        .contentShape(Rectangle())
    }
}

private struct PauseStoreSheet: View {
    let onPause: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Pausar a loja") { dismiss() }
            Text("O Cardápio no WhatsApp responde que a loja está fechada agora, e um carrinho aberto antes é recusado ao concluir. Os pedidos já feitos seguem no quadro.")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            AuthField(label: "Mensagem ao cliente (opcional)") { TextField("Ex.: voltamos às 19h", text: $message) }
            PrimaryButton(title: "Pausar a loja", color: Theme.danger) { onPause(message) }
                .accessibilityIdentifier("pedido.pause.confirm")
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
    }
}

/// Detalhe do pedido: estado, itens com adicionais e observações, pagamento, cliente e entrega, histórico e comanda.
struct PedidoOrderView: View {
    @StateObject private var vm: PedidoOrderViewModel
    @Environment(\.pushRoute) private var push
    @State private var confirming: (status: String, title: String)?
    @State private var note = ""
    @State private var notify = true
    @State private var payingNote = ""
    @State private var confirmPaid = false
    @State private var printState: TicketPrint?
    @State private var showPrinter = false
    @State private var confirmReprint = false

    init(id: String, vm: PedidoOrderViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? PedidoOrderViewModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let order = vm.order {
                    header(order)
                    actions(order)
                    itemsSection(order)
                    paymentSection(order)
                    customerSection(order)
                    historySection(order)
                    printSection(order)
                } else if vm.loading {
                    SkeletonList(rows: 4, avatar: false)
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.order.map { "Pedido \($0.numberText)" } ?? "Pedido")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task {
            vm.observeEvents()
            await vm.load()
            #if DEBUG
            if !AppContainer.shared.isDemo, let script = DemoMode.pedidoScript { await runScript(script) }
            #endif
        }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .sheet(isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            if let confirming { confirmSheet(confirming) }
        }
        .confirmationDialog("Registrar o pagamento recebido?", isPresented: $confirmPaid, titleVisibility: .visible) {
            Button("Recebi \(Money.format(vm.order?.totalCents ?? 0))") { vm.markPaid(note: nil) }
            Button("Voltar", role: .cancel) {}
        } message: {
            Text("Use para dinheiro, maquininha ou pagamento feito por fora. Fica no histórico com o seu nome.")
        }
    }

    #if DEBUG
    /// `WABOTIA_PEDIDO` no pedido (só depuração, sessão de verdade): estados (também um que não vale), pago, forma de
    /// pagamento e impressão, com o resultado no console. Nada é avisado ao cliente.
    private func runScript(_ script: String) async {
        let lines = (vm.order?.lines ?? []).map { "\($0.quantity ?? 1)x \($0.name ?? "")[\($0.slot ?? 0)] \(PedidoRules.optionsText($0) ?? "")" }
        Swift.print("[Vinki] pedido \(vm.order?.numberText ?? "?"): \(vm.order?.label ?? "?"), linhas: \(lines.joined(separator: " | ")), próximos: \((vm.order?.nextStatuses ?? []).joined(separator: ","))")
        for step in script.split(separator: ",").map(String.init) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
            let arg = parts.count > 1 ? parts[1] : ""
            switch parts.first ?? "" {
            case "status": vm.perform(arg, note: nil, reason: arg == "cancelled" ? "Teste do app" : nil, notify: false)
            case "paid": vm.markPaid(note: nil)
            case "method": vm.setMethod(arg)
            case "print": print(confirmed: false)
            default: break
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
            for _ in 0..<80 where vm.busy != nil || printState == .printing { try? await Task.sleep(nanoseconds: 100_000_000) }
            try? await Task.sleep(nanoseconds: 800_000_000)
            let o = vm.order
            Swift.print("[Vinki] pedido \(o?.numberText ?? "?"): \(step) → aviso: \(vm.notice ?? "-"); estado \(o?.label ?? "?"), pagamento \(o?.payment?.statusLabel ?? "?"), impressão: \(printMessage ?? "-")")
        }
    }
    #endif

    private func header(_ o: PedidoOrder) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(o.numberText).font(.system(size: 24, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                Spacer()
                Pill(text: o.label, color: PedidoRules.color(o.state), filled: true)
            }
            HStack(spacing: 14) {
                Label(o.fulfillmentLabel ?? (o.delivery ? "Entrega" : "Retirada"), systemImage: o.delivery ? "bicycle" : "bag.fill")
                if let created = o.created { Label(BrasiliaTime.shortWithTime(created), systemImage: "calendar") }
                if let eta = o.etaAt { Label("Previsão \(BrasiliaTime.clock(eta))", systemImage: "clock") }
            }
            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            if let note = o.note, !note.isEmpty {
                Label(note, systemImage: "text.bubble").font(Theme.font(14)).foregroundStyle(Theme.textPrimary)
                    .accessibilityLabel("Observação do cliente: \(note)")
            }
            if let notes = o.notes, !notes.isEmpty {
                Label(notes, systemImage: "lock.fill").font(Theme.font(13)).foregroundStyle(Theme.noteText)
                    .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubbleNote))
                    .accessibilityLabel("Observação interna: \(notes)")
            }
            if let reason = o.cancelReason, !reason.isEmpty {
                Text("Motivo do cancelamento: \(reason)").font(Theme.font(13)).foregroundStyle(Theme.danger)
            }
        }
        .card(padding: 16)
    }

    @ViewBuilder
    private func actions(_ o: PedidoOrder) -> some View {
        let list = PedidoRules.actions(for: o)
        if !list.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(list, id: \.status) { action in
                    let color = action.status == "cancelled" ? Theme.danger : PedidoRules.color(action.status)
                    Button {
                        note = ""
                        notify = o.customer?.conversationId != nil
                        confirming = action
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busy == "status:\(action.status)" { ProgressView().scaleEffect(0.7) }
                            Text(action.title).font(Theme.font(14, .semibold)).lineLimit(2).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(color)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.12)))
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(vm.busy != nil)
                    .accessibilityIdentifier("pedido.action.\(action.status)")
                }
            }
        }
    }

    private func confirmSheet(_ action: (status: String, title: String)) -> some View {
        let cancel = action.status == "cancelled"
        let hasChat = vm.order?.customer?.conversationId != nil
        return VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: action.title) { confirming = nil }
            if cancel {
                Text("Uma cobrança Pix ou link aberta é cancelada junto. Se o cliente pagar mesmo assim, o pedido fica marcado para estorno.")
                    .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                AuthField(label: "Motivo (vai ao cliente)") { TextField("Ex.: acabou o pão de hambúrguer", text: $note) }
            } else {
                AuthField(label: "Observação no histórico (opcional)") { TextField("Ex.: motoboy João", text: $note) }
            }
            if hasChat {
                Toggle("Avisar o cliente no WhatsApp", isOn: $notify).font(Theme.font(15))
            } else {
                Text("Pedido sem conversa ligada: o cliente não é avisado.").font(Theme.font(13)).foregroundStyle(Theme.warn)
            }
            PrimaryButton(title: action.title, color: cancel ? Theme.danger : Theme.brand, disabled: cancel && note.trimmingCharacters(in: .whitespaces).isEmpty) {
                let status = action.status
                confirming = nil
                vm.perform(status, note: cancel ? nil : note, reason: cancel ? note : nil, notify: notify && hasChat)
            }
            .accessibilityIdentifier("pedido.confirm")
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
    }

    /// Cada linha como veio: o mesmo item em duas montagens aparece duas vezes.
    private func itemsSection(_ o: PedidoOrder) -> some View {
        let lines = o.lines ?? []
        return SectionCard(title: "Itens") {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(line.quantity ?? 1)x \(line.name ?? "Item")").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        Text(Money.format(line.totalCents ?? 0)).font(Theme.font(14)).foregroundStyle(Theme.textPrimary)
                    }
                    ForEach(Array((line.options ?? []).enumerated()), id: \.offset) { _, option in
                        Text("+ \(option.name ?? "")" + ((option.priceCents ?? 0) > 0 ? " (\(Money.format(option.priceCents ?? 0)))" : ""))
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    }
                    if let note = line.note, !note.isEmpty {
                        Text("Obs.: \(note)").font(Theme.font(13, .semibold)).foregroundStyle(Theme.warn)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                ThinDivider().padding(.leading, 14)
            }
            CardRow(title: "Subtotal", value: Money.format(o.subtotalCents ?? 0))
            if o.delivery { CardRow(title: "Entrega", value: Money.format(o.deliveryFeeCents ?? 0)) }
            CardRow(title: "Total", value: Money.format(o.totalCents ?? 0), titleColor: Theme.textPrimary, divider: false)
        }
    }

    private func paymentSection(_ o: PedidoOrder) -> some View {
        let p = o.payment
        return SectionCard(title: "Pagamento") {
            CardRow(icon: "creditcard.fill", iconColor: PedidoRules.paymentColor(p?.status), title: p?.methodLabel ?? "A definir",
                    subtitle: [p?.statusLabel, p?.changeForCents.map { "troco para \(Money.format($0))" }, p?.error].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                    divider: p?.needsRefund == true || PedidoRules.canChooseMethod(o) || PedidoRules.canMarkPaid(o))
            if p?.needsRefund == true {
                CardRow(icon: "exclamationmark.triangle.fill", iconColor: Theme.danger, title: "Pago depois de cancelado: estornar no Mercado Pago", divider: PedidoRules.canChooseMethod(o) || PedidoRules.canMarkPaid(o))
            }
            if PedidoRules.canChooseMethod(o) {
                ForEach(PedidoRules.staffMethods, id: \.id) { m in
                    Button { vm.setMethod(m.id) } label: {
                        CardRow(icon: m.id == "cash" ? "banknote" : "creditcard", iconColor: Theme.brand, title: "Vai pagar com \(m.title.lowercased())", chevron: true)
                    }
                    .buttonStyle(.plain).disabled(vm.busy != nil)
                    .accessibilityIdentifier("pedido.method.\(m.id)")
                }
            }
            if PedidoRules.canMarkPaid(o) {
                Button { confirmPaid = true } label: {
                    CardRow(icon: "checkmark.circle.fill", iconColor: Theme.ok, title: "Registrar pagamento recebido", chevron: true, divider: false)
                }
                .buttonStyle(.plain).disabled(vm.busy != nil)
                .accessibilityIdentifier("pedido.paid")
            }
        }
    }

    private func customerSection(_ o: PedidoOrder) -> some View {
        SectionCard(title: o.delivery ? "Cliente e entrega" : "Cliente") {
            CardRow(icon: "person.fill", iconColor: Theme.brand, title: o.customerName, subtitle: PhoneText.display(o.customer?.phone))
            if o.delivery {
                CardRow(icon: "mappin.and.ellipse", iconColor: Theme.ticket, title: o.addressText?.isEmpty == false ? o.addressText! : "Endereço não informado",
                        subtitle: o.address?.reference?.isEmpty == false ? "Referência: \(o.address!.reference!)" : nil)
            }
            if let conversation = o.customer?.conversationId {
                Button { push(.conversation(id: conversation)) } label: {
                    CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true, divider: false)
                }
                .buttonStyle(.plain)
            } else {
                CardRow(icon: "tray.and.arrow.down.fill", iconColor: Theme.muted, title: "Origem", value: sourceLabel(o.source), divider: false)
            }
        }
    }

    private func historySection(_ o: PedidoOrder) -> some View {
        SectionCard(title: "Histórico") {
            let entries = (o.history ?? []).reversed()
            if entries.isEmpty { CardRow(title: "Sem registros ainda.", divider: false) }
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, h in
                CardRow(icon: "clock.arrow.circlepath", iconColor: PedidoRules.color(h.toStatus ?? ""), title: PedidoRules.historyText(h),
                        subtitle: [h.note, actorLabel(h.actor)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                        value: h.created.map(BrasiliaTime.shortWithTime), divider: index < entries.count - 1)
            }
        }
    }

    /// A comanda montada pelo servidor, na impressora escolhida no app.
    private func printSection(_ o: PedidoOrder) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SecondaryButton(title: "Imprimir comanda", icon: "printer.fill", busy: printState == .printing) { print(confirmed: false) }
                .accessibilityIdentifier("pedido.print")
            if let text = printMessage {
                Text(text).font(Theme.font(13)).foregroundStyle(printState?.isFailure == true ? Theme.danger : Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if printState == .noPrinter {
                Button("Escolher impressora") { showPrinter = true }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
            }
        }
        .sheet(isPresented: $showPrinter) { PrinterScreen { showPrinter = false } }
        .confirmationDialog("A comanda saiu?", isPresented: $confirmReprint, titleVisibility: .visible) {
            Button("Nada saiu, imprimir") { print(confirmed: true) }
            Button("Saiu, cancelar", role: .cancel) {}
        } message: {
            Text("A impressora pode ter impresso sem confirmar. Imprima de novo só se nada saiu.")
        }
    }

    private var printMessage: String? {
        switch printState {
        case .printing?: return "Imprimindo…"
        case .printed?: return "Enviada à impressora. Confira o papel."
        case .noPrinter?: return "Nenhuma impressora escolhida neste aparelho."
        case let .failed(message, _)?: return "A comanda não saiu: \(message)"
        case nil: return nil
        }
    }

    private func print(confirmed: Bool) {
        if case let .failed(_, needsConfirmation)? = printState, needsConfirmation, !confirmed {
            confirmReprint = true
            return
        }
        guard WabotiaPrinting.shared.hasPrinter else { printState = .noPrinter; return }
        printState = .printing
        Task {
            do {
                let texts = try await vm.tickets()
                printState = await WabotiaPrinting.shared.printPedido(texts)
            } catch {
                printState = .failed(message: ModuleFailure.message(error), reprintNeedsConfirmation: false)
            }
        }
    }

    private func actorLabel(_ actor: String?) -> String? {
        guard let actor else { return nil }
        if actor == "customer" { return "pelo cliente" }
        if actor == "provider" { return "pelo Mercado Pago" }
        if actor.hasPrefix("system") || actor == "module" { return "automático" }
        return nil
    }

    private func sourceLabel(_ source: String?) -> String {
        switch source {
        case "cart": return "Carrinho pelo WhatsApp"
        case "catalog": return "Catálogo do WhatsApp"
        case "panel": return "Balcão"
        case "api": return "Integração"
        default: return source ?? "—"
        }
    }
}
