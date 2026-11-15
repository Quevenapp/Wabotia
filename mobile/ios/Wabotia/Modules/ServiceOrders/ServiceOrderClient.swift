import Foundation

/*
 Ordem de Serviço (módulo `os`, docs/ORDEM-DE-SERVICO.md e docs/API.md "Ordem de serviço"). Valores em centavos,
 datas em ms. `next_statuses` diz os botões; `notes` é interno (não vai ao cliente nem ao comprovante).
 */

struct ServiceOrderCustomer: Codable, Equatable {
    var name: String?
    var phone: String?
    var contactId: String?
    var conversationId: String?
}

struct ServiceOrderTerms: Codable, Equatable {
    var text: String?
    var acceptedAt: Int64?
}

struct QuoteItem: Codable, Equatable, Identifiable {
    var description: String
    var quantity: Int
    var unitCents: Int
    var id: String { "\(description)#\(quantity)#\(unitCents)" }
    var totalCents: Int { quantity * unitCents }

    var json: [String: Any] { ["description": description, "quantity": quantity, "unit_cents": unitCents] }
}

struct ServiceOrderQuote: Codable, Equatable {
    var items: [QuoteItem]?
    var totalCents: Int?
    var note: String?
    var validDays: Int?
    var validUntil: Int64?
    var sentAt: Int64?
    var version: Int?
    var expired: Bool?

    var total: Int { totalCents ?? (items ?? []).reduce(0) { $0 + $1.totalCents } }
}

struct ServiceOrderDecision: Codable, Equatable {
    var decision: String?
    var at: Int64?
    var by: String?
    var via: String?
}

struct ServiceOrderHistory: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var fromStatus: String?
    var toStatus: String?
    var actor: String?
    var note: String?
    var created: Int64?
}

struct ServiceOrder: Codable, Equatable, Identifiable {
    var id: String
    var number: Int?
    var status: String?
    var statusLabel: String?
    var customer: ServiceOrderCustomer?
    var item: String?
    var problem: String?
    var notes: String?
    var assignee: String?
    var dueAt: Int64?
    var source: String?
    var terms: ServiceOrderTerms?
    var quote: ServiceOrderQuote?
    var decision: ServiceOrderDecision?
    var readyAt: Int64?
    var deliveredAt: Int64?
    var warrantyUntil: Int64?
    var nextStatuses: [String]?
    var createdBy: String?
    var created: Int64?
    var updated: Int64?
    var history: [ServiceOrderHistory]?

    var state: String { status ?? "received" }
    var label: String { statusLabel?.isEmpty == false ? statusLabel! : ServiceOrderRules.statusLabel(state) }
    var numberText: String { number.map { "nº \($0)" } ?? "—" }
    var customerName: String {
        if let name = customer?.name, !name.isEmpty { return name }
        if let phone = customer?.phone, !phone.isEmpty { return phone }
        return "Cliente"
    }
}

struct ServiceOrderPage: Decodable, Equatable {
    var data: [ServiceOrder]?
    var nextCursor: String?
    /// Quantas ordens há em cada estado (a área inteira).
    var counts: [String: Int]?

    /// Chave ausente vale 0. O cliente relê o mapa com as chaves exatas; a forma camelCase fica como reserva.
    func count(_ status: String) -> Int {
        counts?[status] ?? counts?[ServiceOrderRules.camel(status)] ?? 0
    }
}

/// O cliente das rotas da Ordem de Serviço de uma área.
final class ServiceOrderClient {
    let api: ProfileAPI

    init(api: ProfileAPI) { self.api = api }

