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

    private fun print(d: CouponData) = String(SenhaTicketReceipt(d).receiptBytes(portable58mm), Charsets.ISO_8859_1)

    private val ticket = br.com.queven.wabotia.queue.QueueTicket(
        id = "t1",
        code = "N012",
        queueName = "Atendimento geral",
        ahead = 3,
        waitMinutes = 25,
        createdAt = 1_794_672_300_000,
        whatsappLink = "https://wa.me/5511999998888?text=SENHA%20N012%20AB12CD",
    )
    private val establishment = br.com.queven.wabotia.modules.Establishment(
        name = "Clinica Central",
        address = "Rua Exemplo, 100",
        footer = "Obrigado pela visita",
    )

    @Test
    fun `sem configuracao da area o cupom sai como antes`() {
        val text = print(CouponData.of(ticket, "Totem", establishment))
        assertTrue(text.contains("Clinica Central"))
        assertTrue(text.contains("Rua Exemplo"))
        assertTrue(text.contains("3 pessoas"))
        assertTrue(text.contains("WhatsApp"))
        assertTrue(text.contains("Obrigado pela visita"))
    }

    @Test
    fun `a area desliga cadastro, posicao e QR e troca o rodape`() {
        val settings = CouponSettings(showEstablishment = false, showPosition = false, showWhatsappQr = false, footer = "Volte sempre\n\n  Boa consulta  ")
        val d = CouponData.of(ticket, "Totem", establishment, settings)
        assertEquals(null, d.whatsappLink)
        assertEquals(listOf("Volte sempre", "Boa consulta"), d.footerLines)
        val text = print(d)
        // O nome sai sempre; o resto do cadastro, não.
        assertTrue(text.contains("Clinica Central"))
        assertFalse(text.contains("Rua Exemplo"))
        assertFalse(text.contains("pessoas"))
        assertFalse(text.contains("WhatsApp"))
        assertFalse(text.contains("Obrigado pela visita"))
        assertTrue(text.contains("Volte sempre"))
        assertTrue(text.contains("N012"))
    }

    @Test
    fun `rodape vazio da area tira o rodape do cadastro`() {
        assertEquals(emptyList<String>(), CouponData.of(ticket, "Totem", establishment, CouponSettings(footer = "")).footerLines)
    }

    @Test
    fun `texto do QR para quem tem dificuldade com o celular`() {
        val hint = "Aperte ENVIAR no WhatsApp\npara ser chamado"
        val d = CouponData.of(ticket, "Totem", establishment, CouponSettings(whatsappHint = hint))
        val text = print(d)
        assertTrue(text.contains("Aperte ENVIAR no WhatsApp"))
        assertTrue(text.contains("para ser chamado"))
        assertFalse(text.contains(CouponText.WHATSAPP.take(20)))
        // Em branco volta ao texto padrão.
        assertEquals(CouponText.WHATSAPP, CouponData.of(ticket, "Totem", null, CouponSettings(whatsappHint = "  ")).whatsappHint)
    }

    @Test
    fun `depois de impresso o cupom esquece os dados e nao aparece em log`() {
        val payload = SenhaTicketReceipt(data())
        payload.clear()
        assertFalse(payload.toString().contains("N012"))
    }
}
