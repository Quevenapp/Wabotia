package br.com.queven.wabotia.printing

import br.com.queven.wabotia.modules.Establishment
import br.com.queven.wabotia.queue.QueueCoupon
import br.com.queven.wabotia.queue.QueueTicket
import br.com.thermalprinterkit.ReceiptLayout
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalReceiptPayload
import br.com.thermalprinterkit.ThermalTextAlignment
import br.com.thermalprinterkit.ThermalTextSize
import br.com.thermalprinterkit.ThermalTextStyle
import br.com.thermalprinterkit.receiptBytes
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.coroutines.cancellation.CancellationException

/** O que vai no cupom; separado do ticket para o teste montar sem rede. */
data class CouponData(
    /** Nome do estabelecimento; vazio = cupom sem cabeçalho (a área desligou os dados do cadastro). */
    val header: String,
    val queueName: String,
    val code: String,
    val preferential: Boolean,
    val issuedAt: Long,
    val ahead: Int,
    /** `null` quando a fila não mostra estimativa (`wait_mode: off`): o cupom fala só das pessoas à frente. */
    val waitMinutes: Int?,
    /** `https://wa.me/...?text=...SENHA N023 AB12CD...`; liga a senha ao WhatsApp do cliente. */
    val whatsappLink: String?,
    /** Documento, endereço e telefone do estabelecimento, abaixo do nome. */
    val headerLines: List<String> = emptyList(),
    /** Rodapé, no fim do cupom. */
    val footerLines: List<String> = emptyList(),
    /** Linha "pessoas à sua frente"; a área pode desligar. */
    val showPosition: Boolean = true,
) {
    companion object {
        /**
         * Com [coupon] (servidor com o cupom configurável), vale o que a área escolheu: cabeçalho só com o
         * estabelecimento, posição, rodapé e QR. Sem ele (servidor antigo), o cupom de antes: o nome do estabelecimento
         * lido à parte, ou [header] (o nome do aparelho), com documento, endereço, telefone e rodapé do cadastro.
         */
        fun of(ticket: QueueTicket, header: String, establishment: Establishment? = null, coupon: QueueCoupon? = null): CouponData {
            val shop = if (coupon != null) coupon.establishment else establishment
            return CouponData(
                header = shop?.displayName ?: if (coupon != null) "" else header,
                queueName = ticket.queueName.orEmpty(),
                code = ticket.code,
                preferential = ticket.preferential,
                issuedAt = ticket.createdAt,
                ahead = ticket.ahead ?: 0,
                waitMinutes = ticket.waitMinutes,
                // O servidor já anula o link quando o QR está desligado ou sem número; o app só confere o esquema.
                whatsappLink = ticket.whatsappLink?.takeIf { coupon?.whatsappQr != false && it.startsWith("https://") },
                headerLines = shop?.headerLines.orEmpty(),
                footerLines = if (coupon != null) coupon.footer?.let(CouponText::lines).orEmpty() else establishment?.footerLines.orEmpty(),
                showPosition = coupon?.position ?: true,
            )
        }
    }
}

/** As linhas do cupom, em texto: o que o teste confere e o que o layout imprime. */
object CouponText {
    private val clock = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm").withZone(ZoneId.of("America/Sao_Paulo"))

    fun type(data: CouponData) = if (data.preferential) "PREFERENCIAL" else "NORMAL"

    fun issued(data: CouponData) = "Emitida em ${clock.format(Instant.ofEpochMilli(data.issuedAt))}"

    fun position(data: CouponData): String {
        val wait = data.waitMinutes?.let { " · cerca de $it min" }.orEmpty()
        return when (data.ahead) {
            0 -> "Você é o próximo"
            1 -> "1 pessoa à sua frente$wait"
            else -> "${data.ahead} pessoas à sua frente$wait"
        }
    }

    /** Abaixo do QR. A mensagem que o QR abre já diz "Aperte ENVIAR para ser chamado pelo WhatsApp." */
    const val WHATSAPP = "Aponte a câmera do celular e aperte ENVIAR no WhatsApp: avisamos quando for a sua vez"

    /** Texto livre da área em linhas de cupom, sem linhas vazias nem espaços sobrando. */
    fun lines(text: String): List<String> = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
}

/**
 * O cupom da senha do Senhapp (porta do `VinkiTicketReceipt`): empresa, fila,
 * tipo, número em corpo grande, hora, pessoas à frente e o QR do WhatsApp.
 * Largura, página de código e corte vêm do [ReceiptLayout] (perfil da impressora).
 */
class SenhaTicketReceipt(private var data: CouponData?) : ThermalReceiptPayload {
    override fun receiptBytes(layout: ReceiptLayout): ByteArray {
        val d = data ?: error("Senha indisponível.")
        val parts =
            buildList {
                if (d.header.isNotBlank()) {
                    add(layout.text(layout.wrap(PaperText.clean(d.header)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                }
                d.headerLines.forEach { add(layout.text(layout.wrap(PaperText.clean(it)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)) }
                if (d.queueName.isNotBlank()) {
                    add(layout.text(layout.wrap(PaperText.clean(d.queueName)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                add(layout.text("SENHA ${CouponText.type(d)}\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                // Corpo triplo: a senha se lê de longe e é o que a pessoa compara com o painel.
                add(layout.text(layout.wrap(PaperText.clean(d.code), BIG) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, BIG))
                add(layout.text(PaperText.clean(CouponText.issued(d)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                if (d.showPosition) {
                    add(layout.text(layout.wrap(PaperText.clean(CouponText.position(d))) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                d.whatsappLink?.let { link ->
                    add(requireNotNull(layout.qrRaster(link)) { "QR da senha inválido." })
                    add(layout.text(layout.wrap(PaperText.clean(CouponText.WHATSAPP)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                d.footerLines.forEach { add(layout.text(layout.wrap(PaperText.clean(it)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)) }
                add(layout.finish())
            }
        return receiptBytes(parts)
    }

    override fun clear() {
        data = null
    }

    override fun toString(): String = "SenhaTicketReceipt([REDACTED])"

    private companion object {
        val BIG = ThermalTextSize(widthMultiplier = 3, heightMultiplier = 3)
    }
}

/**
 * Manda o cupom e diz o que houve. Resultado incerto (`INDETERMINATE`) nunca
 * reimprime sozinho: a segunda via pede confirmação de quem está no totem.
 */
class SenhaPrinter(
    private val printer: ThermalPrinter,
    private val ready: suspend () -> Unit = {},
) {
    fun hasPrinter(): Boolean = printer.adoptedPrinters.value.isNotEmpty()

    suspend fun print(data: CouponData): TicketPrint {
        ready()
        if (!hasPrinter()) return TicketPrint.NoPrinter
        return try {
            TicketPrint.of(printer.print(SenhaTicketReceipt(data)))
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            TicketPrint.Failed(error.message ?: "Falha ao imprimir.", reprintNeedsConfirmation = true)
        }
    }
}
