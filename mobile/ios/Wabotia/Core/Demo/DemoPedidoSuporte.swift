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

// MARK: - Pedido (lanchonete)

/// O Pedido da demonstração: a Lanchonete da Ana, com cardápio (lanches, açaí e bebidas; o Misto quente e o Cheddar
/// esgotados), pedidos em todos os estados — dois atrasados no quadro, um com o mesmo X-Burger em duas montagens, um
/// esperando o cliente escolher como pagar — e a comanda em texto como o servidor monta.
final class DemoPedido {
    typealias Row = [String: Any]

    private final class O {
        let id: String, number: Int
        var status: String, statusAt: Int64
        let name: String, phone: String, conversationId: String?
        let delivery: Bool
        var method: String?, payment: String
        let lines: [Row]
        let note: String
        var cancelReason: String?
        var paidAt: Int64?
        var history: [Row] = []
        let created: Int64
        init(_ number: Int, _ status: String, minutes: Int64, _ name: String, _ phone: String, conversation: String? = nil, delivery: Bool, method: String?, payment: String, lines: [Row], note: String = "", t0: Int64) {
            id = "pd_\(number)"; self.number = number; self.status = status; statusAt = t0 - minutes * 60_000
            self.name = name; self.phone = phone; conversationId = conversation; self.delivery = delivery
            self.method = method; self.payment = payment; self.lines = lines; self.note = note
            created = statusAt - 5 * 60_000
            history = [["id": "h\(number)a", "kind": "created", "from_status": NSNull(), "to_status": "awaiting_payment", "actor": "customer", "note": "Carrinho concluído pelo WhatsApp.", "created": created]]
            if status != "awaiting_payment" {
                history.append(["id": "h\(number)b", "kind": "status", "from_status": "awaiting_payment", "to_status": status, "actor": payment == "paid" ? "provider" : "system", "note": NSNull(), "created": statusAt])
            }
        }
        var subtotal: Int { lines.reduce(0) { $0 + ($1["total_cents"] as? Int ?? 0) } }
        var fee: Int { delivery ? 700 : 0 }
    }

    private static let labels: [String: String] = ["awaiting_payment": "Aguardando pagamento", "received": "Recebido", "preparing": "Em preparo", "ready": "Pronto para retirada",
                                                   "out_for_delivery": "Saiu para entrega", "delivered": "Entregue", "cancelled": "Cancelado"]
    private static let methodLabels = ["pix": "Pix", "link": "Cartão pelo link de pagamento", "cash": "Dinheiro na entrega ou retirada", "card": "Cartão na maquininha"]
    private static let alerts: [String: Int64] = ["received": 10, "preparing": 40, "ready": 60, "out_for_delivery": 90]

    private var orders: [O] = []
    private var categories: [Row] = []
    private var groups: [Row] = []
    private var paused = false
    private var pauseMessage = ""
    private let replays = Replays()

