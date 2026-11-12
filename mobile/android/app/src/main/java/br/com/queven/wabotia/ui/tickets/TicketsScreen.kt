@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.tickets

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.components.FilterRow
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
    /** Texto digitado na busca (número do protocolo ou telefone); a tela faz o debounce e chama [applyQuery]. */
    var query by mutableStateOf("")
    var appliedQuery by mutableStateOf("")
        private set
    /** Contadores dos chips Abertos, Em andamento e Atrasados. */
    var counts by mutableStateOf<Map<TicketFilter, Int>>(emptyMap())
        private set
    /** `id da pessoa` → nome, de GET /presence (para o responsável no cartão). */
    var names by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    private var started = false
    private var job: Job? = null
    private var countsJob: Job? = null

    private val q: String? get() = appliedQuery.trim().ifBlank { null }

    fun start() {
        if (!started) {
            refresh()
            loadNames()
        }
    }

    fun ownerName(owner: String?): String? {
        if (owner.isNullOrBlank()) return null
        names[owner]?.takeIf { it.isNotBlank() }?.let { return it }
        container.session.user?.takeIf { it.id == owner }?.let { return it.name.ifBlank { "Você" } }
        return "Atendente ${owner.take(8)}"
    }

    private fun loadNames() {
        if (profileId.isBlank()) return
        viewModelScope.launch {
            try {
                names = container.api.presence(profileId).associate { it.actor to it.name }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // nomes são complementares: o cartão mostra o identificador curto enquanto não chegam
            }
        }
    }

    /** Contadores dos chips: três consultas leves, usando o tamanho de cada lista. */
    private fun loadCounts() {
        if (profileId.isBlank()) return
        countsJob?.cancel()
        countsJob = viewModelScope.launch {
            val result = HashMap(counts)
            for (f in listOf(TicketFilter.Open, TicketFilter.InProgress, TicketFilter.Overdue)) {
                try {
                    result[f] = container.api.tickets(profileId, status = f.status, overdue = f.overdue).data.size
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // mantém o último contador conhecido
                }
            }
            counts = result
        }
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
                val page = container.api.tickets(profileId, status = filter.status, overdue = filter.overdue, q = q)
                tickets = page.data
                nextCursor = page.next_cursor
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Falha momentânea: encerra a sessão em 401 e deixa a lista como está; o pull-to-refresh mostra o erro.
                container.handleError(e)
            }
        }
        loadCounts()
    }

    fun selectFilter(f: TicketFilter) {
        if (filter == f) return
        filter = f
        tickets = emptyList()
        nextCursor = null
        refresh()
    }

    /** Aplica a busca digitada (número ou telefone → `q`). */
    fun applyQuery() {
        if (appliedQuery == query) return
        appliedQuery = query
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
                val page = container.api.tickets(profileId, status = filter.status, overdue = filter.overdue, q = q)
                tickets = page.data
                nextCursor = page.next_cursor
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
        loadCounts()
        if (pull) loadNames()
    }

    fun loadMore() {
        val cursor = nextCursor ?: return
        if (loadingMore || loading || refreshing) return
        viewModelScope.launch {
            loadingMore = true
            try {
                val page = container.api.tickets(profileId, status = filter.status, overdue = filter.overdue, cursor = cursor, q = q)
                val known = tickets.map { it.id }.toHashSet()
                tickets = tickets + page.data.filter { it.id !in known }
                nextCursor = page.next_cursor
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            } finally {
                loadingMore = false
            }
        }
    }
}

