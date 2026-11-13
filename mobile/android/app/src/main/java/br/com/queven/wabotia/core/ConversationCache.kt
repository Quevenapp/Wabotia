package br.com.queven.wabotia.core

import android.content.Context
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import br.com.queven.wabotia.core.media.MediaKinds
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.Event
import br.com.queven.wabotia.core.model.LastMessage
import br.com.queven.wabotia.core.model.Message
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.model.array
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.obj
import br.com.queven.wabotia.core.model.string
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Prévia da última mensagem de uma conversa. [kind]: text | image | video | audio | voice | document | sticker |
 * location | contacts | attachment | deleted. [status] é o `delivery_status` quando a mensagem saiu de nós.
 */
@Serializable
data class MessagePreview(
    val text: String = "",
    val kind: String = "text",
    val outgoing: Boolean = false,
    val note: Boolean = false,
    val at: Long = 0,
    val status: String = "",
    val messageId: String = "",
)

/** `last_message` do servidor (0.14+) no formato da prévia da lista. */
fun LastMessage.toPreview(): MessagePreview = MessagePreview(
    text = text,
    kind = when {
        kind == "text" && attachments > 0 -> "attachment"
        else -> kind
    },
    outgoing = !isIncoming && !isSystem,
    note = isNote,
    at = created,
    status = if (isIncoming || isNote || isSystem) "" else deliveryStatus,
)

/**
 * Prévia mostrada na linha da conversa: `last_message` do servidor quando vier (0.14+); o cache local fica como reserva
 * para servidores antigos e só passa na frente quando é mais novo (evento que chegou antes da recarga da lista). Para a
 * mesma mensagem, o cache mantém o que só o detalhe sabe (áudio de voz, mensagem apagada).
 */
fun listPreview(conversation: Conversation, cached: MessagePreview?): MessagePreview? {
    val server = conversation.lastMessage?.toPreview() ?: return cached
    if (cached == null) return server
    return when {
        cached.at > server.at -> cached
        cached.at == server.at && cached.kind in setOf("voice", "deleted") -> server.copy(kind = cached.kind, messageId = cached.messageId)
        else -> server
    }
}

/**
 * Servidores até a 0.13 não mandam prévia na lista (a 0.14 manda `last_message`), e nenhum manda não lidas. Este cache local (por perfil) guarda
 * `conversa → prévia` e `conversa → não lidas`, alimentado por eventos `message.received` / `message.sent`,
 * pelo detalhe de cada conversa aberta e pelo preenchimento em segundo plano da lista. Abrir a conversa zera as não lidas.
 */
class ConversationCache(private val container: AppContainer) {
    val previews: SnapshotStateMap<String, MessagePreview> = mutableStateMapOf()
    val unread: SnapshotStateMap<String, Int> = mutableStateMapOf()

    private var loadedProfile: String? = null
    private val prefs get() = container.appContext.getSharedPreferences("wabotia.cache", Context.MODE_PRIVATE)
    private val previewsSerializer = MapSerializer(String.serializer(), MessagePreview.serializer())
    private val unreadSerializer = MapSerializer(String.serializer(), Int.serializer())

    val totalUnread: Int get() = unread.values.sum()

    /** Carrega do disco o cache do perfil (uma vez por troca de perfil). */
    @Synchronized
    fun use(profileId: String?) {
        if (profileId == loadedProfile) return
        loadedProfile = profileId
        previews.clear()
        unread.clear()
        if (profileId == null) return
        runCatching { WabotiaJson.decodeFromString(previewsSerializer, prefs.getString("previews.$profileId", "{}") ?: "{}") }.getOrNull()?.let { previews.putAll(it) }
        runCatching { WabotiaJson.decodeFromString(unreadSerializer, prefs.getString("unread.$profileId", "{}") ?: "{}") }.getOrNull()?.let { unread.putAll(it) }
    }

    @Synchronized
    private fun persist() {
        val profile = loadedProfile ?: return
        // Mantém só as prévias mais recentes para o arquivo não crescer sem limite.
        val keep = previews.entries.sortedByDescending { it.value.at }.take(MAX_ENTRIES).associate { it.key to it.value }
        prefs.edit()
            .putString("previews.$profile", WabotiaJson.encodeToString(previewsSerializer, keep))
            .putString("unread.$profile", WabotiaJson.encodeToString(unreadSerializer, unread.filterValues { it > 0 }))
            .apply()
    }

    fun markRead(conversationId: String) {
        if ((unread[conversationId] ?: 0) == 0) return
        unread.remove(conversationId)
        persist()
    }

    /** Atualiza a prévia a partir do detalhe carregado (conversa aberta ou preenchimento em segundo plano). */
    fun onDetail(detail: ConversationDetail) {
        val id = detail.conversation.id
        val last = detail.messages.lastOrNull { it.direction != "system" } ?: return
        val preview = previewOf(last, detail)
        if (previews[id] != preview) {
            previews[id] = preview
            persist()
        }
    }

    /** Eventos do perfil em primeiro plano; [visibleConversationId] é a conversa aberta na tela (não soma não lida). */
    fun onEvents(events: List<Event>, visibleConversationId: String?) {
        var changed = false
        for (event in events) {
            if (event.kind != "message.received" && event.kind != "message.sent") continue
            val payload = event.payload as? JsonObject ?: continue
            val conversationId = payload.string("conversation_id") ?: continue
            val incoming = event.kind == "message.received"
            val attachments = (payload["attachments"] as? JsonArray)?.size ?: 0
            val text = payload.string("text").orEmpty()
            previews[conversationId] = MessagePreview(
                text = text,
                kind = if (attachments > 0) "attachment" else "text",
                outgoing = !incoming,
                at = if (event.created > 0) event.created else System.currentTimeMillis(),
                status = if (incoming) "" else "sent",
                messageId = payload.string("message_id").orEmpty(),
            )
            if (incoming && conversationId != visibleConversationId) {
                unread[conversationId] = (unread[conversationId] ?: 0) + 1
            }
            changed = true
        }
        if (changed) persist()
    }

    fun clear() {
        previews.clear()
        unread.clear()
        loadedProfile = null
    }

    companion object {
        private const val MAX_ENTRIES = 400

        fun previewOf(message: Message, detail: ConversationDetail?): MessagePreview {
            val content = message.contentJson
            val attachmentId = message.attachmentIds.firstOrNull()
            val mime = attachmentId?.let { id -> detail?.media?.firstOrNull { it.id == id }?.type }
            val type = content.string("type")
            val kind = when {
                content.bool("deleted") == true -> "deleted"
                type == "voice" -> "voice"
                attachmentId != null && type == "document" -> "document"
                attachmentId != null && mime != null -> MediaKinds.kindOf(mime)
                attachmentId != null -> "attachment"
                content.obj("location") != null -> "location"
                (content.array("contacts")?.size ?: 0) > 0 -> "contacts"
                else -> "text"
            }
            return MessagePreview(
                text = message.text,
                kind = kind,
                outgoing = !message.isIncoming,
                note = message.isNote,
                at = message.created,
                status = if (message.isIncoming || message.isNote) "" else message.delivery_status,
                messageId = message.id,
            )
        }
    }
}
