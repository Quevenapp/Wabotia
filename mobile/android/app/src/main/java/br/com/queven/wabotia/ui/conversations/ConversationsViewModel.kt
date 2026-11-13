package br.com.queven.wabotia.ui.conversations

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.ActionRequest
import br.com.queven.wabotia.core.model.Call
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.Event
import br.com.queven.wabotia.core.model.Profile
import br.com.queven.wabotia.core.model.ProfileStatus
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.components.handleError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Chips da aba Conversas (DESIGN.md §4). "Minhas" = state=human filtrado por owner == eu. */
enum class ConversationFilter(val label: String, val state: String?) {
    All("Todas", null),
    Queue("Fila", "waiting"),
    Mine("Minhas", "human"),
    Bots("Bots", "ai"),
    Closed("Concluídas", "closed"),
}

class ConversationsViewModel(private val container: AppContainer) : ViewModel() {
    val profileId: String get() = container.session.profileId ?: ""
    val meId: String? get() = container.session.user?.id

    var filter by mutableStateOf(ConversationFilter.All)
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
    /** Pessoas e bots do perfil (`id` → contato), para "Com Ana" e "Bot Vendas". */
    var team by mutableStateOf<Map<String, TeamContact>>(emptyMap())
        private set
    var status by mutableStateOf<ProfileStatus?>(container.profileData.cached(container.session.profileId))
        private set
    var profiles by mutableStateOf<List<Profile>>(emptyList())
        private set
    var callBusy by mutableStateOf(false)
        private set
    /** Conversa com ação rápida em curso (assumir/concluir pela lista). */
    var actingOn by mutableStateOf<String?>(null)
        private set
    /** Retorno curto para snackbar. */
    var notice by mutableStateOf<String?>(null)

    /** "Minhas" contado nas conversas em atendimento carregadas (o servidor não conta por dono). */
    var mineCount by mutableStateOf(0)
        private set

    private var loadJob: Job? = null
    private var fillJob: Job? = null
    private var generation = 0
    private val fillAttempted = HashSet<String>()
    private var pendingAct: Triple<String, ActionRequest, String>? = null

    fun selectFilter(value: ConversationFilter) {
        if (filter == value) return
        filter = value
        items = emptyList()
        loaded = false
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
        loadSideData(force = true)
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
        container.conversationCache.use(profileId)
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
                if (q == null && (filter == ConversationFilter.All || mine)) {
                    mineCount = items.count { it.isOwnedBy(me) }
                }
                fillPreviews()
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

    /**
     * Preenchimento em segundo plano: as 15 primeiras conversas sem prévia conhecida recebem uma chamada de detalhe
     * (duas por vez). O detalhe alimenta o cache local; a lista recompõe sozinha.
     */
    private fun fillPreviews() {
        val cache = container.conversationCache
        val pending = items.take(30).filter { c ->
            val known = cache.previews[c.id]
            (known == null || known.kind == "attachment" || known.at < c.last_customer) && fillAttempted.add(c.id + ":" + c.updated)
        }.take(15)
        if (pending.isEmpty()) return
        val profile = profileId
        fillJob?.cancel()
        fillJob = viewModelScope.launch {
            val gate = Semaphore(2)
            pending.forEach { c ->
                launch {
                    gate.withPermit {
                        try {
                            cache.onDetail(container.api.conversation(profile, c.id))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            // prévia é complementar: a linha mostra o texto do estado enquanto não houver
                        }
                    }
                }
            }
        }
    }

    /** Nomes da equipe, contagens por estado e tipo das linhas. */
    fun loadSideData(force: Boolean = false) {
        val profile = profileId
        if (profile.isBlank()) return
        viewModelScope.launch {
            container.profileData.load(profile, maxAgeMs = if (force) 0 else 20_000)?.let { status = it }
        }
        viewModelScope.launch {
            try {
                team = container.api.team(profile).data.associateBy { it.id }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // nomes são complementares na lista
            }
        }
        if (profiles.isEmpty()) {
            viewModelScope.launch {
                try {
                    profiles = container.api.profiles()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
            }
        }
    }

    fun selectProfile(id: String) {
        if (id == profileId) return
        container.onProfileSelected(id)
    }

    /** Ligações tocando (`ringing`) sem responsável ou já minhas, para o cartão no topo. */
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
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // sem permissão de ligações ou sem rede: o cartão simplesmente não aparece
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

    // --- ações rápidas pela lista (deslizar e toque longo) ---

    fun claim(c: Conversation, onDone: () -> Unit = {}) = act(c, ActionRequest(action = "claim"), "Conversa assumida", onDone)
    fun resolve(c: Conversation) = act(c, ActionRequest(action = "resolve"), "Conversa concluída")
    fun saveTags(c: Conversation, tags: List<String>) =
        act(c, ActionRequest(action = "tags", tags = tags.map { it.trim().take(40) }.filter { it.isNotEmpty() }.distinct().take(20)), "Etiquetas salvas")

    private fun act(c: Conversation, request: ActionRequest, done: String, onDone: () -> Unit = {}) {
        if (actingOn != null) return
        // Mesmo pedido repetido após falha de rede → mesma chave; pedido diferente → chave nova.
        val key = pendingAct?.takeIf { it.first == c.id && it.second == request }?.third
            ?: ApiClient.newIdempotencyKey().also { pendingAct = Triple(c.id, request, it) }
        actingOn = c.id
        viewModelScope.launch {
            try {
                container.api.act(profileId, c.id, key, request)
                pendingAct = null
                notice = done
                onDone()
                reloadSilently()
                loadSideData(force = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiException && (e.isIdempotencyConflict || e.isDefinitiveWriteRejection)) pendingAct = null
                notice = container.handleError(e)
            } finally {
                actingOn = null
            }
        }
    }

    fun onEvents(events: List<Event>) {
        if (events.any { it.kind.startsWith("conversation.") || it.kind.startsWith("message.") }) {
            reloadSilently()
            loadSideData(force = true)
        }
        if (events.any { it.kind.startsWith("call.") }) refreshCalls()
    }
}
