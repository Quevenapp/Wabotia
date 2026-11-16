package br.com.queven.wabotia.demo

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.queue.CallFrame
import br.com.queven.wabotia.queue.CounterInfo
import br.com.queven.wabotia.queue.DeviceScopes
import br.com.queven.wabotia.queue.QueueInfo
import br.com.queven.wabotia.queue.QueueOverview
import br.com.queven.wabotia.queue.QueueSettings
import br.com.queven.wabotia.queue.QueueTicket
import br.com.queven.wabotia.queue.WaitMinutes
import br.com.queven.wabotia.queue.Waiting
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.ZoneId
import kotlin.math.ceil

/**
 * A fila de senhas da demonstração (docs/FILA-SENHAS.md), em memória: duas filas, três guichês, senhas aguardando e
 * uma atendente fictícia que chama sozinha de tempos em tempos, para o painel de chamadas falar e o guichê ter o que
 * fazer. Também responde ao pareamento do modo aparelho (aprovado sozinho) e à rota de capacidades. Chamado por
 * [DemoServer] dentro do mesmo trinco; nada aqui toca a rede.
 */
internal class DemoQueue(private val t0: Long) {
    private data class Q(
        val id: String,
        val name: String,
        val normal: String,
        val preferential: String,
        val channels: List<String>,
        val notice: String?,
        var normalsSincePreferential: Int = 0,
        val counters: MutableMap<Boolean, Int> = mutableMapOf(false to 0, true to 0),
    )

    private data class C(val id: String, val name: String, val queueIds: List<String>, var status: String, var userId: String?, var userName: String?, var current: String? = null)

    private data class T(
        val id: String,
        var queueId: String,
        val code: String,
        val preferential: Boolean,
        val source: String,
        var status: String = "waiting",
        var counterId: String? = null,
        /** Transferida direto para este guichê: passa à frente nele. */
        var reservedFor: String? = null,
        var callCount: Int = 0,
        val phone: String? = null,
        val conversationId: String? = null,
        val createdAt: Long,
        var calledAt: Long? = null,
        var startedAt: Long? = null,
        var finishedAt: Long? = null,
    )

    private val queues = listOf(
        Q("dq-geral", "Atendimento geral", "N", "P", listOf("whatsapp", "kiosk"), "Idosos (60+), gestantes, lactantes, pessoas com deficiência e com criança de colo."),
        Q("dq-retirada", "Retirada de documentos", "R", "S", listOf("whatsapp", "kiosk"), null),
    )
    private val counters = listOf(
        C("dc-1", "Guichê 1", listOf("dq-geral", "dq-retirada"), "closed", null, null),
        C("dc-2", "Guichê 2", listOf("dq-geral"), "open", Ids.ANA, "Ana Souza"),
        C("dc-3", "Guichê 3", listOf("dq-retirada"), "paused", null, null),
    )
    private val tickets = mutableListOf<T>()
    private val calls = ArrayDeque<CallFrame>()
    private val replies = HashMap<String, Reply>()
    private var seq = 0
    private var phoneSeq = 100
    private var nextAutoCall = t0 + 15_000
    private var nextAutoIssue = t0 + 22_000
    private val pairingPolls = HashMap<String, Int>()

    init {
        // A manhã já começou: algumas chamadas no painel e gente esperando.
        listOf(false, false, true, false).forEachIndexed { i, pref -> issue("dq-geral", pref, if (i % 2 == 0) "whatsapp" else "kiosk", t0 - (50 - i * 6) * 60_000L) }
        listOf(false, true).forEachIndexed { i, pref -> issue("dq-retirada", pref, "kiosk", t0 - (40 - i * 5) * 60_000L) }
        for (n in 0 until 3) {
            val c = counters[1]
            callNext(c, t0 - (30 - n * 9) * 60_000L)
            if (n < 2) finish(c, t0 - (26 - n * 9) * 60_000L)
        }
        listOf(false, true, false, false, true, false).forEachIndexed { i, pref -> issue("dq-geral", pref, if (i % 3 == 0) "kiosk" else "whatsapp", t0 - (12 - i * 2) * 60_000L) }
        listOf(false, false, true).forEachIndexed { i, pref -> issue("dq-retirada", pref, "whatsapp", t0 - (10 - i * 3) * 60_000L) }
    }

