package br.com.queven.wabotia.modules.mensalidade

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * As dependências das telas da Mensalidade (trocáveis nos testes). [isAdmin]: baixa manual, isenção e pausar,
 * retomar ou encerrar só aparecem para administradores (o servidor responde 403 `admin_required` aos outros).
 */
class MensalidadeDeps(
    val client: MensalidadeClient,
    val onFailure: (Throwable) -> Unit,
    val isAdmin: () -> Boolean,
    val today: () -> String = { BrasiliaTime.today() },
) {
    companion object {
        fun of(container: AppContainer) = MensalidadeDeps(
            MensalidadeClient(ProfileApi.current(container)),
            { ModuleFailure.handle(container, ModuleIds.MENSALIDADE, it) },
            { container.session.user?.isAdmin == true },
        )
    }
}

/** Mensalidades: o mês (resumo e parcelas com filtro), as assinaturas e os inadimplentes. */
class MensalidadeViewModel(private val deps: MensalidadeDeps, container: AppContainer? = null, initialMode: Mode = Mode.MONTH) : ViewModel() {
    enum class Mode(val label: String) { MONTH("Mês"), SUBSCRIPTIONS("Assinaturas"), DELINQUENTS("Inadimplentes") }

    var mode by mutableStateOf(initialMode)
        private set
    var month by mutableStateOf(deps.today().take(7))
        private set
    var summary by mutableStateOf<MensalidadeSummary?>(null)
        private set
    var installments by mutableStateOf<List<Installment>>(emptyList())
        private set
    var installmentCounts by mutableStateOf<Map<String, Int>>(emptyMap())
        private set
    var filter by mutableStateOf("all")
        private set
    var subscriptionFilter by mutableStateOf("active")
        private set
    var subscriptions by mutableStateOf<List<Subscription>>(emptyList())
        private set
    var subscriptionCounts by mutableStateOf<Map<String, Int>>(emptyMap())
        private set
    var delinquents by mutableStateOf<List<Delinquent>>(emptyList())
        private set
    var query by mutableStateOf("")
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /**
     * Pagador de cada assinatura na aba dos inadimplentes: `GET /delinquents` não traz o pagador, então a linha o busca
     * pela assinatura quando aparece, uma vez. Valor `null` guardado: sem pagador (servidor antigo).
     */
    var payers by mutableStateOf<Map<String, Payer?>>(emptyMap())
        private set

    private var job: Job? = null
    private val payerLoading = mutableSetOf<String>()

    init {
        container?.let { observeModuleEvents(it, "mensalidade.") { load() } }
    }

    /** Busca o pagador da assinatura (com os telefones); sem a rota de pagadores, fica o resumo da assinatura. */
    suspend fun loadPayer(subscriptionId: String) {
        if (subscriptionId in payers || !payerLoading.add(subscriptionId)) return
        try {
            // Sem rede, nada fica guardado: a linha tenta de novo quando aparecer outra vez.
            val ref = try {
                deps.client.subscription(subscriptionId).payer
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return
            }
            val found = ref?.let { r -> runCatching { deps.client.payer(r.id) }.getOrNull() ?: Payer(r.id, name = r.name, documentDisplay = r.documentDisplay) }
            payers = payers + (subscriptionId to found)
        } finally {
            payerLoading.remove(subscriptionId)
        }
    }

    private val empty: Boolean get() = summary == null && installments.isEmpty() && subscriptions.isEmpty() && delinquents.isEmpty()

    /** Contagem do filtro das parcelas no mês (chave ausente vale 0). */
    fun count(filter: String): Int = MensalidadeRules.count(installmentCounts, filter)

    fun subscriptionCount(filter: String): Int = if (filter == "all") subscriptionCounts.values.sum() else subscriptionCounts[filter] ?: 0

    /** O `Job` devolvido serve aos testes para esperar a leitura. */
    fun refresh(): Job {
        job?.cancel()
        return viewModelScope.launch { load() }.also { job = it }
    }

