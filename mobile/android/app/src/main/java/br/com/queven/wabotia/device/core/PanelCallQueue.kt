package br.com.queven.wabotia.device.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A fila de anúncios do painel: a tela acompanha a fala (docs/FILA-SENHAS.md, "Painel: a tela acompanha a fala"; o
 * mesmo que `web/queue/call-queue.ts`). Numa rajada, o destaque é sempre a senha que está sendo anunciada; a seguinte
 * só toma o destaque quando o anúncio dela começa. O resto do painel (anteriores, pedidos) segue o `snapshot`, fora
 * daqui.
 *
 * 1. Uma chamada por vez: [announce] toca o sinal e fala; `hurry()` diz se há outras esperando (perguntado antes de
 *    repetir a fala).
 * 2. No máximo [cap] esperando: chegou mais uma, sai a mais antiga da espera (fica só nas últimas chamadas).
 * 3. Esperando há mais de [staleMs] desde que chegou: não é anunciada.
 * 4. Rechamada de uma senha que ainda espera substitui a anterior, no mesmo lugar.
 * 5. Acabou a fila: o último anunciado fica em destaque por [holdMs] e então [show] recebe `null` (volta à última
 *    chamada do `snapshot`).
 *
 * Tudo roda no mesmo despachante (a thread principal no app; o relógio virtual nos testes).
 */
class PanelCallQueue(
    private val scope: CoroutineScope,
    private val announce: suspend (call: StationCall, hurry: () -> Boolean) -> Unit,
    private val show: (StationCall?) -> Unit,
    private val now: () -> Long,
    private val cap: Int = CAP,
    private val staleMs: Long = STALE_MS,
    private val holdMs: Long = HOLD_MS,
) {
    private class Waiting(val call: StationCall, val at: Long)

    private val waiting = ArrayDeque<Waiting>()
    private var runner: Job? = null
    private var hold: Job? = null

    /** Senhas esperando a vez de ser anunciadas (sem a atual). */
    val pending: List<StationCall> get() = waiting.map { it.call }

    fun push(call: StationCall) {
        val entry = Waiting(call, now())
        val same = waiting.indexOfFirst { it.call.ticketId == call.ticketId }
        if (same >= 0) waiting[same] = entry else waiting.addLast(entry)
        while (waiting.size > cap) waiting.removeFirst()
        if (runner?.isActive != true) runner = scope.launch { run() }
    }

    /** Painel fechado ou fora do papel de painel: cala e esquece a espera, sem voltar ao panorama sozinho. */
    fun clear() {
        waiting.clear()
        runner?.cancel()
        runner = null
        hold?.cancel()
        hold = null
    }

    private suspend fun run() {
        while (true) {
            val next = waiting.removeFirstOrNull() ?: break
            if (now() - next.at > staleMs) continue
            hold?.cancel()
            hold = null
            show(next.call)
            try {
                announce(next.call) { waiting.isNotEmpty() }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Sem voz: segue para a próxima.
            }
        }
        hold = scope.launch {
            delay(holdMs)
            hold = null
            show(null)
        }
    }

    companion object {
        const val CAP = 3
        const val STALE_MS = 30_000L
        const val HOLD_MS = 12_000L

        /** Sem som (ou sem voz no aparelho), cada chamada fica este tempo no destaque. */
        const val SILENT_MS = 4_000L

        /** Do sinal ao começo da fala: o gongo não se sobrepõe à voz. */
        const val CHIME_MS = 600L

        /**
         * Um anúncio: sinal e a fala duas vezes; se, ao fim da primeira, houver outras esperando, a fala não se repete.
         * Sem som, ou quando o aparelho não fala (sem voz em português, motor desligado), [SILENT_MS] no destaque.
         */
        suspend fun speak(call: StationCall, hurry: () -> Boolean, audio: PanelCallAudio, soundOn: () -> Boolean) {
            if (!soundOn()) {
                delay(SILENT_MS)
                return
            }
            val text = PanelCallAnnouncer.announcementText(call)
            audio.chime()
            delay(CHIME_MS)
            if (!audio.say(text)) {
                delay(SILENT_MS - CHIME_MS)
                return
            }
            if (!hurry() && soundOn()) audio.say(text)
        }
    }
}
