package br.com.queven.wabotia.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.calls.CallText
import br.com.queven.wabotia.calls.CallsScreen
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Event
import br.com.queven.wabotia.core.model.TicketStatus
import br.com.queven.wabotia.core.push.IncomingCallBus
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.conversations.ConversationsScreen
import br.com.queven.wabotia.ui.settings.SettingsScreen
import br.com.queven.wabotia.ui.team.TeamScreen
import br.com.queven.wabotia.ui.theme.Wb
import br.com.queven.wabotia.ui.tickets.TicketsScreen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** As cinco abas da barra inferior (DESIGN.md §3). [key] é o nome usado nos atalhos de demonstração. */
enum class HomeTab(val key: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector) {
    Conversations("conversations", "Conversas", Icons.AutoMirrored.Outlined.Chat, Icons.AutoMirrored.Filled.Chat),
    Tickets("tickets", "Protocolos", Icons.Outlined.ConfirmationNumber, Icons.Filled.ConfirmationNumber),
    Team("team", "Equipe", Icons.Outlined.Groups, Icons.Filled.Groups),
    Calls("calls", "Ligações", Icons.Outlined.Call, Icons.Filled.Call),
    Settings("settings", "Ajustes", Icons.Outlined.Settings, Icons.Filled.Settings),
}

/** Contadores das abas: protocolos atrasados/recebidos (só ativos), conversas internas não lidas e ligações tocando. */
class HomeBadgesViewModel(private val container: AppContainer) : ViewModel() {
    var overdueTickets by mutableStateOf(0)
        private set
    var openTickets by mutableStateOf(0)
        private set
    var internalUnread by mutableStateOf(0)
        private set
    var ringingCalls by mutableStateOf(0)
        private set

    fun refreshTickets() {
        val profile = container.session.profileId ?: return
        viewModelScope.launch {
            try {
                // Uma consulta dos protocolos ativos (`active=1`; servidores 0.13 ignoram o filtro e o app filtra aqui):
                // atrasados = ativos sem primeira resposta e com prazo vencido; senão, os recebidos ainda sem análise.
                val now = System.currentTimeMillis()
                val active = container.api.tickets(profile, active = "1").data.filter { it.isActive }
                overdueTickets = active.count { it.isOverdueAt(now) }
                openTickets = active.count { it.status == TicketStatus.OPEN }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // contadores são complementares: mantêm o último valor conhecido
            }
        }
    }

