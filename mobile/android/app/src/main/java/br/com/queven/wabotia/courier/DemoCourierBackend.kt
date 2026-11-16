package br.com.queven.wabotia.courier

import br.com.queven.wabotia.demo.DemoMode
import kotlinx.coroutines.delay

/**
 * O servidor do modo entregador na demonstração: dois pedidos fictícios da lanchonete de exemplo, conversa com
 * respostas prontas, previsão calculada no aparelho. Nada sai do celular: as posições ficam aqui e somem. O pedido nº 15
 * tem a janela do WhatsApp fechada, para mostrar o "fale com a loja".
 */
class DemoCourierBackend(private val clock: () -> Long = System::currentTimeMillis) : CourierBackend {
    private class Entry(var delivery: CourierDelivery, val messages: MutableList<CourierMessage>, var revoked: Boolean = false)

    private val entries = mutableMapOf<String, Entry>()
    private var seq = 0L

    override suspend fun preview(link: CourierLink): CourierPreview {
        delay(250)
        val template = TEMPLATES[link.code]
        val open = template != null && entries[template.id]?.revoked != false
        return CourierPreview(valid = open, store = template?.let { STORES[it.id] }, server = link.server)
    }

    override suspend fun claim(link: CourierLink, name: String, device: String): Pair<CourierSession, CourierDelivery> {
        delay(300)
        val template = TEMPLATES[link.code] ?: throw CourierFailure("Este QR não é de um pedido desta loja.", 404, "claim_not_found")
        if (entries[template.id]?.revoked == false) throw CourierFailure("Este QR já foi lido. Peça à loja um QR novo.", 410, "claim_used")
        val now = clock()
        val messages = mutableListOf(
            CourierMessage(++seq, "store", "store", STORES[template.id].orEmpty(), "Pedido pronto no balcão. Pode retirar, e boa entrega!", now - 120_000),
            CourierMessage(++seq, "customer", "customer", template.customerName, template.customerHello, now - 60_000),
        )
        val delivery = template.copy(chat = CourierChat(seq, customerOpen = template.id == "dl-12"))
        entries[template.id] = Entry(delivery, messages)
        return CourierSession(link.server, "wabx_demo_${template.id}", "demo", template.id, storeName = STORES[template.id]) to delivery
    }

    override suspend fun delivery(session: CourierSession): CourierDelivery = entry(session).delivery

    override suspend fun start(session: CourierSession, destination: LatLng?): CourierPace? {
        delay(300)
        val e = entry(session)
        e.delivery = e.delivery.copy(status = "en_route", statusLabel = "A caminho", destination = destination ?: e.delivery.destination)
        return PACE
    }

    override suspend fun positions(session: CourierSession, points: List<PositionPoint>, battery: Int?): PositionsReply {
        val e = entry(session)
        val chat = CourierChat(e.messages.lastOrNull()?.seq ?: 0, e.delivery.chat?.customerOpen)
        if (!e.delivery.enRoute) return PositionsReply(active = true, status = e.delivery.status, app = PACE, chat = chat)
        val last = points.maxByOrNull { it.t } ?: return PositionsReply(active = true, status = "en_route", eta = e.delivery.eta, app = PACE, chat = chat)
        // Destino fictício a ~1,4 km da primeira posição real: a previsão fica plausível onde quer que o aparelho esteja.
        val dest = e.delivery.destination ?: LatLng(last.lat + 0.012, last.lng + 0.006)
        val meters = Geo.distanceMeters(last.lat, last.lng, dest.lat, dest.lng)
        val eta = CourierEta(minutes = Geo.etaMinutes(meters), at = last.t + Geo.etaMinutes(meters) * 60_000L, distanceM = meters.toInt())
        e.delivery = e.delivery.copy(destination = dest, eta = eta, arriving = meters < 500)
        return PositionsReply(active = true, status = "en_route", lastAt = last.t, eta = eta, arriving = meters < 500, app = PACE, chat = chat)
    }

    override suspend fun messages(session: CourierSession, after: Long): CourierMessagesPage {
        val e = entry(session)
        val list = e.messages.filter { it.seq > after }
        return CourierMessagesPage(list, list.lastOrNull()?.seq ?: after, e.delivery.chat?.customerOpen, open = true)
    }

