package br.com.queven.wabotia.demo

import br.com.queven.wabotia.modules.BrasiliaTime
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/*
 * As verticais da demonstração (Agenda, Ordem de Serviço, Reserva, Mensalidade), em memória e no mesmo desenho das
 * demonstrações do iOS (`Core/Demo/DemoModules.swift`): dados fictícios (telefones 552090…, sem documento real),
 * Idempotency-Key obrigatória com repetição pela mesma chave, os mesmos códigos de erro do servidor e eventos para as
 * telas abertas se atualizarem. Chamado por [DemoServer] dentro do mesmo trinco; nada aqui toca a rede.
 */

/** Publica um evento em `GET /events` da demonstração. */
internal typealias DemoEmit = (kind: String, resourceId: String?, payload: JsonObject) -> Unit

/** Nome e telefone do cliente de uma conversa de exemplo. */
internal typealias DemoCustomer = (conversationId: String) -> Pair<String, String?>?

internal fun demoFail(code: Int, errorCode: String, message: String) = Reply.error(code, errorCode, message)

internal fun demoOk(value: JsonElement, code: Int = 200) = Reply.json(value, code)

/**
 * Idempotência das escritas: a mesma chave com o mesmo pedido devolve a mesma resposta; com outro pedido, 409
 * `idempotency_conflict`; sem chave, 400.
 */
internal class DemoReplays {
    private val replies = HashMap<String, Reply>()

    fun run(key: String?, path: List<String>, body: JsonObject, write: () -> Reply): Reply {
        if (key.isNullOrBlank()) return demoFail(400, "idempotency_required", "Envie Idempotency-Key em toda escrita.")
        val signature = "$key|${path.joinToString("/")}|${canonical(body)}"
        replies[signature]?.let { return it }
        if (replies.keys.any { it.startsWith("$key|") }) return demoFail(409, "idempotency_conflict", "A mesma chave foi usada com outro pedido.")
        return write().also { if (it.code < 500) replies[signature] = it }
    }

    private fun canonical(element: JsonElement): String = when (element) {
        is JsonObject -> element.entries.sortedBy { it.key }.joinToString(",", "{", "}") { "\"${it.key}\":${canonical(it.value)}" }
        else -> element.toString()
    }
}

internal fun JsonObject.longValue(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

internal fun nul(value: Any?): Any = value ?: JsonNull

/**
 * A Agenda da demonstração: uma barbearia com dois profissionais, aberta todos os dias (para a revisão das lojas ver a
 * agenda em qualquer dia), das 9h às 12h e das 13h às 19h, com horários de 30 minutos. Agendamentos de hoje e da semana,
 * alguns ligados às conversas de exemplo. Um cliente fictício marca pelo WhatsApp 40 segundos depois da entrada.
 */
internal class DemoAgenda(t0: Long, private val customerOf: DemoCustomer) {
    private data class Service(val id: String, val name: String, val minutes: Int, val price: Long)
    private data class Professional(val id: String, val name: String, val services: List<String>)

    private class A(
        val id: String,
        val serviceId: String,
        var professionalId: String,
        var starts: Long,
        var ends: Long,
        val conversationId: String?,
        val customerName: String,
        val customerPhone: String,
        val source: String,
        val notes: String,
        val bookedAt: Long,
    ) {
        var status = "booked"
        var confirmedAt: Long? = null
        var cancelledAt: Long? = null
        var cancelReason = ""
        var noShowAt: Long? = null
        var moves = 0
        var updated = bookedAt
    }

    private val services = listOf(
        Service("s-corte", "Corte de cabelo", 30, 4500),
        Service("s-barba", "Barba", 30, 3500),
        Service("s-combo", "Corte e barba", 60, 7000),
        Service("s-pigmentacao", "Pigmentação", 60, 6000),
    )
    private val professionals = listOf(
        Professional("p-rui", "Rui Amaral", listOf("s-corte", "s-barba", "s-combo", "s-pigmentacao")),
        Professional("p-leo", "Léo Prado", listOf("s-corte", "s-barba", "s-combo")),
    )
    private val turns = listOf(9 * 60 to 12 * 60, 13 * 60 to 19 * 60)
    private val appointments = mutableListOf<A>()
    private val replays = DemoReplays()
    private var seq = 0
    private var nextWalkIn = t0 + 40_000

    init {
        val today = BrasiliaTime.day(t0)
        data class Seed(val offset: Int, val hour: Int, val minute: Int, val service: String, val pro: String, val name: String, val phone: String, val conversation: String?, val status: String)
        listOf(
            Seed(0, 9, 0, "s-corte", "p-rui", "Mariana Costa", "5520908765432", Ids.C_RICH, "confirmed"),
            Seed(0, 10, 0, "s-combo", "p-leo", "Gustavo Lima", "5520907771234", null, "booked"),
            Seed(0, 11, 0, "s-barba", "p-rui", "João Pedro Almeida", "5520906543210", Ids.C_5H, "booked"),
            Seed(0, 14, 30, "s-corte", "p-leo", "Henrique Sales", "5520907775678", null, "confirmed"),
            Seed(0, 16, 0, "s-pigmentacao", "p-rui", "Patrícia Nunes", "5520909887766", Ids.C_40MIN, "booked"),
            Seed(0, 17, 30, "s-corte", "p-leo", "Otávio Reis", "5520907779012", null, "cancelled"),
            Seed(1, 9, 30, "s-combo", "p-rui", "Eduardo Santos", "5520903334455", null, "booked"),
            Seed(1, 15, 0, "s-corte", "p-leo", "Vinícius Rocha", "5520907773456", null, "booked"),
            Seed(2, 10, 0, "s-barba", "p-leo", "Felipe Moura", "5520907777890", null, "booked"),
            Seed(3, 13, 0, "s-corte", "p-rui", "Aline Barbosa", "5520904445566", Ids.C_DONE, "booked"),
            Seed(4, 18, 0, "s-combo", "p-rui", "Renato Dias", "5520907772345", null, "booked"),
            Seed(-1, 9, 0, "s-corte", "p-rui", "Tiago Melo", "5520907776789", null, "no_show"),
        ).forEach { s ->
            val start = BrasiliaTime.startOf(BrasiliaTime.addDays(today, s.offset)) ?: return@forEach
            val starts = start + (s.hour * 60 + s.minute) * 60_000L
            val a = make(s.service, s.pro, starts, s.conversation, s.name, s.phone, if (s.conversation == null) "panel" else "whatsapp", "", t0 - 2 * 86_400_000L)
            a.status = s.status
            when (s.status) {
                "confirmed" -> a.confirmedAt = t0 - 3_600_000
                "cancelled" -> { a.cancelledAt = t0 - 7_200_000; a.cancelReason = "Cliente avisou que não poderia vir." }
                "no_show" -> a.noShowAt = starts + 900_000
            }
            appointments += a
        }
    }

    private fun make(service: String, pro: String, starts: Long, conversation: String?, name: String, phone: String, source: String, notes: String, at: Long): A {
        seq += 1
        val minutes = services.firstOrNull { it.id == service }?.minutes ?: 30
        return A("ag-$seq", service, pro, starts, starts + minutes * 60_000L, conversation, name, phone, source, notes, at)
    }

    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?, key: String?, now: Long, emit: DemoEmit): Reply {
        tick(now, emit)
        if (method == "GET") {
            return when {
                r.isEmpty() -> demoOk(j("config" to j("slot_step_minutes" to 30, "reminder_hours" to 24), "services" to services.map(::serviceRow), "professionals" to professionals.map(::professionalRow)))
                r == listOf("services") -> demoOk(j("data" to services.map(::serviceRow)))
                r == listOf("professionals") -> demoOk(j("data" to professionals.map(::professionalRow)))
                r == listOf("availability") -> availability(query, now)
                r == listOf("appointments") -> {
                    val from = query("from")?.toLongOrNull() ?: 0L
                    val to = query("to")?.toLongOrNull() ?: Long.MAX_VALUE
                    val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }?.toSet().orEmpty()
                    val list = appointments.filter { a ->
                        a.starts < to && a.ends > from &&
                            (query("professional_id").isNullOrEmpty() || query("professional_id") == a.professionalId) &&
                            (statuses.isEmpty() || a.status in statuses) &&
                            (query("conversation_id").isNullOrEmpty() || query("conversation_id") == a.conversationId)
                    }
                    demoOk(j("data" to list.sortedBy { it.starts }.map(::row)))
                }
                r.size == 2 && r[0] == "appointments" -> appointments.firstOrNull { it.id == r[1] }?.let { demoOk(row(it)) } ?: demoFail(404, "not_found", "Agendamento não encontrado.")
                else -> demoFail(404, "not_found", "Recurso não encontrado.")
            }
        }
        if (method != "POST") return demoFail(405, "method_not_allowed", "Método não permitido.")
        return replays.run(key, r, body) { write(r, body, now, emit) }
    }

    private fun write(r: List<String>, body: JsonObject, now: Long, emit: DemoEmit): Reply {
        if (r == listOf("appointments")) {
            val service = services.firstOrNull { it.id == body.str("service_id") } ?: return demoFail(400, "invalid_request", "Serviço não encontrado.")
            val starts = body.longValue("starts") ?: return demoFail(400, "invalid_request", "Informe o horário.")
            val conversation = body.str("conversation_id")
            val customer = conversation?.let(customerOf)
            val name = customer?.first ?: body.str("customer_name").orEmpty()
            if (name.isBlank()) return demoFail(400, "invalid_request", "Informe conversation_id ou customer_name.")
            val pro = freeProfessional(service, starts, body.str("professional_id"), null) ?: return demoFail(409, "slot_taken", "Esse horário acabou de ser ocupado.")
            val phone = customer?.second ?: body.str("customer_phone").orEmpty()
            val a = make(service.id, pro, starts, conversation, name, phone, "panel", body.str("notes").orEmpty(), now)
            appointments += a
            emit("agenda.booked", a.id, event(a, Ids.ME))
            return demoOk(row(a))
        }
        val a = if (r.size == 3 && r[0] == "appointments") appointments.firstOrNull { it.id == r[1] } else null
        a ?: return demoFail(404, "not_found", "Agendamento não encontrado.")
        if (a.status != "booked" && a.status != "confirmed") return demoFail(409, "appointment_closed", "Este agendamento já foi encerrado.")
        when (r[2]) {
            "move" -> {
                val starts = body.longValue("starts") ?: return demoFail(400, "invalid_request", "Informe o horário.")
                val service = services.first { it.id == a.serviceId }
                val pro = freeProfessional(service, starts, body.str("professional_id") ?: a.professionalId, a.id)
                    ?: return demoFail(409, "slot_taken", "Esse horário acabou de ser ocupado.")
                val previous = row(a)
                a.starts = starts
                a.ends = starts + service.minutes * 60_000L
                a.professionalId = pro
                a.moves += 1
                a.status = "booked"
                a.updated = now
                emit("agenda.rescheduled", a.id, JsonObject(event(a, Ids.ME) + ("previous" to previous)))
            }
            "cancel" -> {
                a.status = "cancelled"; a.cancelledAt = now; a.cancelReason = body.str("reason").orEmpty(); a.updated = now
                emit("agenda.cancelled", a.id, JsonObject(event(a, Ids.ME) + ("reason" to JsonPrimitive(a.cancelReason))))
            }
            "confirm" -> {
                a.status = "confirmed"; a.confirmedAt = now; a.updated = now
                emit("agenda.confirmed", a.id, event(a, Ids.ME))
            }
            "no-show" -> {
                if (now < a.starts) return demoFail(409, "invalid_request", "A ausência só pode ser marcada depois do início.")
                a.status = "no_show"; a.noShowAt = now; a.updated = now
                emit("agenda.no_show", a.id, event(a, Ids.ME))
            }
            else -> return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(row(a))
    }

    private fun event(a: A, actor: String) = j("appointment" to row(a), "conversation_id" to nul(a.conversationId), "actor" to actor, "module_id" to "agenda")

    /** O profissional pedido, se livre; sem pedido, o primeiro livre que atende o serviço. `null`: ocupado. */
    private fun freeProfessional(service: Service, starts: Long, wanted: String?, ignoring: String?): String? {
        val ends = starts + service.minutes * 60_000L
        return professionals.filter { service.id in it.services && (wanted.isNullOrEmpty() || it.id == wanted) }.firstOrNull { pro ->
            appointments.none { it.id != ignoring && it.professionalId == pro.id && (it.status == "booked" || it.status == "confirmed") && it.starts < ends && it.ends > starts }
        }?.id
    }

    private fun availability(query: (String) -> String?, now: Long): Reply {
        val service = services.firstOrNull { it.id == query("service_id") } ?: return demoFail(400, "invalid_request", "Serviço não encontrado.")
        val date = query("date") ?: BrasiliaTime.day(now)
        val dayStart = BrasiliaTime.startOf(date) ?: return demoFail(400, "invalid_request", "Dia inválido.")
        val wanted = query("professional_id")?.takeIf { it.isNotEmpty() }
        val slots = sortedMapOf<Long, MutableList<String>>()
        professionals.filter { service.id in it.services && (wanted == null || wanted == it.id) }.forEach { pro ->
            turns.forEach { (from, to) ->
                var minute = from
                while (minute + service.minutes <= to) {
                    val starts = dayStart + minute * 60_000L
                    if (starts > now && freeProfessional(service, starts, pro.id, null) != null) slots.getOrPut(starts) { mutableListOf() } += pro.id
                    minute += 30
                }
            }
        }
        val list = slots.map { (starts, pros) -> j("starts" to starts, "ends" to starts + service.minutes * 60_000L, "time" to BrasiliaTime.clock(starts), "professional_ids" to pros) }
        return demoOk(j("service_id" to service.id, "professional_id" to nul(wanted), "days" to listOf(j("date" to date, "slots" to list))))
    }

    /** Um cliente marca pelo WhatsApp, para a tela aberta se atualizar pelo evento `agenda.booked`. */
    private fun tick(now: Long, emit: DemoEmit) {
        if (now < nextWalkIn) return
        nextWalkIn = Long.MAX_VALUE
        val start = BrasiliaTime.startOf(BrasiliaTime.addDays(BrasiliaTime.day(now), 1)) ?: return
        val service = services.first()
        val starts = listOf(11 * 60, 16 * 60 + 30, 18 * 60).map { start + it * 60_000L }.firstOrNull { freeProfessional(service, it, "p-leo", null) != null } ?: return
        val a = make(service.id, "p-leo", starts, Ids.C_QUEUE, "Fernanda Rocha", "5520901122334", "whatsapp", "", now)
        appointments += a
        emit("agenda.booked", a.id, event(a, "customer"))
    }

    private fun serviceRow(s: Service) = j("id" to s.id, "name" to s.name, "description" to "", "duration_minutes" to s.minutes, "price_cents" to s.price, "active" to true, "position" to services.indexOf(s))

    private fun professionalRow(p: Professional) = j(
        "id" to p.id, "name" to p.name, "user_id" to null, "active" to true, "position" to professionals.indexOf(p), "service_ids" to p.services,
        "hours" to (0..6).flatMap { day -> turns.map { (from, to) -> j("weekday" to day, "start" to hhmm(from), "end" to hhmm(to)) } },
    )

    private fun hhmm(minutes: Int) = "%02d:%02d".format(minutes / 60, minutes % 60)

    private fun row(a: A): JsonObject {
        val service = services.firstOrNull { it.id == a.serviceId }
        return j(
            "id" to a.id, "service_id" to a.serviceId, "service_name" to service?.name, "professional_id" to a.professionalId,
            "professional_name" to professionals.firstOrNull { it.id == a.professionalId }?.name,
            "starts" to a.starts, "ends" to a.ends, "date" to BrasiliaTime.day(a.starts), "time" to BrasiliaTime.clock(a.starts),
            "status" to a.status, "conversation_id" to a.conversationId, "contact_id" to null,
            "customer_name" to a.customerName, "customer_phone" to a.customerPhone, "notes" to a.notes, "source" to a.source,
            "price_cents" to service?.price, "booked_at" to a.bookedAt, "reminded_at" to null, "confirmed_at" to a.confirmedAt,
            "cancelled_at" to a.cancelledAt, "cancelled_by" to null, "cancel_reason" to a.cancelReason, "no_show_at" to a.noShowAt,
            "moves" to a.moves, "created" to a.bookedAt, "updated" to a.updated,
        )
    }
}

