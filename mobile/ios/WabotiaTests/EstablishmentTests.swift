import XCTest
import ThermalPrinterKit
@testable import Wabotia

final class EstablishmentTests: XCTestCase {
    private let configured = Establishment(name: "Assistência Exemplo", document: "11222333000181", documentType: "cnpj", documentDisplay: "11.222.333/0001-81",
                                           address: "Rua das Flores, 120\nCentro, Campinas/SP", phone: "(19) 3333-4444", footer: "Garantia de 90 dias.\nVolte sempre.", configured: true)

    func testHeaderAndFooterLines() throws {
        XCTAssertEqual(configured.headerLines, ["CNPJ 11.222.333/0001-81", "Rua das Flores, 120", "Centro, Campinas/SP", "(19) 3333-4444"])
        XCTAssertEqual(configured.footerLines, ["Garantia de 90 dias.", "Volte sempre."])
        let plain = try QueueJSON.decoder.decode(Establishment.self, from: Data(#"{"name":"Loja Centro","document":"","document_type":null,"document_display":"","address":"","phone":"","footer":"","configured":false}"#.utf8))
        XCTAssertEqual(plain.displayName, "Loja Centro", "sem cadastro, o nome é o da área")
        XCTAssertTrue(plain.headerLines.isEmpty && plain.footerLines.isEmpty)
    }

    func testTotemCouponUsesTheEstablishment() throws {
        let ticket = QueueTicket(id: "t1", queueName: "Geral", code: "N001", createdAt: 1)
        let device = CouponData.of(ticket, header: "Totem da entrada")
        XCTAssertEqual(device.header, "Totem da entrada", "servidor antigo, sem a rota: fica o nome do aparelho")
        let data = CouponData.of(ticket, header: "Totem da entrada", establishment: configured)
        XCTAssertEqual(data.header, "Assistência Exemplo")
        let text = String(decoding: try XCTUnwrap(SenhaTicketReceipt(data).receiptBytes(layout: .counter)), as: UTF8.self)
        XCTAssertTrue(text.contains("11.222.333/0001-81"))
        XCTAssertTrue(text.contains("Rua das Flores"))
        XCTAssertTrue(text.contains("Volte sempre"))
    }

    func testServiceOrderReceiptUsesTheEstablishment() throws {
        let order = try QueueJSON.decoder.decode(ServiceOrder.self, from: Data(ServiceOrderClientTests.orderJSON.utf8))
        let data = ServiceOrderReceiptData.of(order, header: "Área", establishment: configured)
        XCTAssertEqual(data.header, "Assistência Exemplo")
        XCTAssertEqual(data.footerLines.first, "Garantia de 90 dias.")
        let text = String(decoding: try XCTUnwrap(ServiceOrderReceipt(data).receiptBytes(layout: .counter)), as: UTF8.self)
        XCTAssertTrue(text.contains("(19) 3333-4444"))
    }

    func testCountsKeepTheStatusCodesAndPeopleAndAssign() async throws {
        StubURLProtocol.reset { seen in
            if seen.url.path.hasSuffix("/people") { return .json(200, #"{"data":[{"id":"u1","name":"Ana","role":"operator"}]}"#) }
            if seen.method == "PATCH" { return .json(200, ServiceOrderClientTests.orderJSON) }
            return .json(200, #"{"data":[],"next_cursor":null,"counts":{"in_progress":4,"received":3}}"#)
        }
        let api = ProfileAPI(baseURL: "https://w.example", profileId: "p1", session: StubURLProtocol.session()) { "wabu_x" }
        let client = ServiceOrderClient(api: api)
        let page = try await client.list()
        XCTAssertEqual(page.counts?["in_progress"], 4, "chaves exatas, sem a conversão para camelCase")
        XCTAssertEqual(page.count("in_progress"), 4)
        XCTAssertEqual(page.count("ready"), 0, "chave ausente vale 0")
        let people = try await api.people()
        XCTAssertEqual(people.map(\.displayName), ["Ana"])
        _ = try await client.assign("o1", assignee: nil, key: "k")
        let patch = try XCTUnwrap(StubURLProtocol.seen.first { $0.method == "PATCH" })
        XCTAssertTrue(patch.json.keys.contains("assignee"))
        XCTAssertTrue(patch.json["assignee"] is NSNull, "nulo tira o responsável")
    }

    func testDemoAreaAndAssignee() async throws {
        DemoServer.reset()
        let api = ProfileAPI(baseURL: DemoMode.serverURL.absoluteString, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { "wabu_demo" }
        let establishment = try await api.establishment()
        XCTAssertEqual(establishment.configured, true)
        XCTAssertFalse(establishment.headerLines.isEmpty)
        let people = try await api.people()
        XCTAssertTrue(people.contains { $0.id == "u_ana" })
        let client = ServiceOrderClient(api: api)
        let updated = try await client.assign("os_8", assignee: "u_ana", key: "demo-assign")
        XCTAssertEqual(updated.assignee, "u_ana")
        let device = QueueClient(baseURL: DemoMode.serverURL.absoluteString, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { DemoQueue.deviceToken }
        let viaDevice = try await device.establishment()
        XCTAssertEqual(viaDevice.displayName, DemoMode.profileName, "o aparelho pareado lê o mesmo cabeçalho")
    }
}
