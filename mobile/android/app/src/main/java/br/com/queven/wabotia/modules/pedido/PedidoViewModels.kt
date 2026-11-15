package br.com.queven.wabotia.modules.pedido

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.printing.PedidoPrinter
import br.com.queven.wabotia.printing.TicketPrint
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** As dependências das telas do Pedido (trocáveis nos testes). */
class PedidoDeps(
    val client: PedidoClient,
    val onFailure: (Throwable) -> Unit,
    val printer: PedidoPrinter? = null,
) {
    companion object {
        fun of(container: AppContainer) = PedidoDeps(
            PedidoClient(ProfileApi.current(container)),
            { ModuleFailure.handle(container, ModuleIds.PEDIDO, it) },
            PedidoPrinter(container.thermalPrinter) { container.printerReady() },
        )
    }
}

/**
 * Pedidos (Ajustes → Atendimento): o quadro da cozinha por estado, a lista com filtro e busca e o cardápio com os
 * interruptores de esgotado, sempre com a faixa da loja (aberta, fechada pelo horário ou pausada com a mensagem). Os
 * eventos `pedido.*` recarregam; o quadro também relê a cada minuto, para o tempo no estado e o atraso andarem sozinhos.
 */
class PedidoViewModel(private val deps: PedidoDeps, container: AppContainer? = null, initialMode: Mode = Mode.BOARD) : ViewModel() {
    enum class Mode(val label: String) { BOARD("Quadro"), LIST("Pedidos"), MENU("Cardápio") }

    var mode by mutableStateOf(initialMode)
        private set
    var board by mutableStateOf<PedidoBoard?>(null)
        private set
    var orders by mutableStateOf<List<PedidoOrder>>(emptyList())
        private set
    var page by mutableStateOf<PedidoPage?>(null)
        private set
    var menu by mutableStateOf<PedidoMenu?>(null)
        private set
    var filter by mutableStateOf("open")
        private set
    var query by mutableStateOf("")
        private set
    var loading by mutableStateOf(true)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)
    /** Interruptores com a troca em andamento (`item:<id>`, `option:<grupo>:<opção>`) e a pausa da loja (`pause`). */
    var busy by mutableStateOf<Set<String>>(emptySet())
        private set

    /** Uma chave por interruptor: trocas de itens diferentes andam juntas. */
    private val keys = HashMap<String, IntentKeys>()
    private var job: Job? = null
    private var generation = 0

    init {
        container?.let { observeModuleEvents(it, "pedido.") { load() } }
    }

    val store: PedidoStore? get() = board?.store

    fun count(filter: String): Int? {
        val p = page ?: return null
        return when (filter) {
            "all" -> null
            "open" -> PedidoRules.openCount(p)
            else -> p.count(filter)
        }
    }

    /** O `Job` devolvido serve aos testes para esperar a leitura. */
    fun refresh(): Job {
        job?.cancel()
        return viewModelScope.launch { load() }.also { job = it }
    }

    fun changeMode(value: Mode): Job? {
        if (mode == value) return null
        mode = value
        error = null
        return refresh()
    }

    fun changeFilter(value: String): Job? {
        if (filter == value) return null
        filter = value
        orders = emptyList()
        return refresh()
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

    private val empty: Boolean
        get() = when (mode) {
            Mode.BOARD -> board == null
            Mode.LIST -> orders.isEmpty()
            Mode.MENU -> menu == null
        }

    suspend fun load() {
        val mine = ++generation
        if (empty) loading = true
        try {
            when (mode) {
                Mode.BOARD -> deps.client.board().let { if (mine == generation) board = it }
                Mode.LIST -> fetch(null).let { if (mine == generation) { page = it; orders = it.data } }
                Mode.MENU -> {
                    val found = deps.client.menu()
                    if (mine == generation) menu = found
                    // A faixa da loja (pausa) fica visível em todas as visões.
                    if (board == null) board = runCatching { deps.client.board() }.getOrNull()
                }
            }
            if (mine == generation) error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            if (mine == generation) error = ModuleFailure.message(e)
        } finally {
            if (mine == generation) loading = false
        }
    }

    fun loadMore() {
        val cursor = page?.nextCursor ?: return
        if (loadingMore) return
        loadingMore = true
        viewModelScope.launch {
            try {
                val more = fetch(cursor)
                val known = orders.map { it.id }.toSet()
                orders = orders + more.data.filter { it.id !in known }
                page = page?.copy(nextCursor = more.nextCursor)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            } finally {
                loadingMore = false
            }
        }
    }

    private suspend fun fetch(cursor: String?): PedidoPage {
        val statuses = if (filter == "open" || filter == "all") emptyList() else listOf(filter)
        return deps.client.list(statuses, open = filter == "open", query = query, cursor = cursor)
    }

    // --- Loja e cardápio ---

    /** "Loja fechada agora" e a volta; qualquer pessoa da equipe pode. */
    fun setPaused(paused: Boolean, message: String = ""): Job? {
        val text = message.trim()
        return write("pause", "pause:$paused:$text", if (paused) "Loja pausada" else "Loja recebendo pedidos de novo") { key ->
            val store = deps.client.pause(paused, if (paused) text.ifEmpty { null } else null, key)
            board = (board ?: PedidoBoard()).copy(store = store)
        }
    }

    fun setItem(item: PedidoMenuItem, available: Boolean): Job? {
        val tag = "item:${item.id}"
        markAvailable(item.id, null, available)
        val name = item.name ?: "Item"
        return write(tag, "$tag:$available", if (available) "$name disponível" else "$name esgotado") { key ->
            deps.client.setItemAvailable(item.id, available, key)
        }
    }

    fun setOption(group: PedidoMenuGroup, option: PedidoMenuOption, available: Boolean): Job? {
        val tag = "option:${group.id}:${option.id}"
        markAvailable(null, group.id to option.id, available)
        val name = option.name ?: "Opção"
        return write(tag, "$tag:$available", if (available) "$name disponível" else "$name esgotada") { key ->
            deps.client.setOptionAvailable(group.id, option.id, available, key)
        }
    }

    /** Mostra a troca na hora; a leitura depois da resposta (ou da recusa) corrige. */
    private fun markAvailable(item: String?, option: Pair<String, String>?, available: Boolean) {
        val current = menu ?: return
        menu = current.copy(
            categories = current.categories.map { c -> c.copy(items = c.items.map { if (it.id == item) it.copy(available = available) else it }) },
            groups = current.groups.map { g ->
                if (option == null || g.id != option.first) g else g.copy(options = g.options.map { if (it.id == option.second) it.copy(available = available) else it })
            },
        )
    }

    private fun write(tag: String, signature: String, success: String, block: suspend (String) -> Unit): Job? {
        if (tag in busy) return null
        val intent = keys.getOrPut(tag) { IntentKeys() }
        val key = intent.key(signature)
        busy = busy + tag
        notice = null
        return viewModelScope.launch {
            try {
                block(key)
                intent.settle(null)
                done = success
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                intent.settle(e)
                deps.onFailure(e)
                notice = ModuleFailure.actionMessage(e)
            } finally {
                busy = busy - tag
            }
            load()
        }
    }

    fun pendingKey(tag: String): String? = keys[tag]?.pendingKey
}