    // --- rotas -----------------------------------------------------------------

    /** `/api/v1/profiles/{p}/queue/…` com [r] já sem o `queue`. */
    fun handle(method: String, r: List<String>, body: JsonObject, idempotencyKey: String?, now: Long): Reply {
        tick(now)
        if (method == "GET") {
            return when {
                r.isEmpty() -> ok(overview(now))
                r.size == 1 && r[0] == "tickets" -> ok(j("data" to tickets.filter { localDay(it.createdAt) == localDay(now) }.map { json(ticket(it, now)) }))
                r.size == 2 && r[0] == "tickets" -> tickets.firstOrNull { it.id == r[1] }?.let { ok(json(ticket(it, now))) } ?: fail(404, "ticket_not_found", "Senha não encontrada.")
                r == listOf("ws") -> fail(400, "websocket_required", "Na demonstração a fila é lida por consulta.")
                else -> fail(404, "not_found", "Recurso não encontrado.")
            }
        }
        if (method != "POST") return fail(405, "method_not_allowed", "Método não permitido.")
        if (idempotencyKey.isNullOrBlank()) return fail(400, "idempotency_required", "Envie Idempotency-Key em toda escrita.")
        val signature = "$idempotencyKey|${r.joinToString("/")}|$body"
        replies[signature]?.let { return it }
        if (replies.keys.any { it.startsWith("$idempotencyKey|") }) return fail(409, "idempotency_conflict", "A mesma chave foi usada com outro pedido.")
        val reply = write(r, body, now)
        if (reply.code < 500) replies[signature] = reply
        return reply
    }

    private fun write(r: List<String>, body: JsonObject, now: Long): Reply {
        if (r == listOf("tickets")) {
            val queue = queues.firstOrNull { it.id == body.text("queue_id") } ?: return fail(404, "queue_not_found", "Fila não encontrada.")
            val source = body.text("source") ?: "kiosk"
            if (source !in queue.channels && source != "staff") return fail(409, "queue_closed", "Esta fila não recebe senhas por aqui.")
            val preferential = (body["preferential"] as? JsonPrimitive)?.contentOrNull == "true"
            return ok(json(ticket(issue(queue.id, preferential, source, now), now)))
        }
        if (r.size == 3 && r[0] == "counters") {
            val counter = counters.firstOrNull { it.id == r[1] } ?: return fail(404, "counter_not_found", "Guichê não encontrado.")
            return when (r[2]) {
                "state" -> {
                    val status = body.text("status")
                    if (status !in setOf("open", "paused", "closed")) return fail(422, "invalid", "Estado inválido.")
                    counter.status = status!!
                    if (status == "open") { counter.userId = Ids.ME; counter.userName = DemoMode.USER_NAME }
                    if (status == "closed") { counter.userId = null; counter.userName = null }
                    ok(json(counterInfo(counter, now)))
                }
                "call-next" -> {
                    if (counter.status != "open") return fail(409, "counter_closed", "Abra o guichê para chamar.")
                    if (counter.userId == null) { counter.userId = Ids.ME; counter.userName = DemoMode.USER_NAME }
                    val called = callNext(counter, now) ?: return fail(404, "queue_empty", "Nenhuma senha aguardando nas filas deste guichê.")
                    ok(json(ticket(called, now)))
                }
                else -> fail(404, "not_found", "Recurso não encontrado.")
            }
        }
        if (r.size == 3 && r[0] == "tickets") {
            val t = tickets.firstOrNull { it.id == r[1] } ?: return fail(404, "ticket_not_found", "Senha não encontrada.")
            val counter = counters.firstOrNull { it.id == t.counterId }
            val invalid = fail(409, "invalid_transition", "Esta ação não vale para a senha agora.")
            when (r[2]) {
                "recall" -> {
                    if (t.status != "called" || counter == null) return invalid
                    t.callCount++
                    t.calledAt = now
                    announce(t, counter, now, recall = true)
                }
                "start" -> {
                    if (t.status != "called") return invalid
                    t.status = "serving"
                    t.startedAt = now
                }
                "finish" -> {
                    if (t.status != "called" && t.status != "serving" || counter == null) return invalid
                    finish(counter, now)
                }
                "no-show" -> {
                    if (t.status != "called") return invalid
                    t.status = "no_show"
                    t.finishedAt = now
                    counter?.current = null
                }
                "cancel" -> {
                    if (t.status !in setOf("waiting", "called", "serving")) return invalid
                    t.status = "cancelled"
                    t.finishedAt = now
                    if (counter?.current == t.id) counter.current = null
                }
                "transfer" -> {
                    if (t.status != "called" && t.status != "serving") return invalid
                    val toQueue = body.text("queue_id")?.let { id -> queues.firstOrNull { it.id == id } ?: return fail(404, "queue_not_found", "Fila não encontrada.") }
                    val toCounter = body.text("counter_id")?.let { id -> counters.firstOrNull { it.id == id } ?: return fail(404, "counter_not_found", "Guichê não encontrado.") }
                    if ((toQueue == null) == (toCounter == null)) return fail(422, "invalid", "Escolha uma fila ou um guichê.")
                    counter?.current = null
                    t.status = "waiting"
                    t.counterId = null
                    if (toQueue != null) { t.queueId = toQueue.id; t.reservedFor = null }
                    if (toCounter != null) t.reservedFor = toCounter.id
                }
                else -> return fail(404, "not_found", "Recurso não encontrado.")
            }
            return ok(json(ticket(t, now)))
        }
        return fail(404, "not_found", "Recurso não encontrado.")
    }

