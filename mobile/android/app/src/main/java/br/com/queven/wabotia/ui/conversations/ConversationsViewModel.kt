package br.com.queven.wabotia.ui.conversations

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Call
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.Event
import br.com.queven.wabotia.core.net.ApiClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Filtros em chips da aba Conversas (mobile/README.md). "Minhas" = state=human filtrado por owner == eu. */
enum class ConversationFilter(val label: String, val state: String?) {
    Queue("Fila", "waiting"),
    Mine("Minhas", "human"),
    Ai("IA", "ai"),
    Closed("Concluídas", "closed"),
    All("Todas", null),
}

class ConversationsViewModel(private val container: AppContainer) : ViewModel() {
    val profileId: String get() = container.session.profileId ?: ""
    val meId: String? get() = container.session.user?.id

    var filter by mutableStateOf(ConversationFilter.Queue)
        private set
    var query by mutableStateOf("")
    var appliedQuery by mutableStateOf("")
        private set
    var items by mutableStateOf<List<Conversation>>(emptyList())
        private set
    var nextCursor by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var ringing by mutableStateOf<List<Call>>(emptyList())
        private set
    var callNames by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var names by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var callBusy by mutableStateOf(false)
        private set

    private var loadJob: Job? = null
    private var generation = 0

    fun selectFilter(value: ConversationFilter) {
        if (filter == value) return
        filter = value
        load(reset = true, keepCount = false)
    }

    /** Aplica a busca digitada (a tela faz o debounce). */
    fun applyQuery() {
        if (appliedQuery == query) return
        appliedQuery = query
        load(reset = true, keepCount = false)
    }

    fun refresh() {
        refreshing = true
        load(reset = true, keepCount = false)
    }

    /** Recarga sem indicador (eventos, volta ao primeiro plano), preservando a quantidade já carregada. */
    fun reloadSilently() = load(reset = true, keepCount = true)

    fun loadMore() {
        if (nextCursor == null || loadingMore || loading || refreshing) return
        load(reset = false, keepCount = false)
    }

    fun dismissError() { error = null }

    private fun load(reset: Boolean, keepCount: Boolean) {
        val gen = ++generation
        loadJob?.cancel()
        val target = if (reset && keepCount) items.size else 0
        val state = filter.state
        val mine = filter == ConversationFilter.Mine
        val q = appliedQuery.trim().ifBlank { null }
        val me = meId
        loadJob = viewModelScope.launch {
            if (reset) loading = items.isEmpty() else loadingMore = true
            try {
                val collected = if (reset) ArrayList<Conversation>() else ArrayList(items)
                var cursor: String? = if (reset) null else nextCursor
                var pages = 0
                do {
                    val page = container.api.conversations(profileId, state = state, q = q, cursor = cursor, limit = 50)
                    collected += if (mine) page.data.filter { it.owner == me } else page.data
                    cursor = page.next_cursor
                    pages++
                    val wantMore = cursor != null && pages < 6 && (collected.size < target || (mine && collected.size < 20))
                } while (wantMore)
                if (gen != generation) return@launch
                items = collected.distinctBy { it.id }
                nextCursor = cursor
                error = null
                loaded = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (gen == generation) error = container.handleError(e)
            } finally {
                if (gen == generation) {
                    loading = false
                    refreshing = false
                    loadingMore = false
                }
            }
        }
    }

    fun loadPresence() {
        viewModelScope.launch {
            try {
                names = container.api.presence(profileId).associate { it.actor to it.name }
            } catch (_: Exception) {
                // nomes são apenas decorativos na lista
            }
        }
    }

    /** Ligações tocando (`ringing`) sem responsável ou já minhas, para a faixa no topo. */
    fun refreshCalls() {
        viewModelScope.launch {
            try {
                val page = container.api.calls(profileId, limit = 30)
                val live = page.data.filter { it.status == "ringing" && (it.actor.isNullOrBlank() || it.actor == meId) }
                ringing = live
                for (call in live) {
                    if (callNames.containsKey(call.conversation_id)) continue
                    val name = items.firstOrNull { it.id == call.conversation_id }?.displayName
                        ?: runCatching { container.api.conversation(profileId, call.conversation_id).conversation.displayName }.getOrNull()
                    if (name != null) callNames = callNames + (call.conversation_id to name)
                }
            } catch (_: Exception) {
                // sem permissão de ligações ou sem rede: a faixa simplesmente não aparece
            }
        }
    }

    /** Recusar = claim + reject (mobile/README.md, Ligações). */
    fun rejectCall(call: Call) {
        if (callBusy) return
        viewModelScope.launch {
            callBusy = true
            try {
                container.api.claimCall(profileId, call.id, ApiClient.newIdempotencyKey())
                container.api.rejectCall(profileId, call.id, ApiClient.newIdempotencyKey())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            } finally {
                callBusy = false
            }
            refreshCalls()
        }
    }

    fun onEvents(events: List<Event>) {
        if (events.any { it.kind.startsWith("conversation.") || it.kind.startsWith("message.") }) reloadSilently()
        if (events.any { it.kind.startsWith("call.") }) refreshCalls()
    }
}
