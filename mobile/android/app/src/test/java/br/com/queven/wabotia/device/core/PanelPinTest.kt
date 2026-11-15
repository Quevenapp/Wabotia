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

    @Test
    fun `aceita PIN de seis digitos`() {
        assertNull(PanelPin.problem("258036"))
        assertEquals("O PIN tem 6 números.", PanelPin.problem("25803"))
        assertEquals("O PIN tem 6 números.", PanelPin.problem("2580361"))
        assertEquals("Escolha um PIN menos óbvio.", PanelPin.problem("000000"))
        assertEquals("Escolha um PIN menos óbvio.", PanelPin.problem("123456"))
        assertEquals("Escolha um PIN menos óbvio.", PanelPin.problem("987654"))
        val stored = PanelPin.seal("258036")
        assertTrue(PanelPin.matches("258036", stored))
        assertFalse(PanelPin.matches("2580", stored))
    }

    @Test
    fun `erros e trava sobrevivem a reabrir o app`() {
        var now = 1_000L
        val disk = MemoryPanelPinAttemptStore()
        repeat(3) { assertNull(PanelPinAttempts(disk, clock = { now }).fail()) }
        // O app foi fechado e reaberto: a contagem continua de onde parou.
        val reopened = PanelPinAttempts(disk, clock = { now })
        assertNull(reopened.fail())
        assertEquals(31_000L, reopened.fail())
        assertTrue(PanelPinAttempts(disk, clock = { now }).locked())
        now = 11_000L
        assertEquals(20_000L, PanelPinAttempts(disk, clock = { now }).remainingMillis())
        assertEquals("Aguarde 20 segundos.", PanelPinAttempts.waitText(20_000L))
    }

    @Test
    fun `cada trava seguida espera mais, e um acerto zera`() {
        var now = 0L
        val disk = MemoryPanelPinAttemptStore()
        val lock = PanelPinAttempts(disk, clock = { now })
        val waits = listOf(30_000L, 60_000L, 300_000L, 900_000L, 3_600_000L, 3_600_000L)
        waits.forEach { wait ->
            repeat(4) { assertNull(lock.fail()) }
            assertEquals(now + wait, lock.fail())
            now += wait
            assertFalse(lock.locked())
        }
        assertEquals(6, disk.lockouts)
        lock.succeed()
        assertEquals(0, disk.lockouts)
        assertEquals(0, disk.failures)
        repeat(4) { lock.fail() }
        assertEquals(now + 30_000L, lock.fail())
        assertEquals("Aguarde 1 minuto.", PanelPinAttempts.waitText(60_000L))
        assertEquals("Aguarde 5 minutos.", PanelPinAttempts.waitText(4 * 60_000L + 1))
        assertEquals("Aguarde 1 segundo.", PanelPinAttempts.waitText(1))
    }
}
