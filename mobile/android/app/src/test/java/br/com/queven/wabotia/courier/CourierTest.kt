package br.com.queven.wabotia.courier

import br.com.queven.wabotia.core.model.WabotiaJson
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** O modo entregador contra o contrato de docs/ENTREGA.md e docs/API.md (feat/modulo-entrega, c8d65f2). */
@OptIn(ExperimentalCoroutinesApi::class)
class CourierTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun main() = Dispatchers.setMain(dispatcher)

    @After fun reset() = Dispatchers.resetMain()

    // --- QR -------------------------------------------------------------------------------------------------------

    private val code = "DEMxENTREGAxLANCHExNUMxDzEZEW23Q"

    private fun rejected(raw: String) = (CourierLinks.check(raw) as CourierScan.Rejected).message

    @Test fun leituraDoQr() {
        assertEquals(CourierLink("https://loja.exemplo.com.br", code), CourierLinks.parse("https://loja.exemplo.com.br/c/$code"))
        assertEquals(CourierLink("https://loja.exemplo.com.br:8443", code), CourierLinks.parse(" https://Loja.Exemplo.com.br:8443/c/$code "))
        assertEquals("loja.exemplo.com.br", CourierLinks.parse("https://loja.exemplo.com.br/c/$code")!!.host)
    }

    @Test fun formatosRecusadosComMensagemClara() {
        assertEquals(CourierLinks.NOT_HTTPS, rejected("http://loja.exemplo.com.br/c/$code"))
        assertEquals(CourierLinks.LOCAL, rejected("https://192.168.0.10/c/$code"))
        assertEquals(CourierLinks.LOCAL, rejected("https://[::1]/c/$code"))
        assertEquals(CourierLinks.LOCAL, rejected("https://localhost/c/$code"))
        assertEquals(CourierLinks.LOCAL, rejected("https://wabotia.local/c/$code"))
        assertEquals(CourierLinks.LOCAL, rejected("https://servidor/c/$code"))
        // Não é do Wabotia (ou o código está fora do formato de 32 caracteres sem 0, 1, I, O, l e o).
        assertEquals(CourierLinks.NOT_ORDER, rejected("https://wa.me/552090000000?text=SENHA%20N004"))
        assertEquals(CourierLinks.NOT_ORDER, rejected("https://loja.exemplo.com.br/x/$code"))
        assertEquals(CourierLinks.NOT_ORDER, rejected("https://loja.exemplo.com.br/c/$code/extra"))
        assertEquals(CourierLinks.NOT_ORDER, rejected("https://loja.exemplo.com.br/c/" + code.dropLast(1)))
        assertEquals(CourierLinks.NOT_ORDER, rejected("https://loja.exemplo.com.br/c/" + code.dropLast(1) + "0"))
        assertEquals(CourierLinks.NOT_ORDER, rejected("https://loja.exemplo.com.br/c/$code?x=1"))
        assertEquals(CourierLinks.NOT_ORDER, rejected("SENHA N004 AB12CD"))
        assertEquals(CourierLinks.NOT_ORDER, rejected(""))
        // O servidor da leitura pública só vale se for o mesmo host do QR.
        val link = CourierLinks.parse("https://loja.exemplo.com.br/c/$code")!!
        assertTrue(CourierLinks.sameServer(link, "https://loja.exemplo.com.br/"))
        assertTrue(CourierLinks.sameServer(link, null))
        assertFalse(CourierLinks.sameServer(link, "https://outra.exemplo.com.br"))
    }


    private fun p(t: Long, lat: Double, lng: Double = -46.6, accuracy: Float? = 10f) = PositionPoint(t, lat, lng, accuracy)

    @Test fun filaDescartaRuimParadoEVelho() {
        val q = PositionQueue()
        q.add(p(1_000, 0.0, 0.0))                 // 0,0
        q.add(p(2_000, -23.5, accuracy = 500f))   // precisão pior que 300 m
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
    }

    // --- visão do entregador ----------------------------------------------------------------------------------------

    @Test fun visaoDoEntregadorComoOServidorManda() {
        val d = WabotiaJson.decodeFromString(
            CourierDelivery.serializer(),
            """{"id":"d1","label":"Pedido nº 12","customer_name":"Mariana","address_text":"Rua A, 1","destination":{"lat":-23.5,"lng":-46.6,"source":"device"},
               "status":"en_route","status_label":"A caminho","eta":{"at":1,"minutes":12,"distance_m":2400},"arriving":false,"signal":"ok",
               "order":{"number":12,"lines":[{"name":"X-Burger","quantity":2,"options":["sem cebola"],"note":"bem passado"}],"item_count":2,"total_cents":5700,
                        "customer_note":"Interfone com defeito","payment":{"method_label":"Dinheiro","status":"pending","status_label":"A receber","paid":false,"change_for_cents":10000}},
               "chat":{"last_seq":3,"customer_open":true},"app":{"sample_seconds":15,"upload_seconds":60,"max_batch":200}}""",
        )
        assertTrue(d.enRoute)
        assertEquals(listOf("2x X-Burger (sem cebola) — bem passado"), d.items)
        assertEquals("Dinheiro · cobrar R$ 57,00", d.paymentText)
        assertEquals("Troco para R$ 100,00", d.changeText)
        assertEquals("Cerca de 12 min · 2,4 km", CourierTexts.eta(d))
        assertEquals("Chegando", CourierTexts.eta(d.copy(arriving = true)))
        assertEquals("Pix · pago", d.copy(order = d.order!!.copy(payment = CourierPayment(methodLabel = "Pix", paid = true))).paymentText)
        assertNull(CourierTexts.eta(d.copy(eta = null)))
    }

    // --- tela (ViewModel) com o servidor da demonstração ----------------------------------------------------------

    private val k12 = "lanchonete.example/dl-12"
    private val k15 = "pizzaria.example/dl-15"

    /** Ler o QR, conferir a loja e continuar. */
    private fun CourierViewModel.read(index: Int, scope: kotlinx.coroutines.test.TestScope) {
        scanned(DemoCourierBackend.QRS[index])
        scope.advanceUntilIdle()
        confirmContinue()
        scope.advanceUntilIdle()
    }

    @Test fun confirmaALojaAntesDeGastarOCodigoEPedeONome() = runTest(dispatcher) {
        val backend = DemoCourierBackend()
        val store = MemoryCourierSessionStore()
        val vm = CourierViewModel(backend, store, device = "Teste")
        vm.scanned(DemoCourierBackend.QRS[0])
        advanceUntilIdle()
        val confirm = vm.state.value.confirm!!
        assertEquals("Lanchonete Exemplo", confirm.store)
        assertEquals("lanchonete.example", confirm.link.host)
        // Cancelar não gasta nada.
        vm.cancelConfirm()
        assertNull(vm.state.value.confirm)
        assertTrue(store.load().isEmpty())
        // Continuar sem nome guardado pede o nome; o nome vale para todas as lojas.
        vm.scanned(DemoCourierBackend.QRS[0])
        advanceUntilIdle()
        vm.confirmContinue()
        assertNotNull(vm.state.value.pendingLink)
        vm.claimWithName("  Carlos Souza ")
        advanceUntilIdle()
        assertEquals("Carlos Souza", store.name)
        assertEquals(listOf(k12), vm.state.value.deliveries.map { it.id })
        assertEquals("Lanchonete Exemplo", vm.state.value.deliveries.single().store)
        // Recusado logo na leitura: nada vai ao servidor.
        vm.scanned("http://lanchonete.example/c/${DemoCourierBackend.CODES[0]}")
        assertEquals(CourierLinks.NOT_HTTPS, vm.state.value.notice)
        assertNull(vm.state.value.confirm)
    }

    @Test fun duasLojasAoMesmoTempoERevogacaoDeUmaSo() = runTest(dispatcher) {
        val backend = DemoCourierBackend(clock = { 1_000_000L })
        val store = MemoryCourierSessionStore().apply { name = "Carlos" }
        val vm = CourierViewModel(backend, store, device = "Teste", clock = { 1_000_000L })
        vm.restore()
        advanceUntilIdle()
        vm.read(0, this)
        vm.read(1, this)
        assertEquals(listOf(k12, k15), vm.state.value.deliveries.map { it.id })
        assertEquals(listOf("Lanchonete Exemplo", "Pizzaria Exemplo"), vm.state.value.deliveries.map { it.store })
        // Cada entrega guarda o próprio servidor e o próprio token.
        assertEquals(setOf("https://lanchonete.example", "https://pizzaria.example"), store.load().map { it.server }.toSet())
        assertEquals(2, store.load().map { it.token }.toSet().size)

        // As duas a caminho: a mesma leitura do GPS vai para as duas, cada uma ao seu servidor.
        vm.start(k12) { null }
        advanceUntilIdle()
        vm.start(k15) { null }
        advanceUntilIdle()
        vm.onLocation(PositionPoint(999_000L, -23.55, -46.63, 8f))
        vm.flush(battery = 80)
        assertTrue(vm.state.value.deliveries.all { it.eta?.distanceM != null })

        // A pizzaria revoga a dela: só ela sai; a da lanchonete continua.
        backend.revoke("dl-15")
        vm.onLocation(PositionPoint(999_500L, -23.56, -46.63, 8f))
        vm.flush(battery = 80)
        assertEquals(listOf(k12), vm.state.value.deliveries.map { it.id })
        assertFalse(vm.state.value.ended)
        assertEquals(listOf("https://lanchonete.example"), store.load().map { it.server })

        // Conversa e conclusão vão ao servidor da entrega.
        vm.open(k12)
        advanceUntilIdle()
        vm.send(k12, CourierParty.CUSTOMER, "Cheguei no portão")
        advanceUntilIdle()
        assertTrue(vm.state.value.messages[k12]!!.any { it.mine && it.text == "Cheguei no portão" })
        vm.delivered(k12, battery = 80)
        advanceUntilIdle()
        assertTrue(vm.state.value.deliveries.isEmpty())
        assertTrue(vm.state.value.ended)
        assertTrue(store.load().isEmpty())
    }

    @Test fun qrQueNaoValeMaisOuQueApontaOutroServidor() = runTest(dispatcher) {
        val store = MemoryCourierSessionStore().apply { name = "Ana" }
        val demo = DemoCourierBackend()
        // Já lido: a leitura pública diz `valid: false`.
        val vm = CourierViewModel(demo, store)
        vm.read(0, this)
        vm.scanned(DemoCourierBackend.QRS[0])
        advanceUntilIdle()
        assertEquals(CourierViewModel.INVALID, vm.state.value.notice)
        assertNull(vm.state.value.confirm)
        // A leitura aponta outro host: o app não segue e não troca o código.
        val other = object : CourierBackend by demo {
            override suspend fun preview(link: CourierLink) = CourierPreview(valid = true, store = "Loja", server = "https://outro.example")
        }
        val vm2 = CourierViewModel(other, MemoryCourierSessionStore().apply { name = "Ana" })
        vm2.scanned(DemoCourierBackend.QRS[1])
        advanceUntilIdle()
        assertTrue(vm2.state.value.notice!!.contains("outro servidor"))
        assertNull(vm2.state.value.confirm)
        assertTrue(vm2.state.value.deliveries.isEmpty())
    }

    @Test fun janelaFechadaENaoConsegui() = runTest(dispatcher) {
        val store = MemoryCourierSessionStore().apply { name = "Ana" }
        val vm = CourierViewModel(DemoCourierBackend(), store)
        vm.read(1, this)
        vm.open(k15)
        advanceUntilIdle()
        assertEquals(false, vm.state.value.customerOpen[k15])
        vm.send(k15, CourierParty.CUSTOMER, "Oi")
        advanceUntilIdle()
        assertTrue(vm.state.value.notice!!.contains("24 horas"))
        vm.cancel(k15, "Cliente ausente")
        advanceUntilIdle()
        assertTrue(vm.state.value.ended)
    }

    @Test fun reabrirRetomaSoAsEntregasVivas() = runTest(dispatcher) {
        val backend = DemoCourierBackend()
        val store = MemoryCourierSessionStore().apply { name = "Ana" }
        val first = CourierViewModel(backend, store)
        first.read(0, this)
        first.read(1, this)
        backend.revoke("dl-12")
        val reopened = CourierViewModel(backend, store)
        reopened.restore()
        advanceUntilIdle()
        assertEquals(listOf(k15), reopened.state.value.deliveries.map { it.id })
        assertEquals("Pizzaria Exemplo", reopened.state.value.deliveries.single().store)
        backend.revoke("dl-15")
        val again = CourierViewModel(backend, store)
        again.restore()
        advanceUntilIdle()
        assertTrue("guardadas e todas encerradas: volta à primeira tela", again.state.value.ended)
    }

    // --- ligação HTTP -----------------------------------------------------------------------------------------------

    @Test fun leituraPublicaNaoGastaOCodigo() = runTest(dispatcher) {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"valid":true,"store":"Lanchonete Exemplo","server":"https://x","expires_at":5}"""))
        server.start()
        try {
            val base = server.url("/").toString().trimEnd('/')
            val preview = HttpCourierBackend().preview(CourierLink(base, code))
            assertTrue(preview.valid)
            assertEquals("Lanchonete Exemplo", preview.store)
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/c/$code", request.path)
            assertEquals("application/json", request.getHeader("Accept"))
            assertNull(request.getHeader("Authorization"))
        } finally {
            server.shutdown()
        }
    }

    @Test fun httpSegueOContrato() = runTest(dispatcher) {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setBody(
                """{"token":"wabx_1","expires_at":9,"profile":"p1","module":"entrega","subject":"d1","credential_id":"c1",
                   "data":{"delivery":{"id":"d1","label":"Pedido nº 7","status":"assigned","customer_name":"Ana","address_text":"Rua B"},"app":{"upload_seconds":45}}}""",
            ),
        )
        server.enqueue(MockResponse().setBody("""{"id":"d1","status":"en_route","app":{"upload_seconds":30}}"""))
        server.enqueue(MockResponse().setBody("""{"active":true,"status":"en_route","accepted":1,"ignored":0,"last_at":2000,"eta":{"minutes":3,"at":5,"distance_m":800},"arriving":false,"app":{"upload_seconds":30},"chat":{"last_seq":4}}"""))
        server.enqueue(MockResponse().setBody("""{"data":[{"seq":4,"channel":"store","sender":"store","author_name":"Loja","text":"Oi","created":1}],"last_seq":4,"customer_open":false,"open":true}"""))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"window_closed","message":"Janela fechada"}}"""))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"invalid_token","message":"x"}}"""))
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":{"code":"claim_used","message":"x"}}"""))
        server.start()
        try {
            val base = server.url("/").toString().trimEnd('/')
            val http = HttpCourierBackend()
            val (session, delivery) = http.claim(CourierLink(base, "CODIGO123"), "Carlos Souza", "Moto G (Android 14)")
            assertEquals("wabx_1", session.token)
            assertEquals("p1", session.profile)
            assertEquals("d1", session.deliveryId)
            assertEquals(45, delivery.app!!.uploadSeconds)
            val claim = server.takeRequest()
            assertEquals("/api/credentials/claim", claim.path)
            val claimBody = claim.body.readUtf8()
            assertTrue(claimBody.contains("\"code\":\"CODIGO123\"") && claimBody.contains("Carlos Souza") && claimBody.contains("Moto G"))
            assertNull(claim.getHeader("Authorization"))

            assertEquals(30, http.start(session, LatLng(-23.5, -46.6))!!.uploadSeconds)
            val start = server.takeRequest()
            assertEquals("/api/v1/profiles/p1/entrega/deliveries/d1/start", start.path)
            assertEquals("Bearer wabx_1", start.getHeader("Authorization"))
            assertNotNull(start.getHeader("Idempotency-Key"))
            assertTrue(start.body.readUtf8().contains("\"destination\":{\"lat\":-23.5"))

            val reply = http.positions(session, listOf(PositionPoint(2000, -23.5, -46.6)), 70)
            assertTrue(reply.near)
            assertEquals(4L, reply.chat!!.lastSeq)
            val batch = server.takeRequest()
            assertEquals("/api/v1/profiles/p1/entrega/deliveries/d1/positions", batch.path)
            assertNull("o lote não leva Idempotency-Key", batch.getHeader("Idempotency-Key"))

            val page = http.messages(session, after = 3)
            assertEquals(1, page.data.size)
            assertEquals(false, page.customerOpen)
            assertEquals("/api/v1/profiles/p1/entrega/deliveries/d1/messages?after=3", server.takeRequest().path)

            val closed = runCatching { http.send(session, CourierParty.CUSTOMER, "Oi") }.exceptionOrNull() as CourierFailure
            assertEquals("window_closed", closed.code)
            assertTrue(server.takeRequest().body.readUtf8().contains("\"channel\":\"customer\""))

            assertTrue(runCatching { http.delivery(session) }.exceptionOrNull() is CourierRevoked)
            server.takeRequest()

            // Na troca do QR, o erro vira texto para o entregador, não revogação.
            val used = runCatching { http.claim(CourierLink(base, "CODIGO123"), "Carlos", "x") }.exceptionOrNull()
            assertTrue(used is CourierFailure && used.message!!.contains("já foi lido"))
        } finally {
            server.shutdown()
        }
    }
}
