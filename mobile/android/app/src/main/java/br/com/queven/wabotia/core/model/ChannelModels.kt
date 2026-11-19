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
    "private_reply_used" -> "A tentativa de resposta privada deste comentário já foi usada."
    "private_reply_expired" -> "O prazo para responder este comentário em privado terminou."
    "quota_exhausted" -> "O limite de envios deste canal foi atingido. Aguarde uma vaga."
    "rate_limited" -> "O canal está aguardando o intervalo permitido para o próximo envio."
    "sender_unverified" -> "Remetente não confirmado. O e-mail não permite consultar dados do cliente."
    "subject_invalid" -> "Use um assunto de até 200 caracteres, sem quebra de linha."
    "attachment_too_large" -> "Um anexo excede o tamanho permitido pelo canal."
    "provider_contract_unverified" -> "Este recurso depende de confirmação do formato usado pelo provedor."
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
        if (remainingMessages != null && remainingMessages <= 0) return channelReason("quota_exhausted")
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
    if (!Channels.isKnown(channel) || channel == "googlebusiness") return channelReason("channel_not_ready")
    if (usesChannelAction) {
        if (extension == null) return "As capacidades deste canal não foram informadas pelo servidor. Atualize a conversa."
        if (telegram?.blocked == true) return "O contato bloqueou o bot do Telegram."
        if (isComment) {
            if (automation) return channelReason("human_only")
            if (hasAttachments) return channelReason("unsupported_content")
            return if (can("text")) null else channelReason("channel_not_ready")
        }
        if (channel == "tiktok") {
            if (remainingMessages == null) return "O contador deste canal não foi informado pelo servidor. Atualize a conversa."
            if (remainingMessages == 0) return channelReason("quota_exhausted")
            val deadline = tiktok?.closesAt ?: extension?.metadata?.closesAt ?: channelWindow?.closesAt
            if (deadline == null || now >= deadline) return channelReason("window_closed")
        }
    }
    val window = channelWindow ?: return "A janela deste canal não foi informada pelo servidor. Atualize a conversa."
    window.blockReason(hasAttachments = hasAttachments, automation = automation, now = now)?.let { return it }
    if (!hasAttachments && !automation && !can("text")) return "O canal não oferece envio de texto nesta conversa."
    return null
}

/** Projeção pública limitada do servidor. Campos de fornecedor e credenciais não pertencem a estes DTOs. */
@Serializable data class ChannelExtensionView(
    val key: String = "",
    val capabilities: JsonObject? = null,
    val metadata: ChannelExtensionMetadata = ChannelExtensionMetadata(),
)
@Serializable data class ChannelExtensionMetadata(
    val subject: String? = null,
    val identityTrust: String? = null,
    val remainingMessages: Int? = null,
    val closesAt: Long? = null,
    val state: String? = null,
    val configured: Boolean? = null,
    val accountLabel: String? = null,
    val commentId: String? = null,
    val postId: String? = null,
    val permalink: String? = null,
    val version: Int? = null,
    val comment: ChannelComment? = null,
    val email: ChannelEmail? = null,
    val telegram: ChannelTelegram? = null,
    val tiktok: ChannelTikTok? = null,
)
@Serializable data class ChannelComment(
    val id: String = "",
    val postId: String = "",
    val parentId: String? = null,
    val text: String? = null,
    val postText: String? = null,
    val permalink: String? = null,
    val hidden: Boolean = false,
    val version: Int = 0,
    val privateState: String = "unknown",
    val privateExpiresAt: Long? = null,
    val privateConversationId: String? = null,
    val privateLinkPending: Boolean = false,
) {
    fun privateBlockReason(now: Long): String? = when {
        privateState != "available" -> channelReason("private_reply_used")
        privateExpiresAt == null || now <= 0 || now >= privateExpiresAt -> channelReason("private_reply_expired")
        else -> null
    }
    val privateStateLabel: String get() = when (privateState) {
        "available" -> "Tentativa privada disponível"
        "reserved" -> "Tentativa privada reservada"
        "sent" -> if (privateLinkPending) "Privado enviado; vínculo pendente" else "Resposta privada enviada"
        "failed" -> "Resposta privada falhou; tentativa consumida"
        "unknown" -> "Resultado privado indeterminado; tentativa consumida"
        else -> "Situação privada desconhecida"
    }
}
@Serializable data class ChannelEmailAuthentication(val method: String = "", val result: String = "")
@Serializable data class ChannelEmail(
    val subject: String = "",
    val sender: String = "",
    val from: String? = null,
    val replyTo: String? = null,
    val identityTrust: String = "unverified_sender",
    val authentication: List<ChannelEmailAuthentication> = emptyList(),
    val attachmentWarnings: List<String> = emptyList(),
)
@Serializable data class ChannelPhoneSuggestion(val masked: String = "", val confirmedByHuman: Boolean = false)
@Serializable data class ChannelTelegram(
    val username: String? = null,
    val botUrl: String? = null,
    val blocked: Boolean = false,
    val webhookConfigured: Boolean = false,
    val phoneSuggestion: ChannelPhoneSuggestion? = null,
)
@Serializable data class ChannelTikTok(
    val remainingMessages: Int? = null,
    val closesAt: Long? = null,
    val conservativeQuota: Boolean = true,
)

