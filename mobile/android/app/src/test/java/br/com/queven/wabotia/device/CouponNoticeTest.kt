package br.com.queven.wabotia.device

import br.com.queven.wabotia.device.ui.DeviceTexts
import br.com.queven.wabotia.queue.QueueCoupon
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** O motivo do QR fora do cupom aparece nos ajustes do aparelho, para quem configura. */
class CouponNoticeTest {
    private val noLine = QueueCoupon(whatsappQrIssue = "no_line", whatsappQrNotice = "A área não tem linha de WhatsApp.")

    @Test fun totemMostraOTextoDoServidor() {
        assertEquals("A área não tem linha de WhatsApp.", DeviceTexts.qrNotice(prints = true, coupon = noLine))
    }

    @Test fun painelDeChamadasNaoImprimeEntaoNaoAvisa() {
        assertNull(DeviceTexts.qrNotice(prints = false, coupon = noLine))
    }

    @Test fun semProblemaOuServidorAntigoNaoAvisa() {
        assertNull(DeviceTexts.qrNotice(prints = true, coupon = QueueCoupon()))
        assertNull(DeviceTexts.qrNotice(prints = true, coupon = null))
    }

    @Test fun motivoSemTextoGanhaAvisoGenerico() {
        val notice = DeviceTexts.qrNotice(prints = true, coupon = QueueCoupon(whatsappQrIssue = "no_number", whatsappQrNotice = " "))
        assertTrue(notice!!.contains("Cupom da senha"))
    }
}
