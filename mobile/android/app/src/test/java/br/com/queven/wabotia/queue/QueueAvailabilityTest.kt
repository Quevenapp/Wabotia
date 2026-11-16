package br.com.queven.wabotia.queue

import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A fila só aparece quando o servidor a oferece: capacidades primeiro, `GET /queue` enquanto elas não existem. */
class QueueAvailabilityTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun probe() = QueueAvailabilityProbe(server.url("/").toString(), "area-1", { "wabu_x" })

    private fun parse(text: String) = ModuleCapabilities.hasModule(WabotiaJson.parseToJsonElement(text))

    @Test
    fun `formatos aceitos da lista de modulos`() {
        assertEquals(true, parse("""{"version":"0.20.0","modules":[{"id":"queue","version":"1.0.0"},{"id":"agenda"}]}"""))
        assertEquals(false, parse("""{"modules":[{"id":"queue","enabled":false}]}"""))
        assertEquals(false, parse("""{"modules":[{"id":"agenda"}]}"""))
        assertEquals(true, parse("""{"modules":["agenda","queue"]}"""))
        assertEquals(true, parse("""{"modules":{"queue":{"version":"1"}}}"""))
        assertEquals(false, parse("""{"modules":{"queue":{"enabled":0}}}"""))
        assertEquals(true, parse("""{"data":{"modules":[{"id":"fila","active":true}]}}"""))
        assertNull(parse("""{"version":"0.19.3"}"""))
    }

    @Test
    fun `rota de capacidades decide quando existe`() = runTest {
        server.enqueue(MockResponse().setBody("""{"modules":[{"id":"agenda"}]}"""))
        assertEquals(QueueAvailability.UNAVAILABLE, probe().check())
        val request = server.takeRequest()
        assertEquals("/api/v1/profiles/area-1/capabilities", request.path)
        assertEquals("Bearer wabu_x", request.getHeader("Authorization"))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `sem rota de capacidades a fila responde e aparece`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"x"}}"""))
        server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(MockResponse().setBody("""{"queues":[],"counters":[],"recent_calls":[]}"""))
        assertEquals(QueueAvailability.AVAILABLE, probe().check())
        assertEquals("/api/v1/profiles/area-1/capabilities", server.takeRequest().path)
        assertEquals("/api/v1/capabilities?profile_id=area-1", server.takeRequest().path)
        assertEquals("/api/v1/profiles/area-1/queue", server.takeRequest().path)
    }

    @Test
    fun `servidor sem fila esconde e queda de rede nao decide`() = runTest {
        repeat(3) { server.enqueue(MockResponse().setResponseCode(404)) }
        assertEquals(QueueAvailability.UNAVAILABLE, probe().check())
        repeat(2) { server.enqueue(MockResponse().setResponseCode(404)) }
        server.enqueue(MockResponse().setResponseCode(503))
        assertEquals(QueueAvailability.UNKNOWN, probe().check())
        server.shutdown()
        assertEquals(QueueAvailability.UNKNOWN, probe().check())
    }

    @Test
    fun `capacidades sem modulos caem para a fila`() = runTest {
        server.enqueue(MockResponse().setBody("""{"version":"0.20.0"}"""))
        server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"forbidden","message":"Sem acesso."}}"""))
        assertEquals(QueueAvailability.UNAVAILABLE, probe().check())
        assertTrue(server.requestCount == 3)
        assertFalse(QueueAvailability.UNAVAILABLE == QueueAvailability.AVAILABLE)
    }
}
