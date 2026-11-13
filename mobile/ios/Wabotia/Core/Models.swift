import Foundation

// Modelos da API Wabotia (docs/API.md e docs/MOBILE.md). Datas são Unix em milissegundos.
// Campos do banco que chegam como JSON em string (attachments, content, tags, profiles) são lidos com os auxiliares abaixo.

extension JSONDecoder {
    static let wabotia: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()
}

extension JSONEncoder {
    static let wabotia: JSONEncoder = {
        let e = JSONEncoder()
        return e
    }()
}

/// Valor JSON genérico para payloads livres (eventos, capabilities, content).
enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "JSON inválido") }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    subscript(key: String) -> JSONValue? { if case .object(let o) = self { return o[key] } else { return nil } }
    var stringValue: String? { if case .string(let s) = self { return s } else if case .number(let n) = self { return String(n) } else { return nil } }
    var doubleValue: Double? { if case .number(let n) = self { return n } else if case .string(let s) = self { return Double(s) } else { return nil } }
    var intValue: Int64? { doubleValue.map { Int64($0) } }
    var boolValue: Bool? { if case .bool(let b) = self { return b } else if case .number(let n) = self { return n != 0 } else { return nil } }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }

    /// Interpreta uma string que contém JSON (ex.: coluna `content`).
    static func parse(_ text: String?) -> JSONValue {
        guard let text, let data = text.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: data) else { return .object([:]) }
        return v
    }
    static func parseStringList(_ text: String?) -> [String] {
        parse(text).arrayValue?.compactMap { $0.stringValue } ?? []
    }
}

struct HealthInfo: Codable { var service: String = ""; var version: String = ""; var commit: String? }
struct AuthStatus: Codable { var initialized: Bool = false; var configured: Bool = false }
struct DeviceInfo: Codable { var platform = "ios"; var name: String; var app_version: String }
struct MobileLoginRequest: Codable { var email: String; var password: String; var device: DeviceInfo }
struct MobileSession: Codable { var token: String; var expires: Int64; var user: User }
struct User: Codable, Equatable {
    var id: String
    var name: String = ""
    var email: String = ""
    var role: String = "operator"
    var profiles: [String] = []
    var isAdmin: Bool { role == "admin" }
}
struct Me: Codable { var id: String; var kind: String = "user"; var name: String = ""; var role: String = "operator"; var profiles: [String] = [] }
struct Profile: Codable, Identifiable { var id: String; var name: String; var enabled: Int? = 0 }
struct Page<T: Codable>: Codable { var data: [T] = []; var next_cursor: String? }
struct APIErrorBody: Codable { var error: APIErrorInfo? }
struct APIErrorInfo: Codable { var code: String = ""; var message: String = ""; var request_id: String? }
struct OK: Codable { var ok: Bool? }

struct Conversation: Codable, Identifiable, Equatable {
    var id: String
    var profile_id: String = ""
    var connection_id: String?
    var external_namespace: String = ""
    var external_id: String = ""
    var phone: String?
    var state: String = "ai" // ai | waiting | human | closed
    var owner: String?
    var epoch: Int64 = 0
    var topic: String?
    var tags: String? = "[]"
    var last_customer: Int64 = 0
    var created: Int64 = 0
    var updated: Int64 = 0
    var chat_type: String? = "direct"
    var title: String? = ""
    var bot_policy: String? = "mentions"
    var recipient_id: String?
    var contact_name: String?
    var contact_id: String?
    var department_id: String?
    var assigned_bot_id: String?
    /// Servidor 0.14+: prévia da última mensagem (`{text, direction, created, delivery_status, attachments, kind}`)
    /// ou nulo. Fica como JSON cru para um formato inesperado nunca derrubar a lista; leia com `lastMessage`.
    var last_message: JSONValue?

    /// `last_message` lido com tolerância; nil em servidores antigos ou quando a conversa não tem mensagens.
    var lastMessage: LastMessage? { LastMessage(last_message) }

    var displayName: String {
        if let n = contact_name, !n.isEmpty { return n }
        if let t = title, !t.isEmpty { return t }
        return phone ?? external_id
    }
    var isGroup: Bool { chat_type == "group" }
    func isOwned(by userId: String?) -> Bool { owner != nil && owner == userId && state == "human" }
}