    fun refreshTeam() {
        val profile = container.session.profileId ?: return
        viewModelScope.launch {
            try {
                val chats = container.api.internalChats(profile).data
                container.internalChats.use(profile)
                container.internalChats.baseline(chats)
                internalUnread = container.internalChats.unreadCount(chats)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    fun refreshCalls() {
        val profile = container.session.profileId ?: return
        val me = container.session.user?.id
        viewModelScope.launch {
            try {
                ringingCalls = container.api.calls(profile, limit = 30).data.count { CallText.isRingingFor(it, me) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    fun onEvents(events: List<Event>) {
        if (events.any { it.kind.startsWith("ticket.") }) refreshTickets()
        if (events.any { it.kind.startsWith("call.") }) refreshCalls()
    }
}

@Composable
fun HomeScreen(
    container: AppContainer,
    tab: HomeTab,
    onTab: (HomeTab) -> Unit,
    tabArg: String?,
    onTabArgConsumed: () -> Unit,
    openConversation: (id: String, sheet: String?) -> Unit,
    openTicket: (String) -> Unit,
    newTicket: (conversationId: String) -> Unit,
    openBot: (String) -> Unit,
    openBotRuns: () -> Unit,
    openInternalChat: (peerId: String) -> Unit,
    openCall: (conversationId: String, callId: String?) -> Unit,
    openLines: () -> Unit,
    openMenus: () -> Unit,
    openBotLines: () -> Unit,
) {
    val c = Wb.colors
    val profileId = container.session.profileId ?: ""
    val badges: HomeBadgesViewModel = viewModel(key = "home-badges:$profileId") { HomeBadgesViewModel(container) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val unread = container.conversationCache.totalUnread
    // Lê o mapa de vistos para recompor o contador quando uma conversa interna é aberta.
    val seenVersion = container.internalChats.seen.values.sum()

    EventPolling(container, profileId, onStart = { badges.refreshTickets(); badges.refreshCalls(); badges.refreshTeam() }, onEvents = { badges.onEvents(it) })
    LaunchedEffect(Unit) { IncomingCallBus.calls.collect { badges.refreshCalls() } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, profileId, seenVersion) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                badges.refreshTeam()
                badges.refreshCalls()
                delay(20_000)
            }
        }
    }
    // O pedido da aba (atalho de demonstração) recria o conteúdo da aba uma vez com o valor inicial e some em seguida.
    var initialArg by remember { mutableStateOf<String?>(null) }
    var argToken by remember { mutableStateOf(0) }
    LaunchedEffect(tabArg) {
        if (tabArg != null) {
            initialArg = tabArg
            argToken++
            onTabArgConsumed()
        }
    }

    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Column {
                HorizontalDivider(color = c.hairline)
                NavigationBar(containerColor = c.background, tonalElevation = 0.dp) {
                    HomeTab.entries.forEach { t ->
                        val selected = tab == t
                        val (count, badgeColor) = when (t) {
                            HomeTab.Conversations -> unread to c.accent
                            HomeTab.Tickets -> if (badges.overdueTickets > 0) badges.overdueTickets to c.danger else badges.openTickets to c.accent
                            HomeTab.Team -> badges.internalUnread to c.accent
                            HomeTab.Calls -> badges.ringingCalls to c.accent
                            HomeTab.Settings -> 0 to c.accent
                        }
                        NavigationBarItem(
                            selected = selected,
                            onClick = { onTab(t) },
                            icon = {
                                BadgedBox(
                                    badge = {
                                        if (count > 0) {
                                            Badge(containerColor = badgeColor, contentColor = if (badgeColor == c.danger) Color.White else c.onAccent) {
                                                Text(if (count > 99) "99+" else count.toString(), fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
                                            }
                                        }
                                    },
                                ) { Icon(if (selected) t.selectedIcon else t.icon, contentDescription = null) }
                            },
                            label = { Text(t.label, fontSize = 11.5.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = if (c.isDark) c.textPrimary else c.brandStrong,
                                selectedTextColor = if (c.isDark) c.textPrimary else c.brandStrong,
                                indicatorColor = c.soft(c.brand, if (c.isDark) 0.3f else 0.18f),
                                unselectedIconColor = c.textSecondary,
                                unselectedTextColor = c.textSecondary,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(bottom = padding.calculateBottomPadding())
        Box(Modifier.fillMaxSize().background(c.background)) {
            androidx.compose.runtime.key(argToken) {
            when (tab) {
                HomeTab.Conversations -> ConversationsScreen(
                    container = container,
                    modifier = modifier,
                    initialSheet = initialArg,
                    openConversation = openConversation,
                    openCall = openCall,
                    newTicket = newTicket,
                    showMessage = { text -> scope.launch { snackbar.showSnackbar(text) } },
                )
                HomeTab.Tickets -> TicketsScreen(container, modifier, openTicket, openConversation = { openConversation(it, null) }, initialFilter = initialArg)
                HomeTab.Team -> TeamScreen(container, modifier, initialSegment = initialArg, openInternalChat = openInternalChat, openBot = openBot, openBotRuns = openBotRuns)
                HomeTab.Calls -> CallsScreen(container, modifier, openCall, openConversation = { openConversation(it, null) })
                HomeTab.Settings -> SettingsScreen(container, modifier, openLines, openMenus, openBotLines)
            }
            }
        }
    }
}