    override suspend fun send(session: CourierSession, party: CourierParty, text: String) {
        val e = entry(session)
        if (party == CourierParty.CUSTOMER && e.delivery.chat?.customerOpen != true) {
            throw CourierFailure("O cliente não falou com a loja nas últimas 24 horas, então a mensagem não pode ir pelo WhatsApp. Fale com a loja.", 409, "window_closed")
        }
        val now = clock()
        e.messages += CourierMessage(++seq, party.wire, "courier", "Você", text.trim(), now)
        val reply = if (party == CourierParty.STORE) "Combinado, obrigado!" else "Obrigada! Estou esperando."
        e.messages += CourierMessage(++seq, party.wire, party.wire, if (party == CourierParty.STORE) STORES[e.delivery.id].orEmpty() else e.delivery.customerName, reply, now + 1)
    }

    override suspend fun delivered(session: CourierSession, note: String?) {
        delay(300)
        entry(session).revoked = true
    }

    override suspend fun cancel(session: CourierSession, reason: String) {
        delay(300)
        entry(session).revoked = true
    }

    /** Atalho de depuração: a loja revoga todas as entregas (o app volta à primeira tela). */
    fun revokeAll() = entries.values.forEach { it.revoked = true }

    /** Uma loja revoga só a própria entrega (o QR foi trocado ou a entrega passou a outra pessoa). */
    fun revoke(deliveryId: String) {
        entries[deliveryId]?.revoked = true
    }

    private fun entry(session: CourierSession): Entry {
        val e = entries[session.deliveryId] ?: throw CourierRevoked()
        if (e.revoked) throw CourierRevoked()
        return e
    }

    private val CourierDelivery.customerHello: String
        get() = if (id == "dl-12") "Oi! O interfone não funciona, me chama aqui quando chegar." else "Pode deixar na portaria, por favor."

    companion object {
        val PACE = CourierPace(sampleSeconds = 15, uploadSeconds = 30, nearUploadSeconds = 15)

        /** Os códigos dos QR de demonstração: 32 caracteres do alfabeto do QR (sem 0, 1, I, O, l e o). */
        val CODES = listOf("DEMxENTREGAxLANCHExNUMxDzEZEW23Q", "DEMxENTREGAxPZZARAxNUMxDzEZEW45Q")

        /** Duas lojas diferentes, em endereços fictícios (.example): o entregador atende as duas ao mesmo tempo. */
        val QRS = listOf("https://lanchonete.example/api/public/c/${CODES[0]}", "https://pizzaria.example/api/public/c/${CODES[1]}")

        private val STORES = mapOf("dl-12" to "Lanchonete Exemplo", "dl-15" to "Pizzaria Exemplo")

        fun demoLink(index: Int) = CourierLinks.parse(QRS[index])!!

        fun storeOf(index: Int) = STORES[if (index == 0) "dl-12" else "dl-15"]!!

        private val TEMPLATES = mapOf(
            CODES[0] to CourierDelivery(
                id = "dl-12",
                label = "Pedido nº 12",
                customerName = "Mariana",
                address = "Rua Exemplo, 200, apto 31 — Centro\nCidade Exemplo/SP",
                status = "assigned",
                statusLabel = "Aguardando a saída",
                order = CourierOrder(
                    number = 12,
                    lines = listOf(CourierOrderLine("X-Burger", 2, listOf("sem cebola")), CourierOrderLine("Batata média", 1), CourierOrderLine("Refrigerante lata", 2)),
                    totalCents = 5_700,
                    customerNote = "Interfone com defeito: chamar pelo app",
                    payment = CourierPayment(methodLabel = "Dinheiro na entrega", status = "pending", paid = false, changeForCents = 10_000),
                ),
                app = PACE,
            ),
            CODES[1] to CourierDelivery(
                id = "dl-15",
                label = "Pedido nº 15",
                customerName = "Rafael",
                address = "Avenida Exemplo, 1500 — Jardim Exemplo\nCidade Exemplo/SP",
                status = "assigned",
                statusLabel = "Aguardando a saída",
                order = CourierOrder(
                    number = 15,
                    lines = listOf(CourierOrderLine("Pizza média", 1, listOf("calabresa")), CourierOrderLine("Suco de laranja", 1)),
                    totalCents = 6_200,
                    payment = CourierPayment(methodLabel = "Pix pelo link", status = "paid", paid = true),
                ),
                app = PACE,
            ),
        )
    }
}
