package br.com.queven.wabotia.modules.erp

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** As dependências das telas da Gestão (trocáveis nos testes). Na demonstração não há cópia em disco. */
class ErpDeps(
    val client: ErpClient,
    /** 401 volta ao login; `module_disabled` esconde a parte na hora. */
    val onFailure: (part: String, error: Throwable) -> Unit,
    val now: () -> Long = { System.currentTimeMillis() },
) {
    fun fail(part: String, error: Throwable): String {
        onFailure(part, error)
        return ErpText.message(error, part)
    }

    /** Mensagem de uma escrita: sem conexão nada é guardado para depois. */
    fun failWrite(part: String, error: Throwable): String {
        onFailure(part, error)
        return if (ErpText.isOffline(error)) ErpText.OFFLINE_WRITE + ModuleFailure.RETRY_HINT.takeIf { (error as? QueueException)?.retryable == true }.orEmpty()
        else ErpText.message(error, part)
    }

    companion object {
        fun of(container: AppContainer): ErpDeps {
            val profile = container.session.profileId.orEmpty()
            return ErpDeps(
                ErpClient(ProfileApi.current(container), if (container.isDemo) null else ErpCache.of(container.appContext), profile),
                { part, e -> ModuleFailure.handle(container, part, e) },
            )
        }
    }
}

private suspend fun <T> guarded(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Throwable) {
    Result.failure(e)
}

// ---------------------------------------------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------------------------------------------

class ErpCustomersViewModel(private val deps: ErpDeps) : ViewModel() {
    var query by mutableStateOf("")
        private set
    var items by mutableStateOf<List<ErpContactItem>>(emptyList())
        private set
    var total by mutableStateOf(0)
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var offlineAt by mutableStateOf<Long?>(null)
        private set
    private var page = 1
    private var job: Job? = null

    init { refresh() }

    fun search(text: String) {
        query = text
        job?.cancel()
        job = viewModelScope.launch {
            delay(350)
            load(1)
        }
    }

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch { load(1) }
    }

    fun loadMore() {
        if (loading || items.size >= total || offlineAt != null) return
        job = viewModelScope.launch { load(page + 1) }
    }

    private suspend fun load(next: Int) {
        loading = true
        guarded { deps.client.customers(query, next) }
            .onSuccess { read ->
                page = next
                items = if (next == 1) read.value.items else (items + read.value.items).distinctBy { it.id }
                total = read.value.total
                offlineAt = read.offlineAt
                error = null
            }
            .onFailure { error = deps.fail(ErpParts.CUSTOMERS, it) }
        loading = false
    }
}

class ErpCustomerViewModel(private val deps: ErpDeps, val id: String, private val access: ErpAccess?) : ViewModel() {
    var record by mutableStateOf<ErpContactRecord?>(null)
        private set
    var orders by mutableStateOf<List<ErpSaleHistoryItem>?>(null)
        private set
    var ordersNote by mutableStateOf<String?>(null)
        private set
    var bills by mutableStateOf<List<ErpTitle>?>(null)
        private set
    var billsNote by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var offlineAt by mutableStateOf<Long?>(null)
        private set

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            loading = true
            guarded { deps.client.customer(id) }
                .onSuccess { read ->
                    record = read.value.record
                    offlineAt = read.offlineAt
                    error = null
                }
                .onFailure { error = deps.fail(ErpParts.CUSTOMERS, it) }
            loading = false
            val customer = record ?: return@launch
            if (access?.customerOrders == true) {
                guarded { deps.client.customerOrders(id) }
                    .onSuccess { read ->
                        orders = read.value.items
                        ordersNote = if (!read.value.visible) "Os pedidos deste cliente não aparecem para o seu papel no ERP." else null
                        if (read.offlineAt != null) offlineAt = offlineAt ?: read.offlineAt
                    }
                    .onFailure { ordersNote = deps.fail(ErpParts.SALES, it) }
            }
            if (access?.customerBills == true) {
                guarded { deps.client.customerBills(id, customer.name) }
                    .onSuccess { read -> bills = read.value; billsNote = null }
                    .onFailure { billsNote = deps.fail(ErpParts.FINANCE, it) }
            }
        }
    }
}

