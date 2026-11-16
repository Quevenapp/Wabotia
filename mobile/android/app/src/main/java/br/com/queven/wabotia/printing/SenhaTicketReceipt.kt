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

/**
 * O que a área escolhe mostrar no cupom da senha (Onda 4: dados do cadastro, posição na fila, rodapé e QR do wa.me,
 * cada um ligável, e o texto do QR pensado para quem tem dificuldade com o celular). Os padrões reproduzem o cupom de
 * antes da configuração, para servidores que ainda não mandam nada.
 */
data class CouponSettings(
    /** Documento, endereço e telefone do cadastro abaixo do nome. O nome sai sempre. */
    val showEstablishment: Boolean = true,
    /** "3 pessoas à sua frente · cerca de 12 min". */
    val showPosition: Boolean = true,
    /** Mensagem de rodapé da área; null usa o rodapé do cadastro do estabelecimento. Vazia não imprime rodapé. */
    val footer: String? = null,
    /** QR do wa.me (só sai quando o servidor manda o link). */
    val showWhatsappQr: Boolean = true,
    /** Texto abaixo do QR; null usa [CouponText.WHATSAPP]. */
    val whatsappHint: String? = null,
)

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
    /** Linha "pessoas à sua frente"; a área pode desligar. */
    val showPosition: Boolean = true,
    /** Texto abaixo do QR. */
    val whatsappHint: String = CouponText.WHATSAPP,
) {
    companion object {
        /**
         * `header` é o nome do aparelho; com o estabelecimento lido do servidor vale o nome dele (o nome da área quando
         * não há cadastro) e entram documento, endereço, telefone e rodapé, conforme [settings].
         */
        fun of(ticket: QueueTicket, header: String, establishment: Establishment? = null, settings: CouponSettings = CouponSettings()) =
            CouponData(
                header = establishment?.displayName ?: header,
                queueName = ticket.queueName.orEmpty(),
                code = ticket.code,
                preferential = ticket.preferential,
                issuedAt = ticket.createdAt,
                ahead = ticket.ahead ?: 0,
                waitMinutes = ticket.waitMinutes,
                whatsappLink = ticket.whatsappLink?.takeIf { settings.showWhatsappQr && it.startsWith("https://") },
                headerLines = if (settings.showEstablishment) establishment?.headerLines.orEmpty() else emptyList(),
                footerLines = settings.footer?.let(CouponText::lines) ?: establishment?.footerLines.orEmpty(),
                showPosition = settings.showPosition,
                whatsappHint = settings.whatsappHint?.trim()?.takeIf { it.isNotEmpty() } ?: CouponText.WHATSAPP,
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

    /** Texto livre da área em linhas de cupom, sem linhas vazias nas pontas nem espaços sobrando. */
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
                add(layout.text(layout.wrap(d.header) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                d.headerLines.forEach { add(layout.text(layout.wrap(it) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)) }
                if (d.queueName.isNotBlank()) {
                    add(layout.text(layout.wrap(d.queueName) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                add(layout.text("SENHA ${CouponText.type(d)}\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                // Corpo triplo: a senha se lê de longe e é o que a pessoa compara com o painel.
                add(layout.text(layout.wrap(d.code, BIG) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, BIG))
                add(layout.text(CouponText.issued(d) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                if (d.showPosition) {
                    add(layout.text(layout.wrap(CouponText.position(d)) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                }
                d.whatsappLink?.let { link ->
                    add(requireNotNull(layout.qrRaster(link)) { "QR da senha inválido." })
                    CouponText.lines(d.whatsappHint).forEach {
                        add(layout.text(layout.wrap(it) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                    }
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
