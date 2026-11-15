package br.com.queven.wabotia.printing

import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Establishment
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.os.QuoteItem
import br.com.queven.wabotia.modules.os.ServiceOrder
import br.com.thermalprinterkit.ReceiptLayout
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalReceiptPayload
import br.com.thermalprinterkit.ThermalTextAlignment
import br.com.thermalprinterkit.ThermalTextSize
import br.com.thermalprinterkit.ThermalTextStyle
import br.com.thermalprinterkit.receiptBytes
import kotlin.coroutines.cancellation.CancellationException

/**
 * O que vai no comprovante da ordem de serviço; separado da ordem para o teste montar sem rede. A observação interna
 * (`notes`) nunca entra: é da equipe.
 */
data class ServiceOrderReceiptData(
    val header: String,
    val number: String,
    val created: Long?,
    val customer: String,
    val phone: String?,
    val item: String,
    val problem: String,
    val status: String,
    val due: Long?,
    val quote: List<QuoteItem>,
    val total: Long?,
    val validUntil: Long?,
    val decision: String?,
    val warrantyUntil: Long?,
    val termsAcceptedAt: Long?,
    val printedAt: Long,
    /** Documento, endereço e telefone do estabelecimento, abaixo do nome. */
    val headerLines: List<String> = emptyList(),
    /** Rodapé do estabelecimento (ex.: garantia), no fim do papel. */
    val footerLines: List<String> = emptyList(),
) {
    companion object {
        /** Com o estabelecimento lido do servidor, o nome dele (o nome da área quando não há cadastro) vira o cabeçalho. */
        fun of(order: ServiceOrder, header: String, establishment: Establishment? = null, now: Long = System.currentTimeMillis()) =
            ServiceOrderReceiptData(
                header = (establishment?.displayName ?: header).ifBlank { "Wabotia" },
                number = order.number?.toString() ?: "—",
                created = order.created,
                customer = order.customerName,
                phone = order.customer?.phone,
                item = order.item.orEmpty(),
                problem = order.problem.orEmpty(),
                status = order.label,
                due = order.dueAt,
                quote = order.quote?.items.orEmpty(),
                total = order.quote?.total,
                validUntil = order.quote?.validUntil,
                decision = order.decision?.decision,
                warrantyUntil = order.warrantyUntil,
                termsAcceptedAt = order.terms?.acceptedAt,
                printedAt = now,
                headerLines = establishment?.headerLines.orEmpty(),
                footerLines = establishment?.footerLines.orEmpty(),
            )
    }
}

/** As linhas do comprovante, em texto: o que o teste confere e o que o cupom imprime. */
object ServiceOrderReceiptText {
    /** Pares rótulo/valor do corpo, na ordem do papel. */
    fun fields(d: ServiceOrderReceiptData): List<Pair<String, String>> = buildList {
        d.created?.let { add("Data" to BrasiliaTime.shortWithTime(it)) }
        add("Cliente" to d.customer)
        PhoneText.display(d.phone)?.takeIf { it != d.customer }?.let { add("Telefone" to it) }
        add("Item" to d.item)
        add("Problema" to d.problem)
        add("Estado" to d.status)
        d.due?.let { add("Previsão" to BrasiliaTime.short(it)) }
    }

    fun quoteLines(d: ServiceOrderReceiptData): List<Pair<String, String>> =
        d.quote.map { (if (it.quantity > 1) "${it.quantity}x ${it.description}" else it.description) to Money.format(it.totalCents) }

    /**
     * "Descrição ........ R$ 10,00" na largura do papel; descrição comprida quebra e o valor fica alinhado à direita
     * na última linha.
     */
    fun valueLine(label: String, value: String, columns: Int): String {
        val width = maxOf(columns, value.length + 1)
        val lines = mutableListOf<String>()
        var current = ""
        for (word in label.split(' ').filter { it.isNotEmpty() }.flatMap { it.chunked(width) }) {
            val candidate = if (current.isEmpty()) word else "$current $word"
            if (candidate.length <= width) current = candidate else { lines += current; current = word }
        }
        lines += current
        val last = lines.last()
        // O valor cabe ao lado da última linha; senão, desce para uma linha só dele, alinhado à direita.
        return if (last.length + 1 + value.length <= width) {
            (lines.dropLast(1) + (last + " ".repeat(width - last.length - value.length) + value)).joinToString("\n")
        } else {
            (lines + (" ".repeat(width - value.length) + value)).joinToString("\n")
        }
    }

