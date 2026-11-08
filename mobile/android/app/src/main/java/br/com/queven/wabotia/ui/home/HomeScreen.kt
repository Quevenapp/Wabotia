package br.com.queven.wabotia.ui.home

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import br.com.queven.wabotia.calls.CallsScreen
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.ui.bots.BotsScreen
import br.com.queven.wabotia.ui.conversations.ConversationsScreen
import br.com.queven.wabotia.ui.settings.SettingsScreen
import br.com.queven.wabotia.ui.tickets.TicketsScreen

enum class HomeTab(val label: String, val icon: ImageVector) {
    Conversations("Conversas", Icons.AutoMirrored.Filled.Chat),
    Tickets("Protocolos", Icons.Filled.Description),
    Bots("Bots", Icons.Filled.SmartToy),
    Calls("Ligações", Icons.Filled.Call),
    More("Mais", Icons.Filled.MoreHoriz),
}

@Composable
fun HomeScreen(
    container: AppContainer,
    openConversation: (String) -> Unit,
    openTicket: (String) -> Unit,
    openBot: (String) -> Unit,
    openCall: (conversationId: String, callId: String?) -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(HomeTab.Conversations) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                HomeTab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(padding)
        when (tab) {
            HomeTab.Conversations -> ConversationsScreen(container, modifier, openConversation, openCall)
            HomeTab.Tickets -> TicketsScreen(container, modifier, openTicket, openConversation)
            HomeTab.Bots -> BotsScreen(container, modifier, openBot)
            HomeTab.Calls -> CallsScreen(container, modifier, openCall, openConversation)
            HomeTab.More -> SettingsScreen(container, modifier)
        }
    }
}
