package br.com.queven.wabotia.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanelPinTest {
    @Test
    fun `o PIN do painel tem quatro digitos e nao e trivial`() {
        assertTrue(PanelPin.problem("2580") == null)
        assertEquals("O PIN tem 4 números.", PanelPin.problem("258"))
        assertEquals("O PIN tem 4 números.", PanelPin.problem("25a0"))
        assertEquals("Escolha um PIN menos óbvio.", PanelPin.problem("1111"))
        assertEquals("Escolha um PIN menos óbvio.", PanelPin.problem("1234"))
        assertEquals("Escolha um PIN menos óbvio.", PanelPin.problem("4321"))
    }

    @Test
    fun `guarda so o resumo com sal, e confere o PIN certo`() {
        val stored = PanelPin.seal("2580")
        assertFalse(stored.contains("2580"))
        assertNotEquals(stored, PanelPin.seal("2580"))
        assertTrue(PanelPin.matches("2580", stored))
        assertFalse(PanelPin.matches("2581", stored))
        assertFalse(PanelPin.matches("2580", "lixo"))
    }

    @Test
    fun `cinco erros seguidos travam por trinta segundos`() {
        var now = 1_000L
        val lock = PanelPinAttempts(clock = { now })
        repeat(4) { assertNull(lock.fail()) }
        assertEquals(31_000L, lock.fail())
        assertTrue(lock.locked())
        now = 31_000L
        assertFalse(lock.locked())
        lock.succeed()
        repeat(4) { assertNull(lock.fail()) }
    }
}