    init(t0: Int64) {
        func item(_ id: String, _ cat: String, _ name: String, _ price: Int, _ position: Int, _ description: String = "", groups: [String] = [], available: Bool = true) -> Row {
            ["id": id, "category_id": cat, "name": name, "description": description, "price_cents": price, "photo_media_id": NSNull(), "image_url": NSNull(),
             "available": available, "max_quantity": 20, "retailer_id": NSNull(), "position": position, "group_ids": groups, "created": t0, "updated": t0]
        }
        categories = [
            ["id": "lanches", "name": "Lanches", "description": "Pão brioche e carne de 150 g", "position": 0, "items": [
                item("xburger", "lanches", "X-Burger", 2500, 0, "Carne, queijo e molho da casa", groups: ["ponto", "adicionais"]),
                item("xsalada", "lanches", "X-Salada", 2700, 1, "Carne, queijo, alface e tomate", groups: ["ponto", "adicionais"]),
                item("misto", "lanches", "Misto quente", 1200, 2, available: false),
            ]],
            ["id": "acai", "name": "Açaí", "description": "", "position": 1, "items": [item("acai", "acai", "Açaí na tigela", 1800, 0, "Com granola e banana", groups: ["tamanho"])]],
            ["id": "bebidas", "name": "Bebidas", "description": "", "position": 2, "items": [item("suco", "bebidas", "Suco de laranja", 800, 0), item("refri", "bebidas", "Refrigerante lata", 600, 1)]],
        ]
        groups = [
            ["id": "ponto", "name": "Ponto da carne", "min": 1, "max": 1, "options": [
                ["id": "mal", "name": "Mal passada", "price_cents": 0, "available": true], ["id": "ao-ponto", "name": "Ao ponto", "price_cents": 0, "available": true],
                ["id": "bem", "name": "Bem passada", "price_cents": 0, "available": true]]],
            ["id": "adicionais", "name": "Adicionais", "min": 0, "max": 3, "options": [
                ["id": "bacon", "name": "Bacon", "price_cents": 500, "available": true], ["id": "ovo", "name": "Ovo", "price_cents": 300, "available": true],
                ["id": "cheddar", "name": "Cheddar", "price_cents": 400, "available": false]]],
            ["id": "tamanho", "name": "Tamanho do açaí", "min": 1, "max": 1, "options": [
                ["id": "300", "name": "300 ml", "price_cents": 0, "available": true], ["id": "500", "name": "500 ml", "price_cents": 600, "available": true]]],
        ]
        func line(_ item: String, _ name: String, _ qty: Int, _ unit: Int, _ options: [(String, String, Int)] = [], note: String = "", slot: Int = 0) -> Row {
            let each = unit + options.reduce(0) { $0 + $1.2 }
            return ["item_id": item, "slot": slot, "name": name, "quantity": qty, "unit_cents": each,
                    "options": options.map { ["group_id": $0.0, "group": $0.0 == "ponto" ? "Ponto da carne" : ($0.0 == "tamanho" ? "Tamanho" : "Adicionais"), "id": $0.1.lowercased(), "name": $0.1, "price_cents": $0.2] as Row },
                    "note": note, "total_cents": each * qty]
        }
        orders = [
            O(46, "awaiting_payment", minutes: 1, "Sofia Ramos", "5520907743333", delivery: false, method: nil, payment: "choosing",
              lines: [line("xsalada", "X-Salada", 1, 2700, [("ponto", "Ao ponto", 0)]), line("refri", "Refrigerante lata", 1, 600)], t0: t0),
            O(45, "awaiting_payment", minutes: 4, "Rafael Souza", "5520907745555", delivery: true, method: "pix", payment: "awaiting",
              lines: [line("acai", "Açaí na tigela", 2, 1800, [("tamanho", "500 ml", 600)])], t0: t0),
            O(44, "received", minutes: 3, "Bianca Lopes", "5520907746666", delivery: false, method: "cash", payment: "pending",
              lines: [line("xburger", "X-Burger", 1, 2500, [("ponto", "Ao ponto", 0), ("adicionais", "Bacon", 500)], note: "sem cebola"),
                      line("xburger", "X-Burger", 1, 2500, [("ponto", "Bem passada", 0)], slot: 1), line("refri", "Refrigerante lata", 2, 600)],
              note: "Troco para R$ 100", t0: t0),
            O(43, "received", minutes: 12, "Carlos Mendes", "5520907747777", delivery: true, method: "card", payment: "pending",
              lines: [line("xsalada", "X-Salada", 2, 2700, [("ponto", "Mal passada", 0), ("adicionais", "Ovo", 300)])], t0: t0),
            O(42, "preparing", minutes: 18, "Mariana Costa", "5520908765432", conversation: "c_rich", delivery: true, method: "pix", payment: "paid",
              lines: [line("acai", "Açaí na tigela", 1, 1800, [("tamanho", "500 ml", 600)], note: "sem banana"), line("suco", "Suco de laranja", 1, 800)], t0: t0),
            O(41, "preparing", minutes: 44, "Fernanda Rocha", "5520901122334", delivery: false, method: "link", payment: "paid",
              lines: [line("xburger", "X-Burger", 3, 2500, [("ponto", "Ao ponto", 0)])], t0: t0),
            O(40, "ready", minutes: 6, "Lucas Martins", "5520908876655", delivery: false, method: "cash", payment: "pending",
              lines: [line("misto", "Misto quente", 2, 1200), line("suco", "Suco de laranja", 2, 800)], t0: t0),
            O(39, "out_for_delivery", minutes: 22, "Patrícia Nunes", "5520909887766", delivery: true, method: "pix", payment: "paid",
              lines: [line("xburger", "X-Burger", 1, 2500, [("ponto", "Bem passada", 0), ("adicionais", "Bacon", 500), ("adicionais", "Ovo", 300)])], t0: t0),
            O(38, "delivered", minutes: 70, "Helena Prado", "5520907742222", delivery: false, method: "card", payment: "paid",
              lines: [line("acai", "Açaí na tigela", 1, 1800, [("tamanho", "300 ml", 0)])], t0: t0),
            O(37, "cancelled", minutes: 95, "Gabriel Nogueira", "5520907741111", delivery: true, method: "pix", payment: "cancelled",
              lines: [line("xsalada", "X-Salada", 1, 2700, [("ponto", "Ao ponto", 0)])], t0: t0),
        ]
        orders.first { $0.number == 37 }?.cancelReason = "Cliente desistiu pelo WhatsApp."
        for o in orders where o.payment == "paid" { o.paidAt = o.statusAt }
    }