/// Prévia da última mensagem que vem em cada linha de GET /conversations (docs/CENTRAL-ATENDIMENTO.md §6).
struct LastMessage: Equatable {
    var text: String
    /// customer | outbound | operator | note | system
    var direction: String
    var created: Int64
    var deliveryStatus: String
    /// Quantidade de anexos.
    var attachments: Int
    /// text | image | video | audio | document | location | contacts | sticker | interactive
    var kind: String

    init?(_ value: JSONValue?) {
        guard let value, case .object = value else { return nil }
        text = value["text"]?.stringValue ?? ""
        direction = value["direction"]?.stringValue ?? ""
        created = value["created"]?.intValue ?? 0
        deliveryStatus = value["delivery_status"]?.stringValue ?? ""
        if let list = value["attachments"]?.arrayValue { attachments = list.count } else { attachments = max(0, Int(value["attachments"]?.intValue ?? 0)) }
        let k = value["kind"]?.stringValue ?? ""
        kind = k.isEmpty ? "text" : k
    }
}

struct Message: Codable, Identifiable, Equatable {
    var id: String
    var profile_id: String = ""
    var conversation_id: String = ""
    var direction: String = "" // customer | outbound | operator | note | system
    var author: String = ""
    var text: String = ""
    var attachments: String? = "[]"
    var external_id: String?
    var created: Int64 = 0
    var content: String? = "{}"
    var delivery_status: String? = ""
    var status_at: Int64? = 0

    var attachmentIds: [String] { JSONValue.parseStringList(attachments) }
    var contentJSON: JSONValue { JSONValue.parse(content) }
    var isIncoming: Bool { direction == "customer" }
    var isNote: Bool { direction == "note" }
}

struct MediaFile: Codable, Identifiable, Equatable { var id: String; var name: String = ""; var type: String = "application/octet-stream"; var size: Int64 = 0 }
struct Delivery: Codable, Identifiable, Equatable { var id: String; var status: String = ""; var error: String?; var created: Int64 = 0 }
struct ConversationDetail: Codable {
    var conversation: Conversation
    var media: [MediaFile] = []
    var capabilities: [String: JSONValue]? = [:]
    var group: JSONValue?
    var contact: JSONValue?
    var messages: [Message] = []
    var deliveries: [Delivery] = []
    /// Tipo da linha desta conversa (`meta`, `zernio`, …) e relógio do servidor, quando o servidor informa.
    var connection_kind: String?
    var server_now: Int64?
    func can(_ feature: String) -> Bool { capabilities?[feature]?.boolValue ?? false }
    /// Recurso de mídia básico: só some quando a linha diz explicitamente que não oferece.
    func allows(_ feature: String) -> Bool { capabilities?[feature]?.boolValue ?? true }
}

/// POST /conversations/{id}/actions
struct ActionRequest: Codable, Equatable {
    var action: String // claim | reply | note | transfer | resolve | resume | tags | menu | protocols | survey
    var text: String?
    /// `transfer`: id da pessoa ou `bot:<id>`.
    var target: String?
    var attachments: [String]?
    var content: JSONValue?
    var tags: [String]?
    var menu_id: String? = nil
    /// `transfer` para um setor (sem `target`): a conversa volta para a fila do setor.
    var department_id: String? = nil
    /// `protocols`: número `WA-…` para consultar um protocolo específico (opcional).
    var number: String? = nil
}
struct MessageActionRequest: Codable { var action: String; var message_id: String; var emoji: String?; var text: String? }
struct UploadInit: Codable { var name: String; var type: String; var size: Int64 }
struct UploadCreated: Codable { var id: String; var part_size: Int64; var parts: Int }
struct UploadDone: Codable { var id: String; var name: String?; var size: Int64?; var status: String? }
struct GroupPolicyRequest: Codable { var bot_policy: String }

struct Ticket: Codable, Identifiable, Equatable {
    var id: String
    var number: String = ""
    var profile_id: String = ""
    var conversation_id: String = ""
    var title: String = ""
    /// open | in_progress | waiting_customer | waiting_third | resolved | closed (ver `TicketStatus`).
    var status: String = "open"
    var owner: String?
    var response_due_at: Int64?
    var first_response_at: Int64?
    var created: Int64 = 0
    var updated: Int64 = 0
    /// Servidor 0.14+: `id` de uma categoria de `settings.ticket_categories` (aplicativo ou assunto).
    var category: String?

