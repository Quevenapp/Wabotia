import Foundation

/*
 Reserva e check-in (módulo `reserva`, docs/RESERVA.md e docs/API.md "Reserva e check-in"). Unidades por diária
 (pousada, temporada) ou por hora (quadra, salão). Datas em ms Unix; `*_date` e `*_time` já vêm em Brasília. Cadastros e
 regras ficam no painel web: o app mostra a ocupação e opera as reservas.
 */

struct ReservaUnit: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    /// `daily` ou `hourly`.
    var mode: String?
    var kind: String?
    var capacity: Int?
    var priceCents: Int?
    var description: String?
    var active: Bool?
    var position: Int?

    var displayName: String { name?.isEmpty == false ? name! : "Unidade" }
    var isHourly: Bool { mode == "hourly" }
    var isActive: Bool { active ?? true }
}

struct ReservaDeposit: Codable, Equatable {
    var available: Bool?
    var reason: String?
    var message: String?
}

/// `GET /reserva`: as regras ficam com o painel; o app usa unidades e o estado do sinal.
struct ReservaOverview: Decodable, Equatable {
    var units: [ReservaUnit]?
    var deposit: ReservaDeposit?
}

struct Booking: Codable, Equatable, Identifiable {
    var id: String
    var number: Int?
    var unitId: String?
    var unitName: String?
    var mode: String?
    var startDate: String?
    var endDate: String?
    var starts: Int64?
    var ends: Int64?
    var arrivalTime: String?
    var departureTime: String?
    var nights: Int?
    var durationMinutes: Int?
    var guests: Int?
    /// `pending_payment`, `confirmed`, `cancelled`, `expired` ou `completed`.
    var status: String?
    var conversationId: String?
    var customerName: String?
    var customerPhone: String?
    var notes: String?
    var source: String?
    var priceCents: Int?
    var depositCents: Int?
    var paymentId: String?
    var paymentStatus: String?
    var paymentError: String?
    var paymentDueAt: Int64?
    var paidAt: Int64?
    var confirmedAt: Int64?
    /// `none`, `invited`, `sent` ou `completed`.
    var checkinStatus: String?
    var checkinAt: Int64?
    var checkinAnswers: [String: JSONValue]?
    var cancelledAt: Int64?
    var cancelReason: String?
    var changes: Int?
    var created: Int64?
    var updated: Int64?

    var state: String { status ?? "confirmed" }
    var isHourly: Bool { mode == "hourly" }
    var numberText: String { number.map { "nº \($0)" } ?? "—" }
    var customer: String { customerName?.isEmpty == false ? customerName! : (PhoneText.display(customerPhone) ?? "Cliente") }

    /// "22/11 a 25/11 · 3 diárias" ou "22/11 · 14:00 às 16:00".
    var periodText: String {
        if isHourly, let starts {
            let end = ends.map { " às \(BrasiliaTime.clock($0))" } ?? ""
            return "\(BrasiliaTime.short(starts)) · \(BrasiliaTime.clock(starts))\(end)"
        }
        let from = startDate.map(ReservaRules.shortDay) ?? "—", to = endDate.map(ReservaRules.shortDay) ?? "—"
        let n = nights.map { $0 == 1 ? " · 1 diária" : " · \($0) diárias" } ?? ""
        return "\(from) a \(to)\(n)"
    }
}

struct ReservaCell: Codable, Equatable {
    var date: String
    /// `free`, `pending_payment`, `confirmed`, `completed`, `partial` ou `blocked`.
    var state: String?
    var bookingIds: [String]?
    var blockIds: [String]?
}

struct ReservaCalendarUnit: Codable, Equatable, Identifiable {
    var unitId: String
    var name: String?
    var mode: String?
    var active: Bool?
    var cells: [ReservaCell]?
    var id: String { unitId }
}

struct ReservaCalendar: Decodable, Equatable {
    var fromDate: String?
    var toDate: String?
    var days: [String]?
    var units: [ReservaCalendarUnit]?
    var bookings: [Booking]?
}

