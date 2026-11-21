package br.com.queven.wabotia.device

import br.com.queven.wabotia.device.core.PanelCallAnnouncer
import br.com.queven.wabotia.printing.CouponData
import br.com.queven.wabotia.printing.CouponText
import br.com.queven.wabotia.queue.CallFrame
import br.com.queven.wabotia.queue.DebugNetwork
import br.com.queven.wabotia.queue.DeviceScopes
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.QueueInfo
import br.com.queven.wabotia.queue.QueueOverview
import br.com.queven.wabotia.queue.QueueTicket
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A lógica do totem e do painel que veio do Senhapp, ligada ao contrato do Vinki. */
class TotemLogicTest {
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

    private val ticket = """{"id":"t1","queue_id":"q1","queue_name":"Geral","code":"N007","status":"waiting","ahead":3,"wait_minutes":null,"created_at":1}"""

    @Test
    fun `queda no meio da emissao repete uma vez com a mesma chave`() = runTest {
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        server.enqueue(MockResponse().setBody(ticket))
        val issued = issueOnce(client, "q1", preferential = false, key = "chave-totem", pauseMs = 0)
        assertEquals("N007", issued.code)
        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("chave-totem", first.getHeader("Idempotency-Key"))
        assertEquals("chave-totem", second.getHeader("Idempotency-Key"))
        assertEquals(first.body.readUtf8(), second.body.readUtf8())
    }

    @Test
    fun `recusa do contrato nao repete`() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"queue_closed","message":"Fila fechada."}}"""))
        val error = runCatching { issueOnce(client, "q1", false, "k", pauseMs = 0) }.exceptionOrNull() as QueueException
        assertEquals("queue_closed", error.code)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `depois de duas falhas o toque seguinte repete a mesma chave e nao emite senha fantasma`() = runTest {
        val keys = TotemIssueKeys()
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        val first = keys.key("q1", false)
        val error = runCatching { issueOnce(client, "q1", false, first, pauseMs = 0) }.exceptionOrNull() as QueueException
        keys.settle(error)
        assertEquals(first, keys.pending?.key)
        // O servidor gravou a primeira: com a mesma chave, devolve a mesma senha.
        server.enqueue(MockResponse().setBody(ticket))
        val again = keys.key("q1", false)
        assertEquals(first, again)
        assertEquals("N007", issueOnce(client, "q1", false, again, pauseMs = 0).code)
        keys.settle(null)
        assertNull(keys.pending)
        assertEquals(List(3) { first }, List(3) { server.takeRequest().getHeader("Idempotency-Key") })
        assertNotEquals(first, keys.key("q1", false))
    }

    @Test
    fun `pedido incerto so vale para a mesma fila e o mesmo tipo dentro do prazo`() {
        var now = 1_000L
        var n = 0
        val keys = TotemIssueKeys(windowMs = 60_000, clock = { now }, newKey = { "k${++n}" })
        val network = QueueException(0, QueueException.NETWORK, "Sem conexão")
        assertEquals("k1", keys.key("q1", false))
        keys.settle(network)
        assertEquals(PendingIssue("q1", false, "k1", 1_000L), keys.pending)
        now = 30_000L
        assertEquals("k1", keys.key("q1", false))
        keys.settle(network)
        // Outro tipo ou outra fila: outra chave, e o pedido guardado passa a ser o novo.
        assertEquals("k2", keys.key("q1", true))
        keys.settle(network)
        assertEquals("k3", keys.key("q2", true))
        keys.settle(network)
        // Passado o prazo (contado do primeiro toque), a chave não volta.
        now = 30_000L + 60_001L
        assertEquals("k4", keys.key("q2", true))
        // Recusa do contrato é resposta definitiva: libera.
        keys.settle(QueueException(409, "queue_closed", "Fila fechada."))
        assertNull(keys.pending)
        assertEquals("k5", keys.key("q2", true))
        keys.settle(QueueException(503, "unavailable", "Fora do ar"))
        assertEquals("k5", keys.key("q2", true))
    }

    @Test
    fun `sem estimativa o cupom fala so das pessoas a frente`() {
        val data = CouponData.of(QueueTicket(id = "t1", code = "N007", ahead = 3, waitMinutes = null), "Totem")
        assertEquals("3 pessoas à sua frente", CouponText.position(data))
        val withWait = CouponData.of(QueueTicket(id = "t1", code = "N007", ahead = 1, waitMinutes = 9), "Totem")
        assertEquals("1 pessoa à sua frente · cerca de 9 min", CouponText.position(withWait))
    }

    @Test
    fun `link do cupom so vale com https`() {
        val bad = CouponData.of(QueueTicket(id = "t1", code = "N007", whatsappLink = "javascript:alert(1)"), "Totem")
        assertEquals(null, bad.whatsappLink)
    }

    @Test
    fun `chamada pelo WebSocket e a mesma no snapshot nao falam duas vezes`() {
        val announcer = PanelCallAnnouncer()
        announcer.prime(emptyList())
        val frame = CallFrame(ticketId = "t9", code = "N009", counterName = "Guichê 1", callCount = 1, at = 1000)
        val viaSocket = announcer.announce(listOf(frame.toStationCall(0)))
        assertTrue(viaSocket.chime)
        assertEquals(listOf("Senha N 9. Guichê 1."), viaSocket.spoken)
        val viaSnapshot = announcer.announce(listOf(frame.toStationCall(0)))
        assertFalse(viaSnapshot.chime)
        // Rechamar soma call_count e muda `at`: fala de novo.
        val recall = announcer.announce(listOf(frame.copy(callCount = 2, at = 2000).toStationCall(0)))
        assertTrue(recall.chime)
    }

    @Test
    fun `permissoes do aparelho`() {
        val base = DeviceConfig("d", "https://x", "wab_x", "p", "Totem")
        assertTrue(base.canIssue())
        assertFalse(base.copy(scopes = listOf(DeviceScopes.READ)).canIssue())
        assertTrue(base.copy(scopes = DeviceScopes.requested).canIssue())
        assertFalse(base.toString().contains("wab_x"))
        assertEquals(listOf("queue:read", "queue:issue"), DeviceScopes.requested)
    }

    @Test
    fun `quadrado da fila no totem usa a letra das senhas`() {
        val overview = QueueOverview(
            queues = listOf(
                QueueInfo(id = "q1", name = "Atendimento geral", prefixNormal = "N", prefixPreferential = "P", channels = listOf("kiosk")),
                QueueInfo(id = "q2", name = "Retirada", channels = listOf("kiosk", "whatsapp")),
                QueueInfo(id = "q3", name = "Interna", prefixNormal = "I", channels = listOf("whatsapp")),
            ),
        )
        val options = overview.toRuntime("Totem").options
        assertEquals(listOf("q1", "q2"), options.map { it.queueId })
        assertEquals('N', options[0].letter)
        assertEquals(null, options[1].letter)
    }

    @Test
    fun `comando de depuracao da rede`() {
        assertEquals(20, DebugNetwork.parse("offline:20"))
        assertEquals(null, DebugNetwork.parse("offline:x"))
        assertEquals(null, DebugNetwork.parse("20"))
        assertEquals(null, DebugNetwork.parse(null))
    }

    @Test
    fun `cartao da senha fica mais tempo sem papel`() {
        assertTrue(issuedCardMillis(printed = false) > issuedCardMillis(printed = true))
    }
}
