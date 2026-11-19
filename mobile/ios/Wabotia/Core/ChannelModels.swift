import Foundation

/// Contratos de src/channel-contracts.ts. Valores desconhecidos são conservados, nunca viram WhatsApp.
struct ChannelID: RawRepresentable, Codable, Hashable, Identifiable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        try value.encode(rawValue)
    }
    var id: String { rawValue }
    static let whatsapp = ChannelID(rawValue: "whatsapp")
    static let instagram = ChannelID(rawValue: "instagram")
    static let facebook = ChannelID(rawValue: "facebook")
    static let tiktok = ChannelID(rawValue: "tiktok")
    static let googlebusiness = ChannelID(rawValue: "googlebusiness")
    static let telegram = ChannelID(rawValue: "telegram")
    static let email = ChannelID(rawValue: "email")
    static let all = [whatsapp, instagram, facebook, tiktok, googlebusiness, telegram, email]
    var isKnown: Bool { Self.all.contains(self) }
    var isSocial: Bool { self == .instagram || self == .facebook }
    /// A declaração de canais futuros não habilita conexão, composição ou envio.
    var enabled: Bool { self == .whatsapp || isSocial }
    /// Catálogo nativo: a presença aqui não concede envio; capacidades e contexto são obrigatórios.
    var supportsConversation: Bool { enabled || self == .telegram || self == .email || self == .tiktok }
    var label: String {
        switch self {
        case .whatsapp: return "WhatsApp"
        case .instagram: return "Instagram"
        case .facebook: return "Facebook"
        case .tiktok: return "TikTok"
        case .googlebusiness: return "Google Business"
        case .telegram: return "Telegram"
        case .email: return "E-mail"
        default: return "Canal desconhecido"
        }
    }
}

struct ChannelMenu: Codable, Equatable {
    var buttons: Int
    var quickReplies: Int
    var listItems: Int
    var fallback: String
}

extension ChannelMenu {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        buttons = try values.decodeIfPresent(Int.self, forKey: .buttons) ?? 0
        quickReplies = try values.decodeIfPresent(Int.self, forKey: .quickReplies) ?? 0
        listItems = try values.decodeIfPresent(Int.self, forKey: .listItems) ?? 0
        fallback = try values.decodeIfPresent(String.self, forKey: .fallback) ?? ""
    }
}

/// O servidor decide a janela. A projeção local só expira permissões, nunca as amplia.
struct ChannelWindowState: Codable, Equatable {
    var kind: String
    var state: String
    var serverNow: Int64
    var closesAt: Int64?
    var humanTextClosesAt: Int64?
    var remainingMessages: Int?
    var canHumanText: Bool
    var canAutomation: Bool
    var reason: String?

    var showsClock: Bool { kind == "customer" }
    var isHumanTextOnly: Bool { state == "human_text_only" }

    func projected(at now: Int64) -> Self {
        var result = self
        // Retrocesso do relógio local não reabre prazo já observado pelo servidor.
        let time = max(now, serverNow)
        guard serverNow > 0, kind == "customer" || kind == "none",
              ["open", "human_text_only", "closed"].contains(state) else {
            result.state = "closed"; result.canHumanText = false; result.canAutomation = false
            result.reason = "provider_unknown"
            return result
        }
        if state == "closed" || (remainingMessages.map { $0 <= 0 } ?? false) {
            result.state = "closed"; result.canHumanText = false; result.canAutomation = false
            return result
        }
        guard kind == "customer" else { return result }
        guard let closesAt, closesAt > 0 else {
            result.state = "closed"; result.canHumanText = false; result.canAutomation = false
            result.reason = "window_closed"
            return result
        }
        if time >= closesAt {
            result.canAutomation = false
            if let humanTextClosesAt, humanTextClosesAt > closesAt, time < humanTextClosesAt, canHumanText {
                result.state = "human_text_only"
                result.reason = "human_only"
            } else {
                result.state = "closed"; result.canHumanText = false
                result.reason = "window_closed"
            }
        } else if state == "human_text_only" {
            result.canAutomation = false
        }
        return result
    }

