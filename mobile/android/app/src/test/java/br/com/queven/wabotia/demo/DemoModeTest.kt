package br.com.queven.wabotia.demo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Demonstração pública (todos os builds): o servidor fictício responde, sem rede, aos fluxos principais (fila, assumir,
 * responder, transferir, protocolos, equipe, ligações) e os dados de exemplo são fictícios.
 */
class DemoModeTest {
    /** Atrás do interceptor da demonstração, qualquer chamada que escapasse responderia 599 (nunca a rede). */
    private val client = OkHttpClient.Builder()
        .addInterceptor(DemoMode.interceptor)
        .addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(599).message("fora da demonstração")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
        .build()
    private val base = "${DemoMode.SERVER}/api/v1/profiles/${Ids.PROFILE}"

    @Before fun freshData() {
        DemoServer.reset()
    }

    private fun call(method: String, url: String, body: String? = null): Pair<Int, JsonElement> {
        val payload = body?.toRequestBody("application/json".toMediaType()) ?: if (method == "GET") null else "".toRequestBody(null)
        client.newCall(Request.Builder().url(url).method(method, payload).build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            return response.code to (if (text.isBlank()) JsonObject(emptyMap()) else Json.parseToJsonElement(text))
        }
    }

    private fun get(url: String) = call("GET", url).also { assertEquals("GET $url", 200, it.first) }.second
    private fun data(url: String): List<JsonObject> = get(url).jsonObject["data"]!!.jsonArray.map { it.jsonObject }
    private fun JsonElement.string(key: String) = (this as? JsonObject)?.get(key)?.let { (it as? JsonPrimitive)?.contentOrNull }

    @Test fun recognizesTheDemoServerAndTheTypedShortcut() {
        assertTrue(DemoMode.isDemo("https://demo.wabotia.localhost"))
        assertFalse(DemoMode.isDemo("https://wabotia.empresa.example"))
        assertFalse(DemoMode.isDemo(null))
        assertTrue(DemoMode.wantsDemo(" Demo "))
        assertFalse(DemoMode.wantsDemo("demo.empresa.example"))
    }

    @Test fun onlyTheDemoHostIsAnsweredInMemory() {
        assertEquals("wabotia", get("${DemoMode.SERVER}/api/health").string("service"))
        // Outros endereços seguem adiante (aqui, para o interceptor de teste): o modo demo não intercepta servidores reais.
        assertEquals(599, call("GET", "https://wabotia.empresa.example/api/health").first)
    }

    @Test fun queueClaimReplyAndTransfer() {
        assertTrue(data("$base/conversations?state=waiting").any { it.string("id") == Ids.C_QUEUE })

        val (claimStatus, claimed) = call("POST", "$base/conversations/${Ids.C_QUEUE}/actions", """{"action":"claim"}""")
        assertEquals(200, claimStatus)
        assertEquals("human", claimed.string("state"))
        assertEquals(Ids.ME, claimed.string("owner"))

        val (replyStatus, reply) = call("POST", "$base/conversations/${Ids.C_QUEUE}/actions", """{"action":"reply","text":"Olá! Já estou vendo isso."}""")
        assertEquals(200, replyStatus)
        assertTrue(reply.string("delivery_id").orEmpty().isNotEmpty())
        val messages = get("$base/conversations/${Ids.C_QUEUE}").jsonObject["messages"]!!.jsonArray
        assertEquals("Olá! Já estou vendo isso.", messages.last { it.string("direction") == "outbound" }.string("text"))

        val (transferStatus, transferred) = call("POST", "$base/conversations/${Ids.C_RICH}/actions", """{"action":"transfer","target":"${Ids.ANA}"}""")
        assertEquals(200, transferStatus)
        assertEquals(Ids.ANA, transferred.string("owner"))
    }

