import Foundation
import ThermalPrinterKit

/// O que vai no comprovante da ordem de serviço; separado da ordem para o teste montar sem rede. A observação interna
/// (`notes`) nunca entra: é da equipe.
struct ServiceOrderReceiptData: Equatable {
    var header: String
    var number: String
    var created: Int64?
    var customer: String
    var phone: String?
    var item: String
    var problem: String
    var status: String
    var due: Int64?
    var quote: [QuoteItem]
    var total: Int?
    var validUntil: Int64?
    var decision: String?
    var warrantyUntil: Int64?
    var termsAcceptedAt: Int64?
    var printedAt: Int64
    /// Documento, endereço e telefone do estabelecimento, abaixo do nome.
    var headerLines: [String] = []
    /// Rodapé do estabelecimento (ex.: garantia), no fim do papel.
    var footerLines: [String] = []

    /// Com o estabelecimento lido do servidor, o nome dele (o nome da área quando não há cadastro) vira o cabeçalho.
    static func of(_ order: ServiceOrder, header: String, establishment: Establishment? = nil, now: Date = Date()) -> ServiceOrderReceiptData {
        let name = establishment?.displayName ?? header
        return ServiceOrderReceiptData(
            header: name.isEmpty ? "Vinki" : name,
            number: order.number.map(String.init) ?? "—",
            created: order.created,
            customer: order.customerName,
            phone: order.customer?.phone,
            item: order.item ?? "",
            problem: order.problem ?? "",
            status: order.label,
            due: order.dueAt,
            quote: order.quote?.items ?? [],
            total: order.quote.map(\.total),
            validUntil: order.quote?.validUntil,
            decision: order.decision?.decision,
            warrantyUntil: order.warrantyUntil,
            termsAcceptedAt: order.terms?.acceptedAt,
            printedAt: BrasiliaTime.millis(now),
            headerLines: establishment?.headerLines ?? [],
            footerLines: establishment?.footerLines ?? []
        )
    }
}

/// As linhas do comprovante, em texto: o que o teste confere e o que o cupom imprime.
enum ServiceOrderReceiptText {
    static func phone(_ digits: String?) -> String? { PhoneText.display(digits) }

    /// Pares rótulo/valor do corpo, na ordem do papel.
    static func fields(_ d: ServiceOrderReceiptData) -> [(String, String)] {
        var out: [(String, String)] = []
        if let created = d.created { out.append(("Data", BrasiliaTime.shortWithTime(created))) }
        out.append(("Cliente", d.customer))
        if let phone = phone(d.phone), phone != d.customer { out.append(("Telefone", phone)) }
        out.append(("Item", d.item))
        out.append(("Problema", d.problem))
        out.append(("Estado", d.status))
        if let due = d.due { out.append(("Previsão", BrasiliaTime.short(due))) }
        return out
    }

    static func quoteLines(_ d: ServiceOrderReceiptData) -> [(String, String)] {
        d.quote.map { item in (item.quantity > 1 ? "\(item.quantity)x \(item.description)" : item.description, Money.format(item.totalCents)) }
    }

    static func footer(_ d: ServiceOrderReceiptData) -> [String] {
        var out: [String] = []
        if let until = d.validUntil, d.decision == nil { out.append("Orçamento válido até \(BrasiliaTime.short(until))") }
        if let decision = d.decision { out.append(decision == "approve" ? "Orçamento aprovado" : "Orçamento recusado") }
        if let warranty = d.warrantyUntil { out.append("Garantia até \(BrasiliaTime.short(warranty))") }
        if let terms = d.termsAcceptedAt { out.append("Termos aceitos em \(BrasiliaTime.shortWithTime(terms))") }
        out.append("Impresso em \(BrasiliaTime.shortWithTime(d.printedAt))")
        return out
    }
}

/// O comprovante da ordem de serviço (número em corpo duplo, cliente, item, problema, estado, data e o orçamento).
/// Largura, página de código e corte vêm do `ReceiptLayout` (perfil da impressora escolhida no app).
final class ServiceOrderReceipt: ThermalReceiptPayload {
    private var data: ServiceOrderReceiptData?

    init(_ data: ServiceOrderReceiptData) { self.data = data }

    func receiptBytes(layout: ReceiptLayout) -> Data? {
        guard let d = data, let big = ThermalTextSize(widthMultiplier: 2, heightMultiplier: 2) else { return nil }
        let center: UInt8 = 1, left: UInt8 = 0
        var out = Data()
        out.append(layout.text(layout.wrap(d.header) + "\n", alignment: center, bold: true, size: .normal))
        for line in d.headerLines { out.append(layout.text(layout.wrap(line) + "\n", alignment: center)) }
        out.append(layout.text("ORDEM DE SERVIÇO\n", alignment: center, bold: true, size: .normal))
        out.append(layout.text(layout.wrap("Nº \(d.number)", size: big) + "\n", alignment: center, bold: true, size: big))
        out.append(layout.text(String(repeating: "-", count: layout.columns) + "\n", alignment: left))
        for (label, value) in ServiceOrderReceiptText.fields(d) {
            out.append(layout.text(layout.wrap("\(label): \(value)") + "\n", alignment: left))
        }
        if !d.quote.isEmpty {
            out.append(layout.text(String(repeating: "-", count: layout.columns) + "\n", alignment: left))
            out.append(layout.text("ORÇAMENTO\n", alignment: left, bold: true))
            for (description, value) in ServiceOrderReceiptText.quoteLines(d) {
                out.append(layout.text(layout.valueLine(description, value: value) + "\n", alignment: left))
            }
            if let total = d.total {
                out.append(layout.text(layout.valueLine("TOTAL", value: Money.format(total)) + "\n", alignment: left, bold: true))
            }
        }
        out.append(layout.text(String(repeating: "-", count: layout.columns) + "\n", alignment: left))
        for line in ServiceOrderReceiptText.footer(d) {
            out.append(layout.text(layout.wrap(line) + "\n", alignment: center))
        }
        for line in d.footerLines { out.append(layout.text(layout.wrap(line) + "\n", alignment: center)) }
        out.append(layout.finish())
        return out
    }

    func clear() { data = nil }
}

extension WabotiaPrinting {
    /// Imprime o comprovante na impressora já escolhida no app (a mesma do totem).
    func print(_ order: ServiceOrderReceiptData) async -> TicketPrint {
        guard hasPrinter else { return .noPrinter }
        return TicketPrint.of(await configuration.coordinator.print(ServiceOrderReceipt(order)))
    }
}
