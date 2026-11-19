package br.com.queven.wabotia.demo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.Request
import okio.Buffer

/** Área fictícia independente, aberta somente por ?canais=2 no servidor local de demonstração.
 * Formato do plano; a conferir com a conta real. Não há transporte nem credenciais aqui. */
internal class ChannelsSecondWave(private val startedAt: Long) {
    companion object {
        const val PROFILE = "demo-channels-second-wave"
        const val COMMENT = "c2-comment"
        const val EMAIL = "c2-email"
        const val TIKTOK = "c2-tiktok-nine"
        const val TELEGRAM = "c2-telegram"
        private const val HOUR = 3_600_000L
    }

    private val conversations = linkedMapOf<String, JsonObject>()
    private val messages = hashMapOf<String, MutableList<JsonObject>>()
    private val metadata = hashMapOf<String, JsonObject>()
    private val replays = DemoReplays()
    private val slots = hashMapOf(TIKTOK to 1, "c2-tiktok-full" to 0, "c2-tiktok-expired" to 10)
    private var sequence = 0

    val profile: JsonObject get() = j("id" to PROFILE, "name" to "Canais 2 · Empresa Exemplo", "enabled" to 1,
        "settings" to j(), "created" to startedAt)

    init {
        fun direct(id: String, channel: String, title: String, age: Long = HOUR) {
            conversations[id] = j("id" to id, "profile_id" to PROFILE, "connection_id" to "c2-$channel",
                "channel" to channel, "account_label" to "Conta de demonstração", "multichannel" to true,
                "external_namespace" to "channel:c2-$channel", "external_id" to "synthetic-$id", "phone" to null,
                "contact_name" to title, "state" to "human", "owner" to Ids.ME, "chat_type" to "direct",
                "last_customer" to startedAt - age, "created" to startedAt - age, "updated" to startedAt)
        }
        fun comment(id: String, name: String, post: String, state: String = "available", hidden: Boolean = false, expired: Boolean = false) {
            direct(id, if (id == "c2-comment-failed") "facebook" else "instagram", name)
            conversations[id] = JsonObject(conversations.getValue(id) + j("chat_type" to "comment",
                "channel_context" to j("version" to 1, "context" to "comment").toString()))
            val item = j("id" to "comment-$id", "postId" to post, "text" to "Gostaria de saber mais.",
                "postText" to "Novidades da loja", "permalink" to "https://example.test/publicacao/$post", "hidden" to hidden,
                "version" to 1, "privateState" to state, "privateExpiresAt" to if (expired) startedAt - HOUR else startedAt + 167 * HOUR,
                "privateLinkPending" to (state == "sent"))
            metadata[id] = j("comment" to item)
            receive(id, "event-$id", "Gostaria de saber mais.", j("type" to "text", "comment" to item))
        }
        comment(COMMENT, "Lia Exemplo", "post-1")
        comment("c2-comment-other-person", "Pedro Exemplo", "post-1")
        comment("c2-comment-other-post", "Lia Exemplo", "post-2")
        comment("c2-comment-hidden", "Comentário oculto", "post-3", hidden = true)
        comment("c2-comment-sent", "Privado enviado; vínculo pendente", "post-4", state = "sent")
        comment("c2-comment-failed", "Tentativa privada consumida", "post-5", state = "failed")
        comment("c2-comment-expired", "Prazo privado expirado", "post-6", expired = true)

        direct(TELEGRAM, "telegram", "Telegram · Júlia Exemplo")
        metadata[TELEGRAM] = j("telegram" to j("username" to "loja_exemplo_bot", "botUrl" to "https://t.me/loja_exemplo_bot",
            "blocked" to false, "webhookConfigured" to true, "phoneSuggestion" to j("masked" to "+55 •• •••••-1234", "confirmedByHuman" to false)))
        receive(TELEGRAM, "telegram-event", "Olá! Meu telefone aguarda conferência humana.")
        receive(TELEGRAM, "telegram-expired", "O botão venceu. Solicite um novo menu.")
        receive(TELEGRAM, "telegram-third-party", "Telefone de terceiro recebido; não comprova identidade.")
        receive(TELEGRAM, "telegram-large", "Anexo recusado: arquivo maior que o limite permitido.")
        direct("c2-telegram-blocked", "telegram", "Bot bloqueado")
        metadata["c2-telegram-blocked"] = j("telegram" to j("blocked" to true, "webhookConfigured" to true))
        receive("c2-telegram-blocked", "blocked-event", "O cliente bloqueou este bot.")
        direct("c2-telegram-limited", "telegram", "Telegram · intervalo de envio")
        metadata["c2-telegram-limited"] = j("state" to "rate_limited", "telegram" to j("blocked" to false, "webhookConfigured" to true))

        direct(EMAIL, "email", "E-mail · remetente não confirmado")
        metadata[EMAIL] = j("subject" to "Pedido 123 — revisão", "identityTrust" to "unverified_sender",
            "email" to j("subject" to "Pedido 123 — revisão", "sender" to "cliente@loja.example",
                "from" to "outra-pessoa@loja.example", "replyTo" to "retorno@loja.example", "identityTrust" to "unverified_sender",
                "authentication" to listOf(j("method" to "dmarc", "result" to "pass")),
                "attachmentWarnings" to listOf("Arquivo executável recusado; texto preservado.")))
        receive(EMAIL, "email-first", "Olá! Preciso de atenção ao pedido.", j("type" to "text", "subject" to "Pedido 123"))
        receive(EMAIL, "email-html", "Conteúdo convertido para texto. Nada remoto foi carregado.", j("type" to "text", "subject" to "Pedido 123 — revisão"))

        direct(TIKTOK, "tiktok", "TikTok · nove usadas")
        direct("c2-tiktok-full", "tiktok", "TikTok · dez usadas")
        direct("c2-tiktok-expired", "tiktok", "TikTok · 48 horas encerradas", 48 * HOUR)
        for (id in slots.keys) receive(id, "event-$id", "Tenho uma dúvida sobre a loja.")
        // As nove vagas usadas já incluem saída externa e eco local, contados uma única vez.
        for ((event, text) in listOf("tiktok-external" to "Resposta feita no aplicativo TikTok.",
            "tiktok-local-echo" to "Envio local confirmado pelo eco.")) {
            messages.getValue(TIKTOK) += j("id" to event, "conversation_id" to TIKTOK, "profile_id" to PROFILE,
                "direction" to "outbound", "author" to Ids.ME, "text" to text, "created" to startedAt - HOUR,
                "content" to j("type" to "text", "source" to if (event == "tiktok-external") "external" else "local").toString())
        }
    }

