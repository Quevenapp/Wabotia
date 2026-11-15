package br.com.queven.wabotia.printing

import br.com.thermalprinterkit.ReceiptLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O cupom do totem. O texto sai em ESC/POS; o teste lê os bytes como Latin-1
 * para achar o que foi escrito (o número em corpo triplo continua legível).
 */
class SenhaTicketReceiptTest {
    private val portable58mm = ReceiptLayout(columns = 32, qrWidthDots = 240, hasCutter = false)

    private fun data(preferential: Boolean = false, ahead: Int = 3, link: String? = "https://wa.me/5511999998888?text=SENHA%20P012%20AB12CD") =
        CouponData(
            header = "Clínica Central",
            queueName = "Atendimento geral",
            code = if (preferential) "P012" else "N012",
            preferential = preferential,
            // 14/11/2026 13:05 em Brasília.
            issuedAt = 1_794_672_300_000,
            ahead = ahead,
            waitMinutes = 25,
            whatsappLink = link,
        )

    @Test
    fun `o cupom leva empresa, fila, tipo, numero, hora e posicao`() {
        val text = String(SenhaTicketReceipt(data(preferential = true)).receiptBytes(portable58mm), Charsets.ISO_8859_1)
        assertTrue(text.contains("Central"))
        assertTrue(text.contains("Atendimento geral"))
        assertTrue(text.contains("SENHA PREFERENCIAL"))
        assertTrue(text.contains("P012"))
        assertTrue(text.contains("14/11/2026 13:05"))
        assertTrue(text.contains("3 pessoas"))
        assertTrue(text.contains("WhatsApp"))
        // O endereço do QR vira imagem; o código de vínculo não aparece em texto.
        assertFalse(text.contains("AB12CD"))
    }

    @Test
    fun `sem WhatsApp configurado o cupom sai sem QR e sem convite`() {
        val text = String(SenhaTicketReceipt(data(link = null)).receiptBytes(portable58mm), Charsets.ISO_8859_1)
        assertTrue(text.contains("SENHA NORMAL"))
        assertTrue(text.contains("N012"))
        assertFalse(text.contains("WhatsApp"))
    }

    @Test
    fun `textos da posicao`() {
        assertEquals("Você é o próximo", CouponText.position(data(ahead = 0)))
        assertEquals("1 pessoa à sua frente · cerca de 25 min", CouponText.position(data(ahead = 1)))
    }

    @Test
    fun `depois de impresso o cupom esquece os dados e nao aparece em log`() {
        val payload = SenhaTicketReceipt(data())
        payload.clear()
        assertFalse(payload.toString().contains("N012"))
    }
}
