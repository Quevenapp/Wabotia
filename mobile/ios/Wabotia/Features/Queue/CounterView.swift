import SwiftUI

/// Guichê da fila de senhas (Ajustes → Atendimento): o atendente escolhe o guichê deste aparelho e chama as senhas
/// com a própria conta. Ao vivo por WebSocket enquanto a tela está à frente, com leitura a cada 5 s sem ele.
struct CounterView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var vm: CounterViewModel
    @State private var choosing = false
    @State private var transferring = false

    init(vm: CounterViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? CounterViewModel(container: AppContainer.shared))
    }

    var body: some View {
        Group {
            if vm.loading && vm.overview == nil {
                SkeletonList(rows: 5, avatar: false)
            } else if let error = vm.error, vm.overview == nil {
                VStack { InlineError(text: error) { Task { await vm.reload() } }.padding(16); Spacer() }
            } else if vm.counter == nil || choosing {
                CounterPicker(
                    counters: vm.overview?.counters ?? [],
                    selected: vm.counterId,
                    onChoose: { id in
                        vm.chooseCounter(id)
                        choosing = false
                    },
                    onCancel: vm.counterId != nil && choosing ? { choosing = false } : nil
                )
            } else {
                counterBody
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.counter?.displayName ?? "Guichê")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Text(vm.live ? "● ao vivo" : (container.isDemo ? "● demonstração" : "Fila de senhas"))
                    .font(Theme.font(12, .semibold)).foregroundStyle(vm.live ? Theme.ok : Theme.textSecondary)
            }
        }
        .onAppear { vm.start() }
        .onDisappear { vm.stop() }
        #if DEBUG
        .task {
            // WABOTIA_DEMO_ACTION=call (só depuração): o guichê 2 chama a próxima, para conferir por print.
            guard container.isDemo, DemoMode.action == "call" else { return }
            for _ in 0..<60 where vm.overview == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
            vm.chooseCounter("dc-2")
            vm.callNext()
        }
        #endif
        .onChange(of: scenePhase) { phase in if phase == .active { vm.start() } else { vm.stop() } }
        .sheet(isPresented: $transferring) {
            if let ticket = vm.current {
                CounterTransferSheet(ticket: ticket, queues: vm.overview?.queues ?? [], counters: (vm.overview?.counters ?? []).filter { $0.id != vm.counterId }) { queue, counter in
                    transferring = false
                    vm.transfer(queueId: queue, counterId: counter)
                }
            }
        }
    }

    private var counterBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let notice = vm.notice {
                    InlineError(text: notice).onTapGesture { vm.notice = nil }
                }
                if let counter = vm.counter {
                    stateCard(counter)
                    currentCard(counter)
                    if counter.state == "open" || vm.current == nil {
                        PrimaryButton(title: "Chamar próxima", icon: "megaphone.fill", busy: vm.isBusy("call:"), disabled: counter.state != "open" || vm.busy != nil, action: vm.callNext)
                            .accessibilityIdentifier("counter.callNext")
                        if counter.state != "open" {
                            Text("Abra o guichê para chamar senhas.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    queuesSection
                    recentSection
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await vm.reload() }
    }

    private func stateCard(_ counter: CounterInfo) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(counter.displayName).font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
                    Text(counter.userName.map { "Com \($0)" } ?? "Sem atendente").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Pill(text: CounterViewModel.statusLabel(counter.state), color: statusColor(counter.state), filled: counter.state == "open")
                Button("Trocar") { choosing = true }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                    .frame(minHeight: Theme.touch).padding(.leading, 6)
            }
            HStack(spacing: 8) {
                stateButton("Abrir", "open", "play.fill", counter)
                stateButton("Pausar", "paused", "pause.fill", counter)
                stateButton("Fechar", "closed", "stop.fill", counter)
            }
        }
        .card(padding: 14)
    }

    private func stateButton(_ title: String, _ status: String, _ icon: String, _ counter: CounterInfo) -> some View {
        let selected = counter.state == status
        return Button { vm.setStatus(status) } label: {
            HStack(spacing: 6) {
                if vm.isBusy("state:\(counter.id):\(status)") { ProgressView().scaleEffect(0.7) } else { Image(systemName: icon).font(.system(size: 12, weight: .bold)) }
                Text(title).font(Theme.font(14, .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 40)
            .foregroundStyle(selected ? Theme.onBrand : statusColor(status))
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(selected ? statusColor(status) : statusColor(status).opacity(0.12)))
        }
        .buttonStyle(PressScaleStyle())
        .disabled(vm.busy != nil || selected)
        .accessibilityIdentifier("counter.state.\(status)")
    }

    @ViewBuilder
    private func currentCard(_ counter: CounterInfo) -> some View {
        if let ticket = vm.current {
            let state = ticket.state
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(ticket.displayCode).font(.system(size: 44, weight: .black, design: .rounded)).foregroundStyle(Theme.textPrimary)
                        .accessibilityIdentifier("counter.current.code")
                    Spacer()
                    Pill(text: CounterViewModel.ticketStatusLabel(state), color: state == "serving" ? Theme.ok : Theme.warn)
                }
                Text([ticket.typeLabel, ticket.queueName].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                if (ticket.callCount ?? 0) > 1 {
                    Text("Chamada \(ticket.callCount ?? 0) vezes").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                }
                if let phone = ticket.phone, !phone.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "phone.fill").font(.system(size: 12)).foregroundStyle(Theme.brand)
                        Text(formatPhone(phone)).font(Theme.font(14)).foregroundStyle(Theme.textPrimary)
                        if ticket.windowOpen == false {
                            Pill(text: "fora da janela", color: Theme.muted, icon: "lock.fill")
                        }
                    }
                }
                if let conversation = ticket.conversationId {
                    Button { push(.conversation(id: conversation)) } label: {
                        Label("Abrir conversa no WhatsApp", systemImage: "bubble.left.and.bubble.right.fill")
                            .font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                    }
                    .frame(minHeight: Theme.touch)
                }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    if state == "called" {
                        action("Rechamar", "recall", "speaker.wave.2.fill", Theme.ticket)
                        action("Iniciar", "start", "person.fill.checkmark", Theme.ok)
                    }
                    if state == "called" || state == "serving" {
                        action("Concluir", "finish", "checkmark.circle.fill", Theme.brand)
                    }
                    if state == "called" {
                        action("Ausente", "no-show", "person.fill.xmark", Theme.danger)
                    }
                    if state == "called" || state == "serving" {
                        Button { transferring = true } label: { actionLabel("Transferir", "arrow.left.arrow.right", Theme.bot, busy: vm.isBusy("transfer:")) }
                            .buttonStyle(PressScaleStyle()).disabled(vm.busy != nil)
                            .accessibilityIdentifier("counter.transfer")
                    }
                }
            }
            .card(padding: 16)
        } else {
            HStack(spacing: 12) {
                Image(systemName: "ticket").font(.system(size: 22)).foregroundStyle(Theme.muted)
                Text("Nenhuma senha neste guichê").font(Theme.font(15)).foregroundStyle(Theme.textSecondary)
                Spacer()
            }
            .card(padding: 16)
        }
    }

    private func action(_ title: String, _ action: String, _ icon: String, _ color: Color) -> some View {
        Button { vm.act(action) } label: { actionLabel(title, icon, color, busy: vm.isBusy("\(action):")) }
            .buttonStyle(PressScaleStyle())
            .disabled(vm.busy != nil)
            .accessibilityIdentifier("counter.action.\(action)")
    }

    private func actionLabel(_ title: String, _ icon: String, _ color: Color, busy: Bool) -> some View {
        HStack(spacing: 6) {
            if busy { ProgressView().scaleEffect(0.7) } else { Image(systemName: icon).font(.system(size: 13, weight: .semibold)) }
            Text(title).font(Theme.font(15, .semibold))
        }
        .frame(maxWidth: .infinity, minHeight: 46)
        .foregroundStyle(color)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.12)))
    }

    private var queuesSection: some View {
        SectionCard(title: "Filas deste guichê") {
            if vm.servedQueues.isEmpty {
                CardRow(title: "Este guichê não atende nenhuma fila.", divider: false)
            }
            ForEach(Array(vm.servedQueues.enumerated()), id: \.element.id) { index, queue in
                CardRow(icon: "person.3.fill", iconColor: Theme.ticket, title: queue.displayName,
                        subtitle: waitingText(queue), divider: index < vm.servedQueues.count - 1)
            }
        }
    }

    @ViewBuilder
    private var recentSection: some View {
        let calls = Array((vm.overview?.recentCalls ?? []).prefix(6))
        if !calls.isEmpty {
            SectionCard(title: "Últimas chamadas") {
                ForEach(Array(calls.enumerated()), id: \.offset) { index, call in
                    CardRow(title: call.code ?? "—", subtitle: [call.counterName, call.queueName].compactMap { $0 }.joined(separator: " · "),
                            value: call.at.map(clock), divider: index < calls.count - 1)
                }
            }
        }
    }

    private func waitingText(_ queue: QueueInfo) -> String {
        let normal = queue.waiting?.normal ?? 0, preferential = queue.waiting?.preferential ?? 0
        var text = "\(normal) normal · \(preferential) preferencial"
        if let minutes = queue.waitMinutes?.normal { text += " · cerca de \(minutes) min" }
        return text
    }

    private func clock(_ millis: Int64) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(millis) / 1000))
    }

    private func formatPhone(_ phone: String) -> String {
        let digits = phone.filter(\.isNumber)
        guard digits.hasPrefix("55"), digits.count >= 12 else { return "+" + digits }
        let local = digits.dropFirst(2)
        let ddd = local.prefix(2), rest = local.dropFirst(2)
        return "(\(ddd)) \(rest.prefix(rest.count - 4))-\(rest.suffix(4))"
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "open": return Theme.ok
        case "paused": return Theme.warn
        default: return Theme.muted
        }
    }
}

