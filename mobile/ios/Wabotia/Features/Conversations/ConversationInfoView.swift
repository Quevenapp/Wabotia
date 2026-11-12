import SwiftUI
import UIKit

/// Dados da conversa (mobile/DESIGN.md, seção 7), aberta pelo nome na barra da conversa: contato, anel
/// grande da janela, estado e responsável, etiquetas, protocolos, mídia compartilhada e ações.
struct ConversationInfoView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.pushRoute) private var push
    @StateObject private var vm: ConversationViewModel
    @ObservedObject private var workspace = Workspace.shared
    let conversationId: String

    @State private var showTags = false
    @State private var showSaveContact = false
    @State private var showBots = false
    @State private var pendingBot: Bot?
    @State private var confirmResolve = false
    @State private var confirmResume = false
    @State private var confirmSurvey = false

    init(conversationId: String) {
        self.conversationId = conversationId
        _vm = StateObject(wrappedValue: ConversationViewModel(conversationId: conversationId))
    }

    private var profileId: String { container.profileId ?? "" }

    var body: some View {
        Group {
            if let c = vm.conversation {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 18) {
                            Group {
                                identity(c)
                                if let clock = vm.window { windowCard(clock, c) }
                                if let error = vm.actionError { InlineError(text: error) }
                                statusCard(c)
                                tagsCard
                            }
                            .padding(.horizontal, 16)
                            ticketsCard.padding(.horizontal, 16).id("tickets")
                            if c.isGroup { groupCard(c).padding(.horizontal, 16) }
                            mediaCard.padding(.horizontal, 16).id("media")
                            actionsCard(c).padding(.horizontal, 16).id("actions")
                        }
                        .padding(.vertical, 16)
                    }
                    #if DEBUG
                    .onAppear {
                        if let anchor = DemoMode.anchor {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { proxy.scrollTo(anchor, anchor: .top) }
                        }
                    }
                    #endif
                }
            } else if let error = vm.error {
                VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
            } else {
                VStack { Spacer(); ProgressView(); Spacer() }.frame(maxWidth: .infinity)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Dados da conversa")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .onAppear { vm.appear() }
        .onDisappear { vm.disappear() }
        .task { await vm.loadTickets() }
        .sheet(isPresented: $showTags) { TagsSheet(vm: vm) }
        .sheet(isPresented: $showSaveContact) { SaveContactSheet(vm: vm) }
        .sheet(isPresented: $showBots, onDismiss: {
            if let bot = pendingBot { pendingBot = nil; push(.bot(id: bot.id, conversationId: conversationId)) }
        }) { BotPickerSheet { bot in pendingBot = bot } }
        .confirmationDialog("Concluir este atendimento?", isPresented: $confirmResolve, titleVisibility: .visible) {
            Button("Concluir", role: .destructive) { Task { if await vm.resolve() { dismiss() } } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("A conversa é marcada como concluída e sai da sua lista.") }
        .confirmationDialog("Devolver a conversa ao bot?", isPresented: $confirmResume, titleVisibility: .visible) {
            Button("Devolver ao bot") { Task { if await vm.resumeAutomation() { dismiss() } } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O atendimento automático do perfil volta a responder o cliente.") }
        .confirmationDialog("Enviar pesquisa de satisfação?", isPresented: $confirmSurvey, titleVisibility: .visible) {
            Button("Enviar pesquisa") { Task { await vm.sendSurvey() } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O cliente recebe a pergunta e responde com uma nota de 1 a 5.") }
    }

    // MARK: Contato

    private func identity(_ c: Conversation) -> some View {
        VStack(spacing: 8) {
            AvatarView(name: vm.displayName, seed: conversationId, kind: c.isGroup ? .group : .person, size: 88, badge: .role(c.role(me: vm.meId)))
            Text(vm.displayName).font(Theme.font(22, .bold)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.center)
            if c.isGroup {
                Text("Grupo · \(vm.groupParticipants) participantes").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
            } else if let phone = c.phone, !phone.isEmpty {
                Button {
                    UIPasteboard.general.string = phone
                    workspace.show("Telefone copiado")
                } label: {
                    HStack(spacing: 6) {
                        Text(ConversationFormatting.phone(phone)).font(Theme.font(15))
                        Image(systemName: "doc.on.doc").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.textSecondary)
                    .frame(minHeight: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Telefone \(phone). Copiar")
            }
            if let line = workspace.connectionName(c.connection_id) {
                Pill(text: line, color: Theme.brand, icon: "phone.fill")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }

    // MARK: Janela

    private func windowCard(_ clock: WindowClock, _ c: Conversation) -> some View {
        HStack(spacing: 16) {
            ProgressRing(fraction: clock.fraction, color: clock.level.color, size: 96, lineWidth: 8) {
                VStack(spacing: 0) {
                    if clock.isClosed {
                        Image(systemName: "lock.fill").font(.system(size: 24)).foregroundStyle(Theme.muted)
                    } else {
                        Text(clock.label).font(Theme.font(15, .bold)).foregroundStyle(clock.level.color).lineLimit(1).minimumScaleFactor(0.6).padding(.horizontal, 10)
                        Text("restantes").font(Theme.font(10)).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Janela de 24 horas").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                Text(clock.isClosed ? "Fechada. Só volta quando o cliente escrever." : "Aberta \(clock.untilLabel() ?? "")")
                    .font(Theme.font(13)).foregroundStyle(clock.level == .danger ? Theme.danger : Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                if c.last_customer > 0 {
                    Text("Última mensagem do cliente: \(ConversationFormatting.date(c.last_customer))")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .card()
    }

    // MARK: Estado e responsável

    private func statusCard(_ c: Conversation) -> some View {
        let role = c.role(me: vm.meId)
        return SectionCard(title: "Atendimento") {
            CardRow(title: "Estado") { Pill(text: ConversationFormatting.stateLabel(c.state), color: role.color) }
            CardRow(title: "Responsável", value: responsible(c, role))
            if let department = workspace.department(c.department_id) {
                CardRow(title: "Setor", value: department.name)
            }
            CardRow(title: "Linha", value: workspace.connectionName(c.connection_id) ?? "—")
            CardRow(title: "Aberta em", value: ConversationFormatting.date(c.created), divider: false)
        }
    }

    private func responsible(_ c: Conversation, _ role: ConversationRole) -> String {
        switch role {
        case .mine: return "Você"
        case .other: return workspace.personName(c.owner)
        case .bot: return workspace.assignedBotName(c).map { "Bot \($0)" } ?? "Atendimento automático"
        case .waiting: return "Ninguém (na fila)"
        case .closed: return "—"
        }
    }

    // MARK: Etiquetas

    private var tagsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Etiquetas", action: "Editar") { showTags = true }
            VStack(alignment: .leading, spacing: 0) {
                if vm.tags.isEmpty {
                    Text("Nenhuma etiqueta").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                } else {
                    FlowTags(tags: vm.tags)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }

    // MARK: Protocolos

    private var ticketsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Protocolos desta conversa", action: vm.isOwned ? "Abrir protocolo" : nil) { push(.newTicket(conversationId: conversationId)) }
            if vm.tickets.isEmpty {
                Text("Nenhum protocolo nesta conversa.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading).card()
            } else {
                ForEach(vm.tickets) { ticket in
                    Button { push(.ticket(id: ticket.id)) } label: { TicketMiniRow(ticket: ticket) }.buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: Grupo

    private func groupCard(_ c: Conversation) -> some View {
        SectionCard(title: "Grupo", footer: vm.groupAnnouncementOnly ? "Somente administradores podem enviar neste grupo." : "Define quando o bot responde às mensagens do grupo.") {
            CardRow(icon: "cpu", iconColor: Theme.bot, title: "Respostas do bot", divider: false) {
                Menu {
                    ForEach(["off", "mentions", "all"], id: \.self) { policy in
                        Button { Task { await vm.setPolicy(policy) } } label: {
                            if (c.bot_policy ?? "mentions") == policy { Label(ConversationFormatting.policyLabel(policy), systemImage: "checkmark") }
                            else { Text(ConversationFormatting.policyLabel(policy)) }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(ConversationFormatting.policyLabel(c.bot_policy)).font(Theme.font(14)).lineLimit(1).minimumScaleFactor(0.8)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(Theme.brand)
                    .frame(minHeight: Theme.touch)
                }
                .disabled(vm.busy)
            }
        }
    }

    // MARK: Mídia compartilhada

    private var mediaCard: some View {
        let files = vm.detail?.media ?? []
        let visual = files.filter { $0.isImage || $0.isVideo }
        let others = files.filter { !$0.isImage && !$0.isVideo }
        return VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Mídia compartilhada", action: nil) {}
            if files.isEmpty {
                Text("Nenhuma mídia nesta conversa.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading).card()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    if !visual.isEmpty {
                        GeometryReader { geo in
                            let side = (geo.size.width - 12) / 3
                            LazyVGrid(columns: Array(repeating: GridItem(.fixed(side), spacing: 6), count: 3), alignment: .leading, spacing: 6) {
                                ForEach(visual.prefix(9)) { file in
                                    MediaThumbnail(file: file, profileId: profileId, side: side)
                                }
                            }
                        }
                        .aspectRatio(visual.count > 6 ? 1 : (visual.count > 3 ? 1.5 : 3), contentMode: .fit)
                    }
                    ForEach(others.prefix(6)) { file in
                        HStack(spacing: 10) {
                            Image(systemName: file.isAudio ? "waveform" : "doc.fill").font(.system(size: 15)).foregroundStyle(Theme.textSecondary).frame(width: 24)
                            Text(file.name.isEmpty ? (file.isAudio ? "Áudio" : "Documento") : file.name).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                            Spacer(minLength: 4)
                            Text(file.sizeLabel).font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
                .card()
            }
        }
    }

    // MARK: Ações

    private func actionsCard(_ c: Conversation) -> some View {
        SectionCard(title: "Ações") {
            if vm.can("calls"), !c.isGroup {
                actionRow("Ligar", "phone.fill", Theme.ok, disabled: !vm.isOwned) { push(.call(conversationId: conversationId, callId: nil)) }
            }
            if !c.isGroup {
                if vm.hasLinkedContact {
                    CardRow(icon: "person.crop.circle.badge.checkmark", iconColor: Theme.muted, title: "Contato salvo", subtitle: "Edição e desvínculo ficam no painel")
                } else {
                    actionRow("Salvar contato", "person.crop.circle.badge.plus", Theme.tickRead) { showSaveContact = true }
                }
            }
            actionRow("Consultar bot", "text.bubble.fill", Theme.bot) { showBots = true }
            if vm.isOwned {
                if !c.isGroup { actionRow("Pesquisa de satisfação", "star.fill", Theme.warn) { confirmSurvey = true } }
                actionRow("Devolver ao bot", "cpu", Theme.bot) { confirmResume = true }
                actionRow("Concluir", "checkmark.circle.fill", Theme.danger, danger: true, divider: false) { confirmResolve = true }
            } else {
                CardRow(icon: "lock.fill", iconColor: Theme.muted, title: "Assuma a conversa para mais ações", titleColor: Theme.textSecondary, divider: false)
            }
        }
        .disabled(vm.busy)
    }

    private func actionRow(_ title: String, _ icon: String, _ color: Color, danger: Bool = false, disabled: Bool = false, divider: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            CardRow(icon: icon, iconColor: color, title: title, titleColor: danger ? Theme.danger : Theme.textPrimary, chevron: !danger, divider: divider)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }

    private func sectionTitle(_ title: String, action: String?, perform: @escaping () -> Void) -> some View {
        HStack {
            Text(title.uppercased()).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
            Spacer()
            if let action {
                Button(action, action: perform).font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 22)
    }
}

/// Miniatura quadrada da grade de mídia.
private struct MediaThumbnail: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    let side: CGFloat
    @State private var image: UIImage?
    @State private var showViewer = false
    @State private var showVideo = false

    var body: some View {
        Button { if file.isVideo { showVideo = true } else if image != nil { showViewer = true } } label: {
            ZStack {
                Theme.divider
                if let image {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: side, height: side).clipped()
                } else if file.isVideo {
                    Image(systemName: "play.fill").font(.system(size: 18)).foregroundStyle(Color.white)
                        .frame(width: 40, height: 40).background(Circle().fill(Color.black.opacity(0.45)))
                } else {
                    ProgressView()
                }
            }
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(file.isVideo ? "Vídeo" : "Foto")
        .fullScreenCover(isPresented: $showViewer) { if let image { ImageViewerView(file: file, profileId: profileId, image: image) } }
        .sheet(isPresented: $showVideo) { VideoPlayerSheet(file: file, profileId: profileId) }
        .task(id: file.id) {
            guard file.isImage, image == nil else { return }
            if let data = try? await MediaLoader.shared.data(mediaId: file.id, profileId: profileId, api: container.api) { image = UIImage(data: data) }
        }
    }
}

/// Etiquetas em pílulas que quebram de linha (sem o protocolo Layout, que é do iOS 16).
struct FlowTags: View {
    let tags: [String]
    @State private var height: CGFloat = 24

    var body: some View {
        GeometryReader { geo in layout(in: geo.size.width) }
            .frame(height: height)
    }

    private func layout(in available: CGFloat) -> some View {
        var x: CGFloat = 0
        var y: CGFloat = 0
        return ZStack(alignment: .topLeading) {
            ForEach(Array(tags.enumerated()), id: \.offset) { index, tag in
                Pill(text: tag, color: Theme.brand)
                    .padding(.trailing, 6)
                    .padding(.bottom, 6)
                    .alignmentGuide(.leading) { d in
                        if abs(x - d.width) > available {
                            x = 0
                            y -= d.height
                        }
                        let result = x
                        if index == tags.count - 1 { x = 0 } else { x -= d.width }
                        return result
                    }
                    .alignmentGuide(.top) { _ in
                        let result = y
                        if index == tags.count - 1 { y = 0 }
                        return result
                    }
            }
        }
        .background(GeometryReader { geo in Color.clear.preference(key: FlowHeightKey.self, value: geo.size.height) })
        .onPreferenceChange(FlowHeightKey.self) { value in if value > 0, abs(value - height) > 0.5 { height = value } }
    }
}

private struct FlowHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