    /// Ativo = não é `resolved` nem `closed`. Um estado futuro desconhecido conta como ativo.
    var isActive: Bool { TicketStatus.isActive(status) }
    var isOverdue: Bool { isOverdue(at: Date()) }
    /// Atrasado: só protocolo ativo, sem primeira resposta e com o prazo vencido.
    func isOverdue(at now: Date) -> Bool {
        guard isActive, first_response_at == nil, let due = response_due_at else { return false }
        return Double(due) / 1000 < now.timeIntervalSince1970
    }
}

/// Os seis estados do protocolo (docs/CENTRAL-ATENDIMENTO.md §2), com o texto usado pela equipe.
enum TicketStatus {
    static let open = "open"
    static let inProgress = "in_progress"
    static let waitingCustomer = "waiting_customer"
    static let waitingThird = "waiting_third"
    static let resolved = "resolved"
    static let closed = "closed"

    /// Ordem do seletor do detalhe.
    static let all = [open, inProgress, waitingCustomer, waitingThird, resolved, closed]
    static let waiting = [waitingCustomer, waitingThird]
    static let finished = [resolved, closed]

    static func isKnown(_ status: String) -> Bool { all.contains(status) }
    static func isActive(_ status: String) -> Bool { status != resolved && status != closed }

    /// Estado desconhecido (servidor mais novo) vira texto neutro, legível, sem derrubar a tela.
    static func label(_ status: String) -> String {
        switch status {
        case open: return "Recebido"
        case inProgress: return "Em análise"
        case waitingCustomer: return "Aguardando cliente"
        case waitingThird: return "Aguardando terceiro"
        case resolved: return "Resolvido"
        case closed: return "Encerrado"
        default:
            let text = status.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
            return text.isEmpty ? "Sem estado" : text.prefix(1).uppercased() + text.dropFirst()
        }
    }
}

/// Categoria de protocolo (`settings.ticket_categories` de GET /status): aplicativo ou assunto.
struct TicketCategory: Identifiable, Equatable {
    var id: String
    var name: String
    var enabled: Bool
}

extension Array where Element == TicketCategory {
    /// Nome da categoria gravada no protocolo; categoria removida da configuração mostra o `id` gravado.
    func name(of categoryId: String?) -> String? {
        guard let id = categoryId, !id.isEmpty else { return nil }
        return first { $0.id == id }?.name ?? id
    }
}

struct TicketUpdate: Codable, Identifiable, Equatable { var id: String; var ticket_id: String = ""; var actor: String = ""; var text: String = ""; var `internal`: Int? = 0; var created: Int64 = 0 }
struct TicketDetail: Codable { var ticket: Ticket; var updates: [TicketUpdate] = []; var conversation: JSONValue? }
/// `category` nulo não é enviado (servidores 0.13 não conhecem o campo).
struct TicketCreate: Codable { var conversation_id: String; var title: String; var category: String? = nil }

struct Bot: Codable, Identifiable, Equatable { var id: String; var profile_id: String = ""; var connection_id: String = ""; var remote_profile: String = ""; var name: String = ""; var enabled: Int? = 0; var line_ids: String? }
struct BotRunRequest: Codable { var profile_id: String; var bot_id: String; var input: String }
struct BotRun: Codable, Identifiable, Equatable {
    var id: String
    var profile_id: String? = ""
    var bot_id: String? = ""
    var actor: String? = ""
    var conversation_id: String?
    var status: String = "queued" // queued | starting | running | cancelling | cancelled | completed | failed | unknown
    var input: String? = ""
    var result: String?
    var error: String?
    var attachments: [String]? = []
    var created: Int64? = 0
    var updated: Int64? = 0
    var isFinal: Bool { ["completed", "failed", "cancelled", "unknown"].contains(status) }
}

struct PresenceEntry: Codable, Identifiable, Equatable { var actor: String; var name: String = ""; var present: Int? = 0; var telegram_id: String?; var id: String { actor } }
struct PresenceRequest: Codable { var present: Bool }
struct PresenceResult: Codable { var actor: String? ; var present: Bool? }

struct Event: Codable, Identifiable, Equatable { var id: Int64; var profile_id: String? = ""; var kind: String = ""; var resource_id: String?; var payload: JSONValue?; var created: Int64? = 0 }
struct Events: Codable { var data: [Event] = []; var cursor: Int64 = 0 }