    fun footer(d: ServiceOrderReceiptData): List<String> = buildList {
        if (d.validUntil != null && d.decision == null) add("Orçamento válido até ${BrasiliaTime.short(d.validUntil)}")
        d.decision?.let { add(if (it == "approve") "Orçamento aprovado" else "Orçamento recusado") }
        d.warrantyUntil?.let { add("Garantia até ${BrasiliaTime.short(it)}") }
        d.termsAcceptedAt?.let { add("Termos aceitos em ${BrasiliaTime.shortWithTime(it)}") }
        add("Impresso em ${BrasiliaTime.shortWithTime(d.printedAt)}")
    }
}

/**
 * O comprovante da ordem de serviço (número em corpo duplo, cliente, item, problema, estado, data e o orçamento).
 * Largura, página de código e corte vêm do [ReceiptLayout] (perfil da impressora escolhida no app).
 */
class ServiceOrderReceipt(private var data: ServiceOrderReceiptData?) : ThermalReceiptPayload {
    override fun receiptBytes(layout: ReceiptLayout): ByteArray {
        val d = data ?: error("Comprovante indisponível.")
        val n = ThermalTextSize.NORMAL
        fun center(text: String, style: ThermalTextStyle = ThermalTextStyle.NORMAL, size: ThermalTextSize = n) =
            layout.text(layout.wrap(text, size) + "\n", ThermalTextAlignment.CENTER, style, size)
        fun left(text: String, style: ThermalTextStyle = ThermalTextStyle.NORMAL) = layout.text(text + "\n", ThermalTextAlignment.LEFT, style, n)
        val rule = "-".repeat(layout.columns)
        val parts = buildList {
            add(center(d.header, ThermalTextStyle.BOLD))
            d.headerLines.forEach { add(center(it)) }
            add(center("ORDEM DE SERVIÇO", ThermalTextStyle.BOLD))
            add(center("Nº ${d.number}", ThermalTextStyle.BOLD, BIG))
            add(left(rule))
            ServiceOrderReceiptText.fields(d).forEach { (label, value) -> add(left(layout.wrap("$label: $value"))) }
            if (d.quote.isNotEmpty()) {
                add(left(rule))
                add(left("ORÇAMENTO", ThermalTextStyle.BOLD))
                ServiceOrderReceiptText.quoteLines(d).forEach { (description, value) -> add(left(ServiceOrderReceiptText.valueLine(description, value, layout.columns))) }
                d.total?.let { add(left(ServiceOrderReceiptText.valueLine("TOTAL", Money.format(it), layout.columns), ThermalTextStyle.BOLD)) }
            }
            add(left(rule))
            ServiceOrderReceiptText.footer(d).forEach { add(center(it)) }
            d.footerLines.forEach { add(center(it)) }
            add(layout.finish())
        }
        return receiptBytes(parts)
    }

    override fun clear() {
        data = null
    }

    override fun toString(): String = "ServiceOrderReceipt([REDACTED])"

    private companion object {
        val BIG = ThermalTextSize(widthMultiplier = 2, heightMultiplier = 2)
    }
}

/** Imprime o comprovante na impressora já escolhida no app (a mesma do totem). */
class ServiceOrderPrinter(private val printer: ThermalPrinter, private val ready: suspend () -> Unit = {}) {
    suspend fun print(data: ServiceOrderReceiptData): TicketPrint {
        ready()
        if (printer.adoptedPrinters.value.isEmpty()) return TicketPrint.NoPrinter
        return try {
            TicketPrint.of(printer.print(ServiceOrderReceipt(data)))
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            TicketPrint.Failed(error.message ?: "Falha ao imprimir.", reprintNeedsConfirmation = true)
        }
    }
}
