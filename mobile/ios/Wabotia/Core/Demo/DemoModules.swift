import Foundation

/// Idempotência das escritas da demonstração: a mesma chave com o mesmo pedido devolve a mesma resposta; com outro
/// pedido, 409 `idempotency_conflict`.
private final class DemoReplays {
    private var replies: [String: DemoServer.Reply] = [:]

    func run(key: String?, path: [String], body: [String: Any], _ write: () -> DemoServer.Reply) -> DemoServer.Reply {
        guard let key, !key.isEmpty else { return demoFail(400, "idempotency_required", "Envie Idempotency-Key em toda escrita.") }
        let canonical = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let signature = "\(key)|\(path.joined(separator: "/"))|\(canonical)"
        if let replay = replies[signature] { return replay }
        if replies.keys.contains(where: { $0.hasPrefix("\(key)|") }) { return demoFail(409, "idempotency_conflict", "A mesma chave foi usada com outro pedido.") }
        let reply = write()
        if reply.status < 500 { replies[signature] = reply }
        return reply
    }
}

private func demoOk(_ value: Any) -> DemoServer.Reply { DemoServer.Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }

private func demoFail(_ status: Int, _ code: String, _ message: String) -> DemoServer.Reply {
    DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
}

private func nul(_ value: Any?) -> Any { value ?? NSNull() }

typealias DemoEmit = (_ kind: String, _ payload: [String: Any]) -> Void

/// Estabelecimento e pessoas da área da demonstração (`GET /establishment`, `GET /people`). Endereço e telefone
/// inventados (DDD 20 não existe); sem documento, para não usar o CNPJ de ninguém.
enum DemoArea {
    static let people: [[String: Any]] = [
        ["id": "u_ana", "name": "Ana Souza", "role": "operator"],
        ["id": "u_carlos", "name": "Carlos Pereira", "role": "operator"],
        ["id": DemoMode.meId, "name": DemoMode.meName, "role": "admin"],
        ["id": "u_marina", "name": "Marina Lima", "role": "operator"],
    ]

    static func route(method: String, parts: [String]) -> DemoServer.Reply? {
        guard method == "GET", parts.count == 5, Array(parts.prefix(3)) == ["api", "v1", "profiles"] else { return nil }
        switch parts[4] {
        case "establishment":
            return demoOk(["name": DemoMode.profileName, "document": "", "document_type": NSNull(), "document_display": "",
                           "address": "Rua Exemplo, 100 — Centro\nCidade Exemplo/SP", "phone": "(20) 3000-0000",
                           "footer": "Demonstração: dados fictícios.", "configured": true])
        case "people":
            return demoOk(["data": people])
        default:
            return nil
        }
    }
}

// MARK: - Agenda (barbearia)

/// A Agenda da demonstração: uma barbearia com dois profissionais, aberta todos os dias (para a revisão das lojas ver
/// a agenda em qualquer dia), das 9h às 12h e das 13h às 19h, com horários de 30 minutos. Agendamentos de hoje e da
/// semana, alguns ligados às conversas de exemplo. Um cliente fictício marca pelo WhatsApp depois de 40 segundos.
final class DemoAgenda {
    typealias Row = [String: Any]

    private struct Service { let id, name: String; let minutes, price: Int }
    private struct Professional { let id, name: String; let services: [String] }
    private final class A {
        let id: String, serviceId: String
        var professionalId: String
        var starts: Int64, ends: Int64
        var status = "booked"
        let conversationId: String?, customerName: String, customerPhone: String, source: String
        let notes: String
        var confirmedAt: Int64?, cancelledAt: Int64?, cancelReason = "", noShowAt: Int64?
        var moves = 0
        let bookedAt: Int64
        var updated: Int64
        init(id: String, serviceId: String, professionalId: String, starts: Int64, ends: Int64, conversationId: String?, customerName: String, customerPhone: String, source: String, notes: String = "", bookedAt: Int64) {
            self.id = id; self.serviceId = serviceId; self.professionalId = professionalId; self.starts = starts; self.ends = ends
            self.conversationId = conversationId; self.customerName = customerName; self.customerPhone = customerPhone; self.source = source
            self.notes = notes; self.bookedAt = bookedAt; self.updated = bookedAt
        }
    }

    private let services = [
        Service(id: "s_corte", name: "Corte de cabelo", minutes: 30, price: 4500),
        Service(id: "s_barba", name: "Barba", minutes: 30, price: 3500),
        Service(id: "s_combo", name: "Corte e barba", minutes: 60, price: 7000),
        Service(id: "s_pigmentacao", name: "Pigmentação", minutes: 60, price: 6000),
    ]
    private let professionals = [
        Professional(id: "p_rui", name: "Rui Amaral", services: ["s_corte", "s_barba", "s_combo", "s_pigmentacao"]),
        Professional(id: "p_leo", name: "Léo Prado", services: ["s_corte", "s_barba", "s_combo"]),
    ]
    private static let turns = [(9 * 60, 12 * 60), (13 * 60, 19 * 60)]
    private var appointments: [A] = []
    private let replays = DemoReplays()
    private var seq = 0
    private var nextWalkIn: Int64

