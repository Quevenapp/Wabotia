package br.com.queven.wabotia.modules.os

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * Ordem de Serviço (módulo `os`, docs/ORDEM-DE-SERVICO.md e docs/API.md "Ordem de serviço"). Valores em centavos,
 * datas em ms. `next_statuses` diz os botões; `notes` é interno (não vai ao cliente nem ao comprovante).
 */

@Serializable
data class ServiceOrderCustomer(
    val name: String? = null,
    val phone: String? = null,
    @SerialName("contact_id") val contactId: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
)

@Serializable
data class ServiceOrderTerms(val text: String? = null, @SerialName("accepted_at") val acceptedAt: Long? = null)

@Serializable
data class QuoteItem(val description: String, val quantity: Int = 1, @SerialName("unit_cents") val unitCents: Long = 0) {
    val totalCents: Long get() = quantity * unitCents
}

@Serializable
data class ServiceOrderQuote(
    val items: List<QuoteItem> = emptyList(),
    @SerialName("total_cents") val totalCents: Long? = null,
    val note: String? = null,
    @SerialName("valid_days") val validDays: Int? = null,
    @SerialName("valid_until") val validUntil: Long? = null,
    @SerialName("sent_at") val sentAt: Long? = null,
    val version: Int? = null,
    val expired: Boolean? = null,
) {
    val total: Long get() = totalCents ?: items.sumOf { it.totalCents }
}

@Serializable
data class ServiceOrderDecision(val decision: String? = null, val at: Long? = null, val by: String? = null, val via: String? = null)

@Serializable
data class ServiceOrderHistory(
    val id: String = "",
    val kind: String? = null,
    @SerialName("from_status") val fromStatus: String? = null,
    @SerialName("to_status") val toStatus: String? = null,
    val actor: String? = null,
    val note: String? = null,
    val created: Long? = null,
)

@Serializable
data class ServiceOrder(
    val id: String,
    val number: Int? = null,
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    val customer: ServiceOrderCustomer? = null,
    val item: String? = null,
    val problem: String? = null,
    val notes: String? = null,
    val assignee: String? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    val source: String? = null,
    val terms: ServiceOrderTerms? = null,
    val quote: ServiceOrderQuote? = null,
    val decision: ServiceOrderDecision? = null,
    @SerialName("ready_at") val readyAt: Long? = null,
    @SerialName("delivered_at") val deliveredAt: Long? = null,
    @SerialName("warranty_until") val warrantyUntil: Long? = null,
    @SerialName("next_statuses") val nextStatuses: List<String> = emptyList(),
    val created: Long? = null,
    val updated: Long? = null,
    val history: List<ServiceOrderHistory>? = null,
) {
    val state: String get() = status ?: "received"
    val label: String get() = statusLabel?.takeIf { it.isNotBlank() } ?: ServiceOrderRules.statusLabel(state)
    val numberText: String get() = number?.let { "nº $it" } ?: "—"
    val customerName: String get() = customer?.name?.takeIf { it.isNotBlank() } ?: customer?.phone?.takeIf { it.isNotBlank() } ?: "Cliente"
}

/** Uma página da lista, com `counts` lido pelas chaves exatas (códigos de estado). */
data class ServiceOrderPage(val data: List<ServiceOrder>, val nextCursor: String?, val counts: Map<String, Int>) {
    /** Chave ausente vale 0. */
    fun count(status: String): Int = counts[status] ?: counts[ServiceOrderRules.camel(status)] ?: 0
}