/// Escolha do guichê deste aparelho, guardada por perfil.
private struct CounterPicker: View {
    let counters: [CounterInfo]
    let selected: String?
    let onChoose: (String) -> Void
    let onCancel: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Qual guichê é este?").font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
                Text("A escolha fica neste aparelho. Você chama as senhas com a sua conta.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                if counters.isEmpty {
                    EmptyStateView(title: "Nenhum guichê cadastrado", systemImage: "rectangle.stack.badge.person.crop",
                                   message: "Um administrador cria os guichês no painel do Wabotia, em Fila de senhas. Depois eles aparecem aqui.")
                } else {
                    SectionCard {
                        ForEach(Array(counters.enumerated()), id: \.element.id) { index, counter in
                            Button { onChoose(counter.id) } label: {
                                CardRow(icon: "person.crop.rectangle", iconColor: counter.state == "open" ? Theme.ok : Theme.muted, title: counter.displayName,
                                        subtitle: [CounterViewModel.statusLabel(counter.state), counter.userName].compactMap { $0 }.joined(separator: " · "),
                                        divider: index < counters.count - 1) {
                                    if counter.id == selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.brand) }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("counter.choose.\(counter.id)")
                        }
                    }
                }
                if let onCancel {
                    Button("Cancelar", action: onCancel).font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                        .frame(maxWidth: .infinity, minHeight: Theme.touch)
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
    }
}

