@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.BotRun
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

class BotsViewModel(private val container: AppContainer, private val profileId: String) : ViewModel() {
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
                    bots = b.await().data.filter { it.enabled == 1 }.sortedBy { it.name.lowercase() }
                    runs = r.await().data.sortedByDescending { it.created }.take(50)
                }
                started = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.describeError(e)
            } finally {
                loading = false
                refreshing = false
            }
        }
    }

    fun botName(botId: String): String = bots.firstOrNull { it.id == botId }?.name?.ifBlank { null } ?: "Bot ${botId.take(8)}"
}

/** Aba Bots: bots habilitados e histórico recente de execuções com estado colorido. */
@Composable
fun BotsScreen(container: AppContainer, modifier: Modifier = Modifier, openBot: (String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: BotsViewModel = viewModel(key = "bots-$profileId") { BotsViewModel(container, profileId) }
    LaunchedEffect(vm) { vm.start() }

    Column(modifier.fillMaxSize()) {
        Text(
            "Bots",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp),
        )
        PullToRefreshBox(
            isRefreshing = vm.refreshing,
            onRefresh = { vm.load(pull = true) },
            modifier = Modifier.fillMaxWidth().weight(1f),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                when {
                    vm.loading && vm.bots.isEmpty() && vm.runs.isEmpty() -> item {
                        Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                    vm.error != null && vm.bots.isEmpty() && vm.runs.isEmpty() -> item {
                        Column(
                            Modifier.fillParentMaxSize().padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(vm.error ?: "", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { vm.load() }) { Text("Tentar novamente") }
                        }
                    }
                    else -> {
                        item { SectionTitle("Bots habilitados") }
                        if (vm.bots.isEmpty()) {
                            item {
                                Text(
                                    "Nenhum bot habilitado neste perfil. Configure a Equipe Bot no painel (Hermes).",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                )
                            }
                        } else {
                            items(vm.bots, key = { "bot-" + it.id }) { bot ->
                                ListItem(
                                    modifier = Modifier.clickable { openBot(bot.id) },
                                    leadingContent = { Icon(Icons.Filled.SmartToy, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
                                    headlineContent = { Text(bot.name.ifBlank { "Bot" }) },
                                    supportingContent = {
                                        Text(
                                            if (bot.remote_profile.isNotBlank()) "Hermes · ${bot.remote_profile}" else "Hermes",
                                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        )
                                    },
                                    trailingContent = { Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "Conversar com ${bot.name}") },
                                )
                                HorizontalDivider()
                            }
                        }

                        item { SectionTitle("Execuções recentes") }
                        if (vm.runs.isEmpty()) {
                            item {
                                Text(
                                    "Nenhuma execução ainda. Escolha um bot acima para começar.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                )
                            }
                        } else {
                            items(vm.runs, key = { "run-" + it.id }) { run ->
                                RunRow(run, vm.botName(run.bot_id), onClick = { openBot(run.bot_id) })
                                HorizontalDivider()
                            }
                        }
                        if (vm.error != null) {
                            item {
                                Text(vm.error ?: "", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                            }
                        }
                        item { Spacer(Modifier.height(16.dp)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
    )
}

@Composable
private fun RunRow(run: BotRun, botName: String, onClick: () -> Unit) {
    val color = botRunStatusColor(run.status)
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        leadingContent = {
            Box(Modifier.size(12.dp).clip(CircleShape).background(color))
        },
        overlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(botRunStatusLabel(run.status), color = color, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(8.dp))
                Text(formatWhen(run.created))
            }
        },
        headlineContent = { Text(run.input.ifBlank { "(sem texto)" }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            val preview = run.error?.takeIf { it.isNotBlank() } ?: run.output().text.takeIf { it.isNotBlank() }
            Column {
                Text(botName, style = MaterialTheme.typography.labelMedium)
                if (preview != null) Text(preview, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
            }
        },
    )
}