    /** `GET /api/v1/profiles/{p}/capabilities`: o registro de módulos com a fila ligada. */
    fun capabilities(): Reply = ok(
        j(
            "version" to "demonstração",
            "modules" to listOf(j("id" to "queue", "name" to "Fila presencial", "version" to "1.0.0", "enabled" to true)),
        ),
    )

    /** `POST /api/pairing/start`: um código fictício que se aprova sozinho na segunda consulta. */
    fun pairingStart(body: JsonObject): Reply {
        if (body.text("client") != "senhapp") return fail(422, "invalid", "Escolha Vinki, Fagoo ou Senhapp.")
        if (body.text("instance_name").isNullOrBlank()) return fail(422, "invalid", "Informe o nome desta instalação (até 80 caracteres).")
        val device = "d".repeat(8) + (++seq).toString().padStart(56, '0')
        pairingPolls[device] = 0
        return ok(j("device_code" to device, "user_code" to "DEMO-2345", "verification_uri" to "${DemoMode.SERVER}/app?pair=1", "expires_in" to 600, "interval" to 2, "client" to "senhapp"))
    }

    /** `POST /api/pairing/token`. */
    fun pairingToken(body: JsonObject): Reply {
        val device = body.text("device_code") ?: return fail(400, "invalid_grant", "Solicitação de pareamento inválida.")
        val polls = pairingPolls[device] ?: return fail(400, "invalid_grant", "Solicitação de pareamento inválida.")
        pairingPolls[device] = polls + 1
        if (polls < 1) return ok(j("status" to "authorization_pending", "interval" to 2))
        pairingPolls.remove(device)
        return ok(
            j(
                "status" to "connected", "access_token" to DemoMode.DEVICE_TOKEN, "token_type" to "Bearer", "expires_in" to 365 * 86400,
                "profile_id" to Ids.PROFILE, "application_id" to "demo-app", "scopes" to DeviceScopes.requested,
                "number_ids" to emptyList<String>(), "pool_ids" to emptyList<String>(), "bot_ids" to emptyList<String>(),
            ),
        )
    }

    // --- regras (versão curta das do servidor) -----------------------------------

