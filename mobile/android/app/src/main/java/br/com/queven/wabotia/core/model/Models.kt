package br.com.queven.wabotia.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Modelos da API Wabotia (docs/API.md e docs/MOBILE.md). Datas são Unix em milissegundos.
// Campos do banco que chegam como JSON em string (attachments, content, tags, profiles) são mantidos como String
// e lidos com os auxiliares de Json.kt.

@Serializable data class HealthInfo(val service: String = "", val version: String = "", val commit: String = "", val runtime: String = "")
@Serializable data class AuthStatus(val initialized: Boolean = false, val configured: Boolean = false)
@Serializable data class DeviceInfo(val platform: String = "android", val name: String, val app_version: String)
@Serializable data class MobileLoginRequest(val email: String, val password: String, val device: DeviceInfo)
@Serializable data class MobileSession(val token: String, val expires: Long, val user: User)
@Serializable data class User(
    val id: String,
    val name: String = "",
    val email: String = "",
    val role: String = "operator",
    val profiles: List<String> = emptyList(),
) { val isAdmin get() = role == "admin" }

/** Resposta de GET /api/v1/me (Actor). */
@Serializable data class Me(
    val id: String,
    val kind: String = "user",
    val name: String = "",
    val role: String = "operator",
    val profiles: List<String> = emptyList(),
)

@Serializable data class Profile(val id: String, val name: String, val enabled: Int = 0, val settings: JsonElement? = null, val created: Long = 0)
@Serializable data class Page<T>(val data: List<T> = emptyList(), val next_cursor: String? = null)
@Serializable data class ApiErrorBody(val error: ApiErrorInfo? = null)
@Serializable data class ApiErrorInfo(val code: String = "", val message: String = "", val request_id: String? = null)
@Serializable data class Ok(val ok: Boolean = true)

@Serializable data class Conversation(
    val id: String,
    val profile_id: String = "",
    val connection_id: String? = null,
    val external_namespace: String = "",
    val external_id: String = "",
    val phone: String? = null,
    val state: String = "ai", // ai | waiting | human | closed
    val owner: String? = null,
    val epoch: Long = 0,
    val topic: String? = null,
    val tags: String = "[]",
    val last_customer: Long = 0,
    val created: Long = 0,
    val updated: Long = 0,
    val chat_type: String = "direct", // direct | group
    val title: String = "",
    val bot_policy: String = "mentions",
    val recipient_id: String? = null,
    val contact_name: String? = null,
    val contact_id: String? = null,
    val department_id: String? = null,
    val assigned_bot_id: String? = null,
    /**
     * Servidor 0.14+: prévia da última mensagem (`{text, direction, created, delivery_status, attachments, kind}`) ou
     * null. Mantido como JSON cru para que um formato inesperado nunca derrube a lista; leia com [lastMessage].
     */
    val last_message: JsonElement? = null,
) {
    val displayName: String get() = contact_name?.takeIf { it.isNotBlank() } ?: title.takeIf { it.isNotBlank() } ?: phone ?: external_id
    val isGroup get() = chat_type == "group"
    fun isOwnedBy(userId: String?) = owner != null && owner == userId && state == "human"

    /** `last_message` lido com tolerância; null em servidores antigos ou quando a conversa não tem mensagens. */
    val lastMessage: LastMessage? get() = LastMessage.from(last_message)
}

