import Foundation
import Combine

/// Prévia da última mensagem de uma conversa, mantida no aparelho (a lista do servidor não traz).
struct MessagePreview: Codable, Equatable {
    /// text | image | video | audio | voice | document | sticker | location | contacts | note | attachment
    var kind: String
    var text: String
    /// customer | outbound | note
    var direction: String
    var created: Int64
    var status: String?

    var isOutgoing: Bool { direction == "outbound" || direction == "operator" }
    var isNote: Bool { direction == "note" || kind == "note" }

    /// `last_message` do servidor (0.14+) no formato da prévia da lista.
    init(_ last: LastMessage) {
        kind = last.direction == "note" ? "note" : (last.kind == "text" && last.attachments > 0 ? "attachment" : last.kind)
        text = last.text
        direction = last.direction
        created = last.created
        status = last.direction == "outbound" || last.direction == "operator" ? last.deliveryStatus : nil
    }

    init(kind: String, text: String, direction: String, created: Int64, status: String?) {
        self.kind = kind; self.text = text; self.direction = direction; self.created = created; self.status = status
    }

    /// Prévia mostrada na linha da conversa: `last_message` do servidor quando vier (0.14+); o cache local fica como
    /// reserva para servidores antigos e só passa na frente quando é mais novo (evento que chegou antes da recarga da
    /// lista). Para a mesma mensagem, o cache mantém o que só o detalhe sabe (áudio de voz).
    static func forList(_ conversation: Conversation, cached: MessagePreview?) -> MessagePreview? {
        guard let last = conversation.lastMessage else { return cached }
        var server = MessagePreview(last)
        guard let cached else { return server }
        if cached.created > server.created { return cached }
        if cached.created == server.created, cached.kind == "voice" { server.kind = "voice" }
        return server
    }

    /// Ícone e rótulo do anexo ("Foto", "Áudio", "Documento", "Localização"…); nil para texto puro.
    var attachmentLabel: (icon: String, title: String)? {
        switch kind {
        case "image": return ("camera.fill", "Foto")
        case "video": return ("video.fill", "Vídeo")
        case "voice": return ("mic.fill", "Áudio")
        case "audio": return ("music.note", "Áudio")
        case "document": return ("doc.fill", "Documento")
        case "sticker": return ("face.smiling", "Figurinha")
        case "location": return ("mappin.circle.fill", "Localização")
        case "contacts": return ("person.crop.circle.fill", "Contato")
        case "attachment": return ("paperclip", "Anexo")
        case "interactive": return text.isEmpty ? ("list.bullet.rectangle", "Mensagem interativa") : nil
        default: return nil
        }
    }
}

/// Evento do atendimento mostrado como chip central na conversa (assumida, transferida, concluída,
/// menu enviado, protocolo aberto). O servidor não grava esses eventos como mensagens: o app monta os
/// chips a partir das próprias ações e dos eventos `conversation.updated` / `ticket.created`.
struct ServiceEvent: Codable, Equatable, Identifiable {
    var id: String
    /// claim | transfer | resolve | resume | queue | menu | ticket | protocols | survey
    var kind: String
    var text: String
    var created: Int64

    var icon: String {
        switch kind {
        case "claim": return "person.fill.checkmark"
        case "transfer": return "arrowshape.turn.up.right.fill"
        case "resolve": return "checkmark.circle.fill"
        case "resume": return "cpu"
        case "queue": return "hourglass"
        case "menu": return "list.bullet"
        case "ticket", "protocols": return "doc.text.fill"
        case "survey": return "star.fill"
        default: return "info.circle.fill"
        }
    }
}

/// Aviso curto que aparece no rodapé e some sozinho.
struct Toast: Equatable, Identifiable {
    enum Style { case info, success, error }
    let id = UUID()
    var text: String
    var style: Style = .info
    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
}

/// Estado compartilhado do perfil aberto: linhas, setores, equipe, presença, contadores, prévias,
/// não lidas, relógio único das telas e o laço de eventos (um só para o app, a cada 4 s em primeiro plano).
@MainActor
final class Workspace: ObservableObject {
    static let shared = Workspace()

    // MARK: Dados do servidor
    @Published private(set) var status: ProfileStatus?
    @Published private(set) var team: [TeamContact] = []
    @Published private(set) var presence: [PresenceEntry] = []
    @Published private(set) var profiles: [Profile] = []
    @Published private(set) var ringing: [Call] = []
    @Published private(set) var ticketCounts = TicketCounts()
    @Published private(set) var loadedOnce = false