    func route(method: String, parts: [String], body: Row, query: [String: String], key: String?, now: Int64, emit: DemoEmit) -> DemoServer.Reply? {
        guard parts.count >= 5, parts[4] == "pedido" else { return nil }
        let r = Array(parts.dropFirst(5))
        if method == "GET" {
            switch (r.first, r.count) {
            case (nil, _): return ok(["store": store(now), "menu": ["categories": categories.count, "items": 7, "available_items": 6]])
            case ("board", _): return board(now)
            case ("menu", _): return ok(["categories": categories, "groups": groups, "images": [Row]()])
            case ("orders", 1): return list(query, now)
            case ("orders", 2): return order(r[1]).map { ok(row($0, now, history: true)) } ?? fail(404, "not_found", "Pedido não encontrado.")
            case ("orders", 3) where r[2] == "ticket":
                guard let o = order(r[1]) else { return fail(404, "not_found", "Pedido não encontrado.") }
                let columns = Int(query["columns"] ?? "32") ?? 32
                guard [32, 42, 48].contains(columns) else { return fail(400, "invalid_request", "columns: 32, 42 ou 48.") }
                return ok(["columns": columns, "order": row(o, now, history: false), "text": ticket(o, columns, now)])
            default: return fail(404, "not_found", "Recurso não encontrado.")
            }
        }
        return replays.run(key, r, body) { write(r, body, now, emit) }
    }

    private func order(_ id: String) -> O? { orders.first { $0.id == id } }

    private func store(_ now: Int64) -> Row {
        ["open": !paused, "reason": paused ? "paused" : "open", "paused": paused, "pause_message": pauseMessage,
         "message": paused ? (["Estamos com a loja pausada agora.", pauseMessage].filter { !$0.isEmpty }.joined(separator: "\n\n")) : "",
         "hours_text": "Todos os dias, das 11:00 às 23:30"]
    }

    private func next(_ o: O) -> [String] {
        let done = o.delivery ? "out_for_delivery" : "ready"
        switch o.status {
        case "awaiting_payment": return ["received", "cancelled"]
        case "received": return ["preparing", done, "cancelled"]
        case "preparing": return [done, "received", "cancelled"]
        case "ready", "out_for_delivery": return ["delivered", "preparing", "cancelled"]
        default: return []
        }
    }