/// Registro do histórico de ligações (GET /calls). O app só lista; não inicia nem atende ligações.
struct Call: Codable, Identifiable, Equatable {
    var id: String
    var conversation_id: String = ""
    var direction: String = "" // inbound | outbound
    var actor: String?
    var status: String = "" // dialing | connecting | ringing | preaccepted | active | completed | rejected | missed | failed | unknown
    var error: String?
    var started: Int64?
    var ended: Int64?
    var duration: Int64?
    var created: Int64 = 0
    var updated: Int64? = 0
}

struct DeviceRegistration: Codable {
    var platform = "ios"
    var provider = "fcm"
    var token: String
    var name: String
    var app_version: String
    var profiles: [String] = []
    var enabled = true
}
/// GET/PUT /api/v1/devices devolvem `profiles` já como lista (deviceView no servidor).
struct Device: Codable, Identifiable { var id: String; var user_id: String? = ""; var platform: String? = ""; var provider: String? = "fcm"; var name: String? = ""; var app_version: String? = ""; var profiles: [String]? = []; var enabled: Int? = 1; var last_error: String?; var created: Int64? = 0; var updated: Int64? = 0 }

struct CountRow: Codable { var state: String?; var status: String?; var count: Int64 = 0 }
struct ConnectionSummary: Codable, Identifiable { var id: String; var name: String = ""; var kind: String = ""; var status: String = ""; var last_seen: Int64? }
struct ProfileStatus: Codable { var settings: JSONValue?; var enabled: Int?; var conversations: [CountRow] = []; var deliveries: [CountRow] = []; var connections: [ConnectionSummary] = [] }

/// Setor de atendimento (`settings.departments` de GET /status).
struct Department: Identifiable, Equatable {
    var id: String
    var name: String
    var enabled: Bool
    var members: [String]
}

extension ProfileStatus {
    /// Setores configurados no painel (inclusive os desabilitados; filtre por `enabled`).
    var departments: [Department] {
        (settings?["departments"]?.arrayValue ?? []).compactMap { item in
            guard let id = item["id"]?.stringValue, !id.isEmpty else { return nil }
            return Department(
                id: id,
                name: item["name"]?.stringValue ?? "Setor",
                enabled: item["enabled"]?.boolValue ?? true,
                members: item["members"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            )
        }
    }

    /// Categorias de protocolo (`settings.ticket_categories`, servidor 0.14+); vazio quando não configuradas.
    var ticketCategories: [TicketCategory] {
        (settings?["ticket_categories"]?.arrayValue ?? []).compactMap { item in
            guard let id = item["id"]?.stringValue, !id.isEmpty else { return nil }
            let name = item["name"]?.stringValue ?? ""
            return TicketCategory(id: id, name: name.isEmpty ? id : name, enabled: item["enabled"]?.boolValue ?? true)
        }
    }

    /// Quantidade de conversas em um estado (`ai`, `waiting`, `human`, `closed`).
    func conversationCount(_ state: String) -> Int {
        Int(conversations.first { $0.state == state }?.count ?? 0)
    }

    func connectionKind(_ id: String?) -> String? {
        guard let id else { return nil }
        return connections.first { $0.id == id }?.kind
    }
}

/// Destino pedido por notificação/deep link (wabotia://open/{type}?profile=&conversation=&ticket=&call=).
struct DeepLink: Equatable {
    var type: String
    var profileId: String?
    var conversationId: String?
    var ticketId: String?
    var callId: String?

    init(type: String, profileId: String?, conversationId: String?, ticketId: String?, callId: String?) {
        self.type = type; self.profileId = profileId; self.conversationId = conversationId; self.ticketId = ticketId; self.callId = callId
    }
    init?(url: URL) {
        guard url.scheme == "wabotia", url.host == "open" else { return nil }
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func v(_ k: String) -> String? { q.first { $0.name == k }?.value }
        self.init(type: url.pathComponents.dropFirst().first ?? "message", profileId: v("profile"), conversationId: v("conversation"), ticketId: v("ticket"), callId: v("call"))
    }
    init?(userInfo: [AnyHashable: Any]) {
        guard let type = userInfo["type"] as? String else { return nil }
        self.init(type: type, profileId: userInfo["profile_id"] as? String, conversationId: userInfo["conversation_id"] as? String, ticketId: userInfo["ticket_id"] as? String, callId: userInfo["call_id"] as? String)
    }
}
