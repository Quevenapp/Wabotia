package br.com.queven.wabotia.courier

import br.com.queven.wabotia.demo.DemoMode
import kotlinx.coroutines.delay

/**
 * O servidor do modo entregador na demonstração: dois pedidos fictícios da lanchonete de exemplo, conversa com
 * respostas prontas, previsão calculada no aparelho. Nada sai do celular: as posições ficam aqui e somem.
 */
class DemoCourierBackend(private val clock: () -> Long = System::currentTimeMillis) : CourierBackend {
    private class Entry(var delivery: CourierDelivery, val messages: MutableMap<CourierParty, MutableList<CourierMessage>>, var revoked: Boolean = false)

    private val entries = mutableMapOf<String, Entry>()
    private var seq = 0

    override suspend fun claim(link: CourierLink): Pair<CourierSession, CourierDelivery> {
        delay(300)
        val template = TEMPLATES[link.code] ?: throw CourierFailure("Este QR não é de um pedido desta loja, ou já foi usado.")
        if (entries.values.any { it.delivery.id == template.id && !it.revoked }) throw CourierFailure("Você já está com ${template.label}.")
        val now = clock()
        entries[template.id] = Entry(
            template,
            mutableMapOf(
                CourierParty.STORE to mutableListOf(CourierMessage("s-${template.id}", "store", "Pedido pronto no balcão. Pode retirar, e boa entrega!", now - 120_000)),
                CourierParty.CUSTOMER to mutableListOf(CourierMessage("c-${template.id}", "customer", template.customerHello, now - 60_000)),
            ),
        )
        return CourierSession(DemoMode.SERVER, "demo-${template.id}", template.id) to template
    }

    override suspend fun delivery(session: CourierSession): CourierDelivery = entry(session).delivery

    override suspend fun positions(session: CourierSession, points: List<PositionPoint>, battery: Int?): PositionsReply {
        val e = entry(session)
        val last = points.maxByOrNull { it.t } ?: return PositionsReply(active = true, etaMinutes = e.delivery.etaMinutes, distanceM = e.delivery.distanceM)
        // Destino fictício a ~1,4 km da primeira posição real: a previsão fica plausível onde quer que o aparelho esteja.
        val (lat, lng) = e.delivery.destLat?.let { it to e.delivery.destLng!! } ?: ((last.lat + 0.012) to (last.lng + 0.006))
        val meters = Geo.distanceMeters(last.lat, last.lng, lat, lng)
        e.delivery = e.delivery.copy(destLat = lat, destLng = lng, etaMinutes = Geo.etaMinutes(meters), distanceM = meters.toInt())
        return PositionsReply(active = true, lastAt = last.t, near = meters < 1000, etaMinutes = e.delivery.etaMinutes, distanceM = e.delivery.distanceM, app = PACE)
    }

    override suspend fun messages(session: CourierSession, party: CourierParty): List<CourierMessage> = entry(session).messages.getValue(party).toList()

    override suspend fun send(session: CourierSession, party: CourierParty, text: String): CourierMessage {
        val e = entry(session)
        val now = clock()
        val mine = CourierMessage("m-${++seq}", "me", text.trim(), now)
        val list = e.messages.getValue(party)
        list += mine
        list += CourierMessage("r-${++seq}", party.wire, if (party == CourierParty.STORE) "Combinado, obrigado!" else "Obrigada! Estou esperando.", now + 1)
        return mine
    }

    override suspend fun delivered(session: CourierSession) {
        delay(300)
        entry(session).revoked = true
    }

    /** Atalho de depuração: a loja revoga todas as entregas (o app volta à primeira tela). */
    fun revokeAll() = entries.values.forEach { it.revoked = true }

    private fun entry(session: CourierSession): Entry {
        val e = entries[session.deliveryId] ?: throw CourierRevoked()
        if (e.revoked) throw CourierRevoked()
        return e
    }

    private val CourierDelivery.customerHello: String
        get() = if (id == "dl-12") "Oi! O interfone não funciona, me chama aqui quando chegar." else "Pode deixar na portaria, por favor."

    companion object {
        val PACE = CourierPace(sampleSeconds = 15, uploadSeconds = 30, nearUploadSeconds = 15)

        /** Os códigos dos QR de demonstração (a tela de escanear oferece botões com eles). */
        val CODES = listOf("DEMO-ENTREGA-12", "DEMO-ENTREGA-15")

        fun demoLink(index: Int) = CourierLink(DemoMode.SERVER, CODES[index])

        private val TEMPLATES = mapOf(
            CODES[0] to CourierDelivery(
                id = "dl-12",
                label = "Pedido nº 12",
                storeName = "Lanchonete Exemplo",
                customerName = "Mariana Souza",
                address = "Rua Exemplo, 200, apto 31 — Centro\nCidade Exemplo/SP",
                items = listOf("2x X-Burger", "1x Batata média", "2x Refrigerante lata"),
                payment = "Dinheiro na entrega",
                change = "Troco para R$ 100,00",
                notes = "Interfone com defeito: chamar pelo app",
                etaMinutes = 12,
                distanceM = 2400,
                app = PACE,
            ),
            CODES[1] to CourierDelivery(
                id = "dl-15",
                label = "Pedido nº 15",
                storeName = "Lanchonete Exemplo",
                customerName = "Rafael Lima",
                address = "Avenida Exemplo, 1500 — Jardim Exemplo\nCidade Exemplo/SP",
                items = listOf("1x Pizza média calabresa", "1x Suco de laranja"),
                payment = "Pago pelo link (Pix)",
                etaMinutes = 18,
                distanceM = 3900,
                app = PACE,
            ),
        )
    }
}
