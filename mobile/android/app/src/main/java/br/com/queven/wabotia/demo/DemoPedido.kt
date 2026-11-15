package br.com.queven.wabotia.demo

import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.PhoneText
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * O Pedido da demonstração (mesmo desenho do iOS, `Core/Demo/DemoPedidoSuporte.swift`): uma lanchonete com cardápio
 * (lanches, açaí e bebidas; o Misto quente e o Cheddar esgotados), pedidos em todos os estados — dois atrasados no
 * quadro, um com o mesmo X-Burger em duas montagens (`slot` 0 e 1), um esperando o cliente escolher como pagar — e a
 * comanda em texto como o servidor monta (src/modules/pedido/ticket.ts). Telefones 552090…, endereço inventado.
 */
internal class DemoPedido(t0: Long) {
    private class Order(
        val number: Int,
        var status: String,
        var statusAt: Long,
        val name: String,
        val phone: String,
        val conversationId: String?,
        val delivery: Boolean,
        var method: String?,
        var payment: String,
        val lines: List<JsonObject>,
        val note: String,
    ) {
        val id = "pd-$number"
        val created = statusAt - 5 * 60_000
        var cancelReason: String? = null
        var paidAt: Long? = null
        val history = mutableListOf<JsonObject>()
        val subtotal: Long get() = lines.sumOf { it.long("total_cents") }
        val fee: Long get() = if (delivery) 700 else 0
        val total: Long get() = subtotal + fee
        val changeFor: Long? get() = if (number == 44) 10_000 else null
    }

    private val orders = mutableListOf<Order>()
    private var categories = listOf<JsonObject>()
    private var groups = listOf<JsonObject>()
    /** Loja pausada: "Montar pedido para este cliente" manda a mensagem da pausa em vez do link. */
    var paused = false
        private set
    private var pauseMessage = ""
    private val replays = DemoReplays()

