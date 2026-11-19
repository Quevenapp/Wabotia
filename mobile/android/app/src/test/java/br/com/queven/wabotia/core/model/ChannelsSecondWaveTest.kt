package br.com.queven.wabotia.core.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import br.com.queven.wabotia.ui.components.windowInfo
import org.junit.Assert.*
import org.junit.Test

class ChannelsSecondWaveTest {
    private val hour = 3_600_000L
    private fun direct(channel: String, metadata: ChannelExtensionMetadata = ChannelExtensionMetadata()) = ConversationDetail(
        conversation = Conversation(id = "c", channel = channel),
        window = ChannelWindow(kind = "none", state = "open", serverNow = hour, canHumanText = true, canAutomation = false),
        capabilities = """{"text":true,"subject":true,"image":true,"modules":true}""".parseJsonObject(),
        channel_extension = ChannelExtensionView(
            key = "$channel/direct",
            capabilities = """{"text":{"enabled":true,"maxChars":50000},"media":{"image":{"send":true,"maxSendBytes":3000000,"mimeTypes":["image/png","image/jpeg"]}}}""".parseJsonObject(),
            metadata = metadata,
        ),
    )
    private fun comment(privateState: String = "available", expires: Long? = 168 * hour): ConversationDetail {
        val direct = direct("instagram")
        return direct.copy(
            conversation = direct.conversation.copy(chat_type = "comment"),
            capabilities = """{"text":true,"public_reply":true,"menu":{"buttons":3},"image":true}""".parseJsonObject(),
            // Um comentário não herda o relógio de DM, mesmo se um servidor antigo o incluir.
            window = ChannelWindow(state = "closed", serverNow = hour),
            channel_extension = direct.channel_extension!!.copy(
                key = "instagram/comment",
                metadata = ChannelExtensionMetadata(comment = ChannelComment(
                    id = "local-comment", postId = "post-1", text = "Qual o preço?", privateState = privateState,
                    privateExpiresAt = expires, hidden = true,
                )),
            ),
        )
    }
    private fun tiktok(remaining: Int? = 1, closesAt: Long? = 48 * hour) = direct("tiktok",
        ChannelExtensionMetadata(tiktok = ChannelTikTok(remainingMessages = remaining, closesAt = closesAt)),
    ).copy(
        window = ChannelWindow(state = "open", serverNow = hour, closesAt = closesAt, canHumanText = true, remainingMessages = remaining),
        channel_extension = ChannelExtensionView(
            key = "tiktok/direct",
            capabilities = """{"text":{"enabled":true,"maxChars":6000},"window":{"kind":"customer","hours":48},"media":{"image":{"send":true,"maxSendBytes":3000000,"mimeTypes":["image/png","image/jpeg"]}}}""".parseJsonObject(),
            metadata = ChannelExtensionMetadata(tiktok = ChannelTikTok(remainingMessages = remaining, closesAt = closesAt)),
        ),
    )
    private fun rejected(block: () -> Unit): String {
        try { block() } catch (error: IllegalArgumentException) { return error.message.orEmpty() }
        fail("A ação deveria ter sido recusada.")
        return ""
    }

    @Test fun unusedChannelKeepsLegacyModelsAndPresentation() {
        val legacy = WabotiaJson.decodeFromString<ConversationDetail>("""{"conversation":{"id":"wa"},"capabilities":{"text":true,"image":true}}""")
        assertNull(legacy.channel_extension)
        assertNull(legacy.comment)
        assertNull(legacy.email)
        assertNull(legacy.tiktok)
        assertNull(legacy.telegram)
        assertNull(legacy.channelWindowHours)
        assertFalse(legacy.usesChannelAction)
        assertFalse(legacy.isComment)
        assertEquals("", legacy.emailReplySubject)
        assertTrue(legacy.can("text"))
        assertTrue(legacy.can("image"))
        assertTrue(legacy.can("menu"))
        assertTrue(legacy.modulesAllowed)
        assertNull(legacy.replyBlockReason())
        assertFalse(WabotiaJson.encodeToString(legacy).contains("channel_extension"))
    }

