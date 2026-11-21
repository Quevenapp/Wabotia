package br.com.queven.wabotia.demo

import br.com.queven.wabotia.modules.BrasiliaTime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.math.BigDecimal
import java.util.UUID

/**
 * A Gestão (ERP) da demonstração, mesmo desenho do iOS (`Core/Demo/DemoErp.swift`): uma mercearia fictícia com clientes,
 * produtos (códigos de barras na faixa 20…, de uso interno, que não identifica produto de ninguém), dois depósitos,
 * pedidos de venda e contas a receber e a pagar vencendo hoje e vencidas. Responde nas rotas da erp-api
 * (`/erp/v1/…`) e do envio pelo WhatsApp (`/erp-conversa/pedido/…`), no formato do servidor. Telefones com DDD 20.
 */
internal class DemoErp(private val t0: Long) {
    private val today: String get() = BrasiliaTime.today(System.currentTimeMillis())
    private fun day(offset: Int) = BrasiliaTime.addDays(today, offset)

    private val customers = mutableListOf<JsonObject>()
    private val products = mutableListOf<JsonObject>()
    /** Saldo por produto e depósito: quantidade e versão. */
    private val stock = LinkedHashMap<Pair<String, String>, Pair<BigDecimal, Int>>()
    private val orders = mutableListOf<JsonObject>()
    private val titles = mutableListOf<JsonObject>()
    private val commands = HashMap<String, Reply>()
    private val sends = HashMap<String, Reply>()
    private var nextOrder = 1041

    private val warehouses = listOf("dep-loja" to "Loja", "dep-fundos" to "Depósito dos fundos")
    private val accounts = listOf(
        j("id" to id("conta-caixa"), "name" to "Caixa da loja", "kind" to "cash", "active" to true),
        j("id" to id("conta-banco"), "name" to "Banco Exemplo", "kind" to "bank", "active" to true),
    )
    private val methods = listOf(
        j("id" to id("forma-dinheiro"), "description" to "Dinheiro", "payment_type" to "01", "is_default" to true),
        j("id" to id("forma-pix"), "description" to "Pix", "payment_type" to "17", "is_default" to false),
        j("id" to id("forma-cartao"), "description" to "Cartão de crédito", "payment_type" to "03", "is_default" to false),
        j("id" to id("forma-boleto"), "description" to "Boleto", "payment_type" to "15", "is_default" to false),
    )

