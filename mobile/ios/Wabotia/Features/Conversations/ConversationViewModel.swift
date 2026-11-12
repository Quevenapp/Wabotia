import Foundation
import Combine
import UIKit
import UniformTypeIdentifiers

/// Arquivo escolhido para envio (galeria, câmera ou arquivos), já em memória.
struct PendingAttachment: Identifiable, Equatable {
    let id: UUID
    var data: Data
    var name: String
    var mimeType: String
    var thumbnail: UIImage?

    init(data: Data, name: String, mimeType: String, thumbnail: UIImage? = nil) {
        id = UUID()
        self.data = data
        self.name = name
        self.mimeType = mimeType
        self.thumbnail = thumbnail
    }

    /// image | video | audio | document (igual a mediaKind do servidor, exceto figurinha).
    var kind: String {
        let m = mimeType.lowercased()
        if m.hasPrefix("image/") { return "image" }
        if m.hasPrefix("video/") { return "video" }
        if m.hasPrefix("audio/") { return "audio" }
        return "document"
    }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file) }

    static func == (a: PendingAttachment, b: PendingAttachment) -> Bool { a.id == b.id }

    static func mimeType(for url: URL) -> String {
        if let t = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType { return t }
        return "application/octet-stream"
    }
}

struct LocationDraft: Equatable {
    var latitude: Double
    var longitude: Double
    var name: String = ""
    var address: String = ""
}

struct ContactDraft: Equatable {
    var name: String
    var phone: String
}

/// Pedido de envio já montado (anexos enviados) guardado com a mesma Idempotency-Key para repetição segura.
struct PendingRequest {
    var body: ActionRequest
    var key: String
    var summary: String
}

enum SendKind: String, CaseIterable, Identifiable {
    case auto = "text", document
    var id: String { rawValue }
    var title: String { self == .auto ? "Automático pelo arquivo" : "Enviar como documento" }
}

// MARK: - Linha do tempo da conversa

/// Mensagem pronta para desenhar: conteúdo já interpretado, anexos resolvidos e posição no grupo.
struct ChatMessage: Identifiable, Equatable {
    enum Side: Equatable { case incoming, outgoing, note }
    enum Sender: Equatable { case none, me, agent(String), bot(String), automatic, participant(String) }

    var message: Message
    var content: JSONValue
    var media: [MediaFile]
    var side: Side
    var sender: Sender
    /// Primeira bolha do grupo (mesmo autor em sequência): leva o rabinho e o rótulo de quem enviou.
    var firstInGroup: Bool
    var quotedText: String?
    var quotedAuthor: String?
    var quotedId: String?
    var reactions: [String]

    var id: String { message.id }
    var isDeleted: Bool { content["deleted"]?.boolValue ?? false }
    var isEdited: Bool { content["edited"]?.boolValue ?? false }
    var isVoice: Bool { content["type"]?.stringValue == "voice" }
}

/// Envio feito aqui que ainda não virou mensagem (o servidor só grava a mensagem quando entrega),
/// ou entrega pendente/falha feita em outro lugar.
struct PendingBubble: Identifiable, Equatable {
    var id: String
    var text: String
    var created: Int64
    /// pending | sending | failed | unknown
    var status: String
    var error: String?
}

enum ChatItem: Identifiable, Equatable {
    case message(ChatMessage)
    case event(ServiceEvent)
    case pending(PendingBubble)

    var id: String {
        switch self {
        case .message(let m): return m.id
        case .event(let e): return "event:\(e.id)"
        case .pending(let p): return "pending:\(p.id)"
        }
    }
    var created: Int64 {
        switch self {
        case .message(let m): return m.message.created
        case .event(let e): return e.created
        case .pending(let p): return p.created
        }
    }
}

struct ChatDay: Identifiable, Equatable {
    let id: Int
    var title: String
    var items: [ChatItem]
}

