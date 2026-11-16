package br.com.queven.wabotia.printing

import br.com.queven.wabotia.modules.Establishment
import br.com.queven.wabotia.queue.QueueCoupon
import br.com.queven.wabotia.queue.QueueTicket
import br.com.thermalprinterkit.ReceiptLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Nada que a página de código da impressora não imprime chega ao papel (o "?" do cupom N004, 16/11). */
class PaperTextTest {
    @Test fun separadorDaPosicaoDoCupomN004() {
        assertEquals("2 pessoas à sua frente - cerca de 8 min", PaperText.clean("2 pessoas à sua frente · cerca de 8 min"))
    }

    @Test fun rodapeComEmoji() {
        assertEquals("Obrigado pela visita! Volte sempre", PaperText.clean("Obrigado pela visita! 😊 Volte sempre 👍🏽"))
        assertEquals("Boa consulta", PaperText.clean("❤️ Boa consulta ✨"))
        // Bandeira e família (sequências com ZWJ) somem inteiras.
        assertEquals("Equipe", PaperText.clean("Equipe 🇧🇷 👨‍👩‍👧"))
    }

    @Test fun mantemAcentosCedilhaEOrdinais() {
        val text = "Ação, açaí, pão, avó, João, ÉRICA, Ônibus, Útil, 1ª e 2º"
        assertEquals(text, PaperText.clean(text))
    }

    @Test fun pontuacaoTipograficaViraAscii() {
        assertEquals("\"Centro\" - 'aberto'... R\$ 10 x 2", PaperText.clean("“Centro” — ‘aberto’… R\$ 10 × 2"))
        assertEquals("Rua A, 100 - Centro\nCidade/SP", PaperText.clean("Rua A, 100 – Centro\nCidade/SP"))
        assertEquals("Sala 2º andar", PaperText.clean("Sala 2° andar"))
        // Espaço sem quebra e espaços finos viram espaço comum.
        assertEquals("R\$ 10,00", PaperText.clean("R\$ 10,00"))
        // Letra de outra língua: só a base.
        assertEquals("Pena Muller", PaperText.clean("Peña Müller").replace("ü", "u"))
        assertEquals("Pena", PaperText.clean("Peña"))
    }

    @Test fun colunasMantemOsEspacos() {
        assertEquals("1x X-Burger     R\$ 25,00", PaperText.clean("1x X-Burger     R\$ 25,00", tidy = false))
        assertEquals("  obs: sem cebola - bem passado", PaperText.clean("  obs: sem cebola · bem passado", tidy = false))
    }

    @Test fun cupomComTextoLivreSaiSemInterrogacao() {
        val ticket = QueueTicket(id = "t1", code = "N004", queueName = "Geral", ahead = 2, waitMinutes = 8, createdAt = 1_794_831_660_000)
        val coupon = QueueCoupon(
            establishment = Establishment(
                name = "Centro Exemplo de Serviços ✂️",
                documentType = "cnpj",
                documentDisplay = "11.222.333/0001-81",
                address = "Rua Exemplo, 100 — Centro\nCidade Exemplo/SP",
                phone = "(20) 3000-1234",
            ),
            footer = "Guarde este cupom até ser chamado… Obrigado pela visita! 🙏",
        )
        val layout = ReceiptLayout(columns = 32, qrWidthDots = 240, hasCutter = false)
        val bytes = SenhaTicketReceipt(CouponData.of(ticket, "Recepcao X230", null, coupon)).receiptBytes(layout)
        val text = String(bytes, Charsets.ISO_8859_1)
        val printable = text.filter { it == '\n' || it.code in 0x20..0x7E }
        assertFalse("nenhum caractere vira ?: $printable", text.contains('?'))
        // A posição quebra em 32 colunas: "...frente - cerca" / "de 8 min".
        assertTrue(printable, printable.contains("frente - cerca"))
        assertTrue(printable, printable.contains("100 - Centro"))
        assertTrue(printable, printable.contains("chamado..."))
    }
}
