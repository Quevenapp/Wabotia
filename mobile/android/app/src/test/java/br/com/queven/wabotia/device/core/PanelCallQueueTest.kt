package br.com.queven.wabotia.device.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Painel: a tela acompanha a fala (docs/FILA-SENHAS.md; os mesmos casos de `tests/queue-call-queue.test.ts` do
 * servidor). Relógio virtual e anúncios terminados pelo teste.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PanelCallQueueTest {
    private fun call(code: String, ticket: String = code, desk: String? = "Guichê 1") = StationCall(ticket, code, "calling", desk, 1)

    private class Spoken(val code: String, val hurry: () -> Boolean, val done: CompletableDeferred<Unit>) {
        var short: Boolean? = null
    }

    /** O mesmo arranjo do teste do servidor: `finish` termina o anúncio em curso, `advance` anda o relógio. */
    private class Harness(test: TestScope) {
        private val scheduler = test.testScheduler
        val shown = mutableListOf<String?>()
        val spoken = mutableListOf<Spoken>()

        // Despachante imediato, como a thread principal do app: `push` começa o anúncio na hora.
        private val scope = CoroutineScope(test.backgroundScope.coroutineContext + UnconfinedTestDispatcher(scheduler))
        val queue = PanelCallQueue(
            scope = scope,
            announce = { c, hurry ->
                val done = CompletableDeferred<Unit>()
                spoken += Spoken(c.publicNumber, hurry, done)
                done.await()
            },
            show = { shown += it?.publicNumber },
            now = { scheduler.currentTime },
        )

        fun finish() {
            val current = spoken.last()
            current.short = current.hurry()
            current.done.complete(Unit)
            scheduler.runCurrent()
        }

        fun advance(ms: Long) {
            scheduler.advanceTimeBy(ms)
            scheduler.runCurrent()
        }
    }

    @Test
    fun `o destaque e a senha anunciada e a seguinte so entra quando a fala dela comeca`() = runTest {
        val h = Harness(this)
        h.queue.push(call("N001"))
        h.queue.push(call("N002"))
        h.queue.push(call("N003"))
        // Só a N001 na tela, falando; a N002 e a N003 esperam.
        assertEquals(listOf("N001"), h.shown)
        assertEquals(listOf("N001"), h.spoken.map { it.code })
        assertEquals(listOf("N002", "N003"), h.queue.pending.map { it.publicNumber })
        h.finish()
        assertEquals(listOf("N001", "N002"), h.shown)
        h.finish()
        h.finish()
        assertEquals(listOf("N001", "N002", "N003"), h.shown)
        // Com outras esperando, fala uma vez; a última, duas.
        assertEquals(listOf(true, true, false), h.spoken.map { it.short })
        // Acabou: o destaque fica 12 s e depois volta ao panorama.
        h.advance(PanelCallQueue.HOLD_MS - 1)
        assertEquals("N003", h.shown.last())
        h.advance(1)
        assertNull(h.shown.last())
    }

    @Test
    fun `rajada de 20 em 20 s fica com no maximo 3 esperando e a fala termina logo`() = runTest {
        val h = Harness(this)
        for (i in 1..20) {
            h.queue.push(call("N%03d".format(i)))
            assertTrue(h.queue.pending.size <= PanelCallQueue.CAP)
            h.advance(1000)
        }
        // A primeira ainda falando: as 3 mais novas esperam, as outras só ficam nas últimas chamadas.
        assertEquals(listOf("N018", "N019", "N020"), h.queue.pending.map { it.publicNumber })
        repeat(4) { h.finish() }
        assertEquals(listOf("N001", "N018", "N019", "N020"), h.shown)
    }

    @Test
    fun `espera longa demais nao e anunciada e a rechamada substitui a que espera`() = runTest {
        val h = Harness(this)
        h.queue.push(call("N001"))
        h.queue.push(call("N002"))
        h.queue.push(call("N002", ticket = "N002", desk = "Guichê 3"))
        assertEquals(listOf("N002"), h.queue.pending.map { it.publicNumber })
        // No mesmo lugar, com o guichê da rechamada.
        assertEquals("Guichê 3", h.queue.pending.single().stationLabel)
        h.queue.push(call("N003"))
        h.advance(PanelCallQueue.STALE_MS + 1)
        h.queue.push(call("N004"))
        h.finish()
        // N002 e N003 passaram de 30 s esperando: vai direto para a N004.
        assertEquals(listOf("N001", "N004"), h.shown)
    }

    @Test
    fun `nova chamada durante o destaque final cancela a volta ao panorama`() = runTest {
        val h = Harness(this)
        h.queue.push(call("N001"))
        h.finish()
        h.advance(5000)
        h.queue.push(call("N002"))
        h.advance(PanelCallQueue.HOLD_MS)
        assertEquals(listOf("N001", "N002"), h.shown)
    }

    @Test
    fun `o painel fechado cala a espera e nao volta sozinho ao panorama`() = runTest {
        val h = Harness(this)
        h.queue.push(call("N001"))
        h.queue.push(call("N002"))
        h.queue.clear()
        h.advance(PanelCallQueue.HOLD_MS * 2)
        assertEquals(listOf("N001"), h.shown)
        assertTrue(h.queue.pending.isEmpty())
        // Depois de limpa, a fila volta a anunciar.
        h.queue.push(call("N003"))
        assertEquals(listOf("N001", "N003"), h.shown)
    }

    /** O som do aparelho no relógio virtual: cada fala leva 2 s. */
    private class FakeAudio(private val voice: Boolean = true) : PanelCallAudio {
        val log = mutableListOf<String>()

        override fun chime() {
            log += "gongo"
        }

        override fun speak(text: String) {
            log += "speak:$text"
        }

        override suspend fun say(text: String): Boolean {
            if (!voice) return false
            log += text
            delay(2000)
            return true
        }

        override fun stop() = Unit
    }

    private fun TestScope.timed(block: suspend () -> Unit): Long {
        val start = testScheduler.currentTime
        var end = -1L
        launch {
            block()
            end = testScheduler.currentTime
        }
        testScheduler.advanceUntilIdle()
        return end - start
    }

    @Test
    fun `anuncio sozinho e sinal e a fala duas vezes`() = runTest {
        val audio = FakeAudio()
        val took = timed { PanelCallQueue.speak(call("N007"), { false }, audio) { true } }
        assertEquals(listOf("gongo", "Senha N 7. Guichê 1.", "Senha N 7. Guichê 1."), audio.log)
        assertEquals(PanelCallQueue.CHIME_MS + 4000, took)
    }

    @Test
    fun `com outras esperando ao fim da primeira fala a fala nao se repete`() = runTest {
        val audio = FakeAudio()
        val took = timed { PanelCallQueue.speak(call("N007"), { true }, audio) { true } }
        assertEquals(listOf("gongo", "Senha N 7. Guichê 1."), audio.log)
        assertEquals(PanelCallQueue.CHIME_MS + 2000, took)
    }

    @Test
    fun `sem som cada chamada fica 4 s no destaque, calada`() = runTest {
        val audio = FakeAudio()
        val took = timed { PanelCallQueue.speak(call("N007"), { false }, audio) { false } }
        assertTrue(audio.log.isEmpty())
        assertEquals(PanelCallQueue.SILENT_MS, took)
    }

    @Test
    fun `sem voz no aparelho o sinal toca e o destaque fica 4 s`() = runTest {
        val audio = FakeAudio(voice = false)
        val took = timed { PanelCallQueue.speak(call("N007"), { false }, audio) { true } }
        assertEquals(listOf("gongo"), audio.log)
        assertEquals(PanelCallQueue.SILENT_MS, took)
    }

    @Test
    fun `sem som, tres chamadas seguidas passam 4 s cada, na mesma ordem`() = runTest {
        val shown = mutableListOf<Pair<Long, String?>>()
        // Termina sozinha (sem som, 4 s cada, e o destaque final): roda no escopo do teste, que espera por ela.
        val scope = CoroutineScope(coroutineContext + UnconfinedTestDispatcher(testScheduler))
        val audio = FakeAudio()
        val queue = PanelCallQueue(
            scope = scope,
            announce = { c, hurry -> PanelCallQueue.speak(c, hurry, audio) { false } },
            show = { shown += testScheduler.currentTime to it?.publicNumber },
            now = { testScheduler.currentTime },
        )
        listOf("N001", "N002", "N003").forEach { queue.push(call(it)) }
        testScheduler.advanceUntilIdle()
        assertEquals(
            listOf(0L to "N001", 4000L to "N002", 8000L to "N003", 12_000L + PanelCallQueue.HOLD_MS to null),
            shown,
        )
    }

    @Test
    fun `o bloco grande segue o destaque e as anteriores seguem o snapshot`() {
        val snapshot = listOf(
            StationCall("3", "N003", "calling", "Guichê 1", 1, recentRank = 0),
            StationCall("2", "N002", "calling", "Guichê 1", 1, recentRank = 1),
            StationCall("1", "N001", "calling", "Guichê 1", 1, recentRank = 2),
        )
        val announcing = snapshot.last()
        assertEquals("N001", PanelCalls.hero(snapshot, announcing)?.publicNumber)
        assertEquals(listOf("N003", "N002"), PanelCalls.previous(snapshot, announcing, 3).map { it.publicNumber })
        // Sem destaque (fim dos 12 s): volta à última chamada do snapshot.
        assertEquals("N003", PanelCalls.hero(snapshot, null)?.publicNumber)
        assertEquals(listOf("N002", "N001"), PanelCalls.previous(snapshot, null, 3).map { it.publicNumber })
    }
}
