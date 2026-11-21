import Foundation

private func caixaOk(_ value: Any) -> DemoServer.Reply { DemoServer.Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
private func caixaFail(_ status: Int, _ code: String, _ message: String) -> DemoServer.Reply {
    DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
}

/// O caixa da demonstração, mesmo desenho do Android (`demo/DemoCaixa.kt`): as rotas do controle de caixa do Financeiro
/// (`erp/v1/financeiro/accounts`, `…/controle-caixa`, `…/actions/session_*`) e as formas de pagamento
/// (`erp/v1/documentos/sales_orders/pagamento`), no formato do servidor. Começa com o caixa fechado.
final class DemoCaixa {
    typealias Row = [String: Any]

    static func id(_ key: String) -> String {
        // Ids fixos com formato de UUID a partir da chave (o ERP valida UUID).
        var hash: UInt64 = 1469598103934665603
        for byte in "wabotia-demo-caixa:\(key)".utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        let hex = String(format: "%016llx", hash)
        return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-4\(hex.dropFirst(13).prefix(3))-8\(hex.prefix(3))-\(hex.suffix(12))"
    }

    private let accounts: [Row] = [
        ["id": DemoCaixa.id("conta-caixa"), "name": "Caixa do salão", "kind": "cash", "active": true],
        ["id": DemoCaixa.id("conta-banco"), "name": "Banco Exemplo", "kind": "bank", "active": true],
    ]
    private let methods: [Row] = [
        ["id": DemoCaixa.id("forma-dinheiro"), "description": "Dinheiro", "payment_type": "01", "is_default": true],
        ["id": DemoCaixa.id("forma-pix"), "description": "Pix", "payment_type": "17", "is_default": false],
        ["id": DemoCaixa.id("forma-debito"), "description": "Cartão de débito", "payment_type": "04", "is_default": false],
        ["id": DemoCaixa.id("forma-credito"), "description": "Cartão de crédito", "payment_type": "03", "is_default": false],
    ]

    private final class Session {
        let id = UUID().uuidString.lowercased()
        let accountId: String
        let change: Int
        let openedAt = ISO8601DateFormatter().string(from: Date())
        var state = "open"
        var version = 1
        var closedAt: String?
        var moves: [Row] = []
        var values: [(String, Int)] = []
        init(accountId: String, change: Int) { self.accountId = accountId; self.change = change }
    }

    private var sessions: [Session] = []
    private var replays: [String: DemoServer.Reply] = [:]

    func route(method: String, parts: [String], body: Row) -> DemoServer.Reply? {
        guard parts.count >= 7, parts[0] == "api", parts[1] == "v1", parts[2] == "profiles", parts[4] == "erp", parts[5] == "v1" else { return nil }
        let p = Array(parts.dropFirst(6))
        if p == ["financeiro", "accounts"] { return caixaOk(["entity": "accounts", "items": accounts, "limit": 100, "has_more": false, "data_mode": "erp_native"]) }
        if p == ["documentos", "sales_orders", "pagamento"] { return caixaOk(["kind": "sales_orders", "methods": methods, "data_mode": "erp_native"]) }
        if p == ["financeiro", "controle-caixa"] {
            let open = sessions.filter { $0.state == "open" }
            return caixaOk(["entity": "cash_sessions", "state": "open", "items": open.map { view($0, lines: false) }, "total": open.count, "data_mode": "erp_native"])
        }
        if p.count == 3, p[0] == "financeiro", p[1] == "controle-caixa" {
            guard let s = sessions.first(where: { $0.id == p[2] }) else { return caixaFail(404, "ERP_NOT_FOUND", "Caixa não encontrado.") }
            return caixaOk(["entity": "cash_sessions", "record": view(s, lines: true), "data_mode": "erp_native"])
        }
        if p.count == 3, p[0] == "financeiro", p[1] == "actions", method == "POST" {
            let command = body["command_id"] as? String ?? ""
            if let replay = replays[command] { return replay }
            let reply = action(p[2], body["data"] as? Row ?? [:])
            if reply.status < 300 { replays[command] = reply }
            return reply
        }
        return nil
    }

    private func action(_ name: String, _ data: Row) -> DemoServer.Reply {
        if name == "session_open" {
            let account = data["account_id"] as? String ?? ""
            guard accounts.contains(where: { $0["id"] as? String == account && $0["kind"] as? String == "cash" }) else { return caixaFail(400, "erp_finance_invalid_account", "Conta inválida.") }
            if sessions.contains(where: { $0.state == "open" && $0.accountId == account }) { return caixaFail(409, "erp_finance_cash_session_open", "Caixa já aberto.") }
            let s = Session(accountId: account, change: Int(data["change_cents"] as? String ?? "") ?? 0)
            sessions.append(s)
            return result(name, s)
        }
        guard let s = sessions.first(where: { $0.id == data["id"] as? String }) else { return caixaFail(404, "ERP_NOT_FOUND", "Caixa não encontrado.") }
        guard (data["expected_version"] as? Int) == s.version else { return caixaFail(409, "erp_finance_version_conflict", "O caixa mudou.") }
        guard s.state == "open" else { return caixaFail(409, "erp_finance_cash_session_state", "Caixa fechado.") }
        switch name {
        case "session_move":
            s.moves.append([
                "id": UUID().uuidString.lowercased(), "kind": data["kind"] as? String ?? "supply", "posted_on": data["posted_on"] as? String ?? BrasiliaTime.today(),
                "note": data["note"] as? String ?? NSNull(), "amount_cents": data["amount_cents"] as? String ?? "0", "created_at": ISO8601DateFormatter().string(from: Date()),
            ])
        case "session_close":
            s.values = (data["values"] as? [Row] ?? []).map { ($0["payment_method_id"] as? String ?? "", Int($0["amount_cents"] as? String ?? "") ?? 0) }
            s.state = "closed"
            s.closedAt = ISO8601DateFormatter().string(from: Date())
        default:
            return caixaFail(400, "ERP_INVALID_QUERY", "Ação não disponível na demonstração.")
        }
        s.version += 1
        return result(name, s)
    }

    private func result(_ action: String, _ s: Session) -> DemoServer.Reply {
        caixaOk(["action": action, "replayed": false, "entity": "cash_sessions", "record": view(s, lines: true), "data_mode": "erp_native"])
    }

    private func view(_ s: Session, lines: Bool) -> Row {
        func sum(_ kind: String) -> Int { s.moves.filter { $0["kind"] as? String == kind }.reduce(0) { $0 + (Int($1["amount_cents"] as? String ?? "") ?? 0) } }
        let supply = sum("supply"), withdrawal = sum("withdrawal")
        var row: Row = [
            "id": s.id, "account_id": s.accountId, "account_name": accounts.first { $0["id"] as? String == s.accountId }?["name"] ?? "",
            "operator_id": DemoMode.meId, "operator_name": "Você", "opened_at": s.openedAt, "opened_on": BrasiliaTime.today(),
            "previous_change_cents": "0", "change_cents": String(s.change), "state": s.state, "closed_by_name": s.closedAt == nil ? NSNull() : "Você",
            "closed_at": s.closedAt ?? NSNull(), "checked": false, "supply_cents": String(supply), "withdrawal_cents": String(withdrawal),
            "expected_cash_cents": String(s.change + supply - withdrawal), "informed_cents": String(s.values.reduce(0) { $0 + $1.1 }),
            "version": s.version, "created_at": s.openedAt,
        ]
        if lines {
            row["values"] = s.values.map { v -> Row in
                ["payment_method_id": v.0, "payment_method_name": methods.first { $0["id"] as? String == v.0 }?["description"] ?? "", "amount_cents": String(v.1)]
            }
            row["methods"] = [Row]()
            row["moves"] = s.moves
        }
        return row
    }
}
