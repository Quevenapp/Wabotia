package br.com.queven.wabotia.demo

import br.com.queven.wabotia.core.model.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
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

/** A rede falha fechada; o relógio dos cenários é fixo, sem espera real. */
class ChannelsSecondWaveDemoTest {
    private val now = 1_800_000_000_000L
    private lateinit var demo: ChannelsSecondWave
    private val base = "${DemoMode.SERVER}/api/v1/profiles/${ChannelsSecondWave.PROFILE}"

    @Before fun reset() { demo = ChannelsSecondWave(now); DemoServer.reset() }

    private fun detail(id: String): ConversationDetail = WabotiaJson.decodeFromString(demo.detail(id, now)!!.toString())
    private fun send(id: String, action: JsonObject, key: String): Reply = demo.handle(Request.Builder()
        .url("$base/conversations/$id/message-actions").header("Idempotency-Key", key)
        .post(j("action" to "channel", "channel_action" to action).toString().toRequestBody("application/json".toMediaType())).build(), now)!!

    @Test fun absentChannelKeepsBothExistingAreasAndRequiresExplicitOptIn() {
        val client = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor)
            .addInterceptor { error("Chamada inesperada à rede") }.build()
        fun get(path: String): Pair<Int, String> = client.newCall(Request.Builder().url("${DemoMode.SERVER}/api/v1/$path").build())
            .execute().use { it.code to it.body!!.string() }
        val before = Json.parseToJsonElement(get("profiles").second).jsonArray
        assertEquals(2, before.size)
        assertEquals(404, get("profiles/${ChannelsSecondWave.PROFILE}/conversations").first)
        val legacy = get("profiles/${Ids.PROFILE}/conversations").second
        assertFalse(legacy.contains("channel_extension"))
        assertFalse(get("profiles/${Ids.CHANNEL_PROFILE}/conversations").second.contains("channel_extension"))
        assertEquals(3, Json.parseToJsonElement(get("profiles?canais=2").second).jsonArray.size)
        assertEquals(200, get("profiles/${ChannelsSecondWave.PROFILE}/conversations").first)
        assertFalse(get("profiles/${Ids.PROFILE}/conversations").second.contains("channel_extension"))
    }

    @Test fun commentsHaveIndependentTargetsAndPrivateAttemptStates() {
        val first = detail(ChannelsSecondWave.COMMENT)
        val otherPerson = detail("c2-comment-other-person")
        val otherPost = detail("c2-comment-other-post")
        assertTrue(first.isComment)
        assertFalse(first.modulesAllowed)
        assertEquals(first.comment!!.postId, otherPerson.comment!!.postId)
        assertNotEquals(first.comment!!.id, otherPerson.comment!!.id)
        assertNotEquals(first.comment!!.postId, otherPost.comment!!.postId)
        assertTrue(detail("c2-comment-hidden").comment!!.hidden)
        assertEquals("sent", detail("c2-comment-sent").comment!!.privateState)
        assertEquals("failed", detail("c2-comment-failed").comment!!.privateState)
        assertNotNull(detail("c2-comment-expired").comment!!.privateBlockReason(now))
        val body = j("type" to "comment.private", "commentId" to first.comment!!.id, "text" to "Vamos conversar em privado.")
        assertEquals(200, send(ChannelsSecondWave.COMMENT, body, "private-once").code)
        assertEquals(200, send(ChannelsSecondWave.COMMENT, body, "private-once").code)
        assertEquals(409, send(ChannelsSecondWave.COMMENT, body, "private-twice").code)
        assertEquals(1, detail(ChannelsSecondWave.COMMENT).messages.count { !it.isIncoming })
    }

    @Test fun emailProjectsSafeTextAndFreezesEditedSubjectAndKeyOnRetry() {
        val current = detail(ChannelsSecondWave.EMAIL)
        assertEquals("unverified_sender", current.email!!.identityTrust)
        assertEquals("Re: Pedido 123 — revisão", current.emailReplySubject)
        assertEquals("Pedido 123", current.messages.first().emailSubject)
        assertEquals("Pedido 123 — revisão", current.messages.last().emailSubject)
        assertFalse(current.messages.any { it.text.contains("<script") || it.content.contains("raw_html") })
        val attempt = ChannelSendAttempt()
        val frozen = attempt.begin(current.prepareChannelAction("Resposta com atenção.", subject = "Pedido 123 https://loja.example", now = now)) { "frozen-key" }
        val repeated = attempt.begin(current.prepareChannelAction("Texto alterado", subject = "Outro assunto", now = now)) { error("Não deve gerar outra chave") }
        assertEquals(frozen, repeated)
        val body = Json.parseToJsonElement(WabotiaJson.encodeToString(frozen.request)).jsonObject
        val request = Request.Builder().url("$base/conversations/${ChannelsSecondWave.EMAIL}/message-actions")
            .header("Idempotency-Key", frozen.key).post(body.toString().toRequestBody("application/json".toMediaType())).build()
        assertEquals(200, demo.handle(request, now)!!.code)
        assertEquals(200, demo.handle(request, now)!!.code)
        val sent = detail(ChannelsSecondWave.EMAIL).messages.filter { !it.isIncoming }
        assertEquals(1, sent.size)
        assertEquals("Pedido 123 https://loja.example", sent.single().emailSubject)
    }

    @Test fun tiktokRejectsTwoSlotsWithOneLeftAndDoesNotResetOnIncoming() {
        val id = ChannelsSecondWave.TIKTOK
        assertEquals(48, detail(id).channelWindowHours)
        assertEquals(1, detail(id).remainingMessages)
        assertFalse(demo.receive(id, "tiktok-local-echo", "Eco repetido"))
        assertFalse(demo.receive(id, "tiktok-external", "Saída externa repetida"))
        assertEquals(1, detail(id).remainingMessages)
        val image = j("mediaId" to "image-fixture", "kind" to "image", "mimeType" to "image/png", "bytes" to 100)
        assertEquals(409, send(id, j("type" to "message.send", "text" to "Texto e imagem", "attachments" to listOf(image)), "two-slots").code)
        assertEquals(1, detail(id).remainingMessages)
        val tenth = j("type" to "message.send", "text" to "Décima mensagem")
        assertEquals(200, send(id, tenth, "tenth").code)
        assertEquals(200, send(id, tenth, "tenth").code)
        assertEquals(0, detail(id).remainingMessages)
        assertEquals(409, send(id, tenth, "eleventh").code)
        assertTrue(demo.receive(id, "new-incoming", "Mais uma pergunta."))
        assertFalse(demo.receive(id, "new-incoming", "Evento repetido."))
        assertEquals(0, detail(id).remainingMessages)
        assertNotNull(detail("c2-tiktok-expired").replyBlockReason(now = now))
    }

    @Test fun telegramStatesAreCapabilitiesWithoutGrantingPhoneIdentity() {
        val current = detail(ChannelsSecondWave.TELEGRAM)
        assertTrue(current.can("text"))
        assertFalse(current.modulesAllowed)
        assertNotNull(current.telegram!!.phoneSuggestion)
        assertFalse(current.telegram!!.phoneSuggestion!!.confirmedByHuman)
        assertNotNull(detail("c2-telegram-blocked").replyBlockReason(now = now))
        assertNotNull(detail("c2-telegram-limited").replyBlockReason(now = now))
        assertEquals("none", current.channelWindow!!.kind)
    }
}
