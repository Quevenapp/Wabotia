package br.com.queven.wabotia.modules

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoErp
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.erp.ErpAccess
import br.com.queven.wabotia.modules.erp.ErpCache
import br.com.queven.wabotia.modules.erp.ErpCartLine
import br.com.queven.wabotia.modules.erp.ErpClient
import br.com.queven.wabotia.modules.erp.ErpContactPage
import br.com.queven.wabotia.modules.erp.ErpInstallmentBody
import br.com.queven.wabotia.modules.erp.ErpNumbers
import br.com.queven.wabotia.modules.erp.ErpOrderData
import br.com.queven.wabotia.modules.erp.ErpOrderItemBody
import br.com.queven.wabotia.modules.erp.ErpOrderRequest
import br.com.queven.wabotia.modules.erp.ErpOrderTotals
import br.com.queven.wabotia.modules.erp.ErpParts
import br.com.queven.wabotia.modules.erp.ErpProduct
import br.com.queven.wabotia.modules.erp.ErpRole
import br.com.queven.wabotia.modules.erp.ErpSendRequest
import br.com.queven.wabotia.modules.erp.ErpSettleData
import br.com.queven.wabotia.modules.erp.ErpSettleRequest
import br.com.queven.wabotia.modules.erp.ErpStockLine
import br.com.queven.wabotia.modules.erp.ErpStockMovementRequest
import br.com.queven.wabotia.modules.erp.ErpText
import br.com.queven.wabotia.modules.os.MemoryWorkCacheStorage
import br.com.queven.wabotia.queue.ModuleCapabilities
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.queueHttp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** Gestão (ERP) nos aplicativos: papéis e partes, contas exatas do pedido, mensagens, cópia sem conexão e a demonstração. */
class ErpTest {
    private val allParts = setOf("erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro", "queue")

    // ------------------------------------------------------------------ papéis e partes

    @Test fun gestaoNeedsTheErpAndARole() {
        assertNull("ERP desligado", ErpAccess.of(setOf("queue", "os"), setOf("erp:vendas"), isAdmin = false))
        assertNull("sem papel do ERP", ErpAccess.of(allParts, setOf("os:technician"), isAdmin = false))
        assertEquals(ErpRole.ADMIN, ErpAccess.of(allParts, emptySet(), isAdmin = true)?.role)
        // O administrador do Wabotia vale erp:admin no ERP, mesmo com outro papel marcado.
        assertEquals(ErpRole.ADMIN, ErpAccess.of(allParts, setOf("erp:consulta"), isAdmin = true)?.role)
    }

    @Test fun eachRoleSeesItsItems() {
        val vendas = ErpAccess.of(allParts, setOf("erp:vendas"), false)!!
        assertTrue(vendas.customers && vendas.products && vendas.quickOrder && vendas.canCreateCustomer)
        assertFalse(vendas.bills || vendas.canSettle || vendas.canAdjustStock)

        val financeiro = ErpAccess.of(allParts, setOf("erp:financeiro"), false)!!
        assertTrue(financeiro.bills && financeiro.canSettle && financeiro.customers)
        assertFalse(financeiro.products || financeiro.quickOrder)

        val estoque = ErpAccess.of(allParts, setOf("erp:estoque"), false)!!
        assertTrue(estoque.products && estoque.stock && estoque.canAdjustStock)
        assertFalse(estoque.quickOrder || estoque.bills)

        val consulta = ErpAccess.of(allParts, setOf("erp:consulta"), false)!!
        assertTrue(consulta.bills && consulta.products && consulta.customerOrders)
        assertFalse(consulta.canSettle || consulta.canAdjustStock || consulta.canCreateCustomer || consulta.quickOrder)
    }

    @Test fun partOffHidesItsItem() {
        val noSales = ErpAccess.of(allParts - "erp-vendas", setOf("erp:admin"), false)!!
        assertFalse(noSales.quickOrder)
        assertFalse(noSales.customerOrders)
        assertTrue(noSales.products)
        val noStock = ErpAccess.of(allParts - "erp-estoque", emptySet(), true)!!
        assertFalse(noStock.stock || noStock.canAdjustStock)
        val noFinance = ErpAccess.of(allParts - "erp-financeiro", emptySet(), true)!!
        assertFalse(noFinance.bills || noFinance.customerBills)
        // Financeiro sem a parte Financeiro: nada para mostrar, a Gestão some.
        assertNull(ErpAccess.of(setOf("erp", "erp-produtos"), setOf("erp:financeiro"), false)?.takeIf { it.bills })
    }