/// Estado da tela de uma conversa: detalhe, ações, linha do tempo e composer.
@MainActor
final class ConversationViewModel: ObservableObject {
    let conversationId: String

    @Published private(set) var detail: ConversationDetail?
    @Published private(set) var timeline: [ChatDay] = []
    @Published private(set) var tickets: [Ticket] = []
    @Published private(set) var loading = false
    @Published var error: String?
    @Published var actionError: String?
    @Published var info: String?
    @Published private(set) var busy = false
    /// Ação de estado em andamento (claim, transfer…), para o progresso no próprio botão.
    @Published private(set) var busyAction: String?
    @Published private(set) var progress: String?
    /// Chegou conteúdo novo: a tela rola até o fim só se a pessoa já estava lá.
    @Published private(set) var scrollToken = 0
    /// Ação feita aqui (enviar, nota, menu…): a tela sempre rola até o fim.
    @Published private(set) var forceScrollToken = 0

    // Composer
    @Published var draft = ""
    @Published var quote: Message?
    @Published var editing: Message?
    @Published var attachments: [PendingAttachment] = []
    @Published var voice: VoiceRecording?
    @Published var sendKind: SendKind = .auto
    @Published var location: LocationDraft?
    @Published var contactDraft: ContactDraft?
    @Published private(set) var pending: PendingRequest?

    private var key = APIClient.newIdempotencyKey()
    private var sendTask: Task<Void, Never>?
    private var loadedOnce = false
    private var visible = false
    private var pendingAction: (body: ActionRequest, key: String)?
    private var outgoing: [PendingBubble] = []
    private var subscriptions: Set<AnyCancellable> = []

    private var container: AppContainer { AppContainer.shared }
    private var workspace: Workspace { Workspace.shared }
    private var profileId: String? { container.profileId }