/**
 * Detalhe do pedido: mudar o estado (cancelar com motivo ao cliente), registrar o pagamento na hora, escolher a forma
 * de pagamento pela equipe e imprimir a comanda montada pelo servidor.
 */
class PedidoOrderViewModel(val id: String, private val deps: PedidoDeps, container: AppContainer? = null) : ViewModel() {
    var order by mutableStateOf<PedidoOrder?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)
    var print by mutableStateOf<TicketPrint?>(null)
        private set

    private val keys = IntentKeys()

    init {
        container?.let { observeModuleEvents(it, "pedido.") { load() } }
    }

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (order == null) loading = true
        try {
            order = deps.client.order(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            if (order == null) notice = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    /** Um dos `next_statuses`; no cancelamento, `reason` vai ao cliente. */
    fun perform(status: String, note: String?, reason: String?, notify: Boolean): Job? {
        val n = note?.trim()?.ifEmpty { null }
        val r = reason?.trim()?.ifEmpty { null }
        val success = if (status == "cancelled") "Pedido cancelado" else "Pedido: ${PedidoRules.statusLabel(status)}"
        return run("status:$status", success) { deps.client.setStatus(id, status, n, r, notify, it) }
    }

    fun markPaid(note: String? = null): Job? {
        val n = note?.trim()?.ifEmpty { null }
        return run("paid", "Pagamento registrado") { deps.client.markPaid(id, n, it) }
    }

    fun setMethod(method: String): Job? = run("method:$method", "Forma de pagamento definida") { deps.client.setMethod(id, method, it) }

    /** As três larguras da comanda, para o cupom escolher a que cabe na impressora deste aparelho. */
    suspend fun tickets(): Map<Int, String> = coroutineScope {
        PedidoRules.TICKET_COLUMNS.map { columns -> async { columns to deps.client.ticket(id, columns).text } }
            .awaitAll()
            .mapNotNull { (columns, text) -> text?.takeIf { it.isNotBlank() }?.let { columns to it } }
            .toMap()
    }

    /**
     * Comanda na impressora escolhida. Sem impressora, nem busca o texto. Falha incerta (a impressora aceitou e não
     * confirmou) só imprime de novo com [confirmed], para não sair a comanda duas vezes na cozinha.
     */
    fun printTicket(confirmed: Boolean = false): Job? {
        val printer = deps.printer ?: return null
        val current = print
        if (current == TicketPrint.Printing) return null
        if (current is TicketPrint.Failed && current.reprintNeedsConfirmation && !confirmed) return null
        print = TicketPrint.Printing
        return viewModelScope.launch {
            print = try {
                if (!printer.hasPrinter()) TicketPrint.NoPrinter else printer.print(tickets())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                deps.onFailure(e)
                TicketPrint.Failed(ModuleFailure.message(e), reprintNeedsConfirmation = false)
            }
        }
    }

    fun clearPrint() {
        print = null
    }

    private fun run(action: String, success: String, block: suspend (String) -> PedidoOrder): Job? {
        if (busy != null) return null
        val key = keys.key("$action:$id")
        busy = action
        notice = null
        return viewModelScope.launch {
            try {
                val updated = block(key)
                keys.settle(null)
                order = if (updated.history == null) updated.copy(history = order?.history) else updated
                done = success
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                deps.onFailure(e)
                val retry = (e as? QueueException)?.retryable == true
                notice = message(e) + if (retry) ModuleFailure.RETRY_HINT else ""
                if (!retry) load()
            } finally {
                busy = null
            }
        }
    }

    private fun message(e: Throwable): String = when ((e as? QueueException)?.code) {
        "invalid_transition" -> "Esta mudança não vale para o pedido agora. A tela foi atualizada."
        "payment_online" -> "Há uma cobrança online aberta: o pagamento é confirmado pelo Mercado Pago."
        "already_paid" -> "O pedido já está pago."
        "payment_chosen" -> "O cliente já escolheu a forma de pagamento."
        "order_closed" -> "O pedido foi cancelado. A tela foi atualizada."
        "pedido_conflict" -> "O pedido mudou enquanto isso. A tela foi atualizada; confira e tente de novo."
        else -> ModuleFailure.message(e)
    }

    val pendingKey: String? get() = keys.pendingKey
}
