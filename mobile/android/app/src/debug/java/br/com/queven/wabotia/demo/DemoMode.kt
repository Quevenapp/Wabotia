package br.com.queven.wabotia.demo

import android.content.Context
import android.net.Uri
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.DebugHooks
import br.com.queven.wabotia.core.DemoDestination
import br.com.queven.wabotia.core.model.User

/**
 * Modo de demonstração (somente build de depuração).
 *
 * - Digitar `demo` como endereço do servidor entra direto em uma instalação fictícia, em memória.
 * - `adb shell am start -n br.com.queven.wabotia.debug/br.com.queven.wabotia.MainActivity --es demo <tela> [--es arg <aba>]`
 *   entra na demonstração e abre a tela pedida (ver [destination]).
 *
 * As telas e os view models rodam sem mudança: quem responde às chamadas é o [DemoInterceptor], instalado no
 * cliente HTTP por [DebugHooks]. Nada sai do aparelho e nenhuma credencial real é usada.
 */
object DemoMode {
    private const val THIRTY_DAYS_MS = 30L * 24 * 60 * 60 * 1000

    @JvmStatic
    fun install(container: AppContainer) {
        DebugHooks.interceptor = DemoInterceptor()
        DebugHooks.demoSignIn = { target -> signIn(target) }
        DebugHooks.demoDestination = { screen, arg -> destination(screen, arg) }
    }

    private fun signIn(container: AppContainer): Boolean {
        val state = DemoServer.reset()
        seedLocalCaches(container, state)
        container.onLoggedIn(
            DebugHooks.DEMO_SERVER,
            "wabu_demo",
            System.currentTimeMillis() + THIRTY_DAYS_MS,
            User(id = Ids.ME, name = "Bruno Almeida", email = "bruno@queven.demo", role = "admin", profiles = listOf(Ids.PROFILE)),
        )
        container.onProfileSelected(Ids.PROFILE)
        container.session.setEventCursor(Ids.PROFILE, 0)
        return true
    }

    /**
     * Deixa o cache local (prévias, não lidas, conversas internas vistas) sempre no mesmo ponto de partida:
     * algumas conversas começam com não lidas e a conversa interna com a Ana começa como não lida.
     */
    private fun seedLocalCaches(container: AppContainer, state: DemoState) {
        runCatching {
            val anaUpdated = state.chats[Ids.CHAT_ANA]?.long("updated") ?: state.t0
            val vendasUpdated = state.chats[Ids.CHAT_VENDAS]?.long("updated") ?: state.t0
            container.appContext.getSharedPreferences("wabotia.cache", Context.MODE_PRIVATE).edit()
                .remove("previews.${Ids.PROFILE}")
                .putString("unread.${Ids.PROFILE}", j(Ids.C_5H to 3, Ids.C_QUEUE to 1, Ids.C_QUEUE2 to 2, Ids.C_GROUP to 2).toString())
                .putString("internal_seen.${Ids.PROFILE}", j(Ids.CHAT_ANA to anaUpdated - 60_000, Ids.CHAT_VENDAS to vendasUpdated).toString())
                .apply()
            container.conversationCache.clear()
            container.internalChats.clear()
            container.profileData.clear()
        }
    }

    private fun destination(screen: String, arg: String?): DemoDestination {
        val option = arg?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        return when (screen.trim().lowercase()) {
            "conversations" -> DemoDestination(tab = "conversations", arg = option)
            "chat" -> DemoDestination(conversationId = Ids.C_RICH)
            "chat-queue" -> DemoDestination(conversationId = Ids.C_QUEUE)
            "chat-bot" -> DemoDestination(conversationId = Ids.C_BOT)
            "chat-other" -> DemoDestination(conversationId = Ids.C_ANA)
            "chat-closed" -> DemoDestination(conversationId = Ids.C_DONE)
            "chat-group" -> DemoDestination(conversationId = Ids.C_GROUP)
            "chat-expiring" -> DemoDestination(conversationId = Ids.C_40MIN)
            "chat-window-closed" -> DemoDestination(conversationId = Ids.C_WINDOW_CLOSED)
            "transfer" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "transfer", arg = option)
            "attach" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "attach")
            "actions" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "menu")
            "info" -> DemoDestination(conversationId = Ids.C_RICH, info = true)
            "tickets" -> DemoDestination(tab = "tickets", arg = option)
            "ticket" -> DemoDestination(
                ticketId = when (option) {
                    "overdue" -> Ids.T_OVERDUE
                    "soon" -> Ids.T_SOON
                    "answered", "waiting" -> Ids.T_ANSWERED
                    "third" -> Ids.T_THIRD
                    "resolved" -> Ids.T_RESOLVED
                    "closed" -> Ids.T_CLOSED
                    else -> Ids.T_PROGRESS
                },
            )
            "team" -> DemoDestination(tab = "team", arg = option)
            "calls" -> DemoDestination(tab = "calls")
            "settings" -> DemoDestination(tab = "settings")
            "presence" -> DemoDestination(tab = "conversations", sheet = "presence")
            "lines" -> DemoDestination(route = "lines")
            "menus" -> DemoDestination(route = "menus")
            "bot-lines" -> DemoDestination(route = "bot-lines")
            "bot-runs" -> DemoDestination(route = "bot-runs")
            // Prévia das telas de entrada (Servidor, Login, Perfil) sem sair da demonstração.
            "auth-server" -> DemoDestination(route = "preview/server")
            "auth-login" -> DemoDestination(route = "preview/login")
            "auth-profiles" -> DemoDestination(route = "preview/profiles")
            "ticket-new" -> DemoDestination(route = "ticket-new/${Ids.C_RICH}")
            "bot" -> DemoDestination(route = "bot/${if (option == "suporte") Ids.BOT_SUPORTE else Ids.BOT_VENDAS}")
            "internal" -> DemoDestination(route = "internal-chat/" + Uri.encode(if (option == "bot") "bot:${Ids.BOT_VENDAS}" else Ids.ANA))
            else -> DemoDestination(tab = "conversations")
        }
    }
}