    private func row(_ o: O, _ now: Int64, history: Bool) -> Row {
        let minutes = max(0, (now - o.statusAt) / 60_000)
        let alert = Self.alerts[o.status] ?? 0
        let paymentLabel: String = {
            switch o.payment {
            case "pending": return o.delivery ? "Pagar na entrega" : "Pagar na retirada"
            case "choosing": return "Cliente escolhendo a forma de pagamento"
            case "awaiting": return "Aguardando pagamento online"
            case "paid": return "Pago"
            case "cancelled": return "Cobrança cancelada"
            default: return o.payment
            }
        }()
        var out: Row = [
            "id": o.id, "number": o.number, "status": o.status, "status_label": Self.labels[o.status] ?? o.status, "status_at": o.statusAt,
            "customer": ["name": o.name, "phone": o.phone, "contact_id": NSNull(), "conversation_id": nul(o.conversationId)],
            "source": "cart", "fulfillment": o.delivery ? "delivery" : "pickup", "fulfillment_label": o.delivery ? "Entrega" : "Retirada",
            "address": o.delivery ? ["street": "Rua das Acácias, 245", "district": "Jardim Primavera", "complement": "Casa 2", "reference": "portão verde"] as Any : NSNull(),
            "address_text": o.delivery ? "Rua das Acácias, 245 - Jardim Primavera, Casa 2 (portão verde)" : "",
            "lines": o.lines, "item_count": o.lines.reduce(0) { $0 + ($1["quantity"] as? Int ?? 0) },
            "subtotal_cents": o.subtotal, "delivery_fee_cents": o.fee, "total_cents": o.subtotal + o.fee,
            "note": o.note, "notes": o.number == 43 ? "Cliente pediu para caprichar no ovo." : "",
            "eta_minutes": o.delivery ? 45 : 20, "eta_at": o.status == "awaiting_payment" ? NSNull() as Any : o.statusAt + (o.delivery ? 45 : 20) * 60_000,
            "payment": ["method": nul(o.method), "method_label": nul(o.method.flatMap { Self.methodLabels[$0] }), "online": o.method == "pix" || o.method == "link",
                        "status": o.payment, "status_label": paymentLabel, "payment_id": NSNull(), "due_at": o.payment == "awaiting" ? o.statusAt + 30 * 60_000 : NSNull() as Any,
                        "paid_at": nul(o.paidAt), "paid_by": NSNull(), "error": NSNull(), "change_for_cents": o.number == 44 ? 10_000 : NSNull() as Any, "needs_refund": false],
            "next_statuses": next(o), "cancel_reason": nul(o.cancelReason), "cancelled_by": NSNull(),
            "created": o.created, "updated": o.statusAt,
            "minutes_in_status": minutes, "late": alert > 0 && minutes >= alert,
        ]
        if history { out["history"] = o.history }
        return out
    }

    private func board(_ now: Int64) -> DemoServer.Reply {
        let active = ["awaiting_payment", "received", "preparing", "ready", "out_for_delivery"]
        let delivered = orders.filter { $0.status == "delivered" }.count
        return ok([
            "generated_at": now, "store": store(now),
            "columns": active.map { status in
                ["status": status, "label": Self.labels[status] ?? status,
                 "orders": orders.filter { $0.status == status }.sorted { $0.statusAt < $1.statusAt }.map { row($0, now, history: false) }] as Row
            },
            "today": ["since": now - 12 * 3_600_000, "orders": orders.count, "delivered": delivered, "cancelled": orders.filter { $0.status == "cancelled" }.count,
                      "total_cents": orders.filter { $0.status != "cancelled" }.reduce(0) { $0 + $1.subtotal + $1.fee }],
        ])
    }

    private func list(_ query: [String: String], _ now: Int64) -> DemoServer.Reply {
        let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
        let open = query["open"] == "1"
        let q = (query["q"] ?? "").lowercased()
        let list = orders.filter { o in
            (statuses.isEmpty || statuses.contains(o.status)) && (!open || !["delivered", "cancelled"].contains(o.status))
                && (q.isEmpty || o.name.lowercased().contains(q) || String(o.number) == q || o.phone.contains(q))
        }.sorted { $0.number > $1.number }
        var counts: [String: Int] = [:]
        for o in orders { counts[o.status, default: 0] += 1 }
        return ok(["data": list.map { row($0, now, history: false) }, "next_cursor": NSNull(), "counts": counts])
    }