    init {
        fun customer(key: String, code: String, name: String, mobile: String?, email: String?, city: String, street: String, extra: Map<String, Any?> = emptyMap()) =
            customers.add(JsonObject(j(
                "id" to id(key), "entity" to "contacts", "version" to 1, "active" to true, "situation" to "A", "code" to code, "name" to name,
                "person_type" to "F", "document" to null, "trade_name" to null, "email" to email, "phone" to null, "mobile" to mobile,
                "postal_code" to "00000-000", "street" to street, "number" to "100", "complement" to null, "district" to "Centro", "city" to city, "state" to "SP",
                "created_at" to "2026-01-10T12:00:00Z", "updated_at" to "2026-01-10T12:00:00Z",
            ) + j(*extra.toList().toTypedArray())))
        customer("cli-mariana", "1", "Mariana Costa", "(20) 90000-1101", "mariana@cliente.example", "Cidade Exemplo", "Rua das Flores")
        customer("cli-joao", "2", "João Pereira", "(20) 90000-1102", null, "Cidade Exemplo", "Avenida Central")
        customer("cli-padaria", "3", "Padaria Pão Dourado", "(20) 90000-1103", "compras@padaria.example", "Vila Exemplo", "Rua do Comércio",
            mapOf("person_type" to "J", "trade_name" to "Pão Dourado", "phone" to "(20) 3000-1103"))
        customer("cli-fernanda", "4", "Fernanda Lima", "(20) 90000-1104", "fernanda@cliente.example", "Cidade Exemplo", "Travessa Azul")
        customer("cli-oficina", "5", "Oficina Roda Viva", null, "oficina@cliente.example", "Vila Exemplo", "Estrada Velha",
            mapOf("person_type" to "J", "phone" to "(20) 3000-1105"))
        customer("cli-paulo", "6", "Paulo Mendes", "(20) 90000-1106", null, "Cidade Exemplo", "Rua Nova")

        fun product(key: String, code: String, gtin: String?, name: String, unit: String, price: String, loja: String, fundos: String, brand: String? = null) {
            products.add(j(
                "id" to id(key), "entity" to "products", "version" to 1, "active" to true, "code" to code, "name" to name, "unit" to unit, "price" to price,
                "gtin" to gtin, "kind" to "P", "format" to "S", "brand" to brand, "description" to null, "created_at" to "2026-01-10T12:00:00Z", "updated_at" to "2026-01-10T12:00:00Z",
            ))
            stock[id(key) to id("dep-loja")] = BigDecimal(loja) to 3
            stock[id(key) to id("dep-fundos")] = BigDecimal(fundos) to 2
        }
        product("pro-cafe", "CAF500", "2000000000015", "Café torrado e moído 500 g", "PCT", "18.9000", "24", "60", "Marca Exemplo")
        product("pro-acucar", "ACU1", "2000000000022", "Açúcar cristal 1 kg", "PCT", "5.4900", "40", "120")
        product("pro-arroz", "ARR5", "2000000000039", "Arroz tipo 1 5 kg", "PCT", "27.9000", "15", "48")
        product("pro-feijao", "FEI1", "2000000000046", "Feijão carioca 1 kg", "PCT", "8.7900", "3", "30")
        product("pro-oleo", "OLE900", "2000000000053", "Óleo de soja 900 ml", "UN", "7.4900", "0", "36")
        product("pro-sabao", "SAB5", "2000000000060", "Sabão em barra (5 unidades)", "PCT", "11.5000", "12", "0")
        product("pro-detergente", "DET500", "2000000000077", "Detergente 500 ml", "UN", "2.9900", "-2", "24")
        product("pro-entrega", "ENT", null, "Entrega no bairro", "SV", "8.0000", "0", "0")

        fun order(customerKey: String, offset: Int, status: String, total: String) {
            orders.add(j("id" to UUID.nameUUIDFromBytes("pedido-${nextOrder}".toByteArray()).toString(), "number" to (nextOrder++).toString(), "date" to day(offset), "status" to status, "total" to total, "contact_id" to id(customerKey)))
        }
        order("cli-mariana", -12, "fulfilled", "86.40")
        order("cli-mariana", -3, "open", "41.37")
        order("cli-padaria", -20, "fulfilled", "512.00")
        order("cli-padaria", -1, "in_progress", "233.50")
        order("cli-joao", -7, "fulfilled", "27.90")

        fun title(key: String, kind: String, customerKey: String?, contactName: String, description: String, due: Int, cents: Long, installment: Int = 1, of: Int = 1) {
            titles.add(j(
                "id" to id(key), "kind" to kind, "contact_id" to id(customerKey ?: "for-$key"), "contact_name" to contactName,
                "description" to description, "due_on" to day(due), "issued_on" to day(due - 30), "amount_cents" to cents.toString(), "settled_cents" to "0",
                "balance_cents" to cents.toString(), "status" to "open", "overdue" to (due < 0), "version" to 1, "account_id" to null,
                "installment" to installment, "installments" to of, "cancelled" to false, "document_linked" to false, "category_name" to null,
            ))
        }
        title("tit-mariana-1", "receivable", "cli-mariana", "Mariana Costa", "Pedido 1042", 0, 4137)
        title("tit-padaria-1", "receivable", "cli-padaria", "Padaria Pão Dourado", "Pedido 1044 · parcela 1/2", 0, 11675, 1, 2)
        title("tit-padaria-2", "receivable", "cli-padaria", "Padaria Pão Dourado", "Pedido 1043", -5, 51200)
        title("tit-fernanda-1", "receivable", "cli-fernanda", "Fernanda Lima", "Venda no fiado", -2, 6390)
        title("tit-luz", "payable", null, "Companhia de Energia Exemplo", "Conta de luz", 0, 31245)
        title("tit-fornecedor", "payable", null, "Distribuidora Exemplo", "Compra de mercadoria", -1, 128900)
        title("tit-aluguel", "payable", null, "Imobiliária Exemplo", "Aluguel da loja", -4, 250000)
    }

