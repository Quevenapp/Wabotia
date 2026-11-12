@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.tickets

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.material.icons.filled.Category
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
import br.com.queven.wabotia.core.model.Page
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.core.model.TicketCategory
import br.com.queven.wabotia.core.model.TicketStatus
import br.com.queven.wabotia.core.model.nameOf
import br.com.queven.wabotia.core.net.ApiException
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

/**
 * Filtros da aba Protocolos (mobile/README.md). [statuses] vazio = sem filtro de estado; com mais de um valor a lista
 * junta uma consulta `status=` por estado (o servidor aceita um estado por consulta). [active] usa `active=1` (0.14+).
 */
enum class TicketFilter(val label: String, val statuses: List<String> = emptyList(), val active: Boolean = false, val overdue: Boolean = false) {
    Active("Ativos", active = true),
    Open("Recebidos", listOf(TicketStatus.OPEN)),
    InProgress("Em análise", listOf(TicketStatus.IN_PROGRESS)),
    Waiting("Aguardando", TicketStatus.waiting),
    Overdue("Atrasados", overdue = true),
    Resolved("Resolvidos", TicketStatus.finished),
    All("Todos"),
    ;

    /** O que o filtro mostra, aplicado também no app: um servidor 0.13 ignora `active=1` e devolve tudo. */
    fun matches(ticket: Ticket, now: Long): Boolean = when {
        overdue -> ticket.isOverdueAt(now)
        active -> ticket.isActive
        statuses.isNotEmpty() -> ticket.status in statuses
        else -> true
    }
}

/** Contadores dos chips a partir da lista de protocolos ativos (uma consulta `active=1`). */
internal fun ticketCounts(active: List<Ticket>, now: Long): Map<TicketFilter, Int> =
    listOf(TicketFilter.Active, TicketFilter.Open, TicketFilter.InProgress, TicketFilter.Waiting, TicketFilter.Overdue)
        .associateWith { f -> active.count { it.isActive && f.matches(it, now) } }

