package br.com.queven.wabotia.demo

import android.content.Context
import android.net.Uri
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.User
import br.com.queven.wabotia.device.DeviceConfig
import br.com.queven.wabotia.device.DeviceRole
import br.com.queven.wabotia.queue.DeviceScopes
import okhttp3.Interceptor

/**
 * Modo de demonstração: uma instalação Wabotia fictícia, em memória, para quem ainda não tem servidor (e para a revisão
 * das lojas). Entra pelo botão "Conhecer o app (demonstração)" da tela Servidor ou digitando `demo` como servidor;
 * existe em todos os builds.
 *
 * - As telas e os view models rodam sem mudança: quem responde às chamadas é o [interceptor], instalado em todo cliente
 *   HTTP do app (OkHttp da API, do Coil e do player). Nada para `demo.wabotia.localhost` sai do aparelho.
 * - Na demonstração o aparelho nunca é registrado para push e o app não pede permissão de notificações.
 * - Os dados são fictícios e recomeçam a cada entrada e a cada abertura do app.
 * - Uma faixa fixa no topo ([br.com.queven.wabotia.ui.components.DemoBanner]) avisa que é demonstração e leva de volta
 *   à tela Servidor.
 *
 * Só no build de depuração: `adb shell am start -n br.com.queven.wabotia.debug/br.com.queven.wabotia.MainActivity
 * --es demo <tela> [--es arg <aba>]` entra na demonstração e abre a tela pedida (ver [destination]).
 */
object DemoMode {
    /** Endereço fictício do servidor de demonstração; `.localhost` nunca é um endereço da internet. */
    const val SERVER = "https://demo.wabotia.localhost"
    const val PROFILE_NAME = "Empresa Exemplo"
    const val USER_NAME = "Diego Andrade"
    /** Domínio `.example` (RFC 2606): nunca é um endereço real. */
    const val USER_EMAIL = "diego@empresa.example"

    /** Credencial fictícia do aparelho pareado na demonstração (nunca é um token real). */
    const val DEVICE_TOKEN = "wab_demo"

    /** Linha de WhatsApp fictícia do QR do cupom: DDD 20 (inexistente) e 9 0, como os telefones da demonstração. */
    const val WHATSAPP_LINE = "5520900000000"

    private const val THIRTY_DAYS_MS = 30L * 24 * 60 * 60 * 1000

    /** Responde em memória pelas chamadas a [SERVER]; as demais seguem para a rede normalmente. */
    val interceptor: Interceptor = DemoInterceptor()

    fun isDemo(serverUrl: String?): Boolean = serverUrl == SERVER

    /** O texto digitado na tela Servidor pede a demonstração? */
    fun wantsDemo(input: String): Boolean = input.trim().equals("demo", ignoreCase = true)

    internal fun user() = User(id = Ids.ME, name = USER_NAME, email = USER_EMAIL, role = "admin", profiles = listOf(Ids.PROFILE))

    /** Entra na demonstração: dados de exemplo do zero e uma sessão local, sem push. */
    fun signIn(container: AppContainer) {
        val state = DemoServer.reset()
        seedLocalCaches(container, state)
        container.onLoggedIn(SERVER, "wabu_demo", System.currentTimeMillis() + THIRTY_DAYS_MS, user())
        container.onProfileSelected(Ids.PROFILE)
        container.session.setEventCursor(Ids.PROFILE, 0)
    }

    /** Sai da demonstração e volta à tela Servidor (não há servidor a avisar nem aparelho registrado). */
    fun signOut(container: AppContainer) {
        if (isDemo(container.session.serverUrl)) container.onLoggedOut(keepServer = false)
    }

    /**
     * O aparelho já pareado da demonstração do modo aparelho (atalhos `--es demo device-totem|device-panel|
     * device-hybrid`): vive só na memória e conversa com a fila em memória.
     */
    fun deviceConfig(role: DeviceRole?): DeviceConfig = DeviceConfig(
        deviceId = "demo-device",
        baseUrl = SERVER,
        token = DEVICE_TOKEN,
        profileId = Ids.PROFILE,
        name = "Recepção (demonstração)",
        role = role,
        scopes = DeviceScopes.requested,
        demo = true,
    )

    /**
     * Atalho do modo aparelho (`device`, `device-totem`, `device-panel`, `device-hybrid`): `null` quando a tela pedida não é
     * do modo aparelho; `Result` vazio para entrar pelo pareamento.
     */
    fun deviceRoleFor(screen: String?): Result<DeviceRole?>? = when (screen?.trim()?.lowercase()) {
        "device" -> Result.success(null)
        "device-totem" -> Result.success(DeviceRole.TOTEM)
        "device-panel" -> Result.success(DeviceRole.PANEL)
        "device-hybrid" -> Result.success(DeviceRole.HYBRID)
        else -> null
    }

    /** Entrar na demonstração do modo aparelho recomeça a fila de exemplo. */
    fun startDevice() {
        DemoServer.reset()
    }

    /**
     * Abertura do app com a demonstração aberta na última vez: os dados de exemplo vivem só na memória e recomeçam,
     * então as prévias, as não lidas e o cursor de eventos guardados também voltam ao início.
     */
    fun restoreOnLaunch(container: AppContainer) {
        if (!isDemo(container.session.serverUrl)) return
        val state = DemoServer.reset()
        seedLocalCaches(container, state)
        container.session.setEventCursor(Ids.PROFILE, 0)
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

    /** Atalho `--es demo <tela>` (só no build de depuração): aba, conversa, protocolo ou rota a abrir. */
    fun destination(screen: String, arg: String?): DemoDestination? {
        if (!BuildConfig.DEBUG) return null
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
            "counter" -> DemoDestination(route = "counter")
            "agenda" -> DemoDestination(route = "agenda")
            "agenda-new" -> DemoDestination(route = "agenda/book")
            // Prévia das telas de entrada (Servidor, Login, Perfil) sem sair da demonstração.
            "auth-server" -> DemoDestination(route = "preview/server")
            "auth-start" -> DemoDestination(route = "preview/start")
            "auth-login" -> DemoDestination(route = "preview/login")
            "auth-profiles" -> DemoDestination(route = "preview/profiles")
            "ticket-new" -> DemoDestination(route = "ticket-new/${Ids.C_RICH}")
            "bot" -> DemoDestination(route = "bot/${if (option == "suporte") Ids.BOT_SUPORTE else Ids.BOT_VENDAS}")
            "internal" -> DemoDestination(route = "internal-chat/" + Uri.encode(if (option == "bot") "bot:${Ids.BOT_VENDAS}" else Ids.ANA))
            else -> DemoDestination(tab = "conversations")
        }
    }
}

/**
 * Destino de um atalho de demonstração. [tab]: conversations | tickets | team | calls | settings.
 * [sheet] abre uma folha da conversa (transfer, attach, presence…) e [arg] escolhe a aba/segmento inicial.
 */
data class DemoDestination(
    val tab: String? = null,
    val conversationId: String? = null,
    val ticketId: String? = null,
    val info: Boolean = false,
    val sheet: String? = null,
    val arg: String? = null,
    val route: String? = null,
)