    init(t0: Int64) {
        nextWalkIn = t0 + 40_000
        let today = BrasiliaTime.day(t0)
        // (dia, hora, minuto, serviço, profissional, cliente, telefone, conversa, estado)
        let seed: [(Int, Int, Int, String, String, String, String, String?, String)] = [
            (0, 9, 0, "s_corte", "p_rui", "Mariana Costa", "5520908765432", "c_rich", "confirmed"),
            (0, 10, 0, "s_combo", "p_leo", "Gustavo Lima", "5520907771234", nil, "booked"),
            (0, 11, 0, "s_barba", "p_rui", "João Pedro Almeida", "5520906543210", "c_5h", "booked"),
            (0, 14, 30, "s_corte", "p_leo", "Henrique Sales", "5520907775678", nil, "confirmed"),
            (0, 16, 0, "s_pigmentacao", "p_rui", "Patrícia Nunes", "5520909887766", "c_40", "booked"),
            (0, 17, 30, "s_corte", "p_leo", "Otávio Reis", "5520907779012", nil, "cancelled"),
            (1, 9, 30, "s_combo", "p_rui", "Eduardo Santos", "5520903334455", "c_other", "booked"),
            (1, 15, 0, "s_corte", "p_leo", "Vinícius Rocha", "5520907773456", nil, "booked"),
            (2, 10, 0, "s_barba", "p_leo", "Felipe Moura", "5520907777890", nil, "booked"),
            (3, 13, 0, "s_corte", "p_rui", "Aline Barbosa", "5520904445566", "c_closed", "booked"),
            (4, 18, 0, "s_combo", "p_rui", "Renato Dias", "5520907772345", nil, "booked"),
            (-1, 9, 0, "s_corte", "p_rui", "Tiago Melo", "5520907776789", nil, "no_show"),
        ]
        for (offset, hour, minute, service, pro, name, phone, conversation, status) in seed {
            guard let start = BrasiliaTime.range(from: BrasiliaTime.addDays(today, offset))?.from else { continue }
            let starts = start + Int64(hour * 60 + minute) * 60_000
            let a = make(service, pro, starts, conversation, name, phone, source: conversation == nil ? "panel" : "whatsapp", at: t0 - 2 * 86_400_000)
            a.status = status
            if status == "confirmed" { a.confirmedAt = t0 - 3_600_000 }
            if status == "cancelled" { a.cancelledAt = t0 - 7_200_000; a.cancelReason = "Cliente avisou que não poderia vir." }
            if status == "no_show" { a.noShowAt = starts + 900_000 }
            appointments.append(a)
        }
    }

    private func make(_ service: String, _ pro: String, _ starts: Int64, _ conversation: String?, _ name: String, _ phone: String, source: String, notes: String = "", at: Int64) -> A {
        seq += 1
        let minutes = services.first { $0.id == service }?.minutes ?? 30
        return A(id: "ag_\(seq)", serviceId: service, professionalId: pro, starts: starts, ends: starts + Int64(minutes) * 60_000,
                 conversationId: conversation, customerName: name, customerPhone: phone, source: source, notes: notes, bookedAt: at)
    }