/** As capacidades achatadas da API são prioritárias; a extensão pode completar somente campos ausentes. */
internal fun ConversationDetail.extensionCan(feature: String): Boolean {
    val view = extension ?: return false
    val spec = view.capabilities
    // A ação nativa desta leva só serializa texto/anexos/assunto e comentário explícito.
    // Anunciar replyTo no transporte não torna reply_to parte de message.send.
    if (feature in setOf("reply", "edit", "reaction", "delete", "mentions", "location", "contacts", "modules")) return false
    if (spec?.bool("enabled") == false || spec?.obj("contexts")?.obj(if (isComment) "comment" else "direct")?.bool("enabled") == false) return false
    if (isComment && feature !in setOf("text", "public_reply")) return false
    val offered = capabilities?.bool(feature) ?: when (feature) {
        "text" -> spec?.obj("text")?.bool("enabled")
        "image", "video", "audio", "document", "sticker" -> spec?.obj("media")?.obj(feature)?.bool("send")
        "subject", "templates" -> spec?.bool(feature)
        "reply" -> spec?.bool("replyTo")
        "public_reply" -> spec?.obj("contexts")?.obj("comment")?.bool("publicReply")
        "menu" -> (capabilities?.obj("menu") ?: spec?.obj("menu"))?.let { menu ->
            listOf("buttons", "quickReplies", "listItems").any { (menu.long(it) ?: 0) > 0 }
        }
        else -> null
    } ?: false
    if (!offered || telegram?.blocked == true) return false
    if (feature == "subject" || feature == "public_reply" || isComment) return offered
    val window = channelWindow ?: return false
    if (channelId == "tiktok" && (remainingMessages ?: 0) <= 0) return false
    return window.blockReason(hasAttachments = feature !in setOf("text", "read"), automation = feature == "menu") == null
}

fun replyEmailSubject(subject: String): String {
    var value = subject.trim()
    while (value.startsWith("Re:", ignoreCase = true)) value = value.substring(3).trimStart()
    return if (value.isEmpty()) "" else "Re: $value"
}

@Serializable data class ChannelAttachment(
    val mediaId: String,
    val kind: String,
    val mimeType: String,
    val bytes: Long,
    val name: String? = null,
)
@Serializable data class ChannelAction(
    val type: String,
    val text: String? = null,
    val subject: String? = null,
    val commentId: String? = null,
    val hidden: Boolean? = null,
    val attachments: List<ChannelAttachment>? = null,
)
@Serializable data class ChannelActionRequest(
    @EncodeDefault val action: String = "channel",
    val channel_action: ChannelAction,
)
data class ChannelPending(val key: String, val request: ChannelActionRequest)