class TicketsViewModel(private val container: AppContainer, private val profileId: String) : ViewModel() {
    var filter by mutableStateOf(TicketFilter.Active)
        private set
    /** Categoria escolhida no filtro (`id`), ou null para todas. */
    var category by mutableStateOf<String?>(null)
        private set
    /** Categorias de `settings.ticket_categories`; vazio em servidores 0.13 ou sem categorias configuradas. */
    var categories by mutableStateOf<List<TicketCategory>>(container.profileData.cached(profileId)?.ticketCategories().orEmpty())
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
    /** Contadores dos chips Ativos, Recebidos, Em análise, Aguardando e Atrasados. */
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
            loadCategories()
        }
    }

    fun categoryName(id: String?): String? = categories.nameOf(id)

    private fun loadCategories(force: Boolean = false) {
        if (profileId.isBlank()) return
        viewModelScope.launch {
            val loaded = container.profileData.load(profileId, maxAgeMs = if (force) 0 else 30_000)?.ticketCategories() ?: return@launch
            categories = loaded
            // A categoria filtrada deixou de existir: volta a mostrar todas.
            if (category != null && loaded.none { it.id == category }) selectCategory(null)
        }
    }

    fun selectCategory(id: String?) {
        if (category == id) return
        category = id
        tickets = emptyList()
        nextCursor = null
        refresh()
    }

    /**
     * Uma página do filtro atual. Filtros com mais de um estado (Aguardando, Resolvidos) fazem uma consulta por estado e
     * juntam o resultado, sem paginação; um estado que o servidor não conhece (0.13) conta como lista vazia.
     */
    private suspend fun fetch(f: TicketFilter, cursor: String? = null): Page<Ticket> {
        val now = System.currentTimeMillis()
        if (f.statuses.size > 1) {
            val merged = ArrayList<Ticket>()
            var answered = false
            var failure: Exception? = null
            for (status in f.statuses) {
                try {
                    merged += container.api.tickets(profileId, status = status, q = q, category = category).data
                    answered = true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    if (e.isUnauthorized) throw e
                    if (e.status == 400 || e.status == 422) answered = true else failure = e
                } catch (e: Exception) {
                    failure = e
                }
            }
            if (!answered) failure?.let { throw it }
            return Page(merged.distinctBy { it.id }.filter { f.matches(it, now) }.sortedByDescending { it.created }, null)
        }
        val page = container.api.tickets(
            profileId,
            status = f.statuses.firstOrNull(),
            overdue = if (f.overdue) "1" else null,
            cursor = cursor,
            q = q,
            active = if (f.active) "1" else null,
            category = category,
        )
        return page.copy(data = page.data.filter { f.matches(it, now) })
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

    /** Contadores dos chips: uma consulta `active=1`, contada no app por estado e por atraso. */
    private fun loadCounts() {
        if (profileId.isBlank()) return
        countsJob?.cancel()
        countsJob = viewModelScope.launch {
            try {
                val active = container.api.tickets(profileId, active = "1", category = category).data
                counts = ticketCounts(active, System.currentTimeMillis())
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // mantém os últimos contadores conhecidos
            }
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
                val page = fetch(filter)
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
                val page = fetch(filter)
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
        if (pull) {
            loadNames()
            loadCategories(force = true)
        }
    }

    fun loadMore() {
        val cursor = nextCursor ?: return
        if (loadingMore || loading || refreshing) return
        viewModelScope.launch {
            loadingMore = true
            try {
                val page = fetch(filter, cursor)
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
fun TicketsScreen(
    container: AppContainer,
    modifier: Modifier = Modifier,
    openTicket: (String) -> Unit,
    openConversation: (String) -> Unit,
    /** Filtro inicial pelo nome (atalho de demonstração): `active`, `open`, `waiting`, `resolved`, `all`… */
    initialFilter: String? = null,
) {
    val profileId = container.session.profileId ?: ""
    val vm: TicketsViewModel = viewModel(key = "tickets-$profileId") { TicketsViewModel(container, profileId) }
    LaunchedEffect(vm) { vm.start() }
    LaunchedEffect(initialFilter) {
        TicketFilter.entries.firstOrNull { it.name.equals(initialFilter, ignoreCase = true) }?.let { vm.selectFilter(it) }
    }

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
        // Filtro por categoria (aplicativo ou assunto): só aparece quando o perfil tem categorias configuradas.
        val categories = vm.categories.filter { it.enabled || it.id == vm.category }
        if (categories.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Category, contentDescription = "Categoria", tint = c.textSecondary, modifier = Modifier.size(18.dp))
                WbFilterChip("Todas", selected = vm.category == null, onClick = { vm.selectCategory(null) }, tone = if (vm.category == null) c.ticket else null)
                categories.forEach { category ->
                    val selected = vm.category == category.id
                    WbFilterChip(category.name, selected = selected, onClick = { vm.selectCategory(category.id) }, tone = if (selected) c.ticket else null)
                }
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
                            categoryName = vm.categoryName(t.category),
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
    TicketFilter.Active -> "Nenhum protocolo ativo"
    TicketFilter.Open -> "Nenhum protocolo recebido"
    TicketFilter.InProgress -> "Nenhum protocolo em análise"
    TicketFilter.Waiting -> "Nenhum protocolo aguardando"
    TicketFilter.Overdue -> "Nenhum protocolo atrasado"
    TicketFilter.Resolved -> "Nenhum protocolo resolvido ou encerrado"
    TicketFilter.All -> "Nenhum protocolo neste perfil"
}

private fun emptySubtitle(filter: TicketFilter) = when (filter) {
    TicketFilter.Overdue -> "Tudo dentro do prazo. Bom trabalho!"
    TicketFilter.All, TicketFilter.Active, TicketFilter.Open -> "Abra um protocolo a partir de uma conversa."
    TicketFilter.Waiting -> "Aqui ficam os protocolos que dependem do cliente ou de um terceiro."
    else -> null
}