    /** Repetir o mesmo evento não acrescenta balão, inclusive após um eco da saída. */
    fun receive(id: String, event: String, text: String, content: JsonObject = j("type" to "text")): Boolean {
        val list = messages.getOrPut(id) { arrayListOf() }
        if (list.any { it.str("id") == event }) return false
        list += j("id" to event, "conversation_id" to id, "profile_id" to PROFILE, "direction" to "customer",
            "author" to "Pessoa de demonstração", "text" to text, "created" to startedAt - HOUR, "content" to content.toString())
        return true
    }

    private fun projection(id: String, now: Long): JsonObject {
        val conversation = conversations.getValue(id)
        val channel = conversation.str("channel")!!
        val context = if (conversation.str("chat_type") == "comment") "comment" else "direct"
        val blocked = id == "c2-telegram-blocked"
        val limited = id == "c2-telegram-limited"
        val deadline = if (channel == "tiktok") conversation.long("last_customer") + 48 * HOUR else null
        val remaining = slots[id]
        val open = !blocked && !limited && (deadline == null || now < deadline) && (remaining == null || remaining > 0)
        val spec = j("id" to channel, "enabled" to true, "context" to context,
            "contexts" to j(context to j("enabled" to true, "bot" to (channel == "telegram" || channel == "tiktok"), "publicReply" to (context == "comment"))),
            "text" to j("enabled" to true, "maxChars" to when (channel) { "email" -> 50000; "tiktok" -> 6000; else -> 4096 }),
            "media" to j("image" to j("send" to (context != "comment"), "receive" to true,
            "maxSendBytes" to if (channel == "tiktok") 3_000_000 else 10_000_000, "mimeTypes" to listOf("image/jpeg", "image/png"))),
            "menu" to j("buttons" to if (channel == "telegram") 3 else 0, "quickReplies" to 0, "listItems" to 0, "fallback" to "numbered_text"),
            "window" to if (channel == "tiktok") j("kind" to "customer", "hours" to 48, "maxMessages" to 10, "after" to "blocked") else j("kind" to "none"),
            "subject" to (channel == "email"), "replyTo" to false, "templates" to false)
        val meta = if (channel == "tiktok") j("remainingMessages" to remaining, "closesAt" to deadline,
            "tiktok" to j("remainingMessages" to remaining, "closesAt" to deadline, "conservativeQuota" to true)) else metadata[id] ?: j()
        return j("channel" to channel, "account_label" to "Conta de demonstração", "multichannel" to true,
            "capabilities" to j("text" to true, "image" to (context != "comment"), "modules" to false, "subject" to (channel == "email"), "public_reply" to (context == "comment")),
            "channel_extension" to j("key" to "$channel/$context", "capabilities" to spec, "metadata" to meta),
            "window" to j("kind" to if (channel == "tiktok") "customer" else "none", "state" to if (open) "open" else "closed",
                "serverNow" to now, "closesAt" to deadline, "remainingMessages" to remaining,
                "canHumanText" to open, "canAutomation" to (open && context != "comment" && channel != "email"),
                "reason" to when { limited -> "rate_limited"; blocked -> "channel_not_ready"; remaining == 0 -> "quota_exhausted"; !open -> "window_closed"; else -> null }))
    }

