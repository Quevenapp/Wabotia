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
    @ObservedObject private var modules = ModuleFeature.shared
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
    @State private var confirmLink = false
    @State private var confirmRelease = false
    @State private var showCourtesy = false
    @State private var showForms = false
    @State private var showCharge = false
    @State private var showEmailTranscript = false
    @State private var ranScript = false

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
            if !vm.isComment, vm.channel != .whatsapp, let window = vm.channelWindow, window.showsClock {
                ChannelWindowSummary(window: window, channel: vm.channel)
            }
            if let detail = vm.detail { ChannelSecondWaveSummary(detail: detail, now: workspace.nowMillisPrecise, compact: true) }
            if !vm.otherConversations.isEmpty {
                Button { push(.conversationInfo(id: conversationId)) } label: {
                    Label("Há outras conversas deste contato", systemImage: "bubble.left.and.bubble.right")
                        .font(Theme.font(12)).padding(8).frame(maxWidth: .infinity)
                }.buttonStyle(.plain).foregroundStyle(Theme.brand).background(Theme.background)
            }
            if let handoff = vm.handoff, vm.conversation?.state != "closed" {
                HandoffBanner(handoff: handoff) { push(.conversationInfo(id: conversationId)) }
            }
            let items = ConversationItemsRules.recent(steps: vm.webSteps, payments: vm.payments, now: workspace.nowMillis)
            if !items.steps.isEmpty || !items.payments.isEmpty {
                ConversationItemsBar(steps: items.steps, payments: items.payments) { push(.conversationInfo(id: conversationId)) }
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
            ChannelTransferSheet(vm: vm, initialTab: tab) { ticketId in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { push(.ticket(id: ticketId)) }
            }
        }
        .sheet(isPresented: $showTags) { TagsSheet(vm: vm) }
        .sheet(isPresented: $showBots, onDismiss: {
            if let bot = pendingBot { pendingBot = nil; push(.bot(id: bot.id, conversationId: conversationId)) }
        }) { BotPickerSheet { bot in pendingBot = bot } }
        .sheet(isPresented: $showSaveContact) { SaveContactSheet(vm: vm) }
        .sheet(isPresented: $showEmailTranscript) {
            if let options = vm.detail?.email_transcript { EmailTranscriptSheet(conversationId: conversationId, options: options) }
        }
        .sheet(isPresented: $showWindowInfo) { WindowInfoSheet(clock: vm.window) }
        .sheet(isPresented: $showCourtesy) {
            CourtesySheet { reason, hours in showCourtesy = false; Task { await vm.suporteAction("courtesy", reason: reason, hours: hours) } }
        }
        .sheet(isPresented: $showForms, onDismiss: { vm.actionError = nil }) { FormPickerSheet(vm: vm) }
        .sheet(isPresented: $showCharge, onDismiss: { vm.actionError = nil }) { ChargeSheet(vm: vm) }
        .confirmationDialog(SuporteRules.linkTitle(vm.suporte) + "?", isPresented: $confirmLink, titleVisibility: .visible) {
            Button("Vincular") { Task { await vm.suporteAction("link") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O telefone desta conversa passa a ser reconhecido como do pagador nas próximas vezes.") }
        .confirmationDialog("Confirmar e liberar o atendimento?", isPresented: $confirmRelease, titleVisibility: .visible) {
            Button("Confirmar e liberar") { Task { await vm.suporteAction("confirm") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("Você confirmou que este telefone é do pagador: ele é vinculado e o cliente é liberado.") }
        .task(id: vm.conversation?.id) {
            guard vm.conversation != nil else { return }
            await vm.loadSuporte()
            #if DEBUG
            // Também na demonstração (WABOTIA_DEMO=chat), para ver o caminho feliz: o Mercado Pago fictício paga sozinho.
            if let script = DemoMode.conversationScript, !ranScript { ranScript = true; await runScript(script) }
            #endif
        }
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
        } message: { Text(vm.channel == .whatsapp ? "A mensagem também será apagada no WhatsApp do cliente." : "A mensagem também será apagada no canal do cliente.") }
        .alert("A mensagem não foi entregue", isPresented: Binding(get: { failedMessage != nil }, set: { if !$0 { failedMessage = nil } })) {
            if vm.isOwned, failedMessage?.message.text.isEmpty == false {
                Button("Tentar de novo") {
                    if let m = failedMessage { vm.retry(m.message) }
                    failedMessage = nil
                }
            }
            Button("OK", role: .cancel) { failedMessage = nil }
        } message: { Text((vm.channel == .whatsapp ? "O WhatsApp recusou a entrega. Confira o número do cliente e a janela de 24 horas." : "O canal recusou a entrega. Confira a janela e o motivo em Entregas.") + (vm.isOwned ? " Tentar de novo devolve o texto ao campo de mensagem." : "")) }
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
                    AvatarView(name: vm.displayName, seed: conversationId, kind: vm.isGroup ? .group : .person, size: 38, badge: vm.conversation.map { .role($0.role(me: vm.meId)) }, ring: Theme.bar, channel: vm.channel, multichannel: vm.isMultichannel)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(vm.displayName).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        if let c = vm.conversation {
                            Text(workspace.headerStatus(c))
                                .font(Theme.font(12))
                                .foregroundStyle(c.state == "waiting" ? Theme.warn : Theme.textSecondary)
                                .lineLimit(1)
                        }
                        if vm.showsChannelIdentity {
                            Text(vm.channelAccount).font(Theme.font(11)).foregroundStyle(Theme.textSecondary).lineLimit(1)
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
        .frame(height: vm.showsChannelIdentity ? 66 : 54)
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
            if vm.modulesAllowed, !c.isGroup, modules.isAvailable(ModuleId.agenda, container.profileId) {
                Button { push(.newAppointment(conversationId: conversationId, customer: vm.displayName)) } label: { Label("Agendar para este cliente", systemImage: "calendar.badge.plus") }
            }
            if vm.modulesAllowed, !c.isGroup, modules.isAvailable(ModuleId.serviceOrders, container.profileId) {
                Button { push(.newServiceOrder(conversationId: conversationId, customer: vm.displayName)) } label: { Label("Abrir ordem de serviço", systemImage: "wrench.and.screwdriver") }
            }
            if vm.modulesAllowed, !c.isGroup, modules.isAvailable(ModuleId.reserva, container.profileId) {
                Button { push(.bookingForm(conversationId: conversationId, customer: vm.displayName, unitId: nil, date: nil)) } label: { Label("Reservar para este cliente", systemImage: "bed.double") }
            }
            if vm.modulesAllowed, !c.isGroup, vm.isOwned, modules.isAvailable(ModuleId.pedido, container.profileId) {
                Button { Task { await vm.sendPedidoLink() } } label: { Label("Montar pedido para este cliente", systemImage: "takeoutbag.and.cup.and.straw") }
            }
            // Formulário e Cobrança: com o módulo ligado e a conversa assumida (ou administrador), como o servidor exige.
            if vm.modulesAllowed, !c.isGroup, vm.isOwned || vm.isAdmin, c.state != "closed" {
                if modules.isAvailable(ModuleId.forms, container.profileId) {
                    Button { vm.actionError = nil; showForms = true } label: { Label("Enviar formulário", systemImage: "doc.text") }
                }
                if modules.isAvailable(ModuleId.payments, container.profileId) {
                    Button { vm.actionError = nil; showCharge = true } label: { Label("Cobrar", systemImage: "creditcard") }
                }
            }
            // Suporte pago: só com a conversa assumida (ou administrador), como o servidor exige.
            if vm.modulesAllowed, !c.isGroup, vm.isOwned || vm.isAdmin, let s = vm.suporte {
                if SuporteRules.canLink(s) {
                    Button { confirmLink = true } label: { Label(SuporteRules.linkTitle(s), systemImage: "link") }
                }
                if SuporteRules.canConfirm(s) {
                    Button { confirmRelease = true } label: { Label("Confirmar e liberar", systemImage: "checkmark.shield") }
                }
                if SuporteRules.canCourtesy(s) {
                    Button { showCourtesy = true } label: { Label("Liberar como cortesia", systemImage: "gift") }
                }
            }
            if vm.canTransfer, vm.menuAllowed {
                Button { transferTab = .menu } label: { Label("Enviar menu", systemImage: "list.bullet") }
            }
            if vm.isOwned, vm.automationAllowed {
                Button { confirmResume = true } label: { Label("Devolver ao bot", systemImage: "cpu") }
                if !c.isGroup {
                    Button { confirmSurvey = true } label: { Label("Pesquisa de satisfação", systemImage: "star") }
                }
            }
            if vm.modulesAllowed {
                Button { showBots = true } label: { Label("Consultar bot", systemImage: "text.bubble") }
            }
            if !c.isGroup, vm.channel == .whatsapp {
                if vm.hasLinkedContact {
                    // Já vinculado: PUT /contact devolveria 409; edição/desvínculo ficam no painel.
                    Button {} label: { Label("Contato salvo", systemImage: "person.crop.circle.badge.checkmark") }.disabled(true)
                } else {
                    Button { showSaveContact = true } label: { Label("Salvar contato", systemImage: "person.crop.circle.badge.plus") }
                }
            }
            if let options = vm.detail?.email_transcript, options.available || !options.destinations.isEmpty {
                Button { showEmailTranscript = true } label: { Label("Enviar conversa por e-mail", systemImage: "envelope") }
                    .disabled(!options.available)
                if !options.available, let reason = options.reason { Text(reason) }
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

    #if DEBUG
    /// `WABOTIA_CONVERSA` (só depuração, sessão de verdade): os passos com o resultado no console.
    private func runScript(_ script: String) async {
        for step in script.split(separator: ",").map(String.init) {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            let parts = step.split(separator: ":", maxSplits: 3).map(String.init)
            var result = ""
            switch parts.first ?? "" {
            case "claim": await vm.claim()
            case "forms":
                await vm.loadForms()
                result = vm.formsError ?? "\(vm.forms?.count ?? 0) formulário(s): \((vm.forms ?? []).map(\.displayName).joined(separator: ", "))"
            case "form":
                if parts.count > 1, let form = vm.forms?.first(where: { $0.id == parts[1] }) { _ = await vm.sendForm(form) } else { result = "formulário \(parts.dropFirst().first ?? "") não está na lista" }
            case "charge" where parts.count == 4:
                _ = await vm.charge(method: parts[1], amountCents: Int(parts[2]) ?? 0, description: parts[3])
            case "resolve": _ = await vm.resolve()
            // A folha aberta mostra o mesmo aviso que a ação deixou (para a captura).
            case "sheet": if parts.count > 1 { if parts[1] == "charge" { showCharge = true } else { showForms = true } }
            case "close": showCharge = false; showForms = false
            default: result = "passo desconhecido"
            }
            print("[Vinki] conversa: \(step) → \(result.isEmpty ? (vm.actionError ?? "ok") : result); estado \(vm.conversation?.state ?? "?"), cobranças \(vm.payments.count), links \(vm.webSteps.count)")
        }
    }
    #endif

    private func demoSheets() {
        #if DEBUG
        switch DemoMode.takeSheet("transfer", "transfer-bots", "transfer-departments", "transfer-menu", "transfer-ticket", "transfer-confirm", "actions", "window", "tags", "reply", "push-info", "do-claim", "do-send", "do-transfer",
                                   "charge", "forms") {
        case "push-info": push(.conversationInfo(id: conversationId))
        case "charge": showCharge = true
        case "forms": showForms = true
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

/// Mantém a folha anterior do WhatsApp e oferece apenas operações permitidas na janela social.
struct ChannelTransferSheet: View {
    @ObservedObject var vm: ConversationViewModel
    var initialTab: TransferSheet.Tab = .people
    var onOpenTicket: ((String) -> Void)? = nil
    @ObservedObject private var workspace = Workspace.shared
    @Environment(\.dismiss) private var dismiss
    @State private var choice: Choice?
    @State private var confirming = false

    private enum Choice {
        case person(TeamContact), department(Department), menu, automation
        var title: String {
            switch self {
            case .person(let person): return "Transferir para \(person.name)?"
            case .department(let department): return "Encaminhar para \(department.name)?"
            case .menu: return "Enviar o menu principal?"
            case .automation: return "Devolver ao bot?"
            }
        }
    }

    var body: some View {
        if vm.channel == .whatsapp {
            TransferSheet(vm: vm, initialTab: initialTab, onOpenTicket: onOpenTicket)
        } else {
            VStack(spacing: 0) {
                SheetHeader(title: "Encaminhar atendimento", subtitle: vm.displayName) { dismiss() }
                ScrollView {
                    VStack(spacing: 12) {
                        if let error = vm.actionError { InlineError(text: error) }
                        if !vm.isComment, let window = vm.channelWindow, !window.canAutomation { ChannelWindowSummary(window: window, channel: vm.channel) }
                        SectionCard(title: "Pessoas") {
                            ForEach(workspace.people.filter { $0.id != vm.meId }) { person in
                                Button { choose(.person(person)) } label: {
                                    CardRow(title: person.name, subtitle: person.online ? "Online" : "Offline", chevron: true)
                                }.buttonStyle(.plain)
                            }
                        }
                        if !workspace.departments.isEmpty {
                            SectionCard(title: "Setores") {
                                ForEach(workspace.departments) { department in
                                    Button { choose(.department(department)) } label: { CardRow(title: department.name, chevron: true) }.buttonStyle(.plain)
                                }
                            }
                        }
                        if vm.automationAllowed {
                            SectionCard(title: "Automação") {
                                Button { choose(.automation) } label: { CardRow(title: "Devolver ao bot", chevron: true) }.buttonStyle(.plain)
                                ForEach(workspace.bots.filter { $0.serves(line: vm.conversation?.connection_id) }) { bot in
                                    Button { choose(.person(bot)) } label: { CardRow(title: bot.name, chevron: true) }.buttonStyle(.plain)
                                }
                                if vm.menuAllowed {
                                    Button { choose(.menu) } label: { CardRow(title: "Enviar menu principal", chevron: true) }.buttonStyle(.plain)
                                }
                            }
                        }
                    }.padding(16).disabled(!vm.canTransfer || vm.busy)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .appSheetDetents(medium: false)
            .task { await workspace.refreshTeam() }
            .confirmationDialog(choice?.title ?? "Confirmar encaminhamento?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Confirmar") { Task { await performChoice() } }
                Button("Cancelar", role: .cancel) { choice = nil }
            }
        }
    }

    private func choose(_ value: Choice) { choice = value; confirming = true }
    private func performChoice() async {
        guard let choice else { return }
        let success: Bool
        switch choice {
        case .person(let person): success = await vm.transfer(to: person)
        case .department(let department): success = await vm.transfer(toDepartment: department)
        case .menu: success = await vm.sendMenu(id: nil, label: "Menu principal")
        case .automation: success = await vm.resumeAutomation()
        }
        self.choice = nil
        if success { dismiss() }
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
