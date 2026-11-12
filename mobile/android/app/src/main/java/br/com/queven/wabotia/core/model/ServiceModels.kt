package br.com.queven.wabotia.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable data class TeamContact(
    val id: String, val kind: String, val name: String, val online: Boolean,
    val bot_id: String? = null, val line_ids: List<String>? = null, val enabled: Boolean? = null,
) {
    val isBot get() = kind == "bot"
    /** Bot habilitado e autorizado para a linha (`line_ids == null` = todas). Pessoas sempre passam. */
    fun allowedOn(connectionId: String?): Boolean = !isBot || (enabled != false && (line_ids == null || (connectionId != null && connectionId in line_ids)))
}
@Serializable data class LineService(val mode: String = "inherit", val bot_id: String? = null, val menu_mode: String = "automatic")
@Serializable data class ServiceLine(
    val id: String, val name: String, val kind: String, val mode: String, val status: String,
    val number: String? = null, val number_policy: JsonObject = JsonObject(emptyMap()), val service: LineService = LineService(),
)
/**
 * Nome legível do destino de uma opção de menu (`type`). `ticket` ("Abrir protocolo") chegou no servidor 0.14; um tipo
 * que este aplicativo ainda não conhece aparece com o próprio identificador, nunca como outro destino.
 */
fun menuTypeLabel(type: String?): String = when (type) {
    null, "", "human" -> "Pessoa"
    "bot" -> "Bot"
    "submenu" -> "Submenu"
    "app" -> "Aplicativo"
    "link" -> "Link"
    "content" -> "Mensagem informativa"
    "protocols" -> "Consultar protocolos"
    "survey" -> "Pesquisa de satisfação"
    "ticket" -> "Abrir protocolo"
    else -> "Outro destino ($type)"
}

/**
 * Item de menu depois da edição no aplicativo. Parte do item original e só troca o que a tela edita: campos de destinos
 * que o aplicativo não edita (`url`, `content`, `question`, `department_id`…) e de tipos mais novos seguem intactos.
 * `bot_id`/`app_id` só mudam quando o destino é bot/aplicativo; `category_id` só quando o destino é `ticket`
 * (vazio remove o campo).
 */
fun editedMenuItem(
    original: JsonObject,
    label: String,
    type: String,
    parentId: String,
    botId: String,
    appId: String,
    categoryId: String,
    trigger: String,
    enabled: Boolean,
    lineIds: List<String>,
): JsonObject {
    val next = LinkedHashMap<String, JsonElement>(original)
    next["label"] = JsonPrimitive(label.trim())
    next["type"] = JsonPrimitive(type)
    next["parent_id"] = if (parentId.isNotEmpty()) JsonPrimitive(parentId) else JsonNull
    if (type == "bot") next["bot_id"] = JsonPrimitive(botId)
    if (type == "app") next["app_id"] = JsonPrimitive(appId)
    if (type == "ticket") {
        if (categoryId.isNotEmpty()) next["category_id"] = JsonPrimitive(categoryId) else next.remove("category_id")
    }
    next["trigger"] = JsonPrimitive(trigger)
    next["enabled"] = JsonPrimitive(enabled)
    next["line_ids"] = JsonArray(lineIds.map(::JsonPrimitive))
    return JsonObject(next)
}

@Serializable data class InternalChat(val id: String, val peer: TeamContact? = null, val messages: List<InternalMessage> = emptyList(), val created: Long = 0, val updated: Long = 0)
@Serializable data class InternalMessage(val id: String, val author: String, val text: String, val created: Long, val status: String? = null, val run_id: String? = null)