struct ReservaDailyOption: Codable, Equatable, Identifiable {
    var unitId: String
    var name: String?
    var capacity: Int?
    var available: Bool?
    var reason: String?
    var message: String?
    var priceCents: Int?
    var depositCents: Int?
    var nights: Int?
    var id: String { unitId }
}

struct ReservaDailyAvailability: Decodable, Equatable {
    var startDate: String?
    var endDate: String?
    var units: [ReservaDailyOption]?
}

struct ReservaSlot: Codable, Equatable, Hashable {
    var starts: Int64
    var ends: Int64?
    var time: String?
    var priceCents: Int?
    var clock: String { time ?? BrasiliaTime.clock(starts) }
}

struct ReservaHourlyOption: Codable, Equatable, Identifiable {
    var unitId: String
    var name: String?
    var capacity: Int?
    var priceCents: Int?
    var slots: [ReservaSlot]?
    var id: String { unitId }
}

struct ReservaHourlyAvailability: Decodable, Equatable {
    var date: String?
    var durationMinutes: Int?
    var units: [ReservaHourlyOption]?
}

/// O cliente das rotas da Reserva de uma área.
final class ReservaClient {
    let api: ProfileAPI
    init(api: ProfileAPI) { self.api = api }

    func overview() async throws -> ReservaOverview { try await api.get("reserva") }

    /// Ocupação por unidade e dia (até 93 dias).
    func calendar(from: String, to: String, unitId: String? = nil) async throws -> ReservaCalendar {
        try await api.get("reserva/calendar", query: ["from_date": from, "to_date": to, "unit_id": unitId])
    }

    func bookings(statuses: [String] = [], from: String? = nil, to: String? = nil, unitId: String? = nil, query: String? = nil, conversationId: String? = nil, limit: Int = 100) async throws -> [Booking] {
        let list: DataList<Booking> = try await api.get("reserva/bookings", query: [
            "status": statuses.isEmpty ? nil : statuses.joined(separator: ","), "from_date": from, "to_date": to, "unit_id": unitId,
            "q": query?.trimmingCharacters(in: .whitespaces).isEmpty == false ? query : nil, "conversation_id": conversationId, "limit": String(limit),
        ])
        return list.data ?? []
    }

    func booking(_ id: String) async throws -> Booking { try await api.get("reserva/bookings/\(id)") }

    /// Diárias: cada unidade com `available`, o motivo quando não está e o valor do período (como a equipe: `staff=1`).
    func dailyAvailability(start: String, nights: Int, guests: Int?) async throws -> ReservaDailyAvailability {
        try await api.get("reserva/availability", query: ["start_date": start, "nights": String(nights), "guests": guests.map(String.init), "staff": "1"])
    }

    /// Por hora: horários livres de cada unidade no dia.
    func hourlyAvailability(date: String, minutes: Int, unitId: String?) async throws -> ReservaHourlyAvailability {
        try await api.get("reserva/availability", query: ["date": date, "duration_minutes": String(minutes), "unit_id": unitId, "staff": "1"])
    }

    /// `body` já no formato da rota: `{unit_id, start_date, nights}` ou `{unit_id, starts, duration_minutes}`, com
    /// `guests`, `conversation_id | customer_name`, `customer_phone`, `notes`, `deposit`.
    func create(_ body: [String: Any?], key: String) async throws -> Booking {
        try await api.send("POST", "reserva/bookings", body, key: key)
    }

    /// Unidade, datas, horário, pessoas e cliente.
    func update(_ id: String, _ body: [String: Any?], key: String) async throws -> Booking {
        try await api.send("PATCH", "reserva/bookings/\(id)", body, key: key)
    }

    func cancel(_ id: String, reason: String?, key: String) async throws -> Booking {
        try await api.send("POST", "reserva/bookings/\(id)/cancel", ["reason": reason], key: key)
    }

    /// Confirma sem sinal (pela equipe).
    func confirm(_ id: String, key: String) async throws -> Booking { try await api.send("POST", "reserva/bookings/\(id)/confirm", [:], key: key) }
    /// Cobra o sinal de novo pela conversa.
    func deposit(_ id: String, key: String) async throws -> Booking { try await api.send("POST", "reserva/bookings/\(id)/deposit", [:], key: key) }
    /// Envia o link do check-in.
    func checkin(_ id: String, key: String) async throws -> Booking { try await api.send("POST", "reserva/bookings/\(id)/checkin", [:], key: key) }
}

