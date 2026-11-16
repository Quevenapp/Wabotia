package br.com.queven.wabotia.courier

import br.com.queven.wabotia.demo.DemoMode
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

@OptIn(ExperimentalCoroutinesApi::class)
class CourierTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun main() = Dispatchers.setMain(dispatcher)

    @After fun reset() = Dispatchers.resetMain()

    // --- QR -------------------------------------------------------------------------------------------------------

    @Test fun linkDoQr() {
        assertEquals(CourierLink("https://loja.exemplo.com.br", "AbC123xyz"), CourierLinks.parse("https://loja.exemplo.com.br/entrega/AbC123xyz"))
        assertEquals(CourierLink("https://loja.exemplo.com.br:8443", "AbC123xyz"), CourierLinks.parse(" https://loja.exemplo.com.br:8443/e/AbC123xyz?x=1 "))
        assertEquals(CourierLink("https://loja.exemplo.com.br", "AbC123xyz"), CourierLinks.parse("https://loja.exemplo.com.br/app?entrega=AbC123xyz"))
        assertEquals(CourierLink("https://loja.exemplo.com.br", "AbC123xyz"), CourierLinks.parse("wabotia://entrega?server=loja.exemplo.com.br&code=AbC123xyz"))
        // Sem https, de outro lugar ou sem código: não é pedido.
        assertNull(CourierLinks.parse("http://loja.exemplo.com.br/entrega/AbC123xyz"))
        assertNull(CourierLinks.parse("https://wa.me/552090000000?text=SENHA%20N004"))
        assertNull(CourierLinks.parse("https://loja.exemplo.com.br/entrega/"))
        assertNull(CourierLinks.parse("wabotia://entrega?server=http://x.com&code=AbC123xyz"))
        assertNull(CourierLinks.parse("SENHA N004 AB12CD"))
    }

    // --- fila de posições -----------------------------------------------------------------------------------------

    private fun p(t: Long, lat: Double, lng: Double = -46.6, accuracy: Float? = 10f) = PositionPoint(t, lat, lng, accuracy)

    @Test fun filaDescartaRuimParadoEVelho() {
        val q = PositionQueue()
        q.add(p(1_000, 0.0, 0.0))                 // 0,0
        q.add(p(2_000, -23.5, accuracy = 500f))   // precisão ruim
        q.add(p(3_000, -23.5))
        q.add(p(4_000, -23.50001))                // ~1 m: parado no semáforo
        q.add(p(2_500, -23.6))                    // fora de ordem
        q.add(p(5_000, -23.501))                  // ~110 m
        assertEquals(2, q.size)
        // Duas horas depois, o primeiro some.
        assertEquals(1, q.batch(3_000 + 2 * 60 * 60 * 1000L + 1).size)
    }

    @Test fun loteDe200EConfirmacaoPorLastAt() {
        val q = PositionQueue()
        repeat(450) { i -> q.add(p(1_000L + i * 1_000, -23.5 + i * 0.001), now = 1_000L) }
        val first = q.batch(500_000)
        assertEquals(200, first.size)
        assertEquals(1_000L, first.first().t) // os mais antigos primeiro
        q.ack(first[149].t, first)            // o servidor confirmou só até o 150º
        assertEquals(300, q.size)
        q.ack(null, q.batch(500_000))         // sem last_at: apaga o lote enviado
        assertEquals(100, q.size)
    }

    @Test fun ritmoSegueOServidorEDobraComBateriaBaixa() {
        val pace = CourierPace(sampleSeconds = 15, uploadSeconds = 60, nearUploadSeconds = 30)
        assertEquals(60_000L, CourierPacing.uploadMillis(pace, near = false, battery = 80))
        assertEquals(30_000L, CourierPacing.uploadMillis(pace, near = true, battery = 80))
        assertEquals(120_000L, CourierPacing.uploadMillis(pace, near = false, battery = 10))
        assertEquals(30_000L, CourierPacing.sampleMillis(pace, battery = 14))
        assertEquals(15_000L, CourierPacing.sampleMillis(pace, battery = null))
    }

    @Test fun previsaoETextos() {
        assertEquals(1, Geo.etaMinutes(100.0))
        val d = CourierDelivery(id = "x", label = "Pedido nº 12", etaMinutes = 12, distanceM = 2400)
        assertEquals("Cerca de 12 min · 2,4 km", CourierTexts.eta(d))
        assertEquals("Chegando · 300 m", CourierTexts.eta(d.copy(etaMinutes = 1, distanceM = 300)))
        assertNull(CourierTexts.eta(d.copy(etaMinutes = null)))
    }

    // --- tela (ViewModel) com o servidor da demonstração ----------------------------------------------------------

    @Test fun variasEntregasPosicaoEEntreguei() = runTest(dispatcher) {
        val backend = DemoCourierBackend(clock = { 1_000_000L })
        val store = MemoryCourierSessionStore()
        val vm = CourierViewModel(backend, store, clock = { 1_000_000L })
        vm.restore()
        advanceUntilIdle()
        assertTrue(vm.state.value.deliveries.isEmpty())
        assertFalse(vm.state.value.ended)

        vm.claim(DemoCourierBackend.demoLink(0))
        advanceUntilIdle()
        vm.claim(DemoCourierBackend.demoLink(1))
        advanceUntilIdle()
        assertEquals(listOf("dl-12", "dl-15"), vm.state.value.deliveries.map { it.id })
        assertEquals(2, store.load().size)
        assertEquals(DemoMode.SERVER, store.load().first().server)

        // A mesma leitura vai para as duas entregas; o lote atualiza a previsão.
        vm.onLocation(PositionPoint(999_000L, -23.55, -46.63, 8f))
        vm.flush(battery = 80)
        val d12 = vm.state.value.deliveries.first { it.id == "dl-12" }
        assertTrue(d12.distanceM!! in 1000..2000)

        vm.open("dl-12")
        advanceUntilIdle()
        vm.send("dl-12", CourierParty.CUSTOMER, "Cheguei no portão")
        advanceUntilIdle()
        val chat = vm.state.value.messages["dl-12"]!![CourierParty.CUSTOMER]!!
        assertTrue(chat.any { it.mine && it.text == "Cheguei no portão" })

        vm.delivered("dl-12", battery = 80)
        advanceUntilIdle()
        assertEquals(listOf("dl-15"), vm.state.value.deliveries.map { it.id })
        assertFalse(vm.state.value.ended)
        assertEquals(1, store.load().size)

        // A loja revoga a outra: sem nenhuma entrega, o app volta à primeira tela.
        backend.revokeAll()
        vm.flush(battery = 80)
        assertTrue(vm.state.value.deliveries.isEmpty())
        assertTrue(vm.state.value.ended)
        assertTrue(store.load().isEmpty())
    }

    @Test fun qrDesconhecidoAvisaENaoGuarda() = runTest(dispatcher) {
        val store = MemoryCourierSessionStore()
        val vm = CourierViewModel(DemoCourierBackend(), store)
        vm.claim(CourierLink(DemoMode.SERVER, "OUTRO-CODIGO"))
        advanceUntilIdle()
        assertTrue(vm.state.value.notice!!.contains("não é de um pedido"))
        assertTrue(store.load().isEmpty())
    }

    @Test fun reabrirRetomaSoAsEntregasVivas() = runTest(dispatcher) {
        val backend = DemoCourierBackend()
        val store = MemoryCourierSessionStore()
        val first = CourierViewModel(backend, store)
        first.claim(DemoCourierBackend.demoLink(0))
        first.claim(DemoCourierBackend.demoLink(1))
        advanceUntilIdle()
        backend.revokeAll()
        val reopened = CourierViewModel(backend, store)
        reopened.restore()
        advanceUntilIdle()
        assertTrue(reopened.state.value.deliveries.isEmpty())
        assertTrue("guardadas e todas encerradas: volta à primeira tela", reopened.state.value.ended)
    }

    // --- ligação HTTP (nomes provisórios) -------------------------------------------------------------------------

    @Test fun httpTrocaCodigoPelaCredencialERevogacaoViraCourierRevoked() = runTest(dispatcher) {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"data":{"token":"tok-1","delivery":{"id":"d1","label":"Pedido nº 7","eta_minutes":9,"novo":true}}}"""))
        server.enqueue(MockResponse().setBody("""{"active":true,"last_at":2000,"near":true,"eta_minutes":3,"app":{"upload_seconds":45}}"""))
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":{"code":"revoked","message":"Encerrada"}}"""))
        server.start()
        try {
            val base = server.url("/").toString().trimEnd('/')
            val http = HttpCourierBackend()
            val (session, delivery) = http.claim(CourierLink(base, "CODIGO123"))
            assertEquals("tok-1", session.token)
            assertEquals("Pedido nº 7", delivery.label)
            val claim = server.takeRequest()
            assertEquals("/api/courier/claim", claim.path)
            assertTrue(claim.body.readUtf8().contains("CODIGO123"))

            val reply = http.positions(session, listOf(PositionPoint(2000, -23.5, -46.6)), 70)
            assertTrue(reply.near)
            assertEquals(45, reply.app!!.uploadSeconds)
            val batch = server.takeRequest()
            assertEquals("Bearer tok-1", batch.getHeader("Authorization"))
            assertEquals("/api/courier/deliveries/d1/positions", batch.path)

            val revoked = runCatching { http.delivery(session) }.exceptionOrNull()
            assertTrue(revoked is CourierRevoked)
        } finally {
            server.shutdown()
        }
    }
}
