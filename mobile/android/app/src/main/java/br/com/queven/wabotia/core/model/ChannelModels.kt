@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package br.com.queven.wabotia.core.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** IDs ficam como texto: ausência é legado e um ID futuro nunca vira WhatsApp por exclusão. */
object Channels {
    val current = listOf("whatsapp", "instagram", "facebook")
    val future = listOf("tiktok", "googlebusiness", "telegram", "email")
    fun isKnown(channel: String?): Boolean = channel in current || channel in future
    fun isSocial(channel: String?): Boolean = channel == "instagram" || channel == "facebook"
    fun showBadge(channel: String?, multichannel: Boolean): Boolean = multichannel && !channel.isNullOrBlank()
    fun label(channel: String?): String = when (channel) {
        "whatsapp" -> "WhatsApp"
        "instagram" -> "Instagram"
        "facebook" -> "Facebook"
        "tiktok" -> "TikTok"
        "googlebusiness" -> "Google Business"
        "telegram" -> "Telegram"
        "email" -> "E-mail"
        else -> "Canal desconhecido"
    }
    /** Só transporte reconhecido permite inferência para uma conversa anterior ao campo channel. */
    fun resolve(channel: String?, connectionKind: String?): String? = channel ?: when (connectionKind) {
        "meta", "zernio", "qr" -> "whatsapp"
        else -> null
    }
}

fun channelReason(code: String?): String = when (code) {
    "window_closed" -> "A janela de resposta está fechada. Aguarde uma nova mensagem do contato."
    "human_only" -> "Somente texto escrito por uma pessoa pode ser enviado nesta janela."
    "cannot_initiate" -> "O contato precisa iniciar a conversa neste canal."
    "unsupported_content" -> "Este conteúdo não é aceito pelo canal."
    "inbox_required" -> "Esta ação exige uma conversa de atendimento."
    "channel_not_ready" -> "Este canal ainda não está disponível."
    "provider_unknown" -> "O resultado do envio é indeterminado. Confira antes de tentar novamente."
    else -> "O envio não está disponível nesta conversa."
}

/** Estado concedido pelo servidor. O aplicativo não concede a extensão humana por conta própria. */
@Serializable data class ChannelWindow(
    val kind: String = "customer",
    val state: String = "closed",
    val serverNow: Long = 0,
    val closesAt: Long? = null,
    val humanTextClosesAt: Long? = null,
    val remainingMessages: Int? = null,
    val canHumanText: Boolean = false,
    val canAutomation: Boolean = false,
    val reason: String? = null,
) {
    val humanTextOnly: Boolean get() = kind == "customer" && state == "human_text_only"
    val allowsHumanText: Boolean get() = state in setOf("open", "human_text_only") && canHumanText
    val allowsMedia: Boolean get() = state == "open" && canHumanText
    val hasClock: Boolean get() = kind == "customer"
    val explanation: String? get() = when {
        humanTextOnly -> channelReason("human_only")
        !allowsHumanText -> channelReason(reason ?: "window_closed")
        else -> null
    }

    fun blockReason(hasAttachments: Boolean = false, automation: Boolean = false, now: Long = serverNow): String? {
        if (kind != "none" && kind != "customer") return channelReason("channel_not_ready")
        if (!allowsHumanText) return channelReason(reason ?: "window_closed")
        if (humanTextOnly && (hasAttachments || automation)) return channelReason("human_only")
        if (automation && !canAutomation) return channelReason(reason ?: "human_only")
        if (kind == "customer") {
            val deadline = if (humanTextOnly) humanTextClosesAt else closesAt
            if (deadline == null || now >= deadline || now < 0) return channelReason("window_closed")
        }
        return null
    }

    companion object {
        fun from(value: JsonObject?): ChannelWindow? = value?.let {
            runCatching { WabotiaJson.decodeFromJsonElement(serializer(), it) }.getOrNull()
        }
    }
}

/** WhatsApp conserva a fila atual; a janela social bloqueia o envio antes de chamar a API. */
fun ConversationDetail.replyBlockReason(
    hasAttachments: Boolean = false,
    automation: Boolean = false,
    now: Long = channelWindow?.serverNow ?: 0,
): String? {
    val channel = channelId
    if (channel == null || channel == "whatsapp") return null
    if (!Channels.isSocial(channel)) return "Este canal ainda não está disponível para envio."
    val window = channelWindow ?: return "A janela deste canal não foi informada pelo servidor. Atualize a conversa."
    window.blockReason(hasAttachments = hasAttachments, automation = automation, now = now)?.let { return it }
    if (!hasAttachments && !automation && !can("text")) return "O canal não oferece envio de texto nesta conversa."
    return null
}

@Serializable data class OtherChannelConversation(
    val id: String = "",
    val channel: String? = null,
    val account_label: String = "",
    val title: String = "",
    val state: String = "",
    val updated: Long = 0,
)