    func route(method: String, parts: [String], body: Row, query: [String: String], key: String?, now: Int64, emit: DemoEmit) -> DemoServer.Reply? {
        guard parts.count >= 5, parts[4] == "agenda" else { return nil }
        tick(now, emit)
        let r = Array(parts.dropFirst(5))
        if method == "GET" {
            if r.isEmpty { return demoOk(["config": ["slot_minutes": 30, "reminder_hours": 24], "services": services.map(serviceRow), "professionals": professionals.map(professionalRow)]) }
            if r == ["services"] { return demoOk(["data": services.map(serviceRow)]) }
            if r == ["professionals"] { return demoOk(["data": professionals.map(professionalRow)]) }
            if r == ["availability"] { return availability(query, now: now) }
            if r == ["appointments"] {
                let from = Int64(query["from"] ?? "") ?? 0, to = Int64(query["to"] ?? "") ?? Int64.max
                let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
                let list = appointments.filter { a in
                    a.starts < to && a.ends > from && (query["professional_id"].map { $0.isEmpty || $0 == a.professionalId } ?? true)
                        && (statuses.isEmpty || statuses.contains(a.status)) && (query["conversation_id"].map { $0.isEmpty || $0 == a.conversationId } ?? true)
                }
                return demoOk(["data": list.sorted { $0.starts < $1.starts }.map(row)])
            }
            if r.count == 2, r[0] == "appointments" {
                guard let a = appointments.first(where: { $0.id == r[1] }) else { return demoFail(404, "not_found", "Agendamento não encontrado.") }
                return demoOk(row(a))
            }
            return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        guard method == "POST" else { return demoFail(405, "method_not_allowed", "Método não permitido.") }
        return replays.run(key: key, path: r, body: body) { write(r, body, now, emit) }
    }

    private func write(_ r: [String], _ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        if r == ["appointments"] {
            guard let service = services.first(where: { $0.id == body["service_id"] as? String }) else { return demoFail(400, "invalid_request", "Serviço não encontrado.") }
            guard let starts = (body["starts"] as? NSNumber)?.int64Value else { return demoFail(400, "invalid_request", "Informe o horário.") }
            let conversation = body["conversation_id"] as? String
            let name = conversation.flatMap(Self.conversationNames) ?? (body["customer_name"] as? String ?? "")
            guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return demoFail(400, "invalid_request", "Informe conversation_id ou customer_name.") }
            guard let pro = freeProfessional(service, starts, wanted: body["professional_id"] as? String, ignoring: nil) else {
                return demoFail(409, "slot_taken", "Esse horário acabou de ser ocupado.")
            }
            let phone = conversation.flatMap(Self.conversationPhones) ?? (body["customer_phone"] as? String ?? "")
            let a = make(service.id, pro, starts, conversation, name, phone, source: "panel", notes: body["notes"] as? String ?? "", at: now)
            appointments.append(a)
            emit("agenda.booked", ["appointment": row(a), "conversation_id": nul(a.conversationId), "actor": DemoMode.meId, "module_id": "agenda"])
            return demoOk(row(a))
        }
        guard r.count == 3, r[0] == "appointments", let a = appointments.first(where: { $0.id == r[1] }) else { return demoFail(404, "not_found", "Agendamento não encontrado.") }
        guard a.status == "booked" || a.status == "confirmed" else { return demoFail(409, "appointment_closed", "Este agendamento já foi encerrado.") }
        switch r[2] {
        case "move":
            guard let starts = (body["starts"] as? NSNumber)?.int64Value, let service = services.first(where: { $0.id == a.serviceId }) else { return demoFail(400, "invalid_request", "Informe o horário.") }
            guard let pro = freeProfessional(service, starts, wanted: (body["professional_id"] as? String) ?? a.professionalId, ignoring: a.id) else {
                return demoFail(409, "slot_taken", "Esse horário acabou de ser ocupado.")
            }
            let previous = row(a)
            a.starts = starts
            a.ends = starts + Int64(service.minutes) * 60_000
            a.professionalId = pro
            a.moves += 1
            a.status = "booked"
            a.updated = now
            emit("agenda.rescheduled", ["appointment": row(a), "previous": previous, "conversation_id": nul(a.conversationId), "actor": DemoMode.meId, "module_id": "agenda"])
        case "cancel":
            a.status = "cancelled"; a.cancelledAt = now; a.cancelReason = body["reason"] as? String ?? ""; a.updated = now
            emit("agenda.cancelled", ["appointment": row(a), "reason": a.cancelReason, "conversation_id": nul(a.conversationId), "actor": DemoMode.meId, "module_id": "agenda"])
        case "confirm":
            a.status = "confirmed"; a.confirmedAt = now; a.updated = now
            emit("agenda.confirmed", ["appointment": row(a), "conversation_id": nul(a.conversationId), "actor": DemoMode.meId, "module_id": "agenda"])
        case "no-show":
            guard now >= a.starts else { return demoFail(409, "invalid_request", "A ausência só pode ser marcada depois do início.") }
            a.status = "no_show"; a.noShowAt = now; a.updated = now
            emit("agenda.no_show", ["appointment": row(a), "conversation_id": nul(a.conversationId), "actor": DemoMode.meId, "module_id": "agenda"])
        default:
            return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(row(a))
    }

    /// O profissional pedido, se livre; sem pedido, o primeiro livre que atende o serviço. `nil`: ocupado.
    private func freeProfessional(_ service: Service, _ starts: Int64, wanted: String?, ignoring: String?) -> String? {
        let ends = starts + Int64(service.minutes) * 60_000
        let candidates = professionals.filter { $0.services.contains(service.id) && (wanted == nil || wanted == "" || $0.id == wanted) }
        return candidates.first { pro in
            !appointments.contains { $0.id != ignoring && $0.professionalId == pro.id && ($0.status == "booked" || $0.status == "confirmed") && $0.starts < ends && $0.ends > starts }
        }?.id
    }

    private func availability(_ query: [String: String], now: Int64) -> DemoServer.Reply {
        guard let service = services.first(where: { $0.id == query["service_id"] }) else { return demoFail(400, "invalid_request", "Serviço não encontrado.") }
        let date = query["date"] ?? BrasiliaTime.day(now)
        guard let dayStart = BrasiliaTime.range(from: date)?.from else { return demoFail(400, "invalid_request", "Dia inválido.") }
        let wanted = query["professional_id"].flatMap { $0.isEmpty ? nil : $0 }
        var slots: [Int64: [String]] = [:]
        for pro in professionals where pro.services.contains(service.id) && (wanted == nil || wanted == pro.id) {
            for (from, to) in Self.turns {
                var minute = from
                while minute + service.minutes <= to {
                    let starts = dayStart + Int64(minute) * 60_000
                    if starts > now, freeProfessional(service, starts, wanted: pro.id, ignoring: nil) != nil { slots[starts, default: []].append(pro.id) }
                    minute += 30
                }
            }
        }
        let list: [Row] = slots.keys.sorted().map { ["starts": $0, "ends": $0 + Int64(service.minutes) * 60_000, "time": BrasiliaTime.clock($0), "professional_ids": slots[$0] ?? []] }
        return demoOk(["service_id": service.id, "professional_id": nul(wanted), "days": [["date": date, "slots": list]]])
    }

    /// Um cliente marca pelo WhatsApp, para a tela aberta se atualizar pelo evento `agenda.booked`.
    private func tick(_ now: Int64, _ emit: DemoEmit) {
        guard now >= nextWalkIn else { return }
        nextWalkIn = Int64.max
        let tomorrow = BrasiliaTime.addDays(BrasiliaTime.day(now), 1)
        guard let start = BrasiliaTime.range(from: tomorrow)?.from, let service = services.first else { return }
        let minutes: [Int64] = [11 * 60, 16 * 60 + 30, 18 * 60]
        let candidates: [Int64] = minutes.map { start + $0 * 60_000 }
        guard let starts = candidates.first(where: { freeProfessional(service, $0, wanted: "p_leo", ignoring: nil) != nil }) else { return }
        let a = make(service.id, "p_leo", starts, "c_queue", "Fernanda Rocha", "5520901122334", source: "whatsapp", at: now)
        appointments.append(a)
        emit("agenda.booked", ["appointment": row(a), "conversation_id": "c_queue", "actor": "customer", "module_id": "agenda"])
    }

    private func serviceRow(_ s: Service) -> Row {
        ["id": s.id, "name": s.name, "description": "", "duration_minutes": s.minutes, "price_cents": s.price, "active": true, "position": services.firstIndex { $0.id == s.id } ?? 0]
    }

    private func professionalRow(_ p: Professional) -> Row {
        ["id": p.id, "name": p.name, "user_id": NSNull(), "active": true, "position": professionals.firstIndex { $0.id == p.id } ?? 0, "service_ids": p.services,
         "hours": (0...6).flatMap { day in Self.turns.map { ["weekday": day, "start": String(format: "%02d:%02d", $0.0 / 60, $0.0 % 60), "end": String(format: "%02d:%02d", $0.1 / 60, $0.1 % 60)] } }]
    }

    private func row(_ a: A) -> Row {
        let service = services.first { $0.id == a.serviceId }
        return [
            "id": a.id, "service_id": a.serviceId, "service_name": nul(service?.name), "professional_id": a.professionalId,
            "professional_name": nul(professionals.first { $0.id == a.professionalId }?.name), "starts": a.starts, "ends": a.ends,
            "date": BrasiliaTime.day(a.starts), "time": BrasiliaTime.clock(a.starts), "status": a.status, "conversation_id": nul(a.conversationId),
            "contact_id": NSNull(), "customer_name": a.customerName, "customer_phone": a.customerPhone, "notes": a.notes, "source": a.source,
            "price_cents": nul(service?.price), "booked_at": a.bookedAt, "reminded_at": NSNull(), "confirmed_at": nul(a.confirmedAt),
            "cancelled_at": nul(a.cancelledAt), "cancelled_by": a.cancelledAt == nil ? NSNull() : DemoMode.meId, "cancel_reason": a.cancelReason,
            "no_show_at": nul(a.noShowAt), "moves": a.moves, "created_by": a.source == "whatsapp" ? "customer" : DemoMode.meId, "created": a.bookedAt, "updated": a.updated,
        ]
    }

    /// Nomes e telefones das conversas de exemplo (DemoServer), para o agendamento feito pela conversa.
    static let conversationNames: (String) -> String? = { ["c_rich": "Mariana Costa", "c_queue": "Fernanda Rocha", "c_queue2": "Lucas Martins", "c_5h": "João Pedro Almeida",
                                                          "c_40": "Patrícia Nunes", "c_closedwin": "Roberto Dias", "c_bot": "Camila Ferreira", "c_other": "Eduardo Santos",
                                                          "c_closed": "Aline Barbosa"][$0] }
    static let conversationPhones: (String) -> String? = { ["c_rich": "5520908765432", "c_queue": "5520901122334", "c_queue2": "5520908876655", "c_5h": "5520906543210",
                                                           "c_40": "5520909887766", "c_closedwin": "5520901234567", "c_bot": "5520902223344", "c_other": "5520903334455",
                                                           "c_closed": "5520904445566"][$0] }
}

// MARK: - Ordem de serviço (assistência técnica)

/// As ordens de serviço da demonstração: uma assistência técnica com oito ordens, uma em cada estado, algumas ligadas
/// às conversas de exemplo. As regras de transição são as do servidor (`src/modules/os/model.ts`). Depois de um
/// minuto, a cliente da ordem com orçamento enviado aprova pelo WhatsApp.
final class DemoServiceOrders {
    typealias Row = [String: Any]

