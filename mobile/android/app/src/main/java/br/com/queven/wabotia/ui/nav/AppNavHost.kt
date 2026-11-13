package br.com.queven.wabotia.ui.nav

import android.net.Uri
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.DebugHooks
import br.com.queven.wabotia.ui.auth.LoginScreen
import br.com.queven.wabotia.ui.auth.ProfilePickerScreen
import br.com.queven.wabotia.ui.auth.ServerScreen
import br.com.queven.wabotia.ui.bots.BotChatScreen
import br.com.queven.wabotia.ui.bots.BotRunsScreen
import br.com.queven.wabotia.ui.conversations.ConversationInfoScreen
import br.com.queven.wabotia.ui.conversations.ConversationScreen
import br.com.queven.wabotia.ui.home.HomeScreen
import br.com.queven.wabotia.ui.home.HomeTab
import br.com.queven.wabotia.ui.service.BotLinesScreen
import br.com.queven.wabotia.ui.service.LinesScreen
import br.com.queven.wabotia.ui.service.MenusScreen
import br.com.queven.wabotia.ui.team.InternalChatScreen
import br.com.queven.wabotia.ui.tickets.NewTicketScreen
import br.com.queven.wabotia.ui.tickets.TicketScreen

@Composable
fun AppNavHost(container: AppContainer, nav: NavHostController, deepLink: DeepLink?, onDeepLinkConsumed: () -> Unit) {
    val auth by container.auth.collectAsState()
    val start = when {
        !auth.isLoggedIn && auth.serverUrl == null -> Routes.SERVER
        !auth.isLoggedIn -> Routes.LOGIN
        auth.profileId == null -> Routes.PROFILE_PICKER
        else -> Routes.HOME
    }
    var homeTab by rememberSaveable { mutableStateOf(HomeTab.Conversations) }
    /** Pedido único para a aba aberta (folha de presença, segmento da Equipe); usado pelos atalhos de demonstração. */
    var homeArg by rememberSaveable { mutableStateOf<String?>(null) }

    // Sessão encerrada (logout/401): volta para o login limpando a pilha.
    LaunchedEffect(auth.isLoggedIn, auth.profileId) {
        val current = nav.currentDestination?.route
        if (!auth.isLoggedIn && current != Routes.SERVER && current != Routes.LOGIN) {
            homeTab = HomeTab.Conversations
            nav.navigate(if (auth.serverUrl == null) Routes.SERVER else Routes.LOGIN) { popUpTo(0) { inclusive = true } }
        } else if (auth.isLoggedIn && auth.profileId == null && current != Routes.PROFILE_PICKER) {
            nav.navigate(Routes.PROFILE_PICKER) { popUpTo(0) { inclusive = true } }
        } else if (auth.isLoggedIn && auth.profileId != null && (current == Routes.LOGIN || current == Routes.PROFILE_PICKER || current == Routes.SERVER)) {
            nav.navigate(Routes.HOME) { popUpTo(0) { inclusive = true } }
        }
    }

    // Notificação tocada (ou atalho de demonstração): abre o destino.
    LaunchedEffect(deepLink, auth.isLoggedIn, auth.profileId) {
        val link = deepLink ?: return@LaunchedEffect
        if (link.type == DeepLink.DEMO) {
            if (!auth.isLoggedIn || auth.serverUrl != DebugHooks.DEMO_SERVER) {
                // Entra na demonstração; este efeito roda de novo quando a sessão mudar.
                if (!DebugHooks.signInDemo(container)) onDeepLinkConsumed()
                return@LaunchedEffect
            }
            if (auth.profileId == null) return@LaunchedEffect
            val destination = DebugHooks.destination(link.demoScreen ?: "conversations", link.demoArg)
            if (nav.currentDestination?.route != Routes.HOME) nav.navigate(Routes.HOME) { popUpTo(0) { inclusive = true } }
            homeTab = HomeTab.entries.firstOrNull { it.key == destination?.tab } ?: HomeTab.Conversations
            homeArg = destination?.sheet ?: destination?.arg?.takeIf { destination.conversationId == null && destination.ticketId == null }
            when {
                destination == null -> {}
                destination.route != null -> nav.navigate(destination.route)
                destination.conversationId != null && destination.info -> nav.navigate(Routes.conversationInfo(destination.conversationId))
                destination.conversationId != null -> nav.navigate(Routes.conversation(destination.conversationId, destination.sheet, destination.arg))
                destination.ticketId != null -> nav.navigate(Routes.ticket(destination.ticketId))
            }
            onDeepLinkConsumed()
            return@LaunchedEffect
        }
        if (!auth.isLoggedIn || auth.profileId == null) return@LaunchedEffect
        if (link.profileId != null && link.profileId != auth.profileId && container.session.user?.let { it.isAdmin || link.profileId in it.profiles } == true) {
            container.onProfileSelected(link.profileId)
        }
        when (link.type) {
            "ticket", "ticket_due" -> link.ticketId?.let { nav.navigate(Routes.ticket(it)) }
            // Demais tipos (inclusive "call": o app só mostra o histórico de ligações) abrem a conversa.
            else -> link.conversationId?.let { nav.navigate(Routes.conversation(it)) }
        }
        onDeepLinkConsumed()
    }

    NavHost(
        navController = nav,
        startDestination = start,
        enterTransition = { slideInHorizontally(tween(220)) { it / 5 } + fadeIn(tween(200)) },
        exitTransition = { fadeOut(tween(160)) },
        popEnterTransition = { fadeIn(tween(180)) },
        popExitTransition = { slideOutHorizontally(tween(200)) { it / 5 } + fadeOut(tween(160)) },
    ) {
        composable(Routes.SERVER) { ServerScreen(container) { nav.navigate(Routes.LOGIN) } }
        composable(Routes.LOGIN) {
            LoginScreen(
                container,
                onChangeServer = { container.onLoggedOut(keepServer = false); nav.navigate(Routes.SERVER) { popUpTo(0) { inclusive = true } } },
            )
        }
        composable(Routes.PROFILE_PICKER) { ProfilePickerScreen(container) }
        if (BuildConfig.DEBUG) {
            // Prévia das telas de entrada dentro da demonstração (atalhos `--es demo auth-server|auth-login|auth-profiles`).
            composable("preview/server") { ServerScreen(container) { nav.popBackStack() } }
            composable("preview/login") { LoginScreen(container, onChangeServer = { nav.popBackStack() }) }
            composable("preview/profiles") { ProfilePickerScreen(container) }
        }
        composable(Routes.HOME) {
            HomeScreen(
                container = container,
                tab = homeTab,
                onTab = { homeTab = it },
                tabArg = homeArg,
                onTabArgConsumed = { homeArg = null },
                openConversation = { id, sheet -> nav.navigate(Routes.conversation(id, sheet)) },
                openTicket = { nav.navigate(Routes.ticket(it)) },
                newTicket = { nav.navigate(Routes.ticketNew(it)) },
                openBot = { nav.navigate(Routes.botChat(it)) },
                openBotRuns = { nav.navigate(Routes.BOT_RUNS) },
                openInternalChat = { nav.navigate(Routes.internalChat(it)) },
                openLines = { nav.navigate(Routes.LINES) },
                openMenus = { nav.navigate(Routes.MENUS) },
                openBotLines = { nav.navigate(Routes.BOT_LINES) },
            )
        }
        composable(Routes.LINES) { LinesScreen(container) { nav.popBackStack() } }
        composable(Routes.MENUS) { MenusScreen(container) { nav.popBackStack() } }
        composable(Routes.BOT_LINES) { BotLinesScreen(container) { nav.popBackStack() } }
        composable(Routes.BOT_RUNS) { BotRunsScreen(container, onBack = { nav.popBackStack() }, openBot = { nav.navigate(Routes.botChat(it)) }) }
        composable(
            Routes.INTERNAL_CHAT,
            arguments = listOf(navArgument("peerId") { type = NavType.StringType }),
        ) { entry ->
            val peerId = entry.arguments?.getString("peerId")?.let(Uri::decode) ?: return@composable
            InternalChatScreen(container, peerId, onBack = { nav.popBackStack() })
        }
        composable(
            Routes.CONVERSATION,
            arguments = listOf(
                navArgument("id") { type = NavType.StringType },
                navArgument("sheet") { type = NavType.StringType; nullable = true; defaultValue = null },
                navArgument("arg") { type = NavType.StringType; nullable = true; defaultValue = null },
            ),
        ) { entry ->
            val id = entry.arguments?.getString("id") ?: return@composable
            ConversationScreen(
                container = container,
                conversationId = id,
                initialSheet = entry.arguments?.getString("sheet"),
                initialArg = entry.arguments?.getString("arg"),
                onBack = { nav.popBackStack() },
                openInfo = { nav.navigate(Routes.conversationInfo(id)) },
                openTicket = { nav.navigate(Routes.ticket(it)) },
                openBot = { botId -> nav.navigate(Routes.botChat(botId, id)) },
            )
        }
        composable(Routes.CONVERSATION_INFO, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id") ?: return@composable
            ConversationInfoScreen(
                container = container,
                conversationId = id,
                onBack = { nav.popBackStack() },
                openTicket = { nav.navigate(Routes.ticket(it)) },
                newTicket = { nav.navigate(Routes.ticketNew(id)) },
                openBot = { botId -> nav.navigate(Routes.botChat(botId, id)) },
                openTransfer = {
                    // Volta para a conversa (ou abre uma) com a folha "Encaminhar atendimento".
                    nav.navigate(Routes.conversation(id, "transfer")) { popUpTo(Routes.HOME) }
                },
            )
        }
        composable(Routes.TICKET, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            TicketScreen(container, entry.arguments?.getString("id") ?: return@composable, onBack = { nav.popBackStack() }, openConversation = { nav.navigate(Routes.conversation(it)) })
        }
        composable(Routes.TICKET_NEW, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            NewTicketScreen(container, entry.arguments?.getString("conversationId") ?: return@composable, onBack = { nav.popBackStack() }, onCreated = { nav.popBackStack(); nav.navigate(Routes.ticket(it)) })
        }
        composable(
            Routes.BOT_CHAT,
            arguments = listOf(navArgument("botId") { type = NavType.StringType }, navArgument("conversationId") { type = NavType.StringType; nullable = true; defaultValue = null }),
        ) { entry ->
            BotChatScreen(container, entry.arguments?.getString("botId") ?: return@composable, entry.arguments?.getString("conversationId"), onBack = { nav.popBackStack() })
        }
    }
}
