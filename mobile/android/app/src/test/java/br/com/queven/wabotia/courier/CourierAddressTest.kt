package br.com.queven.wabotia.courier

import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * O endereço da entrega (fix/entrega-endereco, 50930c6; docs/ENTREGA.md, "Endereço"): o achado da instalação de teste
 * era "Rua das Flores" sem cidade caindo em outro estado (no Android, a ~494 km) ou em Portugal (no iPhone).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CourierAddressTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun main() = Dispatchers.setMain(dispatcher)

    @After fun reset() = Dispatchers.resetMain()

    private val storePos = LatLng(-22.9056, -47.0608)

    /** A visão do entregador como o servidor manda (o mesmo formato de tests/entrega-endereco.test.ts). */
    private val courierView = """
        {"id":"d1","label":"Pedido nº 25","status":"assigned","customer_name":"Caio",
         "address":{"street":"Rua das Flores, 200","number":"","complement":"","district":"Centro","city":"Campinas","state":"SP","postal_code":"","reference":"portão azul"},
         "address_text":"Rua das Flores, 200 - Centro, Campinas - SP","address_incomplete":false,"destination":null,
         "store":{"name":"Lanchonete da Ana","city":"Campinas","state":"SP","position":{"lat":-22.9056,"lng":-47.0608}}}
    """.trimIndent()

    private fun delivery(json: String) = WabotiaJson.decodeFromString(CourierDelivery.serializer(), json)

    @Test fun leOsCamposNovos() {
        val d = delivery(courierView)
        assertEquals("Campinas", d.addressParts!!.city)
        assertEquals("portão azul", d.addressParts!!.reference)
        assertEquals("Rua das Flores, 200 - Centro, Campinas - SP", d.address)
        assertFalse(d.addressIncomplete)
        assertEquals(CourierShop("Lanchonete da Ana", "Campinas", "SP", storePos), d.shop)
        // O destino com a origem ("customer") também é lido.
        val withDestination = delivery("""{"id":"d2","destination":{"lat":-22.91,"lng":-47.05,"source":"customer"},"store":{"name":"L","city":"","state":"","position":null}}""")
        assertEquals(LatLng(-22.91, -47.05), withDestination.destination)
        assertNull(withDestination.shop!!.position)
        // Servidor de antes: sem os campos, nada quebra.
        val old = delivery("""{"id":"d3","address_text":"Rua B"}""")
        assertNull(old.addressParts)
        assertNull(old.shop)
    }

    @Test fun regra1ComDestinoVaiDireto() {
        val d = delivery(courierView).copy(destination = LatLng(-22.91, -47.05))
        assertEquals(DestinationSearch.Known(LatLng(-22.91, -47.05)), CourierDestination.plan(d))
        // Mesmo com address_incomplete: o cliente mandou a localização.
        assertEquals(DestinationSearch.Known(LatLng(-22.91, -47.05)), CourierDestination.plan(d.copy(addressIncomplete = true)))
    }

    @Test fun regra2ProcuraPertoDaLojaENaoDoEntregador() {
        val plan = CourierDestination.plan(delivery(courierView)) as DestinationSearch.Search
        assertEquals("Rua das Flores, 200 - Centro, Campinas - SP, Brasil", plan.query)
        assertEquals(storePos, plan.near)
        // O retângulo cerca a loja.
        val (sw, ne) = CourierDestination.bounds(storePos)
        assertTrue(sw.lat < storePos.lat && storePos.lat < ne.lat && sw.lng < storePos.lng && storePos.lng < ne.lng)
        // Achado do A07: a outra "Rua das Flores" a ~494 km é recusada; uma em Campinas vale; fora do Brasil, nunca.
        assertFalse(CourierDestination.accept(LatLng(-19.92, -43.94), "BR", plan))
        assertTrue(CourierDestination.accept(LatLng(-22.91, -47.05), "BR", plan))
        assertFalse(CourierDestination.accept(LatLng(41.15, -8.61), "PT", plan))
        assertTrue(CourierDestination.distanceKm(storePos, LatLng(-19.92, -43.94)) > 300)
    }

    @Test fun regra3SemPosicaoDaLojaUsaCidadeEUf() {
        val noPosition = delivery(courierView).let { it.copy(shop = it.shop!!.copy(position = null)) }
        val plan = CourierDestination.plan(noPosition) as DestinationSearch.Search
        assertNull(plan.near)
        assertTrue(plan.query.contains("Campinas - SP"))
        // Linha sem a cidade (servidor que só manda os campos): a cidade e a UF entram no texto.
        val partsOnly = noPosition.copy(address = "Rua das Flores, 200 - Centro")
        assertEquals("Rua das Flores, 200 - Centro, Campinas, SP, Brasil", (CourierDestination.plan(partsOnly) as DestinationSearch.Search).query)
        // Sem a linha pronta, ela é montada dos campos.
        assertEquals(
            "Rua das Flores, 200 - Centro, Campinas - SP",
            CourierDestination.compose(CourierAddress(street = "Rua das Flores, 200", district = "Centro", city = "Campinas", state = "SP")),
        )
        // Fora do Brasil não serve, mesmo sem a loja.
        assertFalse(CourierDestination.accept(LatLng(41.15, -8.61), "PT", plan))
    }

    @Test fun regra4EnderecoSemCidadeAvisaEmVezDeProcurar() {
        val d = delivery("""{"id":"d4","address_text":"Rua das Flores, 200 - Centro","address":{"street":"Rua das Flores, 200","district":"Centro"},"address_incomplete":true,"store":{"name":"L","position":null}}""")
        assertEquals(DestinationSearch.Incomplete, CourierDestination.plan(d))
        assertEquals(DestinationSearch.Empty, CourierDestination.plan(CourierDelivery(id = "d5")))
    }

    @Test fun lojaDaTrocaDoQrEntraNaEntrega() = runTest(dispatcher) {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setBody(
                """{"token":"wabx_1","profile":"p1","subject":"d1",
                   "data":{"delivery":{"id":"d1","address_text":"Rua das Flores, 200 - Centro, Campinas - SP"},
                           "store":{"name":"Lanchonete da Ana","city":"Campinas","state":"SP","position":{"lat":-22.9056,"lng":-47.0608}}}}""",
            ),
        )
        server.start()
        try {
            val (_, d) = HttpCourierBackend().claim(CourierLink(server.url("/").toString().trimEnd('/'), "CODIGO"), "Carlos", "Teste")
            assertEquals(storePos, d.shop!!.position)
        } finally {
            server.shutdown()
        }
    }

    /** A loja de exemplo com o endereço novo; o resto é a demonstração. */
    private class AddressBackend(
        private val shape: (CourierDelivery) -> CourierDelivery,
        private val demo: DemoCourierBackend = DemoCourierBackend(),
    ) : CourierBackend by demo {
        val started = mutableListOf<LatLng?>()

        override suspend fun claim(link: CourierLink, name: String, device: String): Pair<CourierSession, CourierDelivery> =
            demo.claim(link, name, device).let { (s, d) -> s to shape(d) }

        override suspend fun delivery(session: CourierSession): CourierDelivery = shape(demo.delivery(session))

        override suspend fun start(session: CourierSession, destination: LatLng?): CourierPace? {
            started += destination
            return demo.start(session, destination)
        }
    }

    private fun kotlinx.coroutines.test.TestScope.started(shape: (CourierDelivery) -> CourierDelivery, found: LatLng?): Pair<List<DestinationSearch.Search>, AddressBackend> {
        val backend = AddressBackend(shape)
        val vm = CourierViewModel(backend, MemoryCourierSessionStore().apply { name = "Carlos" }, device = "Teste")
        vm.scanned(DemoCourierBackend.QRS[0])
        advanceUntilIdle()
        vm.confirmContinue()
        advanceUntilIdle()
        val asked = mutableListOf<DestinationSearch.Search>()
        vm.start(vm.state.value.deliveries.single().id) { asked += it; found }
        advanceUntilIdle()
        return asked to backend
    }

    @Test fun iniciarRotaProcuraPertoDaLojaENaoProcuraSemCidade() = runTest(dispatcher) {
        val campinas = LatLng(-22.91, -47.05)
        val shop = CourierShop("Lanchonete da Ana", "Campinas", "SP", storePos)
        val (asked, backend) = started({ it.copy(address = "Rua das Flores, 200 - Centro, Campinas - SP", shop = shop) }, campinas)
        assertEquals(listOf(storePos), asked.map { it.near })
        assertEquals(listOf<LatLng?>(campinas), backend.started)

        // Sem cidade: não procura e manda o início sem destino.
        val (none, quiet) = started({ it.copy(address = "Rua das Flores, 200", addressIncomplete = true) }, campinas)
        assertTrue(none.isEmpty())
        assertEquals(listOf<LatLng?>(null), quiet.started)

        // Com o destino do cliente: não procura (o servidor já tem).
        val (direct, known) = started({ it.copy(destination = it.destination ?: campinas) }, LatLng(0.0, 0.0))
        assertTrue(direct.isEmpty())
        assertEquals(listOf<LatLng?>(null), known.started)
    }
}