    fun detail(id: String, now: Long): JsonObject? = conversations[id]?.let { conversation ->
        val view = projection(id, now)
        JsonObject(view + j("conversation" to JsonObject(conversation + view.filterKeys { it != "capabilities" }),
            "messages" to messages[id].orEmpty(), "media" to emptyList<JsonObject>(), "deliveries" to emptyList<JsonObject>()))
    }

    fun handle(request: Request, now: Long): Reply? {
        val path = request.url.pathSegments.filter { it.isNotEmpty() }
        if (path.take(4) != listOf("api", "v1", "profiles", PROFILE)) return null
        val parts = path.drop(4)
        if (parts == listOf("status")) return Reply.json(j("enabled" to 1, "multichannel" to true,
            "connected_channels" to listOf("instagram", "facebook", "telegram", "email", "tiktok"),
            "conversation_channels" to listOf("instagram", "facebook", "telegram", "email", "tiktok"),
            "channel_extensions" to listOf("instagram/comment", "facebook/comment", "telegram/direct", "email/direct", "tiktok/direct"),
            "connections" to emptyList<JsonObject>(), "settings" to j()))
        if (parts == listOf("events")) return Reply.json(j("events" to emptyList<JsonObject>(), "cursor" to now))
        if (parts == listOf("presence")) return Reply.json(JsonArray(emptyList()))
        if (parts == listOf("team")) return Reply.json(j("data" to listOf(j("id" to Ids.ME, "kind" to "user", "name" to "Diego Exemplo", "online" to true))))
        if (parts.firstOrNull() in setOf("bots", "menus", "lines", "tickets", "departments")) return Reply.json(j("data" to emptyList<JsonObject>()))
        if (parts == listOf("conversations")) {
            val channel = request.url.queryParameter("channel")
            val query = request.url.queryParameter("q").orEmpty()
            val state = request.url.queryParameter("state")
            val cursor = request.url.queryParameter("cursor")?.toIntOrNull()?.coerceAtLeast(0) ?: 0
            val limit = request.url.queryParameter("limit")?.toIntOrNull()?.coerceIn(1, 200) ?: 50
            val rows = conversations.values.filter { (channel == null || it.str("channel") == channel) &&
                (state == null || it.str("state") == state) && it.str("contact_name").orEmpty().contains(query, ignoreCase = true) }
            val page = rows.drop(cursor).take(limit).map { row -> JsonObject(row + projection(row.str("id")!!, now).filterKeys { it != "capabilities" }) }
            return Reply.json(j("data" to page, "next_cursor" to if (cursor + page.size < rows.size) (cursor + page.size).toString() else null))
        }
        val id = parts.getOrNull(1)
        if (parts.firstOrNull() != "conversations" || id == null || id !in conversations) return Reply.error(404, "not_found", "Recurso não encontrado.")
        if (parts.size == 2 && request.method == "GET") return Reply.json(detail(id, now)!!)
        if (parts.size == 3 && request.method == "POST") {
            val buffer = Buffer()
            request.body?.writeTo(buffer)
            val body = runCatching { Json.parseToJsonElement(buffer.readUtf8()) as? JsonObject }.getOrNull() ?: j()
            if (parts[2] == "actions" && body.str("action") == "reply") return Reply.error(422, "unsupported_content", "Use a ação explícita do canal.")
            if (parts[2] == "message-actions") return replays.run(request.header("Idempotency-Key"), listOf(PROFILE, id, "message-actions"), body) { send(id, body, now) }
        }
        return Reply.error(404, "not_found", "Recurso não encontrado.")
    }