/// Para outra fila ou outro guichê, com confirmação na própria folha.
private struct CounterTransferSheet: View {
    let ticket: QueueTicket
    let queues: [QueueInfo]
    let counters: [CounterInfo]
    let onTransfer: (String?, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var confirm: (queue: String?, counter: String?, label: String)?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Transferir \(ticket.displayCode)", subtitle: "A senha volta a aguardar no destino, na ordem de emissão.") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let confirm {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Transferir \(ticket.displayCode) para \(confirm.label)?").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                            PrimaryButton(title: "Transferir") { onTransfer(confirm.queue, confirm.counter) }
                                .accessibilityIdentifier("counter.transfer.confirm")
                            SecondaryButton(title: "Escolher outro destino") { self.confirm = nil }
                        }
                        .card(padding: 16)
                    } else {
                        let otherQueues = queues.filter { $0.id != ticket.queueId }
                        if !otherQueues.isEmpty {
                            SectionCard(title: "Filas") {
                                ForEach(Array(otherQueues.enumerated()), id: \.element.id) { index, queue in
                                    Button { confirm = (queue.id, nil, "a fila \(queue.displayName)") } label: {
                                        CardRow(icon: "person.3.fill", iconColor: Theme.ticket, title: queue.displayName, subtitle: "\(queue.waiting?.total ?? 0) aguardando",
                                                chevron: true, divider: index < otherQueues.count - 1)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        if !counters.isEmpty {
                            SectionCard(title: "Guichês") {
                                ForEach(Array(counters.enumerated()), id: \.element.id) { index, counter in
                                    Button { confirm = (nil, counter.id, counter.displayName) } label: {
                                        CardRow(icon: "person.crop.rectangle", iconColor: Theme.bot, title: counter.displayName,
                                                subtitle: CounterViewModel.statusLabel(counter.state), chevron: true, divider: index < counters.count - 1)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("counter.transfer.to.\(counter.id)")
                                }
                            }
                        }
                        if otherQueues.isEmpty && counters.isEmpty {
                            Text("Não há outra fila nem outro guichê para receber a senha.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }
}
