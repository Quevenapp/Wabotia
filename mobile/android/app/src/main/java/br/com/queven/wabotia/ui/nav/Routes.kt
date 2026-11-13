package br.com.queven.wabotia.ui.nav

import android.net.Uri
import br.com.queven.wabotia.BuildConfig

/** Rotas do NavHost. Mantenha sincronizado com AppNavHost e com os deep links wabotia://open/{type}. */
object Routes {
    const val SERVER = "server"
    const val LOGIN = "login"
    const val PROFILE_PICKER = "profile-picker"
    const val HOME = "home" // abas: conversas, protocolos, equipe, ligações (histórico), ajustes
    const val LINES = "lines"
    const val MENUS = "menus"
    const val BOT_LINES = "bot-lines"
    const val BOT_RUNS = "bot-runs"
    const val CONVERSATION = "conversation/{id}?sheet={sheet}&arg={arg}"
    const val CONVERSATION_INFO = "conversation-info/{id}"
    const val TICKET = "ticket/{id}"
    const val TICKET_NEW = "ticket-new/{conversationId}"
    const val BOT_CHAT = "bot/{botId}?conversationId={conversationId}"
    const val INTERNAL_CHAT = "internal-chat/{peerId}"

    /** [sheet] abre uma folha ao entrar (transfer, attach, menu, note, tags, window) e [arg] escolhe a aba da folha. */
    fun conversation(id: String, sheet: String? = null, arg: String? = null): String {
        val query = listOfNotNull(sheet?.let { "sheet=${Uri.encode(it)}" }, arg?.let { "arg=${Uri.encode(it)}" }).joinToString("&")
        return "conversation/$id" + if (query.isEmpty()) "" else "?$query"
    }
    fun conversationInfo(id: String) = "conversation-info/$id"
    fun ticket(id: String) = "ticket/$id"
    fun ticketNew(conversationId: String) = "ticket-new/$conversationId"
    fun botChat(botId: String, conversationId: String? = null) = "bot/$botId" + (conversationId?.let { "?conversationId=$it" } ?: "")
    /** O id de um bot na equipe é "bot:<id>": precisa ser codificado para caber no caminho. */
    fun internalChat(peerId: String) = "internal-chat/${Uri.encode(peerId)}"
}

/**
 * Destino pedido por notificação/deep link.
 *
 * Duas origens: a URI wabotia://open/{type}?profile=&conversation=&ticket= (notificações montadas pelo próprio app
 * em [br.com.queven.wabotia.core.push.Notifications.openIntent]) e os extras do Intent quando o Firebase exibe a notificação
 * por conta própria (mensagem FCM com bloco `notification` chegando com o app em segundo plano/fechado): nesse caso o toque
 * inicia a Activity LAUNCHER com os pares de `data` (type, profile_id, conversation_id, ticket_id — docs/MOBILE.md)
 * como extras e sem URI.
 *
 * No build de depuração há uma terceira origem: o extra `demo` (e `arg`), que entra na demonstração em memória e abre uma
 * tela ([demoScreen]); ver [br.com.queven.wabotia.core.DebugHooks].
 */
data class DeepLink(
    val type: String,
    val profileId: String?,
    val conversationId: String?,
    val ticketId: String?,
    val demoScreen: String? = null,
    val demoArg: String? = null,
) {
    companion object {
        const val DEMO = "demo"

        fun parse(uri: android.net.Uri?): DeepLink? {
            if (uri == null || uri.scheme != "wabotia" || uri.host != "open") return null
            return DeepLink(
                type = uri.pathSegments.firstOrNull() ?: "message",
                profileId = uri.getQueryParameter("profile"),
                conversationId = uri.getQueryParameter("conversation"),
                ticketId = uri.getQueryParameter("ticket"),
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
            )
        }

        /** Atalho de demonstração (somente depuração): `--es demo <tela> [--es arg <valor>]`. */
        fun fromDemo(intent: android.content.Intent?): DeepLink? {
            if (!BuildConfig.DEBUG || intent == null) return null
            val screen = intent.getStringExtra("demo")?.takeIf { it.isNotBlank() } ?: return null
            return DeepLink(type = DEMO, profileId = null, conversationId = null, ticketId = null, demoScreen = screen, demoArg = intent.getStringExtra("arg"))
        }

        /** URI primeiro (notificação do app), depois extras (notificação exibida pelo Firebase). */
        fun from(intent: android.content.Intent?): DeepLink? {
            if (intent == null) return null
            return fromDemo(intent) ?: parse(intent.data) ?: fromExtras(intent.extras)
        }
    }
}