    private func write(_ r: [String], _ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        if r == ["store", "pause"] {
            guard let value = body["paused"] as? Bool else { return fail(400, "invalid_request", "Informe paused como verdadeiro ou falso.") }
            paused = value
            pauseMessage = value ? (body["message"] as? String ?? "") : ""
            emit("pedido.store_changed", ["paused": value, "message": pauseMessage, "module_id": "pedido"])
            return ok(store(now))
        }
        if r.count == 3, r[0] == "items", r[2] == "availability", let available = body["available"] as? Bool {
            for c in categories.indices {
                var items = categories[c]["items"] as? [Row] ?? []
                for i in items.indices where items[i]["id"] as? String == r[1] { items[i]["available"] = available }
                categories[c]["items"] = items
            }
            emit("pedido.menu_changed", ["what": "item", "id": r[1], "action": "availability", "available": available, "module_id": "pedido"])
            let item = categories.flatMap { $0["items"] as? [Row] ?? [] }.first { $0["id"] as? String == r[1] }
            return item.map(ok) ?? fail(404, "not_found", "Item não encontrado no cardápio.")
        }
        if r.count == 3, r[0] == "groups", r[2] == "availability", let available = body["available"] as? Bool, let option = body["option_id"] as? String {
            guard let g = groups.firstIndex(where: { $0["id"] as? String == r[1] }) else { return fail(404, "not_found", "Grupo de adicionais não encontrado no cardápio.") }
            var options = groups[g]["options"] as? [Row] ?? []
            guard options.contains(where: { $0["id"] as? String == option }) else { return fail(400, "invalid_request", "Opção não encontrada neste grupo.") }
            for o in options.indices where options[o]["id"] as? String == option { options[o]["available"] = available }
            groups[g]["options"] = options
            emit("pedido.menu_changed", ["what": "group", "id": r[1], "action": "availability", "option_id": option, "available": available, "module_id": "pedido"])
            return ok(groups[g])
        }
        guard r.count == 3, r[0] == "orders", let o = order(r[1]) else { return fail(404, "not_found", "Recurso não encontrado.") }
        switch r[2] {
        case "status":
            let to = body["status"] as? String ?? ""
            guard next(o).contains(to) else { return fail(409, "invalid_transition", "Mudança inválida para o pedido nº \(o.number).") }
            if to == "cancelled" {
                let reason = (body["reason"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                o.cancelReason = reason.isEmpty ? nil : reason
                if o.payment == "awaiting" { o.payment = "cancelled" }
            }
            o.history.append(["id": "h\(o.number)-\(o.history.count)", "kind": "status", "from_status": o.status, "to_status": to, "actor": DemoMode.meId,
                              "note": nul(body["note"] as? String ?? (to == "cancelled" ? o.cancelReason : nil)), "created": now])
            let from = o.status
            o.status = to
            o.statusAt = now
            emit("pedido.status_changed", ["order_id": o.id, "number": o.number, "from": from, "to": to, "actor": DemoMode.meId, "conversation_id": nul(o.conversationId), "module_id": "pedido"])
        case "paid":
            guard o.payment != "paid" else { return fail(409, "already_paid", "O pedido nº \(o.number) já está pago.") }
            guard o.payment != "awaiting" else { return fail(409, "payment_online", "O pedido nº \(o.number) tem uma cobrança online aberta: o pagamento é confirmado pelo provedor.") }
            guard o.status != "cancelled" else { return fail(409, "order_closed", "Pedido cancelado.") }
            o.payment = "paid"
            o.paidAt = now
            o.history.append(["id": "h\(o.number)-\(o.history.count)", "kind": "payment", "from_status": o.status, "to_status": o.status, "actor": DemoMode.meId,
                              "note": "Pagamento registrado pela equipe: \(Money.format(o.subtotal + o.fee)).", "created": now])
            emit("pedido.paid", ["order_id": o.id, "number": o.number, "module_id": "pedido"])
        case "payment":
            guard o.method == nil || o.payment == "failed" else { return fail(409, "payment_chosen", "O cliente já escolheu a forma de pagamento.") }
            let method = body["method"] as? String ?? ""
            guard ["cash", "card"].contains(method) else { return fail(400, "invalid_request", "Forma de pagamento inválida.") }
            o.method = method
            o.payment = "pending"
            o.history.append(["id": "h\(o.number)-\(o.history.count)", "kind": "payment", "from_status": o.status, "to_status": o.status, "actor": DemoMode.meId,
                              "note": "Forma de pagamento: \(Self.methodLabels[method] ?? method).", "created": now])
            emit("pedido.status_changed", ["order_id": o.id, "number": o.number, "module_id": "pedido"])
        default: return fail(404, "not_found", "Recurso não encontrado.")
        }
        return ok(row(o, now, history: false))
    }

    // MARK: Comanda (o mesmo desenho do servidor: src/modules/pedido/ticket.ts)

    private func ticket(_ o: O, _ columns: Int, _ now: Int64) -> String {
        func wrap(_ text: String) -> [String] {
            var out: [String] = []
            for paragraph in text.components(separatedBy: "\n") {
                var line = ""
                for raw in paragraph.split(separator: " ").map(String.init) {
                    var word = raw
                    while word.count > columns { if !line.isEmpty { out.append(line); line = "" }; out.append(String(word.prefix(columns))); word = String(word.dropFirst(columns)) }
                    if word.isEmpty { continue }
                    if line.isEmpty { line = word } else if line.count + 1 + word.count <= columns { line += " " + word } else { out.append(line); line = word }
                }
                out.append(line)
            }
            return out
        }
        func center(_ text: String) -> [String] { wrap(text).map { String(repeating: " ", count: max(0, (columns - $0.count) / 2)) + $0 } }
        func pair(_ left: String, _ right: String) -> [String] {
            var lines = wrap(left)
            let last = lines.removeLast()
            if last.count + 1 + right.count <= columns { lines.append(last + String(repeating: " ", count: columns - last.count - right.count) + right) }
            else { lines.append(last); lines.append(String(repeating: " ", count: max(0, columns - right.count)) + right) }
            return lines
        }
        let rule = String(repeating: "-", count: columns)
        var out: [String] = []
        out += center(DemoMode.profileName.uppercased())
        out += center("Rua Exemplo, 100 — Centro")
        out += center("(20) 3000-0000")
        out.append(rule)
        out += pair("PEDIDO Nº \(o.number)", BrasiliaTime.shortWithTime(o.created))
        out += wrap("\(o.delivery ? "ENTREGA" : "RETIRADA") · \(Self.labels[o.status] ?? o.status)")
        out.append(rule)
        for line in o.lines {
            out += pair("\(line["quantity"] as? Int ?? 1)x \(line["name"] as? String ?? "")", Money.format(line["total_cents"] as? Int ?? 0))
            for option in line["options"] as? [Row] ?? [] { out += wrap("+ \(option["name"] as? String ?? "")").map { "   " + $0 } }
            if let note = line["note"] as? String, !note.isEmpty { out += wrap("Obs: \(note)").map { "   " + $0 } }
        }
        out.append(rule)
        out += pair("Subtotal", Money.format(o.subtotal))
        if o.delivery { out += pair("Entrega", Money.format(o.fee)) }
        out += pair("TOTAL", Money.format(o.subtotal + o.fee))
        out += wrap("Pagamento: \(o.method.flatMap { Self.methodLabels[$0] } ?? "a definir")\(o.number == 44 ? " (troco para R$ 100,00)" : "")")
        out += wrap(o.payment == "paid" ? "*** PAGO ***" : "Situação: \(o.payment == "pending" ? (o.delivery ? "Pagar na entrega" : "Pagar na retirada") : o.payment)")
        out.append(rule)
        out += wrap("Cliente: \(o.name)")
        out += wrap("Tel: \(PhoneText.display(o.phone) ?? o.phone)")
        if o.delivery { out += wrap("Entregar em: Rua das Acácias, 245 - Jardim Primavera, Casa 2 (portão verde)") }
        if !o.note.isEmpty { out += wrap("Obs.: \(o.note)") }
        out.append(rule)
        out += center("Demonstração: dados fictícios.")
        return out.joined(separator: "\n")
    }
}

// MARK: - Suporte pago (atendimento com passagem para humano)

/// O Suporte pago da demonstração: a conversa `c_suporte` (Ricardo Almeida, cliente de uma assistência de TI) chegou à
/// equipe depois de comprar um suporte avulso, informando o CPF de um pagador a partir de um telefone não vinculado.
/// O detalhe da conversa traz o `handoff` com o resumo e os marcadores; as ações vinculam, confirmam e dão cortesia.
final class DemoSuporte {
    typealias Row = [String: Any]
    static let conversationId = "c_suporte"
    private var linked = false
    private var released: Row?
    private let replays = Replays()
    private let t0: Int64

    init(t0: Int64) { self.t0 = t0 }

    /// `handoff` do detalhe da conversa.
    func handoff(_ conversationId: String) -> Any {
        guard conversationId == Self.conversationId else { return NSNull() }
        var flags = ["suporte avulso pago (até o protocolo fechar)"]
        if !linked { flags.insert("telefone não vinculado ao pagador Ricardo Almeida", at: 0) }
        return ["module": "suporte", "summary": "Ricardo Almeida (CPF 123.456.789-09) comprou o Suporte avulso de R$ 60,00 pelo Pix. Pediu ajuda com a impressora fiscal que não liga desde a queda de energia.",
                "flags": flags, "at": t0 - 6 * 60_000] as Row
    }

    func route(method: String, parts: [String], body: Row, key: String?, now: Int64, emit: DemoEmit) -> DemoServer.Reply? {
        guard parts.count >= 7, parts[4] == "suporte", parts[5] == "conversations" else { return nil }
        let id = parts[6]
        guard id == Self.conversationId else {
            return method == "GET" ? ok(["conversation_id": id, "phone": "", "allowed": false, "reason": "payment_required", "release": NSNull(), "session": NSNull(),
                                         "awaiting_team": false, "unlinked_phone": NSNull(), "purchases": [Row]()]) : fail(404, "not_found", "Sem atendimento do suporte nesta conversa.")
        }
        if method == "GET", parts.count == 7 { return ok(status()) }
        let r = Array(parts.dropFirst(5))
        return replays.run(key, r, body) {
            switch parts.count == 8 ? parts[7] : "" {
            case "link-phone":
                guard !linked else { return fail(409, "nothing_to_link", "Não há pagador aguardando vínculo nesta conversa.") }
                linked = true
                emit("suporte.phone_linked", ["conversation_id": id, "payer_id": "py_almeida", "module_id": "suporte"])
                return ok(status())
            case "confirm":
                linked = true
                return ok(release(kind: "team", reason: nil, until: nil, now: now))
            case "courtesy":
                let reason = (body["reason"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                guard !reason.isEmpty else { return fail(400, "invalid_request", "Informe o motivo da cortesia (até 300 caracteres).") }
                let hours = body["hours"] as? Int
                return ok(release(kind: "courtesy", reason: reason, until: hours.map { now + Int64($0) * 3_600_000 }, now: now))
            default: return fail(404, "not_found", "Recurso não encontrado.")
            }
        }
    }

    private func release(kind: String, reason: String?, until: Int64?, now: Int64) -> Row {
        let labels = ["package": "Suporte avulso", "courtesy": "Cortesia", "team": "Confirmado pela equipe"]
        let row: Row = ["id": "rel_\(kind)", "conversation_id": Self.conversationId, "phone": "5520906541111", "payer_id": "py_almeida", "payer_name": "Ricardo Almeida",
                        "kind": kind, "kind_label": labels[kind] ?? kind, "ref_id": NSNull(), "phone_linked": linked, "valid_until": nul(until), "until_ticket": until == nil,
                        "reason": nul(reason), "summary": NSNull(), "actor": DemoMode.meId, "status": "active", "ended_at": NSNull(), "ended_by": NSNull(), "created": now]
        released = row
        return row
    }

    private func status() -> Row {
        let current: Row = released ?? ["id": "rel_package", "conversation_id": Self.conversationId, "phone": "5520906541111", "payer_id": "py_almeida", "payer_name": "Ricardo Almeida",
                                        "kind": "package", "kind_label": "Suporte avulso", "ref_id": "sp_1", "phone_linked": linked, "valid_until": NSNull(), "until_ticket": true,
                                        "reason": NSNull(), "summary": NSNull(), "actor": "module", "status": "active", "ended_at": NSNull(), "ended_by": NSNull(), "created": t0 - 6 * 60_000]
        var withLink = current
        withLink["phone_linked"] = linked
        return ["conversation_id": Self.conversationId, "phone": "5520906541111", "allowed": true, "reason": "released", "release": withLink,
                "session": ["id": "ss_1", "status": "active", "payer_id": "py_almeida", "name": "Ricardo Almeida", "phone_linked": linked, "matched_by": "document"] as Row,
                "awaiting_team": false,
                "unlinked_phone": linked ? NSNull() as Any : ["payer_id": "py_almeida", "payer_name": "Ricardo Almeida"] as Row,
                "purchases": [["id": "sp_1", "package_name": "Suporte avulso", "amount_cents": 6000, "status": "paid", "created": t0 - 8 * 60_000] as Row]]
    }
}
