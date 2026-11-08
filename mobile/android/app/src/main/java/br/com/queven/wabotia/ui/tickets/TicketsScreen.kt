@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.tickets

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Ticket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Filtros da aba Protocolos (mobile/README.md): status= ou overdue=1. */
enum class TicketFilter(val label: String, val status: String?, val overdue: String?) {
    Open("Abertos", "open", null),
    InProgress("Em andamento", "in_progress", null),
    Overdue("Atrasados", null, "1"),
    Closed("Concluídos", "closed", null),
    All("Todos", null, null),
}

class TicketsViewModel(private val container: AppContainer, private val profileId: String) : ViewModel() {
    var filter by mutableStateOf(TicketFilter.Open)
        private set
    var tickets by mutableStateOf<List<Ticket>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var nextCursor by mutableStateOf<String?>(null)
        private set

    private var started = false
    private var job: Job? = null

    fun start() {
        if (!started) refresh()
    }

    /**
     * Recarga silenciosa (sem indicador) disparada por eventos `ticket.*` ou ao voltar ao primeiro plano: outro atendente
     * pode ter criado/atribuído um protocolo. Só roda depois da primeira carga; mantém a página atual (primeira página).
     */
    fun reloadSilently() {
        if (!started || profileId.isBlank() || loading || refreshing || loadingMore) return
        job?.cancel()
        job = viewModelScope.launch {
            try {
                val page = container.api.tickets(profileId, status = filter.status, overdue = filter.overdue)
                tickets = page.data
                nextCursor = page.next_cursor
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Falha momentânea: encerra a sessão em 401 e deixa a lista como está; o pull-to-refresh mostra o erro.
                container.describeError(e)
            }
        }
    }

    fun selectFilter(f: TicketFilter) {
        if (filter == f) return
        filter = f
        tickets = emptyList()
        nextCursor = null
        refresh()
    }

    fun refresh(pull: Boolean = false) {
        if (profileId.isBlank()) { error = "Perfil não selecionado."; return }
        job?.cancel()
        job = viewModelScope.launch {
            if (pull) refreshing = true else loading = true
            error = null
            try {
                val page = container.api.tickets(profileId, status = filter.status, overdue = filter.overdue)
                tickets = page.data
                nextCursor = page.next_cursor
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

    fun loadMore() {
        val cursor = nextCursor ?: return
        if (loadingMore || loading || refreshing) return
        viewModelScope.launch {
            loadingMore = true
            try {
                val page = container.api.tickets(profileId, status = filter.status, overdue = filter.overdue, cursor = cursor)
                val known = tickets.map { it.id }.toHashSet()
                tickets = tickets + page.data.filter { it.id !in known }
                nextCursor = page.next_cursor
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.describeError(e)
            } finally {
                loadingMore = false
            }
        }
    }
}

/** Lista de protocolos com filtros, cores de prazo, pull-to-refresh e paginação por cursor. */
@Composable
fun TicketsScreen(container: AppContainer, modifier: Modifier = Modifier, openTicket: (String) -> Unit, openConversation: (String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: TicketsViewModel = viewModel(key = "tickets-$profileId") { TicketsViewModel(container, profileId) }
    LaunchedEffect(vm) { vm.start() }

    // Em primeiro plano (mobile/README.md "Atualização em primeiro plano"): eventos `ticket.*` recarregam a lista e
    // voltar à aba recarrega uma vez, porque outra tela pode ter consumido o cursor de eventos enquanto isso.
    TicketEventPolling(container, profileId, onStart = { vm.reloadSilently() }) { vm.reloadSilently() }

    Column(modifier.fillMaxSize()) {
        Text(
            "Protocolos",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp),
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            TicketFilter.entries.forEach { f ->
                FilterChip(selected = vm.filter == f, onClick = { vm.selectFilter(f) }, label = { Text(f.label) })
            }
        }
        Spacer(Modifier.height(4.dp))
        PullToRefreshBox(
            isRefreshing = vm.refreshing,
            onRefresh = { vm.refresh(pull = true) },
            modifier = Modifier.fillMaxWidth().weight(1f),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                when {
                    vm.loading && vm.tickets.isEmpty() -> item {
                        Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                    vm.error != null && vm.tickets.isEmpty() -> item {
                        Column(
                            Modifier.fillParentMaxSize().padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(vm.error ?: "", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { vm.refresh() }) { Text("Tentar novamente") }
                        }
                    }
                    vm.tickets.isEmpty() -> item {
                        Box(Modifier.fillParentMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                            Text(
                                emptyMessage(vm.filter),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    else -> {
                        items(vm.tickets, key = { it.id }) { t ->
                            TicketRow(t, onClick = { openTicket(t.id) }, onOpenConversation = { openConversation(t.conversation_id) })
                            HorizontalDivider()
                        }
                        if (vm.nextCursor != null) {
                            item {
                                LaunchedEffect(vm.nextCursor) { vm.loadMore() }
                                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                                    if (vm.loadingMore) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                                    else Button(onClick = { vm.loadMore() }) { Text("Carregar mais") }
                                }
                            }
                        }
                        if (vm.error != null) {
                            item {
                                Text(
                                    vm.error ?: "",
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun emptyMessage(filter: TicketFilter) = when (filter) {
    TicketFilter.Open -> "Nenhum protocolo aberto."
    TicketFilter.InProgress -> "Nenhum protocolo em andamento."
    TicketFilter.Overdue -> "Nenhum protocolo atrasado."
    TicketFilter.Closed -> "Nenhum protocolo concluído."
    TicketFilter.All -> "Nenhum protocolo neste perfil. Abra um a partir de uma conversa."
}

@Composable
private fun TicketRow(t: Ticket, onClick: () -> Unit, onOpenConversation: () -> Unit) {
    val tone = t.dueTone()
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        overlineContent = { Text(t.number.ifBlank { "Protocolo" }, fontWeight = FontWeight.SemiBold) },
        headlineContent = {
            Text(t.title.ifBlank { "Sem título" }, maxLines = 2, overflow = TextOverflow.Ellipsis)
        },
        supportingContent = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        ticketStatusLabel(t.status),
                        color = ticketStatusColor(t.status),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                    Text(t.dueLabel(), color = tone.color(), style = MaterialTheme.typography.labelMedium)
                }
                Text(
                    "Aberto ${formatWhen(t.created)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        trailingContent = {
            IconButton(onClick = onOpenConversation) {
                Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = "Abrir conversa do protocolo ${t.number}")
            }
        },
    )
}