/** Prévia da última mensagem que vem em cada linha de GET /conversations (docs/CENTRAL-ATENDIMENTO.md §6). */
data class LastMessage(
    val text: String,
    val direction: String, // customer | outbound | operator | note | system
    val created: Long,
    val deliveryStatus: String,
    /** Quantidade de anexos. */
    val attachments: Int,
    /** text | image | video | audio | document | location | contacts | sticker | interactive */
    val kind: String,
) {
    val isIncoming get() = direction == "customer"
    val isNote get() = direction == "note"
    val isSystem get() = direction == "system"

    companion object {
        fun from(element: JsonElement?): LastMessage? {
            val o = element as? JsonObject ?: return null
            val attachments = when (val raw = o["attachments"]) {
                is JsonArray -> raw.size
                else -> o.long("attachments")?.toInt() ?: 0
            }
            return LastMessage(
                text = o.string("text").orEmpty(),
                direction = o.string("direction").orEmpty(),
                created = o.long("created") ?: 0L,
                deliveryStatus = o.string("delivery_status").orEmpty(),
                attachments = attachments.coerceAtLeast(0),
                kind = o.string("kind")?.takeIf { it.isNotBlank() } ?: "text",
            )
        }
    }
}

@Serializable data class Message(
    val id: String,
    val profile_id: String = "",
    val conversation_id: String = "",
    val direction: String = "", // customer | outbound | operator | note | system
    val author: String = "",
    val text: String = "",
    val attachments: String = "[]",
    val external_id: String? = null,
    val created: Long = 0,
    val content: String = "{}",
    val delivery_status: String = "",
    val status_at: Long = 0,
) {
    val attachmentIds: List<String> get() = attachments.parseJsonStringList()
    val contentJson: JsonObject get() = content.parseJsonObject()
    val isIncoming get() = direction == "customer"
    val isNote get() = direction == "note"
}

@Serializable data class MediaFile(val id: String, val name: String = "", val type: String = "application/octet-stream", val size: Long = 0)
@Serializable data class Delivery(val id: String, val status: String = "", val error: String? = null, val created: Long = 0)
@Serializable data class ConversationDetail(
    val conversation: Conversation,
    val media: List<MediaFile> = emptyList(),
    val capabilities: JsonObject? = null,
    val group: JsonObject? = null,
    val contact: JsonObject? = null,
    val messages: List<Message> = emptyList(),
    val deliveries: List<Delivery> = emptyList(),
) {
    fun can(feature: String): Boolean = capabilities?.bool(feature) ?: false
}

/** POST /conversations/{id}/actions. `content` segue o esquema MessageContent da API. */
@Serializable data class ActionRequest(
    val action: String, // claim | reply | note | transfer | resolve | resume | tags | menu | protocols | survey
    val text: String? = null,
    val target: String? = null,
    val attachments: List<String>? = null,
    val content: JsonObject? = null,
    val tags: List<String>? = null,
    val menu_id: String? = null,
    /** `transfer` para um setor: envie `department_id` sem `target`. */
    val department_id: String? = null,
    /** `protocols`: número do protocolo a consultar (opcional). */
    val number: String? = null,
)
@Serializable data class ActionResult(val delivery_id: String? = null, val status: String? = null, val id: String? = null)
@Serializable data class MessageActionRequest(val action: String, val message_id: String, val emoji: String? = null, val text: String? = null)
@Serializable data class UploadInit(val name: String, val type: String, val size: Long)
@Serializable data class UploadCreated(val id: String, val part_size: Long, val parts: Int)
@Serializable data class UploadDone(val id: String, val name: String? = null, val size: Long? = null, val status: String? = null)
@Serializable data class GroupPolicyRequest(val bot_policy: String)

@Serializable data class Ticket(
    val id: String,
    val number: String = "",
    val profile_id: String = "",
    val conversation_id: String = "",
    val title: String = "",
    /** open | in_progress | waiting_customer | waiting_third | resolved | closed (ver [TicketStatus]). */
    val status: String = "open",
    val owner: String? = null,
    val response_due_at: Long? = null,
    val first_response_at: Long? = null,
    val created: Long = 0,
    val updated: Long = 0,
    /** Servidor 0.14+: `id` de uma categoria de `settings.ticket_categories` (aplicativo ou assunto). */
    val category: String? = null,
) {
    /** Ativo = não é `resolved` nem `closed`. Um estado futuro desconhecido conta como ativo. */
    val isActive: Boolean get() = TicketStatus.isActive(status)
    val isOverdue: Boolean get() = isOverdueAt(System.currentTimeMillis())
    /** Atrasado: só protocolo ativo, sem primeira resposta e com o prazo vencido. */
    fun isOverdueAt(now: Long): Boolean = isActive && first_response_at == null && response_due_at != null && response_due_at < now
}