    init {
        fun item(id: String, cat: String, name: String, price: Long, position: Int, description: String = "", groupIds: List<String> = emptyList(), available: Boolean = true) = j(
            "id" to id, "category_id" to cat, "name" to name, "description" to description, "price_cents" to price, "photo_media_id" to null, "image_url" to null,
            "available" to available, "max_quantity" to 20, "retailer_id" to null, "position" to position, "group_ids" to groupIds, "created" to t0, "updated" to t0,
        )
        categories = listOf(
            j(
                "id" to "lanches", "name" to "Lanches", "description" to "Pão brioche e carne de 150 g", "position" to 0,
                "items" to listOf(
                    item("xburger", "lanches", "X-Burger", 2500, 0, "Carne, queijo e molho da casa", listOf("ponto", "adicionais")),
                    item("xsalada", "lanches", "X-Salada", 2700, 1, "Carne, queijo, alface e tomate", listOf("ponto", "adicionais")),
                    item("misto", "lanches", "Misto quente", 1200, 2, available = false),
                ),
            ),
            j("id" to "acai", "name" to "Açaí", "description" to "", "position" to 1, "items" to listOf(item("acai", "acai", "Açaí na tigela", 1800, 0, "Com granola e banana", listOf("tamanho")))),
            j("id" to "bebidas", "name" to "Bebidas", "description" to "", "position" to 2, "items" to listOf(item("suco", "bebidas", "Suco de laranja", 800, 0), item("refri", "bebidas", "Refrigerante lata", 600, 1))),
        )
        fun option(id: String, name: String, price: Long, available: Boolean = true) = j("id" to id, "name" to name, "price_cents" to price, "available" to available)
        groups = listOf(
            j("id" to "ponto", "name" to "Ponto da carne", "min" to 1, "max" to 1, "options" to listOf(option("mal", "Mal passada", 0), option("ao-ponto", "Ao ponto", 0), option("bem", "Bem passada", 0))),
            j("id" to "adicionais", "name" to "Adicionais", "min" to 0, "max" to 3, "options" to listOf(option("bacon", "Bacon", 500), option("ovo", "Ovo", 300), option("cheddar", "Cheddar", 400, available = false))),
            j("id" to "tamanho", "name" to "Tamanho do açaí", "min" to 1, "max" to 1, "options" to listOf(option("300", "300 ml", 0), option("500", "500 ml", 600))),
        )
        fun line(item: String, name: String, qty: Int, unit: Long, options: List<Triple<String, String, Long>> = emptyList(), note: String = "", slot: Int = 0): JsonObject {
            val each = unit + options.sumOf { it.third }
            val groupName = mapOf("ponto" to "Ponto da carne", "tamanho" to "Tamanho", "adicionais" to "Adicionais")
            return j(
                "item_id" to item, "slot" to slot, "name" to name, "quantity" to qty, "unit_cents" to each,
                "options" to options.map { (g, o, p) -> j("group_id" to g, "group" to groupName[g], "id" to o.lowercase().replace(' ', '-'), "name" to o, "price_cents" to p) },
                "note" to note, "total_cents" to each * qty,
            )
        }
        fun order(number: Int, status: String, minutes: Long, name: String, phone: String, delivery: Boolean, method: String?, payment: String, lines: List<JsonObject>, note: String = "", conversation: String? = null) =
            Order(number, status, t0 - minutes * 60_000, name, phone, conversation, delivery, method, payment, lines, note)
        orders += listOf(
            order(46, "awaiting_payment", 1, "Sofia Ramos", "5520907743333", false, null, "choosing", listOf(line("xsalada", "X-Salada", 1, 2700, listOf(Triple("ponto", "Ao ponto", 0L))), line("refri", "Refrigerante lata", 1, 600))),
            order(45, "awaiting_payment", 4, "Rafael Souza", "5520907745555", true, "pix", "awaiting", listOf(line("acai", "Açaí na tigela", 2, 1800, listOf(Triple("tamanho", "500 ml", 600L))))),
            order(
                44, "received", 3, "Bianca Lopes", "5520907746666", false, "cash", "pending",
                listOf(
                    line("xburger", "X-Burger", 1, 2500, listOf(Triple("ponto", "Ao ponto", 0L), Triple("adicionais", "Bacon", 500L)), note = "sem cebola"),
                    line("xburger", "X-Burger", 1, 2500, listOf(Triple("ponto", "Bem passada", 0L)), slot = 1),
                    line("refri", "Refrigerante lata", 2, 600),
                ),
                note = "Troco para R$ 100",
            ),
            order(43, "received", 12, "Carlos Mendes", "5520907747777", true, "card", "pending", listOf(line("xsalada", "X-Salada", 2, 2700, listOf(Triple("ponto", "Mal passada", 0L), Triple("adicionais", "Ovo", 300L))))),
            order(
                42, "preparing", 18, "Mariana Costa", "5520908765432", true, "pix", "paid",
                listOf(line("acai", "Açaí na tigela", 1, 1800, listOf(Triple("tamanho", "500 ml", 600L)), note = "sem banana"), line("suco", "Suco de laranja", 1, 800)),
                conversation = Ids.C_RICH,
            ),
            order(41, "preparing", 44, "Fernanda Rocha", "5520901122334", false, "link", "paid", listOf(line("xburger", "X-Burger", 3, 2500, listOf(Triple("ponto", "Ao ponto", 0L))))),
            order(40, "ready", 6, "Lucas Martins", "5520908876655", false, "cash", "pending", listOf(line("misto", "Misto quente", 2, 1200), line("suco", "Suco de laranja", 2, 800))),
            order(
                39, "out_for_delivery", 22, "Patrícia Nunes", "5520909887766", true, "pix", "paid",
                listOf(line("xburger", "X-Burger", 1, 2500, listOf(Triple("ponto", "Bem passada", 0L), Triple("adicionais", "Bacon", 500L), Triple("adicionais", "Ovo", 300L)))),
                conversation = Ids.C_40MIN,
            ),
            order(38, "delivered", 70, "Helena Prado", "5520907742222", false, "card", "paid", listOf(line("acai", "Açaí na tigela", 1, 1800, listOf(Triple("tamanho", "300 ml", 0L))))),
            order(37, "cancelled", 95, "Gabriel Nogueira", "5520907741111", true, "pix", "cancelled", listOf(line("xsalada", "X-Salada", 1, 2700, listOf(Triple("ponto", "Ao ponto", 0L))))),
        )
        orders.first { it.number == 37 }.cancelReason = "Cliente desistiu pelo WhatsApp."
        orders.forEach { o ->
            if (o.payment == "paid") o.paidAt = o.statusAt
            o.history += j("id" to "h${o.number}a", "kind" to "created", "from_status" to null, "to_status" to "awaiting_payment", "actor" to "customer", "note" to "Carrinho concluído pelo WhatsApp.", "created" to o.created)
            if (o.status != "awaiting_payment") {
                o.history += j("id" to "h${o.number}b", "kind" to "status", "from_status" to "awaiting_payment", "to_status" to o.status, "actor" to if (o.payment == "paid") "provider" else "system", "note" to null, "created" to o.statusAt)
            }
        }
    }