    @Test fun unknownChannelsAndMissingMismatchedProjectionsNeverGrantSend() {
        val future = direct("future-network")
        assertFalse(future.can("text"))
        assertNotNull(future.replyBlockReason())
        assertFalse(direct("googlebusiness").can("text"))
        val telegram = direct("telegram")
        assertFalse(telegram.copy(channel_extension = null).can("text"))
        assertNotNull(telegram.copy(channel_extension = null).replyBlockReason())
        assertFalse(telegram.copy(channel_extension = telegram.channel_extension!!.copy(key = "future/context")).can("text"))
        val empty = WabotiaJson.decodeFromString<ChannelExtensionView>("""{"metadata":null,"future_field":true}""")
        assertNull(empty.metadata.email)
        assertNull(empty.capabilities)
    }

    @Test fun capabilitiesAreExplicitAndNeverEnableModulesOutsideWhatsapp() {
        for (channel in listOf("telegram", "email", "tiktok")) {
            val state = if (channel == "tiktok") tiktok() else direct(channel)
            assertTrue(state.can("text"))
            assertFalse(state.modulesAllowed)
            assertFalse(state.can("edit"))
            assertFalse(state.can("location"))
            assertFalse(state.can("contacts"))
            assertFalse(state.copy(capabilities = """{"reply":true,"edit":true,"modules":true}""".parseJsonObject()).can("reply"))
            assertFalse(state.can("modules"))
            assertFalse(state.copy(capabilities = """{"text":false}""".parseJsonObject()).can("text"))
            assertFalse(state.copy(channel_extension = state.channel_extension!!.copy(capabilities = """{"enabled":false}""".parseJsonObject())).can("text"))
        }
        val projected = direct("telegram").copy(capabilities = null)
        assertTrue(projected.can("text"))
        assertTrue(projected.can("image"))
        assertFalse(projected.can("audio"))
        assertFalse(projected.copy(channel_extension = projected.channel_extension!!.copy(capabilities = null)).can("text"))
    }

    @Test fun commentsReadObjectAndStoredContextWithoutEnablingGenericSend() {
        for (payload in listOf(
            """{"id":"c","channel":"instagram","channel_context":{"context":"comment"}}""",
            """{"id":"c","channel":"facebook","channel_context":"{\"context\":\"comment\"}"}""",
            """{"id":"c","channel":"instagram","chat_type":"comment"}""",
        )) {
            val conversation = WabotiaJson.decodeFromString<Conversation>(payload)
            assertTrue(conversation.isComment)
            val detail = ConversationDetail(conversation)
            assertTrue(detail.usesChannelAction)
            assertNotNull(detail.replyBlockReason())
        }
        assertFalse(Conversation("c").isComment)
    }

    @Test fun publicAndPrivateCommentsRequireExplicitActionAndTarget() {
        val state = comment()
        assertTrue(state.can("text"))
        assertTrue(state.can("public_reply"))
        assertFalse(state.can("image"))
        assertFalse(state.can("menu"))
        assertNull(state.replyBlockReason())
        assertNotNull(state.replyBlockReason(automation = true))
        assertTrue(state.comment!!.hidden)
        assertTrue(rejected { state.prepareChannelAction("Olá") }.contains("pública ou privada"))
        assertTrue(rejected { state.prepareChannelAction("Olá", commentMode = "public", commentId = "") }.contains("alvo"))
        val public = state.prepareChannelAction("Olá", commentMode = "public").channel_action
        assertEquals("comment.reply", public.type)
        assertEquals("local-comment", public.commentId)
        val private = state.prepareChannelAction("Olá", commentMode = "private", now = hour).channel_action
        assertEquals("comment.private", private.type)
        assertTrue(rejected { state.prepareChannelAction("Olá", commentMode = "private", commentId = "another", now = hour) }.contains("alvo"))
    }

