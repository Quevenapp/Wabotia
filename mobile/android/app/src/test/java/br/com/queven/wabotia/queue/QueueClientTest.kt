package br.com.queven.wabotia.queue

import br.com.queven.wabotia.device.toRuntime
import kotlinx.coroutines.test.runTest
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

/**
 * O cliente da fila e o do pareamento contra respostas no formato do contrato (docs/FILA-SENHAS.md e
 * docs/PAREAMENTO.md). O Vinki de verdade é provado nos testes do servidor e no roteiro de bancada.
 */
class QueueClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: QueueClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = QueueClient(server.url("/").toString(), "area-1", { "wab_token" })
    }

    @After
    fun tearDown() = server.shutdown()

    private val overviewJson =
        """
        {"day":"2026-11-14","settings":{"front_door":true,"notify_ahead":2},
         "queues":[
          {"id":"q1","name":"Geral","prefix_normal":"N","prefix_preferential":"P","channels":["whatsapp","kiosk"],"enabled":true,
           "preferential_notice":"60+","waiting":{"normal":4,"preferential":2},"wait_minutes":{"normal":35,"preferential":10},"open_counters":2,
           "campo_novo":{"x":1}},
          {"id":"q2","name":"Só WhatsApp","channels":["whatsapp"],"enabled":true,"waiting":{"normal":1,"preferential":0},"wait_minutes":{"normal":5,"preferential":0}},
          {"id":"q3","name":"Sem estimativa","channels":["kiosk"],"enabled":true,"wait_mode":"off","waiting":{"normal":0,"preferential":0},"wait_minutes":{"normal":null,"preferential":null}}
         ],
         "counters":[{"id":"c1","name":"Guichê 1","queue_ids":["q1"],"status":"open","user_id":null,"user_name":null,
           "current":{"id":"t9","queue_id":"q1","queue_name":"Geral","code":"N009","preferential":false,"status":"called","call_count":1,"ahead":0,"wait_minutes":0,"created_at":1}}],
         "recent_calls":[{"ticket_id":"t9","code":"N009","preferential":false,"queue_id":"q1","queue_name":"Geral","counter_id":"c1","counter_name":"Guichê 1","call_count":2,"recall":true,"at":1700000000000,"speech":"Senha N 9, Guichê 1"}]}
        """.trimIndent()

    @Test
    fun `le a fila e entrega aos quadros so as filas do totem`() = runTest {
        server.enqueue(MockResponse().setBody(overviewJson))
        val overview = client.overview()
        val request = server.takeRequest()
        assertEquals("/api/v1/profiles/area-1/queue", request.path)
        assertEquals("Bearer wab_token", request.getHeader("Authorization"))
        assertEquals(3, overview.queues!!.size)
        assertEquals("N009", overview.counters!![0].current!!.code)
        assertNull(overview.queues!![2].waitMinutes!!.normal)

        val runtime = overview.toRuntime("Totem da entrada")
        assertEquals(listOf("Geral", "Sem estimativa"), runtime.options.map { it.name })
        assertEquals(6, runtime.options[0].waitingCount)
        assertEquals(35, runtime.options[0].estimatedWaitMinutes)
        assertNull(runtime.options[1].estimatedWaitMinutes)
        val call = runtime.calls.single()
        assertEquals("calling", call.status)
        assertEquals("Guichê 1", call.stationLabel)
        assertEquals(1, call.recalls)
    }

    @Test
    fun `emite com chave de idempotencia e le o cupom`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"id":"t1","queue_id":"q1","queue_name":"Geral","code":"P003","preferential":true,"source":"kiosk","status":"waiting",
                   "ahead":2,"wait_minutes":12,"created_at":1794675900000,"public_token":"abc",
                   "whatsapp_link":"https://wa.me/5511999998888?text=SENHA%20P003%20AB12CD"}""",
            ),
        )
        val ticket = client.issue("q1", preferential = true, key = "chave-1")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/v1/profiles/area-1/queue/tickets", request.path)
        assertEquals("chave-1", request.getHeader("Idempotency-Key"))
        val body = request.body.readUtf8()
        assertTrue(body.contains("\"queue_id\":\"q1\""))
        assertTrue(body.contains("\"preferential\":true"))
        // Sem `source`, o servidor decide (kiosk para o aparelho pareado).
        assertFalse(body.contains("source"))
        assertEquals("P003", ticket.code)
        assertEquals(2, ticket.ahead)
        assertNotNull(ticket.whatsappLink)
    }

    @Test
    fun `toda escrita do guiche leva Idempotency-Key e vai para a rota do contrato`() = runTest {
        val ticket = """{"id":"t9","queue_id":"q1","code":"N009","status":"called","call_count":2}"""
        repeat(5) { server.enqueue(MockResponse().setBody(ticket)) }
        server.enqueue(MockResponse().setBody("""{"id":"c1","status":"paused"}"""))
        client.callNext("c1")
        client.ticketAction("t9", "recall")
        client.ticketAction("t9", "no-show")
        client.transfer("t9", queueId = "q2")
        client.transfer("t9", counterId = "c2")
        client.counterState("c1", "paused")
        val requests = List(6) { server.takeRequest() }
        assertEquals(
            listOf(
                "/api/v1/profiles/area-1/queue/counters/c1/call-next",
                "/api/v1/profiles/area-1/queue/tickets/t9/recall",
                "/api/v1/profiles/area-1/queue/tickets/t9/no-show",
                "/api/v1/profiles/area-1/queue/tickets/t9/transfer",
                "/api/v1/profiles/area-1/queue/tickets/t9/transfer",
                "/api/v1/profiles/area-1/queue/counters/c1/state",
            ),
            requests.map { it.path },
        )
        assertTrue(requests.all { it.method == "POST" && !it.getHeader("Idempotency-Key").isNullOrBlank() })
        assertEquals(6, requests.map { it.getHeader("Idempotency-Key") }.toSet().size)
        assertEquals("{\"queue_id\":\"q2\"}", requests[3].body.readUtf8())
        assertEquals("{\"counter_id\":\"c2\"}", requests[4].body.readUtf8())
        assertEquals("{\"status\":\"paused\"}", requests[5].body.readUtf8())
    }

    @Test
    fun `recusa do contrato vira QueueException com o codigo`() = runTest {
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"code":"kiosk_rate","message":"Muitas senhas em pouco tempo."}}"""))
        val error = runCatching { client.issue("q1", false) }.exceptionOrNull() as QueueException
        assertEquals("kiosk_rate", error.code)
        assertEquals("Muitas senhas em pouco tempo.", error.message)
        assertFalse(error.retryable)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"queue_empty","message":"Nenhuma senha aguardando."}}"""))
        val empty = runCatching { client.callNext("c1") }.exceptionOrNull() as QueueException
        assertEquals("queue_empty", empty.code)
        server.takeRequest()
        assertEquals("/api/v1/profiles/area-1/queue/counters/c1/call-next", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        val revoked = runCatching { client.overview() }.exceptionOrNull() as QueueException
        assertTrue(revoked.unauthorized)
        assertEquals("http_401", revoked.code)
    }

    @Test
    fun `queda de rede pode repetir com a mesma chave`() = runTest {
        server.shutdown()
        val error = runCatching { client.overview() }.exceptionOrNull() as QueueException
        assertEquals(QueueException.NETWORK, error.code)
        assertTrue(error.retryable)
    }

    @Test
    fun `pareamento usa o cliente senhapp e pede so ler e emitir`() = runTest {
        server.enqueue(MockResponse().setBody("""{"device_code":"d","user_code":"ABCD-2345","expires_in":600,"interval":5,"client":"senhapp"}"""))
        server.enqueue(MockResponse().setBody("""{"status":"authorization_pending","interval":5}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"status":"connected","access_token":"wab_x","profile_id":"area-1","token_type":"Bearer","expires_in":31536000,
                   "application_id":"app-1","scopes":["queue:read","queue:issue"],"number_ids":[],"pool_ids":[],"bot_ids":[],"key_expires":1}""",
            ),
        )
        val pairing = QueuePairing()
        val base = server.url("/").toString()
        assertEquals("ABCD-2345", pairing.start(base, " Totem da entrada ").userCode)
        val start = server.takeRequest()
        assertEquals("/api/pairing/start", start.path)
        val body = start.body.readUtf8()
        assertTrue(body.contains("\"client\":\"senhapp\""))
        assertTrue(body.contains("\"instance_name\":\"Totem da entrada\""))
        assertTrue(body.contains("\"scopes\":[\"queue:read\",\"queue:issue\"]"))
        assertFalse(body.contains("queue:operate"))
        assertNull(start.getHeader("Authorization"))

        assertEquals("authorization_pending", pairing.poll(base, "d").status)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"device_code\":\"d\""))
        val done = pairing.poll(base, "d")
        assertEquals("wab_x", done.accessToken)
        assertEquals("area-1", done.profileId)
        assertEquals(listOf("queue:read", "queue:issue"), done.scopes)
    }

    @Test
    fun `pareamento traduz recusa e devagar`() = runTest {
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"code":"slow_down","message":"Aguarde."}}"""))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"access_denied","message":"Recusado."}}"""))
        val pairing = QueuePairing()
        val base = server.url("/").toString()
        assertEquals("slow_down", (runCatching { pairing.poll(base, "d") }.exceptionOrNull() as QueueException).code)
        assertEquals("access_denied", (runCatching { pairing.poll(base, "d") }.exceptionOrNull() as QueueException).code)
    }

    @Test
    fun `desfazer pareamento usa a propria credencial`() = runTest {
        server.enqueue(MockResponse().setBody("""{"disconnected":true}"""))
        QueuePairing().disconnect(server.url("/").toString(), "wab_x")
        val request = server.takeRequest()
        assertEquals("/api/v1/pairings/disconnect", request.path)
        assertEquals("Bearer wab_x", request.getHeader("Authorization"))
    }

    @Test
    fun `quadros do WebSocket`() {
        val call = QueueFrame.parse("""{"type":"call","data":{"ticket_id":"t1","code":"N023","counter_name":"Guichê 2","call_count":1,"at":5}}""")
        assertEquals("N023", (call as QueueFrame.Call).call.code)
        assertEquals("t1#1", call.call.key)
        val snapshot = QueueFrame.parse("""{"type":"snapshot","data":$overviewJson}""")
        assertEquals("Geral", (snapshot as QueueFrame.Snapshot).overview.queues!![0].name)
        assertEquals(QueueFrame.Pong, QueueFrame.parse("""{"type":"pong"}"""))
        assertNull(QueueFrame.parse("lixo"))
        assertNull(QueueFrame.parse("""{"type":"call","data":{"sem":"ticket"}}"""))
    }

    @Test
    fun `endereco sem https ganha https`() {
        assertEquals("https://wabotia.exemplo.com.br", normalizeBaseUrl(" wabotia.exemplo.com.br/ "))
        assertEquals("http://127.0.0.1:8799", normalizeBaseUrl("http://127.0.0.1:8799"))
    }
}
