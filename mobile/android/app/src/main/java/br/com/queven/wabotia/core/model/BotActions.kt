package br.com.queven.wabotia.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/*
 * Ações pelo bot na conversa interna (docs/API.md, "Ações pelo bot na conversa interna", feat/bot-acoes 3bb3d68): a
 * mensagem traz `kind` (`text`, `proposal`, `result`, `approval`) e `payload`. Toda mensagem tem `text` de reserva:
 * tipo desconhecido ou payload que não se lê aparece como texto.
 */

/** Proposta de ação do bot; o estado vem sempre atual na leitura. */
@Serializable
data class BotProposal(
    val id: String,
    /** `pending`, `running`, `done`, `failed`, `cancelled`, `expired`. */
    val status: String = "pending",
    val operation: String = "",
    /** Escrito pelo bot. */
    val summary: String = "",
    val params: JsonObject? = null,
    /** Operação sensível: pede o código do autenticador. */
    val sensitive: Boolean = false,
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("decided_at") val decidedAt: Long? = null,
    val result: JsonElement? = null,
    val error: JsonElement? = null,
    val created: Long = 0,
)

@Serializable
data class ProposalPayload(
    /** Do catálogo, não do bot. */
    @SerialName("operation_summary") val operationSummary: String? = null,
    val module: String? = null,
    val actions: List<String> = emptyList(),
    val proposal: BotProposal,
)

@Serializable
data class ApprovalField(val key: String = "", val label: String = "", val value: JsonElement? = null) {
    val text: String get() = value.display()
}

@Serializable
data class ApprovalAdjust(val label: String = "Ajuste", val type: String = "number", val min: Double? = null, val max: Double? = null)

/** Pedido de aprovação (desconto, dispensa de parcela), já filtrado para quem lê. */
@Serializable
data class Approval(
    val id: String,
    @SerialName("module_id") val moduleId: String? = null,
    val kind: String? = null,
    @SerialName("ref_id") val refId: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    val title: String = "",
    /** `pending`, `deciding`, `approved`, `declined`, `handoff`, `expired`. */
    val status: String = "pending",
    /** Lidos por código pelo módulo: mostrar como vêm. */
    val fields: List<ApprovalField> = emptyList(),
    @SerialName("hidden_fields") val hiddenFields: Int = 0,
    /** O que o bot escreveu: separado dos números, como "não verificado". */
    @SerialName("model_summary") val modelSummary: String? = null,
    val adjust: ApprovalAdjust? = null,
    @SerialName("can_decide") val canDecide: Boolean = false,
    val value: Double? = null,
    val reason: String? = null,
    @SerialName("decided_by") val decidedBy: JsonElement? = null,
    @SerialName("decided_at") val decidedAt: Long? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
    val created: Long = 0,
) {
    /** `decided_by` como nome, venha texto ou `{id, name}`. */
    val decidedByName: String?
        get() = when (val d = decidedBy) {
            null, JsonNull -> null
            is JsonPrimitive -> d.contentOrNull
            is JsonObject -> (d["name"] as? JsonPrimitive)?.contentOrNull ?: (d["id"] as? JsonPrimitive)?.contentOrNull
            else -> null
        }
}

@Serializable
data class ApprovalPayload(val approval: Approval)

/** Como desenhar uma mensagem da conversa interna. */
sealed interface StructuredMessage {
    data object Text : StructuredMessage
    data class Proposal(val payload: ProposalPayload) : StructuredMessage
    data class Result(val payload: ProposalPayload) : StructuredMessage
    data class ApprovalRequest(val approval: Approval) : StructuredMessage

    companion object {
        fun of(message: InternalMessage): StructuredMessage {
            val payload = message.payload as? JsonObject ?: return Text
            return runCatching {
                when (message.kind) {
                    "proposal" -> Proposal(WabotiaJson.decodeFromJsonElement(ProposalPayload.serializer(), payload))
                    "result" -> Result(WabotiaJson.decodeFromJsonElement(ProposalPayload.serializer(), payload))
                    "approval" -> ApprovalRequest(WabotiaJson.decodeFromJsonElement(ApprovalPayload.serializer(), payload).approval)
                    else -> Text
                }
            }.getOrDefault(Text)
        }
    }
}

/** Valor de JSON para a tela: texto como vem, número sem ".0", lista e objeto compactos. */
fun JsonElement?.display(): String = when (this) {
    null, JsonNull -> "—"
    is JsonPrimitive -> contentOrNull?.let { c -> c.toDoubleOrNull()?.takeIf { !isString && it % 1.0 == 0.0 }?.toLong()?.toString() ?: c } ?: "—"
    is JsonArray -> joinToString(", ") { it.display() }
    is JsonObject -> entries.joinToString(", ") { (k, v) -> "$k: ${v.display()}" }
}
