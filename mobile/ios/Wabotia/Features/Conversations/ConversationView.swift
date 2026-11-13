import SwiftUI

/// Tela da conversa (mobile/DESIGN.md, seção 5): barra própria no estilo WhatsApp, faixa da janela de 24 h,
/// mensagens em bolhas sobre o papel de parede e rodapé conforme o estado (composer ou cartão de ação).
struct ConversationView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.pushRoute) private var push
    @StateObject private var vm: ConversationViewModel
    @ObservedObject private var workspace = Workspace.shared
    let conversationId: String

    @State private var transferTab: TransferSheet.Tab?
    @State private var showTags = false
    @State private var showBots = false
    @State private var pendingBot: Bot?
    @State private var showSaveContact = false
    @State private var showWindowInfo = false
    @State private var confirmResolve = false
    @State private var confirmResume = false
    @State private var confirmSurvey = false
    @State private var actionsFor: ChatMessage?
    @State private var confirmDelete: ChatMessage?
    @State private var failedMessage: ChatMessage?
    @State private var atBottom = true
    @State private var newCount = 0
    @State private var highlighted: String?
    @State private var didOpen = false

    init(conversationId: String) {
        self.conversationId = conversationId
        _vm = StateObject(wrappedValue: ConversationViewModel(conversationId: conversationId))
    }

    private var profileId: String { container.profileId ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let clock = vm.window, vm.conversation?.state != "closed" {
                WindowBanner(clock: clock) { showWindowInfo = true }
            }
            messagesArea
            if vm.conversation != nil { footer }
        }
        .background(Theme.chatWallpaper.ignoresSafeArea())
        .appNavigationBarHidden(true)
        .overlay {
            if let target = actionsFor {
                MessageActionsPanel(item: target, vm: vm, onDelete: { confirmDelete = target }) { actionsFor = nil }
                    .transition(.opacity)
            }
        }
        .animation(.quick, value: actionsFor)
        .onAppear {
            PushManager.shared.visibleConversationId = conversationId
            vm.appear()
        }
        .onDisappear {
            if PushManager.shared.visibleConversationId == conversationId { PushManager.shared.visibleConversationId = nil }
            vm.disappear()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await vm.load(silent: true) } }
        }
        .sheet(item: $transferTab) { tab in
            TransferSheet(vm: vm, initialTab: tab) { ticketId in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { push(.ticket(id: ticketId)) }
            }
        }
        .sheet(isPresented: $showTags) { TagsSheet(vm: vm) }
        .sheet(isPresented: $showBots, onDismiss: {
            if let bot = pendingBot { pendingBot = nil; push(.bot(id: bot.id, conversationId: conversationId)) }
        }) { BotPickerSheet { bot in pendingBot = bot } }
        .sheet(isPresented: $showSaveContact) { SaveContactSheet(vm: vm) }
        .sheet(isPresented: $showWindowInfo) { WindowInfoSheet(clock: vm.window) }
        .confirmationDialog("Concluir este atendimento?", isPresented: $confirmResolve, titleVisibility: .visible) {
            Button("Concluir", role: .destructive) { Task { if await vm.resolve() { dismiss() } } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("A conversa é marcada como concluída e sai da sua lista.") }
        .confirmationDialog("Devolver a conversa ao bot?", isPresented: $confirmResume, titleVisibility: .visible) {
            Button("Devolver ao bot") { Task { await vm.resumeAutomation() } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O atendimento automático do perfil volta a responder o cliente.") }
        .confirmationDialog("Enviar pesquisa de satisfação?", isPresented: $confirmSurvey, titleVisibility: .visible) {
            Button("Enviar pesquisa") { Task { await vm.sendSurvey() } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O cliente recebe a pergunta e responde com uma nota de 1 a 5.") }
        .alert("Apagar mensagem?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("Apagar", role: .destructive) {
                if let target = confirmDelete { Task { await vm.messageAction("delete", message: target.message) } }
                confirmDelete = nil
            }
            Button("Cancelar", role: .cancel) { confirmDelete = nil }
        } message: { Text("A mensagem também será apagada no WhatsApp do cliente.") }
        .alert("A mensagem não foi entregue", isPresented: Binding(get: { failedMessage != nil }, set: { if !$0 { failedMessage = nil } })) {
            if vm.isOwned, failedMessage?.message.text.isEmpty == false {
                Button("Tentar de novo") {
                    if let m = failedMessage { vm.retry(m.message) }
                    failedMessage = nil
                }
            }
            Button("OK", role: .cancel) { failedMessage = nil }
        } message: { Text("O WhatsApp recusou a entrega. Confira o número do cliente e a janela de 24 horas." + (vm.isOwned ? " Tentar de novo devolve o texto ao campo de mensagem." : "")) }
    }

    // MARK: Barra superior

    private var header: some View {
        HStack(spacing: 0) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.brand)
                    .frame(width: 38, height: Theme.touch)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Voltar")

            Button { push(.conversationInfo(id: conversationId)) } label: {
                HStack(spacing: 9) {
                    AvatarView(name: vm.displayName, seed: conversationId, kind: vm.isGroup ? .group : .person, size: 38, badge: vm.conversation.map { .role($0.role(me: vm.meId)) }, ring: Theme.bar)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(vm.displayName).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        if let c = vm.conversation {
                            Text(workspace.headerStatus(c))
                                .font(Theme.font(12))
                                .foregroundStyle(c.state == "waiting" ? Theme.warn : Theme.textSecondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(vm.displayName). Abrir dados da conversa")

            if let c = vm.conversation {
                headerIcon("arrowshape.turn.up.right", "Transferir") {
                    if vm.canTransfer { transferTab = .people }
                    else { workspace.show(c.state == "closed" ? "Reabra a conversa para transferir" : "Assuma a conversa para transferir") }
                }
                actionsMenu(c)
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 4)
        .frame(height: 54)
        .background(Theme.bar.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { ThinDivider() }
    }

    private func headerIcon(_ systemName: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 19, weight: .regular))
                .foregroundStyle(Theme.brand)
                .frame(width: 40, height: Theme.touch)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func actionsMenu(_ c: Conversation) -> some View {
        Menu {
            Button { showTags = true } label: { Label("Etiquetas", systemImage: "tag") }
            Button { push(.newTicket(conversationId: conversationId)) } label: { Label("Abrir protocolo", systemImage: "doc.text") }
            if vm.canTransfer {
                Button { transferTab = .menu } label: { Label("Enviar menu", systemImage: "list.bullet") }
            }
            if vm.isOwned {
                Button { confirmResume = true } label: { Label("Devolver ao bot", systemImage: "cpu") }
                if !c.isGroup {
                    Button { confirmSurvey = true } label: { Label("Pesquisa de satisfação", systemImage: "star") }
                }
            }
            Button { showBots = true } label: { Label("Consultar bot", systemImage: "text.bubble") }
            if !c.isGroup {
                if vm.hasLinkedContact {
                    // Já vinculado: PUT /contact devolveria 409; edição/desvínculo ficam no painel.
                    Button {} label: { Label("Contato salvo", systemImage: "person.crop.circle.badge.checkmark") }.disabled(true)
                } else {
                    Button { showSaveContact = true } label: { Label("Salvar contato", systemImage: "person.crop.circle.badge.plus") }
                }
            }
            Divider()
            Button { Task { await vm.load(); await vm.loadPresence() } } label: { Label("Atualizar", systemImage: "arrow.clockwise") }
            if vm.isOwned {
                Button(role: .destructive) { confirmResolve = true } label: { Label("Concluir", systemImage: "checkmark.circle") }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(Theme.brand)
                .rotationEffect(.degrees(90))
                .frame(width: 36, height: Theme.touch)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Mais ações")
    }

    // MARK: Mensagens

    /// A lista é invertida (espelhada na vertical, com as linhas espelhadas de volta): a origem da rolagem
    /// passa a ser o fim da conversa. Assim ela abre no fim, continua no fim quando chega mensagem e quando
    /// o teclado ou a faixa de resposta encolhem a área, sem depender de "rolar até o fim" depois do layout.
    @ViewBuilder private var messagesArea: some View {
        if vm.loading && vm.detail == nil {
            VStack { Spacer(); ProgressView(); Spacer() }.frame(maxWidth: .infinity)
        } else if let error = vm.error, vm.detail == nil {
            VStack(spacing: 12) {
                Spacer()
                InlineError(text: error) { Task { await vm.load() } }.padding(24)
                Spacer()
            }
        } else {
            GeometryReader { geo in
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 0) {
                            // Marca do fim da conversa (origem da rolagem). Fica fora da pilha preguiçosa:
                            // existe sempre, então diz com certeza se a pessoa está no fim.
                            Color.clear.frame(height: 8).id("bottom")
                                .background(GeometryReader { marker in
                                    Color.clear.preference(key: BottomMarkerKey.self, value: marker.frame(in: .named("chat")).minY)
                                })
                            // Conversa curta: as mensagens começam no alto da tela, não coladas no rodapé.
                            Spacer(minLength: 0)
                            LazyVStack(spacing: 0) {
                                ForEach(vm.timeline.reversed()) { day in
                                    ForEach(day.items.reversed()) { item in
                                        itemView(item, maxWidth: min(geo.size.width * 0.8, 520), proxy: proxy)
                                            .flippedVertically()
                                            .id(item.id)
                                    }
                                    ChatChip(text: day.title).padding(.vertical, 6).flippedVertically()
                                }
                                if vm.timeline.isEmpty {
                                    ChatChip(text: "Nenhuma mensagem ainda").padding(.vertical, 24).flippedVertically()
                                }
                            }
                        }
                        .padding(.horizontal, 6)
                        .frame(minHeight: geo.size.height)
                    }
                    .coordinateSpace(name: "chat")
                    .flippedVertically()
                    .appScrollDismissesKeyboard()
                    .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
                    .onPreferenceChange(BottomMarkerKey.self) { y in
                        // y = quanto a pessoa rolou para longe do fim (0 no fim, negativo ao subir).
                        let now = y > -120
                        if now != atBottom {
                            atBottom = now
                            if now { newCount = 0 }
                        }
                    }
                    .onChange(of: vm.scrollToken) { _ in
                        if atBottom { scrollToBottom(proxy) }
                    }
                    .onChange(of: vm.forceScrollToken) { _ in scrollToBottom(proxy) }
                    .onChange(of: vm.messages.count) { [old = vm.messages.count] new in
                        if !atBottom, new > old { newCount += vm.messages.suffix(new - old).filter(\.isIncoming).count }
                    }
                    .onChange(of: vm.timeline.isEmpty) { empty in
                        if !empty { opened(proxy) }
                    }
                    .onAppear { if !vm.timeline.isEmpty { opened(proxy) } }
                    .overlay(alignment: .bottomTrailing) {
                        if !atBottom {
                            Button { scrollToBottom(proxy); newCount = 0 } label: {
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(Theme.textSecondary)
                                    .frame(width: 40, height: 40)
                                    .background(Circle().fill(Theme.bubbleIn))
                                    .shadow(color: Theme.shadow, radius: 3, y: 1)
                                    .overlay(alignment: .topTrailing) {
                                        if newCount > 0 { CountBadge(count: newCount).offset(x: 6, y: -8) }
                                    }
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, 10)
                            .padding(.bottom, 10)
                            .transition(.scale.combined(with: .opacity))
                            .accessibilityLabel(newCount > 0 ? "Ir para o fim, \(newCount) mensagens novas" : "Ir para o fim")
                        }
                    }
                    .animation(.quick, value: atBottom)
                }
            }
        }
    }

    @ViewBuilder
    private func itemView(_ item: ChatItem, maxWidth: CGFloat, proxy: ScrollViewProxy) -> some View {
        switch item {
        case .event(let event):
            ChatChip(text: event.text, icon: event.icon).padding(.vertical, 5)
        case .pending(let bubble):
            PendingBubbleView(bubble: bubble, maxWidth: maxWidth) { vm.dismissPending(bubble) }
                .padding(.top, 6)
        case .message(let message):
            MessageBubbleView(
                item: message, profileId: profileId, maxWidth: maxWidth, isGroup: vm.isGroup,
                actionable: vm.isActionable(message), canReply: vm.isActionable(message) && vm.can("reply"),
                onLongPress: { hideKeyboard(); Haptics.medium(); actionsFor = message },
                onReply: { vm.beginReply(message.message) },
                onQuoteTap: { id in jump(to: id, proxy) },
                onFailedTap: { failedMessage = message }
            )
            .equatable()
            .padding(.top, message.firstInGroup ? 7 : 2)
            .background(highlighted == message.id ? Theme.brand.opacity(0.16) : Color.clear)
        }
    }

    /// Primeira vez com mensagens na tela.
    private func opened(_ proxy: ScrollViewProxy) {
        guard !didOpen else { return }
        didOpen = true
        #if DEBUG
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            // Na lista invertida, a âncora `.bottom` é o alto da tela.
            if let anchor = DemoMode.anchor, anchor != "bottom" { proxy.scrollTo(anchor, anchor: .bottom) }
            demoSheets()
        }
        #endif
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.quick) { proxy.scrollTo("bottom", anchor: .top) }
    }

    /// Toque na citação: rola até a mensagem original e a destaca por um instante.
    private func jump(to id: String, _ proxy: ScrollViewProxy) {
        withAnimation(.quick) { proxy.scrollTo(id, anchor: .center) }
        highlighted = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { if highlighted == id { withAnimation(.quick) { highlighted = nil } } }
    }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func demoSheets() {
        #if DEBUG
        switch DemoMode.takeSheet("transfer", "transfer-bots", "transfer-departments", "transfer-menu", "transfer-ticket", "transfer-confirm", "actions", "window", "tags", "reply", "push-info", "do-claim", "do-send", "do-transfer") {
        case "push-info": push(.conversationInfo(id: conversationId))
        case "do-claim": Task { await vm.claim() }
        case "do-send":
            vm.draft = "Mariana, a coleta está confirmada para amanhã cedo."
            vm.send()
        case "do-transfer":
            if let ana = workspace.people.first(where: { $0.id == "u_ana" }) { Task { _ = await vm.transfer(to: ana) } }
        case "transfer": transferTab = .people
        case "transfer-confirm": TransferSheet.demoConfirm = true; transferTab = .people
        case "transfer-bots": transferTab = .bots
        case "transfer-departments": transferTab = .departments
        case "transfer-menu": transferTab = .menu
        case "transfer-ticket": transferTab = .ticket
        case "window": showWindowInfo = true
        case "tags": showTags = true
        case "actions":
            for day in vm.timeline { for case .message(let m) in day.items where m.id == "m12" { actionsFor = m } }
        case "reply":
            if let m = vm.messages.first(where: { $0.id == "m5" }) { vm.beginReply(m) }
        default: break
        }
        #endif
    }

    // MARK: Rodapé conforme o estado

    @ViewBuilder private var footer: some View {
        Group {
            if vm.isOwned {
                ComposerView(vm: vm, onMenu: { transferTab = .menu }, onTicket: { push(.newTicket(conversationId: conversationId)) })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let c = vm.conversation {
                stateCard(c).transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.quick, value: vm.isOwned)
    }

    private func stateCard(_ c: Conversation) -> some View {
        let role = c.role(me: vm.meId)
        return VStack(spacing: 10) {
            if let e = vm.actionError { InlineError(text: e) }
            HStack(spacing: 8) {
                switch role {
                case .waiting:
                    Image(systemName: "hourglass").foregroundStyle(Theme.warn)
                    Text("Na fila há \(ConversationFormatting.elapsed(since: c.updated, now: workspace.nowMillis))")
                case .bot:
                    RobotIcon(size: 16)
                    Text(workspace.assignedBotName(c).map { "O bot \($0) está atendendo" } ?? "O atendimento automático está respondendo")
                case .other:
                    Image(systemName: "person.fill").foregroundStyle(Theme.muted)
                    Text("Em atendimento com \(workspace.personName(c.owner))")
                case .closed:
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.muted)
                    Text("Conversa concluída")
                case .mine:
                    EmptyView()
                }
            }
            .font(Theme.font(14, .medium))
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(2)
            .multilineTextAlignment(.center)
            switch role {
            case .waiting, .bot:
                PrimaryButton(title: "Assumir conversa", icon: "person.fill.checkmark", busy: vm.busyAction == "claim") { Task { await vm.claim() } }
            case .closed:
                PrimaryButton(title: "Reabrir e assumir", icon: "arrow.uturn.backward", busy: vm.busyAction == "claim") { Task { await vm.claim() } }
            case .other:
                if vm.canTakeOver {
                    SecondaryButton(title: "Transferir para mim", icon: "person.fill.checkmark", busy: vm.busyAction == "transfer") { Task { await vm.claim() } }
                }
            case .mine:
                EmptyView()
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity)
        .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ThinDivider() }
    }
}

extension View {
    /// Espelha na vertical (lista de mensagens invertida e cada linha de volta ao normal).
    func flippedVertically() -> some View { scaleEffect(x: 1, y: -1, anchor: .center) }
}

private struct BottomMarkerKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Chip central da conversa (data, evento do atendimento).
struct ChatChip: View {
    let text: String
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            if let icon { Image(systemName: icon).font(.system(size: 10, weight: .semibold)) }
            Text(text).font(Theme.font(12, .medium)).multilineTextAlignment(.center)
        }
        .foregroundStyle(Theme.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.bubbleSystem))
        .shadow(color: Theme.shadow, radius: 0.5, y: 0.5)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 28)
    }
}

