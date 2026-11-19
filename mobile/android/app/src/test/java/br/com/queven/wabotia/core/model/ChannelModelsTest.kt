package br.com.queven.wabotia.core.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import br.com.queven.wabotia.ui.components.windowInfo

class ChannelModelsTest {
    @Test fun legacyAndUnknownChannelsNeverBecomeWhatsAppByExclusion() {
        val legacy = WabotiaJson.decodeFromString<Conversation>("""{"id":"legacy"}""")
        assertNull(legacy.channel)
        assertFalse(legacy.multichannel)
        assertNull(legacy.window)
        assertFalse(Channels.showBadge(legacy.channel, legacy.multichannel))
        assertNull(Channels.resolve(null, "ai"))
        assertNull(Channels.resolve(null, "internal"))
        assertEquals("whatsapp", Channels.resolve(null, "qr"))
        val future = WabotiaJson.decodeFromString<Conversation>("""{"id":"future","channel":"new-network","multichannel":true}""")
        assertEquals("new-network", future.channel)
        assertEquals("new-network", Channels.resolve(future.channel, "zernio"))
        assertEquals("Canal desconhecido", Channels.label(future.channel))
        assertTrue(Channels.showBadge(future.channel, future.multichannel))
        assertFalse(Channels.isSocial(future.channel))
        assertEquals("Contato", future.copy(external_id = "opaque-subject", phone = "5511999990000").displayName)
        assertEquals("5511999990000", legacy.copy(phone = "5511999990000").displayName)
    }

    @Test fun whatsappOnlyKeepsLegacyPresentation() {
        val status = WabotiaJson.decodeFromString<ProfileStatus>("""{"conversation_channels":["whatsapp"],"multichannel":false}""")
        val c = Conversation(id = "wa", channel = "whatsapp")
        assertFalse(Channels.showBadge(c.channel, status.multichannel))
        assertEquals(1, status.conversation_channels.size)
        val detail = ConversationDetail(conversation = c)
        assertNull(detail.email_transcript)
        assertTrue(detail.other_conversations.isEmpty())
        assertNull(detail.channelWindow)
    }

    @Test fun absentNullAndUnknownAdditionalFieldsAreTolerated() {
        val detail = WabotiaJson.decodeFromString<ConversationDetail>("""{
            "conversation":{"id":"c","channel":null,"account_label":null},
            "capabilities":{"channel":"instagram","account_label":"@loja","multichannel":true,
                "window":{"kind":"customer","state":"future-state","canHumanText":true,"new_field":1}},
            "new_field":{"anything":true}
        }""")
        assertEquals("instagram", detail.channelId)
        assertEquals("@loja", detail.accountLabel)
        assertTrue(detail.isMultichannel)
        assertNotNull(detail.channelWindow?.blockReason())
        val profile = WabotiaJson.decodeFromString<ContactChannelProfile>("""{"contributions":[],"channels":[{"channel":"future-network","state":"future-state"}]}""")
        assertEquals("Situação desconhecida", profile.channels.single().stateLabel)
        assertTrue(profile.other_conversations.isEmpty())
    }

    @Test fun detailFieldsPrecedeCapabilitiesAndConversation() {
        val detail = WabotiaJson.decodeFromString<ConversationDetail>("""{
            "conversation":{"id":"c","channel":"whatsapp","account_label":"antigo","multichannel":true},
            "channel":"facebook","account_label":"Loja","multichannel":false,
            "capabilities":{"channel":"instagram","account_label":"@loja","multichannel":true}
        }""")
        assertEquals("facebook", detail.channelId)
        assertEquals("Loja", detail.accountLabel)
        assertFalse(detail.isMultichannel)
    }

    @Test fun serverWindowHasTwoStagesAndNeverGrantsAutomationInExtension() {
        val hour = 3_600_000L
        val open = ChannelWindow(state = "open", serverNow = hour, closesAt = 24 * hour,
            humanTextClosesAt = 168 * hour, canHumanText = true, canAutomation = true)
        assertNull(open.blockReason(hasAttachments = true, automation = true))
        assertNotNull(open.blockReason(now = 24 * hour))
        val extended = open.copy(state = "human_text_only", serverNow = 25 * hour, canAutomation = false)
        assertNull(extended.blockReason())
        assertNotNull(extended.blockReason(hasAttachments = true))
        assertNotNull(extended.blockReason(automation = true))
        assertNotNull(extended.blockReason(now = 168 * hour))
        assertNotNull(extended.copy(state = "closed", serverNow = 168 * hour).blockReason())
        assertNotNull(ChannelWindow().blockReason())
        val noWindow = ChannelWindow(kind = "none", state = "open", canHumanText = true, canAutomation = true)
        assertFalse(noWindow.hasClock)
        assertNull(noWindow.blockReason(hasAttachments = true))
    }

