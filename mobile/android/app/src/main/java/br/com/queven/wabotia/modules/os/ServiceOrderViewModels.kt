package br.com.queven.wabotia.modules.os

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.AreaPerson
import br.com.queven.wabotia.modules.Establishment
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.printing.ServiceOrderPrinter
import br.com.queven.wabotia.printing.ServiceOrderReceiptData
import br.com.queven.wabotia.printing.TicketPrint
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** As dependências das telas da Ordem de Serviço (trocáveis nos testes). */
class ServiceOrderDeps(
    val client: ServiceOrderClient,
    val onFailure: (Throwable) -> Unit,
    val printer: ServiceOrderPrinter? = null,
    /** Nome da área, para o comprovante quando o servidor não tem a rota do estabelecimento. */
    val areaName: () -> String = { "" },
) {
    companion object {
        fun of(container: AppContainer) = ServiceOrderDeps(
            ServiceOrderClient(ProfileApi.current(container)),
            { ModuleFailure.handle(container, ModuleIds.SERVICE_ORDERS, it) },
            ServiceOrderPrinter(container.thermalPrinter) { container.printerReady() },
        )
    }
}

/** Lista de ordens com filtro por estado (padrão: abertas) e busca por item, cliente, problema, número ou telefone. */
class ServiceOrdersViewModel(private val deps: ServiceOrderDeps, container: AppContainer? = null) : ViewModel() {
    var filter by mutableStateOf("open")
        private set
    var query by mutableStateOf("")
        private set
    var orders by mutableStateOf<List<ServiceOrder>>(emptyList())
        private set
    var page by mutableStateOf<ServiceOrderPage?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var job: Job? = null

    init {
        container?.let { observeModuleEvents(it, "os.") { load() } }
    }

    fun count(filter: String): Int? {
        val p = page ?: return null
        return when (filter) {
            "all" -> null
            "open" -> ServiceOrderRules.openCount(p)
            else -> p.count(filter)
        }
    }

    fun changeFilter(value: String) {
        if (filter == value) return
        filter = value
        orders = emptyList()
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

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (orders.isEmpty()) loading = true
        try {
            val result = fetch(null)
            page = result
            orders = result.data
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

    private suspend fun fetch(cursor: String?): ServiceOrderPage {
        val statuses = if (filter == "open" || filter == "all") emptyList() else listOf(filter)
        return deps.client.list(statuses, open = filter == "open", query = query, cursor = cursor)
    }
}

/** Detalhe da ordem: mudar estado, montar e enviar orçamento, resposta do cliente no balcão, entrega e comprovante. */
class ServiceOrderViewModel(val id: String, private val deps: ServiceOrderDeps, container: AppContainer? = null) : ViewModel() {
    var order by mutableStateOf<ServiceOrder?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)
    /** Pessoas da área, para o responsável (servidor sem `GET /people`: lista vazia e o campo some). */
    var people by mutableStateOf<List<AreaPerson>>(emptyList())
        private set
    var print by mutableStateOf<TicketPrint?>(null)
        private set

    private val keys = IntentKeys()
    private var establishment: Establishment? = null

    init {
        container?.let { observeModuleEvents(it, "os.") { load() } }
    }

    /** Nome do responsável pela lista de pessoas (o `id` quando a pessoa saiu da área). */
    val assigneeName: String?
        get() {
            val id = order?.assignee?.takeIf { it.isNotEmpty() } ?: return null
            return people.firstOrNull { it.id == id }?.displayName ?: id
        }

    fun refresh() {
        viewModelScope.launch {
            load()
            if (people.isEmpty()) people = runCatching { deps.client.api.people() }.getOrDefault(emptyList())
        }
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

    /** Um dos `next_statuses`: `quoted` envia o orçamento, `approved`/`declined` registram a resposta do cliente. */
    fun perform(status: String, note: String? = null, notify: Boolean = true) {
        val text = note?.trim()?.ifEmpty { null }
        when (status) {
            "quoted" -> run("quote/send:$notify", if (notify) "Orçamento enviado ao cliente" else "Envio do orçamento registrado") { deps.client.sendQuote(id, notify, it) }
            "approved", "declined" -> {
                val approve = status == "approved"
                run("decision:$status", if (approve) "Aprovação registrada" else "Recusa registrada") { deps.client.decide(id, approve, it) }
            }
            else -> run("status:$status", if (status == "delivered") "Entrega registrada" else "Ordem: ${ServiceOrderRules.statusLabel(status)}") {
                deps.client.setStatus(id, status, text, it)
            }
        }
    }

    fun assign(personId: String?) =
        run("assign:${personId ?: "-"}", if (personId == null) "Responsável retirado" else "Responsável alterado") { deps.client.assign(id, personId, it) }

    fun saveQuote(items: List<QuoteItem>, validDays: Int?, note: String, thenSend: Boolean) {
        val trimmed = note.trim()
        val signature = "quote:" + items.joinToString("|") { "${it.description}#${it.quantity}#${it.unitCents}" } + ":${validDays ?: 0}:$trimmed"
        run(signature, if (thenSend) "Orçamento enviado ao cliente" else "Orçamento salvo") { key ->
            val saved = deps.client.saveQuote(id, items, validDays, trimmed.ifEmpty { null }, key)
            if (!thenSend) return@run saved
            keys.settle(null)
            deps.client.sendQuote(id, true, keys.key("quote/send:${saved.quote?.version ?: 0}"))
        }
    }

    /** Comprovante na impressora escolhida, com o cabeçalho do estabelecimento (lido uma vez). */
    fun printReceipt() {
        val current = order ?: return
        val printer = deps.printer ?: return
        if (print == TicketPrint.Printing) return
        print = TicketPrint.Printing
        viewModelScope.launch {
            if (establishment == null) establishment = runCatching { deps.client.api.establishment() }.getOrNull()
            print = printer.print(ServiceOrderReceiptData.of(current, deps.areaName(), establishment))
        }
    }

    fun clearPrint() {
        print = null
    }

    private fun run(action: String, success: String, block: suspend (String) -> ServiceOrder) {
        if (busy != null) return
        val key = keys.key("$action:$id")
        busy = action
        notice = null
        viewModelScope.launch {
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
                notice = message(e)
                if ((e as? QueueException)?.retryable != true) load()
            } finally {
                busy = null
            }
        }
    }

    private fun message(e: Throwable): String = when ((e as? QueueException)?.code) {
        "quote_expired" -> "O orçamento venceu e não pode mais ser aprovado. Envie de novo."
        "quote_not_pending" -> "O orçamento não está esperando resposta. A tela foi atualizada."
        "no_conversation" -> "Esta ordem não está ligada a uma conversa: registre o envio sem avisar pelo WhatsApp."
        "invalid_transition" -> "Esta mudança não vale para a ordem agora. A tela foi atualizada."
        else -> ModuleFailure.actionMessage(e)
    }

    val pendingKey: String? get() = keys.pendingKey
}

/** Abrir ordem: pela conversa (o cliente é avisado no WhatsApp) ou no balcão, com o telefone. */
class NewServiceOrderViewModel(val conversationId: String?, val customerLabel: String?, private val deps: ServiceOrderDeps) : ViewModel() {
    var item by mutableStateOf("")
    var problem by mutableStateOf("")
    var phone by mutableStateOf("")
    var customerName by mutableStateOf("")
    var notes by mutableStateOf("")
    /** Previsão em dias a partir de hoje; `null`: sem previsão. */
    var dueDays by mutableStateOf<Int?>(null)
    /** Responsável (`id` de `GET /people`); `null`: sem responsável. */
    var assignee by mutableStateOf<String?>(null)
    var people by mutableStateOf<List<AreaPerson>>(emptyList())
        private set
    var busy by mutableStateOf(false)
        private set
    var notice by mutableStateOf<String?>(null)
    var result by mutableStateOf<ServiceOrder?>(null)
        private set

