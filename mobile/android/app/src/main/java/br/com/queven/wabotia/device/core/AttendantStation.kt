package br.com.queven.wabotia.device.core

import br.com.queven.wabotia.printing.TicketPrint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/**
 * O balcão do atendente, como no V2: o mesmo modelo de tela e as mesmas
 * regras de botão. No V4 quem responde é o `vinki-core` (via
 * `EngineStationClient`), não mais o servidor HTTP.
 */
data class StationOption(
    val queueId: String,
    val optionId: String,
    val name: String,
    val available: Boolean,
    val waitingCount: Int,
    /** A estimativa de espera desta opção, em minutos; `null` sem histórico. */
    val estimatedWaitMinutes: Int? = null,
    /** A letra das senhas desta fila (o prefixo normal no Vinki); sem ela, a inicial do nome. */
    val letter: Char? = null,
)

data class StationCall(
    val ticketId: String,
    val publicNumber: String,
    val status: String,
    val stationLabel: String?,
    val version: Int,
    /** Quando a senha foi chamada; o painel põe a mais recente em destaque. */
    val calledAt: String? = null,
    /** Quantas rechamadas: cada uma faz o painel falar de novo. */
    val recalls: Int = 0,
    /** A fila atual da senha; a transferência oferece as outras. */
    val queueId: String? = null,
    /**
     * A posição em `chamadas_recentes` (0 = a última chamada ou rechamada). A
     * rechamada não muda `chamada_em`; só esta posição diz que ela é a mais nova.
     */
    val recentRank: Int? = null,
    /** `ultima_chamada_em`: a última chamada ou rechamada, para desempatar. */
    val lastCalledAt: String? = null,
)

data class StationRuntime(
    val displayName: String?,
    val actions: List<String>,
    val options: List<StationOption>,
    val calls: List<StationCall>,
    val waitingCount: Int,
    val estimatedWaitMinutes: Int?,
    /** Só há senhas reservadas a outro guichê ("1 reservada ao Guiche 5"); `null` sem aviso. */
    val reservedNote: String? = null,
    /** As campanhas do snapshot, para a área de campanha do painel (o cache filtra as vigentes). */
    val campaigns: List<br.com.queven.wabotia.device.core.Campaign> = emptyList(),
)

data class StationCallAction(val action: String, val label: String)

object StationCallActions {
    /**
     * Os botões de uma chamada. Em atendimento, "Continuar atendimento"
     * (`resume`) usa a permissão de iniciar; concluir é à parte.
     */
    fun offered(status: String, actions: List<String>): List<StationCallAction> {
        val all =
            if (status == "serving") {
                listOf(
                    StationCallAction("cancel", "Cancelar"),
                )
            } else {
                listOf(
                    StationCallAction("recall", "Rechamar"),
                    StationCallAction("start", "Iniciar"),
                    StationCallAction("no_show", "Não compareceu"),
                    StationCallAction("cancel", "Cancelar"),
                )
            }
        return all.filter { actions.contains(it.action) }
    }

    fun statusLabel(status: String): String =
        when (status) {
            "calling" -> "Chamando"
            "acknowledged" -> "A caminho"
            "serving" -> "Em atendimento"
            else -> "Situação não reconhecida"
        }
}

/** Uma operação do balcão; o adaptador a traduz no comando do contrato. */
data class StationOperation(
    /** `call_next`, `recall`, `start`, `no_show`, `cancel`, `complete`, `rate`, `transfer`. */
    val action: String,
    val ticketId: String? = null,
    val queueId: String? = null,
    val version: Int? = null,
    /** Destino da transferência para outro guichê. */
    val guiche: String? = null,
) {
    companion object {
        /** Decisão 15: a senha vai para outra fila, na ordem da emissão. */
        fun transferToQueue(ticketId: String, version: Int, queueId: String) =
            StationOperation("transfer", ticketId = ticketId, version = version, queueId = queueId)

        /** Decisão 15: a senha fica reservada a outro guichê. */
        fun transferToStation(ticketId: String, version: Int, guiche: String) =
            StationOperation("transfer", ticketId = ticketId, version = version, guiche = guiche.trim())

        fun callNext(queueId: String, optionId: String) = StationOperation("call_next", queueId = queueId)

        fun onCall(action: String, ticketId: String, version: Int) = StationOperation(action, ticketId = ticketId, version = version)

        fun complete(ticketId: String, version: Int) = StationOperation("complete", ticketId = ticketId, version = version)
    }
}

/** A falha de uma operação, já no código do contrato. */
class StationException(
    val failure: StationFailure,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

enum class StationFailure {
    /** A central revogou este aparelho, ou foi aposentada: não volta sozinho. */
    REVOKED,

    /** A central não respondeu; a tela segura a última leitura. */
    UNAVAILABLE,

    /** A central recusou (fila vazia, versão conflitante, transição inválida). */
    REJECTED,

    /** O balcão não tem guichê: chamar exige saber para onde a pessoa vai. */
    NEEDS_GUICHE,
}