    @Test fun channelFilterParticipatesInPaginationIdentity() {
        val whatsapp = ConversationPageKey("area", "human", "Ana", "whatsapp")
        val instagram = whatsapp.copy(channel = "instagram")
        assertNotEquals(whatsapp, instagram)
        assertNotEquals(whatsapp, whatsapp.copy(profileId = "outra-area"))
        assertNotEquals(whatsapp, whatsapp.copy(query = "Bia"))
        assertEquals(whatsapp, whatsapp.copy())
    }

    @Test fun replyWindowKeepsWhatsappQueueAndGuardsSocialSending() {
        val closed = ChannelWindow(state = "closed", serverNow = 168, closesAt = 24, humanTextClosesAt = 168)
        val whatsapp = ConversationDetail(Conversation("wa", channel = "whatsapp"), window = closed)
        assertNull(whatsapp.replyBlockReason())
        assertNull(whatsapp.replyBlockReason(hasAttachments = true, automation = true))
        assertNull(whatsapp.copy(conversation = Conversation("legacy")).replyBlockReason())
        val social = whatsapp.copy(channel = "instagram", capabilities = """{"text":true}""".parseJsonObject())
        assertNotNull(social.replyBlockReason())
        val extension = social.copy(window = closed.copy(state = "human_text_only", serverNow = 25, canHumanText = true))
        assertNull(extension.replyBlockReason())
        assertNotNull(extension.replyBlockReason(hasAttachments = true))
        assertNotNull(extension.replyBlockReason(automation = true))
        assertNotNull(extension.replyBlockReason(now = 168))
        assertNotNull(extension.copy(window = null).replyBlockReason())
        assertNotNull(extension.copy(channel = "future-network").replyBlockReason())
    }

    @Test fun otherConversationLinksExcludeCurrentDuplicatesAndUnreadableProfile() {
        val current = OtherChannelConversation(id = "current", channel = "instagram")
        val facebook = OtherChannelConversation(id = "facebook", channel = "facebook")
        val whatsapp = OtherChannelConversation(id = "whatsapp", channel = "whatsapp")
        val detail = ConversationDetail(Conversation("current"), other_conversations = listOf(current, facebook))
        val profile = ContactChannelProfile(other_conversations = listOf(current, facebook, whatsapp, OtherChannelConversation()))
        assertEquals(listOf(facebook, whatsapp), detail.otherConversationLinks(profile))
        assertEquals(listOf(facebook), detail.otherConversationLinks(profile.copy(readable = false)))
        assertEquals(listOf(facebook), detail.otherConversationLinks(null))
        assertTrue(ConversationDetail(Conversation("wa")).otherConversationLinks(null).isEmpty())
    }

    @Test fun windowPresentationKeepsWhatsappAndUsesServerSocialStages() {
        val hour = 3_600_000L
        val legacy = Conversation("legacy", last_customer = hour)
        val previous = windowInfo(legacy, null, 2 * hour)!!
        assertEquals(23 * hour, previous.remainingMs)
        assertFalse(previous.social)
        assertNull(windowInfo(legacy.copy(channel = "future-network"), null, 2 * hour))
        val social = legacy.copy(channel = "instagram", window = ChannelWindow(state = "human_text_only",
            serverNow = 25 * hour, closesAt = 24 * hour, humanTextClosesAt = 168 * hour, canHumanText = true))
        val extension = windowInfo(social, null, 25 * hour)!!
        assertTrue(extension.social)
        assertTrue(extension.humanTextOnly)
        assertFalse(extension.closed)
        assertTrue(windowInfo(social, null, 168 * hour)!!.closed)
        assertNull(windowInfo(social.copy(window = ChannelWindow(kind = "none", state = "open", canHumanText = true)), null, 25 * hour))
        val detail = ConversationDetail(legacy, channel = "facebook", window = social.window)
        assertTrue(windowInfo(detail, null, 25 * hour)!!.social)
    }

