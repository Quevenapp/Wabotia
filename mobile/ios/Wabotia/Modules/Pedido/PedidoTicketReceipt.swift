import Foundation
import ThermalPrinterKit

/// A comanda do pedido no papel: o texto que o servidor monta (`GET …/orders/{id}/ticket`), já com o estabelecimento e
/// em colunas fixas. O app pede 32, 42 e 48 colunas e o cupom usa a maior que cabe na impressora escolhida; uma linha
/// mais larga que o papel (perfil estreito) é quebrada pelo `ReceiptLayout`. Observação interna nunca vem no texto.
final class PedidoTicketReceipt: ThermalReceiptPayload {
    private var texts: [Int: String]

    init(texts: [Int: String]) { self.texts = texts }

    /// O texto para a largura da impressora (testável sem impressora).
    static func text(for columns: Int, in texts: [Int: String]) -> String? {
        let wanted = PedidoRules.ticketColumns(for: columns)
        if let exact = texts[wanted] { return exact }
        return texts.keys.sorted().last { $0 <= columns }.flatMap { texts[$0] } ?? texts.keys.sorted().first.flatMap { texts[$0] }
    }

    func receiptBytes(layout: ReceiptLayout) -> Data? {
        guard let text = Self.text(for: layout.columns, in: texts) else { return nil }
        var out = Data()
        let left: UInt8 = 0
        for (index, line) in text.components(separatedBy: "\n").enumerated() {
            let fits = line.count <= layout.columns
            // A primeira linha é o nome do estabelecimento; a do número do pedido sai em negrito.
            let bold = index == 0 || line.hasPrefix("PEDIDO Nº")
            out.append(layout.text((fits ? line : layout.wrap(line.trimmingCharacters(in: .whitespaces))) + "\n", alignment: left, bold: bold))
        }
        out.append(layout.finish())
        return out
    }

    func clear() { texts = [:] }
}

extension WabotiaPrinting {
    /// Imprime a comanda na impressora já escolhida no app (a mesma do totem e do comprovante).
    func printPedido(_ texts: [Int: String]) async -> TicketPrint {
        guard hasPrinter else { return .noPrinter }
        return TicketPrint.of(await configuration.coordinator.print(PedidoTicketReceipt(texts: texts)))
    }
}