    @Test fun grantsComeFromTheAreaInCapabilities() {
        val json = WabotiaJson.parseToJsonElement(
            """{"profiles":[{"id":"a","modules":[{"id":"erp"}],"grants":["erp:vendas","os:technician"]},{"id":"b","modules":[],"grants":["erp:admin"]}]}""",
        )
        assertEquals(setOf("erp:vendas", "os:technician"), ModuleCapabilities.grants(json, "a"))
        assertEquals(setOf("erp:admin"), ModuleCapabilities.grants(json, "b"))
        assertEquals(emptySet<String>(), ModuleCapabilities.grants(WabotiaJson.parseToJsonElement("""{"modules":["erp"]}"""), "a"))
    }

    // ------------------------------------------------------------------ números

    @Test fun quantitiesAreTypedTheBrazilianWay() {
        assertEquals("1.5", ErpNumbers.quantity("1,5"))
        assertEquals("2", ErpNumbers.quantity(" 2 "))
        assertEquals("1234.5", ErpNumbers.quantity("1.234,5"))
        assertNull(ErpNumbers.quantity("0"))
        assertNull(ErpNumbers.quantity("-1"))
        assertNull(ErpNumbers.quantity("1,1234567"))
        assertNull(ErpNumbers.quantity("abc"))
        assertEquals("12,5", ErpNumbers.showQuantity("12.500000"))
        assertEquals("-3", ErpNumbers.showQuantity("-3.000000"))
        assertEquals("0", ErpNumbers.showQuantity("0.000000"))
    }

    @Test fun pricesKeepTheServerPrecision() {
        assertEquals("18.9", ErpNumbers.unitPrice("18.9000"))
        assertEquals("10.00", ErpNumbers.unitPrice("10"))
        assertEquals("0.1234567891", ErpNumbers.unitPrice("0.12345678906"))
        assertNull(ErpNumbers.unitPrice(null))
        assertEquals(1890L, ErpNumbers.priceCents("18.9000"))
    }

    @Test fun orderTotalsMatchTheServerRounding() {
        // Quantidade × preço exato, meio para cima, item a item (packages/erp-domain calculateDocument).
        assertEquals(5670L, ErpNumbers.lineCents("3", "18.9"))
        assertEquals(333L, ErpNumbers.lineCents("0.333", "10.00"))
        assertEquals(1L, ErpNumbers.lineCents("1", "0.005"))
        assertEquals(0L, ErpNumbers.lineCents("1", "0.0049"))
        // Desconto percentual sobre o subtotal, com 4 casas e meio para cima.
        assertEquals(567L, ErpNumbers.discountCents(5670, "10.0000", percent = true))
        assertEquals(1890L, ErpNumbers.discountCents(5670, "33.3333", percent = true))
        assertEquals(500L, ErpNumbers.discountCents(5670, "5.00", percent = false))
        assertEquals("5.00", ErpNumbers.discountValue("5", percent = false))
        assertEquals("10.5000", ErpNumbers.discountValue("10,5", percent = true))
        assertNull(ErpNumbers.discountValue("101", percent = true))
        assertEquals("0.00", ErpNumbers.discountValue("", percent = false))

        val cafe = ErpProduct("p1", "Café", price = "18.9000", unit = "PCT")
        val arroz = ErpProduct("p2", "Arroz", price = "27.9000", unit = "PCT")
        val totals = ErpOrderTotals.of(listOf(ErpCartLine(cafe, "2"), ErpCartLine(arroz, "1.5")), "10.0000", percent = true)!!
        assertEquals(3780L + 4185L, totals.subtotal)
        assertEquals(797L, totals.discount)
        assertEquals(totals.subtotal - 797L, totals.total)
        assertFalse(ErpOrderTotals.of(listOf(ErpCartLine(cafe, "1")), "20.00", percent = false)!!.valid)
        assertNull(ErpOrderTotals.of(listOf(ErpCartLine(ErpProduct("p3", "Sem preço"), "1")), "0.00", false))
    }

    // ------------------------------------------------------------------ textos

    @Test fun refusalsAreSaidInWords() {
        val off = ErpText.message(QueueException(409, "module_disabled", "Esta rotina depende de uma parte desligada."), ErpParts.FINANCE)
        assertTrue(off, off.contains("Financeiro") && off.contains("Gestão → Módulos"))
        val role = ErpText.message(QueueException(403, "ERP_FORBIDDEN", "O Wabotia recusou (403)."))
        assertTrue(role, role.contains("papel no ERP"))
        val conflict = ErpText.message(QueueException(409, "ERP_CONFLICT", "O Wabotia recusou (409)."))
        assertTrue(conflict, conflict.contains("mudou"))
        assertEquals(ErpText.OFFLINE_READ, ErpText.message(QueueException(0, QueueException.NETWORK, "Sem conexão com o Wabotia.")))
        // Mensagem própria do servidor (rotas do núcleo) vale como veio.
        assertEquals("Conecte uma linha.", ErpText.message(QueueException(409, "erp_conversa_blocked", "Conecte uma linha.")))
        val unknown = ErpText.message(QueueException(400, "ERP_ALGO_NOVO", "O Wabotia recusou (400)."))
        assertFalse(unknown, unknown.contains("Não foi possível concluir"))
        assertTrue(unknown, unknown.contains("ERP_ALGO_NOVO"))
    }

