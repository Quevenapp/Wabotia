import Foundation

/// A fila de senhas da demonstração (docs/FILA-SENHAS.md), em memória: duas filas, três guichês, senhas aguardando e
/// uma atendente fictícia que chama sozinha de tempos em tempos, para o painel de chamadas falar e o guichê ter o que
/// fazer. Também responde ao pareamento do modo aparelho (aprovado sozinho na segunda consulta), ao desfazer
/// pareamento e à rota de capacidades. Chamada por `DemoServer`, na mesma fila serial; nada aqui toca a rede.
///
/// Dados fictícios como no resto da demonstração: telefones com o DDD 20 (que não existe no Brasil) começando por 9 0.
final class DemoQueue {
    typealias Row = [String: Any]
    typealias Reply = DemoServer.Reply

    static let deviceToken = "wab_demo"
    static let userCode = "DEMO-2345"
    /// Linha de WhatsApp fictícia do QR do cupom.
    static let whatsappLine = "5520900000001"
    static let normalsPerPreferential = 2
    static let serviceMinutes = 6.0
    static let autoCallMs: Int64 = 20_000
    static let autoIssueMs: Int64 = 27_000

    private final class Q {
        let id: String, name: String, normal: String, preferential: String, channels: [String], notice: String?
        var normalsSincePreferential = 0
        var numbers: [Bool: Int] = [false: 0, true: 0]
        init(_ id: String, _ name: String, _ normal: String, _ preferential: String, _ channels: [String], _ notice: String?) {
            self.id = id; self.name = name; self.normal = normal; self.preferential = preferential; self.channels = channels; self.notice = notice
        }
    }

    private final class C {
        let id: String, name: String, queueIds: [String]
        var status: String, userId: String?, userName: String?
        var current: String?
        init(_ id: String, _ name: String, _ queueIds: [String], _ status: String, _ userId: String?, _ userName: String?) {
            self.id = id; self.name = name; self.queueIds = queueIds; self.status = status; self.userId = userId; self.userName = userName
        }
    }

    private final class T {
        let id: String
        var queueId: String
        let code: String, preferential: Bool, source: String
        var status = "waiting"
        var counterId: String?
        /// Transferida direto para este guichê: passa à frente nele.
        var reservedFor: String?
        var callCount = 0
        let phone: String?, conversationId: String?
        let createdAt: Int64
        var calledAt: Int64?, startedAt: Int64?, finishedAt: Int64?
        init(id: String, queueId: String, code: String, preferential: Bool, source: String, phone: String?, conversationId: String?, createdAt: Int64) {
            self.id = id; self.queueId = queueId; self.code = code; self.preferential = preferential; self.source = source
            self.phone = phone; self.conversationId = conversationId; self.createdAt = createdAt
        }
    }

    private let queues = [
        Q("dq-geral", "Atendimento geral", "N", "P", ["whatsapp", "kiosk"], "Idosos (60+), gestantes, lactantes, pessoas com deficiência e com criança de colo."),
        Q("dq-retirada", "Retirada de documentos", "R", "S", ["whatsapp", "kiosk"], nil),
    ]
    private let counters = [
        C("dc-1", "Guichê 1", ["dq-geral", "dq-retirada"], "closed", nil, nil),
        C("dc-2", "Guichê 2", ["dq-geral"], "open", "u_ana", "Ana Souza"),
        C("dc-3", "Guichê 3", ["dq-retirada"], "paused", nil, nil),
    ]
    private var tickets: [T] = []
    private var calls: [Row] = []
    private var replies: [String: Reply] = [:]
    private var seq = 0
    private var phoneSeq = 100
    private var nextAutoCall: Int64
    private var nextAutoIssue: Int64
    private var pairingPolls: [String: Int] = [:]

