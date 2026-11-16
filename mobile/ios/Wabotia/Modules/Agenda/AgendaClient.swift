import Foundation

/*
 Agenda (módulo `agenda`, docs/AGENDA.md e docs/API.md "Agenda"). Horários em ms Unix; `date` e `time` dos
 agendamentos já vêm em Brasília. Os cadastros (serviços, profissionais, regras, bloqueios) ficam no painel web nesta
 versão: o app lê o catálogo e opera os agendamentos.
 */

struct AgendaService: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var description: String?
    var durationMinutes: Int?
    var priceCents: Int?
    var active: Bool?
    var position: Int?

    var displayName: String { name?.isEmpty == false ? name! : "Serviço" }
    var isActive: Bool { active ?? true }
}

struct AgendaHours: Codable, Equatable {
    var weekday: Int
    var start: String
    var end: String
}

struct AgendaProfessional: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var userId: String?
    var active: Bool?
    var position: Int?
    var serviceIds: [String]?
    var hours: [AgendaHours]?

    var displayName: String { name?.isEmpty == false ? name! : "Profissional" }
    var isActive: Bool { active ?? true }
}

/// `GET /agenda`: a configuração fica de fora (é do painel); o app usa serviços e profissionais.
struct AgendaCatalog: Decodable, Equatable {
    var services: [AgendaService]?
    var professionals: [AgendaProfessional]?
}

struct Appointment: Codable, Equatable, Identifiable {
    var id: String
    var serviceId: String?
    var serviceName: String?
    var professionalId: String?
    var professionalName: String?
    var starts: Int64
    var ends: Int64?
    /// "AAAA-MM-DD" e "HH:MM" de Brasília: mostrar sem converter fuso.
    var date: String?
    var time: String?
    /// `booked`, `confirmed`, `cancelled` ou `no_show`.
    var status: String?
    var conversationId: String?
    var contactId: String?
    var customerName: String?
    var customerPhone: String?
    var notes: String?
    var source: String?
    var priceCents: Int?
    var bookedAt: Int64?
    var remindedAt: Int64?
    var confirmedAt: Int64?
    var cancelledAt: Int64?
    var cancelledBy: String?
    var cancelReason: String?
    var noShowAt: Int64?
    var moves: Int?
    var created: Int64?
    var updated: Int64?

    var state: String { status ?? "booked" }
    var day: String { date ?? BrasiliaTime.day(starts) }
    var clock: String { time ?? BrasiliaTime.clock(starts) }
    var customer: String { customerName?.isEmpty == false ? customerName! : (customerPhone?.isEmpty == false ? customerPhone! : "Cliente") }
}

struct AgendaSlot: Codable, Equatable, Hashable {
    var starts: Int64
    var ends: Int64?
    var time: String?
    var professionalIds: [String]?

    var clock: String { time ?? BrasiliaTime.clock(starts) }
}

struct AgendaDay: Codable, Equatable {
    var date: String
    var slots: [AgendaSlot]?
}

struct AgendaAvailability: Codable, Equatable {
    var serviceId: String?
    var professionalId: String?
    var days: [AgendaDay]?
}

/// O cliente das rotas da Agenda de uma área.
final class AgendaClient {
    let api: ProfileAPI

    init(api: ProfileAPI) { self.api = api }

    func catalog() async throws -> AgendaCatalog { try await api.get("agenda") }

    /// Agendamentos que cruzam `[from, to)` (até 62 dias).
    func appointments(from: Int64, to: Int64, professionalId: String? = nil, status: [String]? = nil, conversationId: String? = nil) async throws -> [Appointment] {
        let list: DataList<Appointment> = try await api.get("agenda/appointments", query: [
            "from": String(from), "to": String(to), "professional_id": professionalId,
            "status": status?.joined(separator: ","), "conversation_id": conversationId,
        ])
        return list.data ?? []
    }

    func appointment(_ id: String) async throws -> Appointment { try await api.get("agenda/appointments/\(id)") }

    /// Horários livres do dia para a equipe (`staff=1` ignora a antecedência mínima e máxima).
    func availability(serviceId: String, professionalId: String?, date: String) async throws -> AgendaAvailability {
        try await api.get("agenda/availability", query: ["service_id": serviceId, "professional_id": professionalId, "date": date, "staff": "1"])
    }