/** Os seis estados do protocolo (docs/CENTRAL-ATENDIMENTO.md §2), com o texto usado pela equipe. */
object TicketStatus {
    const val OPEN = "open"
    const val IN_PROGRESS = "in_progress"
    const val WAITING_CUSTOMER = "waiting_customer"
    const val WAITING_THIRD = "waiting_third"
    const val RESOLVED = "resolved"
    const val CLOSED = "closed"

    /** Ordem do seletor do detalhe. */
    val all = listOf(OPEN, IN_PROGRESS, WAITING_CUSTOMER, WAITING_THIRD, RESOLVED, CLOSED)
    val waiting = listOf(WAITING_CUSTOMER, WAITING_THIRD)
    val finished = listOf(RESOLVED, CLOSED)

    fun isKnown(status: String): Boolean = status in all
    fun isActive(status: String): Boolean = status != RESOLVED && status != CLOSED

    /** Estado desconhecido (servidor mais novo) vira texto neutro, legível, sem derrubar a tela. */
    fun label(status: String): String = when (status) {
        OPEN -> "Recebido"
        IN_PROGRESS -> "Em análise"
        WAITING_CUSTOMER -> "Aguardando cliente"
        WAITING_THIRD -> "Aguardando terceiro"
        RESOLVED -> "Resolvido"
        CLOSED -> "Encerrado"
        else -> status.replace('_', ' ').trim().replaceFirstChar { it.uppercase() }.ifBlank { "Sem estado" }
    }
}

/** Categoria de protocolo (`settings.ticket_categories` de GET /status): aplicativo ou assunto. */
data class TicketCategory(val id: String, val name: String, val enabled: Boolean)

/** Nome da categoria gravada no protocolo; categoria removida da configuração mostra o `id` gravado. */
fun List<TicketCategory>.nameOf(categoryId: String?): String? {
    val id = categoryId?.takeIf { it.isNotBlank() } ?: return null
    return firstOrNull { it.id == id }?.name ?: id
}

@Serializable data class TicketUpdate(val id: String, val ticket_id: String = "", val actor: String = "", val text: String = "", val internal: Int = 0, val created: Long = 0)
@Serializable data class TicketDetail(val ticket: Ticket, val updates: List<TicketUpdate> = emptyList(), val conversation: JsonObject? = null)
/** `category` nulo não é enviado (servidores 0.13 não conhecem o campo). */
@Serializable data class TicketCreate(val conversation_id: String, val title: String, val category: String? = null)

@Serializable data class Bot(val id: String, val profile_id: String = "", val connection_id: String = "", val remote_profile: String = "", val name: String = "", val enabled: Int = 0, val line_ids: String? = null)
@Serializable data class BotRunRequest(val profile_id: String, val bot_id: String, val input: String)
@Serializable data class BotRun(
    val id: String,
    val profile_id: String = "",
    val bot_id: String = "",
    val actor: String = "",
    val conversation_id: String? = null,
    val status: String = "queued", // queued | starting | running | cancelling | cancelled | completed | failed | unknown
    val input: String = "",
    val result: String? = null,
    val error: String? = null,
    val attachments: List<String> = emptyList(),
    val created: Long = 0,
    val updated: Long = 0,
) {
    val isFinal get() = status in setOf("completed", "failed", "cancelled", "unknown")
}

@Serializable data class PresenceEntry(val actor: String, val name: String = "", val present: Int = 0, val telegram_id: String? = null)
@Serializable data class PresenceRequest(val present: Boolean)
@Serializable data class PresenceResult(val actor: String = "", val present: Boolean = false)