    @Test fun privateAttemptConsumedExpiredOrUnknownCannotBeRecreated() {
        for (status in listOf("reserved", "sent", "failed", "unknown", "future-status")) {
            val state = comment(privateState = status)
            assertNotNull(state.comment!!.privateBlockReason(hour))
            rejected { state.prepareChannelAction("Olá", commentMode = "private", now = hour) }
            assertEquals("comment.reply", state.prepareChannelAction("Olá", commentMode = "public", now = hour).channel_action.type)
        }
        assertNotNull(comment(expires = hour).comment!!.privateBlockReason(hour))
        assertNotNull(comment(expires = null).comment!!.privateBlockReason(hour))
        assertNotNull(comment().comment!!.privateBlockReason(0))
        assertEquals("Privado enviado; vínculo pendente", comment("sent").comment!!.copy(privateLinkPending = true).privateStateLabel)
    }

    @Test fun emailReplySubjectHasOnePrefixAndPreservesNumbersUrlsAndAccents() {
        val state = direct("email", ChannelExtensionMetadata(email = ChannelEmail(subject = "RE: Re: Pedido 42 · https://loja.test/ação")))
        assertEquals("Re: Pedido 42 · https://loja.test/ação", state.emailReplySubject)
        val request = state.prepareChannelAction("Olá, informação geral.", subject = "Pedido 42 · https://loja.test/ação")
        val encoded = WabotiaJson.encodeToString(request).parseJsonObject()
        assertEquals("channel", encoded.string("action"))
        assertEquals("email.send", encoded.obj("channel_action")?.string("type"))
        assertEquals("Pedido 42 · https://loja.test/ação", encoded.obj("channel_action")?.string("subject"))
        assertNull(encoded.obj("channel_action")?.string("recipient"))
        assertNull(encoded.obj("channel_action")?.string("from"))
        for (subject in listOf("a\rb", "a\nb", "a\u0000b", "a".repeat(201))) {
            rejected { state.prepareChannelAction("Olá", subject = subject) }
        }
        assertEquals(200, state.prepareChannelAction("Olá", subject = "a".repeat(200)).channel_action.subject!!.length)
    }

    @Test fun emailMetadataDoesNotPromoteSenderAndMessagesExposeOnlyPlainSubject() {
        val state = direct("email", ChannelExtensionMetadata(email = ChannelEmail(
            subject = "Informação", sender = "envelope@example.test", from = "diferente@example.test", replyTo = "resposta@example.test",
            authentication = listOf(ChannelEmailAuthentication("dmarc", "pass")),
            attachmentWarnings = listOf("Anexo recusado"),
        )))
        assertEquals("unverified_sender", state.email!!.identityTrust)
        assertFalse(state.modulesAllowed)
        assertNotNull(state.replyBlockReason(automation = true))
        assertEquals("pass", state.email!!.authentication.single().result)
        val message = Message("mail", content = """{"email":{"subject":"Alteração do pedido"},"html":"<script>hostil()</script>"}""")
        assertEquals("Alteração do pedido", message.emailSubject)
        assertNull(Message("wa").emailSubject)
        assertNull(Message("bad", content = "not json").emailSubject)
        assertEquals("private", Message("p", content = """{"comment":{"id":"local","visibility":"private"}}""").commentVisibility)
        assertNull(Message("p", content = """{"comment":{"visibility":"future"}}""").commentVisibility)
    }

    @Test fun telegramBlockedNoWindowAndUnknownStateAreProjectedSafely() {
        val ready = direct("telegram", ChannelExtensionMetadata(telegram = ChannelTelegram(webhookConfigured = true)))
        assertFalse(ready.channelWindow!!.hasClock)
        assertNull(ready.replyBlockReason())
        assertEquals("message.send", ready.prepareChannelAction("Olá").channel_action.type)
        val blocked = ready.copy(channel_extension = ready.channel_extension!!.copy(metadata = ChannelExtensionMetadata(telegram = ChannelTelegram(blocked = true))))
        assertFalse(blocked.can("text"))
        assertTrue(blocked.replyBlockReason()!!.contains("bloqueou"))
        assertNotNull(ready.copy(window = ready.window!!.copy(state = "future-state")).replyBlockReason())
        assertNotNull(ready.copy(window = null).replyBlockReason())
    }

