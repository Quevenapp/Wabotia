package br.com.queven.wabotia.device.core

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * As regras puras dos painéis redesenhados (31/10/2026): o catálogo dos cinco
 * templates escolhidos no aparelho, a divisão do destino em rótulo e número
 * e a hora local das chamadas anteriores.
 */
class PanelTemplateTest {
    @Test
    fun `os cinco templates têm identificador estável e nome em português`() {
        assertEquals(listOf("sinal", "clinica", "terminal", "vitrine", "sol"), PanelTemplate.entries.map { it.id })
        assertEquals(listOf("Sinal", "Clínica", "Terminal", "Vitrine", "Sol"), PanelTemplate.entries.map { it.label })
    }

    @Test
    fun `identificador desconhecido ou ausente cai no padrão`() {
        assertEquals(PanelTemplate.TERMINAL, PanelTemplate.fromId("terminal"))
        assertEquals(PanelTemplate.DEFAULT, PanelTemplate.fromId("balcao"))
        assertEquals(PanelTemplate.DEFAULT, PanelTemplate.fromId(null))
        assertEquals(PanelTemplate.SINAL, PanelTemplate.DEFAULT)
    }

    @Test
    fun `a loja em memória guarda um template por aparelho`() {
        val store = InMemoryPanelTemplateStore()
        assertEquals(PanelTemplate.DEFAULT, store.template("a"))
        store.setTemplate("a", PanelTemplate.VITRINE)
        assertEquals(PanelTemplate.VITRINE, store.template("a"))
        assertEquals(PanelTemplate.DEFAULT, store.template("b"))
    }

    @Test
    fun `destino com número curto no fim separa rótulo e número`() {
        assertEquals(PanelDestination.Parts("Guichê", "3", long = false), PanelDestination.split("Guichê 3"))
        assertEquals(PanelDestination.Parts("Sala", "12", long = false), PanelDestination.split("  Sala 12 "))
        assertEquals(PanelDestination.Parts("Mesa", "4B", long = false), PanelDestination.split("Mesa 4B"))
    }

    @Test
    fun `destino sem número vira valor inteiro com rótulo de direção`() {
        assertEquals(PanelDestination.Parts("Dirija-se ao", "Balcão", long = true), PanelDestination.split("Balcão"))
        assertEquals(
            PanelDestination.Parts("Dirija-se ao", "Caixa preferencial", long = true),
            PanelDestination.split("Caixa preferencial"),
        )
        assertEquals(PanelDestination.Parts("Dirija-se ao", "Balcão", long = true), PanelDestination.split(null))
        assertEquals(PanelDestination.Parts("Dirija-se ao", "Balcão", long = true), PanelDestination.split("  "))
        // Número sozinho fica curto: o painel o mostra grande.
        assertFalse(PanelDestination.split("3").long)
        // Palavra longa no fim não é número de guichê.
        assertTrue(PanelDestination.split("Guichê preferencial").long)
    }

    @Test
    fun `a letra da fila vem do começo da senha`() {
        assertEquals('B', PanelQueueLetter.of("B042"))
        assertEquals('A', PanelQueueLetter.of("a001"))
        assertNull(PanelQueueLetter.of("128"))
        assertNull(PanelQueueLetter.of(""))
    }

    @Test
    fun `filas comuns do balcão não dividem a cor`() {
        val common = listOf('A', 'G', 'C', 'P').map(PanelQueueLetter::colorIndex)
        assertEquals(listOf(0, 1, 2, 3), common)
        assertEquals(PanelQueueLetter.colorIndex('g'), PanelQueueLetter.colorIndex('G'))
        assertEquals('Z'.code % 4, PanelQueueLetter.colorIndex('Z'))
        assertEquals(0, PanelQueueLetter.colorIndex(null))
    }

    @Test
    fun `a hora da chamada aparece no fuso do aparelho`() {
        val saoPaulo = ZoneId.of("America/Sao_Paulo")
        assertEquals("09:42", PanelClock.hhmm("2026-10-31T12:42:00Z", saoPaulo))
        assertEquals("09:42", PanelClock.hhmm("2026-10-31T09:42:10-03:00", saoPaulo))
        assertNull(PanelClock.hhmm(null, saoPaulo))
        assertNull(PanelClock.hhmm("ontem", saoPaulo))
    }
}