class ErpNewCustomerViewModel(private val deps: ErpDeps) : ViewModel() {
    var name by mutableStateOf("")
    var personType by mutableStateOf("F")
    var document by mutableStateOf("")
    var mobile by mutableStateOf("")
    var email by mutableStateOf("")
    var saving by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    var created by mutableStateOf<ErpContactRecord?>(null)
        private set
    private val keys = IntentKeys()

    /** O corpo enviado; `null` com a mensagem do que falta. */
    fun body(key: String): Pair<ErpQuickContactRequest?, String?> {
        val n = name.trim()
        if (n.isEmpty()) return null to "Informe o nome do cliente."
        if (n.length > 200) return null to "O nome pode ter até 200 letras."
        val mail = email.trim()
        if (mail.isNotEmpty() && !Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(mail)) return null to "Confira o e-mail ou deixe em branco."
        val doc = document.filter { it.isLetterOrDigit() }.uppercase()
        if (doc.isNotEmpty() && personType == "F" && doc.length != 11) return null to "O CPF tem 11 números. Confira ou deixe em branco."
        if (doc.isNotEmpty() && personType == "J" && doc.length != 14) return null to "O CNPJ tem 14 caracteres. Confira ou deixe em branco."
        val phone = mobile.trim().takeIf { it.isNotEmpty() }
        if (phone != null && phone.count(Char::isDigit) < 10) return null to "Informe o celular com DDD."
        return ErpQuickContactRequest(
            ErpClient.commandId(key),
            ErpQuickContactData(name = n, personType = personType, document = doc.ifEmpty { null }, mobile = phone, email = mail.ifEmpty { null }),
        ) to null
    }

    fun save() {
        if (saving) return
        val signature = listOf(name, personType, document, mobile, email).joinToString("|")
        val key = keys.key(signature)
        val (request, problem) = body(key)
        if (request == null) {
            error = problem
            return
        }
        viewModelScope.launch {
            saving = true
            error = null
            guarded { deps.client.createCustomer(request, key) }
                .onSuccess { created = it.record; keys.settle(null) }
                .onFailure { keys.settle(it); error = deps.failWrite(ErpParts.CUSTOMERS, it) }
            saving = false
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Produtos e estoque
// ---------------------------------------------------------------------------------------------------------------

class ErpProductsViewModel(private val deps: ErpDeps) : ViewModel() {
    var query by mutableStateOf("")
        private set
    var items by mutableStateOf<List<ErpProduct>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var offlineAt by mutableStateOf<Long?>(null)
        private set
    /** O produto achado pelo código de barras, para a tela abrir a ficha. */
    var scanned by mutableStateOf<ErpProduct?>(null)
    private var job: Job? = null

    init { refresh() }

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

    /** Código lido pela câmera: busca e, achando exatamente um, abre a ficha. */
    fun scan(code: String?) {
        val value = ErpText.barcode(code)
        if (value == null) {
            notice = ErpText.NO_BARCODE
            return
        }
        query = value
        job?.cancel()
        job = viewModelScope.launch {
            load()
            val exact = ErpText.exactBarcode(items, value) ?: items.singleOrNull()
            if (exact != null) scanned = exact
            else if (error == null) notice = "Nenhum produto ativo com o código $value. Confira no painel se o GTIN está cadastrado."
        }
    }

    private suspend fun load() {
        loading = true
        guarded { deps.client.products(query) }
            .onSuccess { read -> items = read.value.items; offlineAt = read.offlineAt; error = null }
            .onFailure { error = deps.fail(ErpParts.PRODUCTS, it) }
        loading = false
    }
}

class ErpProductViewModel(private val deps: ErpDeps, val id: String, private val access: ErpAccess?) : ViewModel() {
    var product by mutableStateOf<ErpProduct?>(null)
        private set
    var balances by mutableStateOf<List<ErpStockBalance>?>(null)
        private set
    var stockNote by mutableStateOf<String?>(null)
        private set
    var photo by mutableStateOf<ByteArray?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var offlineAt by mutableStateOf<Long?>(null)
        private set
    var saving by mutableStateOf(false)
        private set
    var adjustError by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)
    private val keys = IntentKeys()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            loading = true
            guarded { deps.client.product(id) }
                .onSuccess { read -> product = read.value.record; offlineAt = read.offlineAt; error = null }
                .onFailure { error = deps.fail(ErpParts.PRODUCTS, it) }
            loading = false
            if (product == null) return@launch
            if (access?.stock == true) loadStock()
            if (photo == null && offlineAt == null) {
                guarded {
                    deps.client.productImages(id).items.filter { it.status == "ready" }.minByOrNull { it.position ?: Int.MAX_VALUE }
                        ?.let { deps.client.productImage(id, it.id) }
                }.onSuccess { photo = it }
            }
        }
    }