    suspend fun load() {
        if (empty) loading = true
        try {
            when (mode) {
                Mode.MONTH -> {
                    val statuses = MensalidadeRules.FILTERS.firstOrNull { it.first == filter }?.third.orEmpty()
                    val found = deps.client.summary(month)
                    val page = deps.client.installments(month, statuses, query)
                    summary = found
                    installments = page.data
                    installmentCounts = page.counts
                }
                Mode.SUBSCRIPTIONS -> {
                    val page = deps.client.subscriptions(if (subscriptionFilter == "all") emptyList() else listOf(subscriptionFilter), query)
                    subscriptions = page.data
                    subscriptionCounts = page.counts
                }
                Mode.DELINQUENTS -> delinquents = deps.client.delinquents()
            }
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            error = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    fun changeMode(mode: Mode): Job? {
        if (this.mode == mode) return null
        this.mode = mode
        query = ""
        return refresh()
    }

    fun shiftMonth(n: Int) {
        month = BrasiliaTime.addMonths(month, n)
        summary = null
        installments = emptyList()
        refresh()
    }

    fun goCurrentMonth() {
        month = deps.today().take(7)
        refresh()
    }

    fun changeFilter(id: String) {
        if (filter == id) return
        filter = id
        installments = emptyList()
        refresh()
    }

    fun changeSubscriptionFilter(id: String) {
        if (subscriptionFilter == id) return
        subscriptionFilter = id
        subscriptions = emptyList()
        refresh()
    }

    /** Busca com uma pausa curta, para não consultar a cada letra. */
    fun search(text: String) {
        query = text
        job?.cancel()
        job = viewModelScope.launch {
            delay(350)
            load()
        }
    }
}

/** Uma parcela: reenviar a cobrança (qualquer pessoa da área), dar baixa e isentar (administrador). */
class InstallmentViewModel(val id: String, private val deps: MensalidadeDeps, container: AppContainer? = null) : ViewModel() {
    var installment by mutableStateOf<Installment?>(null)
        private set
    /** A assinatura da parcela (conversa e pagador). */
    var subscription by mutableStateOf<Subscription?>(null)
        private set
    /** O pagador com os telefones; servidor sem a rota de pagadores: fica `null` e a tela mostra o telefone da assinatura. */
    var payer by mutableStateOf<Payer?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)

    private val keys = IntentKeys()

    init {
        container?.let { observeModuleEvents(it, "mensalidade.") { load() } }
    }

    val isAdmin: Boolean get() = deps.isAdmin()
    val today: String get() = deps.today()

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (installment == null) loading = true
        try {
            val found = deps.client.installment(id)
            installment = found
            val subscriptionId = found.subscriptionId
            if (subscriptionId != null && subscription == null) subscription = runCatching { deps.client.subscription(subscriptionId) }.getOrNull()
            val payerId = subscription?.payer?.id
            if (payerId != null) payer = runCatching { deps.client.payer(payerId) }.getOrNull() ?: payer
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            if (installment == null) notice = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    fun charge() = run("charge", "Cobrança enviada ao cliente") { deps.client.charge(id, it) }

    /** Baixa manual com a data "AAAA-MM-DD" (já conferida por [MensalidadeRules.paidDate]). */
    fun pay(note: String, paidAt: String?, notify: Boolean) {
        val text = note.trim().ifEmpty { null }
        run("pay", "Baixa registrada") { deps.client.pay(id, text, paidAt, notify, it) }
    }

    fun waive(note: String) {
        val text = note.trim().ifEmpty { null }
        run("waive", "Parcela isenta") { deps.client.waive(id, text, it) }
    }

    private fun run(action: String, success: String, block: suspend (String) -> Installment) {
        if (busy != null) return
        viewModelScope.launch { perform(action, success, block) }
    }

    /** A ação com a chave da intenção; uma recusa definitiva relê a parcela. */
    suspend fun perform(action: String, success: String, block: suspend (String) -> Installment) {
        if (busy != null) return
        val key = keys.key("$action:$id")
        busy = action
        notice = null
        try {
            installment = block(key)
            keys.settle(null)
            done = success
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            keys.settle(e)
            deps.onFailure(e)
            val retry = (e as? QueueException)?.retryable == true
            notice = MensalidadeRules.explain(e) + if (retry) ModuleFailure.RETRY_HINT else ""
            if (!retry) load()
        } finally {
            busy = null
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}

/** Uma assinatura: o pagador, as parcelas dela e pausar, retomar ou encerrar (administrador). */
class SubscriptionViewModel(val id: String, private val deps: MensalidadeDeps, container: AppContainer? = null) : ViewModel() {
    var subscription by mutableStateOf<Subscription?>(null)
        private set
    var payer by mutableStateOf<Payer?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)

    private val keys = IntentKeys()

    init {
        container?.let { observeModuleEvents(it, "mensalidade.") { load() } }
    }

    val isAdmin: Boolean get() = deps.isAdmin()

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (subscription == null) loading = true
        try {
            val found = deps.client.subscription(id)
            subscription = found
            found.payer?.id?.let { payerId -> payer = runCatching { deps.client.payer(payerId) }.getOrNull() ?: payer }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            if (subscription == null) notice = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    fun act(action: String) {
        if (busy != null) return
        viewModelScope.launch { perform(action) }
    }

    /** Pausar, retomar ou encerrar; a resposta não traz as parcelas, então a tela relê a assinatura. */
    suspend fun perform(action: String) {
        if (busy != null || action !in MensalidadeRules.SUBSCRIPTION_ACTIONS) return
        val key = keys.key("$action:$id")
        busy = action
        notice = null
        try {
            deps.client.subscriptionAction(id, action, key)
            keys.settle(null)
            load()
            done = when (action) {
                "pause" -> "Assinatura pausada"
                "resume" -> "Assinatura retomada"
                else -> "Assinatura encerrada"
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            keys.settle(e)
            deps.onFailure(e)
            val retry = (e as? QueueException)?.retryable == true
            notice = MensalidadeRules.explain(e) + if (retry) ModuleFailure.RETRY_HINT else ""
            if (!retry) load()
        } finally {
            busy = null
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}
