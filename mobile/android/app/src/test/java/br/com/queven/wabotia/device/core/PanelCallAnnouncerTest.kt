package br.com.queven.wabotia.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O som do painel, a TV e a tela acesa, portados do app QRSenha
 * (`core/panel/PanelCallAnnouncer.kt`, `PanelScreenWakePolicy.kt` e o filtro
 * de `CurrentCallsCard`): o painel fala só a chamada nova, cala na rajada, lê
 * a senha como se fala no balcão e não recita o passado ao abrir.
 */
class PanelCallAnnouncerTest {
    private fun call(
        id: String,
        number: String,
        status: String = "calling",
        calledAt: String? = "2026-09-25T12:00:0$id.000Z",
        desk: String? = "Guichê 2",
    ) = StationCall(id, number, status, desk, 1, calledAt)

    @Test
    fun `a primeira leitura so marca, e as chamadas antigas nao sao faladas`() {
        val announcer = PanelCallAnnouncer()
        val first = announcer.announce(listOf(call("1", "A001"), call("2", "A002")))
        assertFalse(first.chime)
        assertTrue(first.spoken.isEmpty())
        assertTrue(announcer.primed)
        // A mesma leitura de novo continua calada.
        assertFalse(announcer.announce(listOf(call("1", "A001"), call("2", "A002"))).chime)
    }

    @Test
    fun `so a chamada nova e falada, com o gongo`() {
        val announcer = PanelCallAnnouncer()
        announcer.prime(listOf(call("1", "A001")))
        val next = announcer.announce(listOf(call("3", "A024"), call("1", "A001")))
        assertTrue(next.chime)
        assertEquals(listOf("Senha A 24. Guichê 2."), next.spoken)
    }

    @Test
    fun `em atendimento ou a caminho nao se anuncia`() {
        val announcer = PanelCallAnnouncer()
        announcer.prime(emptyList())
        val quiet = announcer.announce(listOf(call("1", "A001", "serving"), call("2", "A002", "acknowledged")))
        assertFalse(quiet.chime)
    }

    @Test
    fun `a rechamada muda a hora e volta a ser falada`() {
        val announcer = PanelCallAnnouncer()
        announcer.prime(listOf(call("1", "A001", calledAt = "2026-09-25T12:00:00.000Z")))
        val recalled = announcer.announce(listOf(call("1", "A001", calledAt = "2026-09-25T12:03:00.000Z")))
        assertEquals(listOf("Senha A 1. Guichê 2."), recalled.spoken)
    }

    @Test
    fun `no maximo tres falas por ciclo, as mais recentes, na ordem da chamada`() {
        val announcer = PanelCallAnnouncer()
        announcer.prime(emptyList())
        // O servidor manda a mais recente primeiro.
        val calls = (5 downTo 1).map { call("$it", "A00$it", desk = null) }
        val announcement = announcer.announce(calls)
        assertTrue(announcement.chime)
        assertEquals(listOf("Senha A 3.", "Senha A 4.", "Senha A 5."), announcement.spoken)
    }

    @Test
    fun `a rajada de oito ou mais toca o gongo e nao fala`() {
        val announcer = PanelCallAnnouncer()
        announcer.prime(emptyList())
        val burst = announcer.announce((1..8).map { call("$it", "A00$it") })
        assertTrue(burst.chime)
        assertTrue(burst.spoken.isEmpty())
        // Sete ainda fala (as três mais recentes).
        val seven = PanelCallAnnouncer().apply { prime(emptyList()) }.announce((1..7).map { call("$it", "B00$it") })
        assertEquals(3, seven.spoken.size)
    }

    @Test
    fun `a senha se le como no balcao`() {
        assertEquals("A 24", PanelCallAnnouncer.spokenTicketNumber("A024"))
        assertEquals("P 0", PanelCallAnnouncer.spokenTicketNumber("P000"))
        assertEquals("A B 7", PanelCallAnnouncer.spokenTicketNumber("ab007"))
        // Fora do formato, a senha vai como veio.
        assertEquals("24-A", PanelCallAnnouncer.spokenTicketNumber("24-A"))
        assertEquals("Senha A 24.", PanelCallAnnouncer.announcementText(call("1", "A024", desk = "  ")))
    }

    @Test
    fun `a TV mostra so quem esta sendo chamado ou a caminho, a mais recente primeiro`() {
        val calls =
            listOf(
                call("1", "A001", "serving", "2026-09-25T12:09:00.000Z"),
                call("2", "A002", "calling", "2026-09-25T12:05:00.000Z"),
                call("3", "A003", "acknowledged", "2026-09-25T12:07:00.000Z"),
            )
        assertEquals(listOf("A003", "A002"), PanelCalls.onScreen(calls).map { it.publicNumber })
        assertTrue(PanelCalls.onScreen(listOf(call("1", "A001", "serving"))).isEmpty())
    }

    @Test
    fun `a tela acesa volta ao valor de antes em segundo plano e ao sair`() {
        val applied = mutableListOf<Boolean>()
        val policy = PanelScreenWakePolicy(originalValue = false, applyValue = { applied += it })
        policy.onForeground()
        policy.onBackground()
        policy.onForeground()
        policy.close()
        // Fechada, a política não mexe mais na tela.
        policy.onForeground()
        policy.close()
        assertEquals(listOf(true, false, true, false), applied)
    }
}