    static let manual: [String: [String]] = [
        "received": ["analyzing", "in_progress", "cancelled"], "analyzing": ["in_progress", "cancelled"], "quoted": ["analyzing", "cancelled"],
        "approved": ["in_progress", "cancelled"], "declined": ["analyzing", "ready", "cancelled"], "in_progress": ["ready", "cancelled"],
        "ready": ["delivered", "in_progress", "cancelled"], "delivered": [], "cancelled": [],
    ]
    static let quotable: Set<String> = ["received", "analyzing", "quoted", "declined"]

    private final class O {
        let id: String, number: Int
        var status: String
        let customerName: String, phone: String, conversationId: String?
        var item: String, problem: String, notes: String
        let source: String
        var dueAt: Int64?
        var assignee: String?
        var termsAt: Int64?
        var quote: [QuoteItem]?
        var quoteNote = "", quoteDays = 7, quoteVersion = 0
        var quoteValidUntil: Int64?, quoteSentAt: Int64?
        var decision: String?, decidedAt: Int64?, decidedVia: String?
        var readyAt: Int64?, deliveredAt: Int64?, warrantyUntil: Int64?
        let created: Int64
        var updated: Int64
        var history: [Row] = []
        init(id: String, number: Int, status: String, customer: String, phone: String, conversation: String?, item: String, problem: String, notes: String = "", source: String, created: Int64) {
            self.id = id; self.number = number; self.status = status; self.customerName = customer; self.phone = phone; self.conversationId = conversation
            self.item = item; self.problem = problem; self.notes = notes; self.source = source; self.created = created; self.updated = created
        }
    }