    init(t0: Int64) {
        nextAutoCall = t0 + 15_000
        nextAutoIssue = t0 + 22_000
        // A manhã já começou: algumas chamadas no painel e gente esperando.
        for (i, pref) in [false, false, true, false].enumerated() { _ = issue("dq-geral", pref, i % 2 == 0 ? "whatsapp" : "kiosk", t0 - Int64(50 - i * 6) * 60_000) }
        for (i, pref) in [false, true].enumerated() { _ = issue("dq-retirada", pref, "kiosk", t0 - Int64(40 - i * 5) * 60_000) }
        for n in 0..<3 {
            _ = callNext(counters[1], t0 - Int64(30 - n * 9) * 60_000)
            if n < 2 { finish(counters[1], t0 - Int64(26 - n * 9) * 60_000) }
        }
        for (i, pref) in [false, true, false, false, true, false].enumerated() { _ = issue("dq-geral", pref, i % 3 == 0 ? "kiosk" : "whatsapp", t0 - Int64(12 - i * 2) * 60_000) }
        for (i, pref) in [false, false, true].enumerated() { _ = issue("dq-retirada", pref, "whatsapp", t0 - Int64(10 - i * 3) * 60_000) }
    }

    // MARK: - Rotas

    /// As rotas da fila, do pareamento e das capacidades; `nil` para as demais (o `DemoServer` responde).
    func route(method: String, parts: [String], body: Row, key: String?, now: Int64) -> Reply? {
        let get = method == "GET", post = method == "POST"
        if post, parts == ["api", "pairing", "start"] { return pairingStart(body) }
        if post, parts == ["api", "pairing", "token"] { return pairingToken(body) }
        if post, parts == ["api", "v1", "pairings", "disconnect"] { return ok(["ok": true, "revoked": true]) }
        if get, parts == ["api", "v1", "capabilities"] { return capabilities(perArea: false) }
        if get, parts.count == 5, Array(parts.prefix(3)) == ["api", "v1", "profiles"], parts[4] == "capabilities" { return capabilities(perArea: true) }
        if parts.count >= 5, Array(parts.prefix(3)) == ["api", "v1", "profiles"], parts[4] == "queue" {
            return handle(method: method, rest: Array(parts.dropFirst(5)), body: body, key: key, now: now)
        }
        return nil
    }

    /// `/api/v1/profiles/{p}/queue/…` com `rest` já sem o `queue`.
    func handle(method: String, rest r: [String], body: Row, key: String?, now: Int64) -> Reply {
        tick(now)
        if method == "GET" {
            if r.isEmpty { return ok(overview(now)) }
            if r == ["tickets"] { return ok(["data": tickets.filter { localDay($0.createdAt) == localDay(now) }.map { ticketRow($0, now) }]) }
            if r.count == 2, r[0] == "tickets" {
                guard let t = tickets.first(where: { $0.id == r[1] }) else { return fail(404, "ticket_not_found", "Senha não encontrada.") }
                return ok(ticketRow(t, now))
            }
            if r == ["ws"] { return fail(400, "websocket_required", "Na demonstração a fila é lida por consulta.") }
            return fail(404, "not_found", "Recurso não encontrado.")
        }
        guard method == "POST" else { return fail(405, "method_not_allowed", "Método não permitido.") }
        guard let key, !key.isEmpty else { return fail(400, "idempotency_required", "Envie Idempotency-Key em toda escrita.") }
        let signature = "\(key)|\(r.joined(separator: "/"))|\(canonical(body))"
        if let replay = replies[signature] { return replay }
        if replies.keys.contains(where: { $0.hasPrefix("\(key)|") }) { return fail(409, "idempotency_conflict", "A mesma chave foi usada com outro pedido.") }
        let reply = write(r, body, now)
        if reply.status < 500 { replies[signature] = reply }
        return reply
    }