    /// Lista por número decrescente. `open`: sem entregues e canceladas.
    func list(statuses: [String] = [], open: Bool = false, query: String? = nil, conversationId: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> ServiceOrderPage {
        let data = try await api.getData("service-orders", query: [
            "status": statuses.isEmpty ? nil : statuses.joined(separator: ","), "open": open && statuses.isEmpty ? "1" : nil,
            "q": query?.trimmingCharacters(in: .whitespaces).isEmpty == false ? query : nil, "conversation_id": conversationId,
            "cursor": cursor, "limit": String(limit),
        ])
        var page = try QueueHTTP.decode(ServiceOrderPage.self, data)
        // `counts` tem os códigos de estado como chaves (docs/ORDEM-DE-SERVICO.md): lidas sem a conversão de snake_case.
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let raw = object["counts"] as? [String: Any] {
            page.counts = raw.compactMapValues { ($0 as? NSNumber)?.intValue }
        }
        return page
    }

    /// Troca o responsável (`assignee`, o `id` de `GET /people`; `nil` tira).
    func assign(_ id: String, assignee: String?, key: String) async throws -> ServiceOrder {
        try await api.send("PATCH", "service-orders/\(id)", ["assignee": assignee ?? NSNull()], key: key)
    }

    func order(_ id: String) async throws -> ServiceOrder { try await api.get("service-orders/\(id)") }

    /// Abre a ordem: ligada à conversa (o cliente é avisado) ou pelo telefone, no balcão.
    func create(item: String, problem: String, conversationId: String?, phone: String?, customerName: String?, notes: String?, dueAt: Int64?, assignee: String? = nil, key: String) async throws -> ServiceOrder {
        try await api.send("POST", "service-orders", [
            "item": item, "problem": problem, "conversation_id": conversationId, "phone": phone,
            "customer_name": customerName, "notes": notes, "due_at": dueAt, "assignee": assignee,
        ], key: key)
    }

    func setStatus(_ id: String, status: String, note: String?, key: String) async throws -> ServiceOrder {
        try await api.send("POST", "service-orders/\(id)/status", ["status": status, "note": note], key: key)
    }

    func saveQuote(_ id: String, items: [QuoteItem], validDays: Int?, note: String?, key: String) async throws -> ServiceOrder {
        try await api.send("PUT", "service-orders/\(id)/quote", ["items": items.map(\.json), "valid_days": validDays, "note": note], key: key)
    }

    /// `notify: false` só registra o envio (orçamento entregue em mãos).
    func sendQuote(_ id: String, notify: Bool, key: String) async throws -> ServiceOrder {
        try await api.send("POST", "service-orders/\(id)/quote/send", ["notify": notify], key: key)
    }

    /// Resposta do cliente dada no balcão ou por telefone: `approve` ou `decline`.
    func decide(_ id: String, approve: Bool, key: String) async throws -> ServiceOrder {
        try await api.send("POST", "service-orders/\(id)/decision", ["decision": approve ? "approve" : "decline"], key: key)
    }
}

/// Regras das telas da Ordem de Serviço, sem tela, para testar.
enum ServiceOrderRules {
    static let statuses = ["received", "analyzing", "quoted", "approved", "declined", "in_progress", "ready", "delivered", "cancelled"]
    static let closed: Set<String> = ["delivered", "cancelled"]
    /// Estados de onde o orçamento pode ser montado e enviado.
    static let quotable: Set<String> = ["received", "analyzing", "quoted", "declined"]

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "received": return "Recebida"
        case "analyzing": return "Em análise"
        case "quoted": return "Orçamento enviado"
        case "approved": return "Aprovada"
        case "declined": return "Recusada"
        case "in_progress": return "Em execução"
        case "ready": return "Pronta"
        case "delivered": return "Entregue"
        case "cancelled": return "Cancelada"
        default: return status
        }
    }

    static func camel(_ snake: String) -> String {
        let parts = snake.split(separator: "_")
        guard let first = parts.first else { return snake }
        return String(first) + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
    }

    /// Um botão por próximo estado, com o rótulo do que a pessoa faz. `quoted` vira "Enviar orçamento", `approved` e
    /// `declined` viram a resposta do cliente; o cancelamento fica por último.
    static func actions(for order: ServiceOrder) -> [(status: String, title: String)] {
        let next = order.nextStatuses ?? []
        var out: [(String, String)] = []
        for status in next where status != "cancelled" {
            switch status {
            case "analyzing": out.append((status, order.state == "quoted" ? "Voltar para análise" : "Em análise"))
            case "quoted": out.append((status, "Enviar orçamento"))
            case "approved": out.append((status, "Cliente aprovou"))
            case "declined": out.append((status, "Cliente recusou"))
            case "in_progress": out.append((status, order.state == "ready" ? "Voltar para execução" : "Iniciar execução"))
            case "ready": out.append((status, order.state == "declined" ? "Devolver sem conserto" : "Marcar como pronta"))
            case "delivered": out.append((status, "Registrar entrega"))
            default: out.append((status, statusLabel(status)))
            }
        }
        if next.contains("cancelled") { out.append(("cancelled", "Cancelar ordem")) }
        return out.map { (status: $0.0, title: $0.1) }
    }

    static func canEditQuote(_ order: ServiceOrder) -> Bool { quotable.contains(order.state) }

    /// Orçamento enviado e vencido: não pode ser aprovado, só reenviado.
    static func quoteExpired(_ order: ServiceOrder, now: Date = Date()) -> Bool {
        if order.quote?.expired == true { return true }
        guard let until = order.quote?.validUntil else { return false }
        return until <= BrasiliaTime.millis(now)
    }

    /// Filtros da lista: abertas, cada estado e todas.
    static let filters: [(id: String, title: String)] =
        [(id: "open", title: "Abertas")] + statuses.map { (id: $0, title: statusLabel($0)) } + [(id: "all", title: "Todas")]

    static func historyText(_ h: ServiceOrderHistory) -> String {
        switch h.kind {
        case "opened": return "Ordem aberta"
        case "quote": return "Orçamento salvo"
        case "edit": return "Dados alterados"
        default:
            if let to = h.toStatus { return statusLabel(to) }
            return h.kind ?? "Alteração"
        }
    }
}