    /** `/erp/…` e `/erp-conversa/…` da área. [r] começa em `erp` ou `erp-conversa`. */
    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?): Reply {
        if (r.firstOrNull() == "erp-conversa") return conversa(method, r.drop(1), body)
        val p = r.drop(1).let { if (it.firstOrNull() == "v1") it.drop(1) else return notFound() }
        return when {
            p == listOf("cadastros", "contatos") && method == "GET" -> contactPage(query)
            p == listOf("cadastros", "contatos") && method == "POST" -> command(body) { createContact(body) }
            p.size == 3 && p[0] == "cadastros" && p[1] == "contatos" -> customers.firstOrNull { it.str("id") == p[2] }?.let { ok(j("entity" to "contacts", "record" to it, "data_mode" to "erp_native", "replayed" to false)) } ?: notFound()
            p.size == 4 && p[0] == "cadastros" && p[1] == "contatos" && p[3] == "historico" -> ok(j(
                "scope" to "contact_sales", "contact_id" to p[2], "visible" to true, "data_mode" to "erp_native",
                "items" to orders.filter { it.str("contact_id") == p[2] }.sortedByDescending { it.str("date") }.take(10).map { o -> j("id" to o.str("id"), "number" to o.str("number"), "date" to o.str("date"), "status" to o.str("status"), "total" to o.str("total")) },
            ))
            p == listOf("cadastros", "products") && method == "GET" -> productList(query)
            p.size == 3 && p[0] == "cadastros" && p[1] == "products" -> products.firstOrNull { it.str("id") == p[2] }?.let { ok(j("entity" to "products", "record" to it, "data_mode" to "erp_native")) } ?: notFound()
            p.size == 3 && p[0] == "anexos-cadastros" && p[1] == "produtos" -> ok(j("product_id" to p[2], "items" to emptyList<Any>(), "pending" to emptyList<Any>(), "stored_bytes" to "0", "limit" to 20, "data_mode" to "erp_native"))
            p == listOf("estoque", "saldos") -> balances(query("product_id").orEmpty())
            p == listOf("estoque", "movimentos") && method == "POST" -> command(body) { moveStock(body) }
            p == listOf("documentos", "sales_orders", "pagamento") -> ok(j("kind" to "sales_orders", "methods" to methods, "data_mode" to "erp_native"))
            p == listOf("documentos", "sales_orders") && method == "POST" -> command(body) { createOrder(body) }
            p == listOf("financeiro", "titles") -> titlePage(query)
            p == listOf("financeiro", "accounts") -> ok(j("entity" to "accounts", "items" to accounts, "limit" to 100, "has_more" to false, "next_cursor" to null, "data_mode" to "erp_native"))
            p == listOf("financeiro", "actions", "settle") && method == "POST" -> command(body) { settle(body) }
            else -> notFound()
        }
    }

    private fun ok(value: JsonObject) = demoOk(value)
    private fun notFound() = demoFail(404, "ERP_NOT_FOUND", "Não encontrado no ERP da demonstração.")
    private fun invalid() = demoFail(400, "ERP_INVALID_QUERY", "Dados recusados pelo ERP da demonstração.")

    /** O mesmo `command_id` devolve a mesma resposta (como o ERP). */
    private fun command(body: JsonObject, run: () -> Reply): Reply {
        val key = body.str("command_id") ?: return invalid()
        commands[key]?.let { return it }
        return run().also { if (it.code < 500) commands[key] = it }
    }

    private fun contactPage(query: (String) -> String?): Reply {
        val q = query("q")?.trim()?.lowercase().orEmpty()
        val digits = q.filter(Char::isDigit)
        val page = query("page")?.toIntOrNull() ?: 1
        val size = query("size")?.toIntOrNull() ?: 100
        val found = customers.filter { c ->
            q.isEmpty() || c.str("name")?.lowercase()?.contains(q) == true || c.str("code") == q ||
                (digits.length >= 4 && listOf("mobile", "phone", "document").any { k -> c.str(k)?.filter(Char::isDigit)?.contains(digits) == true })
        }.let { list -> if (q.isEmpty()) list.reversed() else list.sortedBy { it.str("name") } }
        val slice = found.drop((page - 1) * size).take(size)
        return ok(j("entity" to "contacts", "items" to slice, "page" to page, "size" to size, "total" to found.size, "sort" to (query("sort") ?: "created_desc"), "situation" to "latest", "scoped" to false, "data_mode" to "erp_native"))
    }

    private fun createContact(body: JsonObject): Reply {
        val data = body["data"] as? JsonObject ?: return invalid()
        val name = data.str("name")?.trim()?.takeIf { it.isNotEmpty() } ?: return invalid()
        val document = data.str("document")
        if (document != null && customers.any { it.str("document")?.filter(Char::isLetterOrDigit) == document }) return demoFail(409, "ERP_CONTACT_DUPLICATE_DOCUMENT", "CPF/CNPJ já cadastrado.")
        val record = j(
            "id" to UUID.randomUUID().toString(), "entity" to "contacts", "version" to 1, "active" to true, "situation" to "A", "code" to (customers.size + 1).toString(),
            "name" to name, "person_type" to (data.str("person_type") ?: "F"), "document" to document, "trade_name" to null, "email" to data.str("email"),
            "phone" to data.str("phone"), "mobile" to data.str("mobile"), "postal_code" to null, "street" to null, "number" to null, "complement" to null,
            "district" to null, "city" to null, "state" to null, "roles" to listOf("customer"), "types" to listOf("customer"),
            "created_at" to "2026-11-21T12:00:00Z", "updated_at" to "2026-11-21T12:00:00Z",
        )
        customers.add(record)
        return ok(j("entity" to "contacts", "record" to record, "data_mode" to "erp_native", "replayed" to false))
    }

    private fun productList(query: (String) -> String?): Reply {
        val q = query("q")?.trim()?.lowercase().orEmpty()
        val limit = query("limit")?.toIntOrNull() ?: 25
        val found = products.filter { p -> q.isEmpty() || listOf("name", "code", "gtin").any { k -> p.str(k)?.lowercase()?.contains(q) == true } }.sortedBy { it.str("name") }
        return ok(j("entity" to "products", "items" to found.take(limit), "limit" to limit, "has_more" to (found.size > limit), "next_cursor" to null, "data_mode" to "erp_native"))
    }

    private fun balances(productId: String): Reply {
        val product = products.firstOrNull { it.str("id") == productId } ?: return notFound()
        val items = warehouses.map { (key, name) ->
            val (quantity, version) = stock[productId to id(key)] ?: (BigDecimal.ZERO to 0)
            j(
                "warehouse_id" to id(key), "warehouse_name" to name, "warehouse_active" to true, "quantity" to quantity.setScale(6).toPlainString(), "version" to version,
                "unit" to product.str("unit"), "warehouse_default" to (key == "dep-loja"), "warehouse_ignored" to false,
                "reserved_quantity" to if (key == "dep-loja" && productId == id("pro-arroz")) "2.000000" else "0.000000", "situation_reserved_quantity" to "0.000000",
            )
        }
        return ok(j("product_id" to productId, "items" to items, "reservation" to j(), "data_mode" to "erp_native"))
    }

    private fun moveStock(body: JsonObject): Reply {
        val reason = body.str("reason")?.trim().orEmpty()
        val items = (body["items"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return invalid()
        if (reason.length < 3 || items.isEmpty() || body.str("kind") !in setOf("receipt", "issue")) return invalid()
        val lines = items.map { line ->
            val key = line.str("product_id").orEmpty() to line.str("warehouse_id").orEmpty()
            val (quantity, version) = stock[key] ?: (BigDecimal.ZERO to 0)
            if ((line["expected_version"] as? JsonPrimitive)?.intOrNull != version) return demoFail(409, "ERP_CONFLICT", "O saldo mudou.")
            val delta = line.str("quantity")?.toBigDecimalOrNull() ?: return invalid()
            Triple(key, quantity + delta, version + 1)
        }
        lines.forEach { (key, quantity, version) -> stock[key] = quantity to version }
        return ok(j("movement" to j("id" to UUID.randomUUID().toString(), "kind" to body.str("kind"), "occurred_on" to body.str("occurred_on"), "reason" to reason), "replayed" to false, "data_mode" to "erp_native"))
    }

    private fun createOrder(body: JsonObject): Reply {
        val data = body["data"] as? JsonObject ?: return invalid()
        val contactId = data.str("contact_id") ?: return invalid()
        if (customers.none { it.str("id") == contactId }) return demoFail(400, "ERP_INVALID_QUERY", "Cliente não encontrado.")
        val items = (data["items"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
        if (items.isEmpty()) return invalid()
        val subtotal = items.sumOf { line ->
            (BigDecimal(line.str("quantity") ?: "0") * BigDecimal(line.str("unit_price") ?: "0")).setScale(2, java.math.RoundingMode.HALF_UP)
        }
        val discountValue = BigDecimal(data.str("discount_value") ?: "0")
        val discount = if (data.str("discount_mode") == "percent") (subtotal * discountValue / BigDecimal(100)).setScale(2, java.math.RoundingMode.HALF_UP) else discountValue
        if (discount > subtotal) return demoFail(400, "ERP_INVALID_QUERY", "Desconto maior que o subtotal.")
        val total = (subtotal - discount).setScale(2)
        val installments = (data["installments"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
        if (installments.isNotEmpty() && installments.sumOf { BigDecimal(it.str("amount") ?: "0") }.compareTo(total) != 0) return demoFail(400, "ERP_INVALID_QUERY", "Parcelas diferentes do total.")
        val number = (nextOrder++).toString()
        val order = j("id" to UUID.randomUUID().toString(), "number" to number, "date" to today, "status" to "open", "total" to total.toPlainString(), "contact_id" to contactId)
        orders.add(order)
        val name = customers.first { it.str("id") == contactId }.str("name").orEmpty()
        installments.forEach { row ->
            val cents = BigDecimal(row.str("amount") ?: "0").movePointRight(2).toLong().toString()
            titles.add(j(
                "id" to UUID.randomUUID().toString(), "kind" to "receivable", "contact_id" to contactId, "contact_name" to name, "description" to "Pedido $number",
                "due_on" to (row.str("due_date") ?: today), "issued_on" to today, "amount_cents" to cents, "settled_cents" to "0",
                "balance_cents" to cents, "status" to "open", "overdue" to false, "version" to 1, "account_id" to null,
                "installment" to 1, "installments" to 1, "cancelled" to false, "document_linked" to true, "category_name" to null,
            ))
        }
        return ok(j("kind" to "sales_orders", "document" to j("id" to order.str("id"), "kind" to "sales_orders", "number" to number, "status" to "open", "version" to 1), "replayed" to false, "data_mode" to "erp_native"))
    }

    private fun titlePage(query: (String) -> String?): Reply {
        val kind = query("kind") ?: return invalid()
        val option = query("option") ?: "open"
        val from = query("from")
        val to = query("to")
        val q = query("q")?.trim()?.lowercase().orEmpty()
        val found = titles.filter { t ->
            t.str("kind") == kind && t.str("status") in setOf("open", "partial") &&
                (option != "overdue" || t.str("due_on").orEmpty() < today) &&
                (from == null || t.str("due_on").orEmpty() >= from) && (to == null || t.str("due_on").orEmpty() <= to) &&
                (q.isEmpty() || t.str("contact_name")?.lowercase()?.contains(q) == true || t.str("description")?.lowercase()?.contains(q) == true)
        }.sortedBy { it.str("due_on") }.map { JsonObject(it + ("overdue" to JsonPrimitive(it.str("due_on").orEmpty() < today))) }
        val amount = found.sumOf { it.str("amount_cents")?.toLongOrNull() ?: 0L }
        val balance = found.sumOf { it.str("balance_cents")?.toLongOrNull() ?: 0L }
        return ok(j(
            "entity" to "titles", "kind" to kind, "option" to option, "items" to found, "page" to 1, "limit" to (query("limit")?.toIntOrNull() ?: 100), "order" to "due_asc", "total" to found.size,
            "totals" to j("count" to found.size, "amount_cents" to amount.toString(), "balance_cents" to balance.toString(), "fee_cents" to "0"), "data_mode" to "erp_native",
        ))
    }

    private fun settle(body: JsonObject): Reply {
        val data = body["data"] as? JsonObject ?: return invalid()
        val index = titles.indexOfFirst { it.str("id") == data.str("id") }
        if (index < 0) return notFound()
        val title = titles[index]
        if ((data["expected_version"] as? JsonPrimitive)?.intOrNull != (title["version"] as? JsonPrimitive)?.intOrNull) return demoFail(409, "ERP_CONFLICT", "A conta mudou.")
        if (accounts.none { it.str("id") == data.str("account_id") }) return invalid()
        val principal = data.str("principal_cents")?.toLongOrNull() ?: return invalid()
        val balance = (title.str("balance_cents")?.toLongOrNull() ?: 0L) - principal
        if (balance < 0) return invalid()
        val updated = JsonObject(title + mapOf(
            "balance_cents" to JsonPrimitive(balance.toString()),
            "settled_cents" to JsonPrimitive(((title.str("settled_cents")?.toLongOrNull() ?: 0L) + principal).toString()),
            "status" to JsonPrimitive(if (balance == 0L) "paid" else "partial"),
            "version" to JsonPrimitive(((title["version"] as? JsonPrimitive)?.intOrNull ?: 1) + 1),
        ))
        titles[index] = updated
        return ok(j("entity" to "titles", "action" to "settle", "record" to updated, "replayed" to false, "data_mode" to "erp_native"))
    }

    private fun conversa(method: String, r: List<String>, body: JsonObject): Reply {
        if (r.size < 2 || r[0] != "pedido") return demoFail(404, "not_found", "Rota não encontrada.")
        val order = orders.firstOrNull { it.str("id") == r[1] } ?: return demoFail(404, "not_found", "Pedido não encontrado.")
        val customer = customers.firstOrNull { it.str("id") == order.str("contact_id") }
        val digits = (customer?.str("mobile") ?: customer?.str("phone"))?.filter(Char::isDigit)?.let { "55$it" }
        val line = j("id" to "linha-loja", "nome" to "WhatsApp da loja")
        if (r.size == 2 && method == "GET") {
            return demoOk(j(
                "documento" to j("tipo" to "pedido", "id" to order.str("id"), "titulo" to "Pedido ${order.str("number")}", "cliente" to customer?.str("name")),
                "telefones" to listOfNotNull(digits?.let { j("digitos" to it, "numero" to (customer?.str("mobile") ?: customer?.str("phone"))) }),
                "linhas" to listOf(line), "conectar" to null,
                "destino" to digits?.let { j("telefone" to (customer?.str("mobile") ?: customer?.str("phone")), "digitos" to it, "fora_do_cadastro" to false, "linha" to "linha-loja", "modo" to "arquivo", "motivo" to null) },
                "previa" to j("texto" to "Olá! Segue o pedido ${order.str("number")} da Empresa Exemplo.", "anexos" to listOf(j("nome" to "pedido-${order.str("number")}.pdf", "tipo" to "application/pdf", "tamanho" to 24_000))),
                "envios" to emptyList<Any>(),
            ))
        }
        if (r.size == 3 && r[2] == "enviar" && method == "POST") {
            val telefone = body.str("telefone") ?: return demoFail(400, "invalid_request", "Informe o telefone.")
            val key = "${order.str("id")}|$telefone|${body.str("linha")}"
            return sends.getOrPut(key) {
                demoOk(j("envio" to j("id" to UUID.randomUUID().toString(), "status" to "enviado", "telefone" to telefone), "repetido" to false))
            }
        }
        return demoFail(404, "not_found", "Rota não encontrada.")
    }

    companion object {
        /** Ids estáveis em forma de UUID (o ERP só aceita UUID), derivados de um nome legível. */
        fun id(key: String): String = UUID.nameUUIDFromBytes("demo-erp:$key".toByteArray()).toString()
    }
}
