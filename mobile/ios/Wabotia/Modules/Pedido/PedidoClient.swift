import Foundation

/*
 Pedido (módulo `pedido`, docs/PEDIDO.md e docs/API.md "Pedido"). Valores em centavos, datas em ms. A cozinha vê o
 quadro por estado; cada pedido traz `next_statuses` (os botões) e o pagamento. O mesmo `item_id` pode aparecer em
 várias linhas com `slot` diferente (duas montagens do mesmo lanche): as linhas nunca são agrupadas por item.
 */

struct PedidoCustomer: Codable, Equatable {
    var name: String?
    var phone: String?
    var contactId: String?
    var conversationId: String?
}

struct PedidoAddress: Codable, Equatable {
    var street: String?
    var district: String?
    var complement: String?
    var reference: String?
}

struct PedidoOption: Codable, Equatable {
    var groupId: String?
    var group: String?
    var id: String?
    var name: String?
    var priceCents: Int?
}

struct PedidoLine: Codable, Equatable {
    var itemId: String?
    var slot: Int?
    var name: String?
    var quantity: Int?
    var unitCents: Int?
    var options: [PedidoOption]?
    var note: String?
    var totalCents: Int?
}

struct PedidoPayment: Codable, Equatable {
    var method: String?
    var methodLabel: String?
    var online: Bool?
    var status: String?
    var statusLabel: String?
    var paymentId: String?
    var dueAt: Int64?
    var paidAt: Int64?
    var paidBy: String?
    var error: String?
    var changeForCents: Int?
    var needsRefund: Bool?
}

struct PedidoHistory: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var fromStatus: String?
    var toStatus: String?
    var actor: String?
    var note: String?
    var created: Int64?
}

struct PedidoOrder: Codable, Equatable, Identifiable {
    var id: String
    var number: Int?
    var status: String?
    var statusLabel: String?
    var statusAt: Int64?
    var customer: PedidoCustomer?
    var source: String?
    var fulfillment: String?
    var fulfillmentLabel: String?
    var address: PedidoAddress?
    var addressText: String?
    var lines: [PedidoLine]?
    var itemCount: Int?
    var subtotalCents: Int?
    var deliveryFeeCents: Int?
    var totalCents: Int?
    /// Observação do cliente (vai na comanda).
    var note: String?
    /// Observação interna da equipe (não vai ao cliente nem à comanda).
    var notes: String?
    var etaMinutes: Int?
    var etaAt: Int64?
    var payment: PedidoPayment?
    var nextStatuses: [String]?
    var cancelReason: String?
    var cancelledBy: String?
    var created: Int64?
    var updated: Int64?
    var history: [PedidoHistory]?
    /// Só no quadro: minutos no estado atual e se passou do alerta.
    var minutesInStatus: Int?
    var late: Bool?

    var state: String { status ?? "received" }
    var label: String { statusLabel?.isEmpty == false ? statusLabel! : PedidoRules.statusLabel(state) }
    var numberText: String { number.map { "nº \($0)" } ?? "—" }
    var delivery: Bool { fulfillment == "delivery" }
    var customerName: String {
        if let name = customer?.name, !name.isEmpty { return name }
        if let phone = PhoneText.display(customer?.phone) { return phone }
        return "Cliente"
    }
}

struct PedidoStore: Codable, Equatable {
    var open: Bool?
    var reason: String?
    var paused: Bool?
    var pauseMessage: String?
    var message: String?
    var hoursText: String?
}

struct PedidoColumn: Codable, Equatable, Identifiable {
    var status: String
    var label: String?
    var orders: [PedidoOrder]?
    var id: String { status }
}

struct PedidoToday: Codable, Equatable {
    var since: Int64?
    var orders: Int?
    var delivered: Int?
    var cancelled: Int?
    var totalCents: Int?
}

struct PedidoBoard: Codable, Equatable {
    var generatedAt: Int64?
    var store: PedidoStore?
    var columns: [PedidoColumn]?
    var today: PedidoToday?
}

struct PedidoPage: Decodable, Equatable {
    var data: [PedidoOrder]?
    var nextCursor: String?
    var counts: [String: Int]?

    func count(_ status: String) -> Int { counts?[status] ?? 0 }
}

struct PedidoMenuOption: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var priceCents: Int?
    var available: Bool?
}