    private fun issue(queueId: String, preferential: Boolean, source: String, at: Long): T {
        val q = queues.first { it.id == queueId }
        val number = (q.counters[preferential] ?: 0) + 1
        q.counters[preferential] = number
        val prefix = if (preferential) q.preferential else q.normal
        val viaWhatsapp = source == "whatsapp"
        val t = T(
            id = "dt-${++seq}",
            queueId = queueId,
            code = prefix + number.toString().padStart(3, '0'),
            preferential = preferential,
            source = source,
            // Telefones fictícios: DDD 20 (inexistente) e número começando por 9 0, como no resto da demonstração.
            phone = if (viaWhatsapp) "552090000" + (phoneSeq++).toString().padStart(4, '0') else null,
            conversationId = if (viaWhatsapp && queueId == "dq-geral" && seq % 4 == 1) Ids.C_QUEUE else null,
            createdAt = at,
        )
        tickets += t
        return t
    }

    /** Ordem de chamada do contrato: reservada ao guichê, dívida de normais, preferencial, prioridade e emissão. */
    private fun callNext(counter: C, at: Long): T? {
        counter.current?.let { id -> tickets.firstOrNull { it.id == id }?.takeIf { it.status == "called" || it.status == "serving" }?.let { finish(counter, at) } }
        val waiting = tickets.filter { it.status == "waiting" && it.queueId in counter.queueIds && (it.reservedFor == null || it.reservedFor == counter.id) }
        if (waiting.isEmpty()) return null
        val reserved = waiting.filter { it.reservedFor == counter.id }.minByOrNull { it.createdAt }
        val pick = reserved ?: run {
            val byQueue = waiting.groupBy { it.queueId }
            val candidates = byQueue.mapNotNull { (queueId, list) ->
                val q = queues.first { it.id == queueId }
                val normals = list.filter { !it.preferential }.minByOrNull { it.createdAt }
                val prefs = list.filter { it.preferential }.minByOrNull { it.createdAt }
                if (normals != null && (prefs == null || q.normalsSincePreferential < NORMALS_PER_PREFERENTIAL)) normals else prefs ?: normals
            }
            candidates.minByOrNull { it.createdAt }
        } ?: return null
        val q = queues.first { it.id == pick.queueId }
        q.normalsSincePreferential = if (pick.preferential) 0 else q.normalsSincePreferential + 1
        pick.status = "called"
        pick.counterId = counter.id
        pick.reservedFor = null
        pick.callCount = 1
        pick.calledAt = at
        counter.current = pick.id
        announce(pick, counter, at, recall = false)
        return pick
    }

    private fun finish(counter: C, at: Long) {
        val t = tickets.firstOrNull { it.id == counter.current } ?: return
        if (t.startedAt == null) t.startedAt = t.calledAt ?: at
        t.status = "done"
        t.finishedAt = at
        counter.current = null
    }

    private fun announce(t: T, counter: C, at: Long, recall: Boolean) {
        val q = queues.first { it.id == t.queueId }
        calls.addFirst(
            CallFrame(
                ticketId = t.id, code = t.code, preferential = t.preferential, queueId = q.id, queueName = q.name,
                counterId = counter.id, counterName = counter.name, callCount = t.callCount, recall = recall, at = at,
                speech = "Senha ${t.code.take(1)} ${t.code.drop(1).trimStart('0')}, ${counter.name}",
            ),
        )
        while (calls.size > 10) calls.removeLast()
    }

    /** O dia anda sozinho: a atendente chama a próxima e chegam senhas pelo WhatsApp. */
    private fun tick(now: Long) {
        var guard = 0
        while (now >= nextAutoCall && guard++ < 3) {
            callNext(counters[1], nextAutoCall)
            nextAutoCall += AUTO_CALL_MS
        }
        if (now >= nextAutoCall) nextAutoCall = now + AUTO_CALL_MS
        guard = 0
        while (now >= nextAutoIssue && guard++ < 3) {
            if (tickets.count { it.status == "waiting" } < 14) issue(if (seq % 3 == 0) "dq-retirada" else "dq-geral", seq % 4 == 0, "whatsapp", nextAutoIssue)
            nextAutoIssue += AUTO_ISSUE_MS
        }
        if (now >= nextAutoIssue) nextAutoIssue = now + AUTO_ISSUE_MS
    }