    private suspend fun loadStock() {
        guarded { deps.client.stock(id) }
            .onSuccess { read -> balances = read.value.items.filter { it.warehouseActive || it.quantity.toBigDecimalOrNull()?.signum() != 0 }; stockNote = null; if (read.offlineAt != null) offlineAt = offlineAt ?: read.offlineAt }
            .onFailure { stockNote = deps.fail(ErpParts.STOCK, it) }
    }

    /** O corpo do ajuste; `null` com a mensagem do que falta. */
    fun adjustBody(key: String, direction: ErpStockDirection, balance: ErpStockBalance, quantityText: String, reason: String): Pair<ErpStockMovementRequest?, String?> {
        val quantity = ErpNumbers.quantity(quantityText) ?: return null to "Informe a quantidade, maior que zero (até 6 casas decimais)."
        val why = reason.trim()
        if (why.length < 3) return null to "Diga o motivo do ajuste (pelo menos 3 letras), por exemplo \"Contagem\" ou \"Avaria\"."
        if (why.length > 500) return null to "O motivo pode ter até 500 letras."
        if (balance.virtual) return null to "Este depósito mostra saldo virtual de composição: ajuste os componentes pelo painel."
        val signed = if (direction == ErpStockDirection.OUT) "-$quantity" else quantity
        return ErpStockMovementRequest(
            commandId = ErpClient.commandId(key),
            kind = direction.kind,
            occurredOn = BrasiliaTime.today(deps.now()),
            reason = why,
            items = listOf(ErpStockLine(id, balance.warehouseId, signed, balance.version)),
        ) to null
    }