/// Regras das telas da Reserva, sem tela, para testar.
enum ReservaRules {
    static let active: Set<String> = ["pending_payment", "confirmed"]
    /// Recusas que pedem recarregar a disponibilidade e explicar.
    static let conflicts: Set<String> = ["unit_unavailable", "unit_blocked", "outside_rules", "booking_closed"]

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "pending_payment": return "Aguardando sinal"
        case "confirmed": return "Confirmada"
        case "cancelled": return "Cancelada"
        case "expired": return "Expirada"
        case "completed": return "Concluída"
        default: return status
        }
    }

    static func checkinLabel(_ status: String?) -> String {
        switch status {
        case "invited": return "Convite enviado"
        case "sent": return "Link enviado"
        case "completed": return "Check-in feito"
        default: return "Não enviado"
        }
    }

    static func cellLabel(_ state: String?) -> String {
        switch state {
        case "pending_payment": return "Aguardando sinal"
        case "confirmed": return "Reservada"
        case "completed": return "Concluída"
        case "partial": return "Parcial"
        case "blocked": return "Bloqueada"
        default: return "Livre"
        }
    }

    static func canConfirm(_ b: Booking) -> Bool { b.state == "pending_payment" }
    static func canChargeDeposit(_ b: Booking) -> Bool { b.state == "pending_payment" && b.conversationId != nil }
    static func canSendCheckin(_ b: Booking) -> Bool { b.state == "confirmed" && b.conversationId != nil && b.checkinStatus != "completed" }
    static func canEdit(_ b: Booking) -> Bool { active.contains(b.state) }
    static func canCancel(_ b: Booking) -> Bool { active.contains(b.state) }

    static func isConflict(_ error: Error) -> Bool { (error as? QueueError).map { conflicts.contains($0.code) } ?? false }

    /// A explicação de cada recusa; `outside_rules` traz a regra na mensagem do servidor.
    static func explain(_ error: Error) -> String {
        guard let e = error as? QueueError else { return QueueError.describe(error) }
        switch e.code {
        case "unit_unavailable": return "Essa unidade acabou de ser reservada nesse período. A disponibilidade foi atualizada: escolha outra unidade ou outras datas."
        case "unit_blocked": return "A unidade está bloqueada nesse período (manutenção ou fechamento). Escolha outras datas ou outra unidade."
        case "outside_rules": return "Fora das regras da reserva: \(e.message)"
        case "booking_closed": return "Esta reserva já foi encerrada (cancelada, expirada ou concluída) e não muda mais."
        case "checkin_disabled": return "O check-in pelo WhatsApp está desligado nas regras da reserva."
        case "checkin_done": return "O cliente já fez o check-in."
        default: return ModuleFailure.message(e)
        }
    }

    /// "2026-11-22" → "22/11".
    static func shortDay(_ day: String) -> String {
        let parts = day.split(separator: "-")
        return parts.count == 3 ? "\(parts[2])/\(parts[1])" : day
    }

    /// Filtros da lista.
    static let filters: [(id: String, title: String, statuses: [String])] = [
        (id: "upcoming", title: "Ativas", statuses: ["pending_payment", "confirmed"]),
        (id: "pending_payment", title: "Aguardando sinal", statuses: ["pending_payment"]),
        (id: "confirmed", title: "Confirmadas", statuses: ["confirmed"]),
        (id: "completed", title: "Concluídas", statuses: ["completed"]),
        (id: "cancelled", title: "Canceladas", statuses: ["cancelled", "expired"]),
        (id: "all", title: "Todas", statuses: []),
    ]

    /// Respostas do check-in em linhas legíveis ("documento: 123", "chegada: 14h").
    static func answers(_ b: Booking) -> [(String, String)] {
        (b.checkinAnswers ?? [:]).sorted { $0.key < $1.key }.map { key, value in
            (key.replacingOccurrences(of: "_", with: " ").capitalized, value.stringValue ?? value.boolValue.map { $0 ? "sim" : "não" } ?? "—")
        }
    }
}
