import XCTest
@testable import Wabotia

/// Gestão (ERP) nos aplicativos: papéis e partes, contas exatas do pedido, corpos das escritas, mensagens, cópia sem
/// conexão e a demonstração. Mesmos casos do Android (`ErpTest.kt` e `RequestEncodingTest.kt`).
final class ErpTests: XCTestCase {
    private let allParts: Set<String> = ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro", "queue"]
    private let base = DemoMode.serverURL.absoluteString

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private var demo: ErpClient {
        ErpClient(api: ProfileAPI(baseURL: base, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { "wabu_demo" }, cache: nil)
    }

    // MARK: Papéis e partes

    func testGestaoNeedsTheErpAndARole() {
        XCTAssertNil(ErpAccess.of(modules: ["queue", "os"], grants: ["erp:vendas"], isAdmin: false), "ERP desligado")
        XCTAssertNil(ErpAccess.of(modules: allParts, grants: ["os:technician"], isAdmin: false), "sem papel do ERP")
        XCTAssertEqual(ErpAccess.of(modules: allParts, grants: [], isAdmin: true)?.role, .admin)
        XCTAssertEqual(ErpAccess.of(modules: allParts, grants: ["erp:consulta"], isAdmin: true)?.role, .admin, "o administrador do Wabotia vale erp:admin")
    }

    func testEachRoleSeesItsItems() throws {
        let vendas = try XCTUnwrap(ErpAccess.of(modules: allParts, grants: ["erp:vendas"], isAdmin: false))
        XCTAssertTrue(vendas.customers && vendas.products && vendas.quickOrder && vendas.canCreateCustomer)
        XCTAssertFalse(vendas.bills || vendas.canSettle || vendas.canAdjustStock)
        let financeiro = try XCTUnwrap(ErpAccess.of(modules: allParts, grants: ["erp:financeiro"], isAdmin: false))
        XCTAssertTrue(financeiro.bills && financeiro.canSettle && financeiro.customers)
        XCTAssertFalse(financeiro.products || financeiro.quickOrder)
        let estoque = try XCTUnwrap(ErpAccess.of(modules: allParts, grants: ["erp:estoque"], isAdmin: false))
        XCTAssertTrue(estoque.products && estoque.stock && estoque.canAdjustStock)
        XCTAssertFalse(estoque.quickOrder || estoque.bills)
        let consulta = try XCTUnwrap(ErpAccess.of(modules: allParts, grants: ["erp:consulta"], isAdmin: false))
        XCTAssertTrue(consulta.bills && consulta.products && consulta.customerOrders)
        XCTAssertFalse(consulta.canSettle || consulta.canAdjustStock || consulta.canCreateCustomer || consulta.quickOrder)
    }

    func testPartOffHidesItsItem() throws {
        let noSales = try XCTUnwrap(ErpAccess.of(modules: allParts.subtracting(["erp-vendas"]), grants: ["erp:admin"], isAdmin: false))
        XCTAssertFalse(noSales.quickOrder || noSales.customerOrders)
        XCTAssertTrue(noSales.products)
        let noStock = try XCTUnwrap(ErpAccess.of(modules: allParts.subtracting(["erp-estoque"]), grants: [], isAdmin: true))
        XCTAssertFalse(noStock.stock || noStock.canAdjustStock)
        let noFinance = try XCTUnwrap(ErpAccess.of(modules: allParts.subtracting(["erp-financeiro"]), grants: [], isAdmin: true))
        XCTAssertFalse(noFinance.bills || noFinance.customerBills)
    }

    func testGrantsComeFromTheAreaInCapabilities() throws {
        let json = try JSONSerialization.jsonObject(with: Data(#"{"profiles":[{"id":"a","modules":[{"id":"erp"}],"grants":["erp:vendas","os:technician"]},{"id":"b","modules":[],"grants":["erp:admin"]}]}"#.utf8))
        XCTAssertEqual(ModuleCapabilities.grants(json, profileId: "a"), ["erp:vendas", "os:technician"])
        XCTAssertEqual(ModuleCapabilities.grants(json, profileId: "b"), ["erp:admin"])
        XCTAssertEqual(ModuleCapabilities.grants(["modules": ["erp"]], profileId: "a"), [])
    }

    @MainActor
    func testDemoCapabilitiesTurnTheGestaoOn() async {
        let snapshot = await ModulesProbe(baseURL: base, profileId: DemoMode.profileId, token: { "wabu_demo" }, session: QueueHTTP.makeSession()).snapshot()
        XCTAssertEqual(snapshot?.grants, ["erp:admin"])
        let access = ErpAccess.of(modules: snapshot?.modules ?? [], grants: snapshot?.grants ?? [], isAdmin: false)
        XCTAssertEqual(access?.role, .admin)
        XCTAssertTrue(access?.quickOrder == true && access?.bills == true && access?.canAdjustStock == true)
    }

    // MARK: Números

    func testQuantitiesAreTypedTheBrazilianWay() {
        XCTAssertEqual(ErpNumbers.quantity("1,5"), "1.5")
        XCTAssertEqual(ErpNumbers.quantity(" 2 "), "2")
        XCTAssertEqual(ErpNumbers.quantity("1.234,5"), "1234.5")
        XCTAssertNil(ErpNumbers.quantity("0"))
        XCTAssertNil(ErpNumbers.quantity("-1"))
        XCTAssertNil(ErpNumbers.quantity("1,1234567"))
        XCTAssertNil(ErpNumbers.quantity("abc"))
        XCTAssertEqual(ErpNumbers.showQuantity("12.500000"), "12,5")
        XCTAssertEqual(ErpNumbers.showQuantity("-3.000000"), "-3")
        XCTAssertEqual(ErpNumbers.showQuantity("0.000000"), "0")
    }

    func testPricesKeepTheServerPrecision() {
        XCTAssertEqual(ErpNumbers.unitPrice("18.9000"), "18.9")
        XCTAssertEqual(ErpNumbers.unitPrice("10"), "10.00")
        XCTAssertEqual(ErpNumbers.unitPrice("0.12345678906"), "0.1234567891")
        XCTAssertNil(ErpNumbers.unitPrice(nil))
        XCTAssertEqual(ErpNumbers.priceCents("18.9000"), 1890)
    }

    func testOrderTotalsMatchTheServerRounding() throws {
        XCTAssertEqual(ErpNumbers.lineCents("3", "18.9"), 5670)
        XCTAssertEqual(ErpNumbers.lineCents("0.333", "10.00"), 333)
        XCTAssertEqual(ErpNumbers.lineCents("1", "0.005"), 1)
        XCTAssertEqual(ErpNumbers.lineCents("1", "0.0049"), 0)
        XCTAssertEqual(ErpNumbers.discountCents(5670, "10.0000", percent: true), 567)
        XCTAssertEqual(ErpNumbers.discountCents(5670, "33.3333", percent: true), 1890)
        XCTAssertEqual(ErpNumbers.discountCents(5670, "5.00", percent: false), 500)
        XCTAssertEqual(ErpNumbers.discountValue("5", percent: false), "5.00")
        XCTAssertEqual(ErpNumbers.discountValue("10,5", percent: true), "10.5000")
        XCTAssertNil(ErpNumbers.discountValue("101", percent: true))
        XCTAssertEqual(ErpNumbers.discountValue("", percent: false), "0.00")

        let cafe = ErpProduct(id: "p1", name: "Café", unit: "PCT", price: "18.9000")
        let arroz = ErpProduct(id: "p2", name: "Arroz", unit: "PCT", price: "27.9000")
        let totals = try XCTUnwrap(ErpOrderTotals.of([ErpCartLine(product: cafe, quantity: "2"), ErpCartLine(product: arroz, quantity: "1.5")], discount: "10.0000", percent: true))
        XCTAssertEqual(totals.subtotal, 3780 + 4185)
        XCTAssertEqual(totals.discount, 797)
        XCTAssertEqual(totals.total, 3780 + 4185 - 797)
        XCTAssertFalse(try XCTUnwrap(ErpOrderTotals.of([ErpCartLine(product: cafe, quantity: "1")], discount: "20.00", percent: false)).valid)
        XCTAssertNil(ErpOrderTotals.of([ErpCartLine(product: ErpProduct(id: "p3", name: "Sem preço"), quantity: "1")], discount: "0.00", percent: false))
    }

    // MARK: Corpos das escritas (as chaves fechadas da erp-api)

    func testStockMovementSendsTheBalanceVersionEvenWhenZero() throws {
        let body = ErpBodies.stockMovement(key: "wabotia-6f1c1c1e-0000-4000-8000-000000000001", direction: .entrada, day: "2026-11-21", reason: "Contagem",
                                           productId: "p", warehouseId: "w", quantity: "5", version: 0).compactMapValues { $0 }
        XCTAssertEqual(Set(body.keys), ["command_id", "kind", "occurred_on", "reason", "items"])
        XCTAssertEqual(body["command_id"] as? String, "6f1c1c1e-0000-4000-8000-000000000001")
        XCTAssertEqual(body["kind"] as? String, "receipt")
        let line = try XCTUnwrap((body["items"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(line.keys), ["product_id", "warehouse_id", "quantity", "expected_version"])
        XCTAssertEqual(line["expected_version"] as? Int, 0)
        let out = ErpBodies.stockMovement(key: "k", direction: .saida, day: "2026-11-21", reason: "Avaria", productId: "p", warehouseId: "w", quantity: "2", version: 3)
        XCTAssertEqual(((out["items"] as? [[String: Any]])?.first?["quantity"]) as? String, "-2")
        XCTAssertEqual(out["kind"] as? String, "issue")
    }

    func testQuickOrderAlwaysSendsTheDiscount() throws {
        let line = ErpCartLine(product: ErpProduct(id: "p", name: "Café", unit: "PCT", price: "18.9000"), quantity: "1")
        let plain = ErpBodies.order(key: "c", day: "2026-11-21", contactId: "ct", lines: [line], discountValue: "0.00", percent: false, total: 1890, method: nil)
        let data = try XCTUnwrap(plain["data"] as? [String: Any])
        XCTAssertEqual(data["discount_mode"] as? String, "amount")
        XCTAssertEqual(data["discount_value"] as? String, "0.00")
        XCTAssertNil(data["installments"], "sem forma escolhida, sem parcela")
        let item = try XCTUnwrap((data["items"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(item.keys), ["product_id", "description", "unit", "quantity", "unit_price"])
        XCTAssertEqual(item["unit_price"] as? String, "18.9")
        let withPayment = ErpBodies.order(key: "c", day: "2026-11-21", contactId: "ct", lines: [line], discountValue: "10.0000", percent: true, total: 1701,
                                          method: ErpPaymentMethod(id: "m", description: "Pix", paymentType: "17", isDefault: false))
        let installment = try XCTUnwrap(((withPayment["data"] as? [String: Any])?["installments"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(installment.keys), ["due_date", "amount", "method", "payment_method_id"])
        XCTAssertEqual(installment["amount"] as? String, "17.01")
    }

    func testQuickCustomerAndSettleBodiesAreExact() throws {
        let contact = try XCTUnwrap(ErpBodies.quickContact(key: "c", name: "Maria", personType: "F", document: nil, mobile: nil, email: nil)["data"] as? [String: Any])
        XCTAssertEqual(Set(contact.keys), ["name", "person_type", "situation", "taxpayer", "types"])
        XCTAssertEqual(contact["situation"] as? String, "A")
        XCTAssertEqual(contact["taxpayer"] as? String, "9")
        XCTAssertEqual(contact["types"] as? [String], ["customer"])
        let title = ErpTitle(id: "t", kind: "receivable", balanceCents: "4137", version: 2)
        let settle = try XCTUnwrap(ErpBodies.settle(key: "k", title: title, accountId: "a", day: "2026-11-21")["data"] as? [String: Any])
        XCTAssertEqual(Set(settle.keys), ["id", "expected_version", "account_id", "posted_on", "principal_cents"])
        XCTAssertEqual(settle["principal_cents"] as? String, "4137")
        XCTAssertEqual(settle["expected_version"] as? Int, 2)
    }

    // MARK: Textos

    func testRefusalsAreSaidInWords() {
        let off = ErpText.message(QueueError(status: 409, code: "module_disabled", message: "Esta rotina depende de uma parte desligada."), part: ErpParts.finance)
        XCTAssertTrue(off.contains("Financeiro") && off.contains("Gestão → Módulos"), off)
        XCTAssertTrue(ErpText.message(QueueError(status: 403, code: "ERP_FORBIDDEN", message: "Sem permissão para esta ação na fila.")).contains("papel no ERP"))
        XCTAssertTrue(ErpText.message(QueueError(status: 409, code: "ERP_CONFLICT", message: "O Wabotia recusou (409).")).contains("mudou"))
        XCTAssertEqual(ErpText.message(QueueError(status: 0, code: QueueError.network, message: "Sem conexão com o Wabotia.")), ErpText.offlineRead)
        XCTAssertEqual(ErpText.message(QueueError(status: 409, code: "erp_conversa_blocked", message: "Conecte uma linha.")), "Conecte uma linha.")
        let unknown = ErpText.message(QueueError(status: 400, code: "ERP_ALGO_NOVO", message: "O Wabotia recusou (400)."))
        XCTAssertFalse(unknown.contains("Não foi possível concluir"))
        XCTAssertTrue(unknown.contains("ERP_ALGO_NOVO"))
    }

    func testPhonesOpenTheDialerAndWhatsapp() {
        XCTAssertEqual(ErpText.whatsappURL("(20) 90000-1101")?.absoluteString, "https://wa.me/5520900001101")
        XCTAssertEqual(ErpText.whatsappURL("+55 20 90000-1101")?.absoluteString, "https://wa.me/5520900001101")
        XCTAssertEqual(ErpText.dialURL("(20) 90000-1101")?.absoluteString, "tel:20900001101")
        XCTAssertNil(ErpText.whatsappURL("123"))
        XCTAssertNil(ErpText.dialURL(nil))
    }

    func testBarcodeMatchesTheExactProduct() {
        let list = [ErpProduct(id: "a", name: "Café 250 g", code: "2000000000015X", gtin: "2000000000022"), ErpProduct(id: "b", name: "Café 500 g", gtin: "2000000000015")]
        XCTAssertEqual(ErpText.exactBarcode(list, "2000000000015")?.id, "b")
        XCTAssertEqual(ErpText.exactBarcode(list, "2000000000015X")?.id, "a")
        XCTAssertNil(ErpText.exactBarcode(list, "999"))
        XCTAssertNil(ErpText.barcode("  "))
        XCTAssertNil(ErpText.barcode("12\n34"))
        XCTAssertEqual(ErpText.barcode(" 2000000000015 "), "2000000000015")
    }

    // MARK: Sem conexão

    func testOfflineReadsShowTheLastCopyAndNeverQueue() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("erp-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = ErpCache(store: PrivateFileStore(directory: folder), profileId: "area")
        let key = ErpClient.cacheKey("erp/v1/cadastros/contatos", ["page": "1", "size": "30", "q": nil, "sort": nil])
        cache.save(key, body: Data(#"{"items":[{"id":"c1","name":"Mariana Costa"}],"page":1,"total":1}"#.utf8), now: Date(timeIntervalSince1970: 1))
        StubURLProtocol.reset { _ in .networkFailure }
        let offline = ErpClient(api: ProfileAPI(baseURL: "https://erp.wabotia.example", profileId: "area", session: StubURLProtocol.session()) { "wabu_x" }, cache: cache)
        let read = try await offline.customers("")
        XCTAssertEqual(read.offlineAt, 1000)
        XCTAssertEqual(read.value.items.first?.name, "Mariana Costa")
        do {
            _ = try await offline.customer("c1")
            XCTFail("sem cópia deveria falhar")
        } catch { XCTAssertEqual((error as? QueueError)?.status, 0) }
        let before = try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
        do {
            try await offline.settle(ErpBodies.settle(key: "k", title: ErpTitle(id: "t", balanceCents: "100", version: 1), accountId: "a", day: "2026-11-21"), key: "k")
            XCTFail("escrita sem conexão deveria falhar")
        } catch { XCTAssertTrue(ErpText.isOffline(error)) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted(), before, "nada fica enfileirado")
        cache.clear()
        XCTAssertNil(cache.entry(key))
    }

    func testCacheKeepsTheNewestCopies() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("erp-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = ErpCache(store: PrivateFileStore(directory: folder), profileId: "p", maxEntries: 2)
        cache.save("a", body: Data("{}".utf8))
        cache.save("b", body: Data("{}".utf8))
        cache.save("c", body: Data("{}".utf8))
        XCTAssertNil(cache.entry("a"))
        XCTAssertNotNil(cache.entry("c"))
        XCTAssertNil(ErpCache(store: PrivateFileStore(directory: folder), profileId: "outra").entry("c"))
    }

    // MARK: Demonstração

    func testDemoCustomersProductsAndStock() async throws {
        let client = demo
        let found = try await client.customers("mariana").value.items
        XCTAssertEqual(found.map(\.name), ["Mariana Costa"])
        let record = try await client.customer(found[0].id).value.record
        XCTAssertEqual(record.mobile, "(20) 90000-1101")
        let orders = try await client.customerOrders(record.id).value.items ?? []
        XCTAssertFalse(orders.isEmpty)
        let bills = try await client.customerBills(record.id, name: record.name).value
        XCTAssertTrue(bills.allSatisfy { $0.contactId == record.id })

        let createdBody = ErpBodies.quickContact(key: "wabotia-\(UUID().uuidString.lowercased())", name: "Cliente Novo Exemplo", personType: "F",
                                                 document: nil, mobile: "(20) 90000-1199", email: nil)
        let created = try await client.createCustomer(createdBody, key: "k1").record
        XCTAssertEqual(created.name, "Cliente Novo Exemplo")

        let byBarcode = try await client.products("2000000000015").value.items ?? []
        XCTAssertEqual(byBarcode.count, 1)
        let cafe = try XCTUnwrap(byBarcode.first)
        XCTAssertEqual(cafe.name, "Café torrado e moído 500 g")
        let before = try await client.stock(cafe.id).value.items ?? []
        let loja = try XCTUnwrap(before.first { $0.isDefault })
        XCTAssertEqual(ErpNumbers.showQuantity(loja.quantity), "24")
        let key = "wabotia-\(UUID().uuidString.lowercased())"
        let body = ErpBodies.stockMovement(key: key, direction: .saida, day: BrasiliaTime.today(), reason: "Avaria na prateleira",
                                           productId: cafe.id, warehouseId: loja.warehouseId, quantity: "4", version: loja.version ?? 0)
        try await client.moveStock(body, key: key)
        try await client.moveStock(body, key: key) // O mesmo comando repetido não lança de novo.
        let after = try await client.stock(cafe.id).value.items ?? []
        XCTAssertEqual(ErpNumbers.showQuantity(after.first { $0.isDefault }?.quantity), "20")
        let stale = ErpBodies.stockMovement(key: "wabotia-\(UUID().uuidString.lowercased())", direction: .saida, day: BrasiliaTime.today(), reason: "Avaria",
                                            productId: cafe.id, warehouseId: loja.warehouseId, quantity: "1", version: loja.version ?? 0)
        do {
            try await client.moveStock(stale, key: "k2")
            XCTFail("versão velha deveria ser recusada")
        } catch { XCTAssertEqual((error as? QueueError)?.status, 409) }
    }

    func testDemoQuickOrderBillsAndWhatsapp() async throws {
        let client = demo
        let customers = try await client.customers("padaria").value.items
        let customer = try XCTUnwrap(customers.first)
        let found = try await client.products("café").value.items ?? []
        let cafe = try XCTUnwrap(found.first)
        let methods = try await client.paymentOptions().value.methods ?? []
        let method = try XCTUnwrap(methods.first { $0.isDefault == true })
        let lines = [ErpCartLine(product: cafe, quantity: "3")]
        let totals = try XCTUnwrap(ErpOrderTotals.of(lines, discount: "5.00", percent: false))
        XCTAssertEqual(totals.total, 5670 - 500)
        let today = BrasiliaTime.today()
        let key = "wabotia-\(UUID().uuidString.lowercased())"
        let request = ErpBodies.order(key: key, day: today, contactId: customer.id, lines: lines, discountValue: "5.00", percent: false, total: totals.total, method: method)
        let saved = try await client.createOrder(request, key: key)
        XCTAssertEqual(saved.document.status, "open")
        let replay = try await client.createOrder(request, key: key)
        XCTAssertEqual(replay.document.id, saved.document.id, "o mesmo comando devolve o mesmo pedido")

        let preview = try await client.sendPreview(saved.document.id)
        XCTAssertTrue(preview.canSend)
        let digits = try XCTUnwrap(preview.destino?.digitos)
        XCTAssertNotNil(digits.range(of: #"^552090\d{7}$"#, options: .regularExpression))
        try await client.sendOrder(saved.document.id, phone: digits, line: preview.destino?.linha ?? "", key: "envio-1")

        let receivable = try await client.titles(kind: "receivable", option: "open", from: today, to: today).value.items ?? []
        let fromOrder = try XCTUnwrap(receivable.first { $0.description == "Pedido \(saved.document.number ?? "")" })
        XCTAssertEqual(fromOrder.balance, totals.total)
        let overdue = try await client.titles(kind: "payable", option: "overdue").value.items ?? []
        XCTAssertFalse(overdue.isEmpty)
        XCTAssertTrue(overdue.allSatisfy { $0.overdue == true })

        let accounts = try await client.accounts().value.items ?? []
        let account = try XCTUnwrap(accounts.first)
        let settleKey = "wabotia-\(UUID().uuidString.lowercased())"
        try await client.settle(ErpBodies.settle(key: settleKey, title: fromOrder, accountId: account.id, day: today), key: settleKey)
        let open = try await client.titles(kind: "receivable", option: "open", from: today, to: today).value.items ?? []
        XCTAssertFalse(open.contains { $0.id == fromOrder.id })
    }

    func testDemoDataIsFictitious() async throws {
        let client = demo
        let customers = try await client.customers("").value.items
        let products = try await client.products("").value.items ?? []
        for c in customers {
            if let email = c.email { XCTAssertTrue(email.hasSuffix(".example"), email) }
            for phone in [c.mobile, c.phone].compactMap({ $0 }) { XCTAssertTrue(phone.hasPrefix("(20) "), phone) }
            if let mobile = c.mobile { XCTAssertTrue(mobile.hasPrefix("(20) 9"), mobile) }
        }
        for p in products { if let gtin = p.gtin { XCTAssertTrue(gtin.hasPrefix("20"), "GTIN da faixa interna: \(gtin)") } }
        XCTAssertFalse((customers.map(\.name) + products.map(\.name)).contains { $0.localizedCaseInsensitiveContains("Fagoo") || $0.contains("Origin") })
        XCTAssertNotNil(DemoErp.id("cli-mariana").range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#, options: .regularExpression))
    }
}