struct PedidoMenuGroup: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var min: Int?
    var max: Int?
    var options: [PedidoMenuOption]?
}

struct PedidoMenuItem: Codable, Equatable, Identifiable {
    var id: String
    var categoryId: String?
    var name: String?
    var description: String?
    var priceCents: Int?
    var available: Bool?
    var groupIds: [String]?
}

struct PedidoMenuCategory: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var description: String?
    var items: [PedidoMenuItem]?
}

struct PedidoMenu: Codable, Equatable {
    var categories: [PedidoMenuCategory]?
    var groups: [PedidoMenuGroup]?
}

/// A comanda pronta (`GET …/orders/{id}/ticket`): o texto em colunas fixas, já com o estabelecimento.
struct PedidoTicket: Codable, Equatable {
    var columns: Int?
    var text: String?
}

/// O cliente das rotas do Pedido de uma área.
final class PedidoClient {
    let api: ProfileAPI

    init(api: ProfileAPI) { self.api = api }

    func board() async throws -> PedidoBoard { try await api.get("pedido/board") }

    func list(statuses: [String] = [], open: Bool = false, query: String? = nil, conversationId: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> PedidoPage {
        let data = try await api.getData("pedido/orders", query: [
            "status": statuses.isEmpty ? nil : statuses.joined(separator: ","), "open": open && statuses.isEmpty ? "1" : nil,
            "q": query?.trimmingCharacters(in: .whitespaces).isEmpty == false ? query : nil, "conversation_id": conversationId,
            "cursor": cursor, "limit": String(limit),
        ])
        var page = try QueueHTTP.decode(PedidoPage.self, data)
        // `counts` tem os códigos de estado como chaves (`out_for_delivery`): lidas sem a conversão de snake_case.
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let raw = object["counts"] as? [String: Any] {
            page.counts = raw.compactMapValues { ($0 as? NSNumber)?.intValue }
        }
        return page
    }

    func order(_ id: String) async throws -> PedidoOrder { try await api.get("pedido/orders/\(id)") }

    func ticket(_ id: String, columns: Int) async throws -> PedidoTicket {
        try await api.get("pedido/orders/\(id)/ticket", query: ["columns": String(columns)])
    }

    /// `reason` vai ao cliente no cancelamento; `notify: false` muda sem avisar no WhatsApp.
    func setStatus(_ id: String, status: String, note: String?, reason: String?, notify: Bool, key: String) async throws -> PedidoOrder {
        try await api.send("POST", "pedido/orders/\(id)/status", ["status": status, "note": note, "reason": reason, "notify": notify], key: key)
    }

    /// Pagamento recebido na hora (dinheiro, maquininha) ou por fora.
    func markPaid(_ id: String, note: String?, key: String) async throws -> PedidoOrder {
        try await api.send("POST", "pedido/orders/\(id)/paid", ["note": note], key: key)
    }

    /// A equipe define a forma de pagamento (dinheiro ou maquininha) quando o cliente ainda não escolheu.
    func setMethod(_ id: String, method: String, key: String) async throws -> PedidoOrder {
        try await api.send("POST", "pedido/orders/\(id)/payment", ["method": method], key: key)
    }

    func pause(_ paused: Bool, message: String?, key: String) async throws -> PedidoStore {
        try await api.send("POST", "pedido/store/pause", ["paused": paused, "message": message], key: key)
    }

    func menu() async throws -> PedidoMenu { try await api.get("pedido/menu") }

    func setItemAvailable(_ itemId: String, available: Bool, key: String) async throws -> PedidoMenuItem {
        try await api.send("POST", "pedido/items/\(itemId)/availability", ["available": available], key: key)
    }

    func setOptionAvailable(groupId: String, optionId: String, available: Bool, key: String) async throws -> PedidoMenuGroup {
        try await api.send("POST", "pedido/groups/\(groupId)/availability", ["option_id": optionId, "available": available], key: key)
    }
}

/// Regras das telas do Pedido, sem tela, para testar.
enum PedidoRules {
    static let active = ["awaiting_payment", "received", "preparing", "ready", "out_for_delivery"]
    static let statuses = active + ["delivered", "cancelled"]
    static let closed: Set<String> = ["delivered", "cancelled"]

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "awaiting_payment": return "Aguardando pagamento"
        case "received": return "Recebido"
        case "preparing": return "Em preparo"
        case "ready": return "Pronto para retirada"
        case "out_for_delivery": return "Saiu para entrega"
        case "delivered": return "Entregue"
        case "cancelled": return "Cancelado"
        default: return status
        }
    }

    /// Título das colunas do quadro (plural, como no painel).
    static func columnLabel(_ status: String) -> String {
        switch status {
        case "awaiting_payment": return "Aguardando pagamento"
        case "received": return "Novos"
        case "preparing": return "Em preparo"
        case "ready": return "Prontos para retirada"
        case "out_for_delivery": return "Saíram para entrega"
        default: return statusLabel(status)
        }
    }

    /// Um botão por próximo estado, com o que a pessoa faz; voltar um passo fica claro; cancelar por último.
    static func actions(for order: PedidoOrder) -> [(status: String, title: String)] {
        let next = order.nextStatuses ?? []
        let rank = { (s: String) in active.firstIndex(of: s) ?? 99 }
        var out: [(String, String)] = []
        for status in next where status != "cancelled" {
            let back = rank(status) < rank(order.state)
            switch status {
            case "received": out.append((status, back ? "Voltar para novos" : "Enviar para o preparo"))
            case "preparing": out.append((status, back ? "Voltar para o preparo" : "Começar preparo"))
            case "ready": out.append((status, "Pronto para retirada"))
            case "out_for_delivery": out.append((status, "Saiu para entrega"))
            case "delivered": out.append((status, "Entregue"))
            default: out.append((status, statusLabel(status)))
            }
        }
        if next.contains("cancelled") { out.append(("cancelled", "Cancelar pedido")) }
        return out.map { (status: $0.0, title: $0.1) }
    }

    /// Registrar o pagamento recebido: não com cobrança online aberta (só o provedor confirma), nem pago, nem cancelado.
    static func canMarkPaid(_ order: PedidoOrder) -> Bool {
        let status = order.payment?.status ?? "pending"
        return status != "paid" && status != "awaiting" && order.state != "cancelled"
    }

    /// A equipe escolhe dinheiro ou maquininha enquanto o cliente não escolheu (ou a cobrança não foi gerada).
    static func canChooseMethod(_ order: PedidoOrder) -> Bool {
        order.state == "awaiting_payment" && ["choosing", "failed"].contains(order.payment?.status ?? "")
    }

    static let staffMethods: [(id: String, title: String)] = [("cash", "Dinheiro"), ("card", "Cartão na maquininha")]

    /// Filtros da lista: em andamento, cada estado e todos.
    static let filters: [(id: String, title: String)] =
        [(id: "open", title: "Em andamento")] + statuses.map { (id: $0, title: statusLabel($0)) } + [(id: "all", title: "Todos")]

    /// "+ Bacon, Ao ponto" de uma linha.
    static func optionsText(_ line: PedidoLine) -> String? {
        let names = (line.options ?? []).compactMap(\.name).filter { !$0.isEmpty }
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    /// "12 min" / "1 h 05" no estado.
    static func elapsed(_ minutes: Int?) -> String? {
        guard let minutes else { return nil }
        if minutes < 60 { return "\(minutes) min" }
        return "\(minutes / 60) h \(String(format: "%02d", minutes % 60))"
    }

    /// Situação da loja para a faixa do quadro.
    static func storeText(_ store: PedidoStore?) -> String {
        guard let store else { return "" }
        if store.paused == true { return "Loja pausada: não recebe pedidos agora" }
        if store.open == false { return "Loja fechada pelo horário" }
        return "Loja aberta, recebendo pedidos"
    }

    /// As colunas da comanda que cabem na impressora: a maior entre 32, 42 e 48 que não passa da largura.
    static func ticketColumns(for printerColumns: Int) -> Int {
        [48, 42, 32].first { $0 <= printerColumns } ?? 32
    }

    static func historyText(_ h: PedidoHistory) -> String {
        switch h.kind {
        case "created": return "Pedido criado"
        case "payment": return "Pagamento"
        case "edit": return "Dados alterados"
        default:
            if let to = h.toStatus { return statusLabel(to) }
            return h.kind ?? "Alteração"
        }
    }
}