/**
 * A Ordem de Serviço da demonstração: uma assistência técnica com oito ordens em estados diferentes (uma com orçamento
 * esperando resposta, uma pronta para retirada), as transições do contrato (`next_statuses`, `409 invalid_transition`),
 * orçamento com validade, resposta do cliente, entrega com garantia e o histórico de cada ordem.
 */
internal class DemoServiceOrders(private val t0: Long, private val customerOf: DemoCustomer) {
    private class Order(
        val id: String,
        val number: Int,
        var status: String,
        val customerName: String,
        val phone: String,
        val conversationId: String?,
        val item: String,
        val problem: String,
        var notes: String,
        var assignee: String?,
        var dueAt: Long?,
        val created: Long,
    ) {
        var quoteItems: List<JsonObject> = emptyList()
        var quoteNote = ""
        var quoteDays = 7
        var quoteVersion = 0
        var sentAt: Long? = null
        var decision: String? = null
        var decisionAt: Long? = null
        var readyAt: Long? = null
        var deliveredAt: Long? = null
        var warrantyUntil: Long? = null
        var updated = created
        val history = mutableListOf<JsonObject>()
    }

    private val orders = mutableListOf<Order>()
    private val replays = DemoReplays()
    private var historySeq = 0

    init {
        val day = 86_400_000L
        data class Seed(val status: String, val name: String, val phone: String, val conversation: String?, val item: String, val problem: String, val ageDays: Int, val quote: List<Pair<String, Long>> = emptyList())
        listOf(
            Seed("delivered", "Tiago Melo", "5520907776789", null, "Notebook Exemplo 14", "Não liga.", 20, listOf("Troca da fonte" to 18000L)),
            Seed("ready", "Aline Barbosa", "5520904445566", Ids.C_DONE, "Celular Exemplo A5", "Tela quebrada.", 9, listOf("Tela nova" to 32000L, "Película" to 3000L)),
            Seed("in_progress", "Eduardo Santos", "5520903334455", null, "Tablet Exemplo 10", "Bateria não segura carga.", 6, listOf("Bateria" to 21000L)),
            Seed("approved", "Patrícia Nunes", "5520909887766", Ids.C_40MIN, "Fone Exemplo BT", "Lado esquerdo sem som.", 5, listOf("Reparo do alto-falante" to 9000L)),
            Seed("quoted", "Mariana Costa", "5520908765432", Ids.C_RICH, "Impressora Exemplo 2000", "Puxa duas folhas.", 3, listOf("Rolete de tração" to 8500L, "Mão de obra" to 6000L)),
            Seed("analyzing", "João Pedro Almeida", "5520906543210", Ids.C_5H, "Console Exemplo", "Desliga sozinho.", 2),
            Seed("received", "Gustavo Lima", "5520907771234", null, "Relógio Exemplo", "Não carrega.", 1),
            Seed("cancelled", "Otávio Reis", "5520907779012", null, "Caixa de som Exemplo", "Chiado no volume.", 12),
        ).forEachIndexed { i, s ->
            val created = t0 - s.ageDays * day
            val o = Order("os-${i + 1}", i + 1, s.status, s.name, s.phone, s.conversation, s.item, s.problem, "", if (i % 2 == 0) Ids.ANA else null, created + 7 * day, created)
            o.history += history("opened", null, "received", Ids.ME, created)
            if (s.quote.isNotEmpty()) {
                o.quoteItems = s.quote.map { (d, v) -> j("description" to d, "quantity" to 1, "unit_cents" to v) }
                o.quoteVersion = 1
                o.sentAt = created + day / 2
                o.history += history("status", "analyzing", "quoted", Ids.ME, o.sentAt!!)
            }
            when (s.status) {
                "approved", "in_progress", "ready", "delivered" -> { o.decision = "approve"; o.decisionAt = created + day; o.history += history("status", "quoted", "approved", "customer", created + day) }
            }
            if (s.status in setOf("in_progress", "ready", "delivered")) o.history += history("status", "approved", "in_progress", Ids.ME, created + day + 3_600_000)
            if (s.status in setOf("ready", "delivered")) { o.readyAt = created + 2 * day; o.history += history("status", "in_progress", "ready", Ids.ME, o.readyAt!!) }
            if (s.status == "delivered") { o.deliveredAt = created + 3 * day; o.warrantyUntil = o.deliveredAt!! + 90 * day; o.history += history("status", "ready", "delivered", Ids.ME, o.deliveredAt!!) }
            if (s.status == "cancelled") o.history += history("status", "received", "cancelled", Ids.ME, created + day)
            orders += o
        }
    }