    // MARK: Estado local
    @Published private(set) var previews: [String: MessagePreview] = [:]
    @Published private(set) var unread: [String: Int] = [:]
    @Published private(set) var internalUnread: [String: Int] = [:]
    @Published private(set) var internalPreviews: [String: MessagePreview] = [:]
    @Published private(set) var serviceEvents: [String: [ServiceEvent]] = [:]
    /// Quantas conversas cada pessoa tem em atendimento (das conversas carregadas).
    @Published var ownerLoad: [String: Int] = [:]
    /// Relógio único das telas: avança a cada 30 s (e na hora quando chega mensagem do cliente).
    @Published private(set) var now = Date()
    @Published private(set) var offline = false
    @Published var toast: Toast?
    @Published private(set) var presenceBusy = false

    /// Eventos novos do perfil, para as telas abertas reagirem.
    let events = PassthroughSubject<[Event], Never>()

    /// Contadores dos protocolos ativos (nem resolvidos nem encerrados), para os chips e o contador da aba.
    struct TicketCounts: Equatable {
        var active = 0
        var open = 0
        var inProgress = 0
        var waiting = 0
        var overdue = 0
        var hasMore = false

        /// Conta a partir da lista de protocolos (só os ativos entram; atrasado = ativo sem resposta e com prazo vencido).
        init(_ tickets: [Ticket] = [], now: Date = Date(), hasMore: Bool = false) {
            for t in tickets where t.isActive {
                active += 1
                if t.status == TicketStatus.open { open += 1 }
                if t.status == TicketStatus.inProgress { inProgress += 1 }
                if TicketStatus.waiting.contains(t.status) { waiting += 1 }
                if t.isOverdue(at: now) { overdue += 1 }
            }
            self.hasMore = hasMore
        }
    }

    private var container: AppContainer { AppContainer.shared }
    private var profileId: String?
    private var poller: EventsPoller?
    private var clock: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var backfilling: Set<String> = []
    private var backfillTask: Task<Void, Never>?
    private var presenceKey: String?
    private var pendingPresence: Bool?
    private var lastStatusRefresh = Date.distantPast
    private var toastTask: Task<Void, Never>?
    /// Diferença entre o relógio do servidor e o do aparelho (ms), para a janela de 24 h.
    private var clockOffset: Int64 = 0
    /// Conversa interna aberta no momento (não soma não lidas).
    var visibleInternalChatId: String?

    private init() {}

    // MARK: Leitura

    var meId: String? { container.user?.id }
    var isAdmin: Bool { container.user?.isAdmin ?? false }
    var nowMillis: Int64 { Int64((now.timeIntervalSince1970 * 1000).rounded()) + clockOffset }
    var mePresent: Bool { (presence.first { $0.actor == meId }?.present ?? 0) == 1 }
    var departments: [Department] { (status?.departments ?? []).filter(\.enabled) }
    /// Categorias de protocolo do perfil (inclusive desabilitadas, para nomear protocolos antigos); vazio em servidores 0.13.
    var ticketCategories: [TicketCategory] { status?.ticketCategories ?? [] }
    func categoryName(_ id: String?) -> String? { ticketCategories.name(of: id) }
    /// Prévia da linha da conversa: `last_message` do servidor, com o cache local como reserva.
    func preview(for conversation: Conversation) -> MessagePreview? { MessagePreview.forList(conversation, cached: previews[conversation.id]) }
    var people: [TeamContact] { team.filter { !$0.isBot } }
    var bots: [TeamContact] { team.filter(\.isBot) }
    var onlinePeople: Int { people.filter(\.online).count }
    var activeBots: Int { bots.filter { $0.online && ($0.enabled ?? true) }.count }
    var totalUnread: Int { unread.values.reduce(0, +) }
    var totalInternalUnread: Int { internalUnread.values.reduce(0, +) }
    var profileName: String {
        guard let id = container.profileId else { return "" }
        return profiles.first { $0.id == id }?.name ?? ""
    }

    func count(_ state: String) -> Int { status?.conversationCount(state) ?? 0 }
    func connectionKind(_ id: String?) -> String? { status?.connectionKind(id) }
    func connectionName(_ id: String?) -> String? {
        guard let id else { return nil }
        return status?.connections.first { $0.id == id }?.name
    }
    func department(_ id: String?) -> Department? {
        guard let id, !id.isEmpty else { return nil }
        return status?.departments.first { $0.id == id }
    }

