package br.com.queven.wabotia.demo

import br.com.queven.wabotia.queue.QueueAvailability
import br.com.queven.wabotia.queue.QueueAvailabilityProbe
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.QueuePairing
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A demonstração cobre o guichê e o modo aparelho sem servidor: os mesmos clientes do app, respondidos em memória. */
class DemoQueueTest {
    /** Atrás do interceptor da demonstração, qualquer chamada que escapasse responderia 599 (nunca a rede). */
    private val http = OkHttpClient.Builder()
        .addInterceptor(DemoMode.interceptor)
        .addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(599).message("fora da demonstração")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
        .build()
    private val client = QueueClient(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http)

    @Before fun fresh() {
        DemoServer.reset()
    }

    @Test fun aFilaAparecePelaRotaDeCapacidades() = runTest {
        assertEquals(QueueAvailability.AVAILABLE, QueueAvailabilityProbe(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http).check())
    }

    @Test fun guicheAbreChamaRechamaIniciaConcluiETransfere() = runTest {
        val overview = client.overview()
        assertEquals(2, overview.queues!!.size)
        assertEquals(3, overview.counters!!.size)
        assertTrue(overview.recentCalls!!.isNotEmpty())
        val counter = overview.counters!!.first { it.status == "closed" }

        val closed = runCatching { client.callNext(counter.id) }.exceptionOrNull() as QueueException
        assertEquals("counter_closed", closed.code)

        client.counterState(counter.id, "open")
        val called = client.callNext(counter.id)
        assertEquals("called", called.status)
        assertEquals(1, client.overview().recentCalls!!.count { it.ticketId == called.id })

        assertEquals(2, client.ticketAction(called.id, "recall").callCount)
        assertEquals("serving", client.ticketAction(called.id, "start").status)
        assertEquals("done", client.ticketAction(called.id, "finish").status)

        val next = client.callNext(counter.id)
        val other = overview.counters!!.first { it.id != counter.id && it.queueIds!!.contains(next.queueId) }
        val moved = client.transfer(next.id, counterId = other.id)
        assertEquals("waiting", moved.status)
        val invalid = runCatching { client.ticketAction(next.id, "start") }.exceptionOrNull() as QueueException
        assertEquals("invalid_transition", invalid.code)
    }

    @Test fun mesmaChaveDevolveAMesmaChamada() = runTest {
        val counter = client.overview().counters!!.first { it.status == "open" }
        val first = client.callNext(counter.id, key = "chave-repetida")
        val again = client.callNext(counter.id, key = "chave-repetida")
        assertEquals(first.id, again.id)
        val other = client.callNext(counter.id, key = "chave-nova")
        assertNotEquals(first.id, other.id)
    }

    @Test fun totemEmiteComQrFicticio() = runTest {
        val queue = client.overview().queues!!.first { it.kiosk }
        val ticket = client.issue(queue.id, preferential = true)
        assertTrue(ticket.code.startsWith(queue.prefixPreferential!!))
        assertNotNull(ticket.ahead)
        assertTrue(ticket.whatsappLink!!.startsWith("https://wa.me/${DemoMode.WHATSAPP_LINE}?"))
        assertTrue(DemoMode.WHATSAPP_LINE.matches(Regex("""552090\d{7}""")))
        // O texto que o servidor monta: convite para apertar ENVIAR e a linha SENHA que vincula a conversa.
        assertTrue(ticket.whatsappLink!!.contains("text=Aperte%20ENVIAR"))
        assertTrue(ticket.whatsappLink!!.contains("%0ASENHA%20${ticket.code}%20"))
    }

    @Test fun cupomDaDemonstracaoComTudoLigado() = runTest {
        val coupon = client.overview().coupon!!
        assertEquals(DemoMode.PROFILE_NAME, coupon.establishment?.name)
        assertTrue(coupon.position)
        assertTrue(coupon.whatsappQr)
        assertNotNull(coupon.footer)
        assertEquals(null, coupon.whatsappQrIssue)
        assertEquals(null, br.com.queven.wabotia.device.ui.DeviceTexts.qrNotice(prints = true, coupon = coupon))
    }

    @Test fun pareamentoDoAparelhoAprovaSozinho() = runTest {
        val pairing = QueuePairing(http)
        val start = pairing.start(DemoMode.SERVER, "Recepção")
        assertEquals("authorization_pending", pairing.poll(DemoMode.SERVER, start.deviceCode).status)
        val done = pairing.poll(DemoMode.SERVER, start.deviceCode)
        assertEquals("connected", done.status)
        assertEquals(DemoMode.DEVICE_TOKEN, done.accessToken)
        assertEquals(Ids.PROFILE, done.profileId)
        assertFalse(done.scopes!!.contains("queue:operate"))
        pairing.disconnect(DemoMode.SERVER, done.accessToken!!)
    }

    @Test fun dadosDaFilaSaoFicticios() = runTest {
        val counter = client.overview().counters!!.first { it.status == "open" }
        client.callNext(counter.id)
        val all = client.overview().toString()
        for (word in listOf("Queven", "Bruno", "Fagoo", "Printher", "Vinki", ".com.br")) assertFalse(word, all.contains(word, ignoreCase = true))
        Regex("""\b55\d{10,11}\b""").findAll(all).forEach { assertTrue("telefone ${it.value}", it.value.matches(Regex("""552090\d{7}"""))) }
    }

    @Test fun atalhosDoModoAparelho() {
        assertEquals(null, DemoMode.deviceRoleFor("conversations"))
        assertEquals(null, DemoMode.deviceRoleFor("device")!!.getOrNull())
        assertEquals("TOTEM", DemoMode.deviceRoleFor("device-totem")!!.getOrNull()!!.name)
        assertEquals(DemoMode.SERVER, DemoMode.deviceConfig(null).baseUrl)
        assertTrue(DemoMode.deviceConfig(null).demo)
    }
}