    @Test fun ticketsTeamAndCalls() {
        assertTrue(data("$base/tickets?active=1").any { it.string("id") == Ids.T_PROGRESS })
        val (status, _) = call("PATCH", "$base/tickets/${Ids.T_PROGRESS}", """{"text":"Andamento registrado na demonstração."}""")
        assertEquals(200, status)
        val updates = get("$base/tickets/${Ids.T_PROGRESS}").jsonObject["updates"]!!.jsonArray
        assertEquals("Andamento registrado na demonstração.", updates.last().string("text"))

        val team = data("$base/team")
        assertTrue(team.any { it.string("kind") == "user" } && team.any { it.string("kind") == "bot" })
        assertEquals(4, data("$base/calls").size)
    }

    @Test fun eventsOfANewRunAreNeverBehindACursorSavedBefore() {
        val saved = get("$base/events?after=0").jsonObject["cursor"]!!.jsonPrimitive.longOrNull!!
        DemoServer.reset()
        call("POST", "$base/conversations/${Ids.C_QUEUE}/actions", """{"action":"claim"}""")
        val fresh = data("$base/events?after=$saved")
        assertTrue(fresh.any { it.string("kind") == "conversation.updated" })
    }

    @Test fun sampleDataIsFictitious() {
        val texts = StringBuilder()
        fun collect(url: String): JsonElement = get(url).also { texts.append(it.toString()).append('\n') }
        val conversations = collect("$base/conversations?limit=200").jsonObject["data"]!!.jsonArray
        conversations.forEach { collect("$base/conversations/${it.string("id")}") }
        listOf("tickets", "team", "lines", "bots", "bot-runs", "calls", "internal-chats", "status", "presence", "menus").forEach { collect("$base/$it") }
        collect("${DemoMode.SERVER}/api/v1/profiles")
        collect("${DemoMode.SERVER}/api/v1/me")
        val all = texts.toString()

        // Pessoas e empresas reais (inclusive a Queven e os produtos dela) não aparecem nos dados de exemplo.
        for (word in listOf("Queven", "Bruno", "Fagoo", "Printher", "Vinki", "Paulista", ".com.br")) {
            assertFalse("\"$word\" nos dados de exemplo", all.contains(word, ignoreCase = true))
        }
        // Telefones: DDD 20 (inexistente no Brasil) e número começando por 9 0 (faixa sem celulares).
        val phones = Regex("""\b55\d{10,11}\b""").findAll(all).map { it.value }.toList()
        assertTrue(phones.isNotEmpty())
        phones.forEach { assertTrue("telefone $it", it.matches(Regex("""552090\d{7}"""))) }
        Regex("""\+55 (\d\d) (\d)""").findAll(all).forEach { assertEquals("+55 20 9", it.value) }
        // E-mails só no domínio reservado .example (o id de grupo do WhatsApp, `…@g.us`, não é e-mail).
        Regex("""[\w.+-]+@[\w-]+(\.[\w-]+)+""").findAll(all).filterNot { it.value.endsWith("@g.us") }
            .forEach { assertTrue("e-mail ${it.value}", it.value.endsWith(".example")) }
        assertEquals(DemoMode.USER_NAME, get("${DemoMode.SERVER}/api/v1/me").string("name"))
    }

    @Test fun groupParticipantsAndContactCardsAreFictitious() {
        val group = get("$base/conversations/${Ids.C_GROUP}").jsonObject["group"]!!.jsonObject
        val participants = Json.parseToJsonElement(group.string("participants")!!).jsonArray
        participants.forEach { assertTrue(it.string("id")!!.startsWith("552090")) }
        val contacts = get("$base/conversations/${Ids.C_RICH}").jsonObject["messages"]!!.jsonArray
            .mapNotNull { Json.parseToJsonElement(it.string("content") ?: "{}").jsonObject["contacts"] as? JsonArray }
            .flatten()
        assertTrue(contacts.isNotEmpty())
        contacts.forEach { assertTrue(it.string("phone")!!.startsWith("552090")) }
    }
}