    fun handle(method: String, r: List<String>, body: JsonObject, query: (String) -> String?, key: String?, now: Long, emit: DemoEmit): Reply {
        if (method == "GET") {
            return when {
                r.isEmpty() -> demoOk(j("store" to store(), "menu" to j("categories" to categories.size, "items" to 6, "available_items" to 5)))
                r == listOf("board") -> demoOk(board(now))
                r == listOf("menu") -> demoOk(j("categories" to categories, "groups" to groups, "images" to emptyList<String>()))
                r == listOf("orders") -> demoOk(list(query, now))
                r.size == 2 && r[0] == "orders" -> find(r[1])?.let { demoOk(row(it, now, true)) } ?: notFound()
                r.size == 3 && r[0] == "orders" && r[2] == "ticket" -> {
                    val o = find(r[1]) ?: return notFound()
                    val columns = query("columns")?.toIntOrNull() ?: 32
                    if (columns !in listOf(32, 42, 48)) return demoFail(400, "invalid_request", "columns: 32, 42 ou 48.")
                    demoOk(j("columns" to columns, "order" to row(o, now, false), "text" to ticket(o, columns)))
                }
                else -> demoFail(404, "not_found", "Recurso não encontrado.")
            }
        }
        return replays.run(key, r, body) { write(r, body, now, emit) }
    }

    private fun notFound() = demoFail(404, "not_found", "Pedido não encontrado.")

    private fun find(id: String) = orders.firstOrNull { it.id == id }

    private fun store(): JsonObject = j(
        "open" to !paused, "reason" to if (paused) "paused" else "open", "paused" to paused, "pause_message" to pauseMessage,
        "message" to if (paused) listOf("Estamos com a loja pausada agora.", pauseMessage).filter { it.isNotEmpty() }.joinToString("\n\n") else "",
        "hours_text" to "Todos os dias, das 11:00 às 23:30",
    )

    private fun next(o: Order): List<String> {
        val done = if (o.delivery) "out_for_delivery" else "ready"
        return when (o.status) {
            "awaiting_payment" -> listOf("received", "cancelled")
            "received" -> listOf("preparing", done, "cancelled")
            "preparing" -> listOf(done, "received", "cancelled")
            "ready", "out_for_delivery" -> listOf("delivered", "preparing", "cancelled")
            else -> emptyList()
        }
    }

    private fun paymentLabel(o: Order): String = when (o.payment) {
        "pending" -> if (o.delivery) "Pagar na entrega" else "Pagar na retirada"
        "choosing" -> "Cliente escolhendo a forma de pagamento"
        "awaiting" -> "Aguardando pagamento online"
        "paid" -> "Pago"
        "cancelled" -> "Cobrança cancelada"
        else -> o.payment
    }