    @Test fun tiktokUses48HourDeadlineAndServerCountWithoutResetOnNewInbound() {
        val state = tiktok()
        assertEquals(48, state.channelWindowHours)
        assertEquals(1, state.remainingMessages)
        assertEquals(6000, state.maxTextChars)
        assertNull(state.replyBlockReason(now = 48 * hour - 1))
        assertNotNull(state.replyBlockReason(now = 48 * hour))
        assertNotNull(tiktok(remaining = 0).replyBlockReason())
        assertNotNull(tiktok(remaining = null).replyBlockReason())
        assertNotNull(tiktok(closesAt = null).replyBlockReason())
        assertEquals(1, state.copy(conversation = state.conversation.copy(last_customer = 47 * hour)).remainingMessages)
        assertEquals("message.send", state.prepareChannelAction("Décima mensagem").channel_action.type)
        rejected { tiktok(remaining = 0).prepareChannelAction("Décima primeira") }
    }

    @Test fun tiktokTextAndImageRequireTwoSlotsAndEnforceServerMediaLimits() {
        val image = ChannelAttachment("image", "image", "image/png", 3_000_000, "ação.png")
        assertTrue(rejected { tiktok(1).prepareChannelAction("Legenda", attachments = listOf(image)) }.contains("2 vagas"))
        assertEquals(1, tiktok(2).prepareChannelAction("Legenda", attachments = listOf(image)).channel_action.attachments!!.size)
        assertEquals("", tiktok(1).prepareChannelAction("", attachments = listOf(image)).channel_action.text)
        rejected { tiktok(2).prepareChannelAction("", attachments = listOf(image.copy(bytes = 3_000_001))) }
        rejected { tiktok(2).prepareChannelAction("", attachments = listOf(image.copy(mimeType = "image/gif"))) }
        rejected { tiktok(2).prepareChannelAction("", attachments = listOf(image, image.copy(mediaId = "second"))) }
    }

    @Test fun windowPresentationUsesProjected48HoursAndNeverShowsDmClockForComment() {
        val state = tiktok().copy(conversation = Conversation("c", channel = "tiktok", last_customer = hour))
        val info = windowInfo(state, null, hour)!!
        assertEquals("Janela de 48 horas", info.title)
        assertEquals(48, info.windowHours)
        assertEquals(1, info.remainingMessages)
        assertTrue(info.social)
        assertEquals(47f / 48f, info.fraction, 0.001f)
        assertNull(windowInfo(comment(), null, hour))
    }

    @Test fun retriesKeepKeySubjectTargetModeAndIndependentAttachments() {
        val mutableAttachments = mutableListOf(ChannelAttachment("original", "image", "image/png", 100))
        val request = ChannelActionRequest(channel_action = ChannelAction("email.send", text = "Original", subject = "Assunto original", attachments = mutableAttachments))
        val attempt = ChannelSendAttempt()
        var keys = 0
        val first = attempt.begin(request) { "key-${++keys}" }
        mutableAttachments.clear()
        val changed = comment().prepareChannelAction("Outro corpo", commentMode = "public")
        val retry = attempt.begin(changed) { "key-${++keys}" }
        assertSame(first, retry)
        assertEquals(1, keys)
        assertEquals("email.send", retry.request.channel_action.type)
        assertEquals("Assunto original", retry.request.channel_action.subject)
        assertEquals("original", retry.request.channel_action.attachments!!.single().mediaId)
        attempt.clear()
        val public = attempt.begin(changed) { "key-${++keys}" }
        val private = comment().prepareChannelAction("Nova edição", commentMode = "private", now = hour)
        assertSame(public, attempt.begin(private) { "key-${++keys}" })
        assertEquals("comment.reply", attempt.pending!!.request.channel_action.type)
        assertEquals("local-comment", attempt.pending!!.request.channel_action.commentId)
        assertEquals("Outro corpo", attempt.pending!!.request.channel_action.text)
        assertEquals(2, keys)
    }
}
