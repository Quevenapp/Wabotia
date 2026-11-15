package br.com.queven.wabotia.printing

import br.com.queven.wabotia.modules.Establishment
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
    val header: String,
    val queueName: String,
    val code: String,
    val preferential: Boolean,
    val issuedAt: Long,
    val ahead: Int,
    /** `null` quando a fila não mostra estimativa (`wait_mode: off`): o cupom fala só das pessoas à frente. */
    val waitMinutes: Int?,
    /** `https://wa.me/...?text=SENHA N023 AB12CD`; liga a senha ao WhatsApp do cliente. */
    val whatsappLink: String?,
    /** Documento, endereço e telefone do estabelecimento, abaixo do nome. */
    val headerLines: List<String> = emptyList(),
    /** Rodapé do estabelecimento, no fim do cupom. */
    val footerLines: List<String> = emptyList(),
) {
    companion object {
        /**
         * `header` é o nome do aparelho; com o estabelecimento lido do servidor vale o nome dele (o nome da área quando
         * não há cadastro) e entram documento, endereço, telefone e rodapé.
         */
        fun of(ticket: QueueTicket, header: String, establishment: Establishment? = null) =
            CouponData(
                header = establishment?.displayName ?: header,
                queueName = ticket.queueName.orEmpty(),
                code = ticket.code,
                preferential = ticket.preferential,
                issuedAt = ticket.createdAt,
                ahead = ticket.ahead ?: 0,
                waitMinutes = ticket.waitMinutes,
                whatsappLink = ticket.whatsappLink?.takeIf { it.startsWith("https://") },
                headerLines = establishment?.headerLines.orEmpty(),
                footerLines = establishment?.footerLines.orEmpty(),
            )
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

    const val WHATSAPP = "Aponte a câmera e envie a mensagem: avisamos pelo WhatsApp quando for chamada"
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
                add(layout.text(layout.wrap(d.header) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                d.headerLines.forEach { add(layout.text(layout.wrap(it) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)) }
                if (d.queueName.isNotBlank()) {
                    add(layout.text(layout.wrap(d.queueName) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                add(layout.text("SENHA ${CouponText.type(d)}\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                // Corpo triplo: a senha se lê de longe e é o que a pessoa compara com o painel.
                add(layout.text(layout.wrap(d.code, BIG) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, BIG))
                add(layout.text(CouponText.issued(d) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                add(layout.text(layout.wrap(CouponText.position(d)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                d.whatsappLink?.let { link ->
                    add(requireNotNull(layout.qrRaster(link)) { "QR da senha inválido." })
                    add(layout.text(layout.wrap(CouponText.WHATSAPP) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                d.footerLines.forEach { add(layout.text(layout.wrap(it) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)) }
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