    private fun row(o: Order, now: Long, withHistory: Boolean): JsonObject {
        val minutes = maxOf(0L, (now - o.statusAt) / 60_000)
        val alert = ALERTS[o.status] ?: 0L
        val fields = mutableListOf<Pair<String, Any?>>(
            "id" to o.id, "number" to o.number, "status" to o.status, "status_label" to LABELS[o.status], "status_at" to o.statusAt,
            "customer" to j("name" to o.name, "phone" to o.phone, "contact_id" to null, "conversation_id" to o.conversationId),
            "source" to "cart", "fulfillment" to if (o.delivery) "delivery" else "pickup", "fulfillment_label" to if (o.delivery) "Entrega" else "Retirada",
            "address" to if (o.delivery) j("street" to "Rua Exemplo, 245", "district" to "Bairro Exemplo", "complement" to "Casa 2", "reference" to "portão verde") else null,
            "address_text" to if (o.delivery) ADDRESS else "",
            "lines" to o.lines, "item_count" to o.lines.sumOf { it.long("quantity") },
            "subtotal_cents" to o.subtotal, "delivery_fee_cents" to o.fee, "total_cents" to o.total,
            "note" to o.note, "notes" to if (o.number == 43) "Cliente pediu para caprichar no ovo." else "",
            "eta_minutes" to if (o.delivery) 45 else 20, "eta_at" to if (o.status == "awaiting_payment") null else o.statusAt + (if (o.delivery) 45 else 20) * 60_000L,
            "payment" to j(
                "method" to o.method, "method_label" to o.method?.let { METHODS[it] }, "online" to (o.method == "pix" || o.method == "link"),
                "status" to o.payment, "status_label" to paymentLabel(o), "payment_id" to null, "due_at" to if (o.payment == "awaiting") o.statusAt + 30 * 60_000L else null,
                "paid_at" to o.paidAt, "paid_by" to null, "error" to null, "change_for_cents" to o.changeFor, "needs_refund" to false,
            ),
            "next_statuses" to next(o), "cancel_reason" to o.cancelReason, "cancelled_by" to null,
            "created" to o.created, "updated" to o.statusAt,
            "minutes_in_status" to minutes, "late" to (if (o.status == "awaiting_payment") o.payment == "awaiting" && now >= o.statusAt + 30 * 60_000L else alert > 0 && minutes >= alert),
        )
        if (withHistory) fields += "history" to o.history
        return j(*fields.toTypedArray())
    }

    private fun board(now: Long): JsonObject = j(
        "generated_at" to now, "store" to j("open" to !paused, "reason" to if (paused) "paused" else "open", "paused" to paused, "message" to store().str("message")),
        "columns" to ACTIVE.map { status -> j("status" to status, "label" to LABELS[status], "orders" to orders.filter { it.status == status }.sortedBy { it.statusAt }.map { row(it, now, false) }) },
        "today" to j(
            "since" to now - 12 * 3_600_000L, "orders" to orders.size, "delivered" to orders.count { it.status == "delivered" }, "cancelled" to orders.count { it.status == "cancelled" },
            "total_cents" to orders.filter { it.status != "cancelled" }.sumOf { it.total },
        ),
    )

    private fun list(query: (String) -> String?, now: Long): JsonObject {
        val statuses = query("status")?.split(",")?.filter { it.isNotBlank() }?.toSet().orEmpty()
        val open = query("open") == "1"
        val q = query("q")?.trim()?.lowercase().orEmpty()
        val list = orders.filter { o ->
            (statuses.isEmpty() || o.status in statuses) && (!open || o.status in ACTIVE) &&
                (q.isEmpty() || o.name.lowercase().contains(q) || o.number.toString() == q.filter(Char::isDigit) || (q.filter(Char::isDigit).length >= 4 && o.phone.contains(q.filter(Char::isDigit))))
        }.sortedByDescending { it.number }
        val counts = orders.groupingBy { it.status }.eachCount()
        return j("data" to list.map { row(it, now, false) }, "next_cursor" to null, "counts" to j(*counts.map { it.key to it.value }.toTypedArray()))
    }

