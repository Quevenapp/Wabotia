package br.com.queven.wabotia.modules.pedido

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * Pedido (módulo `pedido`, docs/PEDIDO.md e docs/API.md "Pedido"). Valores em centavos, datas em ms. A cozinha vê o
 * quadro por estado; cada pedido traz `next_statuses` (os botões) e o pagamento. O mesmo `item_id` pode aparecer em
 * várias linhas com `slot` diferente (duas montagens do mesmo lanche): as linhas nunca são agrupadas por item. Mesmo
 * desenho do iOS (`Modules/Pedido/PedidoClient.swift`).
 */

@Serializable
data class PedidoCustomer(
    val name: String? = null,
    val phone: String? = null,
    @SerialName("contact_id") val contactId: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
)

@Serializable
data class PedidoAddress(
    val street: String? = null,
    val district: String? = null,
    val complement: String? = null,
    val reference: String? = null,
)

@Serializable
data class PedidoOption(
    @SerialName("group_id") val groupId: String? = null,
    val group: String? = null,
    val id: String? = null,
    val name: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
)

/** Uma linha do pedido: uma montagem (`slot`) de um item, com os adicionais e a observação dela. */
@Serializable
data class PedidoLine(
    @SerialName("item_id") val itemId: String? = null,
    val slot: Int? = null,
    val name: String? = null,
    val quantity: Int? = null,
    @SerialName("unit_cents") val unitCents: Long? = null,
    val options: List<PedidoOption> = emptyList(),
    val note: String? = null,
    @SerialName("total_cents") val totalCents: Long? = null,
)

@Serializable
data class PedidoPayment(
    val method: String? = null,
    @SerialName("method_label") val methodLabel: String? = null,
    val online: Boolean? = null,
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    @SerialName("payment_id") val paymentId: String? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    @SerialName("paid_at") val paidAt: Long? = null,
    @SerialName("paid_by") val paidBy: String? = null,
    val error: String? = null,
    @SerialName("change_for_cents") val changeForCents: Long? = null,
    @SerialName("needs_refund") val needsRefund: Boolean? = null,
)

@Serializable
data class PedidoHistory(
    val id: String = "",
    val kind: String? = null,
    @SerialName("from_status") val fromStatus: String? = null,
    @SerialName("to_status") val toStatus: String? = null,
    val actor: String? = null,
    val note: String? = null,
    val created: Long? = null,
)

@Serializable
data class PedidoOrder(
    val id: String,
    val number: Int? = null,
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    @SerialName("status_at") val statusAt: Long? = null,
    val customer: PedidoCustomer? = null,
    val source: String? = null,
    val fulfillment: String? = null,
    @SerialName("fulfillment_label") val fulfillmentLabel: String? = null,
    val address: PedidoAddress? = null,
    @SerialName("address_text") val addressText: String? = null,
    val lines: List<PedidoLine> = emptyList(),
    @SerialName("item_count") val itemCount: Int? = null,
    @SerialName("subtotal_cents") val subtotalCents: Long? = null,
    @SerialName("delivery_fee_cents") val deliveryFeeCents: Long? = null,
    @SerialName("total_cents") val totalCents: Long? = null,
    /** Observação do cliente (vai na comanda). */
    val note: String? = null,
    /** Observação interna da equipe (não vai ao cliente nem à comanda). */
    val notes: String? = null,
    @SerialName("eta_minutes") val etaMinutes: Int? = null,
    @SerialName("eta_at") val etaAt: Long? = null,
    val payment: PedidoPayment? = null,
    @SerialName("next_statuses") val nextStatuses: List<String> = emptyList(),
    @SerialName("cancel_reason") val cancelReason: String? = null,
    @SerialName("cancelled_by") val cancelledBy: String? = null,
    val created: Long? = null,
    val updated: Long? = null,
    val history: List<PedidoHistory>? = null,
    /** Só no quadro: minutos no estado atual e se passou do alerta. */
    @SerialName("minutes_in_status") val minutesInStatus: Int? = null,
    val late: Boolean? = null,
) {
    val state: String get() = status ?: "received"
    val label: String get() = statusLabel?.takeIf { it.isNotBlank() } ?: PedidoRules.statusLabel(state)
    val numberText: String get() = number?.let { "nº $it" } ?: "—"
    val delivery: Boolean get() = fulfillment == "delivery"
    val fulfillmentText: String get() = fulfillmentLabel?.takeIf { it.isNotBlank() } ?: if (delivery) "Entrega" else "Retirada"
    val customerName: String
        get() = customer?.name?.takeIf { it.isNotBlank() } ?: PhoneText.display(customer?.phone) ?: "Cliente"
}