    private var orders: [O] = []
    private let replays = DemoReplays()
    private var seq = 0
    private var approveAt: Int64
    /// As ordens por modelo (`DemoWorkOrders`); sem elas, a demonstração é a de um servidor sem modelos.
    let work: DemoWorkOrders?

    init(t0: Int64, work: DemoWorkOrders? = nil) {
        self.work = work
        approveAt = t0 + 60_000
        let day: Int64 = 86_400_000
        func add(_ number: Int, _ status: String, _ customer: String, _ phone: String, _ conversation: String?, _ item: String, _ problem: String, ago: Int64, notes: String = "") -> O {
            let o = O(id: "os_\(number)", number: number, status: status, customer: customer, phone: phone, conversation: conversation, item: item, problem: problem,
                      notes: notes, source: conversation == nil ? "panel" : "whatsapp", created: t0 - ago)
            if conversation != nil { o.termsAt = t0 - ago }
            o.history.append(history(o, kind: "opened", from: nil, to: "received", actor: conversation == nil ? DemoMode.meId : "customer", at: t0 - ago))
            orders.append(o)
            return o
        }
        _ = add(1, "delivered", "Aline Barbosa", "5520904445566", "c_closed", "Notebook Lenovo", "Teclado com teclas falhando", ago: 20 * day)
        let declined = add(2, "declined", "Bruno Teixeira", "5520907715566", nil, "Controle de videogame", "Analógico esquerdo com drift", ago: 9 * day)
        let ready = add(3, "ready", "Eduardo Santos", "5520903334455", "c_other", "Caixa de som", "Sem áudio no canal esquerdo", ago: 7 * day)
        let progress = add(4, "in_progress", "Sílvia Campos", "5520907716677", nil, "Smartwatch", "Não carrega no suporte", ago: 5 * day, notes: "Peça encomendada, chega quinta.")
        let approved = add(5, "approved", "João Pedro Almeida", "5520906543210", "c_5h", "Tablet", "Conector de carga solto", ago: 4 * day)
        let quoted = add(6, "quoted", "Patrícia Nunes", "5520909887766", "c_40", "iPhone 11", "Bateria descarrega muito rápido", ago: 2 * day)
        _ = add(7, "analyzing", "Carlos Mendes", "5520907718899", nil, "Notebook", "Não liga depois de molhar", ago: day, notes: "Cliente pediu urgência.")
        _ = add(8, "received", "Mariana Costa", "5520908765432", "c_rich", "Celular Galaxy A54", "Tela trincada após queda", ago: 20 * 60_000)
        seq = 8

        func quote(_ o: O, _ items: [QuoteItem], sentAgo: Int64) {
            o.quote = items
            o.quoteVersion = 1
            o.quoteSentAt = t0 - sentAgo
            o.quoteValidUntil = t0 - sentAgo + 7 * day
            o.history.append(history(o, kind: "quote_sent", from: "analyzing", to: "quoted", actor: DemoMode.meId, at: t0 - sentAgo))
        }
        let delivered = orders[0]
        quote(delivered, [QuoteItem(description: "Teclado novo", quantity: 1, unitCents: 32_000), QuoteItem(description: "Mão de obra", quantity: 1, unitCents: 9_000)], sentAgo: 19 * day)
        delivered.decision = "approve"; delivered.decidedAt = t0 - 18 * day; delivered.decidedVia = "whatsapp"
        delivered.readyAt = t0 - 16 * day; delivered.deliveredAt = t0 - 15 * day; delivered.warrantyUntil = t0 + 75 * day
        quote(declined, [QuoteItem(description: "Módulo analógico", quantity: 1, unitCents: 9_000), QuoteItem(description: "Mão de obra", quantity: 1, unitCents: 6_000)], sentAgo: 8 * day)
        declined.decision = "decline"; declined.decidedAt = t0 - 7 * day; declined.decidedVia = "staff"
        quote(ready, [QuoteItem(description: "Placa de áudio (reparo)", quantity: 1, unitCents: 14_000)], sentAgo: 6 * day)
        ready.decision = "approve"; ready.decidedAt = t0 - 6 * day + 3_600_000; ready.decidedVia = "whatsapp"; ready.readyAt = t0 - 2 * day
        progress.dueAt = t0 + 3 * day
        progress.assignee = "u_ana"
        orders[6].assignee = "u_carlos"
        quote(approved, [QuoteItem(description: "Conector de carga", quantity: 1, unitCents: 6_500), QuoteItem(description: "Mão de obra", quantity: 1, unitCents: 8_000)], sentAgo: 3 * day)
        approved.decision = "approve"; approved.decidedAt = t0 - 2 * day; approved.decidedVia = "whatsapp"
        quote(quoted, [QuoteItem(description: "Bateria", quantity: 1, unitCents: 28_900), QuoteItem(description: "Mão de obra", quantity: 1, unitCents: 8_000)], sentAgo: day)
    }