/** O retry recebe o pedido já preparado, inclusive assunto, alvo e modo; não relê o formulário. */
class ChannelSendAttempt {
    var pending: ChannelPending? = null
        private set
    fun begin(request: ChannelActionRequest, newKey: () -> String): ChannelPending = pending
        ?: ChannelPending(newKey(), request.copy(channel_action = request.channel_action.copy(
            attachments = request.channel_action.attachments?.map { it.copy() },
        ))).also { pending = it }
    fun clear() { pending = null }
}

/** Monta a ação antes do congelamento. Comentário jamais cai no envio genérico. */
fun ConversationDetail.prepareChannelAction(
    text: String,
    subject: String = emailReplySubject,
    commentMode: String? = null,
    commentId: String? = comment?.id,
    attachments: List<ChannelAttachment> = emptyList(),
    now: Long = channelWindow?.serverNow ?: server_now,
): ChannelActionRequest {
    require(usesChannelAction) { channelReason("channel_not_ready") }
    replyBlockReason(hasAttachments = attachments.isNotEmpty(), now = now)?.let { throw IllegalArgumentException(it) }
    require(text.isNotBlank() || attachments.isNotEmpty()) { "Escreva uma mensagem ou escolha um conteúdo." }
    require(attachments.size <= 32) { "Use até 32 anexos por mensagem." }
    require(text.length <= maxTextChars) { "O texto pode ter até $maxTextChars caracteres." }
    if (text.isNotBlank()) require(can("text")) { channelReason("unsupported_content") }
    for (attachment in attachments) {
        require(can(attachment.kind)) { channelReason("unsupported_content") }
        val rule = extension?.capabilities?.obj("media")?.obj(attachment.kind)
        val maximum = rule?.long("maxSendBytes")
        require(attachment.bytes >= 0 && (maximum == null || attachment.bytes <= maximum)) { channelReason("attachment_too_large") }
        val mimeTypes = rule?.array("mimeTypes")?.mapNotNull { it.asStringOrNull() }.orEmpty()
        require(mimeTypes.isEmpty() || attachment.mimeType in mimeTypes || mimeTypes.any { it.endsWith("/*") && attachment.mimeType.startsWith(it.dropLast(1)) }) {
            channelReason("unsupported_content")
        }
    }
    val action = when {
        isComment -> {
            require(commentMode == "public" || commentMode == "private") { "Escolha resposta pública ou privada." }
            require(!commentId.isNullOrBlank()) { "Selecione o comentário alvo." }
            require(attachments.isEmpty()) { channelReason("unsupported_content") }
            if (commentMode == "public") require(can("public_reply")) { channelReason("channel_not_ready") }
            else {
                require(comment?.id == commentId) { "Atualize o comentário alvo antes da resposta privada." }
                (comment?.privateBlockReason(now) ?: if (comment == null) channelReason("channel_not_ready") else null)
                    ?.let { throw IllegalArgumentException(it) }
            }
            ChannelAction(type = if (commentMode == "private") "comment.private" else "comment.reply", commentId = commentId, text = text)
        }
        channelId == "email" -> {
            require(can("subject")) { channelReason("channel_not_ready") }
            require(subject.length <= 200 && subject.none { it == '\r' || it == '\n' || it == '\u0000' }) { channelReason("subject_invalid") }
            ChannelAction(type = "email.send", text = text, subject = subject, attachments = attachments.takeIf { it.isNotEmpty() })
        }
        else -> {
            if (channelId == "tiktok") {
                require(attachments.size <= 1 && attachments.all { it.kind == "image" && it.mimeType in setOf("image/jpeg", "image/png") && it.bytes <= 3_000_000 }) {
                    "O TikTok aceita uma imagem JPG ou PNG de até 3.000.000 bytes por envio."
                }
                val slots = attachments.size + if (text.isNotBlank()) 1 else 0
                require(slots <= (remainingMessages ?: 0)) { "Este envio precisa de $slots vagas. Restam ${remainingMessages ?: 0} de 10 mensagens." }
            }
            ChannelAction(type = "message.send", text = text, attachments = attachments.takeIf { it.isNotEmpty() })
        }
    }
    return ChannelActionRequest(channel_action = action)
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