    // --- leitura -------------------------------------------------------------------

    private fun overview(now: Long): JsonObject = json(
        QueueOverview(
            day = localDay(now),
            settings = QueueSettings(frontDoor = true, notifyAhead = 2),
            queues = queues.map { q ->
                val waiting = tickets.filter { it.queueId == q.id && it.status == "waiting" }
                val open = counters.count { it.status == "open" && q.id in it.queueIds }
                QueueInfo(
                    id = q.id, name = q.name, prefixNormal = q.normal, prefixPreferential = q.preferential, preferentialNotice = q.notice,
                    normalsPerPreferential = NORMALS_PER_PREFERENTIAL, waitMode = "fixed", channels = q.channels, enabled = true,
                    waiting = Waiting(waiting.count { !it.preferential }, waiting.count { it.preferential }),
                    waitMinutes = WaitMinutes(wait(waiting.size, open), wait(waiting.count { it.preferential }, open)),
                    openCounters = open,
                )
            },
            counters = counters.map { counterInfo(it, now) },
            recentCalls = calls.toList(),
        ),
    )

    private fun counterInfo(c: C, now: Long) = CounterInfo(
        id = c.id, name = c.name, queueIds = c.queueIds, status = c.status, userId = c.userId, userName = c.userName,
        current = tickets.firstOrNull { it.id == c.current }?.let { ticket(it, now) },
    )

    private fun ticket(t: T, now: Long): QueueTicket {
        val q = queues.first { it.id == t.queueId }
        val waiting = tickets.filter { it.queueId == q.id && it.status == "waiting" && it.createdAt < t.createdAt }
        val ahead = if (t.status != "waiting") 0 else if (t.preferential) waiting.count { it.preferential } else waiting.size
        val open = counters.count { it.status == "open" && q.id in it.queueIds }
        return QueueTicket(
            id = t.id, queueId = q.id, queueName = q.name, code = t.code, preferential = t.preferential, source = t.source,
            status = t.status, counterId = t.counterId, counterName = counters.firstOrNull { it.id == t.counterId }?.name,
            callCount = t.callCount, ahead = ahead, waitMinutes = if (t.status == "waiting") wait(ahead, open) else null,
            phone = t.phone, conversationId = t.conversationId, windowOpen = t.phone?.let { !it.endsWith("7") },
            createdAt = t.createdAt, calledAt = t.calledAt, startedAt = t.startedAt, finishedAt = t.finishedAt,
            serviceDay = localDay(t.createdAt), publicToken = "demo${t.id}",
            whatsappLink = "https://wa.me/${DemoMode.WHATSAPP_LINE}?text=SENHA%20${t.code}%20DEMO${t.id.filter(Char::isDigit)}",
        )
    }

    private fun wait(ahead: Int, open: Int): Int = ceil(ahead * SERVICE_MINUTES / maxOf(1, open).toDouble()).toInt()

    private fun localDay(at: Long) = java.time.Instant.ofEpochMilli(at).atZone(ZoneId.of("America/Sao_Paulo")).toLocalDate().toString()

    private fun <T> json(value: T): JsonObject = when (value) {
        is QueueOverview -> WabotiaJson.encodeToJsonElement(QueueOverview.serializer(), value) as JsonObject
        is QueueTicket -> WabotiaJson.encodeToJsonElement(QueueTicket.serializer(), value) as JsonObject
        is CounterInfo -> WabotiaJson.encodeToJsonElement(CounterInfo.serializer(), value) as JsonObject
        is JsonObject -> value
        else -> error("tipo inesperado")
    }

    private fun ok(element: JsonObject) = Reply.json(element)
    private fun fail(code: Int, errorCode: String, message: String) = Reply.error(code, errorCode, message)
    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private companion object {
        const val NORMALS_PER_PREFERENTIAL = 2
        const val SERVICE_MINUTES = 6.0
        const val AUTO_CALL_MS = 20_000L
        const val AUTO_ISSUE_MS = 27_000L
    }
}
