import SwiftUI

/// Aba Conversas (mobile/DESIGN.md, seção 4): marca e perfil no topo, pílula de presença, busca, chips com
/// contador, linhas com selo de estado, prévia, etiquetas, responsável, anel da janela e não lidas.
struct ConversationsView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @ObservedObject var vm: ConversationsViewModel
    @ObservedObject private var workspace = Workspace.shared

    @State private var searching = false
    @FocusState private var searchFocused: Bool
    @State private var showPresence = false
    @State private var confirmResolve: Conversation?
    @State private var transferTarget: Conversation?
    @State private var tagsTarget: Conversation?

    var body: some View {
        VStack(spacing: 0) {
            header
            filters
            ThinDivider()
            content
        }
        .background(Theme.background.ignoresSafeArea())
        .onAppear { if active { vm.appear() } }
        .onDisappear { vm.disappear() }
        .onChange(of: active) { now in if now { vm.appear() } else { vm.disappear() } }
        .onChange(of: vm.query) { _ in vm.queryChanged() }
        .onChange(of: container.profileId) { _ in vm.load(reset: true) }
        .sheet(isPresented: $showPresence) { PresenceSheet() }
        .sheet(item: $transferTarget) { c in ConversationSheetHost(conversationId: c.id) { TransferSheet(vm: $0) } }
        .sheet(item: $tagsTarget) { c in ConversationSheetHost(conversationId: c.id) { TagsSheet(vm: $0) } }
        .confirmationDialog("Concluir este atendimento?", isPresented: Binding(get: { confirmResolve != nil }, set: { if !$0 { confirmResolve = nil } }), titleVisibility: .visible) {
            Button("Concluir", role: .destructive) {
                if let c = confirmResolve { Task { await vm.resolve(c) } }
                confirmResolve = nil
            }
            Button("Cancelar", role: .cancel) { confirmResolve = nil }
        } message: { Text("A conversa é marcada como concluída e sai da sua lista.") }
        #if DEBUG
        .onAppear {
            switch DemoMode.takeSheet("presence", "search", "filter-queue", "filter-empty") {
            case "presence": showPresence = true
            case "search": searching = true; vm.query = "ma"
            case "filter-queue": vm.filter = .queue
            case "filter-empty": vm.filter = .closed; vm.query = "zzz"
            default: break
            }
        }
        #endif
    }

    // MARK: Topo

    @ViewBuilder private var header: some View {
        if searching {
            SearchField(placeholder: "Nome ou telefone", text: $vm.query, focused: $searchFocused) {
                vm.query = ""
                searching = false
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 56)
            .onAppear { searchFocused = true }
        } else {
            ScreenHeader(title: "Wabotia", subtitle: workspace.profileName, brandTitle: true, onSubtitleTap: workspace.profiles.count > 1 ? { container.profileId = nil } : nil) {
                Button { showPresence = true } label: { PresencePill(online: workspace.mePresent, busy: workspace.presenceBusy) }
                    .buttonStyle(.plain)
                IconButton(systemName: "magnifyingglass", label: "Buscar conversa") { searching = true }
            }
        }
    }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ConversationsViewModel.Filter.allCases) { f in
                    FilterChip(title: f.title, count: count(f), selected: vm.filter == f, attention: f == .queue && workspace.count("waiting") > 0 ? Theme.warn : nil) {
                        vm.filter = f
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func count(_ f: ConversationsViewModel.Filter) -> Int? {
        switch f {
        case .all, .closed: return nil
        case .queue: return workspace.count("waiting")
        case .mine: return vm.mineCount
        case .ai: return workspace.count("ai")
        }
    }

    // MARK: Lista

    @ViewBuilder private var content: some View {
        if vm.loading && vm.items.isEmpty {
            SkeletonList()
        } else if vm.items.isEmpty, let error = vm.error {
            VStack { InlineError(text: error) { vm.load(reset: true) }.padding(16); Spacer() }
        } else if vm.items.isEmpty && vm.hasLoaded {
            ScrollView { emptyState.padding(.top, 48) }
        } else {
            List {
                if let error = vm.error {
                    InlineError(text: error) { vm.load(reset: true) }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Theme.background)
                }
                ForEach(vm.items) { c in row(c) }
                if vm.loadingMore {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowSeparator(.hidden)
                        .listRowBackground(Theme.background)
                }
            }
            .listStyle(.plain)
            .appListBackground(Theme.background)
            .refreshable { await vm.refresh() }
        }
    }

    private func row(_ c: Conversation) -> some View {
        Button { push(.conversation(id: c.id)) } label: {
            ConversationRow(conversation: c, workspace: workspace, busy: vm.busyId == c.id)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Theme.background)
        .onAppear { vm.loadMoreIfNeeded(current: c) }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if vm.canClaim(c) {
                Button { Task { await vm.claim(c) } } label: { Label(c.state == "closed" ? "Reabrir" : "Assumir", systemImage: "person.fill.checkmark") }
                    .tint(Theme.brand)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if c.isOwned(by: vm.meId) {
                Button { confirmResolve = c } label: { Label("Concluir", systemImage: "checkmark.circle") }
                    .tint(Theme.muted)
            }
        }
        .contextMenu {
            if vm.canClaim(c) {
                Button { Task { await vm.claim(c) } } label: { Label(c.state == "closed" ? "Reabrir e assumir" : "Assumir", systemImage: "person.fill.checkmark") }
            }
            if (c.isOwned(by: vm.meId) || workspace.isAdmin), c.state != "closed" {
                Button { transferTarget = c } label: { Label("Transferir", systemImage: "arrowshape.turn.up.right") }
            }
            Button { tagsTarget = c } label: { Label("Etiquetas", systemImage: "tag") }
            if c.isOwned(by: vm.meId) {
                Button { push(.newTicket(conversationId: c.id)) } label: { Label("Abrir protocolo", systemImage: "doc.text") }
                Button(role: .destructive) { confirmResolve = c } label: { Label("Concluir", systemImage: "checkmark.circle") }
            }
        }
    }

    private var emptyState: some View {
        let info = emptyInfo
        return EmptyStateView(title: info.title, systemImage: info.icon, message: info.message)
    }

    private var emptyInfo: (icon: String, title: String, message: String) {
        if !vm.query.trimmingCharacters(in: .whitespaces).isEmpty {
            return ("magnifyingglass", "Nada encontrado", "Nenhuma conversa com \"\(vm.query)\".")
        }
        switch vm.filter {
        case .queue: return ("checkmark.circle", "Fila vazia", "Nenhuma conversa na fila. Bom trabalho!")
        case .mine: return ("person.crop.circle", "Nenhum atendimento seu", "Assuma uma conversa da fila para atender por aqui.")
        case .ai: return ("cpu", "Nenhuma conversa com bots", "Quando um bot estiver atendendo, a conversa aparece aqui.")
        case .closed: return ("archivebox", "Nada concluído ainda", "As conversas concluídas ficam guardadas aqui.")
        case .all: return ("bubble.left.and.bubble.right", "Nenhuma conversa", "As conversas dos clientes aparecem aqui assim que chegarem.")
        }
    }
}

