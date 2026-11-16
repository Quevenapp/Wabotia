package br.com.queven.wabotia.device.core

import br.com.queven.wabotia.device.core.OrderState

/**
 * Os pedidos na tela de acompanhamentos do V2. No V4 cada acompanhamento é um
 * `pedido` do contrato (`recebido` → `em_preparo` → `pronto` → `retirado`).
 * O painel de pedidos só lê; o gerente move.
 */
data class Tracking(
    val id: String,
    val publicTitle: String,
    val externalReference: String,
    val status: String,
    val allowedTransitions: List<String>,
    val timeInStatusSeconds: Int,
    val overdue: Boolean,
    val version: Int,
)

/**
 * O quadro de retirada no painel (decisão 14): os códigos em preparo
 * (recebido e em preparo) e os prontos, na ordem em que chegaram.
 */
data class OrderBoard(val preparing: List<String>, val ready: List<String>) {
    companion object {
        fun of(trackings: List<Tracking>): OrderBoard =
            OrderBoard(
                preparing = trackings.filter { it.status == "recebido" || it.status == "em_preparo" }.map { it.publicTitle },
                ready = trackings.filter { it.status == "pronto" }.map { it.publicTitle },
            )
    }
}

/** Os rótulos de balcão da situação e da transição de um pedido. */
object TrackingLabels {
    fun status(value: String): String = OrderState.of(value)?.label ?: "Situação não reconhecida"

    /** O verbo do botão que leva à situação: "dá para falar em voz alta no balcão". */
    fun transition(toStatus: String): String =
        when (toStatus) {
            "em_preparo" -> "Começar o preparo"
            "pronto" -> "Marcar pronto"
            "retirado" -> "Entregue"
            "cancelado" -> "Cancelar"
            else -> status(toStatus)
        }

    /** "agora mesmo" ou "há 2 min": a frase inteira, sem "há agora". */
    fun since(seconds: Int): String = if (seconds < 60) "agora mesmo" else "há ${elapsed(seconds)}"

    fun elapsed(seconds: Int): String =
        when {
            seconds < 60 -> "agora"
            seconds < 3600 -> "${seconds / 60} min"
            else -> "${seconds / 3600} h ${(seconds % 3600) / 60} min"
        }
}

interface OperationApiClient {
    suspend fun trackings(): List<Tracking>

    suspend fun transition(trackingId: String, toStatus: String, expectedVersion: Int)
}
