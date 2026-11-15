import Foundation

/*
 A fila de senhas do Wabotia (docs/FILA-SENHAS.md, contrato v1). Os mesmos modelos servem ao modo aparelho (totem,
 painel e híbrido, com o token `wab_…` do pareamento) e ao guichê do app logado (token `wabu_…` da pessoa).
 Quase tudo é opcional: o servidor evolui e o JSON tolera campos novos ou ausentes. As chaves chegam em snake_case e
 o decodificador da fila (`QueueJSON.decoder`) as converte.
 */

enum QueueJSON {
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}

struct QueueWaiting: Codable, Equatable {
    var normal: Int?
    var preferential: Int?
    var total: Int { (normal ?? 0) + (preferential ?? 0) }
}

/// Espera estimada por tipo; `nil` quando a fila não mostra estimativa (`wait_mode: off`).
struct QueueWaitMinutes: Codable, Equatable {
    var normal: Int?
    var preferential: Int?
}

struct QueueInfo: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var prefixNormal: String?
    var prefixPreferential: String?
    var preferentialNotice: String?
    var normalsPerPreferential: Int?
    var priority: Int?
    var waitMode: String?
    var channels: [String]?
    var enabled: Bool?
    var waiting: QueueWaiting?
    var waitMinutes: QueueWaitMinutes?
    var openCounters: Int?

    var displayName: String { name?.isEmpty == false ? name! : "Fila" }
    /// O totem só oferece filas ativas com o canal `kiosk`.
    var kiosk: Bool { (enabled ?? true) && (channels ?? []).contains("kiosk") }
}

struct QueueTicket: Codable, Equatable, Identifiable {
    var id: String
    var queueId: String?
    var queueName: String?
    var code: String?
    var preferential: Bool?
    var source: String?
    /// `waiting`, `called`, `serving`, `done`, `no_show` ou `cancelled`.
    var status: String?
    var counterId: String?
    var counterName: String?
    var callCount: Int?
    var ahead: Int?
    var waitMinutes: Int?
    /// Só para a equipe.
    var phone: String?
    var conversationId: String?
    /// O cliente pode receber texto livre agora (janela de 24 h aberta).
    var windowOpen: Bool?
    var createdAt: Int64?
    var calledAt: Int64?
    var startedAt: Int64?
    var finishedAt: Int64?
    var serviceDay: String?
    var publicToken: String?
    var whatsappLink: String?

    var displayCode: String { code ?? "—" }
    var isPreferential: Bool { preferential ?? false }
    var typeLabel: String { isPreferential ? "Preferencial" : "Normal" }
    var state: String { status ?? "waiting" }
}

struct CounterInfo: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var queueIds: [String]?
    /// `open`, `paused` ou `closed`.
    var status: String?
    var enabled: Bool?
    var userId: String?
    var userName: String?
    var current: QueueTicket?

    var displayName: String { name?.isEmpty == false ? name! : "Guichê" }
    var state: String { status ?? "closed" }
}

struct CallFrame: Codable, Equatable {
    var ticketId: String
    var code: String?
    var preferential: Bool?
    var queueId: String?
    var queueName: String?
    var counterId: String?
    var counterName: String?
    var callCount: Int?
    var recall: Bool?
    var at: Int64?
    var speech: String?

    /// Uma chamada é a mesma senha na mesma vez: rechamar soma `call_count` e conta como chamada nova.
    var key: String { "\(ticketId)#\(callCount ?? 1)" }
}

struct QueueSettings: Codable, Equatable {
    var frontDoor: Bool?
    var notifyAhead: Int?
}

struct QueueOverview: Codable, Equatable {
    var day: String?
    var settings: QueueSettings?
    var queues: [QueueInfo]?
    var counters: [CounterInfo]?
    var recentCalls: [CallFrame]?
}

/// Resposta de `POST /api/pairing/start`.
struct PairingStart: Codable, Equatable {
    var deviceCode: String
    var userCode: String
    var verificationUri: String?
    var expiresIn: Int?
    var interval: Int?
    /// As permissões pedidas que o servidor aceitou (servidor com `scopes` no pareamento).
    var scopes: [String]?
}

/// Resposta de `POST /api/pairing/token`: `authorization_pending` ou `connected` com a credencial.
struct PairingToken: Codable, Equatable {
    var status: String
    var accessToken: String?
    var profileId: String?
    var expiresIn: Int64?
    var scopes: [String]?
    var interval: Int?
}

/// As permissões de fila que o modo aparelho pede: ler e emitir, sem operar (o guichê fica no app logado).
enum DeviceScopes {
    static let read = "queue:read"
    static let issue = "queue:issue"
    static let operate = "queue:operate"
    static let events = "events:read"
    static let requested = [read, issue]
}