    private val keys = IntentKeys()

    fun loadPeople() {
        if (people.isNotEmpty()) return
        viewModelScope.launch { people = runCatching { deps.client.api.people() }.getOrDefault(emptyList()) }
    }

    val canSubmit: Boolean
        get() = item.isNotBlank() && problem.isNotBlank() && !busy && (conversationId != null || phone.filter(Char::isDigit).length >= 10)

    fun submit() {
        if (canSubmit) viewModelScope.launch { create() }
    }

    suspend fun create(now: Long = System.currentTimeMillis()) {
        if (!canSubmit) return
        busy = true
        notice = null
        val item = item.trim()
        val problem = problem.trim()
        val digits = phone.filter(Char::isDigit)
        val key = keys.key("open:${conversationId ?: digits}:$item:$problem")
        try {
            result = deps.client.create(
                item, problem, conversationId,
                phone = if (conversationId == null) digits else null,
                customerName = customerName.trim().ifEmpty { null },
                notes = notes.trim().ifEmpty { null },
                dueAt = dueDays?.let { now + it * 86_400_000L },
                assignee = assignee,
                key = key,
            )
            keys.settle(null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            keys.settle(e)
            deps.onFailure(e)
            notice = ModuleFailure.actionMessage(e)
        } finally {
            busy = false
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}

/** O orçamento sendo montado: linhas editáveis com descrição, quantidade e valor digitado em reais. */
data class QuoteDraft(val lines: List<Line>, val validDays: String, val note: String) {
    data class Line(val key: Long = nextKey(), val description: String = "", val quantity: Int = 1, val value: String = "")

    /** Os itens válidos, ou a mensagem do primeiro problema. */
    fun items(): Result<List<QuoteItem>> {
        val out = mutableListOf<QuoteItem>()
        lines.forEachIndexed { index, line ->
            val description = line.description.trim()
            if (description.isEmpty() && line.value.isBlank()) return@forEachIndexed
            if (description.isEmpty()) return Result.failure(IllegalArgumentException("Descreva o item ${index + 1}."))
            if (line.quantity !in 1..999) return Result.failure(IllegalArgumentException("Quantidade do item ${index + 1} de 1 a 999."))
            val cents = Money.parse(line.value) ?: return Result.failure(IllegalArgumentException("Valor do item ${index + 1} inválido. Use, por exemplo, 45,90."))
            out += QuoteItem(description, line.quantity, cents)
        }
        return if (out.isEmpty()) Result.failure(IllegalArgumentException("Inclua pelo menos um item no orçamento.")) else Result.success(out)
    }

    val days: Int? get() = validDays.trim().toIntOrNull()?.takeIf { it in 1..90 }

    val total: Long get() = items().getOrNull()?.sumOf { it.totalCents } ?: 0

    companion object {
        private var seq = 0L
        private fun nextKey() = ++seq

        fun of(order: ServiceOrder?, defaultDays: Int = 7): QuoteDraft {
            val items = order?.quote?.items.orEmpty()
            return QuoteDraft(
                lines = if (items.isEmpty()) listOf(Line()) else items.map { Line(description = it.description, quantity = it.quantity, value = Money.format(it.unitCents).removePrefix("R$ ")) },
                validDays = (order?.quote?.validDays ?: defaultDays).toString(),
                note = order?.quote?.note.orEmpty(),
            )
        }
    }
}