/// Faixa fixa da janela de 24 h logo abaixo da barra superior (altura 36).
struct WindowBanner: View {
    let clock: WindowClock
    var onTap: () -> Void

    var body: some View {
        let color = clock.level.color
        Button(action: onTap) {
            HStack(spacing: 8) {
                WindowRing(clock: clock, size: 20)
                Text(clock.bannerText)
                    .font(Theme.font(13, .medium))
                    .foregroundStyle(clock.level == .danger ? Theme.danger : Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 4)
                if let until = clock.untilLabel() {
                    Text(until).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1).fixedSize().layoutPriority(1)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(ZStack { Theme.background; if clock.level == .danger { Theme.danger.opacity(0.12) } })
            .overlay(alignment: .bottomLeading) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        color.opacity(0.2)
                        color.frame(width: geo.size.width * CGFloat(clock.fraction))
                    }
                }
                .frame(height: 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Explica a regra da janela de 24 horas")
    }
}

/// Envio feito aqui que ainda espera a entrega (relógio) ou que falhou.
struct PendingBubbleView: View {
    let bubble: PendingBubble
    let maxWidth: CGFloat
    var onDismiss: () -> Void

    private var failed: Bool { bubble.status == "failed" }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 3) {
                HStack(alignment: .bottom, spacing: 6) {
                    Text(bubble.text.isEmpty ? (failed ? "Mensagem não enviada" : "Mensagem na fila de envio") : bubble.text)
                        .font(Theme.font(16))
                        .italicIf(bubble.text.isEmpty)
                        .foregroundStyle(Theme.textPrimary)
                    HStack(spacing: 3) {
                        Text(ConversationFormatting.time(bubble.created)).font(Theme.font(11)).foregroundStyle(Theme.textSecondary)
                        TickView(status: failed ? "failed" : (bubble.status == "unknown" ? "unknown" : "pending"))
                    }
                    .padding(.bottom, 1)
                }
                if failed {
                    HStack(spacing: 8) {
                        Text(bubble.error?.isEmpty == false ? bubble.error! : "Falha no envio").font(Theme.font(12)).foregroundStyle(Theme.danger).lineLimit(2)
                        Button("Dispensar", action: onDismiss).font(Theme.font(12, .semibold)).foregroundStyle(Theme.brand)
                    }
                }
            }
            .padding(.leading, 9)
            .padding(.trailing, 9 + BubbleShape.tailWidth)
            .padding(.vertical, 6)
            .background(BubbleShape(tail: .trailing).fill(Theme.bubbleOut.opacity(failed ? 1 : 0.75)))
            .frame(maxWidth: maxWidth, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

private extension Text {
    func italicIf(_ active: Bool) -> Text { active ? self.italic() : self }
}

/// Explica a regra da janela em três linhas.
struct WindowInfoSheet: View {
    let clock: WindowClock?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            SheetHeader(title: "Janela de 24 horas") { dismiss() }
            if let clock {
                ProgressRing(fraction: clock.fraction, color: clock.level.color, size: 96, lineWidth: 8) {
                    VStack(spacing: 0) {
                        if clock.isClosed {
                            Image(systemName: "lock.fill").font(.system(size: 26)).foregroundStyle(Theme.muted)
                        } else {
                            Text(clock.label).font(Theme.font(15, .bold)).foregroundStyle(clock.level.color).minimumScaleFactor(0.6).lineLimit(1).padding(.horizontal, 8)
                            Text("restantes").font(Theme.font(10)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 12) {
                rule("clock", "O WhatsApp só aceita mensagem livre até 24 horas depois da última mensagem do cliente.")
                rule("arrow.clockwise", "Cada mensagem nova do cliente reinicia o prazo e o anel volta a encher.")
                rule("lock", "Com a janela fechada, o que você enviar fica guardado e é entregue quando o cliente escrever.")
            }
            .padding(.horizontal, 4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
    }

    private func rule(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.brand).frame(width: 22)
            Text(text).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}