/** Situação da loja. O quadro manda `open`, `reason`, `paused` e `message`; `GET /pedido` manda também `pause_message`. */
@Serializable
data class PedidoStore(
    val open: Boolean? = null,
    val reason: String? = null,
    val paused: Boolean? = null,
    @SerialName("pause_message") val pauseMessage: String? = null,
    val message: String? = null,
    @SerialName("hours_text") val hoursText: String? = null,
)

@Serializable
data class PedidoColumn(val status: String, val label: String? = null, val orders: List<PedidoOrder> = emptyList())

@Serializable
data class PedidoToday(
    val since: Long? = null,
    val orders: Int? = null,
    val delivered: Int? = null,
    val cancelled: Int? = null,
    @SerialName("total_cents") val totalCents: Long? = null,
)

@Serializable
data class PedidoBoard(
    @SerialName("generated_at") val generatedAt: Long? = null,
    val store: PedidoStore? = null,
    val columns: List<PedidoColumn> = emptyList(),
    val today: PedidoToday? = null,
) {
    val count: Int get() = columns.sumOf { it.orders.size }
}

/** Uma página da lista, com `counts` lido pelas chaves exatas (códigos de estado, como `out_for_delivery`). */
data class PedidoPage(val data: List<PedidoOrder>, val nextCursor: String?, val counts: Map<String, Int>) {
    fun count(status: String): Int = counts[status] ?: 0
}

@Serializable
data class PedidoMenuOption(
    val id: String,
    val name: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    val available: Boolean? = null,
)

@Serializable
data class PedidoMenuGroup(
    val id: String,
    val name: String? = null,
    val min: Int? = null,
    val max: Int? = null,
    val options: List<PedidoMenuOption> = emptyList(),
)

@Serializable
data class PedidoMenuItem(
    val id: String,
    @SerialName("category_id") val categoryId: String? = null,
    val name: String? = null,
    val description: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    val available: Boolean? = null,
    @SerialName("group_ids") val groupIds: List<String> = emptyList(),
)

@Serializable
data class PedidoMenuCategory(
    val id: String,
    val name: String? = null,
    val description: String? = null,
    val items: List<PedidoMenuItem> = emptyList(),
)

@Serializable
data class PedidoMenu(val categories: List<PedidoMenuCategory> = emptyList(), val groups: List<PedidoMenuGroup> = emptyList())

/** A comanda pronta (`GET …/orders/{id}/ticket`): o texto em colunas fixas, já com o estabelecimento. */
@Serializable
data class PedidoTicket(val columns: Int? = null, val text: String? = null)

/** O cliente das rotas do Pedido de uma área. */
class PedidoClient(val api: ProfileApi) {
    suspend fun board(): PedidoBoard = api.get("pedido/board", PedidoBoard.serializer())