    /// Relógio da janela de uma conversa; nil quando a janela não se aplica (grupo, linha sem janela).
    func window(for conversation: Conversation, kind: String? = nil) -> WindowClock? {
        let lineKind = kind ?? connectionKind(conversation.connection_id)
        guard WindowClock.applies(chatType: conversation.chat_type, connectionKind: lineKind) else { return nil }
        return WindowClock(lastCustomer: conversation.last_customer, now: nowMillis)
    }

    /// Nome de uma pessoa da equipe ("Você" para mim).
    func personName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "" }
        if id == meId { return "Você" }
        if let p = presence.first(where: { $0.actor == id }), !p.name.isEmpty { return p.name }
        if let t = team.first(where: { $0.id == id }), !t.name.isEmpty { return t.name }
        return "Atendente"
    }

    func isOnline(_ id: String?) -> Bool {
        guard let id else { return false }
        if let t = team.first(where: { $0.id == id }) { return t.online }
        return (presence.first { $0.actor == id }?.present ?? 0) == 1
    }

    /// Nome do bot a partir do id cru ou de `bot:<id>`; nil quando não está na equipe.
    func botName(_ id: String?) -> String? {
        guard var key = id, !key.isEmpty else { return nil }
        if key.hasPrefix("bot:") { key = String(key.dropFirst(4)) }
        return bots.first { $0.botKey == key }?.name
    }

    // MARK: Ciclo de vida

    /// Liga o relógio, o laço de eventos e carrega os dados do perfil. Idempotente.
    func activate() {
        guard let p = container.profileId else { return }
        if p != profileId { switchProfile(to: p) }
        if clock == nil {
            clock = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    if Task.isCancelled { return }
                    self?.now = Date()
                }
            }
        }
        if poller == nil {
            let poller = EventsPoller(container: container, profileId: p) { [weak self] events in self?.handle(events) }
            poller.onConnectivity = { [weak self] ok in
                guard let self, self.offline == ok else { return }
                self.offline = !ok
            }
            self.poller = poller
        }
        poller?.start()
        now = Date()
        refresh()
    }

    /// App em segundo plano ou fora das telas principais: para os laços (o push assume).
    func deactivate() {
        poller?.stop()
        clock?.cancel()
        clock = nil
    }

    /// Sessão encerrada ou perfil trocado.
    func reset() {
        deactivate()
        poller = nil
        refreshTask?.cancel()
        backfillTask?.cancel()
        profileId = nil
        status = nil
        team = []
        presence = []
        ringing = []
        ticketCounts = TicketCounts()
        previews = [:]
        unread = [:]
        internalUnread = [:]
        internalPreviews = [:]
        serviceEvents = [:]
        ownerLoad = [:]
        loadedOnce = false
        offline = false
    }

    private func switchProfile(to p: String) {
        reset()
        profileId = p
        loadCache()
        #if DEBUG
        DemoMode.seedLocalState(self)
        #endif
    }

    /// Recarrega linhas, setores, equipe, presença, ligações tocando e contadores de protocolo.
    func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in await self?.refreshNow() }
    }

    func refreshNow() async {
        guard let p = container.profileId else { return }
        let api = container.api
        async let statusRequest = try? api.profileStatus(p)
        async let teamRequest = try? api.team(p)
        async let presenceRequest = try? api.presence(p)
        async let profilesRequest = try? api.profiles()
        let (s, t, pr, profs) = await (statusRequest, teamRequest, presenceRequest, profilesRequest)
        if Task.isCancelled || p != container.profileId { return }
        if let s { status = s; lastStatusRefresh = Date() }
        if let t { team = t }
        if let pr, pendingPresence == nil { presence = pr }
        if let profs { profiles = profs }
        loadedOnce = true
        await refreshRinging()
        await refreshTicketCounts()
    }

    /// Só os contadores por estado (chips da lista), no máximo uma vez a cada 3 s.
    func refreshCounts() {
        guard Date().timeIntervalSince(lastStatusRefresh) > 3, let p = container.profileId else { return }
        lastStatusRefresh = Date()
        Task { [weak self] in
            guard let self, let s = try? await self.container.api.profileStatus(p), p == self.container.profileId else { return }
            self.status = s
        }
    }

    func refreshTeam() async {
        guard let p = container.profileId else { return }
        let api = container.api
        async let teamRequest = try? api.team(p)
        async let presenceRequest = try? api.presence(p)
        let (t, pr) = await (teamRequest, presenceRequest)
        if p != container.profileId { return }
        if let t { team = t }
        if let pr, pendingPresence == nil { presence = pr }
    }

    func refreshRinging() async {
        guard let p = container.profileId else { return }
        do {
            let page = try await container.api.calls(p, limit: 30)
            let me = meId
            ringing = page.data.filter { $0.status == "ringing" && $0.direction != "outbound" && ($0.actor == nil || $0.actor?.isEmpty == true || $0.actor == me) }
        } catch {
            // Sem permissão de ligações ou canal sem chamadas: o cartão simplesmente não aparece.
        }
    }

    func refreshTicketCounts() async {
        guard let p = container.profileId else { return }
        // Uma consulta dos ativos (`active=1`); um servidor 0.13 ignora o filtro e o app conta só os ativos.
        guard let page = try? await container.api.tickets(p, active: true) else { return }
        ticketCounts = TicketCounts(page.data, hasMore: page.next_cursor != nil)
    }

    // MARK: Presença

    /// `PUT /presence {present}` com atualização otimista; devolve a mensagem de erro, se houver.
    /// Repetir após falha de rede reutiliza a mesma Idempotency-Key.
    @discardableResult
    func setPresence(_ value: Bool) async -> String? {
        guard let p = container.profileId, let me = meId, !presenceBusy else { return nil }
        presenceBusy = true
        defer { presenceBusy = false }
        let previous = presence
        applyPresence(me: me, present: value)
        if pendingPresence != value || presenceKey == nil { presenceKey = APIClient.newIdempotencyKey() }
        pendingPresence = value
        do {
            let result = try await container.api.setPresence(p, present: value, key: presenceKey ?? APIClient.newIdempotencyKey())
            let confirmed = result.present ?? value
            pendingPresence = nil
            presenceKey = nil
            applyPresence(me: me, present: confirmed)
            show(confirmed ? "Você está online" : "Você está offline", style: .success)
            await refreshTeam()
            return nil
        } catch {
            presence = previous
            if let e = error as? APIError {
                if e.isUnauthorized { container.handleUnauthorized(); return nil }
                // O servidor respondeu: a próxima tentativa é outro pedido.
                presenceKey = nil
                pendingPresence = nil
                if e.isIdempotencyConflict { return "O pedido anterior ainda estava em andamento. Tente novamente." }
            }
            return APIError.describe(error)
        }
    }

    private func applyPresence(me: String, present: Bool) {
        if let i = presence.firstIndex(where: { $0.actor == me }) {
            presence[i].present = present ? 1 : 0
        } else {
            presence.append(PresenceEntry(actor: me, name: container.user?.name ?? "", present: present ? 1 : 0))
        }
        if let i = team.firstIndex(where: { $0.id == me }) { team[i].online = present }
    }

    // MARK: Avisos

    func show(_ text: String, style: Toast.Style = .info) {
        let toast = Toast(text: text, style: style)
        self.toast = toast
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            guard !Task.isCancelled, let self, self.toast == toast else { return }
            self.toast = nil
        }
    }

    // MARK: Eventos

    private func handle(_ list: [Event]) {
        var needsCounts = false
        var needsTickets = false
        var needsCalls = false
        for event in list {
            switch event.kind {
            case "message.received":
                guard let id = event.conversationId else { break }
                let text = event.payload?["text"]?.stringValue ?? ""
                let hasAttachment = !(event.payload?["attachments"]?.arrayValue ?? []).isEmpty
                let created = event.created ?? nowMillis
                setPreview(MessagePreview(kind: text.isEmpty && hasAttachment ? "attachment" : "text", text: text, direction: "customer", created: created, status: nil), for: id)
                if PushManager.shared.visibleConversationId != id { unread[id, default: 0] += 1 }
                now = Date() // o anel da janela volta a encher na hora
                needsCounts = true
            case "message.sent":
                guard let id = event.conversationId else { break }
                let text = event.payload?["text"]?.stringValue ?? ""
                let hasAttachment = !(event.payload?["attachments"]?.arrayValue ?? []).isEmpty
                setPreview(MessagePreview(kind: text.isEmpty && hasAttachment ? "attachment" : "text", text: text, direction: "outbound", created: event.created ?? nowMillis, status: "sent"), for: id)
            case "conversation.updated", "conversation.created":
                needsCounts = true
                if let id = event.conversationId, let chip = serviceEvent(from: event) { add(chip, to: id) }
            case "ticket.created":
                needsTickets = true
                if let id = event.payload?["conversation_id"]?.stringValue {
                    let number = event.payload?["number"]?.stringValue ?? ""
                    add(ServiceEvent(id: "event-\(event.id)", kind: "ticket", text: number.isEmpty ? "Protocolo aberto" : "Protocolo \(number) aberto", created: event.created ?? nowMillis), to: id)
                }
            case "internal.message":
                if let chat = event.payload?["chat_id"]?.stringValue, chat != visibleInternalChatId {
                    internalUnread[chat, default: 0] += 1
                    internalPreviews[chat] = nil
                }
            default:
                if event.kind.hasPrefix("ticket.") { needsTickets = true }
                if event.isCallRelated { needsCalls = true }
            }
        }
        saveCache()
        if needsCounts { refreshCounts() }
        if needsTickets { Task { await refreshTicketCounts() } }
        if needsCalls { Task { await refreshRinging() } }
        events.send(list)
    }

    /// Chip a partir de `conversation.updated` (payload `{action, owner?, assigned_bot_id?, state?, department_id?}`).
    private func serviceEvent(from event: Event) -> ServiceEvent? {
        let payload = event.payload
        let created = event.created ?? nowMillis
        let id = "event-\(event.id)"
        let action = payload?["action"]?.stringValue ?? ""
        if payload?["state"]?.stringValue == "waiting" || action == "waiting" {
            let dept = department(payload?["department_id"]?.stringValue)
            return ServiceEvent(id: id, kind: "queue", text: dept.map { "Encaminhada ao setor \($0.name)" } ?? "Conversa entrou na fila", created: created)
        }
        switch action {
        case "claim": return ServiceEvent(id: id, kind: "claim", text: "Conversa assumida", created: created)
        case "resolve": return ServiceEvent(id: id, kind: "resolve", text: "Conversa concluída", created: created)
        case "resume": return ServiceEvent(id: id, kind: "resume", text: "Devolvida ao atendimento automático", created: created)
        case "transfer":
            if let bot = payload?["assigned_bot_id"]?.stringValue, !bot.isEmpty {
                return ServiceEvent(id: id, kind: "transfer", text: "Transferida para o bot \(botName(bot) ?? "")".trimmingCharacters(in: .whitespaces), created: created)
            }
            if let owner = payload?["owner"]?.stringValue, !owner.isEmpty {
                return ServiceEvent(id: id, kind: "transfer", text: owner == meId ? "Transferida para você" : "Transferida para \(personName(owner))", created: created)
            }
            return ServiceEvent(id: id, kind: "transfer", text: "Conversa transferida", created: created)
        default: return nil
        }
    }

    /// Registra um chip (ação feita aqui ou evento do servidor). O mesmo tipo em até 20 s conta uma vez só.
    func add(_ event: ServiceEvent, to conversationId: String) {
        var list = serviceEvents[conversationId] ?? []
        if list.contains(where: { $0.id == event.id || ($0.kind == event.kind && abs($0.created - event.created) < 20_000) }) { return }
        list.append(event)
        list.sort { $0.created < $1.created }
        serviceEvents[conversationId] = Array(list.suffix(40))
        saveCache()
    }

    func addLocalEvent(_ kind: String, _ text: String, to conversationId: String) {
        add(ServiceEvent(id: "local-\(UUID().uuidString)", kind: kind, text: text, created: Int64(Date().timeIntervalSince1970 * 1000) + clockOffset), to: conversationId)
    }

    // MARK: Prévias e não lidas

    func markRead(_ conversationId: String) {
        guard unread[conversationId] != nil else { return }
        unread[conversationId] = nil
        saveCache()
    }

    func markInternalRead(_ chatId: String) {
        guard internalUnread[chatId] != nil else { return }
        internalUnread[chatId] = nil
    }

    private func setPreview(_ preview: MessagePreview, for id: String) {
        if let old = previews[id], old.created > preview.created { return }
        previews[id] = preview
    }

    /// Atualiza a prévia com a última mensagem do detalhe (texto, tipo do anexo, direção e recibo).
    func record(detail: ConversationDetail) {
        if let serverNow = detail.server_now, serverNow > 0 {
            clockOffset = serverNow - Int64((Date().timeIntervalSince1970 * 1000).rounded())
        }
        guard let last = detail.messages.last else { return }
        let preview = Self.preview(of: last, media: detail.media)
        if previews[detail.conversation.id] != preview {
            previews[detail.conversation.id] = preview
            saveCache()
        }
    }

    func record(internal chat: InternalChat) {
        guard let last = chat.messages?.last else { return }
        let mine = last.author == meId
        internalPreviews[chat.id] = MessagePreview(kind: "text", text: last.text, direction: mine ? "outbound" : "customer", created: last.created, status: nil)
    }

    static func preview(of message: Message, media: [MediaFile]) -> MessagePreview {
        let content = message.contentJSON
        var kind = "text"
        if message.isNote { kind = "note" }
        else if content["deleted"]?.boolValue == true { kind = "text" }
        else if content["location"] != nil || content["type"]?.stringValue == "location" { kind = "location" }
        else if !(content["contacts"]?.arrayValue ?? []).isEmpty { kind = "contacts" }
        else if let first = message.attachmentIds.first {
            let type = content["type"]?.stringValue ?? ""
            if ["voice", "sticker", "image", "video", "audio", "document"].contains(type) { kind = type }
            else if let file = media.first(where: { $0.id == first }) {
                kind = file.isImage ? "image" : file.isVideo ? "video" : file.isAudio ? "audio" : "document"
            } else { kind = "attachment" }
        }
        return MessagePreview(kind: kind, text: message.text, direction: message.direction, created: message.created, status: message.delivery_status)
    }

    /// Preenche em segundo plano a prévia das 15 primeiras conversas sem prévia (duas chamadas por vez).
    func backfill(_ conversations: [Conversation]) {
        guard let p = container.profileId else { return }
        // Servidor 0.14+ já manda `last_message` na lista: nada a buscar para essas conversas.
        let missing = conversations.prefix(30).filter { $0.lastMessage == nil && previews[$0.id] == nil && !backfilling.contains($0.id) }.prefix(15).map(\.id)
        guard !missing.isEmpty else { return }
        missing.forEach { backfilling.insert($0) }
        let api = container.api
        backfillTask = Task { [weak self] in
            var index = 0
            while index < missing.count, !Task.isCancelled {
                let pair = Array(missing[index..<min(index + 2, missing.count)])
                index += 2
                await withTaskGroup(of: ConversationDetail?.self) { group in
                    for id in pair { group.addTask { try? await api.conversation(p, id: id) } }
                    for await detail in group {
                        guard let detail, let self else { continue }
                        self.record(detail: detail)
                    }
                }
            }
            guard let self else { return }
            missing.forEach { self.backfilling.remove($0) }
        }
    }

    /// Prévia das conversas internas (a lista do servidor não traz mensagens).
    func backfill(internal chats: [InternalChat]) {
        guard let p = container.profileId else { return }
        let missing = chats.filter { internalPreviews[$0.id] == nil && !backfilling.contains("i:\($0.id)") }.prefix(12).map(\.id)
        guard !missing.isEmpty else { return }
        missing.forEach { backfilling.insert("i:\($0)") }
        let api = container.api
        Task { [weak self] in
            for id in missing {
                if let chat = try? await api.internalChat(p, id: id) { self?.record(internal: chat) }
                self?.backfilling.remove("i:\(id)")
            }
        }
    }

    // MARK: Cache local por perfil

    private struct Cache: Codable {
        var previews: [String: MessagePreview] = [:]
        var unread: [String: Int] = [:]
        var events: [String: [ServiceEvent]] = [:]
    }

    private var cacheKey: String? { profileId.map { "workspace.\($0)" } }

    private func loadCache() {
        guard let key = cacheKey, let data = container.session.cachedData(key), let cache = try? JSONDecoder().decode(Cache.self, from: data) else { return }
        previews = cache.previews
        unread = cache.unread
        serviceEvents = cache.events
    }

    private func saveCache() {
        guard let key = cacheKey else { return }
        // Guarda só o mais recente para o cache não crescer sem limite.
        let keep = Set(previews.sorted { $0.value.created > $1.value.created }.prefix(300).map(\.key))
        let cache = Cache(previews: previews.filter { keep.contains($0.key) }, unread: unread, events: serviceEvents.filter { keep.contains($0.key) })
        container.session.setCachedData(try? JSONEncoder().encode(cache), key)
    }

    #if DEBUG
    /// Estado local de exemplo para a demonstração (não lidas e chips de eventos).
    func seedDemo(unread: [String: Int], events: [String: [ServiceEvent]]) {
        self.unread = unread
        self.serviceEvents = events
    }
    #endif
}