    @Test fun phonesOpenTheDialerAndWhatsapp() {
        assertEquals("https://wa.me/5520900001101", ErpText.whatsappUri("(20) 90000-1101"))
        assertEquals("https://wa.me/5520900001101", ErpText.whatsappUri("+55 20 90000-1101"))
        assertEquals("tel:20900001101", ErpText.dialUri("(20) 90000-1101"))
        assertNull(ErpText.whatsappUri("123"))
        assertNull(ErpText.dialUri(null))
    }

    @Test fun barcodeMatchesTheExactProduct() {
        val list = listOf(ErpProduct("a", "Café 250 g", code = "2000000000015X", gtin = "2000000000022"), ErpProduct("b", "Café 500 g", gtin = "2000000000015"))
        assertEquals("b", ErpText.exactBarcode(list, "2000000000015")?.id)
        assertEquals("a", ErpText.exactBarcode(list, "2000000000015X")?.id)
        assertNull(ErpText.exactBarcode(list, "999"))
        assertNull(ErpText.barcode("  "))
        assertNull(ErpText.barcode("12\n34"))
        assertEquals("2000000000015", ErpText.barcode(" 2000000000015 "))
    }

    // ------------------------------------------------------------------ sem conexão

    @Test fun offlineReadsShowTheLastCopyAndNeverQueue() = runBlocking {
        val storage = MemoryWorkCacheStorage()
        val cache = ErpCache(storage)
        val key = ErpClient.cacheKey("erp/v1/cadastros/contatos", mapOf("page" to "1", "size" to "30", "q" to null, "sort" to null))
        cache.save("area", key, """{"items":[{"id":"c1","name":"Mariana Costa"}],"page":1,"size":30,"total":1}""", now = 1_000L)
        // Porta fechada: falha de conexão, como sem internet.
        val offline = ErpClient(ProfileApi("http://127.0.0.1:1", "area", { "wabu_x" }), cache, "area")
        val read = offline.customers("")
        assertEquals(1_000L, read.offlineAt)
        assertEquals("Mariana Costa", read.value.items.single().name)
        // Leitura que nunca foi vista: sem cópia, a falha aparece.
        try {
            offline.customer("c1")
            fail("sem cópia deveria falhar")
        } catch (e: QueueException) {
            assertEquals(0, e.status)
        }
        // Escrita sem conexão falha e nada fica guardado para depois.
        val before = storage.files.toMap()
        try {
            offline.settle(ErpSettleRequest(UUID.randomUUID().toString(), ErpSettleData("t", 1, "a", "2026-11-21", "100")), "wabotia-k")
            fail("escrita sem conexão deveria falhar")
        } catch (e: QueueException) {
            assertTrue(ErpText.isOffline(e))
        }
        assertEquals(before, storage.files.toMap())
        cache.wipe()
        assertNull(cache.get("area", key))
    }

    @Test fun cacheKeepsTheNewestCopies() {
        val cache = ErpCache(MemoryWorkCacheStorage(), maxEntries = 2)
        cache.save("p", "a", "{}", 1)
        cache.save("p", "b", "{}", 2)
        cache.save("p", "c", "{}", 3)
        assertNull(cache.get("p", "a"))
        assertNotNull(cache.get("p", "c"))
        assertNull(cache.get("outra", "c"))
        // Resposta sem os campos opcionais (servidor mais antigo) decodifica com os padrões.
        assertTrue(WabotiaJson.decodeFromString(ErpContactPage.serializer(), "{}").items.isEmpty())
    }

    // ------------------------------------------------------------------ demonstração

    private lateinit var client: ErpClient