    private func history(_ o: O, kind: String, from: String?, to: String?, actor: String, at: Int64, note: String? = nil) -> Row {
        seq += 1
        return ["id": "osh_\(seq)_\(o.number)", "kind": kind, "from_status": nul(from), "to_status": nul(to), "actor": actor, "note": nul(note), "created": at]
    }

    func route(method: String, parts: [String], body: Row, query: [String: String], key: String?, now: Int64, emit: DemoEmit) -> DemoServer.Reply? {
        guard parts.count >= 5, parts[4] == "service-orders" else { return nil }
        tick(now, emit)
        let r = Array(parts.dropFirst(5))
        if let work {
            // Lista com modelo (`type_id`/`type_ids`): as ordens simples entram quando o filtro inclui `service_order`
            // e não há etapa escolhida.
            if method == "GET", r.isEmpty, query["type_id"] != nil || query["type_ids"] != nil {
                let typeId = query["type_id"]
                let wantsLegacy = query["stage"] == nil
                    && (typeId == DemoWorkOrders.builtinId || (typeId == nil && (query["type_ids"] ?? "").split(separator: ",").contains { $0 == DemoWorkOrders.builtinId }))
                var rows: [(created: Int64, row: Row)] = wantsLegacy ? filtered(query).map { o in
                    var row = view(o, now, withHistory: false)
                    row["type_id"] = DemoWorkOrders.builtinId
                    row["type_label"] = "Ordem de serviço"
                    return (o.created, row)
                } : []
                rows += work.list(query)
                rows.sort { $0.created > $1.created }
                return demoOk(["data": rows.map(\.row), "next_cursor": NSNull(), "counts": Row()])
            }
            if let first = r.first, work.handles(first) {
                return work.route(method: method, r: r, body: body, query: query, key: key, now: now, emit: emit, builtin: Self.builtinType)
            }
            if method == "POST", r.isEmpty, work.ownsType(body["type_id"] as? String) {
                return work.route(method: method, r: r, body: body, query: query, key: key, now: now, emit: emit, builtin: Self.builtinType)
            }
        }
        if method == "GET" {
            if r.isEmpty { return list(query, now) }
            if r.count == 1 {
                guard let o = orders.first(where: { $0.id == r[0] }) else { return demoFail(404, "not_found", "Ordem de serviço não encontrada.") }
                return demoOk(view(o, now, withHistory: true))
            }
            return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return replays.run(key: key, path: r, body: body) { write(method, r, body, now, emit) }
    }

    /// O modelo embutido no catálogo (`kind: "builtin"`): a ordem simples, com estados fixos.
    static let builtinType: Row = [
        "schema_version": 1, "kind": "builtin", "id": DemoWorkOrders.builtinId, "revision": 1, "archived": false,
        "labels": ["singular": "Ordem de serviço", "plural": "Ordens de serviço", "item": "Item", "problem": "Problema", "customer_singular": "Cliente", "customer_plural": "Clientes"] as Row,
        "fields": [Row](), "stages": [Row](), "transitions": [Row](), "initial_stage": "received",
    ]

    /// As ordens simples com os filtros de situação, conversa e busca (sem paginação).
    private func filtered(_ query: [String: String]) -> [O] {
        let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
        let q = (query["q"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let digits = q.filter(\.isNumber)
        return orders.filter { o in
            if !statuses.isEmpty { return statuses.contains(o.status) }
            if query["open"] == "1" { return o.status != "delivered" && o.status != "cancelled" }
            return true
        }.filter { o in
            q.isEmpty || [o.item, o.customerName, o.problem].contains { $0.lowercased().contains(q) } || (!digits.isEmpty && (String(o.number) == digits || (digits.count >= 4 && o.phone.contains(digits))))
        }
    }

    private func list(_ query: [String: String], _ now: Int64) -> DemoServer.Reply {
        let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
        let q = (query["q"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let digits = q.filter(\.isNumber)
        var found = orders.filter { o in
            if !statuses.isEmpty { return statuses.contains(o.status) }
            if query["open"] == "1" { return o.status != "delivered" && o.status != "cancelled" }
            return true
        }
        if let conversation = query["conversation_id"], !conversation.isEmpty { found = found.filter { $0.conversationId == conversation } }
        if !q.isEmpty {
            found = found.filter { o in
                [o.item, o.customerName, o.problem].contains { $0.lowercased().contains(q) } || (!digits.isEmpty && (String(o.number) == digits || (digits.count >= 4 && o.phone.contains(digits))))
            }
        }
        found.sort { $0.number > $1.number }
        if let cursor = Int(query["cursor"] ?? "") { found = found.filter { $0.number < cursor } }
        let limit = min(max(Int(query["limit"] ?? "") ?? 50, 1), 200)
        let page = Array(found.prefix(limit))
        var counts: [String: Int] = [:]
        for o in orders { counts[o.status, default: 0] += 1 }
        return demoOk(["data": page.map { view($0, now, withHistory: false) }, "next_cursor": nul(found.count > limit ? String(page.last!.number) : nil), "counts": counts])
    }

    private func write(_ method: String, _ r: [String], _ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        if method == "POST", r.isEmpty {
            let item = (body["item"] as? String ?? "").trimmingCharacters(in: .whitespaces), problem = (body["problem"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            guard !item.isEmpty, !problem.isEmpty else { return demoFail(400, "invalid_request", "Informe o item e o problema.") }
            let conversation = body["conversation_id"] as? String
            let phone = conversation.flatMap(DemoAgenda.conversationPhones) ?? (body["phone"] as? String ?? "").filter(\.isNumber)
            guard conversation != nil || phone.count >= 10 else { return demoFail(400, "invalid_request", "Informe conversation_id ou phone.") }
            let name = conversation.flatMap(DemoAgenda.conversationNames) ?? (body["customer_name"] as? String ?? "")
            let number = (orders.map(\.number).max() ?? 0) + 1
            let o = O(id: "os_\(number)", number: number, status: "received", customer: name, phone: phone.count == 10 || phone.count == 11 ? "55" + phone : phone,
                      conversation: conversation, item: item, problem: problem, notes: body["notes"] as? String ?? "", source: "panel", created: now)
            o.dueAt = (body["due_at"] as? NSNumber)?.int64Value
            o.assignee = body["assignee"] as? String
            o.history.append(history(o, kind: "opened", from: nil, to: "received", actor: DemoMode.meId, at: now))
            orders.append(o)
            emit("os.opened", ["order": view(o, now, withHistory: false), "conversation_id": nul(conversation), "module_id": "os"])
            return demoOk(view(o, now, withHistory: false))
        }
        guard let o = orders.first(where: { $0.id == r.first }) else { return demoFail(404, "not_found", "Ordem de serviço não encontrada.") }
        let tail = Array(r.dropFirst())
        switch (method, tail) {
        case ("PATCH", []):
            if body.keys.contains("assignee") {
                let person = body["assignee"] as? String
                guard person == nil || DemoArea.people.contains(where: { $0["id"] as? String == person }) else { return demoFail(400, "invalid_request", "Responsável não encontrado na área.") }
                o.assignee = person
            }
            o.updated = now
            o.history.append(history(o, kind: "edit", from: o.status, to: o.status, actor: DemoMode.meId, at: now))
        case ("POST", ["status"]):
            guard let to = body["status"] as? String else { return demoFail(400, "invalid_request", "Informe o estado.") }
            guard (Self.manual[o.status] ?? []).contains(to) else { return demoFail(409, "invalid_transition", "Mudança de estado não permitida.") }
            let from = o.status
            o.status = to
            o.updated = now
            if to == "ready" { o.readyAt = now }
            if to == "delivered" { o.deliveredAt = now; o.warrantyUntil = now + 90 * 86_400_000 }
            o.history.append(history(o, kind: "status", from: from, to: to, actor: DemoMode.meId, at: now, note: body["note"] as? String))
            emit(to == "delivered" ? "os.delivered" : "os.status_changed", ["order": view(o, now, withHistory: false), "from": from, "to": to, "actor": DemoMode.meId, "conversation_id": nul(o.conversationId), "module_id": "os"])
        case ("PUT", ["quote"]):
            guard Self.quotable.contains(o.status) else { return demoFail(409, "invalid_transition", "O orçamento não pode ser alterado agora.") }
            let items = (body["items"] as? [Row] ?? []).compactMap { raw -> QuoteItem? in
                guard let d = raw["description"] as? String, let cents = (raw["unit_cents"] as? NSNumber)?.intValue else { return nil }
                return QuoteItem(description: d, quantity: (raw["quantity"] as? NSNumber)?.intValue ?? 1, unitCents: cents)
            }
            guard !items.isEmpty else { return demoFail(400, "invalid_request", "Orçamento: informe de 1 a 50 itens.") }
            let from = o.status
            o.quote = items
            o.quoteDays = (body["valid_days"] as? NSNumber)?.intValue ?? 7
            o.quoteNote = body["note"] as? String ?? ""
            o.quoteVersion += 1
            o.quoteSentAt = nil
            o.quoteValidUntil = nil
            o.decision = nil
            if o.status == "quoted" || o.status == "declined" { o.status = "analyzing" }
            o.updated = now
            o.history.append(history(o, kind: "quote", from: from, to: o.status, actor: DemoMode.meId, at: now))
        case ("POST", ["quote", "send"]):
            guard o.quote != nil, Self.quotable.contains(o.status) else { return demoFail(409, "invalid_transition", "Monte o orçamento antes de enviar.") }
            if (body["notify"] as? Bool ?? true), o.conversationId == nil { return demoFail(409, "no_conversation", "Esta ordem não está ligada a uma conversa.") }
            let from = o.status
            o.status = "quoted"
            o.quoteSentAt = now
            o.quoteValidUntil = now + Int64(o.quoteDays) * 86_400_000
            o.decision = nil
            o.updated = now
            o.history.append(history(o, kind: "quote_sent", from: from, to: "quoted", actor: DemoMode.meId, at: now))
            emit("os.quoted", ["order": view(o, now, withHistory: false), "conversation_id": nul(o.conversationId), "module_id": "os"])
        case ("POST", ["decision"]):
            guard o.status == "quoted" else { return demoFail(409, "quote_not_pending", "Não há orçamento aguardando resposta.") }
            if let until = o.quoteValidUntil, until <= now { return demoFail(409, "quote_expired", "O orçamento venceu.") }
            decide(o, approve: body["decision"] as? String == "approve", via: "staff", now: now, emit: emit)
        default:
            return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(view(o, now, withHistory: true))
    }

    private func decide(_ o: O, approve: Bool, via: String, now: Int64, emit: DemoEmit) {
        o.status = approve ? "approved" : "declined"
        o.decision = approve ? "approve" : "decline"
        o.decidedAt = now
        o.decidedVia = via
        o.updated = now
        o.history.append(history(o, kind: "decision", from: "quoted", to: o.status, actor: via == "whatsapp" ? "customer" : DemoMode.meId, at: now))
        emit(approve ? "os.approved" : "os.declined", ["order": view(o, now, withHistory: false), "by": via == "whatsapp" ? "customer" : DemoMode.meId, "via": via,
                                                        "conversation_id": nul(o.conversationId), "module_id": "os"])
    }

    /// A cliente da ordem com orçamento enviado aprova pelo WhatsApp (o evento `os.approved` atualiza a tela aberta).
    private func tick(_ now: Int64, _ emit: DemoEmit) {
        guard now >= approveAt else { return }
        approveAt = Int64.max
        if let o = orders.first(where: { $0.number == 6 && $0.status == "quoted" }) { decide(o, approve: true, via: "whatsapp", now: now, emit: emit) }
    }

    private func view(_ o: O, _ now: Int64, withHistory: Bool) -> Row {
        var next = Self.manual[o.status] ?? []
        if o.quote != nil && Self.quotable.contains(o.status) { next.append("quoted") }
        if o.status == "quoted" { next += ["approved", "declined"] }
        let total = o.quote?.reduce(0) { $0 + $1.totalCents }
        var row: Row = [
            "id": o.id, "number": o.number, "status": o.status, "status_label": ServiceOrderRules.statusLabel(o.status),
            "customer": ["name": o.customerName, "phone": o.phone, "contact_id": NSNull(), "conversation_id": nul(o.conversationId)],
            "item": o.item, "problem": o.problem, "notes": o.notes, "assignee": nul(o.assignee), "due_at": nul(o.dueAt), "source": o.source,
            "terms": nul(o.termsAt.map { ["text": "Autorizo a análise do item informado.", "accepted_at": $0] as Row }),
            "quote": nul(o.quote.map { items -> Row in
                ["items": items.map { $0.json }, "total_cents": total ?? 0, "note": o.quoteNote, "valid_days": o.quoteDays, "valid_until": nul(o.quoteValidUntil),
                 "sent_at": nul(o.quoteSentAt), "version": o.quoteVersion, "expired": (o.quoteValidUntil ?? Int64.max) <= now]
            }),
            "decision": nul(o.decision.map { ["decision": $0, "at": nul(o.decidedAt), "by": o.decidedVia == "whatsapp" ? "customer" : DemoMode.meId, "via": nul(o.decidedVia)] as Row }),
            "ready_at": nul(o.readyAt), "delivered_at": nul(o.deliveredAt), "warranty_until": nul(o.warrantyUntil), "next_statuses": next,
            "created_by": o.source == "whatsapp" ? "customer" : DemoMode.meId, "created": o.created, "updated": o.updated,
        ]
        if withHistory { row["history"] = o.history }
        return row
    }
}
