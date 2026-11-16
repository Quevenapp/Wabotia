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

    /** O `coupon` do overview no formato do contrato (docs/FILA-SENHAS.md, "Cupom da senha"). */
    private fun coupon(json: String) = br.com.queven.wabotia.core.model.WabotiaJson.decodeFromString(
        br.com.queven.wabotia.queue.QueueOverview.serializer(), """{"day":"2026-11-16","coupon":$json,"novo":1}""",
    ).coupon!!

    @Test
    fun `cupom do servidor com tudo ligado`() {
        val c = coupon(
            """{"establishment":{"name":"Clinica Exemplo","document_display":"11.222.333/0001-81","address":"Rua A, 1","phone":"(11) 3000-0000"},
               "position":true,"footer":"Obrigado pela visita!","whatsapp_qr":true,"whatsapp_qr_issue":null,"whatsapp_qr_notice":null}""",
        )
        val text = print(CouponData.of(ticket, "Recepcao X230", establishment, c))
        assertTrue(text.contains("Clinica Exemplo"))
        assertTrue(text.contains("CNPJ 11.222.333/0001-81"))
        assertTrue(text.contains("Rua A, 1"))
        assertTrue(text.contains("(11) 3000-0000"))
        assertTrue(text.contains("3 pessoas"))
        assertTrue(text.contains("WhatsApp"))
        assertTrue(text.contains("Obrigado pela visita!"))
        // O estabelecimento lido à parte e o nome do aparelho não entram quando o servidor manda o cupom.
        assertFalse(text.contains("Clinica Central"))
        assertFalse(text.contains("Recepcao"))
    }

    @Test
    fun `area desliga cadastro, posicao, rodape e QR`() {
        val c = coupon("""{"establishment":null,"position":false,"footer":null,"whatsapp_qr":false,"whatsapp_qr_issue":"disabled","whatsapp_qr_notice":"Desligado em Filas e guichês."}""")
        // O servidor já anula o link com o QR desligado; o app confere também.
        val d = CouponData.of(ticket, "Recepcao X230", establishment, c)
        assertEquals(null, d.whatsappLink)
        val text = print(d)
        assertFalse(text.contains("Clinica"))
        assertFalse(text.contains("Recepcao"))
        assertFalse(text.contains("pessoas"))
        assertFalse(text.contains("WhatsApp"))
        assertFalse(text.contains("Obrigado"))
        // O motivo é para quem configura, nunca para o cupom.
        assertFalse(text.contains("Desligado"))
        assertTrue(text.contains("SENHA NORMAL"))
        assertTrue(text.contains("N012"))
        assertTrue(text.contains("Atendimento geral"))
    }

    @Test
    fun `sem linha de WhatsApp o link vem nulo e o cupom sai sem QR`() {
        val c = coupon("""{"establishment":{"name":"Clinica Exemplo"},"position":true,"footer":"Volte sempre\n\n  Boa consulta  ","whatsapp_qr":true,"whatsapp_qr_issue":"no_line","whatsapp_qr_notice":"A área não tem linha de WhatsApp."}""")
        val d = CouponData.of(ticket.copy(whatsappLink = null), "Totem", null, c)
        assertEquals(listOf("Volte sempre", "Boa consulta"), d.footerLines)
        val text = print(d)
        assertFalse(text.contains("WhatsApp"))
        // A linha da posição quebra em 32 colunas; a espera continua lá.
        assertTrue(text.contains("25 min"))
    }

    @Test
    fun `campos ausentes valem o cupom completo`() {
        val c = coupon("{}")
        assertTrue(c.position)
        assertTrue(c.whatsappQr)
        val d = CouponData.of(ticket, "Totem", null, c)
        assertEquals("", d.header)
        assertTrue(d.showPosition)
        assertTrue(d.whatsappLink != null)
    }
    @Test
    fun `depois de impresso o cupom esquece os dados e nao aparece em log`() {
        val payload = SenhaTicketReceipt(data())
        payload.clear()
        assertFalse(payload.toString().contains("N012"))
    }
}