    var label: String {
        if state == "closed" { return ChannelReason.label(reason ?? "window_closed") }
        if isHumanTextOnly { return "Somente texto escrito por pessoa · até 7 dias" }
        return showsClock ? "Janela de 24 horas aberta" : "Sem prazo de resposta"
    }

    func label(for channel: ChannelID?) -> String {
        if state != "open" || !showsClock { return label }
        return channel == .tiktok ? "Janela de 48 horas aberta" : "Janela de 24 horas aberta"
    }
}

extension ChannelWindowState {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "unknown"
        state = try values.decodeIfPresent(String.self, forKey: .state) ?? "closed"
        serverNow = try values.decodeIfPresent(Int64.self, forKey: .serverNow) ?? 0
        closesAt = try values.decodeIfPresent(Int64.self, forKey: .closesAt)
        humanTextClosesAt = try values.decodeIfPresent(Int64.self, forKey: .humanTextClosesAt)
        remainingMessages = try values.decodeIfPresent(Int.self, forKey: .remainingMessages)
        canHumanText = try values.decodeIfPresent(Bool.self, forKey: .canHumanText) ?? false
        canAutomation = try values.decodeIfPresent(Bool.self, forKey: .canAutomation) ?? false
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
    }
}

enum ChannelReason {
    static func label(_ code: String) -> String {
        switch code {
        case "window_closed": return "Janela fechada · aguarde uma nova mensagem do cliente"
        case "human_only": return "Somente texto escrito por pessoa; anexos e automações indisponíveis"
        case "cannot_initiate": return "O cliente precisa iniciar a conversa neste canal"
        case "unsupported_content": return "Este conteúdo não é aceito pelo canal"
        case "inbox_required": return "A conversa precisa estar na caixa de entrada"
        case "channel_not_ready": return "Canal ainda não disponível"
        case "provider_unknown": return "Canal ou capacidades não reconhecidos"
        case "private_reply_used": return "A tentativa de resposta privada já foi usada"
        case "private_reply_expired": return "O prazo para responder em privado terminou"
        case "quota_exhausted": return "Limite de mensagens atingido · aguarde uma vaga"
        case "rate_limited": return "Aguardando o intervalo permitido para envio"
        case "sender_unverified": return "Remetente não confirmado · sem acesso a dados do cliente"
        case "subject_invalid": return "Revise o assunto do e-mail"
        case "attachment_too_large": return "Anexo maior que o permitido pelo canal"
        case "provider_contract_unverified": return "Recurso aguardando confirmação do provedor"
        default: return code
        }
    }
}

struct ChannelView: Codable, Equatable {
    var channel: ChannelID?
    var account_label: String
    var multichannel: Bool
    var window: ChannelWindowState?
    var templates: Bool
    var menu: ChannelMenu?
    var subject: Bool
    var public_reply: Bool
    var modules: Bool
    var can_initiate: Bool
}

struct OtherChannelConversation: Codable, Identifiable, Equatable {
    var id: String
    var channel: ChannelID?
    var account_label: String
    var title: String
    var state: String
    var updated: Int64
}

struct CustomerChannelView: Codable, Identifiable, Equatable {
    var id: String
    var channel: ChannelID
    var account_label: String
    var display_name: String
    var username: String
    var state: String
    var connection_id: String?
    var subject_masked: String?
    var stateLabel: String {
        switch state {
        case "ready": return "Verificado"
        case "pending": return "Pendente"
        case "ambiguous": return "Precisa de conferência"
        case "blocked": return "Restrito"
        case "erased": return "Removido"
        default: return "Situação desconhecida"
        }
    }
}

struct ContactChannelsProfile: Codable {
    var readable: Bool?
    var channels: [CustomerChannelView]?
    var other_conversations: [OtherChannelConversation]?
}

/// Somente a projeção pública normalizada. Todos os acréscimos são opcionais para compatibilidade.
struct ChannelExtensionView: Codable, Equatable {
    var key: String?
    var capabilities: ChannelExtensionCapabilities?
    var metadata: ChannelExtensionMetadata?
}

