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

    /**
     * Acesso por pessoa na demonstração (`--es demo access --es arg mesas,mesas:waiter`, só depuração): a lista que o
     * servidor fictício manda em `/capabilities`. `null` manda `["*"]` (atendente completo); `--es arg all` volta a isso.
     */
    @Volatile var access: List<String>? = null

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
            // Passada pelo Suporte pago: a faixa com vincular, confirmar e cortesia (assuma a conversa para agir).
            "suporte", "chat-suporte" -> DemoDestination(conversationId = Ids.C_SUPORTE)
            "transfer" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "transfer", arg = option)
            "attach" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "attach")
            "actions" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "menu")
            // Formulários e cobranças na conversa da Mariana: a lista, "Enviar formulário" e "Cobrar".
            "items" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "items")
            "form" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "form")
            "charge" -> DemoDestination(conversationId = Ids.C_RICH, sheet = "charge")
            "info" -> DemoDestination(conversationId = Ids.C_RICH, info = true)
            // Aba Atendimento; `tickets` abre a lista por cima dela, com o filtro de `--es arg` (active, overdue, open…).
            "service", "atendimento" -> DemoDestination(tab = "service")
            // A barra e a aba Atendimento montadas pelo acesso por pessoa (ex.: "mesas,mesas:waiter", "conversations,tickets").
            "access" -> {
                access = option?.takeUnless { it == "all" }?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
                DemoDestination(tab = "service")
            }
            "tickets" -> DemoDestination(tab = "service", route = "tickets" + (option?.let { "?filter=$it" } ?: ""))
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
            "os" -> DemoDestination(route = "os")
            "os-quote" -> DemoDestination(route = "os/order/os-5")
            "os-new" -> DemoDestination(route = "os/new")
            "reserva" -> DemoDestination(route = "reserva")
            "reserva-list" -> DemoDestination(route = "reserva?mode=list")
            "reserva-new" -> DemoDestination(route = "reserva/new")
            // A reserva aguardando o sinal (rs-2); `--es arg checkin` abre a de check-in feito (rs-1).
            "reserva-booking" -> DemoDestination(route = "reserva/booking/" + if (option == "checkin") "rs-1" else "rs-2")
            "mensalidade" -> DemoDestination(route = "mensalidade")
            "mensalidade-subscriptions" -> DemoDestination(route = "mensalidade?mode=subscriptions")
            "mensalidade-delinquents" -> DemoDestination(route = "mensalidade?mode=delinquents")
            // A parcela vencida do mês anterior (mi-5); a assinatura de quem tem dois telefones no pagador (ms-2).
            "mensalidade-installment" -> DemoDestination(route = "mensalidade/installment/mi-5")
            "mensalidade-subscription" -> DemoDestination(route = "mensalidade/subscription/ms-2")
            "pedido" -> DemoDestination(route = "pedido")
            "pedido-list" -> DemoDestination(route = "pedido?mode=list")
            "pedido-menu" -> DemoDestination(route = "pedido?mode=menu")
            // O pedido com o mesmo X-Burger em duas montagens (pd-44); `--es arg choosing` abre o que espera a forma de
            // pagamento (pd-46) e `--es arg delivery` o que está em preparo para entrega (pd-42).
            "pedido-order" -> DemoDestination(route = "pedido/order/" + when (option) { "choosing" -> "pd-46"; "delivery" -> "pd-42"; else -> "pd-44" })
            // Prévia das telas de entrada (Servidor, Login, Perfil) sem sair da demonstração.
            "auth-server" -> DemoDestination(route = "preview/server")
            "auth-start" -> DemoDestination(route = "preview/start")
            "auth-login" -> DemoDestination(route = "preview/login")
            "auth-profiles" -> DemoDestination(route = "preview/profiles")
            "ticket-new" -> DemoDestination(route = "ticket-new/${Ids.C_RICH}")
            "bot" -> DemoDestination(route = "bot/${if (option == "suporte") Ids.BOT_SUPORTE else Ids.BOT_VENDAS}")
            "internal" -> DemoDestination(route = "internal-chat/" + Uri.encode(if (option == "bot") "bot:${Ids.BOT_VENDAS}" else Ids.ANA))
            // Ações pelo bot: a conversa interna com propostas, resultado e pedidos de aprovação; e um pedido aberto pelo push.
            "bot-actions" -> DemoDestination(route = "internal-chat/" + Uri.encode("bot:${Ids.BOT_VENDAS}"))
            "approval" -> DemoDestination(route = "approval/${DemoBotActions.DESCONTO_ID}")
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
