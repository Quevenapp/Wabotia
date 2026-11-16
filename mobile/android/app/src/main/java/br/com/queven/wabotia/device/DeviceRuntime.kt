package br.com.queven.wabotia.device

import br.com.queven.wabotia.device.core.StationCall
import br.com.queven.wabotia.device.core.StationOption
import br.com.queven.wabotia.device.core.StationRuntime
import br.com.queven.wabotia.queue.CallFrame
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.QueueOverview
import br.com.queven.wabotia.queue.QueueTicket
import kotlinx.coroutines.delay

/*
 * A ponte entre o contrato da fila e os quadros do painel que vieram do Senhapp (que vieram do Vinki): os quadros leem
 * `StationRuntime`; o Wabotia manda `QueueOverview`. Sem Android, para ser testado na JVM.
 */

/** O formato dos quadros do painel, já como "chamando". */
fun CallFrame.toStationCall(rank: Int? = null) =
    StationCall(
        ticketId = ticketId,
        publicNumber = code,
        status = "calling",
        stationLabel = counterName,
        version = callCount,
        calledAt = at.toString(),
        recalls = (callCount - 1).coerceAtLeast(0),
        queueId = queueId,
        recentRank = rank,
        lastCalledAt = at.toString(),
    )

/** Totem, chamada e híbrido leem este formato. O totem só oferece filas ativas com o canal `kiosk`. */
fun QueueOverview.toRuntime(displayName: String?): StationRuntime {
    val kiosk = queues.orEmpty().filter { it.kiosk }
    return StationRuntime(
        displayName = displayName,
        actions = emptyList(),
        options = kiosk.map { q ->
            StationOption(
                queueId = q.id,
                optionId = q.id,
                name = q.name,
                available = true,
                waitingCount = q.waiting?.total ?: 0,
                estimatedWaitMinutes = q.waitMinutes?.normal,
                // A letra e a cor do quadrado são as das senhas que a fila emite (N001 → N), como no painel.
                letter = q.prefixNormal?.firstOrNull { it.isLetter() }?.uppercaseChar(),
            )
        },
        calls = recentCalls.orEmpty().mapIndexed { i, call -> call.toStationCall(i) },
        waitingCount = kiosk.sumOf { it.waiting?.total ?: 0 },
        estimatedWaitMinutes = kiosk.mapNotNull { it.waitMinutes?.normal }.maxOrNull(),
    )
}

/**
 * Emite a senha do totem. Uma queda de rede (ou erro 5xx) repete uma vez com a **mesma** `Idempotency-Key`: o Wabotia
 * devolve a mesma senha em vez de emitir outra. Recusa do contrato (`kiosk_rate`, `queue_closed`…) não repete. Se as
 * duas falharem, [TotemIssueKeys] guarda a chave para o próximo toque.
 */
suspend fun issueOnce(
    client: QueueClient,
    queueId: String,
    preferential: Boolean,
    key: String = QueueClient.newKey(),
    pauseMs: Long = 1500,
): QueueTicket =
    try {
        client.issue(queueId, preferential, key)
    } catch (e: QueueException) {
        if (!e.retryable) throw e
        delay(pauseMs)
        client.issue(queueId, preferential, key)
    }

/** O pedido de senha que ficou sem resposta definitiva: fila, tipo, a `Idempotency-Key` usada e quando foi feito. */
data class PendingIssue(val queueId: String, val preferential: Boolean, val key: String, val at: Long)

/**
 * A chave da emissão do totem, guardada entre toques. Se a emissão falha por rede (ou 5xx) mesmo depois da repetição
 * de [issueOnce], o servidor pode ter gravado a senha: um toque novo com outra chave emitiria uma segunda, e a primeira
 * ficaria na fila sem dono (o painel chamaria uma senha que ninguém tem). Por isso o pedido incerto fica guardado, e o
 * próximo toque na mesma fila e no mesmo tipo, dentro de [windowMs], repete a mesma chave: o Wabotia devolve a senha
 * que já gravou. Sucesso ou recusa do contrato (`queue_closed`, `kiosk_rate`…) liberam a chave.
 */
class TotemIssueKeys(
    private val windowMs: Long = WINDOW_MS,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newKey: () -> String = { QueueClient.newKey() },
) {
    var pending: PendingIssue? = null
        private set

    /** A chave deste toque: a do pedido incerto, quando é a mesma fila e o mesmo tipo e ainda está no prazo. */
    fun key(queueId: String, preferential: Boolean): String {
        val now = clock()
        pending?.let { p ->
            if (p.queueId == queueId && p.preferential == preferential && now - p.at in 0..windowMs) return p.key
        }
        return newKey().also { pending = PendingIssue(queueId, preferential, it, now) }
    }

    /** Depois da resposta: só uma falha incerta (rede, 5xx, `operation_unknown`) guarda o pedido. */
    fun settle(error: Throwable?) {
        if (error is QueueException && error.retryable) return
        if (error != null && error !is QueueException) return
        pending = null
    }

    companion object {
        /** Alguns minutos: quem tocou e não recebeu a senha costuma tentar de novo logo. */
        const val WINDOW_MS = 5 * 60_000L
    }
}

/** O tempo que o cartão da senha fica no totem: menos com o cupom na mão, mais sem papel (para fotografar). */
fun issuedCardMillis(printed: Boolean): Long = if (printed) 20_000 else 60_000