    private fun send(id: String, body: JsonObject, now: Long): Reply {
        val action = body["channel_action"] as? JsonObject
        if (body.str("action") != "channel" || action == null) return Reply.error(422, "invalid_channel_action", "Escolha a ação do canal.")
        val conversation = conversations.getValue(id)
        val channel = conversation.str("channel")
        val type = action.str("type")
        val isComment = conversation.str("chat_type") == "comment"
        val text = action.str("text").orEmpty()
        val files = action["attachments"] as? JsonArray ?: JsonArray(emptyList())
        val compatible = if (isComment) type in setOf("comment.reply", "comment.private", "comment.visibility")
            else if (channel == "email") type == "email.send" else type == "message.send"
        if (!compatible) return Reply.error(422, "invalid_channel_action", "A ação não pertence ao canal.")
        var content = j("type" to "text")
        if (isComment) {
            val comment = metadata.getValue(id)["comment"] as JsonObject
            if (action.str("commentId") != comment.str("id")) return Reply.error(422, "invalid_channel_action", "Selecione o comentário alvo.")
            if (type == "comment.private") {
                if (comment.str("privateState") != "available") return Reply.error(409, "private_reply_used", "A tentativa privada já foi usada.")
                if (now >= comment.long("privateExpiresAt")) return Reply.error(409, "private_reply_expired", "O prazo privado terminou.")
                metadata[id] = j("comment" to JsonObject(comment + j("privateState" to "sent", "privateLinkPending" to true)))
            }
            if (type == "comment.visibility") {
                metadata[id] = j("comment" to JsonObject(comment + j("hidden" to (action.bool("hidden") == true))))
                return Reply.json(j("status" to "sent"))
            }
            content = j("type" to "text", "comment" to j("id" to comment.str("id"), "postId" to comment.str("postId"),
                "visibility" to if (type == "comment.private") "private" else "public"))
        } else {
            val window = projection(id, now)["window"] as JsonObject
            if (window.bool("canHumanText") != true) return Reply.error(409, window.str("reason") ?: "window_closed", "Envio indisponível neste momento.")
        }
        if (channel == "email") {
            val subject = action.str("subject") ?: return Reply.error(422, "subject_invalid", "Informe o assunto.")
            if (subject.length > 200 || subject.any { it == '\r' || it == '\n' || it == '\u0000' }) return Reply.error(422, "subject_invalid", "Assunto inválido.")
            content = j("type" to "text", "subject" to subject)
        }
        if (channel == "tiktok") {
            val needed = (if (text.isNotEmpty()) 1 else 0) + files.size
            if (needed > (slots[id] ?: 0)) return Reply.error(409, "quota_exhausted", "Não há vagas para todas as entregas.")
            slots[id] = slots.getValue(id) - needed
        }
        val messageId = "c2-outbound-${++sequence}"
        messages.getOrPut(id) { arrayListOf() } += j("id" to messageId, "conversation_id" to id, "profile_id" to PROFILE,
            "direction" to "outbound", "author" to Ids.ME, "text" to text, "created" to now,
            "content" to content.toString(), "delivery_status" to "sent")
        return Reply.json(j("delivery_id" to messageId, "status" to "sent"))
    }
}