@Serializable data class CustomerChannel(
    val id: String = "",
    val channel: String? = null,
    val account_label: String = "",
    val display_name: String = "",
    val username: String = "",
    val state: String = "pending",
    val connection_id: String? = null,
    val subject_masked: String? = null,
) {
    val stateLabel: String get() = when (state) {
        "ready" -> "Vinculado"
        "pending" -> "Pendente"
        "ambiguous" -> "Precisa de conferência"
        "blocked" -> "Bloqueado"
        "erased" -> "Removido"
        else -> "Situação desconhecida"
    }
}

/** Projeção de leitura da ficha. Não oferece operações de junção no aplicativo. */
@Serializable data class ContactChannelProfile(
    val profileId: String = "",
    val contactId: String = "",
    val readable: Boolean = true,
    val channels: List<CustomerChannel> = emptyList(),
    val other_conversations: List<OtherChannelConversation> = emptyList(),
)

/** A ficha pode incluir o diálogo aberto; o aviso oferece apenas os demais diálogos autorizados. */
fun ConversationDetail.otherConversationLinks(profile: ContactChannelProfile?): List<OtherChannelConversation> =
    (other_conversations + profile?.takeIf { it.readable }?.other_conversations.orEmpty())
        .filter { it.id.isNotBlank() && it.id != conversation.id }
        .distinctBy { it.id }

@Serializable data class TranscriptAvailability(val available: Boolean = false, val reason: String? = null)
@Serializable data class TranscriptLimits(
    val maxMessages: Int = 2000,
    val maxTextChars: Int = 50000,
    val maxHtmlChars: Int = 200000,
    val actorPer24Hours: Int = 10,
    val profilePer24Hours: Int = 50,
    val previewTtlMs: Long = 600000,
)
@Serializable data class TranscriptOptions(
    val available: Boolean = false,
    val reason: String? = null,
    val destinations: List<String> = emptyList(),
    val ranges: List<String> = emptyList(),
    val limits: TranscriptLimits = TranscriptLimits(),
)
@Serializable data class TranscriptDestination(
    @EncodeDefault val kind: String = "self",
    val address: String? = null,
)
@Serializable data class TranscriptRange(
    @EncodeDefault val kind: String = "session",
    val from: Long? = null,
    val to: Long? = null,
)
@Serializable data class TranscriptPreviewRequest(
    @EncodeDefault val destination: TranscriptDestination = TranscriptDestination(),
    @EncodeDefault val range: TranscriptRange = TranscriptRange(),
)
@Serializable data class TranscriptPeriod(val from: Long = 0, val to: Long = 0)
@Serializable data class TranscriptSize(val textChars: Int = 0, val htmlChars: Int = 0)
@Serializable data class TranscriptPreview(
    val recipient: String = "",
    val period: TranscriptPeriod = TranscriptPeriod(),
    val messageCount: Int = 0,
    val size: TranscriptSize = TranscriptSize(),
    val warnings: List<String> = emptyList(),
    val requiresConfirmation: Boolean = false,
    val requiresCustomerRequest: Boolean = false,
    val previewToken: String = "",
    val expiresAt: Long = 0,
) {
    fun canConfirm(confirmedRecipient: String, customerRequested: Boolean, now: Long): Boolean =
        previewToken.isNotBlank() && recipient.isNotBlank() && expiresAt > now &&
            (!(requiresConfirmation || requiresCustomerRequest) || confirmedRecipient.trim() == recipient) &&
            (!requiresCustomerRequest || customerRequested)
}
@Serializable data class TranscriptSendRequest(
    val previewToken: String,
    val confirmedRecipient: String? = null,
    val customerRequested: Boolean? = null,
)
@Serializable data class TranscriptSendResult(
    val id: String = "",
    val status: String = "unknown",
    val to_masked: String = "",
    val duplicate: Boolean = false,
) {
    val isTerminal: Boolean get() = status == "sent" || status == "failed"
}

data class TranscriptPending(val key: String, val request: TranscriptSendRequest)

/** Uma intenção mantém corpo e chave inclusive após erro de rede e fechamento da folha. */
class TranscriptAttempt {
    var pending: TranscriptPending? = null
        private set
    var result: TranscriptSendResult? = null
        private set
    var rejected: Boolean = false
        private set
    val canRetry: Boolean get() = pending != null && result == null && !rejected
    val isTerminal: Boolean get() = result?.isTerminal == true || rejected

    fun begin(request: TranscriptSendRequest, newKey: () -> String): TranscriptPending =
        pending ?: TranscriptPending(newKey(), request).also { pending = it }

    fun record(result: TranscriptSendResult) { this.result = result; rejected = false }

    /** Recusa HTTP definitiva comprovada, separada de um recibo de envio devolvido pelo servidor. */
    fun reject() { rejected = true }

    /** Resultado indeterminado ou em andamento exige conferência, nunca uma segunda intenção automática. */
    fun reset(): Boolean {
        if (pending != null && !isTerminal) return false
        pending = null
        result = null
        rejected = false
        return true
    }
}

/** O filtro integra a identidade da carga: um retorno atrasado não pertence à seleção seguinte. */
data class ConversationPageKey(
    val profileId: String,
    val state: String?,
    val query: String?,
    val channel: String?,
)