@Serializable data class Event(val id: Long, val profile_id: String = "", val kind: String = "", val resource_id: String? = null, val payload: JsonElement? = null, val created: Long = 0)
@Serializable data class Events(val data: List<Event> = emptyList(), val cursor: Long = 0)

@Serializable data class CallSession(val sdp_type: String, val sdp: String)
@Serializable data class Call(
    val id: String,
    val conversation_id: String = "",
    val direction: String = "", // inbound | outbound
    val actor: String? = null,
    val status: String = "", // dialing | connecting | ringing | preaccepted | active | completed | rejected | missed | failed | unknown
    val error: String? = null,
    val started: Long? = null,
    val ended: Long? = null,
    val duration: Long? = null,
    val created: Long = 0,
    val updated: Long = 0,
    val session: CallSession? = null,
) {
    val isLive get() = status !in setOf("completed", "missed", "rejected", "failed")
}
@Serializable data class CallStart(val conversation_id: String, val session: CallSession)
@Serializable data class CallAccept(val session: CallSession)
@Serializable data class CallPermissionRequest(val conversation_id: String)
@Serializable data class CallReconcile(val confirmed_ended: Boolean = true)
@Serializable data class CallActionResult(val id: String = "", val status: String = "", val delivery_id: String? = null)

@Serializable data class DeviceRegistration(
    val platform: String = "android",
    val provider: String = "fcm",
    val token: String,
    val name: String,
    val app_version: String,
    val profiles: List<String> = emptyList(),
    val enabled: Boolean = true,
)
@Serializable data class Device(
    val id: String,
    val user_id: String = "",
    val platform: String = "",
    val provider: String = "fcm",
    val name: String = "",
    val app_version: String = "",
    /** O servidor (deviceView em src/index.ts) devolve a lista já decodificada. */
    val profiles: List<String> = emptyList(),
    val enabled: Int = 1,
    val last_error: String? = null,
    val created: Long = 0,
    val updated: Long = 0,
)

@Serializable data class CountRow(val state: String? = null, val status: String? = null, val count: Long = 0)
@Serializable data class ConnectionSummary(val id: String, val name: String = "", val kind: String = "", val status: String = "", val last_seen: Long? = null)
@Serializable data class ProfileStatus(
    val settings: JsonObject? = null,
    val enabled: Int? = null,
    val conversations: List<CountRow> = emptyList(),
    val deliveries: List<CountRow> = emptyList(),
    val connections: List<ConnectionSummary> = emptyList(),
) {
    /** `connection_id` → `kind` (meta, zernio, qr, hermes…). */
    fun lineKinds(): Map<String, String> = connections.associate { it.id to it.kind }
    fun conversationCount(state: String): Int = conversations.firstOrNull { it.state == state }?.count?.toInt() ?: 0
    /** Setores habilitados configurados no painel (`settings.departments`). */
    fun departments(): List<Department> = settings?.array("departments")?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val id = o.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        Department(
            id = id,
            name = o.string("name").orEmpty().ifBlank { "Setor" },
            enabled = o.bool("enabled") ?: true,
            members = o.array("members")?.mapNotNull { it.asStringOrNull() }.orEmpty(),
        )
    }.orEmpty()
    /** Categorias de protocolo (`settings.ticket_categories`, servidor 0.14+); vazio quando não configuradas. */
    fun ticketCategories(): List<TicketCategory> = settings?.array("ticket_categories")?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val id = o.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        TicketCategory(id = id, name = o.string("name").orEmpty().ifBlank { id }, enabled = o.bool("enabled") ?: true)
    }.orEmpty()
}
/** Setor de atendimento (`settings.departments` de GET /status). */
data class Department(val id: String, val name: String, val enabled: Boolean, val members: List<String>)
@Serializable data class Contact(
    val id: String,
    val name: String = "",
    val phone: String? = null,
    val email: String? = null,
    val company: String? = null,
    val notes: String? = null,
    val version: Int = 1,
)
