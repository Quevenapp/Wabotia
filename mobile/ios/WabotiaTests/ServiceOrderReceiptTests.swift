import XCTest
import ThermalPrinterKit
@testable import Wabotia

final class ServiceOrderReceiptTests: XCTestCase {
    private func order() throws -> ServiceOrder {
        try QueueJSON.decoder.decode(ServiceOrder.self, from: Data(ServiceOrderClientTests.orderJSON.utf8))
    }

    func testFieldsAndQuote() throws {
        let data = ServiceOrderReceiptData.of(try order(), header: "Assistência Exemplo", now: Date(timeIntervalSince1970: 1_763_215_200))
        XCTAssertEqual(data.number, "12")
        let fields = Dictionary(uniqueKeysWithValues: ServiceOrderReceiptText.fields(data))
        XCTAssertEqual(fields["Cliente"], "Bia")
        XCTAssertEqual(fields["Telefone"], "(20) 90000-1111")
        XCTAssertEqual(fields["Item"], "Celular")
        XCTAssertEqual(fields["Problema"], "Tela trincada")
        XCTAssertEqual(fields["Estado"], "Orçamento enviado")
        XCTAssertNotNil(fields["Data"])
        XCTAssertEqual(ServiceOrderReceiptText.quoteLines(data).map(\.0), ["Tela", "2x Mão de obra"])
        XCTAssertEqual(data.total, 45_000)
        XCTAssertTrue(ServiceOrderReceiptText.footer(data).contains { $0.hasPrefix("Orçamento válido até") })
        XCTAssertEqual(ServiceOrderReceiptText.footer(data).last, "Impresso em 15/11/2025 11:00")
    }

    func testInternalNotesNeverPrint() throws {
        let receipt = ServiceOrderReceipt(ServiceOrderReceiptData.of(try order(), header: "Assistência Exemplo"))
        let bytes = try XCTUnwrap(receipt.receiptBytes(layout: .portable58mm))
        let text = String(decoding: bytes, as: UTF8.self)
        XCTAssertTrue(text.contains("12"))
        XCTAssertTrue(text.contains("Celular"))
        XCTAssertTrue(text.contains("TOTAL"))
        XCTAssertFalse(text.contains("interno"), "observação interna fica fora do papel")
        receipt.clear()
        XCTAssertNil(receipt.receiptBytes(layout: .portable58mm))
    }
}
