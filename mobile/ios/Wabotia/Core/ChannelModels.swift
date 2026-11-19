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
        guard let channel = resolvedChannel(fallbackKind: fallbackKind), channel.enabled else { return false }
        // WhatsApp conserva a composição/enfileiramento anterior; o servidor decide a entrega.
        if channel == .whatsapp { return capabilities?["text"]?.boolValue ?? true }
        guard conversation.chat_type == nil || conversation.chat_type == "direct" else { return false }
        if let window = channelWindow, window.kind == "customer" {
            let current = window.projected(at: now)
            return current.canHumanText && current.state != "closed" && (capabilities?["text"]?.boolValue ?? (channel == .whatsapp))
        }
        return false
    }
    func allowsChannelFeature(_ feature: String, now: Int64, fallbackKind: String? = nil) -> Bool {
        guard let channel = resolvedChannel(fallbackKind: fallbackKind), channel.enabled else { return false }
        if feature == "modules" { return modulesAllowed(fallbackKind: fallbackKind) }
        if feature == "text" { return canHumanReply(now: now, fallbackKind: fallbackKind) }
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
}

extension ProfileStatus {
    /// O servidor já aplica autorização; não inferir filtro a partir de contas futuras declaradas.
    var channelFilterOptions: [ChannelID] {
        var seen = Set<ChannelID>()
        return (conversation_channels ?? []).filter { $0.enabled && seen.insert($0).inserted }
    }
    var showsChannelFilter: Bool { channelFilterOptions.count > 1 }
}
