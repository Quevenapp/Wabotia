import Foundation

/*
 A ordem de serviço por modelo da demonstração, no mesmo desenho do Android (`demo/DemoWorkOrders.kt`): dois modelos
 fictícios — uma oficina mecânica (objeto do serviço: veículo; checklist com foto na entrada; o campo "Mecânico
 responsável" é pedido a partir da etapa "Pronto") e uma assistência de celulares (sem objeto, com um campo restrito que
 o app nunca mostra) — com as mesmas recusas do servidor (`reason_required`, `checklist_required`, `missing_fields`,
 `photo_required`, `version_conflict`, `order_closed`, `object_required`). Tudo em memória, na fila do `DemoServer`;
 nada sai do aparelho. Placas e IMEIs de exemplo, telefones 552090….
 */
final class DemoWorkOrders {
    typealias Row = [String: Any]

    private struct Stage { let id: String, label: String, base: String; var checklist: [Row] = [] }
    private struct Transition { let id: String, from: String, to: String, label: String }
    private struct Rule { let fieldId: String, fromStage: String? }
    private struct WType {
        let id: String, singular: String, plural: String, item: String, problem: String, prefix: String
        let fields: [Row]
        let stages: [Stage]
        let transitions: [Transition]
        let rules: [Rule]
        let objectTypeId: String?
        var initial: String { stages[0].id }
        func stage(_ id: String?) -> Stage? { stages.first { $0.id == id } }
    }

    private final class Obj {
        let id: String, contactId: String, typeId: String
        var values: Row
        var version = 1
        let created: Int64
        init(id: String, contactId: String, typeId: String, values: Row, created: Int64) {
            self.id = id; self.contactId = contactId; self.typeId = typeId; self.values = values; self.created = created
        }
    }

    private final class Doc {
        let id: String, orderId: String, mime: String, expected: Int
        var version = 1
        var attempt: String?
        var bytes: Data?
        var ready = false
        init(id: String, orderId: String, mime: String, expected: Int) { self.id = id; self.orderId = orderId; self.mime = mime; self.expected = expected }
    }

    private final class Order {
        let id: String
        let type: WType
        let number: Int
        var stage: String
        let customerName: String, phone: String?, contactId: String?, conversationId: String?
        let item: String, problem: String, notes: String
        var extra: Row
        let object: Row?
        let created: Int64
        var version = 1
        var updated: Int64
        var dueAt: Int64?
        var quote: Row?
        var quoteSentAt: Int64?
        var decision: Row?
        var marks: [String: [String: Row]] = [:]
        var history: [Row] = []
        init(id: String, type: WType, number: Int, customerName: String, phone: String?, contactId: String?, conversationId: String?,
             item: String, problem: String, notes: String, extra: Row, object: Row?, created: Int64) {
            self.id = id; self.type = type; self.number = number; self.stage = type.initial; self.customerName = customerName; self.phone = phone
            self.contactId = contactId; self.conversationId = conversationId; self.item = item; self.problem = problem; self.notes = notes
            self.extra = extra; self.object = object; self.created = created; self.updated = created; self.dueAt = created + 5 * DemoWorkOrders.day
        }
        var base: String { type.stage(stage)?.base ?? "received" }
        var closed: Bool { base == "delivered" || base == "cancelled" }
    }

    static let day: Int64 = 86_400_000
    static let rank: [String: Int] = ["received": 0, "analyzing": 1, "quoted": 2, "approved": 3, "declined": 3, "in_progress": 4, "ready": 5, "delivered": 6, "cancelled": 7]
    static let builtinId = "service_order"

    private let profileId: String
    private let contactOf: (String) -> (name: String, phone: String?)?
    private let objectType: Row
    private let types: [WType]
    private var objects: [Obj] = []
    private var orders: [Order] = []
    private var docs: [Doc] = []
    private var replies: [String: DemoServer.Reply] = [:]
    private var seq = 0

    private static func field(_ id: String, _ label: String, _ kind: String, required: Bool = false, sensitive: Bool = false, _ extra: Row = [:]) -> Row {
        var row: Row = ["id": id, "label": label, "help": "", "required": required, "client_visible": false, "sensitive": sensitive, "kind": kind]
        for (k, v) in extra { row[k] = v }
        return row
    }

    private static func item(_ id: String, _ label: String, required: Bool = false, photo: Bool = false) -> Row {
        ["id": id, "label": label, "required": required, "photo_required": photo]
    }

