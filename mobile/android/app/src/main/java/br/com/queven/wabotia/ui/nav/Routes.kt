package br.com.queven.wabotia.ui.nav

/** Rotas do NavHost. Mantenha sincronizado com AppNavHost e com os deep links wabotia://open/{type}. */
object Routes {
    const val SERVER = "server"
    const val LOGIN = "login"
    const val PROFILE_PICKER = "profile-picker"
    const val HOME = "home" // abas: conversas, protocolos, bots, ligações, mais
    const val CONVERSATION = "conversation/{id}"
    const val TICKET = "ticket/{id}"
    const val TICKET_NEW = "ticket-new/{conversationId}"
    const val BOT_CHAT = "bot/{botId}?conversationId={conversationId}"
    const val CALL = "call/{conversationId}?callId={callId}"

    fun conversation(id: String) = "conversation/$id"
    fun ticket(id: String) = "ticket/$id"
    fun ticketNew(conversationId: String) = "ticket-new/$conversationId"
    fun botChat(botId: String, conversationId: String? = null) = "bot/$botId" + (conversationId?.let { "?conversationId=$it" } ?: "")
    fun call(conversationId: String, callId: String? = null) = "call/$conversationId" + (callId?.let { "?callId=$it" } ?: "")
}

/**
 * Destino pedido por notificação/deep link.
 *
 * Duas origens: a URI wabotia://open/{type}?profile=&conversation=&ticket=&call= (notificações montadas pelo próprio app
 * em [br.com.queven.wabotia.core.push.Notifications.openIntent]) e os extras do Intent quando o Firebase exibe a notificação
 * por conta própria (mensagem FCM com bloco `notification` chegando com o app em segundo plano/fechado): nesse caso o toque
 * inicia a Activity LAUNCHER com os pares de `data` (type, profile_id, conversation_id, ticket_id, call_id — docs/MOBILE.md)
 * como extras e sem URI.
 */
data class DeepLink(val type: String, val profileId: String?, val conversationId: String?, val ticketId: String?, val callId: String?) {
    companion object {
        fun parse(uri: android.net.Uri?): DeepLink? {
            if (uri == null || uri.scheme != "wabotia" || uri.host != "open") return null
            return DeepLink(
                type = uri.pathSegments.firstOrNull() ?: "message",
                profileId = uri.getQueryParameter("profile"),
                conversationId = uri.getQueryParameter("conversation"),
                ticketId = uri.getQueryParameter("ticket"),
                callId = uri.getQueryParameter("call"),
            )
        }

        /** Extras do `data` do push repassados pelo Firebase ao Intent da Activity; null se não houver `type`. */
        fun fromExtras(extras: android.os.Bundle?): DeepLink? {
            if (extras == null) return null
            val type = extras.getString("type")?.takeIf { it.isNotBlank() } ?: return null
            fun field(name: String): String? = extras.getString(name)?.takeIf { it.isNotBlank() }
            return DeepLink(
                type = type,
                profileId = field("profile_id"),
                conversationId = field("conversation_id"),
                ticketId = field("ticket_id"),
                callId = field("call_id"),
            )
        }

        /** URI primeiro (notificação do app), depois extras (notificação exibida pelo Firebase). */
        fun from(intent: android.content.Intent?): DeepLink? {
            if (intent == null) return null
            return parse(intent.data) ?: fromExtras(intent.extras)
        }
    }
}