    /** Lista por número decrescente. `open`: só os em andamento. */
    suspend fun list(statuses: List<String> = emptyList(), open: Boolean = false, query: String? = null, conversationId: String? = null, cursor: String? = null, limit: Int = 50): PedidoPage {
        val raw = api.raw(
            "pedido/orders",
            mapOf(
                "status" to statuses.takeIf { it.isNotEmpty() }?.joinToString(","),
                "open" to if (open && statuses.isEmpty()) "1" else null,
                "q" to query?.trim()?.takeIf { it.isNotEmpty() },
                "conversation_id" to conversationId,
                "cursor" to cursor,
                "limit" to limit.toString(),
            ),
        ) as? JsonObject ?: JsonObject(emptyMap())
        val data = (raw["data"] as? JsonArray)?.mapNotNull {
            runCatching { WabotiaJson.decodeFromJsonElement(PedidoOrder.serializer(), it) }.getOrNull()
        }.orEmpty()
        val counts = (raw["counts"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.intOrNull?.let { k to it } }?.toMap().orEmpty()
        val next = (raw["next_cursor"] as? JsonPrimitive)?.takeIf { it.isString || it.intOrNull != null }?.content
        return PedidoPage(data, next, counts)
    }

    suspend fun order(id: String): PedidoOrder = api.get("pedido/orders/$id", PedidoOrder.serializer())

    /** A comanda em 32, 42 ou 48 colunas. */
    suspend fun ticket(id: String, columns: Int): PedidoTicket =
        api.get("pedido/orders/$id/ticket", PedidoTicket.serializer(), mapOf("columns" to columns.toString()))

    /** `reason` vai ao cliente no cancelamento; `notify = false` muda sem avisar no WhatsApp. */
    suspend fun setStatus(id: String, status: String, note: String?, reason: String?, notify: Boolean, key: String): PedidoOrder =
        api.send("POST", "pedido/orders/$id/status", jsonBody("status" to status, "note" to note, "reason" to reason, "notify" to notify), key, PedidoOrder.serializer())

    /** Pagamento recebido na hora (dinheiro, maquininha) ou por fora. */
    suspend fun markPaid(id: String, note: String?, key: String): PedidoOrder =
        api.send("POST", "pedido/orders/$id/paid", jsonBody("note" to note), key, PedidoOrder.serializer())

    /** A equipe define a forma de pagamento (dinheiro ou maquininha) quando o cliente ainda não escolheu. */
    suspend fun setMethod(id: String, method: String, key: String): PedidoOrder =
        api.send("POST", "pedido/orders/$id/payment", jsonBody("method" to method), key, PedidoOrder.serializer())

    /** "Loja fechada agora" e a volta; responde a situação da loja. */
    suspend fun pause(paused: Boolean, message: String?, key: String): PedidoStore =
        api.send("POST", "pedido/store/pause", jsonBody("paused" to paused, "message" to message), key, PedidoStore.serializer())

    suspend fun menu(): PedidoMenu = api.get("pedido/menu", PedidoMenu.serializer())

    suspend fun setItemAvailable(itemId: String, available: Boolean, key: String): PedidoMenuItem =
        api.send("POST", "pedido/items/$itemId/availability", jsonBody("available" to available), key, PedidoMenuItem.serializer())

    suspend fun setOptionAvailable(groupId: String, optionId: String, available: Boolean, key: String): PedidoMenuGroup =
        api.send("POST", "pedido/groups/$groupId/availability", jsonBody("option_id" to optionId, "available" to available), key, PedidoMenuGroup.serializer())
}

/** Regras das telas do Pedido, sem tela, para testar. */
object PedidoRules {
    val ACTIVE = listOf("awaiting_payment", "received", "preparing", "ready", "out_for_delivery")
    val STATUSES = ACTIVE + listOf("delivered", "cancelled")
    val CLOSED = setOf("delivered", "cancelled")
    /** Larguras da comanda que o servidor monta. */
    val TICKET_COLUMNS = listOf(32, 42, 48)

    fun statusLabel(status: String): String = when (status) {
        "awaiting_payment" -> "Aguardando pagamento"
        "received" -> "Recebido"
        "preparing" -> "Em preparo"
        "ready" -> "Pronto para retirada"
        "out_for_delivery" -> "Saiu para entrega"
        "delivered" -> "Entregue"
        "cancelled" -> "Cancelado"
        else -> status
    }

    /** Título das colunas do quadro (plural, como no painel). */
    fun columnLabel(status: String): String = when (status) {
        "received" -> "Novos"
        "ready" -> "Prontos para retirada"
        "out_for_delivery" -> "Saíram para entrega"
        else -> statusLabel(status)
    }

    /** Um botão por próximo estado, com o que a pessoa faz; voltar um passo fica claro; cancelar por último. */
    fun actions(order: PedidoOrder): List<Pair<String, String>> {
        fun rank(s: String) = ACTIVE.indexOf(s).takeIf { it >= 0 } ?: 99
        val out = order.nextStatuses.filter { it != "cancelled" }.map { status ->
            val back = rank(status) < rank(order.state)
            status to when (status) {
                "received" -> if (back) "Voltar para novos" else "Enviar para o preparo"
                "preparing" -> if (back) "Voltar para o preparo" else "Começar preparo"
                "ready" -> "Pronto para retirada"
                "out_for_delivery" -> "Saiu para entrega"
                "delivered" -> "Entregue"
                else -> statusLabel(status)
            }
        }
        return if ("cancelled" in order.nextStatuses) out + ("cancelled" to "Cancelar pedido") else out
    }

    /** Registrar o pagamento recebido: não com cobrança online aberta (só o provedor confirma), nem pago, nem cancelado. */
    fun canMarkPaid(order: PedidoOrder): Boolean {
        val status = order.payment?.status ?: "pending"
        return status != "paid" && status != "awaiting" && order.state != "cancelled"
    }