    init(t0: Int64, profileId: String = "demo", contactOf: @escaping (String) -> (name: String, phone: String?)?) {
        self.profileId = profileId
        self.contactOf = contactOf
        objectType = [
            "schema_version": 1, "id": "veiculo", "revision": 1, "archived": false,
            "labels": ["singular": "Veículo", "plural": "Veículos"], "identifier_field_id": "placa",
            "fields": [
                Self.field("placa", "Placa", "text", required: true, ["multiline": false, "max_length": 8]),
                Self.field("modelo", "Modelo", "text", ["multiline": false, "max_length": 60]),
                Self.field("ano", "Ano", "integer", ["min": 1950, "max": 2030]),
            ],
            "retired_field_ids": [String](),
        ]
        let oficina = WType(
            id: "oficina", singular: "Ordem da oficina", plural: "Oficina", item: "Serviço pedido", problem: "Relato do cliente", prefix: "OF",
            fields: [
                Self.field("km_entrada", "Quilometragem na entrada", "integer", ["min": 0, "max": 2_000_000]),
                Self.field("combustivel", "Combustível na entrada", "choice", ["options": [
                    ["id": "reserva", "label": "Na reserva"], ["id": "meio", "label": "Meio tanque"], ["id": "cheio", "label": "Cheio"],
                ]]),
                Self.field("revisao_garantia", "Revisão na garantia de fábrica", "boolean"),
                Self.field("previsao", "Previsão de entrega", "date", ["min": NSNull(), "max": NSNull()]),
                Self.field("mecanico", "Mecânico responsável", "text", ["multiline": false, "max_length": 60]),
            ],
            stages: [
                Stage(id: "recebido", label: "Recebido", base: "received", checklist: [
                    Self.item("foto_painel", "Foto do painel com a quilometragem", required: true, photo: true),
                    Self.item("objetos", "Conferir objetos deixados no carro", required: true),
                ]),
                Stage(id: "diagnostico", label: "Diagnóstico", base: "analyzing"),
                Stage(id: "execucao", label: "Em execução", base: "in_progress", checklist: [
                    Self.item("teste_rodagem", "Teste de rodagem", required: true),
                    Self.item("lavagem", "Lavagem cortesia"),
                ]),
                Stage(id: "pronto", label: "Pronto", base: "ready"),
                Stage(id: "entregue", label: "Entregue", base: "delivered"),
                Stage(id: "cancelada", label: "Cancelada", base: "cancelled"),
            ],
            transitions: [
                Transition(id: "t-diag", from: "recebido", to: "diagnostico", label: "Começar diagnóstico"),
                Transition(id: "t-exec", from: "diagnostico", to: "execucao", label: "Começar o serviço"),
                Transition(id: "t-volta-receb", from: "diagnostico", to: "recebido", label: "Voltar para recebido"),
                Transition(id: "t-pronto", from: "execucao", to: "pronto", label: "Serviço pronto"),
                Transition(id: "t-retrabalho", from: "pronto", to: "execucao", label: "Retrabalho"),
                Transition(id: "t-entregue", from: "pronto", to: "entregue", label: "Entregar ao cliente"),
                Transition(id: "t-cancel-1", from: "recebido", to: "cancelada", label: "Cancelar"),
                Transition(id: "t-cancel-2", from: "diagnostico", to: "cancelada", label: "Cancelar"),
                Transition(id: "t-cancel-3", from: "execucao", to: "cancelada", label: "Cancelar"),
                Transition(id: "t-cancel-4", from: "pronto", to: "cancelada", label: "Cancelar"),
            ],
            rules: [Rule(fieldId: "mecanico", fromStage: "pronto")],
            objectTypeId: "veiculo")
        let celulares = WType(
            id: "celulares", singular: "Ordem de assistência", plural: "Assistência de celulares", item: "Aparelho", problem: "Defeito relatado", prefix: "CEL",
            fields: [
                Self.field("imei", "IMEI", "text", ["multiline": false, "max_length": 20]),
                Self.field("senha_desbloqueio", "Senha de desbloqueio", "text", sensitive: true, ["multiline": false, "max_length": 30]),
                Self.field("acessorios", "Acessórios deixados", "text", ["multiline": true, "max_length": 200]),
                Self.field("backup", "Cliente fez backup", "boolean", required: true),
            ],
            stages: [
                Stage(id: "entrada", label: "Entrada", base: "received"),
                Stage(id: "reparo", label: "Em reparo", base: "in_progress", checklist: [
                    Self.item("tela", "Testar tela e toque", required: true),
                    Self.item("camera", "Testar câmera e áudio", required: true),
                ]),
                Stage(id: "pronto", label: "Pronto para retirar", base: "ready"),
                Stage(id: "entregue", label: "Entregue", base: "delivered"),
                Stage(id: "cancelada", label: "Cancelada", base: "cancelled"),
            ],
            transitions: [
                Transition(id: "c-reparo", from: "entrada", to: "reparo", label: "Começar o reparo"),
                Transition(id: "c-pronto", from: "reparo", to: "pronto", label: "Reparo pronto"),
                Transition(id: "c-volta", from: "pronto", to: "reparo", label: "Voltar ao reparo"),
                Transition(id: "c-entregue", from: "pronto", to: "entregue", label: "Entregar"),
                Transition(id: "c-cancel-1", from: "entrada", to: "cancelada", label: "Cancelar"),
                Transition(id: "c-cancel-2", from: "reparo", to: "cancelada", label: "Cancelar"),
                Transition(id: "c-cancel-3", from: "pronto", to: "cancelada", label: "Cancelar"),
            ],
            rules: [],
            objectTypeId: nil)
        types = [oficina, celulares]

        let c1 = "ct_c_rich", c2 = "ct_c_5h", c3 = "ct_c_closed"
        objects = [
            Obj(id: "obj-1", contactId: c1, typeId: "veiculo", values: ["placa": "ABC1D23", "modelo": "Hatch Exemplo 1.0", "ano": 2019], created: t0 - 40 * Self.day),
            Obj(id: "obj-2", contactId: c2, typeId: "veiculo", values: ["placa": "XYZ9E87", "modelo": "Sedã Exemplo 2.0", "ano": 2016], created: t0 - 90 * Self.day),
            Obj(id: "obj-3", contactId: c2, typeId: "veiculo", values: ["placa": "EXE4M56", "modelo": "Utilitário Exemplo", "ano": 2022], created: t0 - 10 * Self.day),
            Obj(id: "obj-4", contactId: c3, typeId: "veiculo", values: ["placa": "DEM0A12", "modelo": "Picape Exemplo", "ano": 2020], created: t0 - 30 * Self.day),
        ]
        let mariana = contactOf(c1) ?? (name: "Mariana Costa", phone: Optional("5520908765432"))
        let joao = contactOf(c2) ?? (name: "João Pedro Almeida", phone: Optional("5520906543210"))
        let aline = contactOf(c3) ?? (name: "Aline Barbosa", phone: Optional("5520904445566"))

        @discardableResult
        func seed(_ type: WType, _ stage: String, _ conversation: String?, _ contact: String?, _ customer: (name: String, phone: String?), _ item: String, _ problem: String,
                  ago: Int64, extra: Row, object: String? = nil) -> Order {
            let created = t0 - ago * Self.day - 3_600_000
            let number = orders.filter { $0.type.id == type.id }.count + 1
            let snapshot = object.flatMap { id in objects.first { $0.id == id } }.map { snapshotOf($0, at: created) }
            let o = Order(id: "wo-\(type.prefix.lowercased())-\(number)", type: type, number: number, customerName: customer.name, phone: customer.phone,
                          contactId: contact, conversationId: conversation, item: item, problem: problem, notes: "", extra: extra, object: snapshot, created: created)
            o.history.append(history("opened", nil, nil, nil, type.stage(type.initial)?.base, at: created))
            moveSeed(o, to: stage, at: created + Self.day)
            orders.append(o)
            return o
        }
        seed(oficina, "recebido", "c_rich", c1, mariana, "Revisão dos 60 mil km", "Barulho na suspensão dianteira ao passar em lombada.", ago: 0,
             extra: ["km_entrada": 60_250, "combustivel": "meio", "revisao_garantia": false], object: "obj-1")
        let freios = seed(oficina, "diagnostico", "c_5h", c2, joao, "Freios", "Pedal do freio baixo e chiado ao frear.", ago: 2,
                          extra: ["km_entrada": 132_400, "combustivel": "reserva"], object: "obj-2")
        freios.quote = quote([("Pastilhas de freio (par)", 1, 18_000), ("Fluido de freio", 1, 4_500), ("Mão de obra", 1, 12_000)])
        let oleo = seed(oficina, "execucao", nil, c2, joao, "Troca de óleo e filtros", "Revisão preventiva.", ago: 4,
                        extra: ["km_entrada": 48_900, "combustivel": "cheio", "revisao_garantia": true, "previsao": BrasiliaTime.day(t0 + Self.day)], object: "obj-3")
        oleo.quote = quote([("Óleo 5W30 (litro)", 4, 4_200), ("Filtro de óleo", 1, 3_500)])
        oleo.quoteSentAt = oleo.created + Self.day / 2
        oleo.decision = ["decision": "approved", "at": oleo.created + Self.day, "by": "customer", "via": "whatsapp"]
        oleo.marks["execucao"] = ["lavagem": ["done": true, "photo_document_id": NSNull(), "by": DemoMode.meId, "at": oleo.created + 2 * Self.day]]
        seed(oficina, "pronto", "c_closed", c3, aline, "Alinhamento e balanceamento", "Volante puxando para a direita.", ago: 6,
             extra: ["km_entrada": 75_000, "mecanico": "Carlos Pereira"], object: "obj-4")
        seed(oficina, "entregue", nil, c1, mariana, "Troca da bateria", "Carro não pegava de manhã.", ago: 25,
             extra: ["km_entrada": 55_100, "mecanico": "Carlos Pereira"], object: "obj-1")
        let tela = seed(celulares, "reparo", "c_closed", c3, aline, "Celular Exemplo X", "Tela trincada e touch falhando no canto.", ago: 1,
                        extra: ["imei": "000000000000001", "acessorios": "Capinha transparente", "backup": true, "senha_desbloqueio": "000000"])
        tela.marks["reparo"] = ["tela": ["done": true, "photo_document_id": NSNull(), "by": DemoMode.meId, "at": tela.created + Self.day]]
        seed(celulares, "entrada", nil, nil, (name: "Gustavo Lima", phone: Optional("5520907771234")),"Celular Exemplo Mini", "Não carrega.", ago: 0, extra: ["backup": false])
    }