    private func write(_ r: [String], _ body: Row, _ now: Int64) -> Reply {
        if r == ["tickets"] {
            guard let queue = queues.first(where: { $0.id == body["queue_id"] as? String }) else { return fail(404, "queue_not_found", "Fila não encontrada.") }
            let source = body["source"] as? String ?? "kiosk"
            if !queue.channels.contains(source) && source != "staff" { return fail(409, "queue_closed", "Esta fila não recebe senhas por aqui.") }
            let preferential = body["preferential"] as? Bool ?? false
            return ok(ticketRow(issue(queue.id, preferential, source, now), now))
        }
        if r.count == 3, r[0] == "counters" {
            guard let counter = counters.first(where: { $0.id == r[1] }) else { return fail(404, "counter_not_found", "Guichê não encontrado.") }
            switch r[2] {
            case "state":
                guard let status = body["status"] as? String, ["open", "paused", "closed"].contains(status) else { return fail(422, "invalid", "Estado inválido.") }
                counter.status = status
                if status == "open" { counter.userId = DemoMode.meId; counter.userName = DemoMode.meName }
                if status == "closed" { counter.userId = nil; counter.userName = nil }
                return ok(counterRow(counter, now))
            case "call-next":
                guard counter.status == "open" else { return fail(409, "counter_closed", "Abra o guichê para chamar.") }
                if counter.userId == nil { counter.userId = DemoMode.meId; counter.userName = DemoMode.meName }
                guard let called = callNext(counter, now) else { return fail(404, "queue_empty", "Nenhuma senha aguardando nas filas deste guichê.") }
                return ok(ticketRow(called, now))
            default:
                return fail(404, "not_found", "Recurso não encontrado.")
            }
        }
        if r.count == 3, r[0] == "tickets" {
            guard let t = tickets.first(where: { $0.id == r[1] }) else { return fail(404, "ticket_not_found", "Senha não encontrada.") }
            let counter = counters.first { $0.id == t.counterId }
            let invalid = fail(409, "invalid_transition", "Esta ação não vale para a senha agora.")
            switch r[2] {
            case "recall":
                guard t.status == "called", let counter else { return invalid }
                t.callCount += 1
                t.calledAt = now
                announce(t, counter, now, recall: true)
            case "start":
                guard t.status == "called" else { return invalid }
                t.status = "serving"
                t.startedAt = now
            case "finish":
                guard t.status == "called" || t.status == "serving", let counter else { return invalid }
                finish(counter, now)
            case "no-show":
                guard t.status == "called" else { return invalid }
                t.status = "no_show"
                t.finishedAt = now
                counter?.current = nil
            case "cancel":
                guard ["waiting", "called", "serving"].contains(t.status) else { return invalid }
                t.status = "cancelled"
                t.finishedAt = now
                if counter?.current == t.id { counter?.current = nil }
            case "transfer":
                guard t.status == "called" || t.status == "serving" else { return invalid }
                let toQueue = (body["queue_id"] as? String).map { id in queues.first { $0.id == id } }
                let toCounter = (body["counter_id"] as? String).map { id in counters.first { $0.id == id } }
                if case .some(.none) = toQueue { return fail(404, "queue_not_found", "Fila não encontrada.") }
                if case .some(.none) = toCounter { return fail(404, "counter_not_found", "Guichê não encontrado.") }
                if (toQueue == nil) == (toCounter == nil) { return fail(422, "invalid", "Escolha uma fila ou um guichê.") }
                counter?.current = nil
                t.status = "waiting"
                t.counterId = nil
                if let q = toQueue ?? nil { t.queueId = q.id; t.reservedFor = nil }
                if let c = toCounter ?? nil { t.reservedFor = c.id }
            default:
                return fail(404, "not_found", "Recurso não encontrado.")
            }
            return ok(ticketRow(t, now))
        }
        return fail(404, "not_found", "Recurso não encontrado.")
    }

    /// A rota de capacidades com a fila ligada (o formato de docs/MODULOS.md, seção 6).
    private func capabilities(perArea: Bool) -> Reply {
        let modules: [Row] = [["id": "queue", "name": "Fila presencial", "version": "1.0.0"]]
        var answer: Row = [
            "capabilities_version": 1,
            "server": ["service": "wabotia", "version": "demonstração", "commit": ""],
            "features": ["modules"],
            "profiles": [["id": DemoMode.profileId, "name": DemoMode.profileName, "enabled": true, "modules": modules]],
        ]
        if perArea { answer["modules"] = modules }
        return ok(answer)
    }

    /// `POST /api/pairing/start`: um código fictício que se aprova sozinho na segunda consulta.
    private func pairingStart(_ body: Row) -> Reply {
        guard body["client"] as? String == "senhapp" else { return fail(422, "invalid", "Escolha Vinki, Fagoo ou Senhapp.") }
        guard let name = body["instance_name"] as? String, !name.trimmingCharacters(in: .whitespaces).isEmpty else {
            return fail(422, "invalid", "Informe o nome desta instalação (até 80 caracteres).")
        }
        seq += 1
        let device = "demo-device-\(seq)"
        pairingPolls[device] = 0
        return ok(["device_code": device, "user_code": Self.userCode, "verification_uri": "\(DemoMode.serverURL.absoluteString)/app?pair=1",
                   "expires_in": 600, "interval": 2, "client": "senhapp", "scopes": body["scopes"] ?? DeviceScopes.requested])
    }

