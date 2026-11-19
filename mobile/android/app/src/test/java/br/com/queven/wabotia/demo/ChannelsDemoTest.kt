package br.com.queven.wabotia.demo

import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.push.Notifications
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Fixtures sintéticas do contrato; nenhuma chamada à rede, ao provedor ou a e-mail é permitida. */
class ChannelsDemoTest {
    private val client = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor)
        .addInterceptor { error("Chamada inesperada à rede: ${it.request().url}") }.build()
    private val base = "${DemoMode.SERVER}/api/v1/profiles/${Ids.CHANNEL_PROFILE}"
    private val legacy = "${DemoMode.SERVER}/api/v1/profiles/${Ids.PROFILE}"

    @Before fun reset() { DemoServer.reset() }

    private fun call(path: String, body: JsonObject? = null, key: String? = null): Pair<Int, JsonObject> {
        val request = Request.Builder().url(path).apply {
            if (body != null) post(body.toString().toRequestBody("application/json".toMediaType()))
            if (key != null) header("Idempotency-Key", key)
        }.build()
        client.newCall(request).execute().use { response ->
            return response.code to Json.parseToJsonElement(response.body!!.string()).jsonObject
        }
    }

    private fun get(path: String): JsonObject = call(path).also { assertEquals(path, 200, it.first) }.second
    private fun rows(value: JsonObject): List<JsonObject> = value["data"]!!.jsonArray.map { it.jsonObject }
    private fun preview(id: String, destination: String = "self", key: String = "preview-$id"): JsonObject =
        call("$base/conversations/$id/email/preview",
            j("destination" to if (destination == "custom") j("kind" to "custom", "address" to "revisor@loja.example") else j("kind" to destination),
                "range" to j("kind" to "session")), key).also { assertEquals(200, it.first) }.second

    @Test fun whatsappOnlyKeepsLegacyPresentationAndAnOptionalEmailAction() {
        val status = get("$legacy/status")
        assertEquals(false, status.bool("multichannel"))
        assertEquals(listOf("whatsapp"), status["conversation_channels"]!!.jsonArray.map { it.toString().trim('"') })
        val list = rows(get("$legacy/conversations"))
        assertTrue(list.isNotEmpty())
        assertTrue(list.all { "channel" !in it && "window" !in it && "multichannel" !in it })
        val detail = get("$legacy/conversations/${Ids.C_RICH}")
        assertTrue(detail["capabilities"]!!.jsonObject.bool("reply") == true)
        assertFalse(detail["capabilities"]!!.jsonObject.containsKey("channel"))
        assertTrue(detail["email_transcript"]!!.jsonObject.bool("available") == true)
        val session = call("$legacy/conversations/${Ids.C_RICH}/email/preview",
            j("destination" to j("kind" to "self"), "range" to j("kind" to "session")), "legacy-session")
        assertEquals(409, session.first)
        assertEquals("session_unavailable", session.second["error"]!!.jsonObject.str("code"))
    }

    @Test fun channelsAreSeparateAndFilteredBeforePagination() {
        val status = get("$base/status")
        assertEquals(true, status.bool("multichannel"))
        assertEquals(3, status["connected_channels"]!!.jsonArray.size)
        assertTrue(status["future_channels"]!!.jsonArray.all { it.jsonObject.bool("enabled") == false })
        val first = get("$base/conversations?channel=instagram&limit=1")
        assertEquals(1, rows(first).size)
        val cursor = first.str("next_cursor")!!
        val second = get("$base/conversations?channel=instagram&limit=1&cursor=$cursor")
        assertEquals(1, rows(second).size)
        assertNotEquals(rows(first)[0].str("id"), rows(second)[0].str("id"))
        assertTrue((rows(first) + rows(second)).all { it.str("channel") == "instagram" })
        assertTrue(rows(get("$base/conversations?channel=tiktok")).isEmpty())
        assertEquals(422, call("$base/conversations?channel=unknown").first)
        assertEquals(404, call("$legacy/conversations/${Ids.C_INSTAGRAM}").first)
    }

    @Test fun socialWindowsOnlyPermitHumanTextAfterOneDay() {
        fun state(id: String): JsonObject = get("$base/conversations/$id")["window"]!!.jsonObject
        assertEquals("open", state(Ids.C_INSTAGRAM).str("state"))
        assertEquals("human_text_only", state(Ids.C_FACEBOOK).str("state"))
        assertEquals("closed", state(Ids.C_SOCIAL_CLOSED).str("state"))
        val human = j("action" to "reply", "text" to "Resposta escrita pela pessoa.")
        assertEquals(200, call("$base/conversations/${Ids.C_FACEBOOK}/actions", human, "human").first)
        val rejected = call("$base/conversations/${Ids.C_FACEBOOK}/actions", j("action" to "menu"), "menu")
        assertEquals(409, rejected.first)
        assertEquals("human_only", rejected.second["error"]!!.jsonObject.str("code"))
        assertEquals(409, call("$base/conversations/${Ids.C_FACEBOOK}/actions",
            j("action" to "reply", "attachments" to listOf("image"), "content" to j("type" to "image")), "media").first)
        assertEquals(409, call("$base/conversations/${Ids.C_SOCIAL_CLOSED}/actions", human, "closed").first)
    }

    @Test fun repeatedEventsAndCommandsProduceOneMessage() {
        val id = Ids.C_INSTAGRAM
        DemoServer.withChannelsState { s ->
            repeat(2) { s.addMessage(id, "customer", "Lia Exemplo", "Evento de teste", s.t0, id = "event-test") }
        }
        val body = j("action" to "reply", "text" to "Envio repetido")
        val first = call("$base/conversations/$id/actions", body, "same-send")
        val replay = call("$base/conversations/$id/actions", body, "same-send")
        assertEquals(first, replay)
        val detail = get("$base/conversations/$id")
        val messages = detail["messages"]!!.jsonArray.map { it.jsonObject }
        assertEquals(1, messages.count { it.str("id") == "event-test" })
        assertEquals(1, messages.count { it.str("id") == "event-unavailable" })
        assertEquals(1, messages.count { it.str("text") == "Envio repetido" })
        assertTrue(messages.any { it.str("text")!!.contains("Anexo indisponível") })
        assertTrue(detail["media"]!!.jsonArray.isEmpty())
        val decoded = WabotiaJson.decodeFromString<ConversationDetail>(detail.toString())
        assertEquals("instagram", decoded.conversation.channel)
    }

    @Test fun contactChannelsAndOtherDialogsStaySeparate() {
        val detail = get("$base/conversations/${Ids.C_INSTAGRAM}")
        val others = detail["other_conversations"]!!.jsonArray
        assertEquals(Ids.C_FACEBOOK, others.single().jsonObject.str("id"))
        assertTrue(detail["messages"]!!.jsonArray.all { it.jsonObject.str("conversation_id") == Ids.C_INSTAGRAM })
        val profile = get("$base/contacts/ct-social-shared/profile")
        assertEquals(2, profile["channels"]!!.jsonArray.size)
        assertFalse(profile.toString().contains("synthetic-"))
    }

    @Test fun transcriptRequiresConfirmationAndRepeatsWithoutAnotherEmailOrNote() {
        val id = Ids.C_INSTAGRAM
        val p = preview(id, "contact")
        assertEquals(true, p.bool("requiresConfirmation"))
        assertEquals(true, p.bool("requiresCustomerRequest"))
        assertEquals(2L, p.long("messageCount")) // A nota interna não entra.
        val send = j("previewToken" to p.str("previewToken"), "confirmedRecipient" to p.str("recipient"), "customerRequested" to true)
        assertEquals(422, call("$base/conversations/$id/email", j("previewToken" to p.str("previewToken")), "missing-confirmation").first)
        val first = call("$base/conversations/$id/email", send, "email-command")
        assertEquals(200, first.first)
        val replay = call("$base/conversations/$id/email", send, "email-command")
        assertEquals(first.second.str("id"), replay.second.str("id"))
        assertEquals(true, replay.second.bool("duplicate"))
        DemoServer.withChannelsState { s ->
            assertEquals(1, s.transcriptReceipts.size)
            assertEquals(1, s.messages.getValue(id).count { it.str("id") == "note-${first.second.str("id")}" })
        }
        assertEquals(409, call("$base/conversations/$id/email", j("previewToken" to "changed"), "email-command").first)
        val custom = preview(id, "custom", "custom-preview")
        assertEquals(true, custom.bool("requiresConfirmation"))
        assertEquals(false, custom.bool("requiresCustomerRequest"))
    }

    @Test fun unavailableUnauthorizedAndRevokedTranscriptRemainBlocked() {
        for (id in listOf(Ids.C_EMAIL_DISABLED, Ids.C_EMAIL_DENIED)) {
            val options = get("$base/conversations/$id")["email_transcript"]!!.jsonObject
            assertEquals(false, options.bool("available"))
            assertEquals(id == Ids.C_EMAIL_DENIED, options["destinations"]!!.jsonArray.isEmpty())
            if (id == Ids.C_EMAIL_DISABLED) assertEquals("email_not_configured", options.str("reason"))
            assertEquals(403, call("$base/conversations/$id/email/preview",
                j("destination" to j("kind" to "self"), "range" to j("kind" to "session")), "preview-$id").first)
        }
        val p = preview(Ids.C_INSTAGRAM, "contact")
        DemoServer.withChannelsState { s ->
            s.contacts["ct-social-shared"] = j("id" to "ct-social-shared", "email" to "outro@loja.example")
        }
        assertEquals(409, call("$base/conversations/${Ids.C_INSTAGRAM}/email",
            j("previewToken" to p.str("previewToken"), "confirmedRecipient" to p.str("recipient"), "customerRequested" to true), "changed-contact").first)
    }

    @Test fun pushUsesReadyTitleAndKeepsAndroidNotificationChannel() {
        val instagram = Notifications.presentation("Instagram · Lia", mapOf("channel" to "instagram", "title" to "ignorado"))
        assertEquals("Instagram · Lia", instagram.title)
        assertEquals("instagram", instagram.channel)
        assertEquals("Wabotia", Notifications.presentation("Wabotia", mapOf("channel" to "instagram")).title)
        assertEquals("Mariana", Notifications.presentation(null, mapOf("title" to "Mariana")).title)
        assertNull(Notifications.presentation(null, emptyMap()).channel)
        assertEquals("future", Notifications.presentation(null, mapOf("channel" to "future")).channel)
        assertEquals("messages", Notifications.channelFor("message"))
        assertEquals("queue", Notifications.channelFor("transfer"))
    }
}
