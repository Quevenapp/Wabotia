package br.com.queven.wabotia.ui.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import br.com.queven.wabotia.calls.CallScreen
import br.com.queven.wabotia.calls.CallsScreen
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.ui.auth.LoginScreen
import br.com.queven.wabotia.ui.auth.ProfilePickerScreen
import br.com.queven.wabotia.ui.auth.ServerScreen
import br.com.queven.wabotia.ui.bots.BotChatScreen
import br.com.queven.wabotia.ui.conversations.ConversationScreen
import br.com.queven.wabotia.ui.home.HomeScreen
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

    // Sessão encerrada (logout/401): volta para o login limpando a pilha.
    LaunchedEffect(auth.isLoggedIn, auth.profileId) {
        val current = nav.currentDestination?.route
        if (!auth.isLoggedIn && current != Routes.SERVER && current != Routes.LOGIN) {
            nav.navigate(if (auth.serverUrl == null) Routes.SERVER else Routes.LOGIN) { popUpTo(0) { inclusive = true } }
        } else if (auth.isLoggedIn && auth.profileId == null && current != Routes.PROFILE_PICKER) {
            nav.navigate(Routes.PROFILE_PICKER) { popUpTo(0) { inclusive = true } }
        } else if (auth.isLoggedIn && auth.profileId != null && (current == Routes.LOGIN || current == Routes.PROFILE_PICKER || current == Routes.SERVER)) {
            nav.navigate(Routes.HOME) { popUpTo(0) { inclusive = true } }
        }
    }

    // Notificação tocada: abre o destino.
    LaunchedEffect(deepLink, auth.isLoggedIn, auth.profileId) {
        val link = deepLink ?: return@LaunchedEffect
        if (!auth.isLoggedIn || auth.profileId == null) return@LaunchedEffect
        if (link.profileId != null && link.profileId != auth.profileId && container.session.user?.let { it.isAdmin || link.profileId in it.profiles } == true) {
            container.onProfileSelected(link.profileId)
        }
        when (link.type) {
            "call" -> link.conversationId?.let { nav.navigate(Routes.call(it, link.callId)) }
            "ticket", "ticket_due" -> link.ticketId?.let { nav.navigate(Routes.ticket(it)) }
            else -> link.conversationId?.let { nav.navigate(Routes.conversation(it)) }
        }
        onDeepLinkConsumed()
    }

    NavHost(navController = nav, startDestination = start) {
        composable(Routes.SERVER) { ServerScreen(container) { nav.navigate(Routes.LOGIN) } }
        composable(Routes.LOGIN) {
            LoginScreen(
                container,
                onChangeServer = { container.onLoggedOut(keepServer = false); nav.navigate(Routes.SERVER) { popUpTo(0) { inclusive = true } } },
            )
        }
        composable(Routes.PROFILE_PICKER) { ProfilePickerScreen(container) }
        composable(Routes.HOME) {
            HomeScreen(
                container,
                openConversation = { nav.navigate(Routes.conversation(it)) },
                openTicket = { nav.navigate(Routes.ticket(it)) },
                openBot = { nav.navigate(Routes.botChat(it)) },
                openCall = { conversationId, callId -> nav.navigate(Routes.call(conversationId, callId)) },
            )
        }
        composable(Routes.CONVERSATION, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id") ?: return@composable
            ConversationScreen(
                container, id,
                onBack = { nav.popBackStack() },
                openTicket = { nav.navigate(Routes.ticket(it)) },
                newTicket = { nav.navigate(Routes.ticketNew(id)) },
                openBot = { botId -> nav.navigate(Routes.botChat(botId, id)) },
                openCall = { callId -> nav.navigate(Routes.call(id, callId)) },
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
        composable(
            Routes.CALL,
            arguments = listOf(navArgument("conversationId") { type = NavType.StringType }, navArgument("callId") { type = NavType.StringType; nullable = true; defaultValue = null }),
        ) { entry ->
            CallScreen(container, entry.arguments?.getString("conversationId") ?: return@composable, entry.arguments?.getString("callId"), onClose = { nav.popBackStack() })
        }
    }
}