struct ChannelExtensionCapabilities: Codable, Equatable {
    struct Text: Codable, Equatable { var enabled: Bool?; var maxChars: Int? }
    struct Context: Codable, Equatable { var enabled: Bool?; var bot: Bool?; var publicReply: Bool? }
    struct Media: Codable, Equatable {
        var receive: Bool?; var send: Bool?; var maxSendBytes: Int64?; var mimeTypes: [String]?
    }
    struct Window: Codable, Equatable {
        var kind: String?; var hours: Int?; var humanTextHours: Int?; var maxMessages: Int?; var after: String?
    }
    var enabled: Bool?
    var context: String?
    var contexts: [String: Context]?
    var text: Text?
    var media: [String: Media]?
    var menu: ChannelMenu?
    var window: Window?
    var templates: Bool?
    var subject: Bool?
    var replyTo: Bool?
}

struct ChannelExtensionMetadata: Codable, Equatable {
    var subject: String?
    var identityTrust: String?
    var remainingMessages: Int?
    var closesAt: Int64?
    var state: String?
    var configured: Bool?
    var accountLabel: String?
    var commentId: String?
    var postId: String?
    var permalink: String?
    var version: Int?
    var comment: ChannelCommentMetadata?
    var email: ChannelEmailMetadata?
    var telegram: ChannelTelegramMetadata?
    var tiktok: ChannelTikTokMetadata?
}

struct ChannelCommentMetadata: Codable, Equatable, Identifiable {
    var id: String?
    var postId: String?
    var parentId: String?
    var text: String?
    var postText: String?
    var permalink: String?
    var hidden: Bool?
    var version: Int?
    var privateState: String?
    var privateExpiresAt: Int64?
    var privateConversationId: String?
    var privateLinkPending: Bool?

    func privateReplyAvailable(at now: Int64) -> Bool {
        guard let id, !id.isEmpty, privateState == "available", let privateExpiresAt else { return false }
        return privateExpiresAt > now
    }
    var privateStatusLabel: String {
        switch privateState {
        case "available": return "Uma tentativa de resposta privada"
        case "reserved": return "Tentativa privada reservada"
        case "sent": return privateLinkPending == true ? "Privado enviado; vínculo pendente" : "Resposta privada enviada"
        case "failed": return "Resposta privada falhou · tentativa consumida"
        case "unknown": return "Resposta privada indeterminada · tentativa consumida"
        default: return "Situação da resposta privada indisponível"
        }
    }
    func privateStatusLabel(at now: Int64) -> String {
        guard privateState == "available" else { return privateStatusLabel }
        guard let privateExpiresAt, privateExpiresAt > 0 else { return "Prazo da resposta privada indisponível" }
        return privateExpiresAt <= now ? "Prazo da resposta privada encerrado" : privateStatusLabel
    }
    var safePermalink: URL? { ChannelSafeLink.url(permalink) }
}

enum ChannelSafeLink {
    static func url(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              ["https", "http"].contains(scheme), url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
}

struct ChannelEmailMetadata: Codable, Equatable {
    struct Authentication: Codable, Equatable { var method: String?; var result: String? }
    var subject: String?
    var sender: String?
    var from: String?
    var replyTo: String?
    var identityTrust: String?
    var authentication: [Authentication]?
    var attachmentWarnings: [String]?

