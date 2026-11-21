import Foundation

private func ok(_ value: Any) -> DemoServer.Reply { DemoServer.Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
private func fail(_ status: Int, _ code: String, _ message: String) -> DemoServer.Reply {
    DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
}
private func nul(_ value: Any?) -> Any { value ?? NSNull() }

/// A Gestão (ERP) da demonstração, mesmo desenho do Android (`demo/DemoErp.kt`): uma mercearia fictícia com clientes,
/// produtos (códigos de barras na faixa 20…, de uso interno, que não identifica produto de ninguém), dois depósitos,
/// pedidos de venda e contas a receber e a pagar vencendo hoje e vencidas. Responde nas rotas da erp-api (`/erp/v1/…`)
/// e do envio pelo WhatsApp (`/erp-conversa/pedido/…`), no formato do servidor. Telefones com DDD 20.
final class DemoErp {
    typealias Row = [String: Any]

    private var customers: [Row] = []
    private var products: [Row] = []
    /// Saldo por produto e depósito: quantidade e versão.
    private var stock: [String: (quantity: Decimal, version: Int)] = [:]
    private var orders: [Row] = []
    private var titles: [Row] = []
    private var commands: [String: DemoServer.Reply] = [:]
    private var sends: [String: DemoServer.Reply] = [:]
    private var nextOrder = 1041
    private let warehouses = [("dep-loja", "Loja"), ("dep-fundos", "Depósito dos fundos")]
    private lazy var accounts: [Row] = [
        ["id": Self.id("conta-caixa"), "name": "Caixa da loja", "kind": "cash", "active": true],
        ["id": Self.id("conta-banco"), "name": "Banco Exemplo", "kind": "bank", "active": true],
    ]
    private lazy var methods: [Row] = [
        ["id": Self.id("forma-dinheiro"), "description": "Dinheiro", "payment_type": "01", "is_default": true],
        ["id": Self.id("forma-pix"), "description": "Pix", "payment_type": "17", "is_default": false],
        ["id": Self.id("forma-cartao"), "description": "Cartão de crédito", "payment_type": "03", "is_default": false],
        ["id": Self.id("forma-boleto"), "description": "Boleto", "payment_type": "15", "is_default": false],
    ]

    private var today: String { BrasiliaTime.today() }
    private func day(_ offset: Int) -> String { BrasiliaTime.addDays(today, offset) }

    /// Ids estáveis em forma de UUID (o ERP só aceita UUID), derivados de um nome legível.
    static func id(_ key: String) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in ("demo-erp:" + key).utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
        let hex = String(format: "%016llx", h) + String(format: "%016llx", h &* 0x9E3779B97F4A7C15)
        let c = Array(hex)
        return "\(String(c[0..<8]))-\(String(c[8..<12]))-4\(String(c[13..<16]))-8\(String(c[17..<20]))-\(String(c[20..<32]))"
    }

    init() {
        func customer(_ key: String, _ code: String, _ name: String, mobile: String?, email: String?, city: String, street: String, extra: Row = [:]) {
            var row: Row = ["id": Self.id(key), "entity": "contacts", "version": 1, "active": true, "situation": "A", "code": code, "name": name,
                            "person_type": "F", "document": NSNull(), "trade_name": NSNull(), "email": nul(email), "phone": NSNull(), "mobile": nul(mobile),
                            "postal_code": "00000-000", "street": street, "number": "100", "complement": NSNull(), "district": "Centro", "city": city, "state": "SP",
                            "created_at": "2026-01-10T12:00:00Z", "updated_at": "2026-01-10T12:00:00Z"]
            extra.forEach { row[$0.key] = $0.value }
            customers.append(row)
        }
        customer("cli-mariana", "1", "Mariana Costa", mobile: "(20) 90000-1101", email: "mariana@cliente.example", city: "Cidade Exemplo", street: "Rua das Flores")
        customer("cli-joao", "2", "João Pereira", mobile: "(20) 90000-1102", email: nil, city: "Cidade Exemplo", street: "Avenida Central")
        customer("cli-padaria", "3", "Padaria Pão Dourado", mobile: "(20) 90000-1103", email: "compras@padaria.example", city: "Vila Exemplo", street: "Rua do Comércio",
                 extra: ["person_type": "J", "trade_name": "Pão Dourado", "phone": "(20) 3000-1103"])
        customer("cli-fernanda", "4", "Fernanda Lima", mobile: "(20) 90000-1104", email: "fernanda@cliente.example", city: "Cidade Exemplo", street: "Travessa Azul")
        customer("cli-oficina", "5", "Oficina Roda Viva", mobile: nil, email: "oficina@cliente.example", city: "Vila Exemplo", street: "Estrada Velha",
                 extra: ["person_type": "J", "phone": "(20) 3000-1105"])
        customer("cli-paulo", "6", "Paulo Mendes", mobile: "(20) 90000-1106", email: nil, city: "Cidade Exemplo", street: "Rua Nova")

        func product(_ key: String, _ code: String, _ gtin: String?, _ name: String, _ unit: String, _ price: String, loja: Decimal, fundos: Decimal, brand: String? = nil) {
            products.append(["id": Self.id(key), "entity": "products", "version": 1, "active": true, "code": code, "name": name, "unit": unit, "price": price,
                             "gtin": nul(gtin), "kind": "P", "format": "S", "brand": nul(brand), "description": NSNull(),
                             "created_at": "2026-01-10T12:00:00Z", "updated_at": "2026-01-10T12:00:00Z"])
            stock[Self.id(key) + "|" + Self.id("dep-loja")] = (loja, 3)
            stock[Self.id(key) + "|" + Self.id("dep-fundos")] = (fundos, 2)
        }
        product("pro-cafe", "CAF500", "2000000000015", "Café torrado e moído 500 g", "PCT", "18.9000", loja: 24, fundos: 60, brand: "Marca Exemplo")
        product("pro-acucar", "ACU1", "2000000000022", "Açúcar cristal 1 kg", "PCT", "5.4900", loja: 40, fundos: 120)
        product("pro-arroz", "ARR5", "2000000000039", "Arroz tipo 1 5 kg", "PCT", "27.9000", loja: 15, fundos: 48)
        product("pro-feijao", "FEI1", "2000000000046", "Feijão carioca 1 kg", "PCT", "8.7900", loja: 3, fundos: 30)
        product("pro-oleo", "OLE900", "2000000000053", "Óleo de soja 900 ml", "UN", "7.4900", loja: 0, fundos: 36)
        product("pro-sabao", "SAB5", "2000000000060", "Sabão em barra (5 unidades)", "PCT", "11.5000", loja: 12, fundos: 0)
        product("pro-detergente", "DET500", "2000000000077", "Detergente 500 ml", "UN", "2.9900", loja: -2, fundos: 24)
        product("pro-entrega", "ENT", nil, "Entrega no bairro", "SV", "8.0000", loja: 0, fundos: 0)

        func order(_ customerKey: String, _ offset: Int, _ status: String, _ total: String) {
            orders.append(["id": UUID().uuidString.lowercased(), "number": String(nextOrder), "date": day(offset), "status": status, "total": total, "contact_id": Self.id(customerKey)])
            nextOrder += 1
        }
        order("cli-mariana", -12, "fulfilled", "86.40")
        order("cli-mariana", -3, "open", "41.37")
        order("cli-padaria", -20, "fulfilled", "512.00")
        order("cli-padaria", -1, "in_progress", "233.50")
        order("cli-joao", -7, "fulfilled", "27.90")

        func title(_ key: String, _ kind: String, _ customerKey: String?, _ contactName: String, _ description: String, due: Int, cents: Int, installment: Int = 1, of total: Int = 1) {
            titles.append(["id": Self.id(key), "kind": kind, "contact_id": Self.id(customerKey ?? "for-\(key)"), "contact_name": contactName, "description": description,
                           "due_on": day(due), "issued_on": day(due - 30), "amount_cents": String(cents), "settled_cents": "0", "balance_cents": String(cents),
                           "status": "open", "overdue": due < 0, "version": 1, "account_id": NSNull(), "installment": installment, "installments": total,
                           "cancelled": false, "document_linked": false])
        }
        title("tit-mariana-1", "receivable", "cli-mariana", "Mariana Costa", "Pedido 1042", due: 0, cents: 4137)
        title("tit-padaria-1", "receivable", "cli-padaria", "Padaria Pão Dourado", "Pedido 1044 · parcela 1/2", due: 0, cents: 11675, installment: 1, of: 2)
        title("tit-padaria-2", "receivable", "cli-padaria", "Padaria Pão Dourado", "Pedido 1043", due: -5, cents: 51200)
        title("tit-fernanda-1", "receivable", "cli-fernanda", "Fernanda Lima", "Venda no fiado", due: -2, cents: 6390)
        title("tit-luz", "payable", nil, "Companhia de Energia Exemplo", "Conta de luz", due: 0, cents: 31245)
        title("tit-fornecedor", "payable", nil, "Distribuidora Exemplo", "Compra de mercadoria", due: -1, cents: 128900)
        title("tit-aluguel", "payable", nil, "Imobiliária Exemplo", "Aluguel da loja", due: -4, cents: 250000)
    }

    /// `/api/v1/profiles/{p}/erp/…` e `/erp-conversa/…`; `nil` fora delas.
    func route(method: String, parts: [String], body: Row, query: [String: String]) -> DemoServer.Reply? {
        guard parts.count >= 5, parts[0] == "api", parts[1] == "v1", parts[2] == "profiles" else { return nil }
        let r = Array(parts.dropFirst(4))
        if r.first == "erp-conversa" { return conversa(method, Array(r.dropFirst()), body) }
        guard r.first == "erp", r.count >= 2, r[1] == "v1" else { return nil }
        let p = Array(r.dropFirst(2))
        let get = method == "GET", post = method == "POST"
        switch true {
        case p == ["cadastros", "contatos"] && get: return contactPage(query)
        case p == ["cadastros", "contatos"] && post: return command(body) { self.createContact(body) }
        case p.count == 3 && p[0] == "cadastros" && p[1] == "contatos":
            guard let c = customers.first(where: { $0["id"] as? String == p[2] }) else { return notFound() }
            return ok(["entity": "contacts", "record": c, "data_mode": "erp_native", "replayed": false])
        case p.count == 4 && p[0] == "cadastros" && p[1] == "contatos" && p[3] == "historico":
            let items = orders.filter { $0["contact_id"] as? String == p[2] }.sorted { ($0["date"] as? String ?? "") > ($1["date"] as? String ?? "") }.prefix(10)
                .map { o -> Row in ["id": o["id"]!, "number": o["number"]!, "date": o["date"]!, "status": o["status"]!, "total": o["total"]!] }
            return ok(["scope": "contact_sales", "contact_id": p[2], "visible": true, "data_mode": "erp_native", "items": Array(items)])
        case p == ["cadastros", "products"] && get: return productList(query)
        case p.count == 3 && p[0] == "cadastros" && p[1] == "products":
            guard let product = products.first(where: { $0["id"] as? String == p[2] }) else { return notFound() }
            return ok(["entity": "products", "record": product, "data_mode": "erp_native"])
        case p.count == 3 && p[0] == "anexos-cadastros" && p[1] == "produtos":
            return ok(["product_id": p[2], "items": [Row](), "pending": [Row](), "stored_bytes": "0", "limit": 20, "data_mode": "erp_native"])
        case p == ["estoque", "saldos"]: return balances(query["product_id"] ?? "")
        case p == ["estoque", "movimentos"] && post: return command(body) { self.moveStock(body) }
        case p == ["documentos", "sales_orders", "pagamento"]: return ok(["kind": "sales_orders", "methods": methods, "data_mode": "erp_native"])
        case p == ["documentos", "sales_orders"] && post: return command(body) { self.createOrder(body) }
        case p == ["financeiro", "titles"]: return titlePage(query)
        case p == ["financeiro", "accounts"]: return ok(["entity": "accounts", "items": accounts, "limit": 100, "has_more": false, "next_cursor": NSNull(), "data_mode": "erp_native"])
        case p == ["financeiro", "actions", "settle"] && post: return command(body) { self.settle(body) }
        default: return notFound()
        }
    }

    private func notFound() -> DemoServer.Reply { fail(404, "ERP_NOT_FOUND", "Não encontrado no ERP da demonstração.") }
    private func invalid() -> DemoServer.Reply { fail(400, "ERP_INVALID_QUERY", "Dados recusados pelo ERP da demonstração.") }

    /// O mesmo `command_id` devolve a mesma resposta (como o ERP).
    private func command(_ body: Row, _ run: () -> DemoServer.Reply) -> DemoServer.Reply {
        guard let key = body["command_id"] as? String else { return invalid() }
        if let reply = commands[key] { return reply }
        let reply = run()
        if reply.status < 500 { commands[key] = reply }
        return reply
    }

    private func contactPage(_ query: [String: String]) -> DemoServer.Reply {
        let q = (query["q"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let digits = q.filter(\.isNumber)
        let page = Int(query["page"] ?? "") ?? 1, size = Int(query["size"] ?? "") ?? 100
        var found = customers.filter { c in
            q.isEmpty || ((c["name"] as? String)?.lowercased().contains(q) ?? false) || (c["code"] as? String) == q ||
                (digits.count >= 4 && ["mobile", "phone", "document"].contains { ((c[$0] as? String) ?? "").filter(\.isNumber).contains(digits) })
        }
        found = q.isEmpty ? found.reversed() : found.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        let slice = Array(found.dropFirst((page - 1) * size).prefix(size))
        return ok(["entity": "contacts", "items": slice, "page": page, "size": size, "total": found.count, "sort": query["sort"] ?? "created_desc",
                   "situation": "latest", "scoped": false, "data_mode": "erp_native"])
    }

    private func createContact(_ body: Row) -> DemoServer.Reply {
        guard let data = body["data"] as? Row, let name = (data["name"] as? String)?.trimmingCharacters(in: .whitespaces), !name.isEmpty else { return invalid() }
        let document = data["document"] as? String
        if let document, customers.contains(where: { ($0["document"] as? String)?.filter { $0.isLetter || $0.isNumber } == document }) {
            return fail(409, "ERP_CONTACT_DUPLICATE_DOCUMENT", "CPF/CNPJ já cadastrado.")
        }
        let record: Row = ["id": UUID().uuidString.lowercased(), "entity": "contacts", "version": 1, "active": true, "situation": "A", "code": String(customers.count + 1),
                           "name": name, "person_type": data["person_type"] ?? "F", "document": nul(document), "trade_name": NSNull(),
                           "email": nul(data["email"]), "phone": nul(data["phone"]), "mobile": nul(data["mobile"]),
                           "roles": ["customer"], "types": ["customer"], "created_at": "2026-11-21T12:00:00Z", "updated_at": "2026-11-21T12:00:00Z"]
        customers.append(record)
        return ok(["entity": "contacts", "record": record, "data_mode": "erp_native", "replayed": false])
    }

    private func productList(_ query: [String: String]) -> DemoServer.Reply {
        let q = (query["q"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let limit = Int(query["limit"] ?? "") ?? 25
        let found = products.filter { p in q.isEmpty || ["name", "code", "gtin"].contains { ((p[$0] as? String) ?? "").lowercased().contains(q) } }
            .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        return ok(["entity": "products", "items": Array(found.prefix(limit)), "limit": limit, "has_more": found.count > limit, "next_cursor": NSNull(), "data_mode": "erp_native"])
    }

    private static func text(_ value: Decimal, scale: Int = 6) -> String {
        String(format: "%.\(scale)f", locale: Locale(identifier: "en_US_POSIX"), NSDecimalNumber(decimal: value).doubleValue)
    }

    private func balances(_ productId: String) -> DemoServer.Reply {
        guard let product = products.first(where: { $0["id"] as? String == productId }) else { return notFound() }
        let items: [Row] = warehouses.map { key, name in
            let position = stock[productId + "|" + Self.id(key)] ?? (0, 0)
            return ["warehouse_id": Self.id(key), "warehouse_name": name, "warehouse_active": true, "quantity": Self.text(position.quantity), "version": position.version,
                    "unit": nul(product["unit"]), "warehouse_default": key == "dep-loja", "warehouse_ignored": false,
                    "reserved_quantity": key == "dep-loja" && productId == Self.id("pro-arroz") ? "2.000000" : "0.000000", "situation_reserved_quantity": "0.000000"]
        }
        return ok(["product_id": productId, "items": items, "reservation": Row(), "data_mode": "erp_native"])
    }

    private func moveStock(_ body: Row) -> DemoServer.Reply {
        let reason = ((body["reason"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        guard reason.count >= 3, let kind = body["kind"] as? String, ["receipt", "issue"].contains(kind), let lines = body["items"] as? [Row], !lines.isEmpty else { return invalid() }
        var changes: [(String, Decimal, Int)] = []
        for line in lines {
            let key = "\(line["product_id"] as? String ?? "")|\(line["warehouse_id"] as? String ?? "")"
            let position = stock[key] ?? (0, 0)
            guard (line["expected_version"] as? Int) == position.version else { return fail(409, "ERP_CONFLICT", "O saldo mudou.") }
            guard let delta = Decimal(string: line["quantity"] as? String ?? "", locale: Locale(identifier: "en_US_POSIX")) else { return invalid() }
            changes.append((key, position.quantity + delta, position.version + 1))
        }
        for (key, quantity, version) in changes { stock[key] = (quantity, version) }
        let movement: Row = ["id": UUID().uuidString.lowercased(), "kind": kind, "occurred_on": body["occurred_on"] ?? today, "reason": reason]
        return ok(["movement": movement, "replayed": false, "data_mode": "erp_native"] as Row)
    }

    private func cents(_ text: String?) -> Int {
        guard let value = Decimal(string: text ?? "", locale: Locale(identifier: "en_US_POSIX")) else { return 0 }
        var input = value * 100, output = Decimal()
        NSDecimalRound(&output, &input, 0, .plain)
        return NSDecimalNumber(decimal: output).intValue
    }

    private func createOrder(_ body: Row) -> DemoServer.Reply {
        guard let data = body["data"] as? Row, let contactId = data["contact_id"] as? String else { return invalid() }
        guard let customer = customers.first(where: { $0["id"] as? String == contactId }) else { return fail(400, "ERP_INVALID_QUERY", "Cliente não encontrado.") }
        let items = data["items"] as? [Row] ?? []
        guard !items.isEmpty else { return invalid() }
        let subtotal = items.reduce(0) { sum, line in
            let q = Decimal(string: line["quantity"] as? String ?? "0", locale: Locale(identifier: "en_US_POSIX")) ?? 0
            let p = Decimal(string: line["unit_price"] as? String ?? "0", locale: Locale(identifier: "en_US_POSIX")) ?? 0
            var input = q * p * 100, output = Decimal()
            NSDecimalRound(&output, &input, 0, .plain)
            return sum + NSDecimalNumber(decimal: output).intValue
        }
        let discountText = data["discount_value"] as? String ?? "0"
        let discount: Int
        if data["discount_mode"] as? String == "percent" {
            var input = Decimal(subtotal) * (Decimal(string: discountText, locale: Locale(identifier: "en_US_POSIX")) ?? 0) / 100, output = Decimal()
            NSDecimalRound(&output, &input, 0, .plain)
            discount = NSDecimalNumber(decimal: output).intValue
        } else {
            discount = cents(discountText)
        }
        guard discount <= subtotal else { return fail(400, "ERP_INVALID_QUERY", "Desconto maior que o subtotal.") }
        let total = subtotal - discount
        let installments = data["installments"] as? [Row] ?? []
        if !installments.isEmpty, installments.reduce(0, { $0 + cents($1["amount"] as? String) }) != total {
            return fail(400, "ERP_INVALID_QUERY", "Parcelas diferentes do total.")
        }
        let number = String(nextOrder)
        nextOrder += 1
        let id = UUID().uuidString.lowercased()
        orders.append(["id": id, "number": number, "date": today, "status": "open", "total": ErpNumbers.centsText(total), "contact_id": contactId])
        for row in installments {
            let value = String(cents(row["amount"] as? String))
            titles.append(["id": UUID().uuidString.lowercased(), "kind": "receivable", "contact_id": contactId, "contact_name": customer["name"] ?? "",
                           "description": "Pedido \(number)", "due_on": row["due_date"] ?? today, "issued_on": today, "amount_cents": value, "settled_cents": "0",
                           "balance_cents": value, "status": "open", "overdue": false, "version": 1, "account_id": NSNull(), "installment": 1, "installments": 1,
                           "cancelled": false, "document_linked": true])
        }
        let document: Row = ["id": id, "kind": "sales_orders", "number": number, "status": "open", "version": 1]
        return ok(["kind": "sales_orders", "document": document, "replayed": false, "data_mode": "erp_native"] as Row)
    }

    private func titlePage(_ query: [String: String]) -> DemoServer.Reply {
        guard let kind = query["kind"] else { return invalid() }
        let option = query["option"] ?? "open", from = query["from"], to = query["to"]
        let q = (query["q"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let found: [Row] = titles.filter { t in
            let due = t["due_on"] as? String ?? ""
            return t["kind"] as? String == kind && ["open", "partial"].contains(t["status"] as? String ?? "") &&
                (option != "overdue" || due < today) && (from == nil || due >= from!) && (to == nil || due <= to!) &&
                (q.isEmpty || ((t["contact_name"] as? String)?.lowercased().contains(q) ?? false) || ((t["description"] as? String)?.lowercased().contains(q) ?? false))
        }
        .sorted { ($0["due_on"] as? String ?? "") < ($1["due_on"] as? String ?? "") }
        .map { t -> Row in var row = t; row["overdue"] = (t["due_on"] as? String ?? "") < today; return row }
        let amount = found.reduce(0) { $0 + (Int($1["amount_cents"] as? String ?? "") ?? 0) }
        let balance = found.reduce(0) { $0 + (Int($1["balance_cents"] as? String ?? "") ?? 0) }
        let totals: Row = ["count": found.count, "amount_cents": String(amount), "balance_cents": String(balance), "fee_cents": "0"]
        return ok(["entity": "titles", "kind": kind, "option": option, "items": found, "page": 1, "limit": Int(query["limit"] ?? "") ?? 100, "order": "due_asc", "total": found.count,
                   "totals": totals, "data_mode": "erp_native"] as Row)
    }

    private func settle(_ body: Row) -> DemoServer.Reply {
        guard let data = body["data"] as? Row, let index = titles.firstIndex(where: { $0["id"] as? String == data["id"] as? String }) else { return notFound() }
        var title = titles[index]
        guard (data["expected_version"] as? Int) == (title["version"] as? Int) else { return fail(409, "ERP_CONFLICT", "A conta mudou.") }
        guard accounts.contains(where: { $0["id"] as? String == data["account_id"] as? String }), let principal = Int(data["principal_cents"] as? String ?? "") else { return invalid() }
        let balance = (Int(title["balance_cents"] as? String ?? "") ?? 0) - principal
        guard balance >= 0 else { return invalid() }
        title["balance_cents"] = String(balance)
        title["settled_cents"] = String((Int(title["settled_cents"] as? String ?? "") ?? 0) + principal)
        title["status"] = balance == 0 ? "paid" : "partial"
        title["version"] = (title["version"] as? Int ?? 1) + 1
        titles[index] = title
        return ok(["entity": "titles", "action": "settle", "record": title, "replayed": false, "data_mode": "erp_native"])
    }

    private func conversa(_ method: String, _ r: [String], _ body: Row) -> DemoServer.Reply {
        guard r.count >= 2, r[0] == "pedido", let order = orders.first(where: { $0["id"] as? String == r[1] }) else {
            return fail(404, "not_found", "Pedido não encontrado.")
        }
        let customer = customers.first { $0["id"] as? String == order["contact_id"] as? String }
        let shown = (customer?["mobile"] as? String) ?? (customer?["phone"] as? String)
        let digits = shown.map { "55" + $0.filter(\.isNumber) }
        if r.count == 2, method == "GET" {
            let number = order["number"] as? String ?? ""
            var phones: [Row] = []
            if let digits { phones.append(["digitos": digits, "numero": shown ?? ""]) }
            let attachment: Row = ["nome": "pedido-\(number).pdf", "tipo": "application/pdf", "tamanho": 24_000]
            var answer: Row = [
                "documento": ["tipo": "pedido", "id": nul(order["id"]), "titulo": "Pedido \(number)", "cliente": nul(customer?["name"])] as Row,
                "telefones": phones,
                "linhas": [["id": "linha-loja", "nome": "WhatsApp da loja"]],
                "conectar": NSNull(),
                "previa": ["texto": "Olá! Segue o pedido \(number) da Empresa Exemplo.", "anexos": [attachment]] as Row,
                "envios": [Row](),
            ]
            if let digits {
                answer["destino"] = ["telefone": shown ?? "", "digitos": digits, "fora_do_cadastro": false, "linha": "linha-loja", "modo": "arquivo", "motivo": NSNull()] as Row
            } else {
                answer["destino"] = NSNull()
            }
            return ok(answer)
        }
        if r.count == 3, r[2] == "enviar", method == "POST" {
            guard let phone = body["telefone"] as? String else { return fail(400, "invalid_request", "Informe o telefone.") }
            let key = "\(r[1])|\(phone)|\(body["linha"] as? String ?? "")"
            if let reply = sends[key] { return reply }
            let reply = ok(["envio": ["id": UUID().uuidString.lowercased(), "status": "enviado", "telefone": phone], "repetido": false])
            sends[key] = reply
            return reply
        }
        return fail(404, "not_found", "Rota não encontrada.")
    }
}
