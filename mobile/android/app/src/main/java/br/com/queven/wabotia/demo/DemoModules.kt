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
