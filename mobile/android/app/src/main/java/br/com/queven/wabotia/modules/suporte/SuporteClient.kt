package br.com.queven.wabotia.modules.suporte

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/*
 * Passagem feita por módulo e Suporte pago (docs/API.md "Passagem feita por módulo", docs/SUPORTE.md). O núcleo grava
 * no detalhe da conversa o `handoff` de quem passou a conversa à equipe (resumo e marcadores, como "telefone não
 * vinculado ao pagador X"); o Suporte expõe o estado da conversa e as ações do atendente: vincular o telefone ao
 * pagador, confirmar e liberar, e liberar como cortesia. Só a equipe libera; "já paguei" do cliente nunca libera.
 * Mesmo desenho do iOS (`Modules/Suporte/SuporteClient.swift`).
 */

/** `handoff` do detalhe da conversa: só para quem lê notas internas; some na próxima passagem sem módulo e ao encerrar. */
@Serializable
data class ModuleHandoff(
    val module: String? = null,
    val summary: String? = null,
    val flags: List<String> = emptyList(),
    val at: Long? = null,
) {
    val visibleFlags: List<String> get() = flags.map { it.trim() }.filter { it.isNotEmpty() }
    val hasContent: Boolean get() = !summary.isNullOrBlank() || visibleFlags.isNotEmpty()

    companion object {
        /** O `handoff` cru do detalhe (objeto, `null` ou ausente); vazio também vira `null`. */
        fun of(element: JsonElement?): ModuleHandoff? {
            if (element == null || element is JsonNull || element !is JsonObject) return null
            return runCatching { WabotiaJson.decodeFromJsonElement(serializer(), element) }.getOrNull()?.takeIf { it.hasContent }
        }
    }
}

@Serializable
data class SuporteRelease(
    val id: String? = null,
    @SerialName("payer_id") val payerId: String? = null,
    @SerialName("payer_name") val payerName: String? = null,
    val kind: String? = null,
    @SerialName("kind_label") val kindLabel: String? = null,
    @SerialName("phone_linked") val phoneLinked: Boolean? = null,
    @SerialName("valid_until") val validUntil: Long? = null,
    @SerialName("until_ticket") val untilTicket: Boolean? = null,
    val reason: String? = null,
    val status: String? = null,
)

@Serializable
data class SuporteSession(
    val status: String? = null,
    val step: String? = null,
    @SerialName("payer_id") val payerId: String? = null,
    val name: String? = null,
    @SerialName("phone_linked") val phoneLinked: Boolean? = null,
    @SerialName("matched_by") val matchedBy: String? = null,
)

@Serializable
data class SuporteUnlinked(@SerialName("payer_id") val payerId: String? = null, @SerialName("payer_name") val payerName: String? = null)

@Serializable
data class SuportePurchase(
    val id: String? = null,
    @SerialName("package_name") val packageName: String? = null,
    @SerialName("amount_cents") val amountCents: Long? = null,
    val status: String? = null,
    val created: Long? = null,
)

/** `GET /suporte/conversations/{id}`. */
@Serializable
data class SuporteStatus(
    @SerialName("conversation_id") val conversationId: String? = null,
    val phone: String? = null,
    val allowed: Boolean? = null,
    /** `released`, `subscription`, `payment_required`, `module_disabled`… */
    val reason: String? = null,
    val release: SuporteRelease? = null,
    val session: SuporteSession? = null,
    @SerialName("awaiting_team") val awaitingTeam: Boolean? = null,
    @SerialName("unlinked_phone") val unlinkedPhone: SuporteUnlinked? = null,
    val purchases: List<SuportePurchase> = emptyList(),
)

/** O cliente das rotas do Suporte pago de uma área. */
class SuporteClient(val api: ProfileApi) {
    suspend fun status(conversationId: String): SuporteStatus = api.get("suporte/conversations/$conversationId", SuporteStatus.serializer())

    /** Autoriza o telefone da conversa no pagador identificado ("Vincular ao pagador"); responde o estado novo. */
    suspend fun linkPhone(conversationId: String, key: String): SuporteStatus =
        api.send("POST", "suporte/conversations/$conversationId/link-phone", jsonBody(), key, SuporteStatus.serializer())

