import SwiftUI

/// Aba Equipe (mobile/DESIGN.md, seção 9): cartão de presença, e as listas Conversas (internas),
/// Pessoas, Bots e Setores. Atualiza a cada 20 s enquanto visível e ao puxar.
struct TeamView: View {
    enum Segment: String, CaseIterable, Identifiable {
        case chats, people, bots, departments
        var id: String { rawValue }
        var title: String {
            switch self {
            case .chats: return "Conversas"
            case .people: return "Pessoas"
            case .bots: return "Bots"
            case .departments: return "Setores"
            }
        }
    }

    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.pushRoute) private var push
    @ObservedObject private var workspace = Workspace.shared
    @StateObject private var runs = BotsViewModel()
    @State private var segment: Segment = .chats
    @State private var chats: [InternalChat] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var presenceError: String?
    @State private var selectedRun: BotRun?
    @State private var showBotPicker = false
    @State private var pendingBot: Bot?

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Equipe", subtitle: summary) { EmptyView() }
            List {
                Group {
                    presenceCard
                    segmentControl
                    if let error { InlineError(text: error) { Task { await load() } } }
                    switch segment {
                    case .chats: chatsSection
                    case .people: peopleSection
                    case .bots: botsSection
                    case .departments: departmentsSection
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.background)
            }
            .listStyle(.plain)
            .appListBackground(Theme.background)
            .refreshable { await load() }
        }
        .background(Theme.background.ignoresSafeArea())
        .task(id: "\(container.profileId ?? "")|\(active)|\(scenePhase == .active)") {
            guard active, scenePhase == .active else { return }
            while !Task.isCancelled {
                await load()
                do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { break }
            }
        }
        .onAppear { if active, loaded { Task { await load() } } }
        .sheet(item: $selectedRun) { run in BotRunDetailView(run: run, botName: runs.botName(run.bot_id)) }
        .sheet(isPresented: $showBotPicker, onDismiss: {
            if let bot = pendingBot { pendingBot = nil; push(.bot(id: bot.id, conversationId: nil)) }
        }) { BotPickerSheet { bot in pendingBot = bot } }
        #if DEBUG
        .onAppear {
            switch DemoMode.takeSheet("team-people", "team-bots", "team-departments") {
            case "team-people": segment = .people
            case "team-bots": segment = .bots
            case "team-departments": segment = .departments
            default: break
            }
        }
        #endif
    }

    private var summary: String {
        let people = workspace.onlinePeople
        let bots = workspace.activeBots
        return "\(people) \(people == 1 ? "pessoa" : "pessoas") online · \(bots) \(bots == 1 ? "bot ativo" : "bots ativos")"
    }

    private func load() async {
        guard let p = container.profileId else { return }
        await workspace.refreshTeam()
        do {
            chats = try await container.api.internalChats(p)
            workspace.backfill(internal: chats)
            error = nil
        } catch {
            if !Task.isCancelled { self.error = container.serviceError(error) }
        }
        loaded = true
        if segment == .bots || !runs.hasLoaded { await runs.load(quiet: true) }
    }

    // MARK: Presença

    private var presenceCard: some View {
        let online = workspace.mePresent
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AvatarView(name: container.user?.name ?? "Você", seed: container.user?.id ?? "", size: 52, badge: .presence(online), ring: Theme.surface)
                VStack(alignment: .leading, spacing: 2) {
                    Text(online ? "Você está online" : "Você está offline").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                    Text(online ? "Novos atendimentos podem chegar a você." : "Novos atendimentos não são encaminhados a você.")
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                if workspace.presenceBusy { ProgressView() }
                Toggle("Presença", isOn: Binding(get: { workspace.mePresent }, set: { value in
                    presenceError = nil
                    Task { presenceError = await workspace.setPresence(value) }
                }))
                .labelsHidden()
                .tint(Theme.accent)
                .disabled(workspace.presenceBusy)
            }
            if let presenceError { InlineError(text: presenceError) }
        }
        .card()
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 12)
    }

    private var segmentControl: some View {
        HStack(spacing: 4) {
            ForEach(Segment.allCases) { s in
                let selected = segment == s
                Button { segment = s } label: {
                    HStack(spacing: 4) {
                        Text(s.title).font(Theme.font(13, selected ? .semibold : .medium)).lineLimit(1).minimumScaleFactor(0.85)
                        if s == .chats, workspace.totalInternalUnread > 0 {
                            Circle().fill(selected ? Theme.onBrand : Theme.accent).frame(width: 7, height: 7)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 34)
                    .foregroundStyle(selected ? Theme.onBrand : Theme.textPrimary)
                    .background(Capsule().fill(selected ? Theme.brand : Color.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(Theme.surface))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    // MARK: Conversas internas

    @ViewBuilder private var chatsSection: some View {
        if !loaded {
            SkeletonList(rows: 3).frame(height: 230)
        } else if chats.isEmpty {
            hint("bubble.left.and.bubble.right", "Nenhuma conversa interna", "Toque em uma pessoa ou em um bot para conversar dentro do Wabotia.")
        } else {
            ForEach(chats) { chat in
                if let peer = chat.peer {
                    let preview = workspace.internalPreviews[chat.id]
                    let unread = workspace.internalUnread[chat.id] ?? 0
                    Button { push(.internalChat(peer: peer, chatId: chat.id)) } label: {
                        TeamRow(divider: chat.id != chats.last?.id) {
                            AvatarView(name: peer.name, seed: peer.id, kind: peer.isBot ? .bot : .person, size: 48, badge: .presence(peer.online))
                        } content: {
                            HStack(alignment: .firstTextBaseline) {
                                Text(peer.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                Spacer(minLength: 4)
                                Text(ConversationFormatting.listDate(preview?.created ?? chat.updated))
                                    .font(Theme.font(12)).foregroundStyle(unread > 0 ? Theme.accent : Theme.textSecondary)
                            }
                            HStack(spacing: 6) {
                                Text(previewText(preview)).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                                Spacer(minLength: 4)
                                if unread > 0 { CountBadge(count: unread) }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func previewText(_ preview: MessagePreview?) -> String {
        guard let preview else { return "Conversa interna" }
        return (preview.isOutgoing ? "Você: " : "") + preview.text.replacingOccurrences(of: "\n", with: " ")
    }

    // MARK: Pessoas

    @ViewBuilder private var peopleSection: some View {
        let people = workspace.people.filter { $0.id != workspace.meId }
            .sorted { $0.online != $1.online ? $0.online : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        if people.isEmpty {
            hint("person.2", workspace.loadedOnce ? "Nenhuma outra pessoa neste perfil" : "Carregando equipe…", "As pessoas com acesso ao perfil aparecem aqui.")
        } else {
            ForEach(people) { person in
                let load = workspace.ownerLoad[person.id] ?? 0
                Button { push(.internalChat(peer: person, chatId: chats.first { $0.peer?.id == person.id }?.id)) } label: {
                    TeamRow(divider: person.id != people.last?.id) {
                        AvatarView(name: person.name, seed: person.id, size: 48, badge: .presence(person.online))
                    } content: {
                        Text(person.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        HStack(spacing: 4) {
                            Text(person.online ? "Online" : "Offline").foregroundStyle(person.online ? Theme.ok : Theme.textSecondary)
                            if load > 0 { Text("· \(load) em atendimento").foregroundStyle(Theme.textSecondary) }
                        }
                        .font(Theme.font(13))
                        .lineLimit(1)
                    } trailing: {
                        Image(systemName: "bubble.left").font(.system(size: 16)).foregroundStyle(Theme.brand)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Bots

    @ViewBuilder private var botsSection: some View {
        let bots = workspace.bots.sorted { $0.online != $1.online ? $0.online : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        if bots.isEmpty {
            hint("cpu", workspace.loadedOnce ? "Nenhum bot neste perfil" : "Carregando bots…", "Habilite bots neste perfil pelo painel.")
        } else {
            ForEach(bots) { bot in
                let enabled = bot.enabled ?? true
                Button { push(.internalChat(peer: bot, chatId: chats.first { $0.peer?.id == bot.id }?.id)) } label: {
                    TeamRow(divider: bot.id != bots.last?.id) {
                        AvatarView(name: bot.name, kind: .bot, size: 48, badge: .presence(bot.online && enabled))
                    } content: {
                        Text(bot.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        HStack(spacing: 4) {
                            Text(!enabled ? "Desabilitado" : (bot.online ? "Disponível" : "Indisponível")).foregroundStyle(bot.online && enabled ? Theme.ok : Theme.textSecondary)
                            Text("· \(linesText(bot))").foregroundStyle(Theme.textSecondary)
                        }
                        .font(Theme.font(13))
                        .lineLimit(1)
                    } trailing: {
                        Image(systemName: "bubble.left").font(.system(size: 16)).foregroundStyle(Theme.bot)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        HStack {
            Text("EXECUÇÕES RECENTES").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
            Spacer()
            Button("Nova consulta") { showBotPicker = true }.font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand).buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
        .padding(.bottom, 6)
        if runs.runs.isEmpty {
            Text(runs.hasLoaded ? "Nenhuma execução ainda." : "Carregando…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 16).padding(.vertical, 8)
        } else {
            ForEach(runs.runs.prefix(20)) { run in
                Button { selectedRun = run } label: { BotRunRowView(run: run, botName: runs.botName(run.bot_id)) }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
            }
        }
    }

    private func linesText(_ bot: TeamContact) -> String {
        guard let lines = bot.line_ids else { return "Todas as linhas" }
        if lines.isEmpty { return "Só conversa interna" }
        return lines.count == 1 ? "1 linha" : "\(lines.count) linhas"
    }

    // MARK: Setores

    @ViewBuilder private var departmentsSection: some View {
        let list = workspace.departments
        if list.isEmpty {
            hint("building.2", workspace.loadedOnce ? "Nenhum setor configurado" : "Carregando setores…", "Os setores são criados no painel e recebem as conversas encaminhadas.")
        } else {
            ForEach(list) { department in
                let online = department.members.filter { workspace.isOnline($0) }.count
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(department.name).font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        Pill(text: "\(online) de \(department.members.count) online", color: online > 0 ? Theme.ok : Theme.muted)
                    }
                    HStack(spacing: -8) {
                        ForEach(department.members.prefix(6), id: \.self) { member in
                            AvatarView(name: memberName(member), seed: member, size: 30, ring: Theme.surface)
                                .overlay(Circle().fill(Theme.surface.opacity(workspace.isOnline(member) ? 0 : 0.6)))
                                .overlay(Circle().stroke(Theme.surface, lineWidth: 2))
                        }
                        if department.members.count > 6 {
                            Text("+\(department.members.count - 6)").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).padding(.leading, 14)
                        }
                        Spacer(minLength: 8)
                        Text(department.members.prefix(3).map { workspace.firstName(memberName($0)) }.joined(separator: ", "))
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1).padding(.leading, 8)
                    }
                }
                .card()
                .padding(.horizontal, 16)
                .padding(.vertical, 5)
            }
        }
    }

    private func memberName(_ id: String) -> String {
        id == workspace.meId ? (container.user?.name ?? "Você") : workspace.personName(id)
    }

    private func hint(_ icon: String, _ title: String, _ message: String) -> some View {
        EmptyStateView(title: title, systemImage: icon, message: message).frame(minHeight: 260)
    }
}

/// Linha das listas da equipe: avatar, duas linhas de texto e um acessório.
private struct TeamRow<Avatar: View, Content: View, Trailing: View>: View {
    var divider = true
    @ViewBuilder var avatar: () -> Avatar
    @ViewBuilder var content: () -> Content
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            avatar()
            VStack(alignment: .leading, spacing: 3) { content() }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 68)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { if divider { ThinDivider(leading: 76) } }
        .accessibilityElement(children: .combine)
    }
}

private extension TeamRow where Trailing == EmptyView {
    init(divider: Bool = true, @ViewBuilder avatar: @escaping () -> Avatar, @ViewBuilder content: @escaping () -> Content) {
        self.init(divider: divider, avatar: avatar, content: content) { EmptyView() }
    }
}

/// Chat interno com uma pessoa ou um bot: bolhas iguais às da conversa, sem janela nem ticks de WhatsApp.
struct InternalChatView: View {
    let peer: TeamContact
    var existingId: String? = nil
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var workspace = Workspace.shared
    @State private var chat: InternalChat?
    @State private var draft = ""
    @State private var error: String?
    @State private var busy = false
    @State private var openKey = APIClient.newIdempotencyKey()
    @State private var pending: (text: String, key: String)?
    @State private var confirmDiscard = false
    @FocusState private var focused: Bool

    private var messages: [InternalMessage] { chat?.messages ?? [] }
    private var online: Bool { workspace.team.first { $0.id == peer.id }?.online ?? peer.online }

    var body: some View {
        VStack(spacing: 0) {
            header
            GeometryReader { geo in
                ScrollViewReader { proxy in
                    // Lista invertida, como na conversa: a origem da rolagem é a última mensagem.
                    ScrollView {
                        VStack(spacing: 0) {
                            Color.clear.frame(height: 8).id("bottom")
                            Spacer(minLength: 0)
                            LazyVStack(spacing: 0) {
                                ForEach(Array(messages.enumerated().reversed()), id: \.element.id) { index, message in
                                    let mine = message.author == container.user?.id
                                    let first = index == 0 || messages[index - 1].author != message.author
                                    bubble(message, mine: mine, first: first, maxWidth: min(geo.size.width * 0.8, 520))
                                        .padding(.top, first ? 7 : 2)
                                        .flippedVertically()
                                        .id(message.id)
                                    if index == 0 || ConversationFormatting.dayKey(messages[index - 1].created) != ConversationFormatting.dayKey(message.created) {
                                        ChatChip(text: ConversationFormatting.dayChip(message.created)).padding(.vertical, 6).flippedVertically()
                                    }
                                }
                                ChatChip(text: "Conversa interna. As mensagens ficam dentro do Wabotia.", icon: "lock.fill").padding(.vertical, 10).flippedVertically()
                            }
                        }
                        .padding(.horizontal, 6)
                        .frame(minHeight: geo.size.height)
                    }
                    .flippedVertically()
                    .appScrollDismissesKeyboard()
                    .onChange(of: messages.last?.id) { _ in withAnimation(.quick) { proxy.scrollTo("bottom", anchor: .top) } }
                }
            }
            footer
        }
        .background(Theme.chatWallpaper.ignoresSafeArea())
        .appNavigationBarHidden(true)
        .confirmationDialog("Parar de tentar este envio?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Descartar tentativa", role: .destructive) { pending = nil; draft = ""; error = nil }
            Button("Continuar tentando", role: .cancel) {}
        } message: { Text("Isso não apaga uma mensagem que já tenha sido enviada. Confira o histórico antes de escrever a mesma mensagem novamente.") }
        .task(id: "\(container.profileId ?? ""):\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled { await load(); do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { break } }
        }
        .onDisappear { workspace.visibleInternalChatId = nil }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.brand)
                    .frame(width: 38, height: Theme.touch).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Voltar")
            AvatarView(name: peer.name, seed: peer.id, kind: peer.isBot ? .bot : .person, size: 38, badge: .presence(online), ring: Theme.bar)
            VStack(alignment: .leading, spacing: 1) {
                Text(peer.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text("\(peer.isBot ? "Bot" : "Equipe") · \(peer.isBot ? (online ? "Disponível" : "Indisponível") : (online ? "Online" : "Offline"))")
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            .padding(.leading, 9)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .frame(height: 54)
        .background(Theme.bar.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { ThinDivider() }
    }

    private func bubble(_ message: InternalMessage, mine: Bool, first: Bool, maxWidth: CGFloat) -> some View {
        let waiting = message.status.map { !["sent", "completed"].contains($0) } ?? false
        return HStack(spacing: 0) {
            if mine { Spacer(minLength: 0) }
            VStack(alignment: .leading, spacing: 3) {
                ZStack(alignment: .bottomTrailing) {
                    (Text(message.text).font(Theme.font(16)).foregroundColor(Theme.textPrimary)
                     + Text(" " + String(repeating: "0", count: 7)).font(Theme.font(11)).foregroundColor(.clear))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel(message.text)
                    Text(ConversationFormatting.time(message.created)).font(Theme.font(11)).foregroundStyle(Theme.textSecondary).offset(y: 2)
                }
                if waiting, let status = message.status {
                    HStack(spacing: 4) {
                        if status != "failed" && status != "unknown" { ProgressView().scaleEffect(0.6).frame(width: 12, height: 12) }
                        Text(statusLabel(status)).font(Theme.font(11, .medium))
                    }
                    .foregroundStyle(status == "failed" ? Theme.danger : Theme.textSecondary)
                }
            }
            .padding(.vertical, 6)
            .padding(.leading, 9 + (mine ? 0 : BubbleShape.tailWidth))
            .padding(.trailing, 9 + (mine ? BubbleShape.tailWidth : 0))
            .background(BubbleShape(tail: mine ? (first ? .trailing : .noneTrailing) : (first ? .leading : .noneLeading)).fill(mine ? Theme.bubbleOut : Theme.bubbleIn).shadow(color: Theme.shadow, radius: 0.5, y: 0.8))
            .frame(maxWidth: maxWidth, alignment: mine ? .trailing : .leading)
            if !mine { Spacer(minLength: 0) }
        }
    }

    private var footer: some View {
        VStack(spacing: 6) {
            if let error { InlineError(text: error) }
            if chat == nil, error != nil {
                SecondaryButton(title: "Tentar abrir a conversa", busy: busy) { Task { await load() } }
            }
            if pending != nil && !busy {
                HStack {
                    Text("Envio sem confirmação. Toque em enviar para repetir o mesmo pedido.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 6)
                    Button("Parar") { confirmDiscard = true }.font(Theme.font(13, .semibold)).foregroundStyle(Theme.danger)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                field
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.field))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.divider, lineWidth: 1))
                let canSend = !busy && chat != nil && (pending != nil || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button { Task { await send() } } label: {
                    Group { if busy { ProgressView().progressViewStyle(CircularProgressViewStyle(tint: Theme.onBrand)) } else { Image(systemName: "paperplane.fill").font(.system(size: 16, weight: .semibold)) } }
                        .foregroundStyle(Theme.onBrand).frame(width: 40, height: 40).background(Circle().fill(Theme.brand)).opacity(canSend ? 1 : 0.4)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(pending == nil ? "Enviar" : "Tentar envio novamente")
                .disabled(!canSend)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ThinDivider() }
    }

    @ViewBuilder private var field: some View {
        if #available(iOS 16, *) {
            AppMultilineField("Mensagem interna", text: $draft, lines: 1...5, font: Theme.font(16))
                .focused($focused).disabled(pending != nil || busy).padding(.horizontal, 14).padding(.vertical, 9).frame(minHeight: 40)
        } else {
            AppMultilineField("Mensagem interna", text: $draft, lines: 1...5, font: Theme.font(16))
                .focused($focused).disabled(pending != nil || busy).padding(.horizontal, 9).padding(.vertical, 1).frame(minHeight: 40)
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "queued", "starting", "running", "pending": return "Aguardando resposta"
        case "cancelling", "cancelled": return "Cancelada"
        case "failed": return "Falha na resposta"
        case "unknown": return "Sem confirmação"
        default: return status
        }
    }

    private func load() async {
        guard let p = container.profileId else { return }
        do {
            if chat == nil {
                if let existingId { chat = try await container.api.internalChat(p, id: existingId) }
                else { chat = try await container.api.openInternalChat(p, peer: peer.id, key: openKey) }
            }
            if let id = chat?.id {
                let fresh = try await container.api.internalChat(p, id: id)
                chat = fresh
                workspace.visibleInternalChatId = id
                workspace.markInternalRead(id)
                workspace.record(internal: fresh)
            }
            if pending == nil { error = nil }
        } catch { if !Task.isCancelled { self.error = container.serviceError(error) } }
    }

    private func send() async {
        guard let p = container.profileId, let id = chat?.id, !busy else { return }
        let value = pending ?? (draft.trimmingCharacters(in: .whitespacesAndNewlines), APIClient.newIdempotencyKey())
        guard !value.0.isEmpty else { return }
        pending = value; busy = true
        defer { busy = false }
        do {
            _ = try await container.api.sendInternal(p, id: id, text: value.0, key: value.1)
            pending = nil; draft = ""; error = nil
            Haptics.light()
            await load()
        } catch {
            self.error = container.serviceError(error)
            if let e = error as? APIError, (400..<500).contains(e.status) && e.status != 408 && e.status != 429 && !["operation_unknown", "idempotency_conflict"].contains(e.code) { pending = nil }
        }
    }
}