    /// `POST /api/pairing/token`.
    private func pairingToken(_ body: Row) -> Reply {
        guard let device = body["device_code"] as? String, let polls = pairingPolls[device] else {
            return fail(400, "invalid_grant", "Solicitação de pareamento inválida.")
        }
        pairingPolls[device] = polls + 1
        if polls < 1 { return ok(["status": "authorization_pending", "interval": 2]) }
        pairingPolls[device] = nil
        return ok(["status": "connected", "access_token": Self.deviceToken, "token_type": "Bearer", "expires_in": 365 * 86_400,
                   "profile_id": DemoMode.profileId, "application_id": "demo-app", "scopes": DeviceScopes.requested,
                   "number_ids": [String](), "pool_ids": [String](), "bot_ids": [String]()])
    }

    // MARK: - Regras (versão curta das do servidor)

    private func issue(_ queueId: String, _ preferential: Bool, _ source: String, _ at: Int64) -> T {
        let q = queues.first { $0.id == queueId }!
        let number = (q.numbers[preferential] ?? 0) + 1
        q.numbers[preferential] = number
        let viaWhatsapp = source == "whatsapp"
        seq += 1
        var phone: String?
        if viaWhatsapp {
            phone = "552090000" + String(format: "%04d", phoneSeq)
            phoneSeq += 1
        }
        let t = T(id: "dt-\(seq)", queueId: queueId, code: (preferential ? q.preferential : q.normal) + String(format: "%03d", number),
                  preferential: preferential, source: source, phone: phone,
                  conversationId: viaWhatsapp && queueId == "dq-geral" && seq % 4 == 1 ? "c_queue" : nil, createdAt: at)
        tickets.append(t)
        return t
    }

    /// Ordem de chamada do contrato: reservada ao guichê, dívida de normais, preferencial e emissão.
    private func callNext(_ counter: C, _ at: Int64) -> T? {
        if let id = counter.current, let t = tickets.first(where: { $0.id == id }), t.status == "called" || t.status == "serving" { finish(counter, at) }
        let waiting = tickets.filter { $0.status == "waiting" && counter.queueIds.contains($0.queueId) && ($0.reservedFor == nil || $0.reservedFor == counter.id) }
        guard !waiting.isEmpty else { return nil }
        let oldest: ([T]) -> T? = { $0.min { $0.createdAt < $1.createdAt } }
        var pick = oldest(waiting.filter { $0.reservedFor == counter.id })
        if pick == nil {
            let candidates: [T] = Dictionary(grouping: waiting, by: \.queueId).compactMap { queueId, list in
                let q = queues.first { $0.id == queueId }!
                let normal = oldest(list.filter { !$0.preferential })
                let preferential = oldest(list.filter(\.preferential))
                if let normal, preferential == nil || q.normalsSincePreferential < Self.normalsPerPreferential { return normal }
                return preferential ?? normal
            }
            pick = oldest(candidates)
        }
        guard let t = pick else { return nil }
        let q = queues.first { $0.id == t.queueId }!
        q.normalsSincePreferential = t.preferential ? 0 : q.normalsSincePreferential + 1
        t.status = "called"
        t.counterId = counter.id
        t.reservedFor = nil
        t.callCount = 1
        t.calledAt = at
        counter.current = t.id
        announce(t, counter, at, recall: false)
        return t
    }

    private func finish(_ counter: C, _ at: Int64) {
        guard let t = tickets.first(where: { $0.id == counter.current }) else { return }
        if t.startedAt == nil { t.startedAt = t.calledAt ?? at }
        t.status = "done"
        t.finishedAt = at
        counter.current = nil
    }

    private func announce(_ t: T, _ counter: C, _ at: Int64, recall: Bool) {
        let q = queues.first { $0.id == t.queueId }!
        let digits = t.code.dropFirst().drop { $0 == "0" }
        calls.insert([
            "ticket_id": t.id, "code": t.code, "preferential": t.preferential, "queue_id": q.id, "queue_name": q.name,
            "counter_id": counter.id, "counter_name": counter.name, "call_count": t.callCount, "recall": recall, "at": at,
            "speech": "Senha \(t.code.prefix(1)) \(digits), \(counter.name)",
        ], at: 0)
        if calls.count > 10 { calls.removeLast(calls.count - 10) }
    }

