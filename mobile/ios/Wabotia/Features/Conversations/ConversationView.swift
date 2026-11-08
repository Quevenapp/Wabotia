import SwiftUI

/// Tela da conversa: cabeçalho com estado/responsável, menu de ações, mensagens e composer.
struct ConversationView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var vm: ConversationViewModel
    let conversationId: String

    private enum Pushed: Hashable { case newTicket, call, bot(String) }
    @State private var pushed: Pushed?
    @State private var pendingBot: Bot?
    @State private var showTransfer = false
    @State private var showTags = false
    @State private var showBots = false
    @State private var showSaveContact = false
    @State private var confirmResolve = false
    @State private var confirmResume = false

    init(conversationId: String) {
        self.conversationId = conversationId
        _vm = StateObject(wrappedValue: ConversationViewModel(conversationId: conversationId))
    }

    private var profileId: String { container.profileId ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            if let c = vm.conversation {
                header(c)
                Divider()
            }
            content
            if vm.conversation != nil {
                Divider()
                if vm.isOwned { ComposerView(vm: vm) } else { lockedNotice }
            }
        }
        .navigationTitle(vm.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .primaryAction) { actionsMenu } }
        .onAppear {
            PushManager.shared.visibleConversationId = conversationId
            vm.appear()
        }
        .onDisappear {
            if PushManager.shared.visibleConversationId == conversationId { PushManager.shared.visibleConversationId = nil }
            vm.stopPolling()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                vm.startPolling()
                Task { await vm.load(silent: true) }
            } else {
                vm.stopPolling()
            }
        }
        .navigationDestination(isPresented: Binding(get: { pushed != nil }, set: { if !$0 { pushed = nil } })) {
            switch pushed {
            case .newTicket?: NewTicketView(conversationId: conversationId)
            case .call?: CallView(conversationId: conversationId, callId: nil)
            case .bot(let id)?: BotChatView(botId: id, conversationId: conversationId)
            case nil: EmptyView()
            }
        }
        .sheet(isPresented: $showTransfer) { TransferSheet(vm: vm) }
        .sheet(isPresented: $showTags) { TagsSheet(vm: vm) }
        .sheet(isPresented: $showBots, onDismiss: {
            if let bot = pendingBot { pendingBot = nil; pushed = .bot(bot.id) }
        }) { BotPickerSheet { bot in pendingBot = bot } }
        .sheet(isPresented: $showSaveContact) { SaveContactSheet(vm: vm) }
        .confirmationDialog("Concluir este atendimento?", isPresented: $confirmResolve, titleVisibility: .visible) {
            Button("Concluir", role: .destructive) { Task { await vm.act("resolve") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("A conversa é marcada como concluída e sai da sua lista.") }
        .confirmationDialog("Devolver a conversa à IA?", isPresented: $confirmResume, titleVisibility: .visible) {
            Button("Devolver à IA") { Task { await vm.act("resume") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O bot do perfil volta a responder o cliente.") }
    }

    // MARK: Cabeçalho

    private func header(_ c: Conversation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                InitialAvatar(name: vm.displayName, isGroup: c.isGroup, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(vm.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let phone = c.phone, !phone.isEmpty, phone != vm.displayName {
                        Text(phone).font(.caption).foregroundStyle(.secondary)
                    } else if c.isGroup {
                        Text("Grupo · \(vm.groupParticipants) participantes").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    StateChip(state: c.state)
                    if let owner = c.owner, !owner.isEmpty {
                        Text("Responsável: \(vm.ownerName(owner))").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            let tags = vm.tags
            if !tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { ForEach(tags, id: \.self) { TagChip(text: $0) } }
                }
            }
            if c.isGroup {
                HStack {
                    Text("Respostas da IA").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Menu {
                        ForEach(["off", "mentions", "all"], id: \.self) { policy in
                            Button {
                                Task { await vm.setPolicy(policy) }
                            } label: {
                                if (c.bot_policy ?? "mentions") == policy { Label(ConversationFormatting.policyLabel(policy), systemImage: "checkmark") }
                                else { Text(ConversationFormatting.policyLabel(policy)) }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(ConversationFormatting.policyLabel(c.bot_policy)).font(.caption)
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                    }
                    .disabled(vm.busy)
                }
                if vm.groupAnnouncementOnly {
                    Text("Somente administradores podem enviar neste grupo.").font(.caption2).foregroundStyle(.orange)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: Mensagens

    @ViewBuilder
    private var content: some View {
        if vm.loading && vm.detail == nil {
            Spacer()
            ProgressView("Carregando conversa…")
            Spacer()
        } else if let error = vm.error, vm.detail == nil {
            VStack(spacing: 12) {
                EmptyStateView(title: "Não foi possível abrir", systemImage: "exclamationmark.triangle", message: error)
                Button("Tentar novamente") { Task { await vm.load() } }.buttonStyle(.bordered)
            }
            .frame(maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if vm.messages.isEmpty {
                            Text("Nenhuma mensagem ainda.").font(.footnote).foregroundStyle(.secondary).padding(.top, 24)
                        }
                        ForEach(vm.messages) { m in
                            MessageBubbleView(message: m, vm: vm, profileId: profileId).id(m.id)
                        }
                        ForEach(vm.pendingDeliveries) { DeliveryStatusRow(delivery: $0) }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: vm.scrollToken) { _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }

    private var lockedNotice: some View {
        VStack(spacing: 8) {
            if let e = vm.actionError { Text(e).font(.caption).foregroundStyle(.red) }
            HStack {
                Image(systemName: "lock").foregroundStyle(.secondary)
                Text(lockedText).font(.footnote).foregroundStyle(.secondary)
                Spacer()
                if canClaim {
                    Button {
                        Task { await vm.act("claim") }
                    } label: { if vm.busy { ProgressView() } else { Text("Assumir") } }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.busy)
                } else if canTakeOver {
                    Button {
                        Task { await vm.act("transfer", target: vm.meId) }
                    } label: { if vm.busy { ProgressView() } else { Text("Assumir para mim") } }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.busy)
                }
            }
        }
        .padding(12)
        .background(.bar)
    }

    private var lockedText: String {
        guard let c = vm.conversation else { return "" }
        if c.state == "human", let owner = c.owner, owner != vm.meId { return "Em atendimento por \(vm.ownerName(owner))." }
        if c.state == "closed" { return "Conversa concluída. Assuma para responder novamente." }
        return "Assuma a conversa para responder, enviar arquivos ou ligar."
    }

    /// `claim` só vale para conversas sem responsável (fila, IA, concluídas): o servidor devolve 409
    /// already_claimed quando outro atendente é o dono, mesmo para administradores.
    private var canClaim: Bool {
        guard let c = vm.conversation else { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty, owner != vm.meId { return false }
        return true
    }

    /// Administrador em conversa de outro atendente: toma a conversa via `transfer` para si mesmo.
    private var canTakeOver: Bool {
        guard let c = vm.conversation, vm.isAdmin, vm.meId != nil else { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty, owner != vm.meId { return true }
        return false
    }

    // MARK: Menu de ações

    private var actionsMenu: some View {
        Menu {
            if let c = vm.conversation {
                if !vm.isOwned, canClaim {
                    Button { Task { await vm.act("claim") } } label: { Label("Assumir", systemImage: "hand.raised") }
                } else if !vm.isOwned, canTakeOver {
                    Button { Task { await vm.act("transfer", target: vm.meId) } } label: { Label("Assumir para mim", systemImage: "hand.raised") }
                }
                if vm.isOwned || vm.isAdmin, c.state != "closed" {
                    Button { showTransfer = true } label: { Label("Transferir…", systemImage: "arrow.left.arrow.right") }
                }
                if vm.isOwned {
                    Button { confirmResume = true } label: { Label("Devolver à IA", systemImage: "cpu") }
                    Button { confirmResolve = true } label: { Label("Concluir", systemImage: "checkmark.circle") }
                }
                Button { showTags = true } label: { Label("Etiquetas…", systemImage: "tag") }
                Divider()
                Button { pushed = .newTicket } label: { Label("Abrir protocolo", systemImage: "doc.badge.plus") }
                Button { showBots = true } label: { Label("Consultar bot…", systemImage: "cpu") }
                if vm.can("calls"), !c.isGroup {
                    Button { pushed = .call } label: { Label("Ligar", systemImage: "phone") }
                        .disabled(!vm.isOwned)
                }
                if !c.isGroup {
                    if vm.hasLinkedContact {
                        // Já vinculado: PUT /contact devolveria 409; edição/desvínculo ficam no painel.
                        Button {} label: { Label("Contato salvo: \(vm.displayName)", systemImage: "person.crop.circle.badge.checkmark") }
                            .disabled(true)
                    } else {
                        Button { showSaveContact = true } label: { Label("Salvar contato…", systemImage: "person.crop.circle.badge.plus") }
                    }
                }
                Divider()
                Button { Task { await vm.load(); await vm.loadPresence() } } label: { Label("Atualizar", systemImage: "arrow.clockwise") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(vm.conversation == nil)
    }
}