/// Linha da lista (altura ~76): avatar com selo, nome, horário, prévia, etiquetas, responsável, anel e não lidas.
struct ConversationRow: View {
    let conversation: Conversation
    @ObservedObject var workspace: Workspace
    var busy = false

    private var role: ConversationRole { conversation.role(me: workspace.meId) }
    private var unread: Int { workspace.unread[conversation.id] ?? 0 }
    private var preview: MessagePreview? { workspace.preview(for: conversation) }
    private var tags: [String] { JSONValue.parseStringList(conversation.tags) }

    /// Na fila há mais de 5 minutos: o horário vira "espera 12 min".
    private var waitText: String? {
        guard conversation.state == "waiting" else { return nil }
        let minutes = (workspace.nowMillis - conversation.updated) / 60_000
        return minutes > 5 ? "espera \(ConversationFormatting.elapsed(since: conversation.updated, now: workspace.nowMillis))" : nil
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            AvatarView(name: conversation.displayName, seed: conversation.id, kind: conversation.isGroup ? .group : .person, size: 50, badge: .role(role))
                .overlay { if busy { ProgressView().frame(width: 50, height: 50).background(Circle().fill(Theme.background.opacity(0.7))) } }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(conversation.displayName)
                        .font(Theme.font(16, .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let waitText {
                        Text(waitText).font(Theme.font(12, .semibold)).foregroundStyle(Theme.warn).lineLimit(1)
                    } else {
                        Text(ConversationFormatting.listDate(preview?.created ?? conversation.updated))
                            .font(Theme.font(12, unread > 0 ? .semibold : .regular))
                            .foregroundStyle(unread > 0 ? Theme.accent : Theme.textSecondary)
                            .lineLimit(1)
                    }
                }
                HStack(alignment: .center, spacing: 6) {
                    previewLine
                    Spacer(minLength: 4)
                    if let clock = workspace.window(for: conversation), conversation.state != "closed" {
                        HStack(spacing: 3) {
                            WindowRing(clock: clock, size: 20)
                            if !clock.compact.isEmpty {
                                Text(clock.compact).font(Theme.font(12, .semibold)).foregroundStyle(clock.level.color)
                            }
                        }
                        .fixedSize()
                    }
                }
                HStack(spacing: 5) {
                    ForEach(tags.prefix(2), id: \.self) { TagChip(text: $0) }
                    if tags.count > 2 { Text("+\(tags.count - 2)").font(Theme.font(11, .semibold)).foregroundStyle(Theme.textSecondary) }
                    if !tags.isEmpty { Text("·").font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                    Text(workspace.ownerLabel(conversation))
                        .font(Theme.font(12, .medium))
                        .foregroundStyle(role == .mine ? Theme.brand : (role == .waiting ? Theme.warn : (role == .bot ? Theme.bot : Theme.textSecondary)))
                        .lineLimit(1)
                        .layoutPriority(1)
                    Spacer(minLength: 4)
                    if unread > 0 { CountBadge(count: unread) }
                }
                .frame(minHeight: 20)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { ThinDivider(leading: 78) }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Abre a conversa")
    }

    @ViewBuilder private var previewLine: some View {
        if let preview {
            HStack(spacing: 4) {
                if preview.isNote {
                    Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(Theme.noteText)
                    Text(preview.text).italic().font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                } else {
                    if preview.isOutgoing { TickView(status: preview.status ?? "sent", size: 11) }
                    if let attachment = preview.attachmentLabel {
                        Image(systemName: attachment.icon).font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                        Text(preview.text.isEmpty ? attachment.title : preview.text).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    } else {
                        Text(preview.text.replacingOccurrences(of: "\n", with: " "))
                            .font(Theme.font(14, unread > 0 ? .medium : .regular))
                            .foregroundStyle(unread > 0 ? Theme.textPrimary : Theme.textSecondary)
                            .lineLimit(1)
                    }
                }
            }
        } else {
            Text(workspace.statusSentence(conversation)).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(1)
        }
    }
}

/// Folha de presença: dois botões grandes, uma linha explicando o efeito e quem está online.
struct PresenceSheet: View {
    @ObservedObject private var workspace = Workspace.shared
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    var body: some View {
        VStack(spacing: 14) {
            SheetHeader(title: "Sua presença") { dismiss() }
            HStack(spacing: 10) {
                Circle().fill(workspace.mePresent ? Theme.ok : Theme.muted).frame(width: 10, height: 10)
                Text(workspace.mePresent ? "Você está online" : "Você está offline").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
            }
            if workspace.mePresent {
                SecondaryButton(title: "Ficar offline", icon: "moon.fill", color: Theme.textSecondary, busy: workspace.presenceBusy) { set(false) }
            } else {
                PrimaryButton(title: "Ficar online", icon: "checkmark.circle.fill", busy: workspace.presenceBusy, color: Theme.ok) { set(true) }
            }
            Text(workspace.mePresent
                 ? "Online: novos atendimentos e transferências podem ser encaminhados a você."
                 : "Offline: novos atendimentos não são encaminhados a você.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
            if let error { InlineError(text: error) }
            HStack(spacing: 6) {
                Image(systemName: "person.2.fill").font(.system(size: 12))
                Text(teamSummary).font(Theme.font(13, .medium))
            }
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(Theme.surface))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
    }

    private var teamSummary: String {
        let n = workspace.onlinePeople
        return n == 1 ? "1 pessoa da equipe online" : "\(n) pessoas da equipe online"
    }

    private func set(_ value: Bool) {
        error = nil
        Task {
            if let message = await workspace.setPresence(value) { error = message } else { Haptics.light(); dismiss() }
        }
    }
}

/// Carrega a conversa e entrega o view model para uma folha aberta a partir da lista (transferir, etiquetas).
struct ConversationSheetHost<Content: View>: View {
    @StateObject private var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    let content: (ConversationViewModel) -> Content

    init(conversationId: String, @ViewBuilder content: @escaping (ConversationViewModel) -> Content) {
        _vm = StateObject(wrappedValue: ConversationViewModel(conversationId: conversationId))
        self.content = content
    }

    var body: some View {
        Group {
            if vm.detail != nil {
                content(vm)
            } else if let error = vm.error {
                VStack(spacing: 12) {
                    SheetHeader(title: "Conversa") { dismiss() }
                    InlineError(text: error) { Task { await vm.load() } }.padding(16)
                    Spacer()
                }
            } else {
                VStack { SheetHeader(title: "Carregando…") { dismiss() }; Spacer(); ProgressView(); Spacer() }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .task { await vm.load(); await vm.loadPresence() }
    }
}