    @Test fun capabilitiesRespectSocialWindowAndKeepWhatsappLegacyBehavior() {
        val capabilities = """{"text":true,"image":true,"reaction":true,"edit":true,"read":true,"reply":true}""".parseJsonObject()
        val legacy = ConversationDetail(Conversation("legacy"), capabilities = capabilities)
        assertTrue(legacy.can("image"))
        assertTrue(legacy.can("menu"))
        assertTrue(legacy.modulesAllowed)
        val social = legacy.copy(channel = "instagram", window = ChannelWindow(state = "human_text_only",
            serverNow = 25, closesAt = 24, humanTextClosesAt = 168, canHumanText = true))
        assertTrue(social.can("text"))
        assertTrue(social.can("read"))
        assertFalse(social.can("image"))
        assertFalse(social.can("reaction"))
        assertFalse(social.can("edit"))
        assertFalse(social.can("reply"))
        assertFalse(social.can("menu"))
        assertFalse(social.modulesAllowed)
        assertFalse(social.copy(channel = "future-network").can("text"))
        assertFalse(social.copy(window = null).can("text"))
    }

    @Test fun previewAndSendEncodeRequiredDiscriminants() {
        val body = WabotiaJson.encodeToString(TranscriptPreviewRequest()).parseJsonObject()
        assertEquals("self", body.obj("destination")?.string("kind"))
        assertEquals("session", body.obj("range")?.string("kind"))
        val dates = WabotiaJson.encodeToString(TranscriptPreviewRequest(
            destination = TranscriptDestination(kind = "custom", address = "pessoa@example.test"),
            range = TranscriptRange(kind = "dates", from = 1000, to = 2000),
        )).parseJsonObject()
        assertEquals(1000L, dates.obj("range")?.long("from"))
        assertEquals(2000L, dates.obj("range")?.long("to"))
        assertFalse(WabotiaJson.encodeToString(TranscriptSendRequest("token")).contains("customerRequested"))
    }

    @Test fun contactAndCustomRequireVisibleAddressConfirmationAndCustomerRequest() {
        val preview = TranscriptPreview(recipient = "pessoa@example.test", previewToken = "token", expiresAt = 5000,
            requiresConfirmation = true, requiresCustomerRequest = true)
        assertFalse(preview.canConfirm("", false, 1000))
        assertFalse(preview.canConfirm(preview.recipient, false, 1000))
        assertFalse(preview.canConfirm("outra@example.test", true, 1000))
        assertTrue(preview.canConfirm(preview.recipient, true, 1000))
        assertFalse(preview.canConfirm(preview.recipient, true, 5000))
        assertTrue(preview.copy(requiresCustomerRequest = false).canConfirm(preview.recipient, false, 1000))
        assertFalse(preview.copy(requiresConfirmation = false).canConfirm("", true, 1000))
        assertFalse(TranscriptPreview().canConfirm("", false, 0))
    }

    @Test fun retryKeepsSameKeyAndFrozenBodyUntilTerminalResult() {
        val attempt = TranscriptAttempt()
        var keys = 0
        val first = attempt.begin(TranscriptSendRequest("token-1")) { "key-${++keys}" }
        assertTrue(attempt.canRetry)
        assertFalse(attempt.reset())
        val retry = attempt.begin(TranscriptSendRequest("token-2")) { "key-${++keys}" }
        assertSame(first, retry)
        assertEquals("token-1", retry.request.previewToken)
        assertEquals(1, keys)
        for (status in listOf("reserved", "sending", "queued", "unknown", "future-status")) {
            attempt.record(TranscriptSendResult(status = status))
            assertFalse(attempt.canRetry)
            assertFalse(attempt.reset())
            assertEquals(first, attempt.begin(TranscriptSendRequest("token-3")) { "key-${++keys}" })
        }
        attempt.record(TranscriptSendResult(status = "sent", duplicate = true))
        assertTrue(attempt.isTerminal)
        assertTrue(attempt.reset())
        assertNull(attempt.pending)
        val next = attempt.begin(TranscriptSendRequest("token-4")) { "key-${++keys}" }
        assertNotEquals(first.key, next.key)
        attempt.record(TranscriptSendResult(status = "failed"))
        assertTrue(attempt.reset())
    }

    @Test fun definitiveRejectionRequiresExplicitNewIntentAndDoesNotInventReceipt() {
        val attempt = TranscriptAttempt()
        val pending = attempt.begin(TranscriptSendRequest("token")) { "same-key" }
        attempt.reject()
        assertTrue(attempt.rejected)
        assertTrue(attempt.isTerminal)
        assertFalse(attempt.canRetry)
        assertNull(attempt.result)
        assertSame(pending, attempt.begin(TranscriptSendRequest("other-token")) { "unexpected-key" })
        assertTrue(attempt.reset())
        assertFalse(attempt.rejected)
    }
}
