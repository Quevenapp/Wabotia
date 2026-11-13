package br.com.queven.wabotia.demo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicLong

/**
 * Servidor Wabotia fictício, em memória, para o modo de demonstração do build de depuração.
 * Responde a toda chamada para `demo.wabotia.localhost`; as demais seguem para a rede normalmente.
 */
internal class DemoInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!request.url.host.equals(DemoServer.HOST, ignoreCase = true)) return chain.proceed(request)
        val reply = try {
            DemoServer.handle(request)
        } catch (e: Exception) {
            Reply.error(500, "demo_error", "Falha no servidor de demonstração: ${e.message ?: e.javaClass.simpleName}")
        }
        if (reply.delayMs > 0) {
            try {
                Thread.sleep(reply.delayMs)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        return try {
            reply.toResponse(request)
        } catch (e: Exception) {
            Reply.error(500, "demo_error", "Falha no servidor de demonstração.").toResponse(request)
        }
    }
}

internal class Reply(
    val code: Int,
    val body: ByteArray,
    val type: String = "application/json; charset=utf-8",
    val headers: List<Pair<String, String>> = emptyList(),
    val delayMs: Long = 120,
) {
    fun toResponse(request: Request): Response {
        val mediaType = type.toMediaTypeOrNull() ?: "application/octet-stream".toMediaType()
        val builder = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(
                when (code) {
                    200 -> "OK"
                    201 -> "Created"
                    202 -> "Accepted"
                    206 -> "Partial Content"
                    404 -> "Not Found"
                    409 -> "Conflict"
                    422 -> "Unprocessable Entity"
                    else -> if (code < 400) "OK" else "Error"
                },
            )
            .header("Content-Type", mediaType.toString())
            .header("Content-Length", body.size.toString())
            .header("Cache-Control", "private, no-store")
        for ((name, value) in headers) builder.header(name, value)
        return builder.body(body.toResponseBody(mediaType)).build()
    }

    companion object {
        fun json(element: JsonElement, code: Int = 200): Reply = Reply(code, element.toString().toByteArray(Charsets.UTF_8))
        fun error(code: Int, errorCode: String, message: String): Reply =
            json(j("error" to j("code" to errorCode, "message" to message, "request_id" to "demo")), code)
    }
}

internal object DemoServer {
    const val HOST = "demo.wabotia.localhost"
    private const val DAY_MS = 24L * 60 * 60 * 1000

    private val lock = Any()
    private var state: DemoState? = null

    /** Ids de evento crescem sempre (inclusive entre reinícios do app), para o cursor salvo nunca "passar" dos novos. */
    private val eventSeq = AtomicLong(System.currentTimeMillis())

    /** Volta os dados ao estado inicial. Chamado a cada entrada na demonstração. */
    fun reset(): DemoState = synchronized(lock) {
        val fresh = DemoState(System.currentTimeMillis())
        fresh.seed()
        state = fresh
        // Um evento inicial faz a primeira consulta (cursor 0) avançar o cursor; sem ele os primeiros eventos reais seriam pulados.
        fresh.emit("demo.started", null, j("profile" to Ids.PROFILE), fresh.t0)
        fresh
    }

    fun <T> withState(block: (DemoState) -> T): T = synchronized(lock) { block(state ?: reset()) }