    private fun write(r: List<String>, body: JsonObject, now: Long, emit: DemoEmit): Reply {
        if (r == listOf("store", "pause")) {
            val value = (body["paused"] as? JsonPrimitive)?.booleanOrNull ?: return demoFail(400, "invalid_request", "Informe paused como verdadeiro ou falso.")
            val message = body.str("message")?.trim().orEmpty()
            if (message.length > 300) return demoFail(400, "invalid_request", "Mensagem da pausa: até 300 caracteres.")
            val changed = paused != value
            paused = value
            pauseMessage = if (value) message else ""
            if (changed) emit("pedido.store_changed", Ids.PROFILE, j("paused" to value, "message" to pauseMessage, "actor" to Ids.ME, "module_id" to "pedido"))
            return demoOk(store())
        }
        if (r.size == 3 && r[0] == "items" && r[2] == "availability") {
            val available = (body["available"] as? JsonPrimitive)?.booleanOrNull ?: return demoFail(400, "invalid_request", "Disponível: verdadeiro ou falso.")
            var found: JsonObject? = null
            categories = categories.map { c ->
                val items = (c["items"] as? kotlinx.serialization.json.JsonArray)?.map { it as JsonObject }.orEmpty().map { i ->
                    if (i.str("id") == r[1]) JsonObject(i + ("available" to JsonPrimitive(available))).also { found = it } else i
                }
                JsonObject(c + ("items" to kotlinx.serialization.json.JsonArray(items)))
            }
            val item = found ?: return demoFail(404, "not_found", "Item não encontrado no cardápio.")
            emit("pedido.menu_changed", r[1], j("what" to "item", "id" to r[1], "action" to "availability", "available" to available, "module_id" to "pedido"))
            return demoOk(item)
        }
        if (r.size == 3 && r[0] == "groups" && r[2] == "availability") {
            val available = (body["available"] as? JsonPrimitive)?.booleanOrNull ?: return demoFail(400, "invalid_request", "Disponível: verdadeiro ou falso.")
            val optionId = body.str("option_id") ?: return demoFail(400, "invalid_request", "Informe option_id.")
            val group = groups.firstOrNull { it.str("id") == r[1] } ?: return demoFail(404, "not_found", "Grupo de adicionais não encontrado no cardápio.")
            val options = (group["options"] as? kotlinx.serialization.json.JsonArray)?.map { it as JsonObject }.orEmpty()
            if (options.none { it.str("id") == optionId }) return demoFail(400, "invalid_request", "Opção não encontrada neste grupo.")
            val updated = JsonObject(group + ("options" to kotlinx.serialization.json.JsonArray(options.map { if (it.str("id") == optionId) JsonObject(it + ("available" to JsonPrimitive(available))) else it })))
            groups = groups.map { if (it.str("id") == r[1]) updated else it }
            emit("pedido.menu_changed", r[1], j("what" to "group", "id" to r[1], "action" to "availability", "option_id" to optionId, "available" to available, "module_id" to "pedido"))
            return demoOk(updated)
        }
        if (r.size != 3 || r[0] != "orders") return demoFail(404, "not_found", "Recurso não encontrado.")
        val o = find(r[1]) ?: return notFound()
        fun history(kind: String, to: String, note: String?) {
            o.history += j("id" to "h${o.number}-${o.history.size}", "kind" to kind, "from_status" to o.status, "to_status" to to, "actor" to Ids.ME, "note" to note, "created" to now)
        }
        when (r[2]) {
            "status" -> {
                val to = body.str("status").orEmpty()
                if (to !in next(o)) return demoFail(409, "invalid_transition", "Mudança inválida para o pedido nº ${o.number}.")
                if (to == "cancelled") {
                    val reason = body.str("reason")?.trim().orEmpty()
                    o.cancelReason = reason.ifEmpty { null }
                    if (o.payment == "awaiting") o.payment = "cancelled"
                }
                history("status", to, body.str("note") ?: if (to == "cancelled") o.cancelReason else null)
                val from = o.status
                o.status = to
                o.statusAt = now
                emit("pedido.status_changed", o.id, j("order_id" to o.id, "number" to o.number, "from" to from, "to" to to, "actor" to Ids.ME, "conversation_id" to o.conversationId, "module_id" to "pedido"))
            }
            "paid" -> {
                if (o.payment == "paid") return demoFail(409, "already_paid", "O pedido nº ${o.number} já está pago.")
                if (o.payment == "awaiting") return demoFail(409, "payment_online", "O pedido nº ${o.number} tem uma cobrança online aberta: o pagamento é confirmado pelo provedor.")
                if (o.status == "cancelled") return demoFail(409, "order_closed", "Pedido cancelado.")
                o.payment = "paid"
                o.paidAt = now
                val note = body.str("note")?.trim()?.takeIf { it.isNotEmpty() }
                history("payment", o.status, "Pagamento registrado pela equipe: ${Money.format(o.total)}${note?.let { " ($it)" }.orEmpty()}.")
                emit("pedido.paid", o.id, j("order_id" to o.id, "number" to o.number, "amount_cents" to o.total, "manual" to true, "actor" to Ids.ME, "conversation_id" to o.conversationId, "module_id" to "pedido"))
            }
            "payment" -> {
                if (o.method != null && o.payment != "failed") return demoFail(409, "payment_chosen", "O cliente já escolheu a forma de pagamento.")
                val method = body.str("method").orEmpty()
                if (method !in listOf("cash", "card")) return demoFail(400, "invalid_request", "Forma de pagamento: pix, link, cash ou card.")
                o.method = method
                o.payment = "pending"
                history("payment", o.status, "Forma de pagamento: ${METHODS[method]}.")
                emit("pedido.status_changed", o.id, j("order_id" to o.id, "number" to o.number, "module_id" to "pedido"))
            }
            else -> return demoFail(404, "not_found", "Recurso não encontrado.")
        }
        return demoOk(row(o, now, false))
    }