    /// O dia anda sozinho: a atendente chama a próxima e chegam senhas pelo WhatsApp.
    private func tick(_ now: Int64) {
        var guardCount = 0
        while now >= nextAutoCall && guardCount < 3 {
            _ = callNext(counters[1], nextAutoCall)
            nextAutoCall += Self.autoCallMs
            guardCount += 1
        }
        if now >= nextAutoCall { nextAutoCall = now + Self.autoCallMs }
        guardCount = 0
        while now >= nextAutoIssue && guardCount < 3 {
            if tickets.filter({ $0.status == "waiting" }).count < 14 { _ = issue(seq % 3 == 0 ? "dq-retirada" : "dq-geral", seq % 4 == 0, "whatsapp", nextAutoIssue) }
            nextAutoIssue += Self.autoIssueMs
            guardCount += 1
        }
        if now >= nextAutoIssue { nextAutoIssue = now + Self.autoIssueMs }
    }

    // MARK: - Leitura

    private func overview(_ now: Int64) -> Row {
        [
            "day": localDay(now),
            "settings": ["front_door": true, "notify_ahead": 2],
            "queues": queues.map { q -> Row in
                let waiting = tickets.filter { $0.queueId == q.id && $0.status == "waiting" }
                let open = counters.filter { $0.status == "open" && $0.queueIds.contains(q.id) }.count
                let preferential = waiting.filter(\.preferential).count
                return ["id": q.id, "name": q.name, "prefix_normal": q.normal, "prefix_preferential": q.preferential, "preferential_notice": n(q.notice),
                        "normals_per_preferential": Self.normalsPerPreferential, "priority": 0, "wait_mode": "fixed", "service_minutes": Int(Self.serviceMinutes),
                        "channels": q.channels, "enabled": true, "waiting": ["normal": waiting.count - preferential, "preferential": preferential],
                        "wait_minutes": ["normal": wait(waiting.count, open), "preferential": wait(preferential, open)], "open_counters": open]
            },
            "counters": counters.map { counterRow($0, now) },
            "recent_calls": calls,
        ]
    }

    private func counterRow(_ c: C, _ now: Int64) -> Row {
        ["id": c.id, "name": c.name, "queue_ids": c.queueIds, "status": c.status, "enabled": true, "user_id": n(c.userId), "user_name": n(c.userName),
         "current": n(tickets.first { $0.id == c.current }.map { ticketRow($0, now) })]
    }

    private func ticketRow(_ t: T, _ now: Int64) -> Row {
        let q = queues.first { $0.id == t.queueId }!
        let before = tickets.filter { $0.queueId == q.id && $0.status == "waiting" && $0.createdAt < t.createdAt }
        let ahead = t.status != "waiting" ? 0 : (t.preferential ? before.filter(\.preferential).count : before.count)
        let open = counters.filter { $0.status == "open" && $0.queueIds.contains(q.id) }.count
        return [
            "id": t.id, "queue_id": q.id, "queue_name": q.name, "code": t.code, "preferential": t.preferential, "source": t.source,
            "status": t.status, "counter_id": n(t.counterId), "counter_name": n(counters.first { $0.id == t.counterId }?.name),
            "call_count": t.callCount, "ahead": ahead, "wait_minutes": n(t.status == "waiting" ? wait(ahead, open) : nil),
            "phone": n(t.phone), "conversation_id": n(t.conversationId), "window_open": n(t.phone.map { !$0.hasSuffix("7") }),
            "created_at": t.createdAt, "called_at": n(t.calledAt), "started_at": n(t.startedAt), "finished_at": n(t.finishedAt),
            "service_day": localDay(t.createdAt), "public_token": "demo\(t.id)",
            "whatsapp_link": "https://wa.me/\(Self.whatsappLine)?text=SENHA%20\(t.code)%20DEMO\(t.id.filter(\.isNumber))",
        ]
    }

    private func wait(_ ahead: Int, _ open: Int) -> Int { Int((Double(ahead) * Self.serviceMinutes / Double(max(1, open))).rounded(.up)) }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private func localDay(_ at: Int64) -> String { Self.dayFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(at) / 1000)) }

    private func canonical(_ body: Row) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func ok(_ value: Any) -> Reply { Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }

    private func fail(_ status: Int, _ code: String, _ message: String) -> Reply {
        Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
    }
}

/// Nulo do JSON para os campos opcionais.
private func n(_ value: Any?) -> Any { value ?? NSNull() }