    fun handle(request: Request): Reply = synchronized(lock) {
        val s = state ?: reset()
        val now = System.currentTimeMillis()
        s.tick(now)
        route(s, request, now)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Eventos e tarefas agendadas
    // -----------------------------------------------------------------------------------------------------------

    private fun DemoState.emit(kind: String, resourceId: String?, payload: JsonObject, at: Long) {
        events += j("id" to eventSeq.incrementAndGet(), "profile_id" to Ids.PROFILE, "kind" to kind, "resource_id" to resourceId, "payload" to payload, "created" to at)
        if (events.size > 600) events.subList(0, 200).clear()
    }

    private fun DemoState.later(at: Long, run: (at: Long) -> Unit) {
        scheduled += Task(at, run)
    }

    /** Executa o que já venceu (entregas confirmadas, resposta do cliente, fim de execuções de bot...). */
    private fun DemoState.tick(now: Long) {
        var guard = 0
        while (guard++ < 200) {
            val due = scheduled.filter { it.at <= now }.minByOrNull { it.at } ?: return
            scheduled.remove(due)
            runCatching { due.run(due.at) }
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Rotas
    // -----------------------------------------------------------------------------------------------------------

    private fun ok(element: JsonElement, code: Int = 200) = Reply.json(element, code)
    private fun okEmpty() = ok(j("ok" to true))
    private fun notFound(message: String = "Recurso não encontrado.") = Reply.error(404, "not_found", message)
    private fun invalid(message: String) = Reply.error(422, "invalid", message)

    private fun bodyBytes(request: Request): ByteArray {
        val body = request.body ?: return ByteArray(0)
        val buffer = Buffer()
        body.writeTo(buffer)
        return buffer.readByteArray()
    }

    private fun bodyJson(request: Request): JsonObject {
        val text = String(bodyBytes(request), Charsets.UTF_8)
        if (text.isBlank()) return JsonObject(emptyMap())
        return runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
    }

    private fun route(s: DemoState, request: Request, now: Long): Reply {
        val method = request.method.uppercase()
        val segments = request.url.pathSegments.filter { it.isNotEmpty() }
        if (segments.firstOrNull() != "api") return notFound()
        val path = segments.drop(1)
        when (path) {
            listOf("health") -> return ok(j("service" to "wabotia", "version" to "0.14.0-demo", "commit" to "demo0000", "runtime" to "demo"))
            listOf("auth", "status") -> return ok(j("initialized" to true, "configured" to true))
            listOf("auth", "mobile", "login") -> return ok(sessionJson(now))
        }
        if (path.firstOrNull() != "v1") return notFound()
        val p = path.drop(1)
        return when {
            p == listOf("me") -> ok(j("id" to Ids.ME, "kind" to "user", "name" to s.userName(Ids.ME), "role" to "admin", "profiles" to listOf(Ids.PROFILE)))
            p == listOf("profiles") -> ok(JsonArray(listOf(j("id" to Ids.PROFILE, "name" to "Queven Atendimento", "enabled" to 1, "settings" to j(), "created" to s.t0 - 200 * DAY_MS))))
            p == listOf("logout") -> okEmpty()
            p == listOf("auth", "mobile", "refresh") -> ok(sessionJson(now))
            p.firstOrNull() == "devices" -> devices(s, method, p.drop(1), request, now)
            p == listOf("bot-runs") && method == "POST" -> startBotRun(s, bodyJson(request), now)
            p.size == 2 && p[0] == "bot-runs" && method == "GET" ->
                s.botRuns.firstOrNull { it.str("id") == p[1] }?.let { ok(it.json()) } ?: notFound("Execução não encontrada.")
            p.size >= 3 && p[0] == "profiles" -> profile(s, method, p.drop(2), request, now)
            else -> notFound()
        }
    }

    private fun sessionJson(now: Long): JsonObject = j(
        "token" to "wabu_demo",
        "expires" to now + 30 * DAY_MS,
        "user" to j("id" to Ids.ME, "name" to "Bruno Almeida", "email" to "bruno@queven.demo", "role" to "admin", "profiles" to listOf(Ids.PROFILE)),
    )

    private fun profile(s: DemoState, method: String, r: List<String>, request: Request, now: Long): Reply {
        val url = request.url
        return when (r[0]) {
            "status" -> ok(status(s))
            "presence" -> if (method == "PUT") {
                val value = bodyJson(request).bool("present") ?: false
                s.present[Ids.ME] = value
                ok(j("actor" to Ids.ME, "present" to value))
            } else {
                ok(JsonArray(s.users.map { (id, name) -> j("actor" to id, "name" to name, "present" to if (s.present[id] == true) 1 else 0, "telegram_id" to null) }))
            }
            "events" -> {
                val after = url.queryParameter("after")?.toLongOrNull() ?: 0L
                val data = s.events.filter { it.long("id") > after }.take(100)
                val cursor = data.lastOrNull()?.long("id") ?: maxOf(after, s.events.lastOrNull()?.long("id") ?: 0L)
                Reply(200, j("data" to data, "cursor" to cursor).toString().toByteArray(Charsets.UTF_8), delayMs = 40)
            }
            "conversations" -> conversations(s, method, r.drop(1), request, now)
            "groups" -> if (r.size == 3 && r[2] == "policy" && method == "PUT") {
                val c = s.conversations[r[1]] ?: return notFound("Grupo não encontrado.")
                c.assign("bot_policy", bodyJson(request).str("bot_policy") ?: "mentions")
                c.assign("updated", now)
                s.emit("conversation.updated", r[1], j("conversation_id" to r[1]), now)
                ok(c.json())
            } else notFound()
            "contacts" -> r.getOrNull(1)?.let { s.contacts[it] }?.let { ok(it) } ?: notFound("Contato não encontrado.")
            "media" -> media(s, method, r.drop(1), request)
            "tickets" -> tickets(s, method, r.drop(1), request, now)
            "bots" -> if (r.size == 1) {
                ok(j("data" to s.bots.map { it.json() }, "next_cursor" to null))
            } else if (method == "PATCH") {
                val bot = s.bots.firstOrNull { it.str("id") == r[1] } ?: return notFound("Bot não encontrado.")
                val body = bodyJson(request)
                if (body.containsKey("line_ids")) {
                    val value = body["line_ids"]
                    bot.assign("line_ids", if (value is JsonArray) value.toString() else null)
                }
                body.str("name")?.let { bot.assign("name", it) }
                ok(bot.json())
            } else notFound()
            "bot-runs" -> if (r.size == 1) {
                ok(j("data" to s.botRuns.sortedByDescending { it.long("created") }.map { it.json() }, "next_cursor" to null))
            } else if (r.size == 3 && r[2] == "cancel") {
                val run = s.botRuns.firstOrNull { it.str("id") == r[1] } ?: return notFound("Execução não encontrada.")
                if (run.str("status") in setOf("queued", "starting", "running")) {
                    run.assign("status", "cancelled")
                    run.assign("updated", now)
                }
                ok(j("id" to r[1], "status" to run.str("status")))
            } else notFound()
            "calls" -> calls(s, method, r.drop(1), request)
            "team" -> ok(j("data" to team(s)))
            "lines" -> if (r.size == 1) {
                ok(j("data" to s.lines.map { it.json() }, "next_cursor" to null))
            } else if (method == "PUT") {
                val line = s.lines.firstOrNull { it.str("id") == r[1] } ?: return notFound("Linha não encontrada.")
                val body = bodyJson(request)
                (body["service"] as? JsonObject)?.let { line.assign("service", it) }
                (body["number_policy"] as? JsonObject)?.let { line.assign("number_policy", it) }
                ok(line.json())
            } else notFound()
            "menus" -> {
                val connection = url.queryParameter("connection_id")
                val visible = s.menus.filter { menu ->
                    val scope = (menu["line_ids"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                    connection == null || scope.isEmpty() || connection in scope
                }
                ok(j("data" to visible, "next_cursor" to null))
            }
            "settings" -> {
                val body = bodyJson(request)
                (body["menus"] as? JsonArray)?.let { list -> s.menus = list.mapNotNull { it as? JsonObject } }
                ok(j("ok" to true, "settings" to settings(s)))
            }
            "internal-chats" -> internalChats(s, method, r.drop(1), request, now)
            else -> notFound()
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Perfil, equipe
    // -----------------------------------------------------------------------------------------------------------

    private fun settings(s: DemoState): JsonObject =
        j("departments" to s.departments, "menus" to s.menus, "apps" to emptyList<String>(), "ticket_categories" to s.ticketCategories)

    /** Ativo = não é `resolved` nem `closed` (docs/CENTRAL-ATENDIMENTO.md §2). */
    private fun isActive(ticket: Map<String, JsonElement>): Boolean = ticket.str("status").let { it != "resolved" && it != "closed" }

    private val ticketStatuses = setOf("open", "in_progress", "waiting_customer", "waiting_third", "resolved", "closed")

    /** `last_message` de GET /conversations (§6): última mensagem que não é evento do sistema, ou null. */
    private fun lastMessage(s: DemoState, conversationId: String): JsonElement {
        val last = s.messages[conversationId].orEmpty().lastOrNull { it.str("direction") != "system" } ?: return JsonNull
        val attachments = attachmentIds(last)
        val content = runCatching { Json.parseToJsonElement(last.str("content") ?: "{}") as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        val mime = attachments.firstOrNull()?.let { s.media[it]?.type }.orEmpty()
        val kind = when {
            content.containsKey("location") -> "location"
            content.containsKey("contacts") -> "contacts"
            content.str("type") == "voice" -> "audio"
            content.str("type") in setOf("image", "video", "audio", "document", "sticker", "interactive") -> content.str("type")
            mime.startsWith("image/") -> "image"
            mime.startsWith("video/") -> "video"
            mime.startsWith("audio/") -> "audio"
            attachments.isNotEmpty() -> "document"
            else -> "text"
        }
        return j(
            "text" to last.str("text"), "direction" to last.str("direction"), "created" to last.long("created"),
            "delivery_status" to last.str("delivery_status"), "attachments" to attachments.size, "kind" to kind,
        )
    }

    private fun status(s: DemoState): JsonObject {
        val counts = s.conversations.values.groupingBy { it.str("state") ?: "ai" }.eachCount()
        val pending = s.deliveries.values.flatten().groupingBy { it.str("status") ?: "pending" }.eachCount()
        return j(
            "settings" to settings(s),
            "enabled" to 1,
            "conversations" to listOf("ai", "waiting", "human", "closed").map { j("state" to it, "count" to (counts[it] ?: 0)) },
            "deliveries" to pending.map { j("status" to it.key, "count" to it.value) },
            "connections" to s.lines.map { j("id" to it.str("id"), "name" to it.str("name"), "kind" to it.str("kind"), "status" to it.str("status"), "last_seen" to System.currentTimeMillis() - 20_000) },
        )
    }

    private fun botLineIds(bot: Map<String, JsonElement>): JsonElement {
        val raw = bot.str("line_ids") ?: return JsonNull
        return runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: JsonNull
    }

    private fun team(s: DemoState): List<JsonObject> =
        s.users.map { (id, name) -> j("id" to id, "kind" to "user", "name" to name, "online" to (s.present[id] == true)) } +
            s.bots.map { bot ->
                val id = bot.str("id").orEmpty()
                j(
                    "id" to "bot:$id", "kind" to "bot", "bot_id" to id, "name" to bot.str("name"),
                    "online" to (s.botOnline[id] == true), "enabled" to (bot.long("enabled") != 0L),
                    "last_seen" to System.currentTimeMillis() - 15_000, "line_ids" to botLineIds(bot),
                )
            }

    private fun teamEntry(s: DemoState, id: String): JsonObject =
        team(s).firstOrNull { it.str("id") == id }
            ?: j("id" to id, "kind" to if (id.startsWith("bot:")) "bot" else "user", "name" to "Contato indisponível", "online" to false)

    // -----------------------------------------------------------------------------------------------------------
    // Dispositivos
    // -----------------------------------------------------------------------------------------------------------

    private fun devices(s: DemoState, method: String, r: List<String>, request: Request, now: Long): Reply = when {
        r.isEmpty() -> ok(j("data" to s.devices.values.map { it.json() }, "next_cursor" to null))
        r.size == 2 && r[1] == "test" -> ok(j("results" to listOf(j("status" to "ok", "device_id" to r[0]))))
        method == "PUT" -> {
            val body = bodyJson(request)
            val device = row(
                "id" to r[0], "user_id" to Ids.ME, "platform" to (body.str("platform") ?: "android"), "provider" to (body.str("provider") ?: "fcm"),
                "name" to (body.str("name") ?: "Android"), "app_version" to (body.str("app_version") ?: ""),
                "profiles" to (body["profiles"] as? JsonArray ?: JsonArray(emptyList())),
                "enabled" to if (body.bool("enabled") == false) 0 else 1, "last_error" to null,
                "created" to (s.devices[r[0]]?.long("created") ?: now), "updated" to now,
            )
            s.devices[r[0]] = device
            ok(device.json())
        }
        method == "DELETE" -> {
            s.devices.remove(r[0])
            okEmpty()
        }
        else -> notFound()
    }

    // -----------------------------------------------------------------------------------------------------------
    // Conversas
    // -----------------------------------------------------------------------------------------------------------

    private fun conversations(s: DemoState, method: String, r: List<String>, request: Request, now: Long): Reply {
        if (r.isEmpty()) {
            val url = request.url
            val state = url.queryParameter("state")?.takeIf { it.isNotBlank() }
            val query = url.queryParameter("q")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            val limit = url.queryParameter("limit")?.toIntOrNull()?.coerceIn(1, 200) ?: 50
            val digits = query?.filter { it.isDigit() }.orEmpty()
            val list = s.conversations.values
                .filter { state == null || it.str("state") == state }
                .filter { c ->
                    if (query == null) return@filter true
                    val name = (c.str("contact_name") ?: c.str("title")).orEmpty().lowercase()
                    name.contains(query) || (digits.length >= 3 && c.str("phone").orEmpty().contains(digits))
                }
                .sortedByDescending { it.long("updated") }
                .take(limit)
            return ok(j("data" to list.map { JsonObject(it + ("last_message" to lastMessage(s, it.str("id").orEmpty()))) }, "next_cursor" to null))
        }
        val id = r[0]
        val c = s.conversations[id] ?: return notFound("Conversa não encontrada.")
        return when (r.getOrNull(1)) {
            null -> ok(detail(s, c))
            "actions" -> action(s, c, bodyJson(request), now)
            "message-actions" -> messageAction(s, c, bodyJson(request), now)
            else -> notFound()
        }
    }

    private fun capabilities(c: Map<String, JsonElement>): JsonObject {
        val zernio = c.str("connection_id") == Ids.LINE_ZERNIO
        val group = c.str("chat_type") == "group"
        return j(
            "image" to true, "video" to true, "audio" to true, "voice" to true, "document" to true, "sticker" to true,
            "location" to true, "contacts" to true, "reply" to true, "reaction" to true, "read" to true,
            "calls" to false, "edit" to zernio, "delete" to zernio, "mentions" to group, "groups" to group,
        )
    }

    private fun attachmentIds(message: Map<String, JsonElement>): List<String> {
        val raw = message.str("attachments") ?: return emptyList()
        return (runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull())?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
    }

    private fun detail(s: DemoState, c: Row): JsonObject {
        val id = c.str("id").orEmpty()
        val messages = s.messages[id].orEmpty()
        val media = messages.flatMap { attachmentIds(it) }.distinct().mapNotNull { s.media[it] }
            .map { j("id" to it.id, "name" to it.name, "type" to it.type, "size" to it.size) }
        return j(
            "conversation" to c.json(),
            "media" to media,
            "capabilities" to capabilities(c),
            "group" to s.groups[id],
            "contact" to c.str("contact_id")?.let { s.contacts[it] },
            "messages" to messages.map { it.json() },
            "deliveries" to s.deliveries[id].orEmpty().map { it.json() },
        )
    }

    private fun DemoState.system(conversationId: String, text: String, at: Long) {
        addMessage(conversationId, "system", "system", text, at, id = nextId("m-$conversationId-s"))
    }

    private fun DemoState.touch(c: Row, at: Long) {
        c.assign("updated", at)
        c.assign("epoch", c.long("epoch") + 1)
        emit("conversation.updated", c.str("id"), j("conversation_id" to c.str("id"), "state" to c.str("state"), "owner" to c.str("owner")), at)
    }

    private fun windowClosed(c: Map<String, JsonElement>, now: Long): Boolean {
        if (c.str("chat_type") == "group") return false
        val last = c.long("last_customer")
        return last <= 0 || now - last > DAY_MS
    }

    /** Mensagem de saída (minha ou automática), com a progressão enviada → entregue → lida. */
    private fun DemoState.outbound(c: Row, text: String, now: Long, content: JsonObject = j("type" to "text"), attachments: List<String> = emptyList()): Row {
        val id = c.str("id").orEmpty()
        val queued = windowClosed(c, now)
        val message = addMessage(id, "outbound", Ids.ME, text, now, if (queued) "pending" else "sent", content, attachments, id = nextId("m-$id-o"))
        val messageId = message.str("id")
        if (queued) {
            deliveries.getOrPut(id) { ArrayList() } += row("id" to "d-$messageId", "status" to "pending", "error" to null, "created" to now, "message_id" to messageId)
        } else {
            emit("message.sent", messageId, j("conversation_id" to id, "message_id" to messageId, "text" to text, "attachments" to attachments), now)
            later(now + 2_000) { at -> advance(id, message, "sent", "delivered", at) }
            later(now + 5_000) { at -> advance(id, message, "delivered", "read", at) }
        }
        c.assign("updated", now)
        return message
    }

    private fun DemoState.advance(conversationId: String, message: Row, from: String, to: String, at: Long) {
        if (message.str("delivery_status") != from) return
        message.assign("delivery_status", to)
        message.assign("status_at", at)
        emit("message.updated", message.str("id"), j("conversation_id" to conversationId, "message_id" to message.str("id"), "delivery_status" to to), at)
    }

    private val customerReplies = listOf(
        "Perfeito, obrigado!",
        "Ótimo, fico no aguardo então.",
        "Entendi! Muito obrigada pela ajuda. 😊",
        "Combinado, pode seguir assim.",
        "Show, valeu pelo retorno!",
    )

    /** Depois de uma resposta minha, o cliente responde em ~6 s: mexe na janela, na prévia e nas não lidas. */
    private fun DemoState.scheduleCustomerReply(c: Row, now: Long) {
        val id = c.str("id").orEmpty()
        val due = now + 6_000
        pendingCustomerReply[id] = due
        later(due) { at ->
            if (pendingCustomerReply[id] != due) return@later
            pendingCustomerReply.remove(id)
            if (c.str("state") == "closed") return@later
            val list = messages.getOrPut(id) { ArrayList() }
            val text = customerReplies[autoReplies++ % customerReplies.size]
            val group = groups[id]
            val content = if (group != null) {
                j("type" to "text", "participant" to "5511970002222", "participant_name" to "Helena · Bloco B")
            } else j("type" to "text")
            val author = if (group != null) "5511970002222" else c.str("phone").orEmpty()
            val message = addMessage(id, "customer", author, text, at, content = content, id = nextId("m-$id-c"))
            // A mensagem do cliente reabre a janela: o que estava na fila sai agora.
            list.filter { it.str("delivery_status") == "pending" }.forEach { advance(id, it, "pending", "delivered", at) }
            deliveries[id]?.removeAll { it.str("status") == "pending" }
            c.assign("last_customer", at)
            c.assign("updated", at)
            emit("message.received", message.str("id"), j("conversation_id" to id, "message_id" to message.str("id"), "text" to text, "attachments" to emptyList<String>()), at)
            // O cliente respondeu: protocolo que estava "Aguardando cliente" volta sozinho para "Em análise" (§2).
            tickets.values.filter { it.str("conversation_id") == id && it.str("status") == "waiting_customer" }.forEach { ticket ->
                ticket.assign("status", "in_progress")
                ticket.assign("updated", at)
                emit("ticket.updated", ticket.str("id"), j("ticket_id" to ticket.str("id"), "conversation_id" to id), at)
            }
        }
    }

    /** Textos da coluna "Para o cliente" (consulta de protocolos). */
    private fun statusLabel(status: String?): String = when (status) {
        "open" -> "Recebido"
        "in_progress" -> "Em análise"
        "waiting_customer" -> "Aguardando você"
        "waiting_third" -> "Aguardando atualização"
        "resolved" -> "Resolvido"
        "closed" -> "Encerrado"
        else -> status.orEmpty()
    }

    private fun action(s: DemoState, c: Row, body: JsonObject, now: Long): Reply = with(s) {
        val id = c.str("id").orEmpty()
        val me = Ids.ME
        val owner = c.str("owner")
        val mine = owner == me && c.str("state") == "human"
        when (val action = body.str("action")) {
            "claim" -> {
                if (mine) return ok(c.json())
                if (owner != null && owner != me) return Reply.error(409, "already_claimed", "Outro atendente assumiu a conversa.")
                c.assign("state", "human")
                c.assign("owner", me)
                c.assign("assigned_bot_id", null)
                tickets.values.filter { it.str("conversation_id") == id && it.str("owner") == null && isActive(it) }.forEach { it.assign("owner", me) }
                system(id, "Conversa assumida por ${userName(me)}", now)
                touch(c, now)
                ok(c.json())
            }
            "reply" -> {
                if (!mine) return Reply.error(409, "not_owner", "Assuma a conversa antes de responder.")
                val text = body.str("text").orEmpty()
                val attachments = (body["attachments"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                val content = body["content"] as? JsonObject ?: j("type" to "text")
                val hasBody = content.containsKey("location") || content.containsKey("contacts")
                if (text.isBlank() && attachments.isEmpty() && !hasBody) return invalid("Escreva uma mensagem ou escolha um conteúdo.")
                val enriched = content.str("reply_to")?.let { quotedId ->
                    val quoted = messages[id]?.firstOrNull { it.str("id") == quotedId }?.str("text")
                    if (quoted.isNullOrBlank() || content.containsKey("reply_text")) content else JsonObject(content + ("reply_text" to JsonPrimitive(quoted)))
                } ?: content
                val message = outbound(c, text, now, enriched, attachments)
                tickets.values.filter { it.str("conversation_id") == id && isActive(it) && it.longOrNull("first_response_at") == null }.forEach {
                    it.assign("first_response_at", now)
                    it.assign("updated", now)
                }
                scheduleCustomerReply(c, now)
                ok(j("delivery_id" to "d-${message.str("id")}", "status" to if (message.str("delivery_status") == "pending") "pending" else "queued", "id" to message.str("id")))
            }
            "note" -> {
                val text = body.str("text")?.trim().orEmpty()
                if (text.isEmpty()) return invalid("Escreva o texto da nota interna.")
                val message = addMessage(id, "note", me, text, now, id = nextId("m-$id-n"))
                c.assign("updated", now)
                emit("message.updated", message.str("id"), j("conversation_id" to id, "message_id" to message.str("id")), now)
                ok(j("id" to message.str("id")))
            }
            "transfer" -> {
                val target = body.str("target")?.takeIf { it.isNotBlank() }
                val department = body.str("department_id")?.takeIf { it.isNotBlank() }
                val from = userName(owner ?: me)
                when {
                    target != null && target.startsWith("bot:") -> {
                        val name = botName(target) ?: return invalid("Bot não encontrado.")
                        c.assign("state", "ai")
                        c.assign("owner", null)
                        c.assign("assigned_bot_id", target.removePrefix("bot:"))
                        system(id, "Transferida para o bot $name", now)
                    }
                    target != null -> {
                        if (target !in users) return invalid("Escolha uma pessoa desta área de atendimento.")
                        c.assign("state", "human")
                        c.assign("owner", target)
                        c.assign("assigned_bot_id", null)
                        system(id, "Transferida de $from para ${userName(target)}", now)
                    }
                    department != null -> {
                        val name = departments.firstOrNull { it.str("id") == department }?.str("name") ?: return invalid("Setor não encontrado.")
                        c.assign("state", "waiting")
                        c.assign("owner", null)
                        c.assign("assigned_bot_id", null)
                        c.assign("department_id", department)
                        system(id, "Encaminhada para o setor $name", now)
                    }
                    else -> return invalid("Escolha para quem transferir.")
                }
                touch(c, now)
                ok(c.json())
            }
            "resume" -> {
                c.assign("state", "ai")
                c.assign("owner", null)
                c.assign("assigned_bot_id", null)
                system(id, "Conversa devolvida ao atendimento automático", now)
                touch(c, now)
                ok(c.json())
            }
            "resolve" -> {
                c.assign("state", "closed")
                c.assign("owner", null)
                c.assign("assigned_bot_id", null)
                pendingCustomerReply.remove(id)
                system(id, "Conversa concluída por ${userName(me)}", now)
                touch(c, now)
                ok(c.json())
            }
            "tags" -> {
                val tags = (body["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.take(40) }?.filter { it.isNotEmpty() }.orEmpty()
                if (tags.size > 20) return invalid("Etiquetas inválidas.")
                c.assign("tags", JsonArray(tags.map { JsonPrimitive(it) }).toString())
                touch(c, now)
                ok(c.json())
            }
            "menu" -> {
                val menuId = body.str("menu_id")
                val parent = menuId?.let { wanted -> menus.firstOrNull { it.str("id") == wanted } ?: return invalid("Menu não encontrado.") }
                val options = menus.filter { it.str("parent_id") == menuId && it.bool("enabled") != false }
                val title = parent?.str("label") ?: "Menu principal"
                val text = buildString {
                    append("*").append(title).append("*\nEscolha uma opção:\n")
                    options.forEachIndexed { index, option -> append(index + 1).append(". ").append(option.str("label")).append('\n') }
                }.trim()
                system(id, if (parent == null) "Menu enviado ao cliente" else "Menu \"$title\" enviado ao cliente", now)
                val message = outbound(c, text, now + 1, j("type" to "text", "automation" to "menu"))
                ok(j("delivery_id" to "d-${message.str("id")}", "status" to "queued"))
            }
            "protocols" -> {
                val number = body.str("number")?.trim()?.takeIf { it.isNotEmpty() }
                val mineTickets = tickets.values.filter { it.str("conversation_id") == id && (number == null || it.str("number").equals(number, ignoreCase = true)) }
                val text = when {
                    mineTickets.isEmpty() && number != null -> "Não encontramos o protocolo $number neste número."
                    mineTickets.isEmpty() -> "Você não tem protocolos abertos conosco no momento."
                    else -> buildString {
                        append(if (mineTickets.size == 1) "Encontramos 1 protocolo seu:\n" else "Encontramos ${mineTickets.size} protocolos seus:\n")
                        mineTickets.forEach { append("• ").append(it.str("number")).append(" · ").append(it.str("title")).append(" (").append(statusLabel(it.str("status"))).append(")\n") }
                    }.trim()
                }
                system(id, "Consulta de protocolos enviada ao cliente", now)
                val message = outbound(c, text, now + 1, j("type" to "text", "automation" to "protocols"))
                ok(j("delivery_id" to "d-${message.str("id")}", "status" to "queued"))
            }
            "survey" -> {
                system(id, "Pesquisa de satisfação enviada", now)
                val message = outbound(c, "Como você avalia o nosso atendimento? Responda com uma nota de 1 a 5.", now + 1, j("type" to "text", "automation" to "survey"))
                ok(j("delivery_id" to "d-${message.str("id")}", "status" to "queued"))
            }
            else -> invalid("Ação desconhecida: ${action ?: "(vazia)"}.")
        }
    }

    private fun messageAction(s: DemoState, c: Row, body: JsonObject, now: Long): Reply = with(s) {
        val id = c.str("id").orEmpty()
        val message = messages[id]?.firstOrNull { it.str("id") == body.str("message_id") } ?: return notFound("Mensagem não encontrada.")
        val content = runCatching { Json.parseToJsonElement(message.str("content") ?: "{}") as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        val updated: JsonObject = when (body.str("action")) {
            "reaction" -> {
                val emoji = body.str("emoji").orEmpty()
                val reactions = (content["reactions"] as? JsonObject)?.toMutableMap() ?: LinkedHashMap()
                if (emoji.isEmpty()) reactions.remove(Ids.ME) else reactions[Ids.ME] = j("emoji" to emoji, "at" to now)
                val next = content.toMutableMap()
                if (reactions.isEmpty()) next.remove("reactions") else next["reactions"] = JsonObject(reactions)
                JsonObject(next)
            }
            "edit" -> {
                val text = body.str("text")?.trim().orEmpty()
                if (text.isEmpty()) return invalid("Escreva o novo texto da mensagem.")
                message.assign("text", text)
                JsonObject(content + ("edited" to JsonPrimitive(true)))
            }
            "delete" -> JsonObject(content + ("deleted" to JsonPrimitive(true)))
            "read" -> JsonObject(content + ("read_at" to JsonPrimitive(now)))
            else -> return invalid("Ação de mensagem desconhecida.")
        }
        message.assign("content", updated.toString())
        emit("message.updated", message.str("id"), j("conversation_id" to id, "message_id" to message.str("id")), now)
        ok(j("delivery_id" to nextId("d-action"), "status" to "queued"))
    }

    // -----------------------------------------------------------------------------------------------------------
    // Mídia
    // -----------------------------------------------------------------------------------------------------------

    private fun media(s: DemoState, method: String, r: List<String>, request: Request): Reply {
        if (r.firstOrNull() == "uploads") {
            if (r.size == 1) {
                val body = bodyJson(request)
                val size = body.long("size")
                val partSize = 5L * 1024 * 1024
                val id = s.nextId("up")
                s.uploads[id] = Upload(body.str("name") ?: "arquivo", body.str("type") ?: "application/octet-stream", size)
                return ok(j("id" to id, "part_size" to partSize, "parts" to maxOf(1L, (size + partSize - 1) / partSize)), 201)
            }
            val upload = s.uploads[r[1]] ?: return notFound("Envio não encontrado.")
            return when (r.getOrNull(2)) {
                "parts" -> {
                    upload.parts[r.getOrNull(3)?.toIntOrNull() ?: 1] = bodyBytes(request)
                    Reply(200, j("ok" to true).toString().toByteArray(), delayMs = 60)
                }
                "complete" -> {
                    val bytes = upload.parts.values.fold(ByteArray(0)) { acc, part -> acc + part }
                    s.media[r[1]] = DemoMedia.Entry(r[1], upload.name, upload.type) { bytes }
                    s.uploads.remove(r[1])
                    ok(j("id" to r[1], "name" to upload.name, "size" to bytes.size, "status" to "ready"))
                }
                "abort" -> {
                    s.uploads.remove(r[1])
                    ok(j("id" to r[1], "status" to "aborted"))
                }
                else -> notFound()
            }
        }
        if (r.size == 2 && r[1] == "content" && (method == "GET" || method == "HEAD")) {
            val entry = s.media[r[0]] ?: return notFound("Arquivo não encontrado.")
            val inline = request.url.queryParameter("inline") == "1"
            val ascii = entry.name.map { if (it.code in 32..126 && it != '"' && it != '\\') it else '_' }.joinToString("")
            val encoded = URLEncoder.encode(entry.name, "UTF-8").replace("+", "%20")
            val headers = arrayListOf(
                "Content-Disposition" to "${if (inline) "inline" else "attachment"}; filename=\"$ascii\"; filename*=UTF-8''$encoded",
                "Accept-Ranges" to "bytes",
            )
            val total = entry.bytes.size
            val range = request.header("Range")?.trim()?.takeIf { it.startsWith("bytes=") }?.removePrefix("bytes=")
            if (range != null && total > 0) {
                val start = range.substringBefore('-').toIntOrNull() ?: 0
                val end = (range.substringAfter('-', "").toIntOrNull() ?: (total - 1)).coerceAtMost(total - 1)
                if (start in 0..end) {
                    headers += "Content-Range" to "bytes $start-$end/$total"
                    return Reply(206, entry.bytes.copyOfRange(start, end + 1), entry.type, headers, delayMs = 20)
                }
            }
            return Reply(200, entry.bytes, entry.type, headers, delayMs = 30)
        }
        return notFound()
    }

    // -----------------------------------------------------------------------------------------------------------
    // Protocolos
    // -----------------------------------------------------------------------------------------------------------

    private fun tickets(s: DemoState, method: String, r: List<String>, request: Request, now: Long): Reply = with(s) {
        if (r.isEmpty()) {
            if (method == "POST") {
                val body = bodyJson(request)
                val conversationId = body.str("conversation_id").orEmpty()
                val c = conversations[conversationId] ?: return invalid("Conversa não encontrada.")
                val title = body.str("title")?.trim().orEmpty()
                if (title.isEmpty() || title.length > 300) return invalid("Informe o título do protocolo (até 300 caracteres).")
                val category = body.str("category")?.takeIf { it.isNotBlank() }
                if (category != null && ticketCategories.none { it.str("id") == category && it.bool("enabled") != false }) {
                    return Reply.error(400, "invalid", "Categoria de protocolo desconhecida.")
                }
                val id = nextId("t-novo")
                val number = "WA-2026-" + (++ticketSeq).toString().padStart(6, '0')
                val ticket = row(
                    "id" to id, "number" to number, "profile_id" to Ids.PROFILE, "conversation_id" to conversationId, "title" to title,
                    "status" to "open", "owner" to (c.str("owner") ?: Ids.ME), "response_due_at" to now + 4 * 3_600_000L, "first_response_at" to null,
                    "created" to now, "updated" to now, "category" to category,
                )
                tickets[id] = ticket
                ticketUpdates[id] = arrayListOf(row("id" to "tu-$id-1", "ticket_id" to id, "actor" to "system", "text" to "Protocolo aberto por ${userName(Ids.ME)}.", "internal" to 0, "created" to now))
                system(conversationId, "Protocolo $number aberto", now)
                c.assign("updated", now)
                emit("ticket.created", id, j("ticket_id" to id, "conversation_id" to conversationId, "number" to number), now)
                emit("conversation.updated", conversationId, j("conversation_id" to conversationId), now)
                return ok(ticket.json(), 201)
            }
            val url = request.url
            val status = url.queryParameter("status")?.takeIf { it.isNotBlank() }
            if (status != null && status !in ticketStatuses) return Reply.error(400, "invalid", "Estado de protocolo inválido.")
            val overdue = url.queryParameter("overdue") == "1"
            val active = url.queryParameter("active") == "1"
            val category = url.queryParameter("category")?.takeIf { it.isNotBlank() }
            val query = url.queryParameter("q")?.trim()?.takeIf { it.isNotEmpty() }
            val digits = query?.filter { it.isDigit() }.orEmpty()
            val list = tickets.values
                .filter { status == null || it.str("status") == status }
                .filter { !active || isActive(it) }
                .filter { category == null || it.str("category") == category }
                .filter { t ->
                    if (!overdue) return@filter true
                    val due = t.longOrNull("response_due_at")
                    isActive(t) && t.longOrNull("first_response_at") == null && due != null && due < now
                }
                .filter { t ->
                    if (query == null) return@filter true
                    val phone = conversations[t.str("conversation_id")]?.str("phone").orEmpty()
                    t.str("number").orEmpty().contains(query, ignoreCase = true) ||
                        (digits.isNotEmpty() && (phone.contains(digits) || t.str("number").orEmpty().filter { it.isDigit() }.contains(digits)))
                }
                .sortedByDescending { it.long("created") }
            return ok(j("data" to list.map { it.json() }, "next_cursor" to null))
        }
        val id = r[0]
        val ticket = tickets[id] ?: return notFound("Protocolo não encontrado.")
        if (method == "PATCH") {
            val body = bodyJson(request)
            val conversationId = ticket.str("conversation_id").orEmpty()
            body.str("text")?.trim()?.takeIf { it.isNotEmpty() }?.let { text ->
                val list = ticketUpdates.getOrPut(id) { ArrayList() }
                list += row("id" to nextId("tu-$id"), "ticket_id" to id, "actor" to Ids.ME, "text" to text, "internal" to 0, "created" to now)
                if (ticket.longOrNull("first_response_at") == null) ticket.assign("first_response_at", now)
                // O andamento também vai ao cliente pela conversa.
                conversations[conversationId]?.let { c ->
                    addMessage(conversationId, "outbound", Ids.ME, "Protocolo ${ticket.str("number")}: $text", now, "sent", j("type" to "text", "automation" to "ticket"), id = nextId("m-$conversationId-t"))
                    c.assign("updated", now)
                    emit("message.sent", null, j("conversation_id" to conversationId, "text" to "Protocolo ${ticket.str("number")}: $text", "attachments" to emptyList<String>()), now)
                }
            }
            body.str("status")?.let { status ->
                if (status !in ticketStatuses) return invalid("Estado inválido.")
                ticket.assign("status", status)
            }
            if (body.containsKey("category")) {
                // `category: null` limpa; valor desconhecido (ou desabilitado) é recusado com 400.
                val category = body.str("category")?.takeIf { it.isNotBlank() }
                if (category != null && ticketCategories.none { it.str("id") == category && it.bool("enabled") != false }) {
                    return Reply.error(400, "invalid", "Categoria de protocolo desconhecida.")
                }
                ticket.assign("category", category)
            }
            body.str("owner")?.let { owner ->
                if (owner !in users) return invalid("Responsável inválido.")
                ticket.assign("owner", owner)
            }
            if (body.containsKey("response_due_at")) {
                if (ticket.longOrNull("first_response_at") != null || !isActive(ticket)) {
                    return invalid("O prazo só pode ser alterado antes da primeira resposta.")
                }
                ticket.assign("response_due_at", body.longOrNull("response_due_at"))
            }
            ticket.assign("updated", now)
            emit(if (ticket.str("status") == "closed") "ticket.closed" else "ticket.updated", id, j("ticket_id" to id, "conversation_id" to conversationId), now)
            return ok(ticket.json())
        }
        ok(
            j(
                "ticket" to ticket.json(),
                "updates" to ticketUpdates[id].orEmpty().sortedBy { it.long("created") }.map { it.json() },
                "conversation" to conversations[ticket.str("conversation_id")]?.json(),
            ),
        )
    }

    // -----------------------------------------------------------------------------------------------------------
    // Bots
    // -----------------------------------------------------------------------------------------------------------

    private val botAnswers = listOf(
        "Consultei a base e aqui vai o resumo: o cliente está com o cadastro em dia, sem pendências financeiras, e o último contato foi resolvido no mesmo dia. Posso detalhar algum ponto?",
        "Pronto! Encontrei 3 registros relacionados. O mais recente é de ontem e já está com a equipe responsável. Se quiser, preparo uma resposta para você enviar ao cliente.",
        "Segundo a política comercial atual, isso é permitido para contratos acima de 10 usuários. Abaixo disso é preciso a aprovação da gerência.",
    )

    private fun startBotRun(s: DemoState, body: JsonObject, now: Long): Reply = with(s) {
        val botId = body.str("bot_id").orEmpty()
        if (bots.none { it.str("id") == botId }) return invalid("Bot não encontrado.")
        val input = body.str("input")?.trim().orEmpty()
        if (input.isEmpty()) return invalid("Escreva a pergunta para o bot.")
        val id = nextId("run-novo")
        val run = row(
            "id" to id, "profile_id" to Ids.PROFILE, "bot_id" to botId, "actor" to Ids.ME, "conversation_id" to null, "status" to "queued",
            "input" to input, "result" to null, "error" to null, "attachments" to emptyList<String>(), "created" to now, "updated" to now,
        )
        botRuns += run
        later(now + 1_000) { at ->
            if (run.str("status") == "queued") {
                run.assign("status", "running")
                run.assign("updated", at)
            }
        }
        later(now + 3_200) { at ->
            if (run.str("status") == "running" || run.str("status") == "queued") {
                run.assign("status", "completed")
                run.assign("result", botAnswers[botRuns.size % botAnswers.size])
                run.assign("updated", at)
            }
        }
        ok(run.json(), 202)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Ligações
    // -----------------------------------------------------------------------------------------------------------

    /** Só o histórico (GET /calls), como no servidor real: iniciar, atender e encerrar não existem mais. */
    private fun calls(s: DemoState, method: String, r: List<String>, request: Request): Reply = with(s) {
        if (method != "GET" || r.isNotEmpty()) return notFound()
        val conversationId = request.url.queryParameter("conversation_id")?.takeIf { it.isNotBlank() }
        val limit = request.url.queryParameter("limit")?.toIntOrNull()?.coerceIn(1, 100) ?: 30
        val list = calls.filter { conversationId == null || it.str("conversation_id") == conversationId }.sortedByDescending { it.long("created") }.take(limit)
        ok(j("data" to list.map { it.json() }, "next_cursor" to null))
    }

    // -----------------------------------------------------------------------------------------------------------
    // Conversas internas
    // -----------------------------------------------------------------------------------------------------------

    private val peerReplies = listOf(
        "Combinado! 👍",
        "Pode deixar comigo, já estou vendo isso.",
        "Boa! Me avisa se precisar de ajuda com o cliente.",
        "Recebido. Te dou um retorno em alguns minutos.",
    )

    private fun chatJson(s: DemoState, chat: Row, withMessages: Boolean): JsonObject {
        val peerId = if (chat.str("member_a") == Ids.ME) chat.str("member_b").orEmpty() else chat.str("member_a").orEmpty()
        val base = chat + ("peer" to teamEntry(s, peerId))
        return if (withMessages) JsonObject(base + ("messages" to JsonArray(s.chatMessages[chat.str("id")].orEmpty().map { it.json() }))) else JsonObject(base)
    }

    private fun internalChats(s: DemoState, method: String, r: List<String>, request: Request, now: Long): Reply = with(s) {
        if (r.isEmpty()) {
            if (method == "POST") {
                val peerId = bodyJson(request).str("peer_id").orEmpty()
                if (peerId == Ids.ME || team(s).none { it.str("id") == peerId }) return invalid("Escolha outra pessoa ou bot desta área de atendimento.")
                val members = listOf(Ids.ME, peerId).sorted()
                val existing = chats.values.firstOrNull { it.str("member_a") == members[0] && it.str("member_b") == members[1] }
                val chat = existing ?: row("id" to nextId("ic-novo"), "profile_id" to Ids.PROFILE, "member_a" to members[0], "member_b" to members[1], "created" to now, "updated" to now).also {
                    chats[it.str("id").orEmpty()] = it
                    chatMessages[it.str("id").orEmpty()] = ArrayList()
                }
                return ok(chatJson(s, chat, withMessages = true), if (existing == null) 201 else 200)
            }
            return ok(j("data" to chats.values.sortedByDescending { it.long("updated") }.map { chatJson(s, it, withMessages = false) }))
        }
        val chat = chats[r[0]] ?: return notFound("Conversa interna não encontrada.")
        val chatId = chat.str("id").orEmpty()
        if (r.getOrNull(1) == "messages" && method == "POST") {
            val text = bodyJson(request).str("text")?.trim().orEmpty()
            if (text.isEmpty()) return invalid("Escreva a mensagem.")
            val message = addChatMessage(chatId, Ids.ME, text, now)
            val peerId = if (chat.str("member_a") == Ids.ME) chat.str("member_b").orEmpty() else chat.str("member_a").orEmpty()
            if (peerId.startsWith("bot:")) {
                val runId = nextId("run-interno")
                val reply = addChatMessage(chatId, peerId, "", now + 300, status = "running", runId = runId)
                later(now + 3_000) { at ->
                    reply.assign("text", botAnswers[chatMessages[chatId].orEmpty().size % botAnswers.size])
                    reply.assign("status", "completed")
                    chat.assign("updated", at)
                }
            } else {
                later(now + 4_000) { at ->
                    addChatMessage(chatId, peerId, peerReplies[chatMessages[chatId].orEmpty().size % peerReplies.size], at)
                }
            }
            return ok(j("id" to message.str("id"), "status" to "sent"), 201)
        }
        ok(chatJson(s, chat, withMessages = true))
    }
}