    /** Modo "só telefone vinculado": a equipe confirma (e vincula) e libera. */
    suspend fun confirm(conversationId: String, link: Boolean, key: String): SuporteRelease =
        api.send("POST", "suporte/conversations/$conversationId/confirm", jsonBody("link" to link), key, SuporteRelease.serializer())

    /** Libera sem pagamento, com motivo; `hours` nulo vale até o protocolo fechar. */
    suspend fun courtesy(conversationId: String, reason: String, hours: Int?, key: String): SuporteRelease =
        api.send("POST", "suporte/conversations/$conversationId/courtesy", jsonBody("reason" to reason, "hours" to hours), key, SuporteRelease.serializer())
}

/** Regras da faixa da passagem e das ações do Suporte, sem tela, para testar. */
object SuporteRules {
    fun moduleName(module: String?): String = when (module) {
        "suporte" -> "Suporte pago"
        "mensalidade" -> "Mensalidade"
        "pedido" -> "Pedido"
        "agenda" -> "Agenda"
        "os" -> "Ordem de serviço"
        "reserva" -> "Reserva"
        null, "" -> "Módulo"
        else -> module.replaceFirstChar { it.uppercase() }
    }

    /** A situação do suporte numa linha. */
    fun statusText(s: SuporteStatus): String {
        if (s.awaitingTeam == true) return "Aguardando a equipe confirmar e liberar"
        val r = s.release
        if (r != null && (r.status == null || r.status == "active")) {
            return buildList {
                add(r.kindLabel?.takeIf { it.isNotBlank() } ?: "Liberado")
                r.payerName?.takeIf { it.isNotBlank() }?.let(::add)
                when {
                    r.validUntil != null -> add("até ${BrasiliaTime.shortWithTime(r.validUntil)}")
                    r.untilTicket == true -> add("até o protocolo fechar")
                }
            }.joinToString(" · ")
        }
        return when (s.reason) {
            "subscription" -> "Assinatura em dia"
            "released" -> "Liberado"
            "payment_required" -> "Sem liberação: pagamento pendente"
            "module_disabled" -> "Suporte pago desligado"
            else -> if (s.allowed == true) "Liberado" else "Sem liberação"
        }
    }

    fun canLink(s: SuporteStatus?): Boolean = s?.unlinkedPhone?.payerId != null
    fun canConfirm(s: SuporteStatus?): Boolean = s?.awaitingTeam == true
    /** Cortesia quando o cliente ainda não está liberado (ou aguarda a equipe). */
    fun canCourtesy(s: SuporteStatus?): Boolean = s != null && (s.allowed != true || s.awaitingTeam == true)

    fun linkTitle(s: SuporteStatus?): String {
        val name = s?.unlinkedPhone?.payerName?.trim().orEmpty()
        return if (name.isEmpty()) "Vincular telefone ao pagador" else "Vincular telefone a $name"
    }

    /** Validades da cortesia: até o protocolo fechar (`null`) ou por horas. */
    val COURTESY_OPTIONS: List<Pair<Int?, String>> = listOf(null to "Até o protocolo fechar", 24 to "24 horas", 72 to "3 dias", 168 to "7 dias")

    /** A faixa aparece com a conversa aberta; a passagem do Suporte pago, só com o módulo ligado. */
    fun showBand(handoff: ModuleHandoff?, conversationState: String?, suporteEnabled: Boolean): Boolean =
        handoff != null && conversationState != "closed" && (handoff.module != "suporte" || suporteEnabled)

    fun success(action: String): String = when (action) {
        "link" -> "Telefone vinculado ao pagador"
        "confirm" -> "Confirmado e liberado"
        else -> "Liberado como cortesia"
    }

    fun explain(error: Throwable): String = when ((error as? QueueException)?.code) {
        "nothing_to_link" -> "Não há pagador aguardando vínculo nesta conversa. A faixa foi atualizada."
        "nothing_to_confirm" -> "Esta conversa não espera mais confirmação. A faixa foi atualizada."
        "forbidden" -> "Assuma a conversa antes de liberar o suporte."
        else -> ModuleFailure.message(error)
    }
}