    fun adjust(direction: ErpStockDirection, balance: ErpStockBalance, quantityText: String, reason: String, onDone: () -> Unit) {
        if (saving) return
        if (offlineAt != null) {
            adjustError = ErpText.OFFLINE_WRITE
            return
        }
        val key = keys.key(listOf(direction.kind, balance.warehouseId, balance.version, quantityText, reason).joinToString("|"))
        val (body, problem) = adjustBody(key, direction, balance, quantityText, reason)
        if (body == null) {
            adjustError = problem
            return
        }
        viewModelScope.launch {
            saving = true
            adjustError = null
            guarded { deps.client.moveStock(body, key) }
                .onSuccess {
                    keys.settle(null)
                    done = "${direction.label} lançada em ${balance.warehouseName}."
                    onDone()
                    loadStock()
                }
                .onFailure {
                    keys.settle(it)
                    adjustError = deps.failWrite(ErpParts.STOCK, it)
                    // Versão velha: relê o saldo para a próxima tentativa sair certa.
                    if ((it as? QueueException)?.status == 409) loadStock()
                }
            saving = false
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Pedido rápido
// ---------------------------------------------------------------------------------------------------------------

class ErpQuickOrderViewModel(private val deps: ErpDeps) : ViewModel() {
    var customer by mutableStateOf<ErpContactItem?>(null)
    var customerQuery by mutableStateOf("")
        private set
    var customerResults by mutableStateOf<List<ErpContactItem>>(emptyList())
        private set
    var productQuery by mutableStateOf("")
        private set
    var productResults by mutableStateOf<List<ErpProduct>>(emptyList())
        private set
    var searching by mutableStateOf(false)
        private set
    var lines by mutableStateOf<List<ErpCartLine>>(emptyList())
        private set
    var discountText by mutableStateOf("")
    var discountPercent by mutableStateOf(false)
    var methods by mutableStateOf<List<ErpPaymentMethod>>(emptyList())
        private set
    var methodId by mutableStateOf<String?>(null)
    var methodsNote by mutableStateOf<String?>(null)
        private set
    var saving by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var saved by mutableStateOf<ErpSavedDocument?>(null)
        private set
    var savedTotal by mutableStateOf(0L)
        private set
    var preview by mutableStateOf<ErpSendPreview?>(null)
        private set
    var sending by mutableStateOf(false)
        private set
    var sent by mutableStateOf<String?>(null)
        private set
    private val keys = IntentKeys()
    private val sendKeys = IntentKeys()
    private var customerJob: Job? = null
    private var productJob: Job? = null

    init {
        viewModelScope.launch {
            guarded { deps.client.paymentOptions() }
                .onSuccess { read ->
                    methods = read.value.methods
                    methodId = methodId ?: (read.value.methods.firstOrNull { it.isDefault } ?: read.value.methods.firstOrNull())?.id
                    methodsNote = if (read.value.methods.isEmpty()) "Nenhuma forma de pagamento cadastrada. O pedido sai sem parcela; cadastre as formas no painel." else null
                }
                .onFailure { methodsNote = deps.fail(ErpParts.SALES, it) }
        }
    }

    fun searchCustomer(text: String) {
        customerQuery = text
        customerJob?.cancel()
        if (text.trim().length < 2) {
            customerResults = emptyList()
            return
        }
        customerJob = viewModelScope.launch {
            delay(350)
            searching = true
            guarded { deps.client.customers(text) }
                .onSuccess { customerResults = it.value.items.take(20) }
                .onFailure { error = deps.fail(ErpParts.CUSTOMERS, it) }
            searching = false
        }
    }

    fun chooseCustomer(item: ErpContactItem) {
        customer = item
        customerQuery = ""
        customerResults = emptyList()
    }

    fun searchProduct(text: String) {
        productQuery = text
        productJob?.cancel()
        if (text.trim().length < 2) {
            productResults = emptyList()
            return
        }
        productJob = viewModelScope.launch {
            delay(350)
            searching = true
            guarded { deps.client.products(text) }
                .onSuccess { productResults = it.value.items.take(20) }
                .onFailure { error = deps.fail(ErpParts.PRODUCTS, it) }
            searching = false
        }
    }

    /** Código lido pela câmera: o produto exato entra no pedido (ou soma 1 se já estiver). */
    fun scan(code: String?) {
        val value = ErpText.barcode(code)
        if (value == null) {
            notice = ErpText.NO_BARCODE
            return
        }
        productJob?.cancel()
        productJob = viewModelScope.launch {
            searching = true
            guarded { deps.client.products(value) }
                .onSuccess { read ->
                    val exact = ErpText.exactBarcode(read.value.items, value) ?: read.value.items.singleOrNull()
                    if (exact != null) add(exact) else notice = "Nenhum produto ativo com o código $value."
                }
                .onFailure { error = deps.fail(ErpParts.PRODUCTS, it) }
            searching = false
        }
    }

    fun add(product: ErpProduct) {
        if (ErpNumbers.unitPrice(product.price) == null) {
            notice = "\"${product.name}\" está sem preço no cadastro. Coloque o preço no painel antes de vender pelo aplicativo."
            return
        }
        val existing = lines.firstOrNull { it.product.id == product.id }
        lines = if (existing != null) {
            val next = (existing.quantity.toBigDecimal() + java.math.BigDecimal.ONE).stripTrailingZeros().toPlainString()
            lines.map { if (it.product.id == product.id) it.copy(quantity = next) else it }
        } else lines + ErpCartLine(product, "1")
        productQuery = ""
        productResults = emptyList()
    }

    fun setQuantity(productId: String, text: String): Boolean {
        val q = ErpNumbers.quantity(text) ?: return false
        lines = lines.map { if (it.product.id == productId) it.copy(quantity = q) else it }
        return true
    }

    fun remove(productId: String) {
        lines = lines.filterNot { it.product.id == productId }
    }

    val discountValue: String? get() = ErpNumbers.discountValue(discountText, discountPercent)

    val totals: ErpOrderTotals? get() = discountValue?.let { ErpOrderTotals.of(lines, it, discountPercent) }

    /** O corpo do pedido; `null` com a mensagem do que falta. */
    fun body(key: String): Pair<ErpOrderRequest?, String?> {
        val c = customer ?: return null to "Escolha o cliente do pedido."
        if (lines.isEmpty()) return null to "Inclua pelo menos um produto."
        val discount = discountValue ?: return null to if (discountPercent) "O desconto em % vai de 0 a 100." else "Confira o valor do desconto."
        val t = ErpOrderTotals.of(lines, discount, discountPercent) ?: return null to "Algum produto está sem preço no cadastro."
        if (!t.valid) return null to "O desconto é maior que o valor dos produtos."
        val today = BrasiliaTime.today(deps.now())
        val method = methods.firstOrNull { it.id == methodId }
        val installments = if (method != null && t.total > 0) listOf(ErpInstallmentBody(today, ErpNumbers.centsText(t.total), method.description.take(100).ifBlank { null }, method.id)) else emptyList()
        val items = lines.map { line ->
            val p = line.product
            ErpOrderItemBody(p.id, p.name.take(200), p.code?.take(100)?.ifBlank { null }, p.unitText.take(16), line.quantity, ErpNumbers.unitPrice(p.price)!!)
        }
        return ErpOrderRequest(ErpClient.commandId(key), ErpOrderData(today, c.id, items, if (discountPercent) "percent" else "amount", discount, installments)) to null
    }

    fun save() {
        if (saving || saved != null) return
        val signature = listOf(customer?.id, lines.joinToString { "${it.product.id}:${it.quantity}" }, discountText, discountPercent, methodId).joinToString("|")
        val key = keys.key(signature)
        val (request, problem) = body(key)
        if (request == null) {
            error = problem
            return
        }
        viewModelScope.launch {
            saving = true
            error = null
            guarded { deps.client.createOrder(request, key) }
                .onSuccess {
                    keys.settle(null)
                    saved = it.document
                    savedTotal = totals?.total ?: 0L
                    loadPreview(it.document.id)
                }
                .onFailure { keys.settle(it); error = deps.failWrite(ErpParts.SALES, it) }
            saving = false
        }
    }

    private suspend fun loadPreview(orderId: String) {
        // Sem a rota (servidor antigo), sem linha de WhatsApp ou sem conversas no acesso: o botão não aparece.
        guarded { deps.client.sendPreview(orderId) }.onSuccess { preview = it }
    }

    fun send() {
        val order = saved ?: return
        val dest = preview?.destino ?: return
        if (sending || sent != null) return
        val key = sendKeys.key("${order.id}|${dest.digitos}|${dest.linha}")
        viewModelScope.launch {
            sending = true
            error = null
            guarded { deps.client.sendOrder(order.id, ErpSendRequest(dest.digitos, dest.linha), key) }
                .onSuccess { sendKeys.settle(null); sent = "Pedido enviado pelo WhatsApp para ${dest.telefone.ifBlank { dest.digitos }}." }
                .onFailure { sendKeys.settle(it); error = deps.failWrite(ErpParts.SALES, it) }
            sending = false
        }
    }

    /** Começar outro pedido do zero. */
    fun reset() {
        customer = null
        lines = emptyList()
        discountText = ""
        discountPercent = false
        saved = null
        preview = null
        sent = null
        error = null
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------------------------------------------

class ErpBillsViewModel(private val deps: ErpDeps) : ViewModel() {
    enum class Filter(val label: String) { TODAY("Vencem hoje"), OVERDUE("Vencidas") }

    var kind by mutableStateOf("receivable")
        private set
    var filter by mutableStateOf(Filter.TODAY)
        private set
    var items by mutableStateOf<List<ErpTitle>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var offlineAt by mutableStateOf<Long?>(null)
        private set
    var accounts by mutableStateOf<List<ErpAccount>>(emptyList())
        private set
    var saving by mutableStateOf(false)
        private set
    var settleError by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)
    private val keys = IntentKeys()
    private var job: Job? = null

    init { refresh() }

    fun select(kind: String = this.kind, filter: Filter = this.filter) {
        if (kind == this.kind && filter == this.filter) return
        this.kind = kind
        this.filter = filter
        items = emptyList()
        refresh()
    }

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch {
            loading = true
            val today = BrasiliaTime.today(deps.now())
            guarded {
                if (filter == Filter.TODAY) deps.client.titles(kind, "open", today, today) else deps.client.titles(kind, "overdue")
            }
                .onSuccess { read -> items = read.value.items.filter { it.isOpen }; offlineAt = read.offlineAt; error = null }
                .onFailure { error = deps.fail(ErpParts.FINANCE, it) }
            loading = false
        }
    }

    fun loadAccounts() {
        if (accounts.isNotEmpty()) return
        viewModelScope.launch {
            guarded { deps.client.accounts() }
                .onSuccess { read -> accounts = read.value.items.filter { it.active } }
                .onFailure { settleError = deps.fail(ErpParts.FINANCE, it) }
        }
    }

    /** O corpo da baixa do saldo inteiro, hoje; `null` com a mensagem do que falta. */
    fun settleBody(key: String, title: ErpTitle, accountId: String?): Pair<ErpSettleRequest?, String?> {
        if (accountId.isNullOrBlank()) return null to "Escolha a conta onde o dinheiro entrou ou saiu."
        if (title.balance <= 0) return null to "Esta conta não tem saldo em aberto."
        return ErpSettleRequest(
            ErpClient.commandId(key),
            ErpSettleData(title.id, title.version, accountId, BrasiliaTime.today(deps.now()), title.balance.toString()),
        ) to null
    }

    fun settle(title: ErpTitle, accountId: String?, onDone: () -> Unit) {
        if (saving) return
        if (offlineAt != null) {
            settleError = ErpText.OFFLINE_WRITE
            return
        }
        val key = keys.key("${title.id}|${title.version}|$accountId")
        val (body, problem) = settleBody(key, title, accountId)
        if (body == null) {
            settleError = problem
            return
        }
        viewModelScope.launch {
            saving = true
            settleError = null
            guarded { deps.client.settle(body, key) }
                .onSuccess {
                    keys.settle(null)
                    done = if (title.kind == "payable") "Conta paga: baixa registrada." else "Recebimento registrado: baixa feita."
                    onDone()
                    refresh()
                }
                .onFailure {
                    keys.settle(it)
                    settleError = deps.failWrite(ErpParts.FINANCE, it)
                    if ((it as? QueueException)?.status == 409) refresh()
                }
            saving = false
        }
    }
}