    init(conversationId: String) {
        self.conversationId = conversationId
        Workspace.shared.events
            .sink { [weak self] events in self?.handle(events) }
            .store(in: &subscriptions)
        Workspace.shared.$serviceEvents
            .map { $0[conversationId] ?? [] }
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in DispatchQueue.main.async { self?.rebuild() } }
            .store(in: &subscriptions)
    }

    // MARK: Leitura

    var conversation: Conversation? { detail?.conversation }
    /// Nome a exibir (contato vinculado antes do nome cru da conversa).
    var displayName: String { detail?.displayName ?? "Conversa" }
    var linkedContactName: String? { detail?.linkedContactName }
    var linkedContactPhone: String? { detail?.linkedContactPhone }
    var hasLinkedContact: Bool { detail?.hasLinkedContact ?? false }
    var messages: [Message] { detail?.messages ?? [] }
    var meId: String? { container.user?.id }
    var isAdmin: Bool { container.user?.isAdmin ?? false }
    var isOwned: Bool { conversation?.isOwned(by: meId) ?? false }
    var isGroup: Bool { conversation?.isGroup ?? false }
    func can(_ feature: String) -> Bool { detail?.can(feature) ?? false }
    func allows(_ feature: String) -> Bool { detail?.allows(feature) ?? true }
    var tags: [String] { JSONValue.parseStringList(conversation?.tags) }
    var team: [TeamContact] { workspace.team }
    var role: ConversationRole { conversation?.role(me: meId) ?? .other }
    var groupParticipants: Int {
        guard let group = detail?.group, let value = group["participants"] else { return 0 }
        if let list = value.arrayValue { return list.count }
        return JSONValue.parse(value.stringValue).arrayValue?.count ?? 0
    }
    var groupAnnouncementOnly: Bool { detail?.group?["announcement"]?.boolValue ?? false }

    /// Relógio da janela de 24 h; nil quando não se aplica (grupo ou linha sem janela).
    var window: WindowClock? {
        guard let c = conversation else { return nil }
        return workspace.window(for: c, kind: detail?.connection_kind)
    }

    /// `claim` só vale para conversas sem responsável (fila, bot, concluídas): o servidor devolve 409
    /// already_claimed quando outro atendente é o dono, mesmo para administradores.
    var canClaim: Bool {
        guard let c = conversation, !isOwned else { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty, owner != meId { return false }
        return true
    }

    /// Administrador em conversa de outro atendente: toma a conversa via `transfer` para si mesmo.
    var canTakeOver: Bool {
        guard let c = conversation, isAdmin, meId != nil else { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty, owner != meId { return true }
        return false
    }

    /// Transferir: dono da conversa e administradores, enquanto não estiver concluída.
    var canTransfer: Bool {
        guard let c = conversation else { return false }
        return (isOwned || isAdmin) && c.state != "closed"
    }

    func media(for id: String) -> MediaFile {
        detail?.media.first { $0.id == id } ?? MediaFile(id: id, name: "Anexo", type: "application/octet-stream", size: 0)
    }

    func ownerName(_ id: String?) -> String { workspace.personName(id) }

    func authorLabel(_ m: Message) -> String {
        if m.isNote { return "Nota interna · " + ownerName(m.author) }
        if m.isIncoming { return m.contentJSON["participant_name"]?.stringValue ?? (isGroup ? "Participante" : displayName) }
        if m.author == meId { return "Você" }
        switch sender(of: m, content: .null) {
        case .bot(let name): return name
        case .agent(let name): return name
        default: return "Equipe"
        }
    }

    var canSend: Bool {
        guard isOwned, !busy else { return false }
        if pending != nil { return true }
        if editing != nil { return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty || voice != nil || location != nil || contactDraft != nil
    }

    var composerLocked: Bool { busy || pending != nil }

    // MARK: Carga e eventos

    func appear() {
        visible = true
        workspace.markRead(conversationId)
        if !loadedOnce {
            loadedOnce = true
            Task { await load() }
            Task { await loadPresence() }
        } else {
            Task { await load(silent: true) }
        }
    }

    func disappear() { visible = false }

    func load(silent: Bool = false) async {
        guard let p = profileId else { return }
        loadedOnce = true
        if !silent, detail == nil { loading = true }
        do {
            let d = try await container.api.conversation(p, id: conversationId)
            let grew = (detail?.messages.count ?? 0) < d.messages.count
            detail = d
            error = nil
            workspace.record(detail: d)
            if visible { workspace.markRead(conversationId) }
            reconcileOutgoing(d)
            rebuild()
            if grew { scrollToken += 1 }
        } catch {
            if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized(); return }
            if detail == nil { self.error = APIError.describe(error) } else { actionError = APIError.describe(error) }
        }
        loading = false
    }

    func loadPresence() async {
        await workspace.refreshTeam()
        rebuild()
    }

    /// Protocolos desta conversa: `GET /tickets?q=<telefone só dígitos>` filtrado por `conversation_id`.
    func loadTickets() async {
        guard let p = profileId else { return }
        let digits = (conversation?.phone ?? "").filter(\.isNumber)
        guard let page = try? await container.api.tickets(p, q: digits.isEmpty ? nil : digits) else { return }
        tickets = page.data.filter { $0.conversation_id == conversationId }.sorted { $0.created > $1.created }
    }

    private func handle(_ events: [Event]) {
        let id = conversationId
        let relevant = events.contains { e in
            (e.isConversationRelated && e.conversationId == id) || (e.isCallRelated && e.conversationId == id)
        }
        if relevant, visible { Task { await self.load(silent: true) } }
        if visible, events.contains(where: { $0.kind.hasPrefix("ticket.") && $0.payload?["conversation_id"]?.stringValue == id }) {
            Task { await self.loadTickets() }
        }
    }

    // MARK: Linha do tempo

    private func sender(of m: Message, content: JSONValue) -> ChatMessage.Sender {
        if m.isIncoming {
            guard isGroup else { return .none }
            return .participant(content["participant_name"]?.stringValue ?? "Participante")
        }
        if m.author == meId { return .me }
        if m.author == "system" { return .automatic }
        if m.author == "bot:attendant" || m.author == "ai" || m.author.isEmpty { return .bot("Atendimento automático") }
        if m.author.hasPrefix("bot:") { return .bot(workspace.botName(m.author) ?? "Bot") }
        if m.author.hasPrefix("app:") { return .bot("Integração") }
        return .agent(workspace.personName(m.author))
    }

    /// Monta dias → itens (mensagens, chips de evento e envios pendentes) uma vez por mudança de dados,
    /// para que digitar no composer não refaça nem reinterprete as mensagens.
    private func rebuild() {
        guard let detail else { timeline = []; return }
        var items: [ChatItem] = []
        var previous: (side: ChatMessage.Side, author: String)?
        let byId = Dictionary(detail.messages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for m in detail.messages {
            if m.direction == "system" {
                items.append(.event(ServiceEvent(id: m.id, kind: "info", text: m.text, created: m.created)))
                previous = nil
                continue
            }
            let content = m.contentJSON
            let side: ChatMessage.Side = m.isNote ? .note : (m.isIncoming ? .incoming : .outgoing)
            let authorKey = m.isIncoming ? (content["participant"]?.stringValue ?? m.author) : m.author
            let first = previous == nil || previous?.side != side || previous?.author != authorKey
            previous = (side, authorKey)

            var quotedText: String?
            var quotedAuthor: String?
            var quotedId: String?
            if content["reply_to"] != nil || content["reply_external_id"] != nil {
                let replyTo = content["reply_to"]?.stringValue
                let external = content["reply_external_id"]?.stringValue
                let original = replyTo.flatMap { byId[$0] } ?? detail.messages.first { external != nil && $0.external_id == external }
                quotedId = original?.id
                if let t = content["reply_text"]?.stringValue, !t.isEmpty { quotedText = t }
                else if let t = original?.text, !t.isEmpty { quotedText = t }
                else { quotedText = original?.attachmentIds.isEmpty == false ? "Anexo" : "Mensagem citada" }
                if let original { quotedAuthor = original.isIncoming ? (original.contentJSON["participant_name"]?.stringValue ?? detail.displayName) : (original.author == meId ? "Você" : "Equipe") }
                else if let fromMe = content["reply_from_me"]?.boolValue { quotedAuthor = fromMe ? "Você" : detail.displayName }
            }
            let reactions = (content["reactions"]?.objectValue ?? [:]).values.compactMap { $0["emoji"]?.stringValue }.filter { !$0.isEmpty }
            items.append(.message(ChatMessage(
                message: m, content: content, media: m.attachmentIds.map { media(for: $0) }, side: side,
                sender: sender(of: m, content: content), firstInGroup: first,
                quotedText: quotedText, quotedAuthor: quotedAuthor, quotedId: quotedId, reactions: reactions
            )))
        }
        for event in workspace.serviceEvents[conversationId] ?? [] { items.append(.event(event)) }
        // Entregas pendentes feitas em outro lugar (as daqui já estão em `outgoing`, com o texto).
        let known = Set(outgoing.map(\.id))
        for d in detail.deliveries where !["sent", "cancelled"].contains(d.status) && !known.contains(d.id) {
            items.append(.pending(PendingBubble(id: d.id, text: "", created: d.created, status: d.status, error: d.error)))
        }
        for bubble in outgoing { items.append(.pending(bubble)) }
        // Ordenação estável por horário: um chip entre duas mensagens quebra o grupo.
        let ordered = items.enumerated().sorted { a, b in
            a.element.created != b.element.created ? a.element.created < b.element.created : a.offset < b.offset
        }.map(\.element)

        var days: [ChatDay] = []
        var lastWasEvent = false
        for var item in ordered {
            if case .message(var m) = item {
                if lastWasEvent { m.firstInGroup = true; item = .message(m) }
                lastWasEvent = false
            } else {
                lastWasEvent = true
            }
            let key = ConversationFormatting.dayKey(item.created)
            if days.last?.id != key {
                if case .message(var m) = item { m.firstInGroup = true; item = .message(m) }
                days.append(ChatDay(id: key, title: ConversationFormatting.dayChip(item.created), items: [item]))
            } else {
                days[days.count - 1].items.append(item)
            }
        }
        if days != timeline { timeline = days }
    }

    /// Tira dos envios locais o que já virou mensagem (`delivery:<id>`) e marca o que falhou.
    private func reconcileOutgoing(_ d: ConversationDetail) {
        guard !outgoing.isEmpty else { return }
        let sent = Set(d.messages.map(\.id))
        outgoing.removeAll { sent.contains("delivery:\($0.id)") }
        for i in outgoing.indices {
            if let delivery = d.deliveries.first(where: { $0.id == outgoing[i].id }) {
                outgoing[i].status = delivery.status
                outgoing[i].error = delivery.error
            }
        }
        outgoing.removeAll { $0.status == "cancelled" || $0.status == "sent" }
    }

    func dismissPending(_ bubble: PendingBubble) {
        outgoing.removeAll { $0.id == bubble.id }
        rebuild()
    }

    // MARK: Ações da conversa

    @discardableResult
    func act(_ action: String, text: String? = nil, target: String? = nil, tags: [String]? = nil, menuId: String? = nil, departmentId: String? = nil, number: String? = nil) async -> Bool {
        guard let p = profileId, !busy else { return false }
        busy = true
        busyAction = action
        actionError = nil
        defer { busy = false; busyAction = nil }
        let body = ActionRequest(action: action, text: text, target: target, attachments: nil, content: nil, tags: tags, menu_id: menuId, department_id: departmentId, number: number)
        let actionKey = pendingAction?.body == body ? pendingAction!.key : APIClient.newIdempotencyKey()
        pendingAction = (body, actionKey)
        do {
            _ = try await container.api.act(p, conversation: conversationId, body, key: actionKey)
            pendingAction = nil
            await load(silent: true)
            workspace.refreshCounts()
            return true
        } catch {
            if let e = error as? APIError, (400..<500).contains(e.status) && ![408, 429].contains(e.status) && !["operation_unknown", "idempotency_conflict"].contains(e.code) { pendingAction = nil }
            handleActionError(error)
            return false
        }
    }

    /// Assumir: um toque, sem diálogo.
    func claim() async {
        guard let c = conversation else { return }
        let reopening = c.state == "closed"
        let ok = canTakeOver ? await act("transfer", target: meId) : await act("claim")
        if ok {
            Haptics.success()
            workspace.addLocalEvent("claim", reopening ? "Você reabriu e assumiu a conversa" : "Você assumiu a conversa", to: conversationId)
        }
    }

    func resolve() async -> Bool {
        guard await act("resolve") else { return false }
        workspace.addLocalEvent("resolve", "Você concluiu a conversa", to: conversationId)
        workspace.show("Conversa concluída", style: .success)
        return true
    }

    /// Devolve a conversa ao atendimento automático do perfil.
    func resumeAutomation() async -> Bool {
        guard await act("resume") else { return false }
        Haptics.success()
        workspace.addLocalEvent("resume", "Devolvida ao atendimento automático", to: conversationId)
        workspace.show("Conversa devolvida ao bot", style: .success)
        return true
    }

    func transfer(to contact: TeamContact) async -> Bool {
        guard await act("transfer", target: contact.transferTarget) else { return false }
        Haptics.success()
        workspace.addLocalEvent("transfer", contact.isBot ? "Transferida para o bot \(contact.name)" : "Transferida para \(contact.name)", to: conversationId)
        workspace.show("Transferida para \(contact.name)", style: .success)
        return true
    }

    func transfer(toDepartment department: Department) async -> Bool {
        guard await act("transfer", departmentId: department.id) else { return false }
        Haptics.success()
        workspace.addLocalEvent("queue", "Encaminhada ao setor \(department.name)", to: conversationId)
        workspace.show("Encaminhada ao setor \(department.name)", style: .success)
        return true
    }

    /// Envia o menu principal (`nil`) ou um submenu ao cliente; a conversa segue comigo até ele escolher.
    func sendMenu(id: String?, label: String) async -> Bool {
        guard await act("menu", menuId: id) else { return false }
        workspace.addLocalEvent("menu", id == nil ? "Menu principal enviado ao cliente" : "Menu \"\(label)\" enviado ao cliente", to: conversationId)
        workspace.show("Menu enviado", style: .success)
        forceScrollToken += 1
        return true
    }

    /// Envia ao cliente a consulta dos protocolos dele (ou de um número específico).
    func sendProtocols(number: String? = nil) async -> Bool {
        guard await act("protocols", number: number) else { return false }
        workspace.addLocalEvent("protocols", "Consulta de protocolos enviada ao cliente", to: conversationId)
        workspace.show("Consulta de protocolos enviada", style: .success)
        forceScrollToken += 1
        return true
    }

    func sendSurvey() async -> Bool {
        guard await act("survey") else { return false }
        workspace.addLocalEvent("survey", "Pesquisa de satisfação enviada", to: conversationId)
        workspace.show("Pesquisa de satisfação enviada", style: .success)
        forceScrollToken += 1
        return true
    }

    /// Abre um protocolo para esta conversa (`POST /tickets`). Devolve o protocolo ou nil (erro em `actionError`).
    func openTicket(title: String, key: String) async -> Ticket? {
        guard let p = profileId else { return nil }
        actionError = nil
        do {
            let ticket = try await container.api.createTicket(p, TicketCreate(conversation_id: conversationId, title: title), key: key)
            workspace.addLocalEvent("ticket", "Protocolo \(ticket.number) aberto", to: conversationId)
            workspace.show("Protocolo \(ticket.number) aberto", style: .success)
            await loadTickets()
            await workspace.refreshTicketCounts()
            return ticket
        } catch {
            handleActionError(error)
            return nil
        }
    }

    func sendNote(_ text: String? = nil) async -> Bool {
        let value = (text ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        guard await act("note", text: value) else { return false }
        if text == nil { draft = "" }
        forceScrollToken += 1
        return true
    }

    func setPolicy(_ policy: String) async {
        guard let p = profileId else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await container.api.groupPolicy(p, conversation: conversationId, policy: policy)
            await load(silent: true)
        } catch { handleActionError(error) }
    }

    func saveContact(name: String, phone: String) async -> Bool {
        guard let p = profileId else { return false }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await container.api.saveConversationContact(p, conversation: conversationId, name: name, phone: phone.isEmpty ? nil : phone)
            await load(silent: true)
            workspace.show("Contato salvo", style: .success)
            return true
        } catch {
            handleActionError(error)
            return false
        }
    }

    // MARK: Ações por mensagem

    func messageAction(_ action: String, message: Message, emoji: String? = nil, text: String? = nil) async {
        guard let p = profileId else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await container.api.messageAction(p, conversation: conversationId, MessageActionRequest(action: action, message_id: message.id, emoji: emoji, text: text))
            if action == "read" { workspace.show("Marcada como lida") }
            if action == "delete" { workspace.show("Mensagem apagada") }
            await load(silent: true)
        } catch { handleActionError(error) }
    }

    /// As ações por mensagem exigem a conversa assumida e uma mensagem já entregue ao canal.
    func isActionable(_ m: ChatMessage) -> Bool {
        m.message.external_id != nil && m.side != .note && !m.isDeleted && isOwned
    }

    func canEdit(_ m: Message) -> Bool {
        can("edit") && m.direction == "outbound" && m.attachmentIds.isEmpty && m.external_id != nil
            && Date().timeIntervalSince1970 * 1000 - Double(m.created) < 15 * 60 * 1000
    }

    func beginReply(_ m: Message) {
        editing = nil
        quote = m
        Haptics.light()
    }

    func beginEdit(_ m: Message) {
        editing = m
        quote = nil
        draft = m.text
    }

    func cancelEdit() {
        editing = nil
        draft = ""
    }

    /// "Tentar de novo" de uma mensagem que falhou: devolve o texto ao composer para um novo envio.
    func retry(_ m: Message) {
        guard isOwned, !m.text.isEmpty else { return }
        editing = nil
        draft = m.text
    }

    // MARK: Envio

    func send() {
        guard sendTask == nil else { return }
        sendTask = Task {
            await performSend()
            sendTask = nil
        }
    }

    func abandonPending() {
        pending = nil
        key = APIClient.newIdempotencyKey()
        actionError = nil
        info = "Pedido abandonado. Confira Entregas no painel antes de reenviar para evitar duplicidade."
    }

    func clearComposer() {
        draft = ""
        quote = nil
        editing = nil
        discardMedia()
        location = nil
        contactDraft = nil
    }

    // Localização e contato são tipos próprios de `content.type` e não aceitam anexos (o servidor responde
    // 400 "Tipo incompatível com o anexo."), então escolher um descarta arquivos/áudio, e vice-versa.

    func setLocation(_ draft: LocationDraft) {
        location = draft
        contactDraft = nil
        dropMediaForStructuredContent()
    }

    func setContactDraft(_ draft: ContactDraft) {
        contactDraft = draft
        location = nil
        dropMediaForStructuredContent()
    }

    /// Acrescenta um arquivo ao envio (até 10) e remove rascunho de localização/contato.
    func addAttachment(_ attachment: PendingAttachment) {
        guard attachments.count < 10 else { return }
        attachments.append(attachment)
        dropStructuredContentForMedia()
    }

    func setVoice(_ recording: VoiceRecording) {
        if let v = voice, v.url != recording.url { try? FileManager.default.removeItem(at: v.url) }
        voice = recording
        dropStructuredContentForMedia()
    }

    func discardVoice() {
        if let v = voice { try? FileManager.default.removeItem(at: v.url) }
        voice = nil
    }

    private func dropMediaForStructuredContent() {
        guard !attachments.isEmpty || voice != nil else { return }
        discardMedia()
        info = "Anexos removidos: localização e contato são enviados sem arquivos."
    }

    private func dropStructuredContentForMedia() {
        guard location != nil || contactDraft != nil else { return }
        location = nil
        contactDraft = nil
        info = "Localização/contato removidos: eles não podem ir junto com arquivos."
    }

    private func discardMedia() {
        attachments = []
        if let v = voice { try? FileManager.default.removeItem(at: v.url) }
        voice = nil
        sendKind = .auto
    }

    private func performSend() async {
        guard let p = profileId, let c = conversation else { return }
        busy = true
        actionError = nil
        info = nil
        defer { busy = false; progress = nil }
        do {
            if let editing {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { actionError = "Escreva o novo texto da mensagem."; return }
                _ = try await container.api.messageAction(p, conversation: c.id, MessageActionRequest(action: "edit", message_id: editing.id, emoji: nil, text: text), key: key)
            } else {
                if pending == nil { pending = try await buildRequest(profile: p) }
                guard let req = pending else { return }
                progress = "Confirmando envio…"
                let result = try await container.api.act(p, conversation: c.id, req.body, key: req.key)
                // O servidor só grava a mensagem quando entrega: até lá, a bolha fica aqui com o relógio.
                if let deliveryId = result["delivery_id"]?.stringValue {
                    let text = req.body.text?.isEmpty == false ? req.body.text! : req.summary.prefix(1).uppercased() + req.summary.dropFirst()
                    outgoing.append(PendingBubble(id: deliveryId, text: text, created: workspace.nowMillisPrecise, status: "pending", error: nil))
                }
            }
            Haptics.light()
            pending = nil
            key = APIClient.newIdempotencyKey()
            clearComposer()
            rebuild()
            forceScrollToken += 1
            await load(silent: true)
            forceScrollToken += 1
        } catch {
            handleActionError(error)
        }
    }

    /// Envia os anexos e monta o corpo do `reply`. Só roda uma vez por intenção; o resultado fica em `pending`.
    private func buildRequest(profile p: String) async throws -> PendingRequest {
        var ids: [String] = []
        let structured = location != nil || contactDraft != nil
        if structured {
            // location/contacts não aceitam anexos; o composer já descartou arquivos, aqui é só garantia.
        } else if let voice {
            let data = try Data(contentsOf: voice.url)
            ids.append(try await upload(p, data: data, name: voice.fileName, type: voice.mimeType))
        } else {
            for a in attachments {
                ids.append(try await upload(p, data: a.data, name: a.name, type: a.mimeType))
            }
        }
        var content: [String: JSONValue] = [:]
        let type: String
        if let voice { type = voice.contentType }
        else if location != nil { type = "location" }
        else if contactDraft != nil { type = "contacts" }
        else if sendKind == .document, !ids.isEmpty { type = "document" }
        else { type = "text" }
        content["type"] = .string(type)
        if let quote, can("reply") { content["reply_to"] = .string(quote.id) }
        if let l = location {
            content["location"] = .object(["latitude": .number(l.latitude), "longitude": .number(l.longitude), "name": .string(l.name), "address": .string(l.address)])
        }
        if let ct = contactDraft {
            content["contacts"] = .array([.object(["name": .string(ct.name), "phone": .string(ct.phone)])])
        }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = ActionRequest(action: "reply", text: text, target: nil, attachments: ids.isEmpty ? nil : ids, content: .object(content), tags: nil)
        var parts: [String] = []
        if !text.isEmpty { parts.append("texto") }
        if voice != nil, !structured { parts.append("áudio") }
        if !attachments.isEmpty, voice == nil, !structured { parts.append(attachments.count == 1 ? "1 anexo" : "\(attachments.count) anexos") }
        if location != nil { parts.append("localização") }
        if contactDraft != nil { parts.append("contato") }
        return PendingRequest(body: body, key: key, summary: parts.joined(separator: ", "))
    }

    private func upload(_ p: String, data: Data, name: String, type: String) async throws -> String {
        guard data.count <= 100 * 1024 * 1024 else {
            throw APIError(status: 413, code: "too_large", message: "Cada arquivo pode ter até 100 MB. O canal pode ter limites menores.")
        }
        progress = "Enviando \(name): 0%"
        return try await container.api.uploadFile(p, data: data, name: name, type: type) { [weak self] fraction in
            let pct = Int((fraction * 100).rounded())
            Task { @MainActor in self?.progress = "Enviando \(name): \(pct)%" }
        }
    }

    // MARK: Erros

    private func handleActionError(_ error: Error) {
        if let e = error as? APIError {
            if e.isUnauthorized { container.handleUnauthorized(); return }
            if e.isIdempotencyConflict {
                key = APIClient.newIdempotencyKey()
                if pending != nil { pending?.key = key }
                actionError = "O servidor já registrou um pedido diferente com esta chave. Uma nova chave foi gerada; confira Entregas e toque em Tentar novamente se precisar."
                return
            }
            if e.code == "unsupported_capability" {
                actionError = "O canal desta conversa não oferece este recurso. " + e.message
                return
            }
        }
        actionError = APIError.describe(error)
    }
}

extension Workspace {
    /// Agora em milissegundos (sem esperar o relógio de 30 s das telas), já corrigido pelo servidor.
    var nowMillisPrecise: Int64 { nowMillis - Int64((now.timeIntervalSince1970 * 1000).rounded()) + Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}