    /** A equipe escolhe dinheiro ou maquininha enquanto o cliente não escolheu (ou a cobrança não foi gerada). */
    fun canChooseMethod(order: PedidoOrder): Boolean =
        order.state == "awaiting_payment" && order.payment?.status in setOf("choosing", "failed")

    val STAFF_METHODS = listOf("cash" to "Dinheiro", "card" to "Cartão na maquininha")

    /** Filtros da lista: em andamento, cada estado e todos. */
    val FILTERS: List<Pair<String, String>> = listOf("open" to "Em andamento") + STATUSES.map { it to statusLabel(it) } + ("all" to "Todos")

    /** Quantos em andamento numa página (chave ausente vale 0). */
    fun openCount(page: PedidoPage): Int = ACTIVE.sumOf { page.count(it) }

    /** "Bem passada, Bacon" de uma linha. */
    fun optionsText(line: PedidoLine): String? =
        line.options.mapNotNull { it.name?.takeIf(String::isNotBlank) }.takeIf { it.isNotEmpty() }?.joinToString(", ")

    /**
     * As linhas na ordem em que vieram, cada montagem (`item_id` + `slot`) na sua; quando o mesmo item tem mais de uma
     * montagem, cada uma ganha "montagem N" para a cozinha não juntar o que o cliente separou.
     */
    fun assemblies(order: PedidoOrder): List<Pair<PedidoLine, String?>> {
        val slotsPerItem = order.lines.groupBy { it.itemId ?: it.name.orEmpty() }.mapValues { (_, lines) -> lines.map { it.slot ?: 0 }.distinct().size }
        return order.lines.map { line ->
            val key = line.itemId ?: line.name.orEmpty()
            line to if ((slotsPerItem[key] ?: 0) > 1) "montagem ${(line.slot ?: 0) + 1}" else null
        }
    }

    /** "12 min" / "1 h 05" no estado. */
    fun elapsed(minutes: Int?): String? {
        val m = minutes ?: return null
        return if (m < 60) "$m min" else "${m / 60} h ${(m % 60).toString().padStart(2, '0')}"
    }

    /** Situação da loja para a faixa do quadro. */
    fun storeText(store: PedidoStore?): String = when {
        store == null -> ""
        store.paused == true -> "Loja pausada: não recebe pedidos agora"
        store.open == false -> "Loja fechada pelo horário"
        else -> "Loja aberta, recebendo pedidos"
    }

    /**
     * O que o cliente lê com a loja pausada. O quadro manda só `message` (o texto de pausa da loja com a mensagem da
     * equipe); `GET /pedido` e a resposta da pausa mandam também `pause_message`. Loja aberta: nada.
     */
    fun pauseText(store: PedidoStore?): String? {
        if (store?.paused != true) return null
        return listOf(store.pauseMessage, store.message)
            .map { it.orEmpty().trim().replace("\n\n", " · ") }
            .firstOrNull { it.isNotEmpty() }
    }

    /** As colunas da comanda que cabem na impressora: a maior entre 32, 42 e 48 que não passa da largura. */
    fun ticketColumns(printerColumns: Int): Int = TICKET_COLUMNS.sortedDescending().firstOrNull { it <= printerColumns } ?: 32

    fun historyText(h: PedidoHistory): String = when (h.kind) {
        "created" -> "Pedido criado"
        "payment" -> "Pagamento"
        "edit" -> "Dados alterados"
        else -> h.toStatus?.let(::statusLabel) ?: h.kind ?: "Alteração"
    }

    /** Quem fez a mudança, quando não é uma pessoa da equipe. */
    fun actorLabel(actor: String?): String? = when {
        actor == null -> null
        actor == "customer" -> "pelo cliente"
        actor == "provider" -> "pelo Mercado Pago"
        actor.startsWith("system") || actor == "module" -> "automático"
        else -> null
    }

    fun sourceLabel(source: String?): String = when (source) {
        "cart" -> "Carrinho pelo WhatsApp"
        "catalog" -> "Catálogo do WhatsApp"
        "panel" -> "Balcão"
        "api" -> "Integração"
        else -> source ?: "—"
    }

    /** Linha de pagamento do cartão: forma e situação. */
    fun paymentPill(order: PedidoOrder): String =
        if (order.payment?.status == "paid") "Pago" else order.payment?.methodLabel?.takeIf { it.isNotBlank() } ?: "Pagamento a definir"
}
