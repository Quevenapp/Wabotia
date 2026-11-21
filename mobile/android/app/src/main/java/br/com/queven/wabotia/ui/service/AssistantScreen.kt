package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException

/** Qual bot responde o "Perguntar ao assistente". */
object AssistantRules {
    /** Os bots ligados da área, em ordem de nome; o id da conversa interna é o da equipe ("bot:<id>"). */
    fun candidates(team: List<TeamContact>): List<TeamContact> = team.filter { it.isBot && it.enabled != false }.sortedBy { it.name.lowercase() }

    fun peerId(bot: TeamContact): String = if (bot.id.startsWith("bot:")) bot.id else "bot:" + (bot.bot_id ?: bot.id)

    /** Um bot só: abre direto a conversa; mais de um: a pessoa escolhe. */
    fun direct(team: List<TeamContact>): String? = candidates(team).singleOrNull()?.let(::peerId)
}

/**
 * "Perguntar ao assistente": abre a conversa interna com o bot da área (a mesma de Equipe → Bots), onde a pessoa pergunta
 * em linguagem natural sobre vendas, estoque, contas e clientes; o bot lê o ERP pelas concessões dadas no painel.
 */
@Composable
fun AssistantScreen(container: AppContainer, onBack: () -> Unit, openChat: (String) -> Unit) {
    val c = Wb.colors
    var bots by remember { mutableStateOf<List<TeamContact>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        val profile = container.session.profileId ?: return@LaunchedEffect
        try {
            val team = container.api.team(profile).data
            AssistantRules.direct(team)?.let { openChat(it); return@LaunchedEffect }
            bots = AssistantRules.candidates(team)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
        }
    }
    androidx.compose.material3.Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Perguntar ao assistente", onBack) },
    ) { padding ->
        val list = bots
        when {
            error != null -> ErrorState(error!!, onRetry = { attempt++ }, modifier = Modifier.padding(padding))
            list == null -> SkeletonList(Modifier.padding(padding), rows = 3)
            list.isEmpty() -> EmptyState(
                Icons.Filled.SmartToy, "Nenhum bot ligado nesta área", Modifier.padding(padding),
                subtitle = "Um administrador cria o bot no painel, em Gestão → Bots, e dá a ele as consultas do ERP.",
            )
            else -> Column(Modifier.padding(padding).fillMaxSize()) {
                Text(
                    "Escolha o assistente. Pergunte, por exemplo: “quanto vendi hoje?”, “tem shampoo em estoque?”, “quais contas vencem esta semana?”.",
                    style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(16.dp),
                )
                LazyColumn(Modifier.fillMaxSize().testTag("assistant.list"), contentPadding = PaddingValues(bottom = 32.dp)) {
                    items(list, key = { it.id }) { bot ->
                        SettingsRow(Icons.Filled.SmartToy, bot.name, tint = c.bot, onClick = { openChat(AssistantRules.peerId(bot)) })
                        RowDivider()
                    }
                }
            }
        }
    }
}
