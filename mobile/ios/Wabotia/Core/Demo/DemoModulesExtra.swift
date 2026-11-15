import Foundation

private func ok(_ value: Any) -> DemoServer.Reply { DemoServer.Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
private func fail(_ status: Int, _ code: String, _ message: String) -> DemoServer.Reply {
    DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
}
private func nul(_ value: Any?) -> Any { value ?? NSNull() }

/// Idempotência das escritas: mesma chave e mesmo pedido devolvem a mesma resposta.
private final class Replays {
    private var replies: [String: DemoServer.Reply] = [:]
    func run(_ key: String?, _ path: [String], _ body: [String: Any], _ write: () -> DemoServer.Reply) -> DemoServer.Reply {
        guard let key, !key.isEmpty else { return fail(400, "idempotency_required", "Envie Idempotency-Key em toda escrita.") }
        let canonical = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let signature = "\(key)|\(path.joined(separator: "/"))|\(canonical)"
        if let replay = replies[signature] { return replay }
        if replies.keys.contains(where: { $0.hasPrefix("\(key)|") }) { return fail(409, "idempotency_conflict", "A mesma chave foi usada com outro pedido.") }
        let reply = write()
        if reply.status < 500 { replies[signature] = reply }
        return reply
    }
}

// MARK: - Reserva (pousada)

/// A Reserva da demonstração: uma pousada com três acomodações por diária e um salão por hora, reservas da semana (uma
/// aguardando o sinal, uma com check-in feito), um bloqueio de manutenção e as recusas do servidor (`unit_unavailable`,
/// `unit_blocked`, `outside_rules`, `booking_closed`).
final class DemoReserva {
    typealias Row = [String: Any]
    private struct Unit { let id, name, mode, kind: String; let capacity, price: Int }
    private final class B {
        let id: String, number: Int
        var unitId: String, start: String, end: String, starts: Int64, ends: Int64, guests: Int, minutes: Int?
        var status: String
        let conversationId: String?, name: String, phone: String
        var notes = "", price: Int, deposit: Int
        var paymentStatus: String?, paidAt: Int64?, dueAt: Int64?, confirmedAt: Int64?
        var checkin = "none", checkinAt: Int64?, answers: Row = [:]
        var cancelledAt: Int64?, reason = "", changes = 0
        let created: Int64
        var updated: Int64
        init(id: String, number: Int, unitId: String, start: String, end: String, starts: Int64, ends: Int64, guests: Int, minutes: Int?, status: String,
             conversationId: String?, name: String, phone: String, price: Int, deposit: Int, created: Int64) {
            self.id = id; self.number = number; self.unitId = unitId; self.start = start; self.end = end; self.starts = starts; self.ends = ends
            self.guests = guests; self.minutes = minutes; self.status = status; self.conversationId = conversationId; self.name = name; self.phone = phone
            self.price = price; self.deposit = deposit; self.created = created; self.updated = created
        }
    }

    private let units = [
        Unit(id: "u_mar", name: "Suíte Vista Mar", mode: "daily", kind: "room", capacity: 2, price: 45_000),
        Unit(id: "u_jardim", name: "Chalé Jardim", mode: "daily", kind: "room", capacity: 4, price: 38_000),
        Unit(id: "u_familia", name: "Suíte Família", mode: "daily", kind: "room", capacity: 5, price: 52_000),
        Unit(id: "u_salao", name: "Salão de eventos", mode: "hourly", kind: "space", capacity: 60, price: 15_000),
    ]
    private var bookings: [B] = []
    private var blocks: [(unit: String, from: String, to: String)] = []
    private let replays = Replays()
    private var seq = 0
    private static let checkinHour = 14, checkoutHour = 11

    init(t0: Int64) {
        let today = BrasiliaTime.day(t0)
        func d(_ n: Int) -> String { BrasiliaTime.addDays(today, n) }
        add("u_mar", d(0), d(3), 2, "confirmed", "c_rich", "Mariana Costa", "5520908765432", at: t0 - 6 * 86_400_000)
        add("u_jardim", d(1), d(4), 3, "pending_payment", "c_40", "Patrícia Nunes", "5520909887766", at: t0 - 3_600_000)
        add("u_familia", d(5), d(7), 5, "confirmed", nil, "Família Andrade", "5520907731234", at: t0 - 4 * 86_400_000)
        add("u_mar", d(6), d(8), 2, "confirmed", "c_5h", "João Pedro Almeida", "5520906543210", at: t0 - 2 * 86_400_000)
        add("u_jardim", d(-4), d(-1), 2, "completed", nil, "Rafael Torres", "5520907735678", at: t0 - 20 * 86_400_000)
        add("u_familia", d(2), d(4), 4, "cancelled", "c_other", "Eduardo Santos", "5520903334455", at: t0 - 5 * 86_400_000)
        if let dayStart = BrasiliaTime.range(from: d(2))?.from {
            seq += 1
            let starts = dayStart + 14 * 3_600_000
            bookings.append(B(id: "rs_\(seq)", number: seq, unitId: "u_salao", start: d(2), end: d(2), starts: starts, ends: starts + 4 * 3_600_000, guests: 40, minutes: 240,
                              status: "confirmed", conversationId: nil, name: "Aniversário da Lia", phone: "5520907739012", price: 60_000, deposit: 0, created: t0 - 86_400_000))
        }
        blocks.append((unit: "u_jardim", from: d(9), to: d(11)))
        let first = bookings[0]
        first.paymentStatus = "paid"; first.paidAt = t0 - 5 * 86_400_000; first.confirmedAt = first.paidAt
        first.checkin = "completed"; first.checkinAt = t0 - 3_600_000
        first.answers = ["documento": "RG 00.000.000-0", "chegada_prevista": "15h", "veiculo": "Não"]
        let pending = bookings[1]
        pending.paymentStatus = "created"; pending.dueAt = t0 + 20 * 3_600_000
        bookings[5].cancelledAt = t0 - 86_400_000; bookings[5].reason = "Cliente mudou a data da viagem."
    }

    private func add(_ unit: String, _ start: String, _ end: String, _ guests: Int, _ status: String, _ conversation: String?, _ name: String, _ phone: String, at: Int64) {
        seq += 1
        let u = units.first { $0.id == unit }!
        let nights = Self.nights(start, end)
        let starts = (BrasiliaTime.range(from: start)?.from ?? 0) + Int64(Self.checkinHour) * 3_600_000
        let ends = (BrasiliaTime.range(from: end)?.from ?? 0) + Int64(Self.checkoutHour) * 3_600_000
        bookings.append(B(id: "rs_\(seq)", number: seq, unitId: unit, start: start, end: end, starts: starts, ends: ends, guests: guests, minutes: nil, status: status,
                          conversationId: conversation, name: name, phone: phone, price: u.price * nights, deposit: u.price * nights * 30 / 100, created: at))
    }

    private static func nights(_ start: String, _ end: String) -> Int {
        guard let a = BrasiliaTime.range(from: start)?.from, let b = BrasiliaTime.range(from: end)?.from else { return 1 }
        return max(Int((b - a) / 86_400_000), 1)
    }

    func route(method: String, parts: [String], body: Row, query: [String: String], key: String?, now: Int64, emit: DemoEmit) -> DemoServer.Reply? {
        guard parts.count >= 5, parts[4] == "reserva" else { return nil }
        let r = Array(parts.dropFirst(5))
        if method == "GET" {
            if r.isEmpty { return ok(["config": ["deposit_type": "percent", "deposit_percent": 30], "units": units.map(unitRow), "deposit": ["available": true, "reason": NSNull(), "message": NSNull()]]) }
            if r == ["units"] { return ok(["data": units.map(unitRow)]) }
            if r == ["calendar"] { return calendar(query) }
            if r == ["availability"] { return availability(query, now) }
            if r == ["bookings"] {
                let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
                let q = (query["q"] ?? "").lowercased()
                let list = bookings.filter { b in
                    (statuses.isEmpty || statuses.contains(b.status)) && (q.isEmpty || b.name.lowercased().contains(q) || b.phone.contains(q) || String(b.number) == q)
                        && (query["conversation_id"].map { $0 == b.conversationId } ?? true)
                }.sorted { $0.starts < $1.starts }
                return ok(["data": list.map(row)])
            }
            if r.count == 2, r[0] == "bookings", let b = bookings.first(where: { $0.id == r[1] }) { return ok(row(b)) }
            return fail(404, "not_found", "Recurso não encontrado.")
        }
        return replays.run(key, r, body) { write(method, r, body, now, emit) }
    }

    private func conflict(_ unit: String, _ starts: Int64, _ ends: Int64, ignoring: String?) -> String? {
        let start = BrasiliaTime.day(starts), end = BrasiliaTime.day(ends)
        if blocks.contains(where: { $0.unit == unit && $0.from < end && $0.to > start }) { return "unit_blocked" }
        if bookings.contains(where: { $0.id != ignoring && $0.unitId == unit && ["pending_payment", "confirmed"].contains($0.status) && $0.starts < ends && $0.ends > starts }) { return "unit_unavailable" }
        return nil
    }

    private func period(_ unit: Unit, _ body: Row, fallback: B?) -> (start: String, end: String, starts: Int64, ends: Int64, minutes: Int?)? {
        if unit.mode == "hourly" {
            guard let starts = (body["starts"] as? NSNumber)?.int64Value ?? fallback?.starts else { return nil }
            let minutes = (body["duration_minutes"] as? NSNumber)?.intValue ?? fallback?.minutes ?? 60
            let day = BrasiliaTime.day(starts)
            return (day, day, starts, starts + Int64(minutes) * 60_000, minutes)
        }
        guard let start = body["start_date"] as? String ?? fallback?.start else { return nil }
        let nights = (body["nights"] as? NSNumber)?.intValue ?? (body["end_date"] as? String).map { Self.nights(start, $0) } ?? fallback.map { Self.nights($0.start, $0.end) } ?? 1
        let end = BrasiliaTime.addDays(start, nights)
        let starts = (BrasiliaTime.range(from: start)?.from ?? 0) + Int64(Self.checkinHour) * 3_600_000
        let ends = (BrasiliaTime.range(from: end)?.from ?? 0) + Int64(Self.checkoutHour) * 3_600_000
        return (start, end, starts, ends, nil)
    }

    private func write(_ method: String, _ r: [String], _ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        func event(_ kind: String, _ b: B, _ extra: Row = [:]) {
            var payload: Row = ["booking": row(b), "conversation_id": nul(b.conversationId), "actor": DemoMode.meId, "module_id": "reserva"]
            extra.forEach { payload[$0.key] = $0.value }
            emit(kind, payload)
        }
        if method == "POST", r == ["bookings"] {
            guard let unit = units.first(where: { $0.id == body["unit_id"] as? String }), let p = period(unit, body, fallback: nil) else { return fail(400, "invalid_request", "Informe a unidade e o período.") }
            if unit.mode == "daily", Self.nights(p.start, p.end) > 14 { return fail(409, "outside_rules", "A estadia máxima é de 14 diárias.") }
            let guests = (body["guests"] as? NSNumber)?.intValue ?? 1
            if guests > unit.capacity { return fail(409, "outside_rules", "\(unit.name) recebe até \(unit.capacity) pessoas.") }
            if let code = conflict(unit.id, p.starts, p.ends, ignoring: nil) { return fail(409, code, code == "unit_blocked" ? "Unidade bloqueada no período." : "Unidade ocupada no período.") }
            let conversation = body["conversation_id"] as? String
            let name = conversation.flatMap(DemoAgenda.conversationNames) ?? (body["customer_name"] as? String ?? "")
            guard !name.isEmpty else { return fail(400, "invalid_request", "Informe conversation_id ou customer_name.") }
            seq += 1
            let price = unit.mode == "hourly" ? unit.price * max((p.minutes ?? 60) / 60, 1) : unit.price * Self.nights(p.start, p.end)
            let deposit = body["deposit"] as? Bool == true ? price * 30 / 100 : 0
            let b = B(id: "rs_\(seq)", number: seq, unitId: unit.id, start: p.start, end: p.end, starts: p.starts, ends: p.ends, guests: guests, minutes: p.minutes,
                      status: deposit > 0 ? "pending_payment" : "confirmed", conversationId: conversation, name: name,
                      phone: conversation.flatMap(DemoAgenda.conversationPhones) ?? (body["customer_phone"] as? String ?? ""), price: price, deposit: deposit, created: now)
            b.notes = body["notes"] as? String ?? ""
            if deposit > 0 { b.paymentStatus = "created"; b.dueAt = now + 24 * 3_600_000 } else { b.confirmedAt = now }
            bookings.append(b)
            event("reserva.created", b)
            return ok(row(b))
        }
        guard r.count >= 2, r[0] == "bookings", let b = bookings.first(where: { $0.id == r[1] }) else { return fail(404, "not_found", "Reserva não encontrada.") }
        guard ["pending_payment", "confirmed"].contains(b.status) else { return fail(409, "booking_closed", "Esta reserva já foi encerrada.") }
        switch (method, Array(r.dropFirst(2))) {
        case ("PATCH", []):
            guard let unit = units.first(where: { $0.id == (body["unit_id"] as? String ?? b.unitId) }), let p = period(unit, body, fallback: b) else { return fail(400, "invalid_request", "Período inválido.") }
            if let code = conflict(unit.id, p.starts, p.ends, ignoring: b.id) { return fail(409, code, "Unidade indisponível no período.") }
            let previous = row(b)
            b.unitId = unit.id; b.start = p.start; b.end = p.end; b.starts = p.starts; b.ends = p.ends; b.minutes = p.minutes
            b.guests = (body["guests"] as? NSNumber)?.intValue ?? b.guests
            b.price = unit.mode == "hourly" ? unit.price * max((p.minutes ?? 60) / 60, 1) : unit.price * Self.nights(p.start, p.end)
            b.changes += 1; b.updated = now
            event("reserva.changed", b, ["previous": previous])
        case ("POST", ["cancel"]):
            b.status = "cancelled"; b.cancelledAt = now; b.reason = body["reason"] as? String ?? ""; b.updated = now
            event("reserva.cancelled", b, ["reason": b.reason])
        case ("POST", ["confirm"]):
            b.status = "confirmed"; b.confirmedAt = now; b.updated = now
            event("reserva.confirmed", b, ["by": "staff"])
        case ("POST", ["deposit"]):
            guard b.conversationId != nil else { return fail(409, "no_conversation", "Reserva sem conversa.") }
            b.paymentStatus = "created"; b.dueAt = now + 24 * 3_600_000; b.updated = now
        case ("POST", ["checkin"]):
            guard b.checkin != "completed" else { return fail(409, "checkin_done", "O cliente já fez o check-in.") }
            b.checkin = "sent"; b.updated = now
            event("reserva.checkin_sent", b)
        default:
            return fail(404, "not_found", "Recurso não encontrado.")
        }
        return ok(row(b))
    }

    private func calendar(_ query: [String: String]) -> DemoServer.Reply {
        let from = query["from_date"] ?? BrasiliaTime.today()
        let to = query["to_date"] ?? BrasiliaTime.addDays(from, 13)
        var days: [String] = []
        var d = from
        while d <= to, days.count < 93 { days.append(d); d = BrasiliaTime.addDays(d, 1) }
        guard let start = BrasiliaTime.range(from: from)?.from, let end = BrasiliaTime.range(from: to)?.to else { return fail(400, "invalid_request", "Datas inválidas.") }
        let visible = bookings.filter { ["pending_payment", "confirmed", "completed"].contains($0.status) && $0.starts < end && $0.ends > start }
        let rows: [Row] = units.filter { query["unit_id"] == nil || $0.id == query["unit_id"] }.map { u in
            ["unit_id": u.id, "name": u.name, "mode": u.mode, "active": true, "cells": days.map { day -> Row in
                let here = visible.filter { b in
                    b.unitId == u.id && (u.mode == "hourly" ? b.start == day : (b.start <= day && b.end > day))
                }
                let blocked = blocks.contains { $0.unit == u.id && $0.from <= day && $0.to > day }
                let state = blocked ? "blocked" : (here.isEmpty ? "free" : (u.mode == "daily" ? here[0].status : "partial"))
                return ["date": day, "state": state, "booking_ids": here.map(\.id), "block_ids": blocked ? ["blk_\(u.id)"] : [String]()]
            }]
        }
        return ok(["from_date": from, "to_date": to, "days": days, "units": rows, "bookings": visible.map(row)])
    }

    private func availability(_ query: [String: String], _ now: Int64) -> DemoServer.Reply {
        if let date = query["date"] {
            let minutes = Int(query["duration_minutes"] ?? "") ?? 60
            guard let dayStart = BrasiliaTime.range(from: date)?.from else { return fail(400, "invalid_request", "Dia inválido.") }
            let options: [Row] = units.filter { $0.mode == "hourly" && (query["unit_id"] == nil || $0.id == query["unit_id"]) }.map { u in
                var slots: [Row] = []
                var hour = 8
                while hour * 60 + minutes <= 22 * 60 {
                    let starts = dayStart + Int64(hour) * 3_600_000
                    if starts > now, conflict(u.id, starts, starts + Int64(minutes) * 60_000, ignoring: nil) == nil {
                        slots.append(["starts": starts, "ends": starts + Int64(minutes) * 60_000, "time": BrasiliaTime.clock(starts), "price_cents": u.price * max(minutes / 60, 1)])
                    }
                    hour += 1
                }
                return ["unit_id": u.id, "name": u.name, "capacity": u.capacity, "price_cents": u.price, "slots": slots]
            }
            return ok(["date": date, "duration_minutes": minutes, "units": options])
        }
        let start = query["start_date"] ?? BrasiliaTime.today()
        let nights = Int(query["nights"] ?? "") ?? 1
        let guests = Int(query["guests"] ?? "") ?? 1
        let end = BrasiliaTime.addDays(start, nights)
        let starts = (BrasiliaTime.range(from: start)?.from ?? 0) + Int64(Self.checkinHour) * 3_600_000
        let ends = (BrasiliaTime.range(from: end)?.from ?? 0) + Int64(Self.checkoutHour) * 3_600_000
        let options: [Row] = units.filter { $0.mode == "daily" }.map { u in
            var reason: String? = conflict(u.id, starts, ends, ignoring: nil)
            if reason == nil, guests > u.capacity { reason = "outside_rules" }
            if reason == nil, nights > 14 { reason = "outside_rules" }
            let message: Any = reason.map { code -> String in
                switch code {
                case "unit_blocked": return "Em manutenção no período."
                case "unit_unavailable": return "Já reservada no período."
                default: return guests > u.capacity ? "Recebe até \(u.capacity) pessoas." : "A estadia máxima é de 14 diárias."
                }
            } ?? NSNull()
            return ["unit_id": u.id, "name": u.name, "capacity": u.capacity, "available": reason == nil, "reason": nul(reason), "message": message,
                    "price_cents": u.price * nights, "deposit_cents": u.price * nights * 30 / 100, "nights": nights]
        }
        return ok(["start_date": start, "end_date": end, "units": options])
    }

    private func unitRow(_ u: Unit) -> Row {
        ["id": u.id, "name": u.name, "mode": u.mode, "kind": u.kind, "capacity": u.capacity, "price_cents": u.price, "description": "", "photos": [String](), "active": true,
         "position": units.firstIndex { $0.id == u.id } ?? 0]
    }

    private func row(_ b: B) -> Row {
        let unit = units.first { $0.id == b.unitId }
        return [
            "id": b.id, "number": b.number, "unit_id": b.unitId, "unit_name": nul(unit?.name), "mode": nul(unit?.mode), "start_date": b.start, "end_date": b.end,
            "starts": b.starts, "ends": b.ends, "arrival_at": b.starts, "departure_at": b.ends,
            "arrival_time": unit?.mode == "daily" ? String(format: "%02d:00", Self.checkinHour) : BrasiliaTime.clock(b.starts),
            "departure_time": unit?.mode == "daily" ? String(format: "%02d:00", Self.checkoutHour) : BrasiliaTime.clock(b.ends),
            "nights": unit?.mode == "daily" ? Self.nights(b.start, b.end) : NSNull(), "duration_minutes": nul(b.minutes), "guests": b.guests, "status": b.status,
            "conversation_id": nul(b.conversationId), "contact_id": NSNull(), "customer_name": b.name, "customer_phone": b.phone, "notes": b.notes,
            "source": b.conversationId == nil ? "panel" : "whatsapp", "price_cents": b.price, "deposit_cents": b.deposit, "payment_id": b.paymentStatus == nil ? NSNull() : "pay_\(b.id)",
            "payment_status": nul(b.paymentStatus), "payment_error": NSNull(), "payment_due_at": nul(b.dueAt), "paid_at": nul(b.paidAt), "confirmed_at": nul(b.confirmedAt),
            "confirmed_by": NSNull(), "checkin_status": b.checkin, "checkin_step_id": NSNull(), "checkin_sent_at": NSNull(), "checkin_at": nul(b.checkinAt),
            "checkin_answers": b.answers, "reminded_at": NSNull(), "checkout_sent_at": NSNull(), "cancelled_at": nul(b.cancelledAt), "cancelled_by": NSNull(),
            "cancel_reason": b.reason, "changes": b.changes, "created_by": DemoMode.meId, "created": b.created, "updated": b.updated,
        ]
    }
}

// MARK: - Mensalidade (escola de idiomas)

/// A Mensalidade da demonstração: uma escola de idiomas com três planos e oito alunos, parcelas do mês e do mês
/// anterior (pagas, em aberto, vencidas, isenta), uma assinatura pausada e uma encerrada.
final class DemoMensalidade {
    typealias Row = [String: Any]
    private final class S {
        let id, plan, name, phone: String
        let amount, discount, dueDay: Int
        var status: String
        let conversationId: String?
        init(_ id: String, _ plan: String, _ name: String, _ phone: String, _ amount: Int, _ discount: Int, _ dueDay: Int, _ status: String, _ conversation: String?) {
            self.id = id; self.plan = plan; self.name = name; self.phone = phone; self.amount = amount; self.discount = discount; self.dueDay = dueDay
            self.status = status; self.conversationId = conversation
        }
    }
    private final class I {
        let id, subscriptionId, period, due: String
        let amount: Int
        var status: String
        var paidAt: Int64?, paidVia: String?, paidNote = "", waivedAt: Int64?, chargedAt: Int64?, overdueNotices = 0
        init(_ id: String, _ sub: String, _ period: String, _ due: String, _ amount: Int, _ status: String) {
            self.id = id; self.subscriptionId = sub; self.period = period; self.due = due; self.amount = amount; self.status = status
        }
    }

    private let plans = ["pl_ingles": ("Inglês", 32_000), "pl_espanhol": ("Espanhol", 28_000), "pl_conversa": ("Conversação", 18_000)]
    private var subs: [S] = []
    private var items: [I] = []
    private let replays = Replays()

    init(t0: Int64) {
        let month = String(BrasiliaTime.day(t0).prefix(7)), previous = MensalidadeRules.shiftMonth(month, -1)
        subs = [
            S("ms_1", "pl_ingles", "Mariana Costa", "5520908765432", 32_000, 0, 10, "active", "c_rich"),
            S("ms_2", "pl_ingles", "Gabriel Nogueira", "5520907741111", 32_000, 3_200, 10, "active", nil),
            S("ms_3", "pl_espanhol", "Patrícia Nunes", "5520909887766", 28_000, 0, 5, "active", "c_40"),
            S("ms_4", "pl_conversa", "Lucas Martins", "5520908876655", 18_000, 0, 15, "active", "c_queue2"),
            S("ms_5", "pl_espanhol", "Helena Prado", "5520907742222", 28_000, 0, 10, "active", nil),
            S("ms_6", "pl_ingles", "João Pedro Almeida", "5520906543210", 32_000, 0, 20, "active", "c_5h"),
            S("ms_7", "pl_conversa", "Sofia Ramos", "5520907743333", 18_000, 0, 10, "paused", nil),
            S("ms_8", "pl_espanhol", "Bruna Teles", "5520907744444", 28_000, 0, 10, "ended", nil),
        ]
        // (assinatura, estado no mês anterior, estado no mês atual)
        let plan: [(String, String, String)] = [
            ("ms_1", "paid", "paid"), ("ms_2", "paid", "open"), ("ms_3", "overdue", "overdue"), ("ms_4", "paid", "open"),
            ("ms_5", "paid", "paid"), ("ms_6", "paid", "overdue"), ("ms_7", "waived", "cancelled"), ("ms_8", "paid", "cancelled"),
        ]
        var n = 0
        for (id, before, now) in plan {
            guard let s = subs.first(where: { $0.id == id }) else { continue }
            for (period, status) in [(previous, before), (month, now)] {
                n += 1
                let i = I("mi_\(n)", s.id, period, "\(period)-\(String(format: "%02d", s.dueDay))", s.amount - s.discount, status)
                if status == "paid" { i.paidAt = t0 - Int64(n) * 3_600_000 * 7; i.paidVia = n % 3 == 0 ? "manual" : "pix" }
                if status == "waived" { i.waivedAt = t0 - 20 * 86_400_000; i.paidNote = "Bolsa por desempenho." }
                if status == "overdue" { i.overdueNotices = 2; i.chargedAt = t0 - 5 * 86_400_000 }
                if status == "open" { i.chargedAt = t0 - 86_400_000 }
                items.append(i)
            }
        }
    }

    func route(method: String, parts: [String], body: Row, query: [String: String], key: String?, now: Int64, emit: DemoEmit) -> DemoServer.Reply? {
        guard parts.count >= 5, parts[4] == "mensalidade" else { return nil }
        let r = Array(parts.dropFirst(5))
        if method == "GET" {
            switch r.first {
            case "summary": return summary(query["month"] ?? String(BrasiliaTime.day(now).prefix(7)))
            case "plans": return ok(["data": plans.map { ["id": $0.key, "name": $0.value.0, "amount_cents": $0.value.1, "period": "monthly", "due_day": 10, "active": true] }])
            case "delinquents": return delinquents()
            case "payers" where r.count == 2: return payerDetail(r[1])
            case "installments":
                if r.count == 2, let i = items.first(where: { $0.id == r[1] }) { return ok(row(i)) }
                let month = query["month"] ?? String(BrasiliaTime.day(now).prefix(7))
                let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
                let q = (query["q"] ?? "").lowercased()
                let list = items.filter { i in
                    let s = sub(i.subscriptionId)
                    return i.period == month && (statuses.isEmpty || statuses.contains(i.status)) && (query["subscription_id"].map { $0 == i.subscriptionId } ?? true)
                        && (q.isEmpty || (s?.name.lowercased().contains(q) ?? false) || (s?.phone.contains(q) ?? false))
                }.sorted { ($0.due, sub($0.subscriptionId)?.name ?? "") < ($1.due, sub($1.subscriptionId)?.name ?? "") }
                var counts: [String: Int] = [:]
                for i in items where i.period == month { counts[i.status, default: 0] += 1 }
                return ok(["month": month, "data": list.map(row), "next_cursor": NSNull(), "counts": counts])
            case "subscriptions":
                if r.count == 2, let s = sub(r[1]) { return ok(subRow(s, withInstallments: true)) }
                let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
                let q = (query["q"] ?? "").lowercased()
                let list = subs.filter { (statuses.isEmpty || statuses.contains($0.status)) && (q.isEmpty || $0.name.lowercased().contains(q) || $0.phone.contains(q)) }
                var counts: [String: Int] = [:]
                for s in subs { counts[s.status, default: 0] += 1 }
                return ok(["data": list.map { subRow($0, withInstallments: false) }, "next_cursor": NSNull(), "counts": counts])
            default: return fail(404, "not_found", "Recurso não encontrado.")
            }
        }
        return replays.run(key, r, body) { write(r, body, now, emit) }
    }

    private func write(_ r: [String], _ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        if r.count == 3, r[0] == "installments", let i = items.first(where: { $0.id == r[1] }) {
            guard ["open", "overdue"].contains(i.status) else { return fail(409, "installment_not_payable", "Parcela não pode ser cobrada.") }
            switch r[2] {
            case "charge":
                guard sub(i.subscriptionId)?.conversationId != nil else { return fail(409, "no_conversation", "Sem conversa com o cliente.") }
                i.chargedAt = now
                emit("mensalidade.charged", ["installment": row(i), "module_id": "mensalidade"])
            case "pay":
                i.status = "paid"; i.paidAt = now; i.paidVia = "manual"; i.paidNote = body["note"] as? String ?? ""
                emit("mensalidade.paid", ["installment": row(i), "via": "manual", "by": DemoMode.meId, "module_id": "mensalidade"])
            case "waive":
                i.status = "waived"; i.waivedAt = now; i.paidNote = body["note"] as? String ?? ""
                emit("mensalidade.waived", ["installment": row(i), "module_id": "mensalidade"])
            default: return fail(404, "not_found", "Recurso não encontrado.")
            }
            return ok(row(i))
        }
        if r.count == 3, r[0] == "subscriptions", let s = sub(r[1]) {
            switch r[2] {
            case "pause": guard s.status == "active" else { return fail(409, "invalid_transition", "Só assinatura ativa pausa.") }; s.status = "paused"
            case "resume": guard s.status == "paused" else { return fail(409, "invalid_transition", "Só assinatura pausada retoma.") }; s.status = "active"
            case "end": guard s.status != "ended" else { return fail(409, "invalid_transition", "Assinatura já encerrada.") }; s.status = "ended"
            default: return fail(404, "not_found", "Recurso não encontrado.")
            }
            if r[2] != "resume" { for i in items where i.subscriptionId == s.id && i.status == "open" { i.status = "cancelled" } }
            emit("mensalidade.subscription_changed", ["subscription": subRow(s, withInstallments: false), "change": r[2] == "end" ? "ended" : (r[2] == "pause" ? "paused" : "resumed"), "module_id": "mensalidade"])
            return ok(subRow(s, withInstallments: false))
        }
        return fail(404, "not_found", "Recurso não encontrado.")
    }

    private func sub(_ id: String) -> S? { subs.first { $0.id == id } }

    private func summary(_ month: String) -> DemoServer.Reply {
        let monthItems = items.filter { $0.period == month }
        func sum(_ statuses: Set<String>) -> Int { monthItems.filter { statuses.contains($0.status) }.reduce(0) { $0 + $1.amount } }
        var counts: [String: Int] = ["open": 0, "paid": 0, "overdue": 0, "cancelled": 0, "waived": 0]
        for i in monthItems { counts[i.status, default: 0] += 1 }
        let overdue = items.filter { $0.status == "overdue" }
        return ok(["month": month, "expected_cents": sum(["open", "paid", "overdue"]), "received_cents": sum(["paid"]), "overdue_cents": sum(["overdue"]),
                   "open_cents": sum(["open"]), "waived_cents": sum(["waived"]), "counts": counts,
                   "received_in_month": ["count": counts["paid"] ?? 0, "cents": sum(["paid"])],
                   "overdue_total": ["count": overdue.count, "cents": overdue.reduce(0) { $0 + $1.amount }, "subscriptions": Set(overdue.map(\.subscriptionId)).count],
                   "payments_ready": true])
    }

    private func delinquents() -> DemoServer.Reply {
        let grouped = Dictionary(grouping: items.filter { $0.status == "overdue" }, by: \.subscriptionId)
        let rows: [Row] = grouped.compactMap { id, list in
            guard let s = sub(id) else { return nil }
            return ["subscription_id": id, "customer": customer(s), "plan_name": plans[s.plan]?.0 ?? "", "subscription_status": s.status, "overdue_count": list.count,
                    "overdue_cents": list.reduce(0) { $0 + $1.amount }, "oldest_due_date": list.map(\.due).min() ?? "", "notices_sent": list.map(\.overdueNotices).max() ?? 0]
        }.sorted { ($0["oldest_due_date"] as? String ?? "") < ($1["oldest_due_date"] as? String ?? "") }
        return ok(["data": rows])
    }

    private func customer(_ s: S) -> Row { ["name": s.name, "phone": s.phone, "contact_id": NSNull(), "conversation_id": nul(s.conversationId)] }

    private func row(_ i: I) -> Row {
        let s = sub(i.subscriptionId)
        let parts = i.period.split(separator: "-")
        let names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
        let label = parts.count == 2 ? "\(names[(Int(parts[1]) ?? 1) - 1])/\(parts[0])" : i.period
        return [
            "id": i.id, "subscription_id": i.subscriptionId, "period_key": i.period, "period_label": label, "due_date": i.due, "amount_cents": i.amount,
            "status": i.status, "status_label": MensalidadeRules.statusLabel(i.status), "customer": s.map(customer) ?? [:], "plan_name": nul(s.flatMap { plans[$0.plan]?.0 }),
            "payment": i.chargedAt.map { ["id": "pay_\(i.id)", "status": i.status == "paid" ? "paid" : "created", "expires_at": $0 + 3 * 86_400_000, "pix_code": "demo", "url": "https://pagamento.example/\(i.id)", "charged_at": $0] as Row } ?? NSNull(),
            "notices": ["before_at": NSNull(), "due_at": NSNull(), "overdue": i.overdueNotices, "overdue_at": NSNull(), "error": NSNull()],
            "paid_at": nul(i.paidAt), "paid_via": nul(i.paidVia), "paid_by": i.paidVia == "manual" ? DemoMode.meId : NSNull(), "paid_note": i.paidNote,
            "waived_at": nul(i.waivedAt), "waived_by": NSNull(), "cancelled_at": NSNull(), "created": 0, "updated": 0,
        ]
    }

    private func subRow(_ s: S, withInstallments: Bool) -> Row {
        let mine = items.filter { $0.subscriptionId == s.id }
        var out: Row = [
            "id": s.id, "plan_id": s.plan, "plan_name": plans[s.plan]?.0 ?? "", "customer": customer(s), "period": "monthly", "period_label": "Mensal",
            "amount_cents": s.amount, "discount_cents": s.discount, "charge_cents": s.amount - s.discount, "due_day": s.dueDay, "start_date": "2026-02-01",
            "end_date": s.status == "ended" ? "2026-11-01" : NSNull(), "status": s.status, "status_label": MensalidadeRules.subscriptionLabel(s.status), "notes": "",
            "open_count": mine.filter { $0.status == "open" }.count, "overdue_count": mine.filter { $0.status == "overdue" }.count,
            "overdue_cents": mine.filter { $0.status == "overdue" }.reduce(0) { $0 + $1.amount },
        ]
        if withInstallments { out["installments"] = mine.sorted { $0.due > $1.due }.map(row) }
        let p = payer(s)
        out["payer"] = ["id": p.id, "name": p.name, "document_display": p.document]
        return out
    }

    // Pagadores: quem paga, com CPF/CNPJ e telefones autorizados. O João Pedro é aluno; quem paga é o pai, e o telefone
    // da mãe também está autorizado. A Patrícia estuda pela empresa (CNPJ).
    private func payer(_ s: S) -> (id: String, name: String, document: String, type: String, phones: [(String, String)]) {
        switch s.id {
        case "ms_6": return ("py_almeida", "Ricardo Almeida", "123.456.789-09", "cpf", [(s.phone, "Aluno"), ("5520906540000", "Cadastro"), ("5520906541111", "Vinculado pelo atendimento")])
        case "ms_3": return ("py_nunes", "Nunes Consultoria LTDA", "12.345.678/0001-95", "cnpj", [("5520909880000", "Cadastro"), (s.phone, "Vinculado pelo atendimento")])
        default: return ("py_\(s.id)", s.name, "987.654.321-00", "cpf", [(s.phone, "Cadastro")])
        }
    }

    private func payerDetail(_ id: String) -> DemoServer.Reply {
        guard let s = subs.first(where: { payer($0).id == id }) else { return fail(404, "not_found", "Pagador não encontrado.") }
        let p = payer(s)
        let digits = p.document.filter { $0.isNumber || $0.isLetter }
        return ok(["id": p.id, "name": p.name, "document": digits, "document_type": p.type, "document_display": p.document, "email": NSNull(), "notes": "",
                   "phones": p.phones.map { ["phone": $0.0, "label": $0.1, "created_by": "panel", "created": 0] as Row },
                   "subscriptions": subs.filter { payer($0).id == id }.map { subRow($0, withInstallments: false) }])
    }
}