    @Before fun fresh() {
        DemoServer.reset()
        client = ErpClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, queueHttp()), null, Ids.PROFILE)
    }

    @Test fun demoCustomersProductsAndStock() = runBlocking {
        val found = client.customers("mariana").value.items
        assertEquals("Mariana Costa", found.single().name)
        val record = client.customer(found.single().id).value.record
        assertEquals("(20) 90000-1101", record.mobile)
        assertTrue(client.customerOrders(record.id).value.items.isNotEmpty())
        assertTrue(client.customerBills(record.id, record.name).value.all { it.contactId == record.id })

        val created = client.createCustomer(
            br.com.queven.wabotia.modules.erp.ErpQuickContactRequest(UUID.randomUUID().toString(), br.com.queven.wabotia.modules.erp.ErpQuickContactData("Cliente Novo Exemplo", "F", mobile = "(20) 90000-1199")),
            "wabotia-${UUID.randomUUID()}",
        ).record
        assertEquals("Cliente Novo Exemplo", created.name)

        val cafe = client.products("2000000000015").value.items.single()
        assertEquals("Café torrado e moído 500 g", cafe.name)
        val loja = client.stock(cafe.id).value.items.first { it.warehouseDefault }
        assertEquals("24", ErpNumbers.showQuantity(loja.quantity))
        val command = UUID.randomUUID().toString()
        val body = ErpStockMovementRequest(command, "issue", "2026-11-21", "Avaria na prateleira", listOf(ErpStockLine(cafe.id, loja.warehouseId, "-4", loja.version)))
        client.moveStock(body, "wabotia-$command")
        // O mesmo comando repetido (rede caiu antes da resposta) não lança de novo.
        client.moveStock(body, "wabotia-$command")
        val after = client.stock(cafe.id).value.items.first { it.warehouseDefault }
        assertEquals("20", ErpNumbers.showQuantity(after.quantity))
        // Versão velha: o ERP recusa e o saldo não muda.
        try {
            client.moveStock(body.copy(commandId = UUID.randomUUID().toString()), "wabotia-${UUID.randomUUID()}")
            fail("versão velha deveria ser recusada")
        } catch (e: QueueException) {
            assertEquals(409, e.status)
        }
    }

    @Test fun demoQuickOrderBillsAndWhatsapp() = runBlocking {
        val customer = client.customers("padaria").value.items.single()
        val cafe = client.products("café").value.items.single()
        val method = client.paymentOptions().value.methods.first { it.isDefault }
        val totals = ErpOrderTotals.of(listOf(ErpCartLine(cafe, "3")), "5.00", percent = false)!!
        assertEquals(5670L - 500L, totals.total)
        val command = UUID.randomUUID().toString()
        val request = ErpOrderRequest(
            command,
            ErpOrderData(
                "2026-11-21", customer.id,
                listOf(ErpOrderItemBody(cafe.id, cafe.name, cafe.code, cafe.unitText, "3", ErpNumbers.unitPrice(cafe.price)!!)),
                "amount", "5.00",
                listOf(ErpInstallmentBody("2026-11-21", ErpNumbers.centsText(totals.total), method.description, method.id)),
            ),
        )
        val saved = client.createOrder(request, "wabotia-$command")
        assertEquals("open", saved.document.status)
        assertEquals(saved.document.id, client.createOrder(request, "wabotia-$command").document.id)

        val preview = client.sendPreview(saved.document.id)
        assertTrue(preview.canSend)
        assertTrue(preview.destino!!.digitos.matches(Regex("""552090\d{7}""")))
        client.sendOrder(saved.document.id, ErpSendRequest(preview.destino!!.digitos, preview.destino!!.linha), "wabotia-${UUID.randomUUID()}")

        val today = BrasiliaTime.today()
        val receivable = client.titles("receivable", "open", today, today).value.items
        val fromOrder = receivable.first { it.description == "Pedido ${saved.document.number}" }
        assertEquals(totals.total, fromOrder.balance)
        assertTrue(client.titles("payable", "overdue").value.items.all { it.overdue })

        val account = client.accounts().value.items.first()
        val settleCommand = UUID.randomUUID().toString()
        client.settle(ErpSettleRequest(settleCommand, ErpSettleData(fromOrder.id, fromOrder.version, account.id, today, fromOrder.balanceCents)), "wabotia-$settleCommand")
        assertTrue(client.titles("receivable", "open", today, today).value.items.none { it.id == fromOrder.id })
    }

    @Test fun demoDataIsFictitious() {
        val ids = listOf("cli-mariana", "pro-cafe").map { DemoErp.id(it) }
        ids.forEach { assertTrue(it.matches(Regex("""[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"""))) }
        runBlocking {
            val all = buildString {
                client.customers("").value.items.forEach { append(it.toString()) }
                client.products("").value.items.forEach { append(it.toString()) }
            }
            Regex("""[\w.+-]+@[\w-]+(\.[\w-]+)+""").findAll(all).forEach { assertTrue("e-mail ${it.value}", it.value.endsWith(".example")) }
            Regex("""\(\d\d\) 9""").findAll(all).forEach { assertEquals("(20) 9", it.value) }
            // GTIN da faixa 20…, de uso interno: não é o código de nenhum produto real.
            Regex("""gtin=(\d+)""").findAll(all).forEach { assertTrue(it.groupValues[1].startsWith("20")) }
            assertFalse(all.contains("Fagoo", ignoreCase = true) || all.contains("Origin"))
        }
    }
}
