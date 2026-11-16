package br.com.queven.wabotia.printing

import br.com.queven.wabotia.modules.pedido.PedidoRules
import br.com.thermalprinterkit.ReceiptLayout
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalReceiptPayload
import br.com.thermalprinterkit.ThermalTextAlignment
import br.com.thermalprinterkit.ThermalTextSize
import br.com.thermalprinterkit.ThermalTextStyle
import br.com.thermalprinterkit.receiptBytes
import kotlin.coroutines.cancellation.CancellationException

/**
 * A comanda do pedido no papel: o texto que o servidor monta (`GET …/orders/{id}/ticket`, src/modules/pedido/ticket.ts),
 * já com o estabelecimento e em colunas fixas. O app pede 32, 42 e 48 colunas e o cupom usa a maior que cabe na
 * impressora escolhida; uma linha mais larga que o papel (perfil estreito) é quebrada pelo [ReceiptLayout]. A
 * observação interna nunca vem no texto. Mesmo desenho do iOS (`PedidoTicketReceipt.swift`).
 */
class PedidoTicketReceipt(private var texts: Map<Int, String>) : ThermalReceiptPayload {
    override fun receiptBytes(layout: ReceiptLayout): ByteArray {
        val text = text(layout.columns, texts) ?: error("Comanda indisponível.")
        val n = ThermalTextSize.NORMAL
        val parts = buildList {
            // O texto vem do servidor, alinhado com espaços: saneia sem mexer no alinhamento.
            PaperText.clean(text, tidy = false).split("\n").forEachIndexed { index, line ->
                // A primeira linha é o nome do estabelecimento; a do número do pedido sai em negrito.
                val bold = index == 0 || isNumberLine(line)
                val fits = line.length <= layout.columns
                add(layout.text((if (fits) line else layout.wrap(line.trim(), n)) + "\n", ThermalTextAlignment.LEFT, if (bold) ThermalTextStyle.BOLD else ThermalTextStyle.NORMAL, n))
            }
            add(layout.finish())
        }
        return receiptBytes(parts)
    }

    override fun clear() {
        texts = emptyMap()
    }

    override fun toString(): String = "PedidoTicketReceipt([REDACTED])"

    companion object {
        /** O texto para a largura da impressora (testável sem impressora): a largura exata, senão a maior que cabe. */
        fun text(columns: Int, texts: Map<Int, String>): String? {
            texts[PedidoRules.ticketColumns(columns)]?.let { return it }
            val sorted = texts.keys.sorted()
            return (sorted.lastOrNull { it <= columns } ?: sorted.firstOrNull())?.let { texts[it] }
        }

        fun isNumberLine(line: String): Boolean = line.trimStart().startsWith("PEDIDO Nº")
    }
}

/** Imprime a comanda na impressora já escolhida no app (a mesma do totem e do comprovante da ordem de serviço). */
class PedidoPrinter(private val printer: ThermalPrinter, private val ready: suspend () -> Unit = {}) {
    /** Há impressora escolhida? Pergunta antes de buscar a comanda no servidor. */
    suspend fun hasPrinter(): Boolean {
        ready()
        return printer.adoptedPrinters.value.isNotEmpty()
    }

    suspend fun print(texts: Map<Int, String>): TicketPrint {
        if (!hasPrinter()) return TicketPrint.NoPrinter
        if (texts.isEmpty()) return TicketPrint.Failed("O servidor não mandou a comanda.", reprintNeedsConfirmation = false)
        return try {
            TicketPrint.of(printer.print(PedidoTicketReceipt(texts)))
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            TicketPrint.Failed(error.message ?: "Falha ao imprimir.", reprintNeedsConfirmation = true)
        }
    }
}
