package br.com.queven.wabotia.device.core

/*
 * Os poucos tipos do motor do Vinki que os quadros do painel ainda usam. No
 * Senhapp não há motor local: a fila mora no Vinki (docs/contrato/wabotia-fila.md).
 */

/** Uma campanha do painel. O Vinki ainda não envia campanhas; a lista fica vazia. */
data class Campaign(
    val campaignId: String,
    val origem: String,
    val criativo: String,
    val hash: String?,
    /** `valido_ate`. */
    val validade: String?,
    val titulo: String? = null,
    val inicio: String? = null,
    /** Quanto tempo fica na tela; `null`, o padrão do painel. */
    val duracaoS: Int? = null,
    val prioridade: Int = 0,
    /** `painel`, `emissor`, `pagina`, `app`; vazio vale para todas. */
    val superficies: List<String> = emptyList(),
)

/** Situações de pedido (quadro de retirada do Vinki); o Senhapp não mostra pedidos. */
enum class OrderState(val wire: String, val label: String) {
    RECEBIDO("recebido", "Recebido"),
    EM_PREPARO("em_preparo", "Em preparo"),
    PRONTO("pronto", "Pronto"),
    RETIRADO("retirado", "Retirado"),
    CANCELADO("cancelado", "Cancelado"),
    ;

    companion object {
        fun of(wire: String): OrderState? = entries.firstOrNull { it.wire == wire }
    }
}