    private fun history(kind: String, from: String?, to: String?, actor: String, at: Long, note: String = "") =
        j("id" to "h-${++historySeq}", "kind" to kind, "from_status" to from, "to_status" to to, "actor" to actor, "note" to note, "created" to at)

    private fun next(o: Order): List<String> = when (o.status) {
        "received" -> listOfNotNull("analyzing", "quoted".takeIf { o.quoteItems.isNotEmpty() }, "in_progress", "cancelled")
        "analyzing" -> listOfNotNull("quoted".takeIf { o.quoteItems.isNotEmpty() }, "in_progress", "cancelled")
        "quoted" -> listOf("approved", "declined", "analyzing", "cancelled")
        "approved" -> listOf("in_progress", "cancelled")
        "declined" -> listOf("quoted", "ready", "cancelled")
        "in_progress" -> listOf("ready", "cancelled")
        "ready" -> listOf("delivered", "in_progress")
        else -> emptyList()
    }

    private fun expired(o: Order, now: Long) = o.sentAt?.let { now > it + o.quoteDays * 86_400_000L } ?: false

    private fun row(o: Order, now: Long, withHistory: Boolean): JsonObject {
        val total = o.quoteItems.sumOf { (it.long("quantity")) * it.long("unit_cents") }
        val quote = if (o.quoteItems.isEmpty()) null else j(
            "items" to o.quoteItems, "total_cents" to total, "note" to o.quoteNote, "valid_days" to o.quoteDays,
            "valid_until" to o.sentAt?.let { it + o.quoteDays * 86_400_000L }, "sent_at" to o.sentAt, "version" to o.quoteVersion, "expired" to (o.status == "quoted" && expired(o, now)),
        )
        val fields = mutableListOf<Pair<String, Any?>>(
            "id" to o.id, "number" to o.number, "status" to o.status, "status_label" to null,
            "customer" to j("name" to o.customerName, "phone" to o.phone, "contact_id" to null, "conversation_id" to o.conversationId),
            "item" to o.item, "problem" to o.problem, "notes" to o.notes, "assignee" to o.assignee, "due_at" to o.dueAt, "source" to "panel",
            "terms" to null, "quote" to quote, "decision" to o.decision?.let { j("decision" to it, "at" to o.decisionAt, "by" to "customer", "via" to "whatsapp") },
            "ready_at" to o.readyAt, "delivered_at" to o.deliveredAt, "warranty_until" to o.warrantyUntil, "next_statuses" to next(o),
            "created" to o.created, "updated" to o.updated,
        )
        if (withHistory) fields += "history" to o.history
        return j(*fields.toTypedArray())
    }

    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?, key: String?, now: Long, emit: DemoEmit): Reply {
        if (method == "GET") {
            if (r.isEmpty()) {
                val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }?.toSet().orEmpty()
                val q = query("q")?.trim()?.lowercase().orEmpty()
                val list = orders.filter { o ->
                    (statuses.isEmpty() || o.status in statuses) &&
                        (query("open") != "1" || o.status !in setOf("delivered", "cancelled")) &&
                        (query("conversation_id").isNullOrEmpty() || o.conversationId == query("conversation_id")) &&
                        (q.isEmpty() || listOf(o.item, o.customerName, o.problem, o.number.toString()).any { it.lowercase().contains(q) } || (q.length >= 4 && o.phone.contains(q.filter(Char::isDigit).ifEmpty { "-" })))
                }.sortedByDescending { it.number }
                val counts = orders.groupingBy { it.status }.eachCount()
                return demoOk(j("data" to list.map { row(it, now, false) }, "next_cursor" to null, "counts" to j(*counts.map { it.key to it.value }.toTypedArray())))
            }
            val o = orders.firstOrNull { it.id == r[0] } ?: return demoFail(404, "not_found", "Ordem não encontrada.")
            return demoOk(row(o, now, true))
        }
        return replays.run(key, r, body) { write(method, r, body, now, emit) }
    }

    private fun write(method: String, r: List<String>, body: JsonObject, now: Long, emit: DemoEmit): Reply {
        if (r.isEmpty() && method == "POST") {
            val item = body.str("item")?.trim().orEmpty()
            val problem = body.str("problem")?.trim().orEmpty()
            if (item.isEmpty() || problem.isEmpty()) return demoFail(400, "invalid_request", "Informe o item e o problema.")
            val conversation = body.str("conversation_id")
            val customer = conversation?.let(customerOf)
            val phone = customer?.second ?: body.str("phone")?.filter(Char::isDigit)?.let { if (it.length <= 11) "55$it" else it }
            if (phone.isNullOrEmpty()) return demoFail(400, "invalid_request", "Informe conversation_id ou phone.")
            val number = (orders.maxOfOrNull { it.number } ?: 0) + 1
            val o = Order("os-$number", number, "received", customer?.first ?: body.str("customer_name") ?: "Cliente", phone, conversation, item, problem, body.str("notes").orEmpty(), body.str("assignee"), body.longValue("due_at"), now)
            o.history += history("opened", null, "received", Ids.ME, now)
            orders += o
            emit("os.opened", o.id, j("order" to row(o, now, false), "conversation_id" to nul(o.conversationId), "actor" to Ids.ME, "module_id" to "os"))
            return demoOk(row(o, now, true), 201)
        }
        val o = orders.firstOrNull { it.id == r.getOrNull(0) } ?: return demoFail(404, "not_found", "Ordem não encontrada.")
        val action = r.drop(1).joinToString("/")
        fun change(to: String, actor: String = Ids.ME, note: String = "") {
            val from = o.status
            o.status = to
            o.updated = now
            o.history += history("status", from, to, actor, now, note)
            when (to) {
                "ready" -> o.readyAt = now
                "delivered" -> { o.deliveredAt = now; o.warrantyUntil = now + 90 * 86_400_000L }
            }
            emit(if (to == "delivered") "os.delivered" else "os.status_changed", o.id, j("order" to row(o, now, false), "from" to from, "to" to to, "actor" to actor, "module_id" to "os"))
        }
        when {
            method == "PATCH" && action.isEmpty() -> {
                if (body.containsKey("assignee")) o.assignee = body.str("assignee")
                body.str("notes")?.let { o.notes = it }
                o.updated = now
                o.history += history("edit", null, null, Ids.ME, now)
            }
            action == "status" -> {
                val to = body.str("status") ?: return demoFail(400, "invalid_request", "Informe o estado.")
                if (to !in next(o) || to in setOf("quoted", "approved", "declined")) return demoFail(409, "invalid_transition", "Esta mudança não vale para a ordem agora.")
                change(to, note = body.str("note").orEmpty())
            }
            action == "quote" && method == "PUT" -> {
                if (o.status !in setOf("received", "analyzing", "quoted", "declined")) return demoFail(409, "invalid_transition", "O orçamento não pode mais ser alterado.")
                val items = (body["items"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
                if (items.isEmpty()) return demoFail(400, "invalid_request", "Inclua pelo menos um item.")
                o.quoteItems = items
                o.quoteDays = body.longValue("valid_days")?.toInt() ?: 7
                o.quoteNote = body.str("note").orEmpty()
                o.quoteVersion += 1
                o.decision = null
                o.history += history("quote", null, null, Ids.ME, now)
                if (o.status == "quoted" || o.status == "declined") change("analyzing") else o.updated = now
            }
            action == "quote/send" -> {
                if (o.quoteItems.isEmpty()) return demoFail(409, "invalid_transition", "Monte o orçamento antes de enviar.")
                if (body["notify"]?.let { (it as? JsonPrimitive)?.content } != "false" && o.conversationId == null) return demoFail(409, "no_conversation", "Esta ordem não está ligada a uma conversa.")
                o.sentAt = now
                o.decision = null
                change("quoted")
                emit("os.quoted", o.id, j("order" to row(o, now, false), "actor" to Ids.ME, "module_id" to "os"))
            }
            action == "decision" -> {
                if (o.status != "quoted") return demoFail(409, "quote_not_pending", "O orçamento não está esperando resposta.")
                if (expired(o, now)) return demoFail(409, "quote_expired", "O orçamento venceu.")
                val approve = body.str("decision") == "approve"
                o.decision = if (approve) "approve" else "decline"
                o.decisionAt = now
                change(if (approve) "approved" else "declined", actor = Ids.ME)
                emit(if (approve) "os.approved" else "os.declined", o.id, j("order" to row(o, now, false), "by" to Ids.ME, "via" to "app", "module_id" to "os"))
            }
            else -> return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(row(o, now, true))
    }
}

/**
 * A Reserva da demonstração: uma pousada com três acomodações por diária e um salão de eventos por hora, reservas da
 * semana (uma aguardando o sinal, uma com o check-in feito, uma concluída e uma cancelada), um bloqueio de manutenção e
 * as recusas do servidor (`unit_unavailable`, `unit_blocked`, `outside_rules`, `booking_closed`). Regras do padrão do
 * servidor: entrada às 14:00, saída às 12:00, salão das 08:00 às 22:00 de hora em hora e sinal de 30%.
 */
internal class DemoReserva(t0: Long, private val customerOf: DemoCustomer, private val isGroup: (String) -> Boolean) {
    private class U(val id: String, val name: String, val mode: String, val kind: String, val capacity: Int, val price: Long)

    private class B(val id: String, val number: Int, var unitId: String, var starts: Long, var ends: Long, var guests: Int, var status: String, val conversationId: String?, var name: String, var phone: String, val created: Long) {
        var notes = ""
        var source = if (conversationId == null) "panel" else "whatsapp"
        var price = 0L
        var deposit = 0L
        var paymentId: String? = null
        var paymentStatus: String? = null
        var paymentDueAt: Long? = null
        var paidAt: Long? = null
        var confirmedAt: Long? = null
        var confirmedBy: String? = null
        var checkin = "none"
        var checkinSentAt: Long? = null
        var checkinAt: Long? = null
        var answers: JsonObject? = null
        var cancelledAt: Long? = null
        var cancelReason = ""
        var changes = 0
        var updated = created
    }

    private class Period(val starts: Long, val ends: Long, val nights: Int?, val minutes: Int?, val price: Long)

    /** Uma recusa no meio da escrita, devolvida como resposta. */
    private class Refused(val reply: Reply) : Exception()

    private val units = listOf(
        U("u-mar", "Suíte Vista Mar", "daily", "room", 2, 45_000),
        U("u-jardim", "Chalé Jardim", "daily", "house", 4, 38_000),
        U("u-familia", "Suíte Família", "daily", "room", 5, 52_000),
        U("u-salao", "Salão de eventos", "hourly", "hall", 60, 15_000),
    )
    private val bookings = mutableListOf<B>()
    /** Bloqueios: unidade (`null`: a casa toda), início e fim em ms, motivo. */
    private val blocks = mutableListOf<Triple<String?, Pair<Long, Long>, String>>()
    private val replays = DemoReplays()
    private var seq = 0

    init {
        val today = BrasiliaTime.day(t0)
        fun d(n: Int) = BrasiliaTime.addDays(today, n)
        val day = 86_400_000L
        daily("u-mar", d(0), d(3), 2, "confirmed", Ids.C_RICH, "Mariana Costa", "5520908765432", t0 - 6 * day).apply {
            deposit = price * DEPOSIT_PERCENT / 100
            paymentId = "pay-$id"; paymentStatus = "paid"; paidAt = t0 - 5 * day; confirmedAt = paidAt; confirmedBy = "payment"
            checkin = "completed"; checkinSentAt = t0 - 2 * day; checkinAt = t0 - 3_600_000
            answers = j("documento" to "RG 00.000.000-0", "chegada_prevista" to "15h", "veiculo" to false)
        }
        daily("u-jardim", d(1), d(4), 3, "pending_payment", Ids.C_40MIN, "Patrícia Nunes", "5520909887766", t0 - 3_600_000).apply {
            deposit = price * DEPOSIT_PERCENT / 100
            paymentId = "pay-$id"; paymentStatus = "created"; paymentDueAt = t0 + 20 * 3_600_000L
        }
        daily("u-familia", d(5), d(7), 5, "confirmed", null, "Família Andrade", "5520907731234", t0 - 4 * day).apply { confirmedAt = created; confirmedBy = Ids.ME }
        daily("u-mar", d(6), d(8), 2, "confirmed", Ids.C_5H, "João Pedro Almeida", "5520906543210", t0 - 2 * day).apply {
            deposit = price * DEPOSIT_PERCENT / 100
            paymentId = "pay-$id"; paymentStatus = "paid"; paidAt = t0 - day; confirmedAt = paidAt; confirmedBy = "payment"
        }
        daily("u-jardim", d(-4), d(-1), 2, "completed", null, "Rafael Torres", "5520907735678", t0 - 20 * day).apply { confirmedAt = created; checkin = "completed"; checkinAt = t0 - 4 * day }
        daily("u-familia", d(2), d(4), 4, "cancelled", null, "Eduardo Santos", "5520903334455", t0 - 5 * day).apply { cancelledAt = t0 - day; cancelReason = "Cliente mudou a data da viagem." }
        BrasiliaTime.startOf(d(2))?.let { start ->
            val starts = start + 14 * 3_600_000L
            add(B("rs-${++seq}", seq, "u-salao", starts, starts + 4 * 3_600_000L, 40, "confirmed", null, "Aniversário da Lia", "5520907739012", t0 - day)).apply {
                price = 4 * 15_000L; confirmedAt = created; confirmedBy = Ids.ME
            }
        }
        val blockStart = BrasiliaTime.startOf(d(9)) ?: t0
        blocks += Triple("u-jardim", blockStart to blockStart + 2 * day, "Manutenção do telhado")
    }

    private fun add(b: B): B = b.also { bookings += it }

    private fun daily(unit: String, start: String, end: String, guests: Int, status: String, conversation: String?, name: String, phone: String, at: Long): B {
        val starts = BrasiliaTime.startOf(start) ?: 0L
        val ends = BrasiliaTime.startOf(end) ?: 0L
        val b = add(B("rs-${++seq}", seq, unit, starts, ends, guests, status, conversation, name, phone, at))
        b.price = (units.first { it.id == unit }.price) * nightsOf(starts, ends)
        return b
    }

    private fun nightsOf(starts: Long, ends: Long) = ((ends - starts + 43_200_000L) / 86_400_000L).toInt()

    private fun unit(id: String?) = units.firstOrNull { it.id == id }

    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?, key: String?, now: Long, emit: DemoEmit): Reply {
        if (method == "GET") {
            return try {
                when {
                    r.isEmpty() -> demoOk(
                        j(
                            "config" to j(
                                "checkin_time" to "14:00", "checkout_time" to "12:00", "hourly_open" to "08:00", "hourly_close" to "22:00",
                                "hourly_step_minutes" to 60, "min_hours" to 1, "deposit_type" to "percent", "deposit_percent" to DEPOSIT_PERCENT,
                                "deposit_method" to "pix", "deposit_deadline_minutes" to DEADLINE_MINUTES,
                            ),
                            "units" to units.map(::unitRow),
                            "deposit" to j("available" to true, "reason" to null, "message" to null),
                        ),
                    )
                    r == listOf("units") -> demoOk(j("data" to units.map(::unitRow)))
                    r.size == 2 && r[0] == "units" -> unit(r[1])?.let { demoOk(unitRow(it)) } ?: demoFail(404, "not_found", "Unidade não encontrada.")
                    r == listOf("blocks") -> demoOk(j("data" to blocks.mapIndexed { i, (u, span, reason) -> blockRow(i, u, span, reason) }))
                    r == listOf("calendar") -> calendar(query, now)
                    r == listOf("availability") -> availability(query, now)
                    r == listOf("bookings") -> list(query)
                    r.size == 2 && r[0] == "bookings" -> bookings.firstOrNull { it.id == r[1] }?.let { demoOk(row(it)) } ?: demoFail(404, "not_found", "Reserva não encontrada.")
                    else -> demoFail(404, "not_found", "Recurso não encontrado.")
                }
            } catch (e: Refused) {
                e.reply
            }
        }
        return replays.run(key, r, body) {
            try {
                write(method, r, body, now, emit)
            } catch (e: Refused) {
                e.reply
            }
        }
    }

    private fun invalid(message: String): Nothing = throw Refused(demoFail(400, "invalid_request", message))

    private fun validDay(value: String?): String? = value?.takeIf { Regex("""\d{4}-\d{2}-\d{2}""").matches(it) && BrasiliaTime.parse(it) != null }

    private fun intOf(body: JsonObject, key: String): Int? = (body[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.toInt()

    /** O período pedido conforme o modo da unidade (na alteração, o que falta vem da reserva). */
    private fun period(u: U, body: JsonObject, before: B?): Period {
        if (u.mode == "daily") {
            val start = validDay(body.str("start_date") ?: before?.let { BrasiliaTime.day(it.starts) })
                ?: invalid("Informe start_date (dia de entrada) no formato AAAA-MM-DD.")
            val nights = intOf(body, "nights")
            val end = body.str("end_date") ?: nights?.let {
                if (it < 1) invalid("nights: número inteiro de diárias.")
                BrasiliaTime.addDays(start, it)
            } ?: before?.takeIf { unit(it.unitId)?.mode == "daily" }?.let { BrasiliaTime.day(it.ends) }
            if (validDay(end) == null || end!! <= start) invalid("Informe end_date (dia de saída), depois do dia de entrada.")
            val starts = BrasiliaTime.startOf(start)!!
            val ends = BrasiliaTime.startOf(end)!!
            val n = nightsOf(starts, ends)
            if (n > 365) invalid("Reserve até 365 diárias por vez.")
            return Period(starts, ends, n, null, u.price * n)
        }
        val starts = (body["starts"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: before?.starts
        if (starts == null || starts <= 0 || starts % 60_000L != 0L) invalid("Informe starts (início) em milissegundos, num minuto exato.")
        val minutes = intOf(body, "duration_minutes") ?: before?.let { ((it.ends - it.starts) / 60_000L).toInt() }
        if (minutes == null || minutes !in 15..1440 || minutes % 15 != 0) invalid("Informe duration_minutes de 15 a 1440, em múltiplos de 15.")
        return Period(starts, starts + minutes * 60_000L, null, minutes, (u.price * minutes + 30) / 60)
    }

    /** A recusa do período como a equipe (`staff`): regras que ainda valem e a ocupação. `null`: livre. */
    private fun refusal(u: U, p: Period, guests: Int?, now: Long, ignore: String? = null, force: Boolean = false): String? {
        if (guests != null && guests > u.capacity) return "capacity"
        if (u.mode == "hourly") {
            val dayStart = BrasiliaTime.startOf(BrasiliaTime.day(p.starts)) ?: 0L
            if (p.starts < dayStart + OPEN * 60_000L || p.ends > dayStart + CLOSE * 60_000L) return "hours"
        }
        if (p.ends <= now) return "past"
        if (bookings.any { it.id != ignore && it.unitId == u.id && it.status in ACTIVE && it.starts < p.ends && it.ends > p.starts }) return "booked"
        if (!force && blocks.any { (bu, span) -> (bu == null || bu == u.id) && span.first < p.ends && span.second > p.starts }) return "blocked"
        return null
    }

    private fun message(refusal: String, u: U): String = when (refusal) {
        "capacity" -> "${u.name} comporta até ${u.capacity} pessoas."
        "hours" -> "${u.name} funciona das 08:00 às 22:00."
        "past" -> "Esse período já começou ou já passou."
        "booked" -> "Essa unidade já está reservada nesse período."
        "blocked" -> "Essa unidade está bloqueada nesse período."
        else -> "Fora das regras da reserva."
    }

    private fun refuse(refusal: String, u: U): Nothing {
        val code = when (refusal) {
            "booked" -> "unit_unavailable"
            "blocked" -> "unit_blocked"
            else -> "outside_rules"
        }
        throw Refused(demoFail(409, code, message(refusal, u)))
    }

    private fun active(b: B) {
        if (b.status in ACTIVE) return
        val message = when (b.status) {
            "cancelled" -> "Esta reserva já foi cancelada."
            "expired" -> "Esta reserva foi liberada porque o sinal não foi pago no prazo."
            else -> "Esta reserva já foi encerrada."
        }
        throw Refused(demoFail(409, "booking_closed", message))
    }

    private fun write(method: String, r: List<String>, body: JsonObject, now: Long, emit: DemoEmit): Reply {
        fun event(kind: String, b: B, vararg extra: Pair<String, Any?>) =
            emit(kind, b.id, j("booking" to row(b), "conversation_id" to b.conversationId, "actor" to Ids.ME, "module_id" to "reserva", *extra))
        if (method == "POST" && r == listOf("bookings")) {
            val unitId = body.str("unit_id")?.takeIf { it.isNotEmpty() } ?: invalid("Informe unit_id.")
            val u = unit(unitId) ?: return demoFail(404, "not_found", "Unidade não encontrada.")
            val p = period(u, body, null)
            val guests = if (body["guests"] == null || body["guests"] is JsonNull) 1 else intOf(body, "guests")?.takeIf { it in 1..1000 } ?: invalid("guests: número de pessoas de 1 a 1000.")
            val conversation = body.str("conversation_id")?.takeIf { it.isNotEmpty() }
            if (conversation != null && isGroup(conversation)) invalid("Ligue a reserva à conversa direta do cliente.")
            val customer = conversation?.let { customerOf(it) ?: return demoFail(404, "not_found", "Conversa não encontrada.") }
            val name = body.str("customer_name")?.trim()?.takeIf { it.isNotEmpty() } ?: customer?.first
            if (name.isNullOrBlank()) invalid("Informe conversation_id ou customer_name.")
            refusal(u, p, guests, now, force = body.bool("force") == true)?.let { refuse(it, u) }
            val b = add(B("rs-${++seq}", seq, u.id, p.starts, p.ends, guests, "confirmed", conversation, name, body.str("customer_phone")?.filter(Char::isDigit) ?: customer?.second.orEmpty(), now))
            b.price = p.price
            b.notes = body.str("notes")?.trim().orEmpty()
            b.source = "panel"
            if (body.bool("deposit") == true && conversation != null) {
                b.deposit = p.price * DEPOSIT_PERCENT / 100
                b.status = "pending_payment"
                b.paymentId = "pay-${b.id}"
                b.paymentStatus = "created"
                b.paymentDueAt = now + DEADLINE_MINUTES * 60_000L
            } else {
                b.confirmedAt = now
                b.confirmedBy = Ids.ME
            }
            event("reserva.created", b, "source" to "panel")
            if (b.status == "confirmed") event("reserva.confirmed", b, "by" to "staff")
            return demoOk(row(b))
        }
        val b = if (r.size >= 2 && r[0] == "bookings") bookings.firstOrNull { it.id == r[1] } else null
        b ?: return demoFail(404, "not_found", "Reserva não encontrada.")
        val action = r.drop(2).joinToString("/")
        when {
            method == "PATCH" && action.isEmpty() -> {
                active(b)
                val u = body.str("unit_id")?.let { unit(it) ?: return demoFail(404, "not_found", "Unidade não encontrada.") } ?: unit(b.unitId)!!
                val moved = u.id != b.unitId || listOf("start_date", "end_date", "nights", "starts", "duration_minutes").any { body.containsKey(it) }
                val p = period(u, body, b.takeIf { u.mode == unit(b.unitId)?.mode })
                val guests = if (body.containsKey("guests")) intOf(body, "guests")?.takeIf { it in 1..1000 } ?: invalid("guests: número de pessoas de 1 a 1000.") else b.guests
                if (moved || guests != b.guests) refusal(u, p, guests, now, ignore = b.id, force = body.bool("force") == true)?.let { refuse(it, u) }
                val previous = j("unit_id" to b.unitId, "starts" to b.starts, "ends" to b.ends, "guests" to b.guests, "price_cents" to b.price)
                b.unitId = u.id
                b.starts = p.starts
                b.ends = p.ends
                b.guests = guests
                if (moved) b.price = p.price
                body.str("customer_name")?.trim()?.takeIf { it.isNotEmpty() }?.let { b.name = it }
                body.str("customer_phone")?.let { b.phone = it.filter(Char::isDigit) }
                body.str("notes")?.let { b.notes = it.trim() }
                b.changes += 1
                b.updated = now
                event("reserva.changed", b, "previous" to previous)
            }
            method == "POST" && action == "cancel" -> {
                active(b)
                val reason = body.str("reason")?.trim().orEmpty()
                if (reason.length > 300) invalid("Motivo até 300 caracteres.")
                b.status = "cancelled"; b.cancelledAt = now; b.cancelReason = reason; b.updated = now
                event("reserva.cancelled", b, "reason" to reason)
            }
            method == "POST" && action == "confirm" -> {
                active(b)
                if (b.status != "confirmed") {
                    b.status = "confirmed"; b.confirmedAt = now; b.confirmedBy = Ids.ME; b.updated = now
                    event("reserva.confirmed", b, "by" to "staff")
                }
            }
            method == "POST" && action == "deposit" -> {
                if (b.status != "pending_payment" || b.deposit <= 0) invalid("Só reservas aguardando o sinal podem ser cobradas.")
                if (b.conversationId == null) invalid("Esta reserva não está ligada a uma conversa do WhatsApp.")
                b.paymentId = "pay-${b.id}"; b.paymentStatus = "created"; b.updated = now
            }
            method == "POST" && action == "checkin" -> {
                if (b.conversationId == null) invalid("Esta reserva não está ligada a uma conversa do WhatsApp.")
                if (b.status != "confirmed") return demoFail(409, "booking_not_confirmed", "O check-in só é enviado para reservas confirmadas.")
                if (b.checkin == "completed") return demoFail(409, "checkin_done", "O check-in desta reserva já foi feito.")
                b.checkin = "sent"; b.checkinSentAt = now; b.updated = now
                event("reserva.checkin_sent", b)
            }
            else -> return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(row(b))
    }

    private fun list(query: (String) -> String?): Reply {
        val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }.orEmpty()
        if (statuses.any { it !in STATUSES }) invalid("status: ${STATUSES.joinToString(", ")} (separados por vírgula).")
        val range = query("from_date")?.let { from -> BrasiliaTime.startOf(from) to (BrasiliaTime.startOf(BrasiliaTime.addDays(query("to_date") ?: BrasiliaTime.addDays(from, 30), 1)) ?: Long.MAX_VALUE) }
        val q = query("q")?.trim().orEmpty()
        val digits = q.filter(Char::isDigit)
        val number = q.removePrefix("#").toIntOrNull()
        val limit = query("limit")?.toIntOrNull()?.coerceIn(1, 1000) ?: 500
        val found = bookings.filter { b ->
            (statuses.isEmpty() || b.status in statuses) &&
                (range == null || (b.ends > (range.first ?: 0L) && b.starts < range.second)) &&
                (query("unit_id").isNullOrEmpty() || b.unitId == query("unit_id")) &&
                (query("conversation_id").isNullOrEmpty() || b.conversationId == query("conversation_id")) &&
                (q.isEmpty() || b.name.lowercase().contains(q.lowercase()) || (digits.length >= 4 && b.phone.contains(digits)) || b.number == number)
        }.sortedBy { it.starts }.take(limit)
        return demoOk(j("data" to found.map(::row)))
    }

    private fun calendar(query: (String) -> String?, now: Long): Reply {
        val from = validDay(query("from_date") ?: BrasiliaTime.day(now)) ?: invalid("from_date no formato AAAA-MM-DD.")
        val to = validDay(query("to_date") ?: BrasiliaTime.addDays(from, 13))?.takeIf { it >= from } ?: invalid("to_date no formato AAAA-MM-DD, igual ou depois de from_date.")
        if (to > BrasiliaTime.addDays(from, 92)) invalid("Consulte até 93 dias por vez.")
        val days = generateSequence(from) { BrasiliaTime.addDays(it, 1) }.takeWhile { it <= to }.toList()
        val start = BrasiliaTime.startOf(from)!!
        val end = BrasiliaTime.startOf(BrasiliaTime.addDays(to, 1))!!
        val wanted = query("unit_id")?.takeIf { it.isNotEmpty() }
        val visible = bookings.filter { it.status in setOf("pending_payment", "confirmed", "completed") && it.starts < end && it.ends > start && (wanted == null || it.unitId == wanted) }
            .sortedBy { it.starts }
        val rows = units.filter { wanted == null || it.id == wanted }.map { u ->
            j(
                "unit_id" to u.id, "name" to u.name, "mode" to u.mode, "active" to true,
                "cells" to days.map { day ->
                    val s = BrasiliaTime.startOf(day)!!
                    val e = s + 86_400_000L
                    val here = visible.filter { it.unitId == u.id && it.starts < e && it.ends > s }
                    val blocked = blocks.withIndex().filter { (_, b) -> (b.first == null || b.first == u.id) && b.second.first < e && b.second.second > s }
                    val state = when {
                        blocked.any { (_, b) -> b.second.first <= s && b.second.second >= e } -> "blocked"
                        u.mode == "daily" && here.isNotEmpty() -> here.first().status
                        here.isNotEmpty() || blocked.isNotEmpty() -> "partial"
                        else -> "free"
                    }
                    j("date" to day, "state" to state, "booking_ids" to here.map { it.id }, "block_ids" to blocked.map { "blk-${it.index + 1}" })
                },
            )
        }
        return demoOk(j("from_date" to from, "to_date" to to, "days" to days, "units" to rows, "bookings" to visible.map(::row)))
    }

    private fun availability(query: (String) -> String?, now: Long): Reply {
        val wanted = query("unit_id")?.takeIf { it.isNotEmpty() }
        val date = query("date")
        if (date != null) {
            if (validDay(date) == null) invalid("date no formato AAAA-MM-DD.")
            val minutes = query("duration_minutes")?.toIntOrNull() ?: 60
            if (minutes !in 15..1440) invalid("duration_minutes de 15 a 1440.")
            val dayStart = BrasiliaTime.startOf(date)!!
            val options = units.filter { it.mode == "hourly" && (wanted == null || it.id == wanted) }.map { u ->
                val slots = generateSequence(OPEN) { it + STEP }.takeWhile { it + minutes <= CLOSE }.mapNotNull { minute ->
                    val starts = dayStart + minute * 60_000L
                    val p = Period(starts, starts + minutes * 60_000L, null, minutes, (u.price * minutes + 30) / 60)
                    if (refusal(u, p, null, now) != null) null
                    else j("starts" to p.starts, "ends" to p.ends, "price_cents" to p.price, "time" to BrasiliaTime.clock(p.starts))
                }.toList()
                j("unit_id" to u.id, "name" to u.name, "capacity" to u.capacity, "price_cents" to u.price, "slots" to slots)
            }
            return demoOk(j("date" to date, "duration_minutes" to minutes, "units" to options))
        }
        val guests = query("guests")?.let { it.toIntOrNull()?.takeIf { n -> n >= 1 } ?: invalid("guests: número de pessoas.") }
        val nights = query("nights")?.toIntOrNull()
        val start = query("start_date")
        val results = units.filter { it.mode == "daily" && (wanted == null || it.id == wanted) }.map { u ->
            val p = period(u, j("start_date" to start, "end_date" to query("end_date"), "nights" to nights), null)
            val refusal = refusal(u, p, guests, now)
            j(
                "unit_id" to u.id, "name" to u.name, "capacity" to u.capacity, "available" to (refusal == null), "reason" to refusal,
                "message" to refusal?.let { message(it, u) }, "price_cents" to p.price, "deposit_cents" to p.price * DEPOSIT_PERCENT / 100, "nights" to p.nights,
            )
        }
        val end = results.firstOrNull()?.let { BrasiliaTime.addDays(start.orEmpty(), (it["nights"] as JsonPrimitive).content.toInt()) } ?: query("end_date")
        return demoOk(j("start_date" to start, "end_date" to end, "units" to results))
    }

    private fun unitRow(u: U) = j(
        "id" to u.id, "name" to u.name, "kind" to u.kind, "description" to "", "capacity" to u.capacity, "photos" to emptyList<String>(),
        "mode" to u.mode, "price_cents" to u.price, "active" to true, "position" to units.indexOf(u), "created" to 0, "updated" to 0,
    )

    private fun blockRow(i: Int, unit: String?, span: Pair<Long, Long>, reason: String) = j(
        "id" to "blk-${i + 1}", "unit_id" to unit, "starts" to span.first, "ends" to span.second, "from_date" to BrasiliaTime.day(span.first),
        "to_date" to BrasiliaTime.day(span.second - 1), "reason" to reason, "created_by" to Ids.ME, "created" to 0,
    )

    private fun row(b: B): JsonObject {
        val u = unit(b.unitId)
        val daily = u?.mode != "hourly"
        val arrival = if (daily) b.starts + CHECKIN * 60_000L else b.starts
        val departure = if (daily) b.ends + CHECKOUT * 60_000L else b.ends
        return j(
            "id" to b.id, "number" to b.number, "unit_id" to b.unitId, "unit_name" to u?.name, "mode" to (u?.mode ?: "daily"),
            "start_date" to BrasiliaTime.day(b.starts), "end_date" to BrasiliaTime.day(if (daily) b.ends else b.ends - 1),
            "starts" to b.starts, "ends" to b.ends, "arrival_at" to arrival, "departure_at" to departure,
            "arrival_time" to BrasiliaTime.clock(arrival), "departure_time" to BrasiliaTime.clock(departure),
            "nights" to if (daily) nightsOf(b.starts, b.ends) else null, "duration_minutes" to if (daily) null else ((b.ends - b.starts) / 60_000L).toInt(),
            "guests" to b.guests, "status" to b.status, "conversation_id" to b.conversationId, "contact_id" to null,
            "customer_name" to b.name, "customer_phone" to b.phone, "notes" to b.notes, "source" to b.source,
            "price_cents" to b.price, "deposit_cents" to b.deposit, "payment_id" to b.paymentId, "payment_status" to b.paymentStatus,
            "payment_error" to null, "payment_due_at" to b.paymentDueAt, "paid_at" to b.paidAt, "confirmed_at" to b.confirmedAt,
            "confirmed_by" to b.confirmedBy, "checkin_status" to b.checkin, "checkin_step_id" to null, "checkin_sent_at" to b.checkinSentAt,
            "checkin_at" to b.checkinAt, "checkin_answers" to b.answers, "reminded_at" to null, "checkout_sent_at" to null,
            "cancelled_at" to b.cancelledAt, "cancelled_by" to b.cancelledAt?.let { Ids.ME }, "cancel_reason" to b.cancelReason,
            "changes" to b.changes, "created_by" to Ids.ME, "created" to b.created, "updated" to b.updated,
        )
    }

    private companion object {
        val ACTIVE = setOf("pending_payment", "confirmed")
        val STATUSES = listOf("pending_payment", "confirmed", "cancelled", "expired", "completed")
        const val DEPOSIT_PERCENT = 30L
        const val DEADLINE_MINUTES = 24 * 60L
        const val CHECKIN = 14 * 60
        const val CHECKOUT = 12 * 60
        const val OPEN = 8 * 60
        const val CLOSE = 22 * 60
        const val STEP = 60
    }
}

/**
 * A Mensalidade da demonstração: uma escola de idiomas com três planos, oito assinaturas e sete pagadores (uma mãe
 * paga a própria assinatura e a do filho; uma empresa paga a de um funcionário, com dois telefones autorizados).
 * Parcelas do mês anterior e do atual (pagas, em aberto, vencidas, isenta, canceladas), uma assinatura pausada e uma
 * encerrada, e as recusas do servidor (`no_conversation`, `installment_not_payable`, `invalid_transition`). Pagadores
 * sem CPF nem CNPJ, para não usar o documento de ninguém.
 */
internal class DemoMensalidade(t0: Long) {
    private class Plan(val id: String, val name: String, val amount: Long)
    private class PayerRow(val id: String, val name: String, val phones: List<Pair<String, String>>)
    private class S(val id: String, val plan: String, val payer: String, val name: String, val phone: String, val amount: Long, val discount: Long, val dueDay: Int, var status: String, val conversationId: String?) {
        var pausedAt: Long? = null
        var endedAt: Long? = null
        var endDate: String? = null
    }
    private class I(val id: String, val sub: String, val period: String, val due: String, val amount: Long, var status: String) {
        var paidAt: Long? = null
        var paidVia: String? = null
        var paidBy: String? = null
        var note = ""
        var waivedAt: Long? = null
        var cancelledAt: Long? = null
        var chargedAt: Long? = null
        var paymentStatus: String? = null
        var overdueNotices = 0
        var updated = 0L
    }

    private class Refused(val reply: Reply) : Exception()

    private val plans = listOf(Plan("pl-ingles", "Inglês", 32_000), Plan("pl-espanhol", "Espanhol", 28_000), Plan("pl-conversa", "Conversação", 18_000))
    private val payers = listOf(
        PayerRow("py-1", "Mariana Costa", listOf("5520908765432" to "")),
        PayerRow("py-2", "Helena Prado", listOf("5520907742222" to "Helena", "5520907741111" to "Gabriel (filho)")),
        PayerRow("py-3", "Patrícia Nunes", listOf("5520909887766" to "")),
        PayerRow("py-4", "Lucas Martins", listOf("5520908876655" to "")),
        PayerRow("py-5", "Construtora Exemplo", listOf("5520906543210" to "João Pedro", "5520907745555" to "Financeiro")),
        PayerRow("py-6", "Sofia Ramos", listOf("5520907743333" to "")),
        PayerRow("py-7", "Bruna Teles", listOf("5520907744444" to "")),
    )
    private val subs = listOf(
        S("ms-1", "pl-ingles", "py-1", "Mariana Costa", "5520908765432", 32_000, 0, 10, "active", Ids.C_RICH),
        S("ms-2", "pl-ingles", "py-2", "Gabriel Prado", "5520907741111", 32_000, 3_200, 10, "active", null),
        S("ms-3", "pl-espanhol", "py-3", "Patrícia Nunes", "5520909887766", 28_000, 0, 5, "active", Ids.C_40MIN),
        S("ms-4", "pl-conversa", "py-4", "Lucas Martins", "5520908876655", 18_000, 0, 15, "active", Ids.C_QUEUE2),
        S("ms-5", "pl-espanhol", "py-2", "Helena Prado", "5520907742222", 28_000, 0, 10, "active", null),
        S("ms-6", "pl-ingles", "py-5", "João Pedro Almeida", "5520906543210", 32_000, 0, 20, "active", Ids.C_5H),
        S("ms-7", "pl-conversa", "py-6", "Sofia Ramos", "5520907743333", 18_000, 0, 10, "paused", null),
        S("ms-8", "pl-espanhol", "py-7", "Bruna Teles", "5520907744444", 28_000, 0, 10, "ended", null),
    )
    private val items = mutableListOf<I>()
    private val replays = DemoReplays()

    init {
        val today = BrasiliaTime.day(t0)
        val month = today.take(7)
        val previous = BrasiliaTime.addMonths(month, -1)
        // (assinatura, estado no mês anterior, estado planejado no mês atual)
        val plan = listOf(
            "paid" to "paid", "paid" to "open", "overdue" to "overdue", "paid" to "open",
            "paid" to "paid", "paid" to "overdue", "waived" to "cancelled", "paid" to "cancelled",
        )
        subs.forEachIndexed { index, s ->
            listOf(previous to plan[index].first, month to plan[index].second).forEachIndexed { k, (period, planned) ->
                val due = "$period-${s.dueDay.toString().padStart(2, '0')}"
                // Em aberto ou vencida conforme o dia de hoje (o mês atual pode ainda não ter vencido).
                val status = if (planned == "open" || planned == "overdue") (if (due < today) "overdue" else "open") else planned
                val i = I("mi-${index * 2 + k + 1}", s.id, period, due, s.amount - s.discount, status)
                val n = index * 2 + k + 1
                when (status) {
                    "paid" -> { i.paidAt = minOf(t0 - n * 7 * 3_600_000L, (BrasiliaTime.startOf(due) ?: t0) + 9 * 3_600_000L); i.paidVia = if (n % 3 == 0) "manual" else "pix"; i.paidBy = if (i.paidVia == "manual") Ids.ME else null; i.paymentStatus = if (i.paidVia == "pix") "paid" else null }
                    "waived" -> { i.waivedAt = t0 - 20 * 86_400_000L; i.note = "Bolsa por desempenho." }
                    "overdue" -> { i.overdueNotices = 2; i.chargedAt = t0 - 5 * 86_400_000L; i.paymentStatus = "created" }
                    "open" -> { i.chargedAt = t0 - 86_400_000L; i.paymentStatus = "created" }
                    "cancelled" -> i.cancelledAt = t0 - 10 * 86_400_000L
                }
                i.updated = t0
                items += i
            }
        }
        subs.first { it.id == "ms-7" }.pausedAt = t0 - 12 * 86_400_000L
        subs.first { it.id == "ms-8" }.apply { endedAt = t0 - 10 * 86_400_000L; endDate = BrasiliaTime.day(t0 - 10 * 86_400_000L) }
    }

    private fun sub(id: String?) = subs.firstOrNull { it.id == id }

    private fun invalid(message: String): Nothing = throw Refused(demoFail(400, "invalid_request", message))

    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?, key: String?, now: Long, emit: DemoEmit): Reply {
        if (method == "GET") {
            return try {
                when {
                    r == listOf("summary") -> summary(month(query("month") ?: BrasiliaTime.day(now).take(7)))
                    r == listOf("plans") -> demoOk(j("data" to plans.map { p -> j("id" to p.id, "name" to p.name, "amount_cents" to p.amount, "period" to "monthly", "period_label" to "Mensal", "due_day" to 10, "active" to true, "sellable" to false, "description" to "", "subscriptions" to subs.count { it.plan == p.id && it.status != "ended" }) }))
                    r == listOf("delinquents") -> delinquents()
                    r == listOf("installments") -> installments(query, now)
                    r.size == 2 && r[0] == "installments" -> items.firstOrNull { it.id == r[1] }?.let { demoOk(row(it)) } ?: demoFail(404, "not_found", "Parcela não encontrada.")
                    r == listOf("subscriptions") -> subscriptions(query)
                    r.size == 2 && r[0] == "subscriptions" -> sub(r[1])?.let { demoOk(subRow(it, withInstallments = true)) } ?: demoFail(404, "not_found", "Assinatura não encontrada.")
                    r == listOf("payers") -> demoOk(j("data" to payers.filter { p -> query("q").isNullOrBlank() || p.name.lowercase().contains(query("q")!!.lowercase()) }.map { payerRow(it, now, false) }, "next_cursor" to null))
                    r.size == 2 && r[0] == "payers" -> payers.firstOrNull { it.id == r[1] }?.let { demoOk(payerRow(it, now, true)) } ?: demoFail(404, "not_found", "Pagador não encontrado.")
                    else -> demoFail(404, "not_found", "Recurso não encontrado.")
                }
            } catch (e: Refused) {
                e.reply
            }
        }
        if (method != "POST") return demoFail(405, "method_not_allowed", "Método não permitido.")
        return replays.run(key, r, body) {
            try {
                write(r, body, now, emit)
            } catch (e: Refused) {
                e.reply
            }
        }
    }

    private fun month(value: String): String = value.takeIf { Regex("""\d{4}-(0[1-9]|1[0-2])""").matches(it) } ?: invalid("Mês no formato AAAA-MM.")

    private fun write(r: List<String>, body: JsonObject, now: Long, emit: DemoEmit): Reply {
        val today = BrasiliaTime.day(now)
        if (r.size == 3 && r[0] == "installments") {
            val i = items.firstOrNull { it.id == r[1] } ?: return demoFail(404, "not_found", "Parcela não encontrada.")
            val s = sub(i.sub)!!
            val label = statusLabel(i.status)
            when (r[2]) {
                "charge" -> {
                    if (s.conversationId == null) return demoFail(409, "no_conversation", "Não há conversa no WhatsApp com o telefone desta assinatura. O cliente precisa escrever primeiro.")
                    if (i.status !in PAYABLE) return demoFail(409, "installment_not_payable", "Esta parcela não está em aberto.")
                    i.chargedAt = now
                    i.paymentStatus = "created"
                    emit("mensalidade.charged", i.id, j("installment_id" to i.id, "subscription_id" to s.id, "amount_cents" to i.amount, "module_id" to "mensalidade"))
                }
                "pay" -> {
                    // Como o servidor: confere a observação e a data antes do estado da parcela.
                    val note = body.str("note")?.trim().orEmpty()
                    if (note.length > 300) invalid("Observação até 300 caracteres.")
                    val paidAt = body.str("paid_at")?.takeIf { it.isNotEmpty() }?.let { day ->
                        val start = BrasiliaTime.startOf(day) ?: invalid("Data do pagamento: AAAA-MM-DD ou milissegundos.")
                        if (day > today) invalid("A data do pagamento não pode ser futura.")
                        start + 12 * 3_600_000L
                    } ?: now
                    if (i.status !in PAYABLE) return demoFail(409, "installment_not_payable", "A parcela de ${i.period} está \"$label\" e não pode receber baixa.")
                    i.status = "paid"; i.paidAt = paidAt; i.paidVia = "manual"; i.paidBy = Ids.ME; i.note = note; i.updated = now
                    emit("mensalidade.paid", i.id, j("installment_id" to i.id, "subscription_id" to s.id, "amount_cents" to i.amount, "via" to "manual", "by" to Ids.ME, "paid_at" to paidAt, "note" to note, "module_id" to "mensalidade"))
                }
                "waive" -> {
                    if (i.status !in PAYABLE + "cancelled") return demoFail(409, "installment_not_payable", "A parcela de ${i.period} está \"$label\" e não pode ser isentada.")
                    val note = body.str("note")?.trim().orEmpty()
                    if (note.length > 300) invalid("Motivo até 300 caracteres.")
                    i.status = "waived"; i.waivedAt = now; i.note = note; i.updated = now
                    emit("mensalidade.waived", i.id, j("installment_id" to i.id, "subscription_id" to s.id, "amount_cents" to i.amount, "by" to Ids.ME, "note" to note, "module_id" to "mensalidade"))
                }
                else -> return demoFail(404, "not_found", "Recurso não encontrado.")
            }
            return demoOk(row(i))
        }
        if (r.size == 3 && r[0] == "subscriptions") {
            val s = sub(r[1]) ?: return demoFail(404, "not_found", "Assinatura não encontrada.")
            val to = when (r[2]) {
                "pause" -> "paused"
                "resume" -> "active"
                "end" -> "ended"
                else -> return demoFail(404, "not_found", "Recurso não encontrado.")
            }
            val allowed = mapOf("paused" to listOf("active"), "active" to listOf("paused"), "ended" to listOf("active", "paused"))
            if (s.status !in allowed.getValue(to)) {
                return demoFail(409, "invalid_transition", "Não é possível passar a assinatura de \"${SUBSCRIPTION_LABELS[s.status]}\" para \"${SUBSCRIPTION_LABELS[to]}\".")
            }
            val from = s.status
            s.status = to
            var cancelled = 0
            when (to) {
                "paused" -> s.pausedAt = now
                "active" -> s.pausedAt = null
                "ended" -> { s.endedAt = now; if (s.endDate == null || s.endDate!! > today) s.endDate = today }
            }
            if (to != "active") items.filter { it.sub == s.id && it.status == "open" && it.due >= today }.forEach { it.status = "cancelled"; it.cancelledAt = now; it.updated = now; cancelled++ }
            emit("mensalidade.subscription_changed", s.id, j("subscription_id" to s.id, "change" to if (to == "active") "resumed" else to, "from" to from, "status" to to, "cancelled_installments" to cancelled, "actor" to Ids.ME, "module_id" to "mensalidade"))
            return demoOk(subRow(s, withInstallments = false))
        }
        return demoFail(404, "not_found", "Recurso não encontrado.")
    }

    private fun installments(query: (String) -> String?, now: Long): Reply {
        val subscriptionId = query("subscription_id")?.takeIf { it.isNotEmpty() }
        val competence = if (subscriptionId != null) query("month")?.let(::month) else month(query("month") ?: BrasiliaTime.day(now).take(7))
        val scope = items.filter { (subscriptionId == null || it.sub == subscriptionId) && (competence == null || it.period == competence) }
        val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }.orEmpty()
        statuses.forEach { if (it !in STATUSES) invalid("Estado desconhecido: $it.") }
        val q = query("q")?.trim()?.lowercase().orEmpty()
        val digits = if (Regex("""[\d\s()+-]+""").matches(q)) q.filter(Char::isDigit) else ""
        val list = scope.filter { i ->
            val s = sub(i.sub)!!
            (statuses.isEmpty() || i.status in statuses) && (q.isEmpty() || s.name.lowercase().contains(q) || (digits.length >= 4 && s.phone.contains(digits)))
        }.sortedWith(compareBy({ it.due }, { it.id }))
        val counts = scope.groupingBy { it.status }.eachCount()
        return demoOk(j("month" to competence, "data" to list.map(::row), "next_cursor" to null, "counts" to j(*counts.map { it.key to it.value }.toTypedArray())))
    }

    private fun subscriptions(query: (String) -> String?): Reply {
        val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }.orEmpty()
        statuses.forEach { if (it !in SUBSCRIPTION_LABELS) invalid("Estado desconhecido: $it.") }
        val q = query("q")?.trim()?.lowercase().orEmpty()
        val digits = if (Regex("""[\d\s()+-]+""").matches(q)) q.filter(Char::isDigit) else ""
        val list = subs.filter { s ->
            val payer = payers.first { it.id == s.payer }
            (statuses.isEmpty() || s.status in statuses) &&
                (q.isEmpty() || s.name.lowercase().contains(q) || payer.name.lowercase().contains(q) || (digits.length >= 4 && s.phone.contains(digits)))
        }
        val counts = subs.groupingBy { it.status }.eachCount()
        return demoOk(j("data" to list.map { subRow(it, withInstallments = false) }, "next_cursor" to null, "counts" to j(*counts.map { it.key to it.value }.toTypedArray())))
    }

    private fun summary(competence: String): Reply {
        val month = items.filter { it.period == competence }
        fun sum(vararg statuses: String) = month.filter { it.status in statuses }.sumOf { it.amount }
        val start = BrasiliaTime.startOf("$competence-01") ?: 0L
        val end = BrasiliaTime.startOf(BrasiliaTime.addMonths(competence, 1) + "-01") ?: Long.MAX_VALUE
        val inMonth = items.filter { it.status == "paid" && (it.paidAt ?: 0) in start until end }
        val overdue = items.filter { it.status == "overdue" }
        return demoOk(
            j(
                "month" to competence, "expected_cents" to sum("open", "paid", "overdue"), "received_cents" to sum("paid"),
                "overdue_cents" to sum("overdue"), "open_cents" to sum("open"), "waived_cents" to sum("waived"),
                "counts" to j(*STATUSES.map { s -> s to month.count { it.status == s } }.toTypedArray()),
                "received_in_month" to j("count" to inMonth.size, "cents" to inMonth.sumOf { it.amount }),
                "overdue_total" to j("count" to overdue.size, "cents" to overdue.sumOf { it.amount }, "subscriptions" to overdue.map { it.sub }.distinct().size),
                "payments_ready" to true,
            ),
        )
    }

    private fun delinquents(): Reply {
        val rows = items.filter { it.status == "overdue" }.groupBy { it.sub }.mapNotNull { (id, list) ->
            val s = sub(id) ?: return@mapNotNull null
            j(
                "subscription_id" to id, "customer" to j("name" to s.name, "phone" to s.phone, "conversation_id" to s.conversationId),
                "plan_name" to plans.firstOrNull { it.id == s.plan }?.name, "subscription_status" to s.status, "overdue_count" to list.size,
                "overdue_cents" to list.sumOf { it.amount }, "oldest_due_date" to list.minOf { it.due }, "notices_sent" to list.maxOf { it.overdueNotices },
            )
        }.sortedWith(compareBy({ it.str("oldest_due_date") }, { it.str("subscription_id") }))
        return demoOk(j("data" to rows))
    }

    private fun statusLabel(status: String) = when (status) {
        "open" -> "Aberta"
        "paid" -> "Paga"
        "overdue" -> "Vencida"
        "cancelled" -> "Cancelada"
        "waived" -> "Isenta"
        else -> status
    }

    private fun periodLabel(period: String): String {
        val (y, m) = period.split("-")
        val names = listOf("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")
        return "${names[(m.toIntOrNull() ?: 1) - 1]}/$y"
    }

    private fun row(i: I): JsonObject {
        val s = sub(i.sub)!!
        return j(
            "id" to i.id, "subscription_id" to i.sub, "period_key" to i.period, "period_label" to periodLabel(i.period), "due_date" to i.due,
            "upfront" to false, "amount_cents" to i.amount, "status" to i.status, "status_label" to statusLabel(i.status),
            "customer" to j("name" to s.name, "phone" to s.phone), "plan_name" to plans.firstOrNull { it.id == s.plan }?.name,
            "payment" to i.chargedAt?.let { at ->
                j("id" to "pay-${i.id}", "status" to (i.paymentStatus ?: "created"), "expires_at" to (BrasiliaTime.startOf(i.due) ?: at) + 8 * 86_400_000L, "pix_code" to "00020126-PIX-DEMONSTRACAO-${i.id}", "url" to "https://pagamento.example/${i.id}", "charged_at" to at)
            },
            "notices" to j("before_at" to i.chargedAt, "due_at" to null, "overdue" to i.overdueNotices, "overdue_at" to if (i.overdueNotices > 0) i.chargedAt?.plus(3 * 86_400_000L) else null, "error" to if (s.conversationId == null && i.status in PAYABLE) "Sem conversa no WhatsApp com este telefone: o aviso não saiu." else null),
            "paid_at" to i.paidAt, "paid_via" to i.paidVia, "paid_by" to i.paidBy, "paid_note" to i.note,
            "waived_at" to i.waivedAt, "waived_by" to i.waivedAt?.let { Ids.ME }, "cancelled_at" to i.cancelledAt, "created" to 0, "updated" to i.updated,
        )
    }

    private fun subRow(s: S, withInstallments: Boolean): JsonObject {
        val mine = items.filter { it.sub == s.id }
        val payer = payers.first { it.id == s.payer }
        val fields = mutableListOf<Pair<String, Any?>>(
            "id" to s.id, "plan_id" to s.plan, "plan_name" to plans.firstOrNull { it.id == s.plan }?.name,
            "customer" to j("name" to s.name, "phone" to s.phone, "contact_id" to null, "conversation_id" to s.conversationId),
            "payer" to j("id" to payer.id, "name" to payer.name, "document_display" to null),
            "period" to "monthly", "period_label" to "Mensal", "amount_cents" to s.amount, "discount_cents" to s.discount, "charge_cents" to s.amount - s.discount,
            "due_day" to s.dueDay, "start_date" to "2026-02-01", "end_date" to s.endDate, "status" to s.status, "status_label" to SUBSCRIPTION_LABELS[s.status],
            "notes" to "", "paused_at" to s.pausedAt, "ended_at" to s.endedAt,
            "open_count" to mine.count { it.status == "open" }, "overdue_count" to mine.count { it.status == "overdue" },
            "overdue_cents" to mine.filter { it.status == "overdue" }.sumOf { it.amount }, "created_by" to Ids.ME, "created" to 0, "updated" to 0,
        )
        if (withInstallments) fields += "installments" to mine.sortedByDescending { it.due }.map(::row)
        return j(*fields.toTypedArray())
    }

    private fun payerRow(p: PayerRow, now: Long, detail: Boolean): JsonObject {
        val mine = subs.filter { it.payer == p.id }
        val fields = mutableListOf<Pair<String, Any?>>(
            "id" to p.id, "name" to p.name, "document" to null, "document_type" to null, "document_display" to null, "email" to "", "notes" to "",
            "phones" to p.phones.map { (phone, label) -> j("phone" to phone, "label" to label, "created_by" to Ids.ME, "created" to 0) },
            "created_by" to Ids.ME, "created" to 0, "updated" to 0,
        )
        if (detail) {
            val active = mine.filter { it.status == "active" }
            val today = BrasiliaTime.day(now)
            val late = items.filter { i -> active.any { it.id == i.sub } && i.status in PAYABLE && i.due < today }.minByOrNull { it.due }
            fields += "subscriptions" to mine.map { subRow(it, withInstallments = false) }
            fields += "situation" to j(
                "status" to when {
                    active.isEmpty() -> "sem_assinatura"
                    late != null -> "em_atraso"
                    else -> "em_dia"
                },
                "open_installment" to late?.let(::row),
                "grace_days" to 0,
            )
        }
        return j(*fields.toTypedArray())
    }

    private companion object {
        val STATUSES = listOf("open", "paid", "overdue", "cancelled", "waived")
        val PAYABLE = setOf("open", "overdue")
        val SUBSCRIPTION_LABELS = mapOf("active" to "Ativa", "paused" to "Pausada", "ended" to "Encerrada")
    }
}