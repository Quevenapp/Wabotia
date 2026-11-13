package br.com.queven.wabotia.ui.conversations

import br.com.queven.wabotia.core.MessagePreview
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.Department
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.parseJsonStringList
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.ui.components.formatSpan
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// Textos e conversões das telas de conversa (pt-BR, DESIGN.md §1, §4 e §5).

internal fun deliveryLabel(status: String): String = when (status) {
    "sent" -> "Enviada"
    "delivered" -> "Entregue"
    "read" -> "Lida"
    "played" -> "Ouvida"
    "pending" -> "Na fila"
    "sending" -> "Enviando"
    "failed" -> "Falhou"
    "unknown" -> "Sem confirmação"
    "cancelled" -> "Cancelada"
    else -> status
}

internal fun botPolicyLabel(policy: String): String = when (policy) {
    "off" -> "Somente atendimento humano"
    "all" -> "Todas as mensagens"
    else -> "Quando mencionado ou /bot"
}

internal fun Conversation.tagList(): List<String> = tags.parseJsonStringList()

/** Nome curto (primeiro nome) para "Com Ana". */
internal fun firstName(name: String): String = name.trim().substringBefore(' ').ifBlank { name }

/** Nome do bot que atende a conversa, quando conhecido. */
internal fun Conversation.botName(team: Map<String, TeamContact>): String? =
    assigned_bot_id?.let { id -> team["bot:$id"]?.name ?: team[id]?.name }

/** Quem está com a conversa, em poucas palavras: "Com você", "Com Ana", "Bot Vendas", "Setor Financeiro". */
internal fun Conversation.ownerShort(meId: String?, team: Map<String, TeamContact>, departments: List<Department>): String? = when (state) {
    "human" -> when {
        owner != null && owner == meId -> "Com você"
        owner != null -> "Com ${team[owner]?.name?.let(::firstName) ?: "atendente"}"
        else -> null
    }
    "ai" -> botName(team)?.let { "Bot $it" } ?: "Com o bot"
    "waiting" -> department_id?.let { id -> departments.firstOrNull { it.id == id }?.name }?.let { "Setor $it" }
    else -> null
}

/** Subtítulo da barra da conversa: "Com você", "Na fila há 4 min", "Com o bot Vendas", "Com Ana · Online". */
internal fun Conversation.stateSubtitle(meId: String?, team: Map<String, TeamContact>, now: Long): String = when (state) {
    "waiting" -> "Na fila há ${formatSpan(now - updated).let { if (it == "agora") "instantes" else it }}"
    "ai" -> botName(team)?.let { "Com o bot $it" } ?: "Com o bot do atendimento"
    "human" -> when {
        owner != null && owner == meId -> "Com você"
        owner != null -> {
            val person = team[owner]
            if (person != null) "Com ${firstName(person.name)} · ${if (person.online) "Online" else "Offline"}" else "Com outro atendente"
        }
        else -> "Em atendimento"
    }
    "closed" -> "Concluída"
    else -> state
}

/** Texto do estado quando não há prévia conhecida ("Aguardando atendente", "Em atendimento com o bot Vendas"). */
internal fun Conversation.stateText(meId: String?, team: Map<String, TeamContact>): String = when (state) {
    "waiting" -> "Aguardando atendente"
    "ai" -> botName(team)?.let { "Em atendimento com o bot $it" } ?: "Em atendimento com o bot"
    "human" -> when {
        owner != null && owner == meId -> "Em atendimento com você"
        owner != null -> "Em atendimento com ${team[owner]?.name?.let(::firstName) ?: "outro atendente"}"
        else -> "Em atendimento"
    }
    "closed" -> "Conversa concluída"
    else -> ""
}

/** Prévia em uma linha: anexo vira emoji + tipo ("📷 Foto", "🎤 Áudio", "📄 Documento", "📍 Localização"). */
internal fun MessagePreview.label(): String {
    val caption = text.trim().replace('\n', ' ')
    val media = when (kind) {
        "image" -> "📷 Foto"
        "sticker" -> "🖼️ Figurinha"
        "video" -> "🎥 Vídeo"
        "voice" -> "🎤 Áudio"
        "audio" -> "🎵 Áudio"
        "document" -> "📄 Documento"
        "location" -> "📍 Localização"
        "contacts" -> "👤 Contato"
        "attachment" -> "📎 Anexo"
        "deleted" -> return "Mensagem apagada"
        else -> null
    }
    return when {
        media == null -> caption
        caption.isBlank() || kind == "location" || kind == "contacts" -> media
        else -> "$media · $caption"
    }
}

data class GroupMember(val id: String, val name: String, val admin: Boolean) {
    val display: String get() = name.ifBlank { id }
}

/** Participantes do grupo (`group.participants` chega como JSON em string, igual ao painel web). */
internal fun ConversationDetail.groupMembers(): List<GroupMember> {
    val raw = group?.get("participants") ?: return emptyList()
    val array: JsonArray = when (raw) {
        is JsonArray -> raw
        else -> {
            val text = group?.string("participants") ?: return emptyList()
            runCatching { WabotiaJson.parseToJsonElement(text) }.getOrNull() as? JsonArray ?: return emptyList()
        }
    }
    return array.mapNotNull { element ->
        val obj = element as? JsonObject ?: return@mapNotNull null
        val id = obj.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        GroupMember(id = id, name = obj.string("name").orEmpty(), admin = obj.bool("admin") ?: false)
    }
}

/**
 * Heurística de reserva (quando o `kind` da conexão não está disponível): canal Meta direto não oferece editar/apagar nem
 * menções e nunca tem `upgrade_required`. Prefira o `kind` de GET /profiles/{p}/status.
 */
internal fun ConversationDetail.isMetaLike(): Boolean =
    capabilities != null && !can("upgrade_required") && !can("edit") && !can("delete") && !can("mentions")