    static func validSubject(_ subject: String) -> Bool {
        // Por escalar: em Swift "\r\n" é um caractere só, e contains("\r") não o acha.
        subject.utf16.count <= 200 && !subject.unicodeScalars.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\0" })
    }
    static func replySubject(_ subject: String) -> String {
        var value = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.lowercased().hasPrefix("re:") {
            value = String(value.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return "Re: \(value)"
    }
}

struct ChannelTelegramMetadata: Codable, Equatable {
    struct PhoneSuggestion: Codable, Equatable { var masked: String?; var confirmedByHuman: Bool? }
    var username: String?
    var botUrl: String?
    var blocked: Bool?
    var webhookConfigured: Bool?
    var phoneSuggestion: PhoneSuggestion?
    var safeBotURL: URL? { ChannelSafeLink.url(botUrl) }
}

struct ChannelTikTokMetadata: Codable, Equatable {
    var remainingMessages: Int?
    var closesAt: Int64?
    var conservativeQuota: Bool?
    var remainingLabel: String? {
        guard let remainingMessages, (0...10).contains(remainingMessages) else { return nil }
        return "Restam \(remainingMessages) de 10 mensagens"
    }
    static let quotaExplanation = "Regra conservadora: até 10 envios ou tentativas nas últimas 48 horas. Uma nova mensagem do cliente renova o prazo, mas não zera o contador."
}

struct ChannelSendAttachment: Codable, Equatable {
    var mediaId: String
    var kind: String
    var mimeType: String
    var bytes: Int64
    var name: String? = nil
}

/// Sem ator/origem/prova: toda autorização e resolução de destinatário pertencem ao servidor.
struct ChannelAction: Codable, Equatable {
    var type: String
    var text: String? = nil
    var subject: String? = nil
    var commentId: String? = nil
    var hidden: Bool? = nil
    var attachments: [ChannelSendAttachment]? = nil
}

struct ChannelActionRequest: Codable, Equatable {
    var action: String = "channel"
    var channel_action: ChannelAction
}

/// O corpo é um valor independente: renovar a projeção não muda assunto, alvo ou chave do retry.
struct ChannelActionAttempt: Equatable {
    let body: ChannelActionRequest
    let key: String
    init(body: ChannelActionRequest, key: String = UUID().uuidString) {
        self.body = body; self.key = key
    }
    static func reusing(_ previous: ChannelActionAttempt?, body: ChannelActionRequest) -> ChannelActionAttempt {
        if let previous, previous.body == body { return previous }
        return ChannelActionAttempt(body: body)
    }
}

extension Message {
    /// Ponto único de leitura dos metadados normalizados; não interpreta HTML nem carrega recursos remotos.
    var emailSubject: String? { contentJSON["email"]?["subject"]?.stringValue ?? contentJSON["subject"]?.stringValue }
    var channelSubject: String? { emailSubject }
    var commentContext: ChannelCommentMetadata? {
        guard let value = contentJSON["comment"], let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(ChannelCommentMetadata.self, from: data)
    }
    var channelComment: ChannelCommentMetadata? { commentContext }
    private var commentActionType: String? {
        contentJSON["channel_action"]?["type"]?.stringValue ?? contentJSON["channel_action"]?.stringValue
    }
    var isPrivateComment: Bool { commentActionType == "comment.private" }
    var isPublicComment: Bool {
        !isPrivateComment && (commentContext != nil || contentJSON["context"]?.stringValue == "comment")
    }
}

struct TranscriptAvailability: Codable, Equatable {
    var available: Bool
    var reason: String?
}

struct TranscriptLimits: Codable, Equatable {
    var maxMessages: Int
    var maxTextChars: Int
    var maxHtmlChars: Int
    var actorPer24Hours: Int
    var profilePer24Hours: Int
    var previewTtlMs: Int64
}

struct TranscriptOptions: Codable, Equatable {
    var available: Bool
    var reason: String?
    var destinations: [String]
    var ranges: [String]
    var limits: TranscriptLimits
}

struct TranscriptDestination: Codable, Equatable {
    var kind: String
    var address: String? = nil
}

struct TranscriptRange: Codable, Equatable {
    var kind: String
    var from: Int64? = nil
    var to: Int64? = nil
}

struct TranscriptPreviewRequest: Codable, Equatable {
    var destination: TranscriptDestination
    var range: TranscriptRange
}

struct TranscriptSendRequest: Codable, Equatable {
    var previewToken: String
    var confirmedRecipient: String? = nil
    var customerRequested: Bool? = nil
}

struct TranscriptPreview: Codable, Equatable {
    struct Period: Codable, Equatable { var from: Int64; var to: Int64 }
    struct Size: Codable, Equatable { var textChars: Int; var htmlChars: Int }
    var recipient: String
    var period: Period
    var messageCount: Int
    var size: Size
    var warnings: [String]
    var requiresConfirmation: Bool
    var requiresCustomerRequest: Bool
    var previewToken: String
    var expiresAt: Int64
}

struct TranscriptSendResult: Codable, Equatable {
    var id: String
    var status: String
    var to_masked: String
    var duplicate: Bool
    /// Mesmo resultado indeterminado é um recibo: a interface não agenda outro envio.
    var mustNotRetry: Bool { status != "failed" }
    var statusLabel: String {
        switch status {
        case "reserved": return "Envio reservado"
        case "sending": return "Envio em andamento"
        case "queued": return "Envio na fila"
        case "sent": return "Conversa enviada"
        case "failed": return "Não foi possível enviar"
        default: return "Resultado indeterminado · confira antes de solicitar outro envio"
        }
    }
}

/// Preserva corpo e chave quando a conexão cai; editar a solicitação cria outra tentativa.
struct TranscriptAttempt: Equatable {
    let body: TranscriptSendRequest
    let key: String
    init(body: TranscriptSendRequest, key: String = UUID().uuidString) {
        self.body = body; self.key = key
    }
    static func reusing(_ previous: TranscriptAttempt?, body: TranscriptSendRequest) -> TranscriptAttempt {
        if let previous, previous.body == body { return previous }
        return TranscriptAttempt(body: body)
    }
}

extension Conversation {
    var isComment: Bool {
        chat_type == "comment" || JSONValue.parse(channel_context)["context"]?.stringValue == "comment"
    }
    /// Uma origem interna/aplicação jamais usa o fallback telefônico.
    func resolvedChannel(connectionKind: String?) -> ChannelID? {
        if connectionKind == "ai" || chat_type == "internal" || external_namespace.hasPrefix("app:") || external_namespace.hasPrefix("internal") { return nil }
        if let channel { return channel }
        guard let connection_id, !connection_id.isEmpty,
              external_namespace == "channel:\(connection_id)",
              ["meta", "zernio", "qr"].contains(connectionKind ?? "") else { return nil }
        return .whatsapp
    }
}

extension ConversationDetail {
    var isComment: Bool {
        conversation.isComment
    }
    var usesSecondWave: Bool {
        if isComment { return true }
        guard let channel = resolvedChannel else { return false }
        return [.telegram, .email, .tiktok].contains(channel)
    }
    var expectedExtensionKey: String? {
        guard let channel = resolvedChannel else { return nil }
        if isComment && channel.isSocial { return "\(channel.rawValue)/comment" }
        if [.telegram, .email, .tiktok].contains(channel) { return "\(channel.rawValue)/direct" }
        return nil
    }
    var hasMatchingExtension: Bool {
        guard let expectedExtensionKey else { return false }
        return channel_extension?.key == expectedExtensionKey && channel_extension?.capabilities?.enabled != false
    }
    var commentContext: ChannelCommentMetadata? { isComment ? channel_extension?.metadata?.comment : nil }
    var emailContext: ChannelEmailMetadata? { resolvedChannel == .email ? channel_extension?.metadata?.email : nil }
    var telegramContext: ChannelTelegramMetadata? { resolvedChannel == .telegram ? channel_extension?.metadata?.telegram : nil }
    var tiktokContext: ChannelTikTokMetadata? {
        guard resolvedChannel == .tiktok else { return nil }
        if let value = channel_extension?.metadata?.tiktok { return value }
        guard let metadata = channel_extension?.metadata else { return nil }
        return ChannelTikTokMetadata(remainingMessages: metadata.remainingMessages, closesAt: metadata.closesAt, conservativeQuota: nil)
    }
    var emailSubject: String? { emailContext?.subject ?? (resolvedChannel == .email ? channel_extension?.metadata?.subject : nil) }
    var replySubject: String { ChannelEmailMetadata.replySubject(emailSubject ?? "") }
    var channelTextLimit: Int? { channel_extension?.capabilities?.text?.maxChars }
    func commentTarget(_ id: String?) -> ChannelCommentMetadata? {
        guard let id, !id.isEmpty else { return nil }
        if commentContext?.id == id { return commentContext }
        return messages.compactMap(\.commentContext).first { $0.id == id }
    }
    private var extensionTextAllowed: Bool {
        guard hasMatchingExtension, channel_extension?.capabilities?.text?.enabled != false else { return false }
        return capabilities?["text"]?.boolValue ?? (channel_extension?.capabilities?.text?.enabled == true)
    }
    private var emailSubjectAllowed: Bool {
        resolvedChannel == .email && (subject ?? capabilities?["subject"]?.boolValue ?? channel_extension?.capabilities?.subject) == true
    }
    var resolvedChannel: ChannelID? { resolvedChannel(fallbackKind: nil) }
    func resolvedChannel(fallbackKind: String?) -> ChannelID? {
        let kind = connection_kind ?? fallbackKind
        if kind == "ai" || conversation.chat_type == "internal" || conversation.external_namespace.hasPrefix("app:") || conversation.external_namespace.hasPrefix("internal") { return nil }
        if let channel { return channel }
        if let channel = conversation.channel { return channel }
        if let raw = capabilities?["channel"]?.stringValue { return ChannelID(rawValue: raw) }
        return conversation.resolvedChannel(connectionKind: kind)
    }
    var isMultichannel: Bool { multichannel ?? capabilities?["multichannel"]?.boolValue ?? conversation.multichannel ?? false }
    var channelAccountLabel: String { account_label ?? capabilities?["account_label"]?.stringValue ?? conversation.account_label ?? "" }
    var channelMenuAvailable: Bool {
        let resolved: ChannelMenu?
        if let menu { resolved = menu }
        else if let raw = capabilities?["menu"], let data = try? JSONEncoder().encode(raw) {
            resolved = try? JSONDecoder().decode(ChannelMenu.self, from: data)
        } else { resolved = nil }
        guard let resolved else { return false }
        return resolved.buttons > 0 || resolved.quickReplies > 0 || resolved.listItems > 0 || resolved.fallback == "numbered_text"
    }
    var channelWindow: ChannelWindowState? {
        if let window { return window }
        if let raw = capabilities?["window"], let data = try? JSONEncoder().encode(raw),
           let parsed = try? JSONDecoder().decode(ChannelWindowState.self, from: data) { return parsed }
        return conversation.window
    }
    var allowsModules: Bool { modulesAllowed(fallbackKind: nil) }
    func modulesAllowed(fallbackKind: String?) -> Bool {
        guard resolvedChannel(fallbackKind: fallbackKind) == .whatsapp else { return false }
        return modules ?? capabilities?["modules"]?.boolValue ?? true
    }
    func canHumanReply(now: Int64, fallbackKind: String? = nil) -> Bool {
        guard let channel = resolvedChannel(fallbackKind: fallbackKind), channel.supportsConversation else { return false }
        // WhatsApp conserva a composição/enfileiramento anterior; o servidor decide a entrega.
        if channel == .whatsapp { return capabilities?["text"]?.boolValue ?? true }
        // Comentário nunca transforma o envio genérico em publicação pública.
        if isComment { return false }
        guard conversation.chat_type == nil || conversation.chat_type == "direct" else { return false }
        if usesSecondWave {
            guard extensionTextAllowed, channel_extension?.capabilities?.contexts?["direct"]?.enabled != false,
                  telegramContext?.blocked != true, let current = channelWindow?.projected(at: now),
                  current.canHumanText, current.state == "open" else { return false }
            if channel == .email && !emailSubjectAllowed { return false }
            if channel == .tiktok {
                guard current.kind == "customer", let remaining = tiktokContext?.remainingMessages ?? current.remainingMessages,
                      (1...10).contains(remaining) else { return false }
                if let end = tiktokContext?.closesAt, end <= max(now, current.serverNow) { return false }
            }
            return true
        }
        if let window = channelWindow, window.kind == "customer" {
            let current = window.projected(at: now)
            return current.canHumanText && current.state != "closed" && (capabilities?["text"]?.boolValue ?? (channel == .whatsapp))
        }
        return false
    }
    func allowsChannelFeature(_ feature: String, now: Int64, fallbackKind: String? = nil) -> Bool {
        guard let channel = resolvedChannel(fallbackKind: fallbackKind), channel.supportsConversation else { return false }
        if feature == "modules" { return modulesAllowed(fallbackKind: fallbackKind) }
        if feature == "text" { return canHumanReply(now: now, fallbackKind: fallbackKind) }
        if usesSecondWave {
            guard !isComment, canHumanReply(now: now, fallbackKind: fallbackKind) else { return false }
            if feature == "menu" { return channelAutomationAllowed(now: now) && channelMenuAvailable }
            if feature == "templates" { return false }
            if feature == "subject" { return emailSubjectAllowed }
            // A união ChannelAction não possui reply_to: não oferecer um alvo que seria descartado.
            if feature == "reply" { return false }
            if let media = channel_extension?.capabilities?.media?[feature], media.send == false { return false }
            return capabilities?[feature]?.boolValue == true
        }
        if channel.isSocial {
            guard conversation.chat_type == nil || conversation.chat_type == "direct",
                  let current = channelWindow?.projected(at: now), current.kind == "customer",
                  current.state == "open", current.canAutomation else { return false }
            // replyTo social ainda não é suportado pelo contrato de transporte.
            if feature == "reply" { return false }
            if feature == "templates" { return false }
            if feature == "menu" { return channelMenuAvailable }
            return capabilities?[feature]?.boolValue == true
        }
        return capabilities?[feature]?.boolValue ?? true
    }

    func canChannelAction(_ type: String, commentId: String? = nil, now: Int64) -> Bool {
        guard let channel = resolvedChannel, channel.supportsConversation, hasMatchingExtension else { return false }
        if isComment {
            guard channel.isSocial, extensionTextAllowed,
                  channel_extension?.capabilities?.contexts?["comment"]?.enabled != false,
                  let target = commentTarget(commentId) else { return false }
            if type == "comment.private" {
                return target.privateReplyAvailable(at: max(now, server_now ?? 0))
            }
            guard ["comment.reply", "comment.visibility", "comment.suggest"].contains(type) else { return false }
            return public_reply ?? capabilities?["public_reply"]?.boolValue ??
                (channel_extension?.capabilities?.contexts?["comment"]?.publicReply == true)
        }
        if type == "email.send" { return channel == .email && canHumanReply(now: now) && allowsChannelFeature("subject", now: now) }
        if type == "telegram.request-contact" { return channel == .telegram && canHumanReply(now: now) }
        return type == "message.send" && [.telegram, .tiktok].contains(channel) && canHumanReply(now: now)
    }

    func channelAutomationAllowed(now: Int64) -> Bool {
        guard !isComment, let channel = resolvedChannel, channel.supportsConversation else { return false }
        if channel == .whatsapp { return true }
        guard let current = channelWindow?.projected(at: now), current.canAutomation, current.state == "open" else { return false }
        if usesSecondWave {
            return canHumanReply(now: now) && channel_extension?.capabilities?.contexts?["direct"]?.bot == true
        }
        return channel.isSocial
    }
}

extension ProfileStatus {
    /// O servidor já aplica autorização; não inferir filtro a partir de contas futuras declaradas.
    var channelFilterOptions: [ChannelID] {
        var seen = Set<ChannelID>()
        return (conversation_channels ?? []).filter {
            let active = $0.enabled || ($0.supportsConversation && (channel_extensions ?? []).contains("\($0.rawValue)/direct"))
            return active && seen.insert($0).inserted
        }
    }
    var showsChannelFilter: Bool { channelFilterOptions.count > 1 }
}