/** Aba Protocolos: busca por número/telefone, chips com contador, cartões com prazo, pull-to-refresh e paginação. */
@Composable
fun TicketsScreen(container: AppContainer, modifier: Modifier = Modifier, openTicket: (String) -> Unit, openConversation: (String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: TicketsViewModel = viewModel(key = "tickets-$profileId") { TicketsViewModel(container, profileId) }
    LaunchedEffect(vm) { vm.start() }

    // Em primeiro plano: eventos `ticket.*` recarregam a lista; voltar à aba recarrega uma vez.
    EventPolling(container, profileId, onStart = { vm.reloadSilently() }) { events ->
        if (events.any { it.kind.startsWith("ticket.") }) vm.reloadSilently()
    }

    // Busca com debounce de 400 ms.
    LaunchedEffect(vm.query) {
        if (vm.query != vm.appliedQuery) {
            delay(400)
            vm.applyQuery()
        }
    }

    var searching by rememberSaveable { mutableStateOf(false) }
    val searchFocus = remember { FocusRequester() }
    fun closeSearch() {
        searching = false
        vm.query = ""
        vm.applyQuery()
    }
    BackHandler(enabled = searching) { closeSearch() }
    LaunchedEffect(searching) { if (searching) runCatching { searchFocus.requestFocus() } }

    // Um único relógio para todos os cartões (prazos).
    val now by rememberNow()
    val c = Wb.colors

    Column(modifier.fillMaxSize().background(c.background)) {
        if (searching) {
            Row(
                Modifier.fillMaxWidth().background(c.background).statusBarsPadding().heightIn(min = 60.dp).padding(start = 4.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { closeSearch() }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Fechar busca", tint = c.textPrimary)
                }
                SearchField(
                    value = vm.query,
                    onValueChange = { vm.query = it },
                    placeholder = "Buscar por número ou telefone",
                    modifier = Modifier.weight(1f),
                    focusRequester = searchFocus,
                    onSearch = { vm.applyQuery() },
                )
            }
        } else {
            TabTopBar("Protocolos") {
                IconButton(onClick = { searching = true }) {
                    Icon(Icons.Filled.Search, contentDescription = "Buscar protocolo", tint = c.textPrimary)
                }
            }
        }
        ConnectionStrip(container)
        FilterRow {
            TicketFilter.entries.forEach { f ->
                WbFilterChip(
                    label = f.label,
                    selected = vm.filter == f,
                    onClick = { vm.selectFilter(f) },
                    count = vm.counts[f],
                    tone = if (f == TicketFilter.Overdue) c.danger else null,
                )
            }
        }
        PullToRefreshBox(
            isRefreshing = vm.refreshing,
            onRefresh = { vm.refresh(pull = true) },
            modifier = Modifier.fillMaxWidth().weight(1f),
        ) {
            when {
                vm.loading && vm.tickets.isEmpty() -> SkeletonList(Modifier.fillMaxSize(), rows = 6, avatar = false)
                vm.error != null && vm.tickets.isEmpty() -> ErrorState(vm.error ?: "", onRetry = { vm.refresh() })
                vm.tickets.isEmpty() -> {
                    if (vm.appliedQuery.isNotBlank()) {
                        EmptyState(Icons.Filled.SearchOff, "Nenhum protocolo encontrado", subtitle = "Confira o número WA-… ou o telefone e tente de novo.")
                    } else {
                        EmptyState(Icons.Filled.ConfirmationNumber, emptyTitle(vm.filter), subtitle = emptySubtitle(vm.filter))
                    }
                }
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(vm.tickets, key = { it.id }) { t ->
                        TicketCard(
                            ticket = t,
                            ownerName = vm.ownerName(t.owner),
                            now = now,
                            onClick = { openTicket(t.id) },
                            onOpenConversation = if (t.conversation_id.isNotBlank()) ({ openConversation(t.conversation_id) }) else null,
                        )
                    }
                    if (vm.error != null) {
                        item("error") {
                            InlineNotice(vm.error ?: "", actionLabel = "Tentar de novo", onAction = { if (vm.nextCursor != null) vm.loadMore() else vm.refresh() })
                        }
                    } else if (vm.nextCursor != null) {
                        item("more") {
                            // Rolagem infinita: chegar ao fim da lista pede a próxima página pelo cursor.
                            LaunchedEffect(vm.nextCursor) { vm.loadMore() }
                            Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = c.brand)
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun emptyTitle(filter: TicketFilter) = when (filter) {
    TicketFilter.Open -> "Nenhum protocolo aberto"
    TicketFilter.InProgress -> "Nenhum protocolo em andamento"
    TicketFilter.Overdue -> "Nenhum protocolo atrasado"
    TicketFilter.Closed -> "Nenhum protocolo concluído"
    TicketFilter.All -> "Nenhum protocolo neste perfil"
}

private fun emptySubtitle(filter: TicketFilter) = when (filter) {
    TicketFilter.Overdue -> "Tudo dentro do prazo. Bom trabalho!"
    TicketFilter.All, TicketFilter.Open -> "Abra um protocolo a partir de uma conversa."
    else -> null
}