/** O cliente das rotas da Ordem de Serviço de uma área. */
class ServiceOrderClient(val api: ProfileApi) {
    /** Lista por número decrescente. `open`: sem entregues e canceladas. */
    suspend fun list(statuses: List<String> = emptyList(), open: Boolean = false, query: String? = null, conversationId: String? = null, cursor: String? = null, limit: Int = 50): ServiceOrderPage {
        val raw = api.raw(
            "service-orders",
            mapOf(
                "status" to statuses.takeIf { it.isNotEmpty() }?.joinToString(","),
                "open" to if (open && statuses.isEmpty()) "1" else null,
                "q" to query?.trim()?.takeIf { it.isNotEmpty() },
                "conversation_id" to conversationId,
                "cursor" to cursor,
                "limit" to limit.toString(),
            ),
        ) as? JsonObject ?: JsonObject(emptyMap())
        val data = (raw["data"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull {
            runCatching { WabotiaJson.decodeFromJsonElement(ServiceOrder.serializer(), it) }.getOrNull()
        }.orEmpty()
        val counts = (raw["counts"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.intOrNull?.let { k to it } }?.toMap().orEmpty()
        val next = (raw["next_cursor"] as? JsonPrimitive)?.takeIf { it.isString || it.intOrNull != null }?.content
        return ServiceOrderPage(data, next, counts)
    }

    suspend fun order(id: String): ServiceOrder = api.get("service-orders/$id", ServiceOrder.serializer())

    /** Abre a ordem: ligada à conversa (o cliente é avisado) ou pelo telefone, no balcão. */
    suspend fun create(item: String, problem: String, conversationId: String?, phone: String?, customerName: String?, notes: String?, dueAt: Long?, assignee: String?, key: String): ServiceOrder =
        api.send(
            "POST", "service-orders",
            jsonBody(
                "item" to item, "problem" to problem, "conversation_id" to conversationId, "phone" to phone,
                "customer_name" to customerName, "notes" to notes, "due_at" to dueAt, "assignee" to assignee,
            ),
            key, ServiceOrder.serializer(),
        )

    /** Troca o responsável (`assignee`, o `id` de `GET /people`; `null` tira). */
    suspend fun assign(id: String, assignee: String?, key: String): ServiceOrder =
        api.send("PATCH", "service-orders/$id", jsonBody("assignee" to (assignee ?: JsonNull)), key, ServiceOrder.serializer())

    suspend fun setStatus(id: String, status: String, note: String?, key: String): ServiceOrder =
        api.send("POST", "service-orders/$id/status", jsonBody("status" to status, "note" to note), key, ServiceOrder.serializer())

    suspend fun saveQuote(id: String, items: List<QuoteItem>, validDays: Int?, note: String?, key: String): ServiceOrder =
        api.send(
            "PUT", "service-orders/$id/quote",
            jsonBody(
                "items" to items.map { mapOf("description" to it.description, "quantity" to it.quantity, "unit_cents" to it.unitCents) },
                "valid_days" to validDays, "note" to note,
            ),
            key, ServiceOrder.serializer(),
        )

    /** `notify = false` só registra o envio (orçamento entregue em mãos). */
    suspend fun sendQuote(id: String, notify: Boolean, key: String): ServiceOrder =
        api.send("POST", "service-orders/$id/quote/send", jsonBody("notify" to notify), key, ServiceOrder.serializer())

    /** Resposta do cliente dada no balcão ou por telefone. */
    suspend fun decide(id: String, approve: Boolean, key: String): ServiceOrder =
        api.send("POST", "service-orders/$id/decision", jsonBody("decision" to if (approve) "approve" else "decline"), key, ServiceOrder.serializer())
}

/** Regras das telas da Ordem de Serviço, sem tela, para testar. */
object ServiceOrderRules {
    val STATUSES = listOf("received", "analyzing", "quoted", "approved", "declined", "in_progress", "ready", "delivered", "cancelled")
    val CLOSED = setOf("delivered", "cancelled")
    /** Estados de onde o orçamento pode ser montado e enviado. */
    val QUOTABLE = setOf("received", "analyzing", "quoted", "declined")

    fun statusLabel(status: String): String = when (status) {
        "received" -> "Recebida"
        "analyzing" -> "Em análise"
        "quoted" -> "Orçamento enviado"
        "approved" -> "Aprovada"
        "declined" -> "Recusada"
        "in_progress" -> "Em execução"
        "ready" -> "Pronta"
        "delivered" -> "Entregue"
        "cancelled" -> "Cancelada"
        else -> status
    }

    fun camel(snake: String): String {
        val parts = snake.split("_")
        return parts.first() + parts.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercase) }
    }

    /**
     * Um botão por próximo estado, com o rótulo do que a pessoa faz. `quoted` vira "Enviar orçamento", `approved` e
     * `declined` viram a resposta do cliente; o cancelamento fica por último.
     */
    fun actions(order: ServiceOrder): List<Pair<String, String>> {
        val next = order.nextStatuses
        val out = next.filter { it != "cancelled" }.map { status ->
            status to when (status) {
                "analyzing" -> if (order.state == "quoted") "Voltar para análise" else "Em análise"
                "quoted" -> "Enviar orçamento"
                "approved" -> "Cliente aprovou"
                "declined" -> "Cliente recusou"
                "in_progress" -> if (order.state == "ready") "Voltar para execução" else "Iniciar execução"
                "ready" -> if (order.state == "declined") "Devolver sem conserto" else "Marcar como pronta"
                "delivered" -> "Registrar entrega"
                else -> statusLabel(status)
            }
        }
        return if ("cancelled" in next) out + ("cancelled" to "Cancelar ordem") else out
    }

    fun canEditQuote(order: ServiceOrder) = order.state in QUOTABLE

    /** Orçamento enviado e vencido: não pode ser aprovado, só reenviado. */
    fun quoteExpired(order: ServiceOrder, now: Long = System.currentTimeMillis()): Boolean =
        order.quote?.expired == true || (order.quote?.validUntil?.let { it <= now } ?: false)

    /** Filtros da lista: abertas, cada estado e todas. */
    val FILTERS: List<Pair<String, String>> = listOf("open" to "Abertas") + STATUSES.map { it to statusLabel(it) } + ("all" to "Todas")

    fun historyText(h: ServiceOrderHistory): String = when (h.kind) {
        "opened" -> "Ordem aberta"
        // O envio também é `quote`, mas leva a ordem para `quoted`.
        "quote" -> if (h.toStatus == "quoted" && h.fromStatus != "quoted") "Orçamento enviado" else "Orçamento salvo"
        "edit" -> "Dados alterados"
        else -> h.toStatus?.let(::statusLabel) ?: h.kind ?: "Alteração"
    }

    /** Quantas abertas: tudo menos entregues e canceladas. */
    fun openCount(page: ServiceOrderPage): Int = STATUSES.filter { it !in CLOSED }.sumOf { page.count(it) }
}