    // --- Comanda: o mesmo desenho do servidor (src/modules/pedido/ticket.ts) ---

    private fun ticket(o: Order, columns: Int): String {
        fun wrap(text: String): List<String> {
            val out = mutableListOf<String>()
            for (paragraph in text.split("\n")) {
                var line = ""
                for (raw in paragraph.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
                    var word = raw
                    while (word.length > columns) {
                        if (line.isNotEmpty()) out += line
                        line = ""
                        out += word.take(columns)
                        word = word.drop(columns)
                    }
                    if (word.isEmpty()) continue
                    line = when {
                        line.isEmpty() -> word
                        line.length + 1 + word.length <= columns -> "$line $word"
                        else -> { out += line; word }
                    }
                }
                out += line
            }
            return out
        }
        fun center(text: String) = wrap(text).map { " ".repeat(maxOf(0, (columns - it.length) / 2)) + it }
        fun indented(text: String) = wrap(text).map { "   $it" }
        fun pair(left: String, right: String): List<String> {
            val lines = wrap(left).toMutableList()
            val last = lines.removeAt(lines.lastIndex)
            if (last.length + 1 + right.length <= columns) lines += last + " ".repeat(columns - last.length - right.length) + right
            else { lines += last; lines += " ".repeat(maxOf(0, columns - right.length)) + right }
            return lines
        }
        val rule = "-".repeat(columns)
        val out = mutableListOf<String>()
        out += center(DemoMode.PROFILE_NAME.uppercase())
        out += center("Rua Exemplo, 100 — Centro\nCidade Exemplo/SP")
        out += center("(20) 3000-0000")
        out += rule
        out += pair("PEDIDO Nº ${o.number}", BrasiliaTime.shortWithTime(o.created))
        out += wrap("${if (o.delivery) "ENTREGA" else "RETIRADA"} · ${LABELS[o.status]}")
        out += rule
        o.lines.forEach { line ->
            out += pair("${line.long("quantity")}x ${line.str("name")}", Money.format(line.long("total_cents")))
            (line["options"] as? kotlinx.serialization.json.JsonArray)?.forEach { out += indented("+ ${(it as JsonObject).str("name")}") }
            line.str("note")?.takeIf { it.isNotEmpty() }?.let { out += indented("Obs: $it") }
        }
        out += rule
        out += pair("Subtotal", Money.format(o.subtotal))
        if (o.delivery) out += pair("Entrega", Money.format(o.fee))
        out += pair("TOTAL", Money.format(o.total))
        out += wrap("Pagamento: ${o.method?.let { METHODS[it] } ?: "a definir"}${o.changeFor?.let { " (troco para ${Money.format(it)})" }.orEmpty()}")
        out += wrap(if (o.payment == "paid") "*** PAGO ***" else "Situação: ${paymentLabel(o)}")
        out += rule
        out += wrap("Cliente: ${o.name}")
        out += wrap("Tel: ${PhoneText.display(o.phone) ?: o.phone}")
        if (o.delivery) out += wrap("Entregar em: $ADDRESS")
        if (o.note.isNotEmpty()) out += wrap("Obs.: ${o.note}")
        out += rule
        out += center("Demonstração: dados fictícios.")
        return out.joinToString("\n")
    }

    private companion object {
        val ACTIVE = listOf("awaiting_payment", "received", "preparing", "ready", "out_for_delivery")
        val LABELS = mapOf(
            "awaiting_payment" to "Aguardando pagamento", "received" to "Recebido", "preparing" to "Em preparo", "ready" to "Pronto para retirada",
            "out_for_delivery" to "Saiu para entrega", "delivered" to "Entregue", "cancelled" to "Cancelado",
        )
        val METHODS = mapOf("pix" to "Pix", "link" to "Cartão pelo link de pagamento", "cash" to "Dinheiro na entrega ou retirada", "card" to "Cartão na maquininha")
        /** Minutos no estado até o destaque de atraso (Regras da loja → alertas). */
        val ALERTS = mapOf("received" to 10L, "preparing" to 40L, "ready" to 60L, "out_for_delivery" to 90L)
        const val ADDRESS = "Rua Exemplo, 245 - Bairro Exemplo, Casa 2 (portão verde)"
    }
}
