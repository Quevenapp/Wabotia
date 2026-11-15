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
            )
        },
        calls = recentCalls.orEmpty().mapIndexed { i, call -> call.toStationCall(i) },
        waitingCount = kiosk.sumOf { it.waiting?.total ?: 0 },
        estimatedWaitMinutes = kiosk.mapNotNull { it.waitMinutes?.normal }.maxOrNull(),
    )
}

/**
 * Emite a senha do totem. Uma queda de rede (ou erro 5xx) repete uma vez com a **mesma** `Idempotency-Key`: o Wabotia
 * devolve a mesma senha em vez de emitir outra. Recusa do contrato (`kiosk_rate`, `queue_closed`…) não repete.
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

/** O tempo que o cartão da senha fica no totem: menos com o cupom na mão, mais sem papel (para fotografar). */
fun issuedCardMillis(printed: Boolean): Long = if (printed) 20_000 else 60_000