    // MARK: Respostas

    private func ok(_ value: Any, status: Int = 200) -> DemoServer.Reply {
        DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data())
    }

    private func fail(_ status: Int, _ code: String, _ message: String) -> DemoServer.Reply {
        DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
    }

    private func replay(_ key: String?, _ path: [String], _ body: Row, _ write: () -> DemoServer.Reply) -> DemoServer.Reply {
        guard let key, !key.isEmpty else { return fail(400, "idempotency_required", "Envie Idempotency-Key em toda escrita.") }
        let canonical = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let signature = "\(key)|\(path.joined(separator: "/"))|\(canonical)"
        if let reply = replies[signature] { return reply }
        if replies.keys.contains(where: { $0.hasPrefix("\(key)|") }) { return fail(409, "idempotency_conflict", "A mesma chave foi usada com outro pedido.") }
        let reply = write()
        if reply.status < 500 { replies[signature] = reply }
        return reply
    }

    // MARK: Leitura

    /// O catálogo: a ordem simples e os dois modelos.
    func catalog(builtin: Row) -> Row { ["data": [builtin] + types.map(typeJSON), "settings_revision": "demo-1"] }

    /// Reconhece as rotas da ordem por modelo (o primeiro segmento depois de `service-orders`).
    func handles(_ first: String) -> Bool { ["types", "object-types", "objects"].contains(first) || orders.contains { $0.id == first } }

    func ownsType(_ typeId: String?) -> Bool { types.contains { $0.id == typeId } }

    /// As ordens da lista com os filtros do servidor (`type_id`, `type_ids`, `stage`, `open`, `status`, `q`).
    func list(_ query: [String: String]) -> [(created: Int64, row: Row)] {
        let typeId = query["type_id"]
        let typeIds = query["type_ids"].map { Set($0.split(separator: ",").map(String.init)) }
        let statuses = Set((query["status"] ?? "").split(separator: ",").map(String.init))
        let q = (query["q"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return orders.filter { o in
            (typeId == nil || o.type.id == typeId) && (typeIds == nil || typeIds!.contains(o.type.id))
                && (query["stage"] == nil || o.stage == query["stage"]) && (statuses.isEmpty || statuses.contains(o.base))
                && (query["open"] != "1" || !o.closed)
                && (q.isEmpty || [displayNumber(o), String(o.number), o.customerName, o.item, identifier(o)].contains { $0.lowercased().contains(q) })
        }.map { ($0.created, row($0)) }
    }

    func route(method: String, r: [String], body: Row, query: [String: String], key: String?, now: Int64, emit: DemoEmit, builtin: Row) -> DemoServer.Reply {
        if method == "GET" { return read(r, query, builtin: builtin) }
        return replay(key, r, body) { write(method, r, body, now, emit) }
    }

    private func read(_ r: [String], _ query: [String: String], builtin: Row) -> DemoServer.Reply {
        switch r[0] {
        case "types":
            if r.count == 1 { return ok(catalog(builtin: builtin)) }
            if r[1] == Self.builtinId { return ok(builtin) }
            guard let t = types.first(where: { $0.id == r[1] }) else { return fail(404, "not_found", "Modelo não encontrado.") }
            return ok(typeJSON(t))
        case "object-types":
            return ok(["data": [objectType], "settings_revision": "demo-1"])
        case "objects":
            guard let contact = query["contact_id"] else { return fail(400, "invalid_request", "Informe contact_id.") }
            let list = objects.filter { $0.contactId == contact && (query["type_id"] == nil || $0.typeId == query["type_id"]) }.sorted { $0.created > $1.created }
            return ok(["data": list.map(objectJSON), "next_cursor": NSNull()])
        default:
            break
        }
        guard let o = orders.first(where: { $0.id == r[0] }) else { return fail(404, "not_found", "Ordem não encontrada.") }
        let tail = Array(r.dropFirst())
        switch tail {
        case []: return ok(row(o))
        case ["history"]: return ok(["data": o.history, "next_cursor": NSNull()])
        case ["requirements"]:
            guard let t = o.type.transitions.first(where: { $0.id == query["transition_id"] && $0.from == o.stage }) else {
                return fail(404, "not_found", "Mudança de etapa não encontrada. Atualize a ordem.")
            }
            let required = requiredFor(o.type, stage: t.to)
            return ok(["id": o.id, "version": o.version, "transition_id": t.id,
                       "required": required.map { ["field_id": $0["id"] ?? "", "label": $0["label"] ?? ""] },
                       "missing": required.filter { isEmpty(o.extra[$0["id"] as? String ?? ""]) }.map { ["field_id": $0["id"] ?? "", "label": $0["label"] ?? ""] },
                       "internal_missing": false])
        default:
            if tail.count == 3, tail[0] == "documents", tail[2] == "content" {
                guard let doc = docs.first(where: { $0.id == tail[1] && $0.orderId == o.id && $0.ready }) else { return fail(404, "not_found", "Documento não encontrado.") }
                return DemoServer.Reply(status: 200, data: doc.bytes ?? Data(), type: doc.mime)
            }
            return fail(404, "not_found", "Recurso não encontrado.")
        }
    }

    // MARK: Escrita

    private func write(_ method: String, _ r: [String], _ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        if method == "POST", r.isEmpty { return create(body, now, emit) }
        guard let o = orders.first(where: { $0.id == r.first }) else { return fail(404, "not_found", "Ordem não encontrada.") }
        let tail = Array(r.dropFirst())
        if tail.first == "documents" { return documents(o, method, Array(tail.dropFirst()), body, now) }
        let version = (body["version"] as? NSNumber)?.intValue
        let visible = Set(o.type.fields.filter { $0["sensitive"] as? Bool != true }.compactMap { $0["id"] as? String })
        switch (method, tail) {
        case ("PATCH", []):
            guard version == o.version else { return conflict() }
            if o.closed { return fail(400, "immutable_field", "Trabalho encerrado: somente observações internas.") }
            guard let extra = body["extra"] as? Row else { return fail(400, "invalid_request", "Informe extra.") }
            if extra.keys.contains(where: { !visible.contains($0) }) { return fail(400, "invalid_fields", "Campo desconhecido neste modelo.") }
            for (k, v) in extra { if v is NSNull { o.extra.removeValue(forKey: k) } else { o.extra[k] = v } }
            commit(o, now, history("os.updated", nil, nil, o.base, o.base, at: now))
            emit("os.updated", ["order_id": o.id, "version": o.version, "module_id": "os"])
        case ("POST", ["stage"]):
            guard version == o.version else { return conflict() }
            if o.closed { return fail(409, "order_closed", "A ordem está encerrada: não muda mais.") }
            guard let t = o.type.transitions.first(where: { $0.id == body["transition_id"] as? String && $0.from == o.stage }), let target = o.type.stage(t.to) else {
                return fail(409, "invalid_transition", "Esta mudança de etapa não vale para a ordem agora.")
            }
            let note = (body["note"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let backward = target.base != "cancelled" && (Self.rank[target.base] ?? 0) < (Self.rank[o.base] ?? 0)
            if (target.base == "cancelled" || backward) && note.isEmpty {
                return fail(422, "reason_required", target.base == "cancelled" ? "Informe o motivo do cancelamento. Ele fica no histórico da ordem." : "Informe o motivo para voltar a etapa. Ele fica no histórico da ordem.")
            }
            if target.base != "cancelled" && !backward, let current = o.type.stage(o.stage) {
                let missing = missingOf(o, current)
                if !missing.isEmpty { return fail(409, "checklist_required", "Antes de passar para \"\(target.label)\", marque no checklist da etapa \"\(current.label)\": \(missing.joined(separator: ", ")).") }
                let fields = requiredFor(o.type, stage: target.id).filter { isEmpty(o.extra[$0["id"] as? String ?? ""]) }
                if !fields.isEmpty { return fail(409, "missing_fields", "Preencha os campos: \(fields.compactMap { $0["label"] as? String }.joined(separator: ", ")).") }
            }
            let from = o.stage, fromBase = o.base
            o.stage = target.id
            commit(o, now, history("os.stage_changed", from, target.id, fromBase, target.base, at: now, note: note))
            emit("os.stage_changed", ["order_id": o.id, "version": o.version, "from": from, "to": target.id, "module_id": "os"])
        case ("POST", ["checklist"]):
            guard version == o.version else { return conflict() }
            if o.closed { return fail(409, "order_closed", "A ordem está encerrada: o checklist não muda mais.") }
            guard let stage = o.type.stage(o.stage), !stage.checklist.isEmpty else { return fail(409, "checklist_unavailable", "A etapa atual desta ordem não tem checklist no modelo.") }
            guard let item = stage.checklist.first(where: { $0["id"] as? String == body["item_id"] as? String }), let itemId = item["id"] as? String else {
                return fail(404, "not_found", "Item do checklist não encontrado na etapa atual. Atualize a ordem.")
            }
            guard let done = body["done"] as? Bool else { return fail(400, "invalid_request", "Informe done: true para marcar ou false para desmarcar.") }
            let photo = body["photo_document_id"] as? String
            if let photo, !docs.contains(where: { $0.id == photo && $0.orderId == o.id && $0.ready }) {
                return fail(404, "photo_not_found", "A foto não está nos documentos desta ordem. Anexe a foto em Documentos e escolha de novo.")
            }
            let label = item["label"] as? String ?? ""
            if done, item["photo_required"] as? Bool == true, photo == nil { return fail(422, "photo_required", "\"\(label)\" pede foto: anexe a foto em Documentos e escolha-a ao marcar.") }
            o.marks[stage.id, default: [:]][itemId] = ["done": done, "photo_document_id": done ? (photo ?? NSNull()) as Any : NSNull(), "by": DemoMode.meId, "at": now]
            let note = "Checklist (\(stage.label)): \(label) \(done ? "feito" : "desmarcado")\(done && photo != nil ? " · com foto" : "")"
            commit(o, now, history("os.checklist_marked", nil, nil, o.base, o.base, at: now, note: note))
            emit("os.updated", ["order_id": o.id, "version": o.version, "module_id": "os"])
        case ("POST", ["quote", "send"]):
            guard o.quote != nil else { return fail(409, "invalid_transition", "Monte o orçamento no painel antes de enviar.") }
            guard o.conversationId != nil else { return fail(409, "no_conversation", "Esta ordem não está ligada a uma conversa.") }
            o.quoteSentAt = now
            commit(o, now, history("quote", nil, nil, o.base, "quoted", at: now))
            emit("os.quoted", ["order_id": o.id, "version": o.version, "module_id": "os"])
        default:
            return fail(404, "not_found", "Recurso não encontrado.")
        }
        return ok(row(o))
    }

    private func create(_ body: Row, _ now: Int64, _ emit: DemoEmit) -> DemoServer.Reply {
        guard let type = types.first(where: { $0.id == body["type_id"] as? String }) else { return fail(404, "not_found", "Modelo não encontrado.") }
        let item = (body["item"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        let problem = (body["problem"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        guard !item.isEmpty, !problem.isEmpty else { return fail(400, "invalid_request", "Informe \(type.item.lowercased()) e \(type.problem.lowercased()).") }
        let extra = body["extra"] as? Row ?? [:]
        let visible = Set(type.fields.filter { $0["sensitive"] as? Bool != true }.compactMap { $0["id"] as? String })
        if extra.keys.contains(where: { !visible.contains($0) }) { return fail(400, "invalid_fields", "Campo desconhecido neste modelo.") }
        let opening = requiredFor(type, stage: type.initial).filter { isEmpty(extra[$0["id"] as? String ?? ""]) }
        if !opening.isEmpty { return fail(409, "missing_fields", "Preencha os campos: \(opening.compactMap { $0["label"] as? String }.joined(separator: ", ")).") }
        let conversation = body["conversation_id"] as? String
        let objectBody = body["object"] as? Row
        if type.objectTypeId == nil, objectBody != nil { return fail(400, "invalid_fields", "Este modelo não utiliza objeto do serviço.") }
        if type.objectTypeId != nil, objectBody == nil { return fail(409, "object_required", "Selecione ou cadastre o objeto do serviço.") }
        let contactId = body["contact_id"] as? String ?? conversation.map { "ct_\($0)" }
        var obj: Obj?
        if let objectBody {
            guard let contactId, contactOf(contactId) != nil else {
                return fail(409, "customer_required", "Confirme o contato do cliente no cadastro compartilhado antes de selecionar o objeto.")
            }
            switch objectBody["mode"] as? String {
            case "existing":
                guard let found = objects.first(where: { $0.id == objectBody["id"] as? String && $0.contactId == contactId }) else {
                    return fail(409, "object_definition_conflict", "O objeto não corresponde ao cliente e ao modelo desta abertura. Atualize a seleção.")
                }
                guard (objectBody["version"] as? NSNumber)?.intValue == found.version else { return fail(409, "object_definition_conflict", "O objeto mudou. Atualize a seleção.") }
                obj = found
            case "new":
                let values = objectBody["values"] as? Row ?? [:]
                if isEmpty(values["placa"]) { return fail(409, "missing_fields", "Preencha os campos: Placa.") }
                let created = Obj(id: "obj-\(objects.count + 1)", contactId: contactId, typeId: "veiculo", values: values, created: now)
                objects.append(created)
                obj = created
            default:
                return fail(400, "invalid_request", "object.mode: existing ou new.")
            }
        }
        let fromConversation = conversation.flatMap { DemoAgenda.conversationNames($0) }
        let fromContact = contactId.flatMap(contactOf)
        let name = fromConversation ?? fromContact?.name ?? (body["customer_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        var phone = conversation.flatMap { DemoAgenda.conversationPhones($0) } ?? fromContact?.phone
        if phone == nil, let raw = body["phone"] as? String {
            let digits = raw.filter(\.isNumber)
            phone = digits.count <= 11 ? "55" + digits : digits
        }
        guard name != nil || (phone ?? "").isEmpty == false else { return fail(400, "invalid_request", "Informe o cliente: conversa, cadastro ou telefone.") }
        let number = orders.filter { $0.type.id == type.id }.count + 1
        let o = Order(id: "wo-\(type.prefix.lowercased())-\(number)", type: type, number: number, customerName: name ?? "Cliente", phone: phone,
                      contactId: contactId, conversationId: conversation, item: item, problem: problem, notes: body["notes"] as? String ?? "",
                      extra: extra.filter { !($0.value is NSNull) }, object: obj.map { snapshotOf($0, at: now) }, created: now)
        o.history.append(history("opened", nil, nil, nil, type.stage(type.initial)?.base, at: now))
        orders.append(o)
        emit("os.opened", ["order_id": o.id, "conversation_id": conversation ?? NSNull(), "actor": DemoMode.meId, "module_id": "os"])
        return ok(row(o), status: 201)
    }

    /// Reserva e conclusão de um documento da ordem (os bytes chegam por `upload`).
    private func documents(_ o: Order, _ method: String, _ r: [String], _ body: Row, _ now: Int64) -> DemoServer.Reply {
        if r.isEmpty, method == "POST" {
            let mime = (body["mime_type"] as? String ?? "").lowercased()
            guard ["image/jpeg", "image/png", "application/pdf"].contains(mime) else { return fail(415, "unsupported_media_type", "Documento: unsupported_media_type.") }
            let bytes = (body["expected_bytes"] as? NSNumber)?.intValue ?? 0
            guard bytes > 0 else { return fail(400, "invalid_request", "expected_bytes: inteiro positivo obrigatório.") }
            guard bytes <= 10 * 1024 * 1024 else { return fail(413, "document_too_large", "Documento: document_too_large.") }
            guard body["client_visible"] is Bool, body["sensitive"] is Bool else { return fail(400, "invalid_request", "client_visible e sensitive: booleanos obrigatórios.") }
            seq += 1
            let doc = Doc(id: "doc-\(seq)", orderId: o.id, mime: mime, expected: bytes)
            docs.append(doc)
            return ok(["id": doc.id, "order_id": o.id, "version": doc.version,
                       "upload_url": "/api/v1/profiles/\(profileId)/service-orders/\(o.id)/documents/\(doc.id)/content", "expires_at": now + 15 * 60_000], status: 201)
        }
        if r.count == 2, r[1] == "complete", method == "POST" {
            guard let doc = docs.first(where: { $0.id == r[0] && $0.orderId == o.id }) else { return fail(404, "not_found", "Documento não encontrado.") }
            if doc.ready { return ok(["id": doc.id, "order_id": o.id, "version": doc.version]) }
            guard doc.bytes != nil else { return fail(409, "upload_incomplete", "Documento: upload_incomplete.") }
            guard (body["version"] as? NSNumber)?.intValue == doc.version, body["upload_attempt"] as? String == doc.attempt else { return fail(409, "version_conflict", "Documento: version_conflict.") }
            doc.ready = true
            doc.version += 1
            return ok(["id": doc.id, "order_id": o.id, "version": doc.version])
        }
        return fail(404, "not_found", "Recurso não encontrado.")
    }

    /// `PUT service-orders/{id}/documents/{doc}/content`: corpo binário e o cabeçalho `Upload-Version`.
    func upload(_ r: [String], data: Data, uploadVersion: String?, key: String?) -> DemoServer.Reply {
        guard let key, !key.isEmpty else { return fail(400, "invalid_request", "Envie Idempotency-Key (até 200 caracteres ASCII).") }
        _ = key
        guard r.count == 4, let o = orders.first(where: { $0.id == r[0] }) else { return fail(404, "not_found", "Ordem não encontrada.") }
        guard let doc = docs.first(where: { $0.id == r[2] && $0.orderId == o.id }) else { return fail(404, "not_found", "Documento não encontrado.") }
        guard Int(uploadVersion ?? "") == doc.version else { return fail(400, "invalid_request", "Envie Upload-Version inteiro positivo.") }
        guard data.count == doc.expected else { return fail(409, "content_mismatch", "Documento: content_mismatch.") }
        if doc.bytes == nil {
            doc.bytes = data
            doc.attempt = "att-\(doc.id)"
        }
        return ok(["id": doc.id, "version": doc.version, "upload_attempt": doc.attempt ?? "", "byte_length": data.count, "sha256": ""])
    }

    // MARK: Montagem

    private func commit(_ o: Order, _ now: Int64, _ entry: Row) {
        o.version += 1
        o.updated = now
        o.history.append(entry)
    }

    private func conflict() -> DemoServer.Reply { fail(409, "version_conflict", "A ordem mudou desde a última leitura. Atualize e tente de novo.") }

    private func moveSeed(_ o: Order, to target: String, at: Int64) {
        var step: Int64 = 0
        while o.stage != target, step < 10 {
            step += 1
            guard let t = o.type.transitions.first(where: { t in
                guard let to = o.type.stage(t.to) else { return false }
                return t.from == o.stage && to.base != "cancelled" && t.to != "recebido" && (Self.rank[to.base] ?? 0) >= (Self.rank[o.base] ?? 0)
            }) else { break }
            if let stage = o.type.stage(o.stage) {
                for item in stage.checklist { if let id = item["id"] as? String { o.marks[stage.id, default: [:]][id] = ["done": true, "photo_document_id": NSNull(), "by": DemoMode.meId, "at": at] } }
            }
            let from = o.stage, fromBase = o.base
            o.stage = t.to
            o.version += 1
            o.history.append(history("os.stage_changed", from, t.to, fromBase, o.base, at: at + step * 3_600_000))
        }
    }

    private func history(_ kind: String, _ fromStage: String?, _ toStage: String?, _ fromStatus: String?, _ toStatus: String?, at: Int64, note: String = "") -> Row {
        seq += 1
        return ["id": "wh-\(seq)", "kind": kind, "from_status": fromStatus ?? NSNull(), "to_status": toStatus ?? NSNull(), "from_stage": fromStage ?? NSNull(),
                "to_stage": toStage ?? NSNull(), "actor": DemoMode.meId, "note": note, "created": at, "changed_fields": [String]()]
    }

    private func quote(_ items: [(String, Double, Int)]) -> Row {
        let list: [Row] = items.map { item in
            seq += 1
            return ["id": "qi-\(seq)", "description": item.0, "quantity": item.1, "unit_cents": item.2, "kind": "service"]
        }
        let total = items.reduce(0) { $0 + Int((Double($1.2) * $1.1).rounded()) }
        return ["items": list, "total_cents": total, "note": "", "valid_days": 7, "version": 1, "expired": false,
                "subtotal_cents": total, "items_discount_cents": 0, "discount_cents": 0]
    }

    private func displayNumber(_ o: Order) -> String { "\(o.type.prefix)-\(o.number)" }

    private func identifier(_ o: Order) -> String { o.object?["identifier"] as? String ?? "" }

    private func snapshotOf(_ obj: Obj, at: Int64) -> Row {
        ["schema_version": 1, "object_id": obj.id, "object_version": obj.version, "captured_at": at, "origin": "opening",
         "type": objectType, "values": obj.values, "identifier": obj.values["placa"] as? String ?? ""]
    }

    private func objectJSON(_ obj: Obj) -> Row {
        ["id": obj.id, "contact_id": obj.contactId, "type_id": obj.typeId, "type_revision": 1, "type": objectType, "values": obj.values,
         "archived": false, "version": obj.version, "identifier": obj.values["placa"] as? String ?? "", "created": obj.created, "updated": obj.created,
         "latest_completed": NSNull()]
    }

    /// Campos que a etapa pede: obrigatórios do modelo e regras a partir de uma etapa até ela (na ordem do modelo).
    private func requiredFor(_ type: WType, stage: String) -> [Row] {
        let index = type.stages.firstIndex { $0.id == stage } ?? -1
        let byRule = Set(type.rules.filter { rule in
            guard let from = rule.fromStage, let i = type.stages.firstIndex(where: { $0.id == from }) else { return false }
            return i <= index
        }.map(\.fieldId))
        return type.fields.filter { f in
            f["sensitive"] as? Bool != true && (f["required"] as? Bool == true || byRule.contains(f["id"] as? String ?? ""))
        }
    }

    private func missingOf(_ o: Order, _ stage: Stage) -> [String] {
        stage.checklist.filter { item in
            item["required"] as? Bool == true && o.marks[stage.id]?[item["id"] as? String ?? ""]?["done"] as? Bool != true
        }.compactMap { $0["label"] as? String }
    }

    private func isEmpty(_ value: Any?) -> Bool {
        guard let value, !(value is NSNull) else { return true }
        if let s = value as? String { return s.trimmingCharacters(in: .whitespaces).isEmpty }
        return false
    }

    private func labels(_ t: WType) -> Row {
        ["singular": t.singular, "plural": t.plural, "item": t.item, "problem": t.problem, "customer_singular": "Cliente", "customer_plural": "Clientes"]
    }

    private func features(_ t: WType) -> Row {
        let quote: Any = t.id == "oficina"
            ? ["default_valid_days": 7, "source_stages": ["diagnostico"], "sent_stage": "diagnostico", "approved_stage": "execucao", "declined_stage": "diagnostico", "edited_stage": "diagnostico"] as Row
            : NSNull()
        return ["customer_open": false, "tasks": false, "people": false, "documents": true, "entries": false, "quote": quote,
                "warranty_days": 90, "pickup_reminder_days": 0, "stale_days": 0]
    }

    private func typeJSON(_ t: WType) -> Row {
        ["schema_version": 1, "kind": "custom", "id": t.id, "revision": 1, "archived": false, "labels": labels(t), "number_prefix": t.prefix, "terms": NSNull(),
         "fields": t.fields, "retired_field_ids": [String](),
         "stages": t.stages.map { ["id": $0.id, "label": $0.label, "base_status": $0.base, "message": "", "checklist": $0.checklist] as Row },
         "retired_stage_ids": [String](), "initial_stage": t.initial,
         "transitions": t.transitions.map { ["id": $0.id, "from": $0.from, "to": $0.to, "label": $0.label, "kind": "manual"] as Row },
         "features": features(t), "pickup_reminder_text": "", "object_type_id": t.objectTypeId ?? NSNull(),
         "stage_field_rules": t.rules.map { ["field_id": $0.fieldId, "required_from_stage": $0.fromStage ?? NSNull()] as Row }]
    }

    private func row(_ o: Order) -> Row {
        let stage = o.type.stage(o.stage)
        let checklist: [Row] = o.type.stages.filter { !$0.checklist.isEmpty }.map { s in
            ["stage_id": s.id, "stage_label": s.label, "current": s.id == o.stage,
             "items": s.checklist.map { item -> Row in
                 let id = item["id"] as? String ?? ""
                 let mark = o.marks[s.id]?[id]
                 return ["id": id, "label": item["label"] ?? "", "required": item["required"] as? Bool == true, "photo_required": item["photo_required"] as? Bool == true,
                         "done": mark?["done"] as? Bool == true, "photo_document_id": mark?["photo_document_id"] ?? NSNull(), "by": mark?["by"] ?? NSNull(), "at": mark?["at"] ?? NSNull()]
             },
             "missing": missingOf(o, s)]
        }
        let next: [Row] = o.closed ? [] : o.type.transitions.filter { $0.from == o.stage }.compactMap { t in
            guard let to = o.type.stage(t.to) else { return nil }
            return ["transition_id": t.id, "stage": to.id, "stage_label": to.label, "base_status": to.base, "kind": "manual"]
        }
        var quote = o.quote
        if quote != nil {
            quote?["sent_at"] = o.quoteSentAt ?? NSNull()
            quote?["valid_until"] = o.quoteSentAt.map { $0 + 7 * Self.day } ?? NSNull()
            quote?["locked"] = o.decision?["decision"] as? String == "approved"
        }
        let offersQuote = o.quote != nil && o.quoteSentAt == nil && o.decision == nil && o.base == "analyzing"
        var row: Row = [
            "id": o.id, "number": o.number, "display_number": displayNumber(o), "status": o.base, "status_label": stage?.label ?? "",
            "type_id": o.type.id, "type_revision": 1, "type_number": o.number, "type_label": o.type.singular, "type_plural_label": o.type.plural,
            "stage": o.stage, "stage_label": stage?.label ?? o.stage, "labels": labels(o.type),
            "customer": ["name": o.customerName, "phone": o.phone ?? NSNull(), "contact_id": o.contactId ?? NSNull(), "conversation_id": o.conversationId ?? NSNull()] as Row,
            "item": o.item, "problem": o.problem, "notes": o.notes, "assignee": NSNull(), "due_at": o.closed ? NSNull() : (o.dueAt ?? NSNull()) as Any,
            "source": "panel", "terms": NSNull(), "quote": quote ?? NSNull(), "decision": o.decision ?? NSNull(),
            "ready_at": NSNull(), "delivered_at": NSNull(), "warranty_until": NSNull(),
            "next_statuses": offersQuote ? ["quoted"] : [String](),
            "created": o.created, "updated": o.updated,
            "extra": o.extra.filter { visibleField(o.type, $0.key) },
            "fields": o.type.fields.filter { $0["sensitive"] as? Bool != true },
            "version": o.version, "features": features(o.type), "next_stages": next, "stage_approval": NSNull(),
        ]
        if let object = o.object { row["object"] = object }
        if !checklist.isEmpty { row["checklist"] = checklist }
        return row
    }

    private func visibleField(_ type: WType, _ id: String) -> Bool {
        type.fields.contains { $0["id"] as? String == id && $0["sensitive"] as? Bool != true }
    }
}
