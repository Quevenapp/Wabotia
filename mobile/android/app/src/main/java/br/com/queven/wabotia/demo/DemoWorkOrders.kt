package br.com.queven.wabotia.demo

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/*
 * A ordem de serviço por modelo da demonstração, no mesmo desenho do iOS (`Core/Demo/DemoWorkOrders.swift`): dois
 * modelos fictícios — uma oficina mecânica (objeto do serviço: veículo; checklist com foto na entrada; o campo
 * "Mecânico responsável" é pedido a partir da etapa "Pronto") e uma assistência de celulares (sem objeto, com um campo
 * restrito que o app nunca mostra) — com as mesmas recusas do servidor (`reason_required`, `checklist_required`,
 * `missing_fields`, `photo_required`, `version_conflict`, `order_closed`, `object_required`). Tudo em memória, chamado
 * por [DemoServiceOrders] dentro do trinco do [DemoServer]; nada toca a rede. Os dados são inventados (placas e IMEIs
 * de exemplo, telefones 552090…).
 */
internal class DemoWorkOrders(
    private val t0: Long,
    private val profileId: String,
    private val customerOf: DemoCustomer,
    private val contactOf: (String) -> Pair<String, String?>?,
) {
    private class Stage(val id: String, val label: String, val base: String, val checklist: List<JsonObject> = emptyList())
    private class Transition(val id: String, val from: String, val to: String, val label: String)
    private class Rule(val fieldId: String, val fromStage: String?)
    private class Type(
        val id: String,
        val singular: String,
        val plural: String,
        val item: String,
        val problem: String,
        val prefix: String,
        val fields: List<JsonObject>,
        val stages: List<Stage>,
        val transitions: List<Transition>,
        val rules: List<Rule>,
        val objectTypeId: String?,
    ) {
        val initial: String get() = stages.first().id
        fun stage(id: String?) = stages.firstOrNull { it.id == id }
    }

    private class Obj(val id: String, val contactId: String, val typeId: String, var values: JsonObject, var version: Int = 1, val created: Long)

    private class Doc(val id: String, val orderId: String, val mime: String, val expected: Long, var version: Int = 1, var attempt: String? = null, var bytes: ByteArray? = null, var ready: Boolean = false)

    private class Order(
        val id: String,
        val type: Type,
        val number: Int,
        var stage: String,
        val customerName: String,
        val phone: String?,
        val contactId: String?,
        val conversationId: String?,
        val item: String,
        val problem: String,
        val notes: String,
        var extra: JsonObject,
        val objectSnapshot: JsonObject?,
        val created: Long,
    ) {
        var version = 1
        var updated = created
        var dueAt: Long? = created + 5 * DAY
        var quote: JsonObject? = null
        var quoteSentAt: Long? = null
        var decision: JsonObject? = null
        val marks = HashMap<String, HashMap<String, JsonObject>>()
        val history = mutableListOf<JsonObject>()
        val base: String get() = type.stage(stage)?.base ?: "received"
        val closed: Boolean get() = base == "delivered" || base == "cancelled"
    }

    private val objectType = j(
        "schema_version" to 1, "id" to "veiculo", "revision" to 1, "archived" to false,
        "labels" to j("singular" to "Veículo", "plural" to "Veículos"), "identifier_field_id" to "placa",
        "fields" to listOf(
            field("placa", "Placa", "text", required = true, extra = arrayOf("multiline" to false, "max_length" to 8)),
            field("modelo", "Modelo", "text", extra = arrayOf("multiline" to false, "max_length" to 60)),
            field("ano", "Ano", "integer", extra = arrayOf("min" to 1950, "max" to 2030)),
        ),
        "retired_field_ids" to emptyList<String>(),
    )

    private val oficina = Type(
        id = "oficina", singular = "Ordem da oficina", plural = "Oficina", item = "Serviço pedido", problem = "Relato do cliente", prefix = "OF",
        fields = listOf(
            field("km_entrada", "Quilometragem na entrada", "integer", extra = arrayOf("min" to 0, "max" to 2_000_000)),
            field("combustivel", "Combustível na entrada", "choice", extra = arrayOf("options" to listOf(
                j("id" to "reserva", "label" to "Na reserva"), j("id" to "meio", "label" to "Meio tanque"), j("id" to "cheio", "label" to "Cheio"),
            ))),
            field("revisao_garantia", "Revisão na garantia de fábrica", "boolean"),
            field("previsao", "Previsão de entrega", "date", extra = arrayOf("min" to null, "max" to null)),
            field("mecanico", "Mecânico responsável", "text", extra = arrayOf("multiline" to false, "max_length" to 60)),
        ),
        stages = listOf(
            Stage("recebido", "Recebido", "received", listOf(
                item("foto_painel", "Foto do painel com a quilometragem", required = true, photo = true),
                item("objetos", "Conferir objetos deixados no carro", required = true),
            )),
            Stage("diagnostico", "Diagnóstico", "analyzing"),
            Stage("execucao", "Em execução", "in_progress", listOf(
                item("teste_rodagem", "Teste de rodagem", required = true),
                item("lavagem", "Lavagem cortesia"),
            )),
            Stage("pronto", "Pronto", "ready"),
            Stage("entregue", "Entregue", "delivered"),
            Stage("cancelada", "Cancelada", "cancelled"),
        ),
        transitions = listOf(
            Transition("t-diag", "recebido", "diagnostico", "Começar diagnóstico"),
            Transition("t-exec", "diagnostico", "execucao", "Começar o serviço"),
            Transition("t-volta-receb", "diagnostico", "recebido", "Voltar para recebido"),
            Transition("t-pronto", "execucao", "pronto", "Serviço pronto"),
            Transition("t-retrabalho", "pronto", "execucao", "Retrabalho"),
            Transition("t-entregue", "pronto", "entregue", "Entregar ao cliente"),
            Transition("t-cancel-1", "recebido", "cancelada", "Cancelar"),
            Transition("t-cancel-2", "diagnostico", "cancelada", "Cancelar"),
            Transition("t-cancel-3", "execucao", "cancelada", "Cancelar"),
            Transition("t-cancel-4", "pronto", "cancelada", "Cancelar"),
        ),
        rules = listOf(Rule("mecanico", "pronto")),
        objectTypeId = "veiculo",
    )

    private val celulares = Type(
        id = "celulares", singular = "Ordem de assistência", plural = "Assistência de celulares", item = "Aparelho", problem = "Defeito relatado", prefix = "CEL",
        fields = listOf(
            field("imei", "IMEI", "text", extra = arrayOf("multiline" to false, "max_length" to 20)),
            field("senha_desbloqueio", "Senha de desbloqueio", "text", sensitive = true, extra = arrayOf("multiline" to false, "max_length" to 30)),
            field("acessorios", "Acessórios deixados", "text", extra = arrayOf("multiline" to true, "max_length" to 200)),
            field("backup", "Cliente fez backup", "boolean", required = true),
        ),
        stages = listOf(
            Stage("entrada", "Entrada", "received"),
            Stage("reparo", "Em reparo", "in_progress", listOf(
                item("tela", "Testar tela e toque", required = true),
                item("camera", "Testar câmera e áudio", required = true),
            )),
            Stage("pronto", "Pronto para retirar", "ready"),
            Stage("entregue", "Entregue", "delivered"),
            Stage("cancelada", "Cancelada", "cancelled"),
        ),
        transitions = listOf(
            Transition("c-reparo", "entrada", "reparo", "Começar o reparo"),
            Transition("c-pronto", "reparo", "pronto", "Reparo pronto"),
            Transition("c-volta", "pronto", "reparo", "Voltar ao reparo"),
            Transition("c-entregue", "pronto", "entregue", "Entregar"),
            Transition("c-cancel-1", "entrada", "cancelada", "Cancelar"),
            Transition("c-cancel-2", "reparo", "cancelada", "Cancelar"),
            Transition("c-cancel-3", "pronto", "cancelada", "Cancelar"),
        ),
        rules = emptyList(),
        objectTypeId = null,
    )

    private val types = listOf(oficina, celulares)
    private val objects = mutableListOf<Obj>()
    private val orders = mutableListOf<Order>()
    private val docs = mutableListOf<Doc>()
    private val replays = DemoReplays()
    private var seq = 0

    init {
        val c1 = "ct-${Ids.C_RICH}"
        val c2 = "ct-${Ids.C_5H}"
        val c3 = "ct-${Ids.C_DONE}"
        objects += Obj("obj-1", c1, "veiculo", j("placa" to "ABC1D23", "modelo" to "Hatch Exemplo 1.0", "ano" to 2019), created = t0 - 40 * DAY)
        objects += Obj("obj-2", c2, "veiculo", j("placa" to "XYZ9E87", "modelo" to "Sedã Exemplo 2.0", "ano" to 2016), created = t0 - 90 * DAY)
        objects += Obj("obj-3", c2, "veiculo", j("placa" to "EXE4M56", "modelo" to "Utilitário Exemplo", "ano" to 2022), created = t0 - 10 * DAY)
        objects += Obj("obj-4", c3, "veiculo", j("placa" to "DEM0A12", "modelo" to "Picape Exemplo", "ano" to 2020), created = t0 - 30 * DAY)

        fun seed(type: Type, stage: String, conversation: String?, contact: String?, name: String, phone: String?, item: String, problem: String, ageDays: Int, extra: JsonObject, objectId: String? = null): Order {
            val created = t0 - ageDays * DAY - 3_600_000
            val number = orders.count { it.type.id == type.id } + 1
            val snapshot = objectId?.let { id -> objects.firstOrNull { it.id == id }?.let { snapshotOf(it, created) } }
            val o = Order("wo-${type.prefix.lowercase()}-$number", type, number, type.initial, name, phone, contact, conversation, item, problem, "", extra, snapshot, created)
            o.history += history("opened", null, null, null, type.stage(type.initial)?.base, created)
            moveSeed(o, stage, created + DAY)
            orders += o
            return o
        }
        val mariana = customerOf(Ids.C_RICH) ?: ("Mariana Costa" to "5520908765432")
        val joao = customerOf(Ids.C_5H) ?: ("João Pedro Almeida" to "5520906543210")
        val aline = customerOf(Ids.C_DONE) ?: ("Aline Barbosa" to "5520904445566")
        seed(oficina, "recebido", Ids.C_RICH, c1, mariana.first, mariana.second, "Revisão dos 60 mil km", "Barulho na suspensão dianteira ao passar em lombada.", 0,
            j("km_entrada" to 60_250, "combustivel" to "meio", "revisao_garantia" to false), "obj-1")
        seed(oficina, "diagnostico", Ids.C_5H, c2, joao.first, joao.second, "Freios", "Pedal do freio baixo e chiado ao frear.", 2,
            j("km_entrada" to 132_400, "combustivel" to "reserva"), "obj-2").also { o ->
            o.quote = quote(listOf(Triple("Pastilhas de freio (par)", 1.0, 18_000L), Triple("Fluido de freio", 1.0, 4_500L), Triple("Mão de obra", 1.0, 12_000L)))
        }
        seed(oficina, "execucao", null, c2, joao.first, joao.second, "Troca de óleo e filtros", "Revisão preventiva.", 4,
            j("km_entrada" to 48_900, "combustivel" to "cheio", "revisao_garantia" to true, "previsao" to dayOf(t0 + DAY)), "obj-3").also { o ->
            o.quote = quote(listOf(Triple("Óleo 5W30 (litro)", 4.0, 4_200L), Triple("Filtro de óleo", 1.0, 3_500L)))
            o.quoteSentAt = o.created + DAY / 2
            o.decision = j("decision" to "approved", "at" to o.created + DAY, "by" to "customer", "via" to "whatsapp")
            o.marks["execucao"] = hashMapOf("lavagem" to j("done" to true, "photo_document_id" to null, "by" to Ids.ME, "at" to o.created + 2 * DAY))
        }
        seed(oficina, "pronto", Ids.C_DONE, c3, aline.first, aline.second, "Alinhamento e balanceamento", "Volante puxando para a direita.", 6,
            j("km_entrada" to 75_000, "mecanico" to "Carlos Pereira"), "obj-4")
        seed(oficina, "entregue", null, c1, mariana.first, mariana.second, "Troca da bateria", "Carro não pegava de manhã.", 25,
            j("km_entrada" to 55_100, "mecanico" to "Carlos Pereira"), "obj-1")
        seed(celulares, "reparo", Ids.C_DONE, c3, aline.first, aline.second, "Celular Exemplo X", "Tela trincada e touch falhando no canto.", 1,
            j("imei" to "000000000000001", "acessorios" to "Capinha transparente", "backup" to true, "senha_desbloqueio" to "000000")).also { o ->
            o.marks["reparo"] = hashMapOf("tela" to j("done" to true, "photo_document_id" to null, "by" to Ids.ME, "at" to o.created + DAY))
        }
        seed(celulares, "entrada", null, null, "Gustavo Lima", "5520907771234", "Celular Exemplo Mini", "Não carrega.", 0, j("backup" to false))
    }

    // ------------------------------------------------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------------------------------------------------

    /** As ordens da lista com os filtros do servidor (`type_id`, `type_ids`, `stage`, `open`, `status`, `q`). */
    fun list(query: (String) -> String?, now: Long): List<Pair<Long, JsonObject>> {
        val typeId = query("type_id")
        val typeIds = query("type_ids")?.split(",")?.filter { it.isNotBlank() }?.toSet()
        val stage = query("stage")
        val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }?.toSet().orEmpty()
        val q = query("q")?.trim()?.lowercase().orEmpty()
        return orders.filter { o ->
            (typeId == null || o.type.id == typeId) && (typeIds == null || o.type.id in typeIds) &&
                (stage == null || o.stage == stage) && (statuses.isEmpty() || o.base in statuses) &&
                (query("open") != "1" || !o.closed) &&
                (q.isEmpty() || listOf(displayNumber(o), o.number.toString(), o.customerName, o.item, identifierOf(o)).any { it.lowercase().contains(q) })
        }.map { it.created to row(it, now) }
    }

    /** O catálogo inclui a ordem simples ([builtin]) e os dois modelos. */
    fun catalog(builtin: JsonObject): JsonObject = j("data" to listOf(builtin) + types.map(::typeJson), "settings_revision" to "demo-1")

    /** Reconhece as rotas da ordem por modelo; `null` deixa a ordem simples responder. */
    fun handles(r: List<String>): Boolean {
        val first = r.firstOrNull() ?: return false
        return first in setOf("types", "object-types", "objects") || orders.any { it.id == first }
    }

    /** Uma ordem nova com modelo próprio (`type_id` de um dos modelos). */
    fun ownsType(typeId: String?): Boolean = types.any { it.id == typeId }

    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?, key: String?, now: Long, emit: DemoEmit, builtin: JsonObject): Reply {
        if (method == "GET") return read(r, query, now, builtin)
        return replays.run(key, r, body) { write(method, r, body, now, emit) }
    }

    private fun read(r: List<String>, query: (String) -> String?, now: Long, builtin: JsonObject): Reply {
        when (r[0]) {
            "types" -> {
                if (r.size == 1) return demoOk(catalog(builtin))
                if (r[1] == "service_order") return demoOk(builtin)
                return types.firstOrNull { it.id == r[1] }?.let { demoOk(typeJson(it)) } ?: demoFail(404, "not_found", "Modelo não encontrado.")
            }
            "object-types" -> return demoOk(j("data" to listOf(objectType), "settings_revision" to "demo-1"))
            "objects" -> {
                val contact = query("contact_id") ?: return demoFail(400, "invalid_request", "Informe contact_id.")
                val list = objects.filter { it.contactId == contact && (query("type_id") == null || it.typeId == query("type_id")) }.sortedByDescending { it.created }
                return demoOk(j("data" to list.map(::objectJson), "next_cursor" to null))
            }
        }
        val o = orders.firstOrNull { it.id == r[0] } ?: return demoFail(404, "not_found", "Ordem não encontrada.")
        return when (r.drop(1).joinToString("/")) {
            "" -> demoOk(row(o, now))
            "history" -> demoOk(j("data" to o.history, "next_cursor" to null))
            "requirements" -> {
                val t = o.type.transitions.firstOrNull { it.id == query("transition_id") && it.from == o.stage }
                    ?: return demoFail(404, "not_found", "Mudança de etapa não encontrada. Atualize a ordem.")
                val required = requiredFor(o, t.to)
                demoOk(j(
                    "id" to o.id, "version" to o.version, "transition_id" to t.id,
                    "required" to required.map { j("field_id" to it.str("id"), "label" to it.str("label")) },
                    "missing" to required.filter { empty(o.extra[it.str("id")]) }.map { j("field_id" to it.str("id"), "label" to it.str("label")) },
                    "internal_missing" to false,
                ))
            }
            else -> {
                if (r.size == 4 && r[1] == "documents" && r[3] == "content") {
                    val doc = docs.firstOrNull { it.id == r[2] && it.orderId == o.id && it.ready } ?: return demoFail(404, "not_found", "Documento não encontrado.")
                    return Reply(200, doc.bytes ?: ByteArray(0), type = doc.mime)
                }
                demoFail(404, "not_found", "Recurso não encontrado.")
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Escrita
    // ------------------------------------------------------------------------------------------------------------

    private fun write(method: String, r: List<String>, body: JsonObject, now: Long, emit: DemoEmit): Reply {
        if (r.isEmpty() && method == "POST") return create(body, now, emit)
        val o = orders.firstOrNull { it.id == r.getOrNull(0) } ?: return demoFail(404, "not_found", "Ordem não encontrada.")
        val action = r.drop(1).joinToString("/")
        if (action.startsWith("documents")) return documents(o, method, r.drop(2), body, now)
        val version = body.longValue("version")?.toInt()
        when {
            method == "PATCH" && action.isEmpty() -> {
                if (version != o.version) return conflict()
                if (o.closed) return demoFail(400, "immutable_field", "Trabalho encerrado: somente observações internas.")
                val extra = body["extra"] as? JsonObject ?: return demoFail(400, "invalid_request", "Informe extra.")
                val visible = o.type.fields.filter { it.bool("sensitive") != true }.mapNotNull { it.str("id") }.toSet()
                if (extra.keys.any { it !in visible }) return demoFail(400, "invalid_fields", "Campo desconhecido neste modelo.")
                val merged = LinkedHashMap(o.extra)
                for ((k, v) in extra) if (v is JsonNull) merged.remove(k) else merged[k] = v
                o.extra = JsonObject(merged)
                commit(o, now, history("os.updated", null, null, o.base, o.base, now))
                emit("os.updated", o.id, j("order_id" to o.id, "version" to o.version, "module_id" to "os"))
            }
            action == "stage" -> {
                if (version != o.version) return conflict()
                if (o.closed) return demoFail(409, "order_closed", "A ordem está encerrada: não muda mais.")
                val t = o.type.transitions.firstOrNull { it.id == body.str("transition_id") && it.from == o.stage }
                    ?: return demoFail(409, "invalid_transition", "Esta mudança de etapa não vale para a ordem agora.")
                val target = o.type.stage(t.to)!!
                val note = body.str("note")?.trim().orEmpty()
                val backward = target.base != "cancelled" && (RANK[target.base] ?: 0) < (RANK[o.base] ?: 0)
                if ((target.base == "cancelled" || backward) && note.isEmpty()) {
                    return demoFail(422, "reason_required", if (target.base == "cancelled") "Informe o motivo do cancelamento. Ele fica no histórico da ordem." else "Informe o motivo para voltar a etapa. Ele fica no histórico da ordem.")
                }
                if (target.base != "cancelled" && !backward) {
                    val current = o.type.stage(o.stage)!!
                    val missing = missingOf(o, current)
                    if (missing.isNotEmpty()) return demoFail(409, "checklist_required", "Antes de passar para \"${target.label}\", marque no checklist da etapa \"${current.label}\": ${missing.joinToString(", ")}.")
                    val fields = requiredFor(o, target.id).filter { empty(o.extra[it.str("id")]) }
                    if (fields.isNotEmpty()) return demoFail(409, "missing_fields", "Preencha os campos: ${fields.joinToString(", ") { it.str("label").orEmpty() }}.")
                }
                val from = o.stage
                val fromBase = o.base
                o.stage = target.id
                commit(o, now, history("os.stage_changed", from, target.id, fromBase, target.base, now, note))
                emit("os.stage_changed", o.id, j("order_id" to o.id, "version" to o.version, "from" to from, "to" to target.id, "module_id" to "os"))
            }
            action == "checklist" -> {
                if (version != o.version) return conflict()
                if (o.closed) return demoFail(409, "order_closed", "A ordem está encerrada: o checklist não muda mais.")
                val stage = o.type.stage(o.stage)!!
                if (stage.checklist.isEmpty()) return demoFail(409, "checklist_unavailable", "A etapa atual desta ordem não tem checklist no modelo.")
                val item = stage.checklist.firstOrNull { it.str("id") == body.str("item_id") }
                    ?: return demoFail(404, "not_found", "Item do checklist não encontrado na etapa atual. Atualize a ordem.")
                val done = (body["done"] as? JsonPrimitive)?.booleanOrNull ?: return demoFail(400, "invalid_request", "Informe done: true para marcar ou false para desmarcar.")
                val photo = body.str("photo_document_id")
                if (photo != null && docs.none { it.id == photo && it.orderId == o.id && it.ready }) {
                    return demoFail(404, "photo_not_found", "A foto não está nos documentos desta ordem. Anexe a foto em Documentos e escolha de novo.")
                }
                val label = item.str("label").orEmpty()
                if (done && item.bool("photo_required") == true && photo == null) return demoFail(422, "photo_required", "\"$label\" pede foto: anexe a foto em Documentos e escolha-a ao marcar.")
                o.marks.getOrPut(stage.id) { HashMap() }[item.str("id")!!] = j("done" to done, "photo_document_id" to if (done) photo else null, "by" to Ids.ME, "at" to now)
                val note = "Checklist (${stage.label}): $label ${if (done) "feito" else "desmarcado"}${if (done && photo != null) " · com foto" else ""}"
                commit(o, now, history("os.checklist_marked", null, null, o.base, o.base, now, note))
                emit("os.updated", o.id, j("order_id" to o.id, "version" to o.version, "module_id" to "os"))
            }
            action == "quote/send" -> {
                if (o.quote == null) return demoFail(409, "invalid_transition", "Monte o orçamento no painel antes de enviar.")
                if (o.conversationId == null) return demoFail(409, "no_conversation", "Esta ordem não está ligada a uma conversa.")
                o.quoteSentAt = now
                commit(o, now, history("quote", null, null, o.base, "quoted", now))
                emit("os.quoted", o.id, j("order_id" to o.id, "version" to o.version, "module_id" to "os"))
            }
            else -> return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(row(o, now))
    }

    private fun create(body: JsonObject, now: Long, emit: DemoEmit): Reply {
        val type = types.firstOrNull { it.id == body.str("type_id") } ?: return demoFail(404, "not_found", "Modelo não encontrado.")
        val item = body.str("item")?.trim().orEmpty()
        val problem = body.str("problem")?.trim().orEmpty()
        if (item.isEmpty() || problem.isEmpty()) return demoFail(400, "invalid_request", "Informe ${type.item.lowercase()} e ${type.problem.lowercase()}.")
        val extra = body["extra"] as? JsonObject ?: JsonObject(emptyMap())
        val visible = type.fields.filter { it.bool("sensitive") != true }
        if (extra.keys.any { k -> visible.none { it.str("id") == k } }) return demoFail(400, "invalid_fields", "Campo desconhecido neste modelo.")
        val opening = requiredFor(null, type.initial, type).filter { empty(extra[it.str("id")]) }
        if (opening.isNotEmpty()) return demoFail(409, "missing_fields", "Preencha os campos: ${opening.joinToString(", ") { it.str("label").orEmpty() }}.")
        val conversation = body.str("conversation_id")
        val objectBody = body["object"] as? JsonObject
        if (type.objectTypeId == null && objectBody != null) return demoFail(400, "invalid_fields", "Este modelo não utiliza objeto do serviço.")
        if (type.objectTypeId != null && objectBody == null) return demoFail(409, "object_required", "Selecione ou cadastre o objeto do serviço.")
        val contactId = body.str("contact_id") ?: conversation?.let { "ct-$it" }
        var obj: Obj? = null
        if (objectBody != null) {
            if (contactId == null || contactOf(contactId) == null) return demoFail(409, "customer_required", "Confirme o contato do cliente no cadastro compartilhado antes de selecionar o objeto.")
            obj = when (objectBody.str("mode")) {
                "existing" -> {
                    val found = objects.firstOrNull { it.id == objectBody.str("id") && it.contactId == contactId }
                        ?: return demoFail(409, "object_definition_conflict", "O objeto não corresponde ao cliente e ao modelo desta abertura. Atualize a seleção.")
                    if (found.version.toLong() != objectBody.longValue("version")) return demoFail(409, "object_definition_conflict", "O objeto mudou. Atualize a seleção.")
                    found
                }
                "new" -> {
                    val values = objectBody["values"] as? JsonObject ?: JsonObject(emptyMap())
                    if (empty(values["placa"])) return demoFail(409, "missing_fields", "Preencha os campos: Placa.")
                    Obj("obj-${objects.size + 1}", contactId, "veiculo", values, created = now).also { objects += it }
                }
                else -> return demoFail(400, "invalid_request", "object.mode: existing ou new.")
            }
        }
        val fromConversation = conversation?.let(customerOf)
        val fromContact = contactId?.let(contactOf)
        val name = fromConversation?.first ?: fromContact?.first ?: body.str("customer_name")?.takeIf { it.isNotBlank() }
        val phone = fromConversation?.second ?: fromContact?.second ?: body.str("phone")?.filter(Char::isDigit)?.let { if (it.length <= 11) "55$it" else it }
        if (name == null && phone.isNullOrEmpty()) return demoFail(400, "invalid_request", "Informe o cliente: conversa, cadastro ou telefone.")
        val number = orders.count { it.type.id == type.id } + 1
        val o = Order("wo-${type.prefix.lowercase()}-$number", type, number, type.initial, name ?: "Cliente", phone, contactId, conversation, item, problem,
            body.str("notes").orEmpty(), JsonObject(extra.filterValues { it !is JsonNull }), obj?.let { snapshotOf(it, now) }, now)
        o.history += history("opened", null, null, null, type.stage(type.initial)?.base, now)
        orders += o
        emit("os.opened", o.id, j("order_id" to o.id, "conversation_id" to nul(conversation), "actor" to Ids.ME, "module_id" to "os"))
        return demoOk(row(o, now), 201)
    }

    /** Reserva, envio dos bytes (`PUT …/content`, só pelo [upload]) e conclusão de um documento da ordem. */
    private fun documents(o: Order, method: String, r: List<String>, body: JsonObject, now: Long): Reply {
        if (r.isEmpty() && method == "POST") {
            val mime = body.str("mime_type")?.lowercase().orEmpty()
            if (mime !in setOf("image/jpeg", "image/png", "application/pdf")) return demoFail(415, "unsupported_media_type", "Documento: unsupported_media_type.")
            val bytes = body.longValue("expected_bytes") ?: 0L
            if (bytes <= 0) return demoFail(400, "invalid_request", "expected_bytes: inteiro positivo obrigatório.")
            if (bytes > 10L * 1024 * 1024) return demoFail(413, "document_too_large", "Documento: document_too_large.")
            if (body["client_visible"] !is JsonPrimitive || body["sensitive"] !is JsonPrimitive) return demoFail(400, "invalid_request", "client_visible e sensitive: booleanos obrigatórios.")
            val doc = Doc("doc-${++seq}", o.id, mime, bytes).also { docs += it }
            return demoOk(j(
                "id" to doc.id, "order_id" to o.id, "version" to doc.version,
                "upload_url" to "/api/v1/profiles/$profileId/service-orders/${o.id}/documents/${doc.id}/content",
                "expires_at" to now + 15 * 60_000,
            ), 201)
        }
        if (r.size == 2 && r[1] == "complete" && method == "POST") {
            val doc = docs.firstOrNull { it.id == r[0] && it.orderId == o.id } ?: return demoFail(404, "not_found", "Documento não encontrado.")
            if (doc.ready) return demoOk(j("id" to doc.id, "order_id" to o.id, "version" to doc.version))
            if (doc.bytes == null) return demoFail(409, "upload_incomplete", "Documento: upload_incomplete.")
            if (body.longValue("version")?.toInt() != doc.version || body.str("upload_attempt") != doc.attempt) return demoFail(409, "version_conflict", "Documento: version_conflict.")
            doc.ready = true
            doc.version += 1
            return demoOk(j("id" to doc.id, "order_id" to o.id, "version" to doc.version))
        }
        return demoFail(404, "not_found", "Recurso não encontrado.")
    }

    /** `PUT service-orders/{id}/documents/{doc}/content` com o corpo binário e o cabeçalho `Upload-Version`. */
    fun upload(r: List<String>, bytes: ByteArray, uploadVersion: String?, key: String?): Reply {
        if (key.isNullOrBlank()) return demoFail(400, "invalid_request", "Envie Idempotency-Key (até 200 caracteres ASCII).")
        val o = orders.firstOrNull { it.id == r.getOrNull(0) } ?: return demoFail(404, "not_found", "Ordem não encontrada.")
        val doc = docs.firstOrNull { it.id == r.getOrNull(2) && it.orderId == o.id } ?: return demoFail(404, "not_found", "Documento não encontrado.")
        if (uploadVersion?.toIntOrNull() != doc.version) return demoFail(400, "invalid_request", "Envie Upload-Version inteiro positivo.")
        if (bytes.size.toLong() != doc.expected) return demoFail(409, "content_mismatch", "Documento: content_mismatch.")
        if (doc.bytes == null) {
            doc.bytes = bytes
            doc.attempt = "att-${doc.id}"
        }
        return demoOk(j("id" to doc.id, "version" to doc.version, "upload_attempt" to doc.attempt, "byte_length" to bytes.size, "sha256" to ""))
    }

    // ------------------------------------------------------------------------------------------------------------
    // Montagem
    // ------------------------------------------------------------------------------------------------------------

    private fun commit(o: Order, now: Long, entry: JsonObject) {
        o.version += 1
        o.updated = now
        o.history += entry
    }

    private fun conflict() = demoFail(409, "version_conflict", "A ordem mudou desde a última leitura. Atualize e tente de novo.")

    private fun moveSeed(o: Order, target: String, at: Long) {
        var step = 0
        while (o.stage != target && step++ < 10) {
            val t = o.type.transitions.firstOrNull { it.from == o.stage && o.type.stage(it.to)?.base != "cancelled" && it.to != "recebido" && it.to != o.stage &&
                (RANK[o.type.stage(it.to)?.base] ?: 0) >= (RANK[o.base] ?: 0) } ?: break
            val stage = o.type.stage(o.stage)
            stage?.checklist?.forEach { item -> o.marks.getOrPut(stage.id) { HashMap() }[item.str("id")!!] = j("done" to true, "photo_document_id" to null, "by" to Ids.ME, "at" to at) }
            val fromBase = o.base
            val from = o.stage
            o.stage = t.to
            o.version += 1
            o.history += history("os.stage_changed", from, t.to, fromBase, o.base, at + step * 3_600_000L)
        }
    }

    private fun history(kind: String, fromStage: String?, toStage: String?, fromStatus: String?, toStatus: String?, at: Long, note: String = "") =
        j("id" to "wh-${++seq}", "kind" to kind, "from_status" to fromStatus, "to_status" to toStatus, "from_stage" to fromStage, "to_stage" to toStage,
            "actor" to Ids.ME, "note" to note, "created" to at, "changed_fields" to emptyList<String>())

    private fun quote(items: List<Triple<String, Double, Long>>): JsonObject {
        val list = items.map { (d, q, v) -> j("id" to "qi-${++seq}", "description" to d, "quantity" to q, "unit_cents" to v, "kind" to "service") }
        val total = items.sumOf { (_, q, v) -> Math.round(q * v) }
        return j("items" to list, "total_cents" to total, "note" to "", "valid_days" to 7, "valid_until" to null, "sent_at" to null, "version" to 1, "expired" to false,
            "subtotal_cents" to total, "items_discount_cents" to 0, "discount_cents" to 0)
    }

    private fun displayNumber(o: Order) = "${o.type.prefix}-${o.number}"

    private fun identifierOf(o: Order) = o.objectSnapshot?.str("identifier").orEmpty()

    private fun snapshotOf(obj: Obj, at: Long) = j(
        "schema_version" to 1, "object_id" to obj.id, "object_version" to obj.version, "captured_at" to at, "origin" to "opening",
        "type" to objectType, "values" to obj.values, "identifier" to obj.values.str("placa").orEmpty(),
    )

    private fun objectJson(obj: Obj) = j(
        "id" to obj.id, "contact_id" to obj.contactId, "type_id" to obj.typeId, "type_revision" to 1, "type" to objectType, "values" to obj.values,
        "archived" to false, "version" to obj.version, "identifier" to obj.values.str("placa").orEmpty(), "created" to obj.created, "updated" to obj.created,
        "latest_completed" to null,
    )

    /** Campos que a etapa [stageId] exige (regra a partir de uma etapa até ela, na ordem do modelo). */
    private fun requiredFor(o: Order?, stageId: String, type: Type = o!!.type): List<JsonObject> {
        val index = type.stages.indexOfFirst { it.id == stageId }
        val byRule = type.rules.filter { rule -> rule.fromStage != null && type.stages.indexOfFirst { it.id == rule.fromStage } in 0..index }.map { it.fieldId }.toSet()
        return type.fields.filter { f -> f.bool("sensitive") != true && (f.bool("required") == true || f.str("id") in byRule) }
    }

    private fun missingOf(o: Order, stage: Stage): List<String> =
        stage.checklist.filter { it.bool("required") == true && o.marks[stage.id]?.get(it.str("id"))?.bool("done") != true }.map { it.str("label").orEmpty() }

    private fun empty(value: JsonElement?): Boolean = value == null || value is JsonNull || (value as? JsonPrimitive)?.let { it.isString && it.content.isBlank() } == true

    private fun typeJson(t: Type): JsonObject = j(
        "schema_version" to 1, "kind" to "custom", "id" to t.id, "revision" to 1, "archived" to false,
        "labels" to labelsOf(t), "number_prefix" to t.prefix, "terms" to null,
        "fields" to t.fields, "retired_field_ids" to emptyList<String>(),
        "stages" to t.stages.map { s -> j("id" to s.id, "label" to s.label, "base_status" to s.base, "message" to "", "checklist" to s.checklist) },
        "retired_stage_ids" to emptyList<String>(), "initial_stage" to t.initial,
        "transitions" to t.transitions.map { tr -> j("id" to tr.id, "from" to tr.from, "to" to tr.to, "label" to tr.label, "kind" to "manual") },
        "features" to features(t), "pickup_reminder_text" to "",
        "object_type_id" to t.objectTypeId,
        "stage_field_rules" to t.rules.map { j("field_id" to it.fieldId, "required_from_stage" to it.fromStage) },
    )

    private fun labelsOf(t: Type) = j("singular" to t.singular, "plural" to t.plural, "item" to t.item, "problem" to t.problem, "customer_singular" to "Cliente", "customer_plural" to "Clientes")

    private fun features(t: Type) = j(
        "customer_open" to false, "tasks" to false, "people" to false, "documents" to true, "entries" to false,
        "quote" to if (t.id == "oficina") j("default_valid_days" to 7, "source_stages" to listOf("diagnostico"), "sent_stage" to "diagnostico", "approved_stage" to "execucao", "declined_stage" to "diagnostico", "edited_stage" to "diagnostico") else null,
        "warranty_days" to 90, "pickup_reminder_days" to 0, "stale_days" to 0,
    )

    private fun row(o: Order, now: Long): JsonObject {
        val stage = o.type.stage(o.stage)
        val checklist = o.type.stages.filter { it.checklist.isNotEmpty() }.map { s ->
            j("stage_id" to s.id, "stage_label" to s.label, "current" to (s.id == o.stage),
                "items" to s.checklist.map { item ->
                    val mark = o.marks[s.id]?.get(item.str("id"))
                    j("id" to item.str("id"), "label" to item.str("label"), "required" to (item.bool("required") == true), "photo_required" to (item.bool("photo_required") == true),
                        "done" to (mark?.bool("done") == true), "photo_document_id" to mark?.str("photo_document_id"), "by" to mark?.str("by"), "at" to mark?.longOrNull("at"))
                },
                "missing" to missingOf(o, s))
        }
        val next = if (o.closed) emptyList() else o.type.transitions.filter { it.from == o.stage }.map { t ->
            val to = o.type.stage(t.to)!!
            j("transition_id" to t.id, "stage" to to.id, "stage_label" to to.label, "base_status" to to.base, "kind" to "manual")
        }
        val quote = o.quote?.let { q ->
            JsonObject(q + mapOf(
                "sent_at" to (o.quoteSentAt?.let { JsonPrimitive(it) } ?: JsonNull),
                "valid_until" to (o.quoteSentAt?.let { JsonPrimitive(it + 7 * DAY) } ?: JsonNull),
                "expired" to JsonPrimitive(false),
                "locked" to JsonPrimitive(o.decision?.str("decision") == "approved"),
            ))
        }
        val offersQuote = quote != null && o.quoteSentAt == null && o.decision == null && o.base == "analyzing"
        val pairs = mutableListOf<Pair<String, Any?>>(
            "id" to o.id, "number" to o.number, "display_number" to displayNumber(o), "status" to o.base, "status_label" to (stage?.label ?: ""),
            "type_id" to o.type.id, "type_revision" to 1, "type_number" to o.number, "type_label" to o.type.singular, "type_plural_label" to o.type.plural,
            "stage" to o.stage, "stage_label" to (stage?.label ?: o.stage), "labels" to labelsOf(o.type),
            "customer" to j("name" to o.customerName, "phone" to o.phone, "contact_id" to o.contactId, "conversation_id" to o.conversationId),
            "item" to o.item, "problem" to o.problem, "notes" to o.notes, "assignee" to null, "due_at" to if (o.closed) null else o.dueAt,
            "source" to "panel", "terms" to null, "quote" to quote, "decision" to o.decision,
            "ready_at" to null, "delivered_at" to null, "warranty_until" to null,
            "next_statuses" to if (offersQuote) listOf("quoted") else emptyList(),
            "created" to o.created, "updated" to o.updated,
            "extra" to JsonObject(o.extra.filterKeys { k -> o.type.fields.any { it.str("id") == k && it.bool("sensitive") != true } }),
            "fields" to o.type.fields.filter { it.bool("sensitive") != true },
            "version" to o.version, "features" to features(o.type), "next_stages" to next, "stage_approval" to null,
        )
        if (o.objectSnapshot != null) pairs += "object" to o.objectSnapshot
        if (checklist.isNotEmpty()) pairs += "checklist" to checklist
        return j(*pairs.toTypedArray())
    }

    private fun dayOf(millis: Long): String = br.com.queven.wabotia.modules.BrasiliaTime.day(millis)

    companion object {
        private const val DAY = 86_400_000L
        private val RANK = mapOf("received" to 0, "analyzing" to 1, "quoted" to 2, "approved" to 3, "declined" to 3, "in_progress" to 4, "ready" to 5, "delivered" to 6, "cancelled" to 7)

        private fun field(id: String, label: String, kind: String, required: Boolean = false, sensitive: Boolean = false, extra: Array<Pair<String, Any?>> = emptyArray()) =
            j("id" to id, "label" to label, "help" to "", "required" to required, "client_visible" to false, "sensitive" to sensitive, "kind" to kind, *extra)

        private fun item(id: String, label: String, required: Boolean = false, photo: Boolean = false) =
            j("id" to id, "label" to label, "required" to required, "photo_required" to photo)
    }
}