    /// `professional_id` nulo: quem estiver livre. Com `conversation_id`, o cliente da conversa recebe a confirmação.
    func book(serviceId: String, starts: Int64, professionalId: String?, conversationId: String?, customerName: String?, customerPhone: String?, notes: String?, key: String) async throws -> Appointment {
        try await api.send("POST", "agenda/appointments", [
            "service_id": serviceId, "starts": starts, "professional_id": professionalId, "conversation_id": conversationId,
            "customer_name": customerName, "customer_phone": customerPhone, "notes": notes,
        ], key: key)
    }

    func move(_ id: String, starts: Int64, professionalId: String?, key: String) async throws -> Appointment {
        try await api.send("POST", "agenda/appointments/\(id)/move", ["starts": starts, "professional_id": professionalId], key: key)
    }

    func cancel(_ id: String, reason: String?, key: String) async throws -> Appointment {
        try await api.send("POST", "agenda/appointments/\(id)/cancel", ["reason": reason], key: key)
    }

    func confirm(_ id: String, key: String) async throws -> Appointment {
        try await api.send("POST", "agenda/appointments/\(id)/confirm", [:], key: key)
    }

    func noShow(_ id: String, key: String) async throws -> Appointment {
        try await api.send("POST", "agenda/appointments/\(id)/no-show", [:], key: key)
    }
}

/// Regras das telas da Agenda, sem tela, para testar.
enum AgendaRules {
    static let active: Set<String> = ["booked", "confirmed"]

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "booked": return "Agendado"
        case "confirmed": return "Confirmado"
        case "cancelled": return "Cancelado"
        case "no_show": return "Ausente"
        default: return status
        }
    }

    static func canConfirm(_ a: Appointment) -> Bool { a.state == "booked" }
    static func canMove(_ a: Appointment) -> Bool { active.contains(a.state) }
    static func canCancel(_ a: Appointment) -> Bool { active.contains(a.state) }
    /// Ausência só depois do início (o servidor recusa antes).
    static func canMarkNoShow(_ a: Appointment, now: Date = Date()) -> Bool {
        active.contains(a.state) && BrasiliaTime.millis(now) >= a.starts
    }

    /// Recusa por horário ocupado ou indisponível: a tela recarrega os horários livres.
    static func isSlotConflict(_ error: Error) -> Bool {
        guard let e = error as? QueueError else { return false }
        return e.code == "slot_taken" || e.code == "slot_unavailable"
    }

    /// Profissionais ativos que atendem o serviço (sem lista de serviços: atende todos).
    static func professionals(for serviceId: String?, in all: [AgendaProfessional]) -> [AgendaProfessional] {
        all.filter { p in
            guard p.isActive else { return false }
            guard let serviceId, let ids = p.serviceIds, !ids.isEmpty else { return true }
            return ids.contains(serviceId)
        }
        .sorted { ($0.position ?? 0, $0.displayName) < ($1.position ?? 0, $1.displayName) }
    }

    static func activeServices(_ all: [AgendaService]) -> [AgendaService] {
        all.filter(\.isActive).sorted { ($0.position ?? 0, $0.displayName) < ($1.position ?? 0, $1.displayName) }
    }

    /// Colunas do dia: um grupo por profissional (na ordem do cadastro), com os agendamentos por horário. Profissional
    /// arquivado que ainda tem agendamento aparece no fim.
    static func columns(_ appointments: [Appointment], professionals: [AgendaProfessional]) -> [(professional: AgendaProfessional, items: [Appointment])] {
        let sorted = appointments.sorted { $0.starts < $1.starts }
        var out = professionals.filter(\.isActive).sorted { ($0.position ?? 0) < ($1.position ?? 0) }.map { p in
            (professional: p, items: sorted.filter { $0.professionalId == p.id })
        }
        let known = Set(out.map(\.professional.id))
        let orphans = Dictionary(grouping: sorted.filter { !known.contains($0.professionalId ?? "") }, by: { $0.professionalId ?? "" })
        for (id, items) in orphans.sorted(by: { $0.key < $1.key }) {
            out.append((professional: AgendaProfessional(id: id, name: items.first?.professionalName ?? "Sem profissional"), items: items))
        }
        return out
    }

    /// Os sete dias da semana (segunda a domingo) com os agendamentos de cada um.
    static func week(_ appointments: [Appointment], start: String) -> [(day: String, items: [Appointment])] {
        (0..<7).map { offset in
            let day = BrasiliaTime.addDays(start, offset)
            return (day, appointments.filter { $0.day == day }.sorted { $0.starts < $1.starts })
        }
    }

    static func duration(_ a: Appointment) -> String? {
        guard let ends = a.ends, ends > a.starts else { return nil }
        return "\(BrasiliaTime.clock(a.starts)) às \(BrasiliaTime.clock(ends))"
    }
}
