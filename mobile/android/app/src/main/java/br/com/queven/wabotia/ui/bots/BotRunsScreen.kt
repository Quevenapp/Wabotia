package br.com.queven.wabotia.ui.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.BotRun
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.formatWhen
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Bots habilitados (para os nomes) e execuções recentes (`GET /bot-runs`, mais recentes primeiro). */
class BotRunsViewModel(private val container: AppContainer, private val profileId: String) : ViewModel() {
    var bots by mutableStateOf<List<Bot>>(emptyList())
        private set
    var runs by mutableStateOf<List<BotRun>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var started = false
    private var job: Job? = null

    fun start() {
        if (!started) load()
    }

    fun load(pull: Boolean = false) {
        if (profileId.isBlank()) { error = "Perfil não selecionado."; return }
        job?.cancel()
        job = viewModelScope.launch {
            if (pull) refreshing = true else loading = true
            error = null
            try {
                coroutineScope {
                    val b = async { container.api.bots(profileId) }
                    val r = async { container.api.botRuns(profileId) }
                    bots = b.await().data.sortedBy { it.name.lowercase() }
                    runs = r.await().data.sortedByDescending { it.created }.take(50)
                }
                started = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            } finally {
                loading = false
                refreshing = false
            }
        }
    }

    fun botName(botId: String): String = bots.firstOrNull { it.id == botId }?.name?.ifBlank { null } ?: "Bot ${botId.take(8)}"
}

/** Execuções recentes dos bots: estado colorido, bot, pergunta, prévia da resposta e horário. Toque abre o chat do bot. */
@Composable
fun BotRunsScreen(container: AppContainer, onBack: () -> Unit, openBot: (String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: BotRunsViewModel = viewModel(key = "bot-runs-$profileId") { BotRunsViewModel(container, profileId) }
    LaunchedEffect(vm) { vm.start() }
    val c = Wb.colors

    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar("Execuções recentes", onBack, subtitle = "Perguntas feitas aos bots")
        PullToRefreshBox(isRefreshing = vm.refreshing, onRefresh = { vm.load(pull = true) }, modifier = Modifier.fillMaxSize().navigationBarsPadding()) {
            when {
                vm.loading && vm.runs.isEmpty() -> SkeletonList(rows = 7)
                vm.error != null && vm.runs.isEmpty() -> ErrorState(vm.error ?: "", onRetry = { vm.load() })
                vm.runs.isEmpty() -> EmptyState(
                    Icons.Filled.History,
                    "Nenhuma execução ainda",
                    subtitle = "Abra um bot na aba Equipe e faça uma pergunta. O histórico aparece aqui.",
                )
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    vm.error?.let { message ->
                        item("error") { InlineNotice(message, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), actionLabel = "Tentar de novo", onAction = { vm.load() }) }
                    }
                    items(vm.runs, key = { "run-" + it.id }) { run ->
                        RunRow(run, vm.botName(run.bot_id), onClick = { openBot(run.bot_id) })
                        RowDivider(startIndent = 74.dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun RunRow(run: BotRun, botName: String, onClick: () -> Unit) {
    val c = Wb.colors
    val preview = run.error?.takeIf { it.isNotBlank() } ?: run.output().text.takeIf { it.isNotBlank() }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Avatar(botName, seed = run.bot_id, size = 44.dp, kind = AvatarKind.Bot)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(botName, style = MaterialTheme.typography.titleSmall, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(formatWhen(run.created), style = MaterialTheme.typography.labelMedium, color = c.textSecondary, maxLines = 1)
            }
            Spacer(Modifier.height(3.dp))
            Text(run.input.ifBlank { "(sem texto)" }, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (preview != null) {
                Spacer(Modifier.height(2.dp))
                Text(preview, style = MaterialTheme.typography.bodySmall, color = if (run.status == "failed") c.danger else c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(6.dp))
            Box { Pill(botRunStatusLabel(run.status), botRunStatusColor(run.status)) }
        }
    }
}
