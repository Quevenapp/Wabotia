package br.com.queven.wabotia.modules.caixa

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.Links
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.FilterRow
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.service.WebPanel
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

class CaixaViewModel(private val container: AppContainer) : ViewModel() {
    private val client = CaixaClient(ProfileApi.current(container))

    var loading by mutableStateOf(true); private set
    var error by mutableStateOf<String?>(null); private set
    var accounts by mutableStateOf<List<CashAccount>>(emptyList()); private set
    var methods by mutableStateOf<List<CashMethod>>(emptyList()); private set
    var session by mutableStateOf<CashSession?>(null); private set
    /** O último caixa fechado aqui (resumo depois do fechamento). */
    var closed by mutableStateOf<CashSession?>(null); private set
    var busy by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null)

    /** A mesma intenção repetida depois de uma falha de rede usa a mesma chave (o servidor não lança duas vezes). */
    private var pending: Pair<String, String>? = null
    private fun key(signature: String): String = pending?.takeIf { it.first == signature }?.second ?: CashRules.newKey().also { pending = signature to it }

    /** Nomes das formas: as do servidor ou, sem elas, as comuns. */
    val methodNames: List<String> get() = methods.map { it.description }.filter { it.isNotBlank() }.ifEmpty { CashRules.FALLBACK_METHODS }

    init { reload() }

    fun reload() {
        viewModelScope.launch {
            loading = session == null && closed == null
            try {
                val list = client.accounts()
                accounts = list
                methods = client.methods()
                session = client.openSession()
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ModuleFailure.handle(container, ModuleIds.ERP_FINANCE, e)
                error = CashRules.message(e)
            }
            loading = false
        }
    }

    private fun run(signature: String, block: suspend (String) -> CashSession, done: (CashSession) -> Unit) {
        if (busy) return
        busy = true
        viewModelScope.launch {
            val k = key(signature)
            try {
                done(block(k))
                pending = null
                notice = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!(e is QueueException && e.retryable)) pending = null
                ModuleFailure.handle(container, ModuleIds.ERP_FINANCE, e)
                notice = CashRules.message(e) + if ((e as? QueueException)?.retryable == true) ModuleFailure.RETRY_HINT else ""
            }
            busy = false
        }
    }

    fun open(accountId: String, change: Long) =
        run("open:$accountId:$change", { client.open(accountId, change, it) }) { session = it; closed = null }

    fun move(entry: Boolean, cents: Long, method: String, description: String, onDone: () -> Unit) {
        val current = session ?: return
        val note = CashRules.note(method, description)
        run("move:${current.id}:${current.version}:$entry:$cents:$note", { client.move(current, entry, cents, note, BrasiliaTime.today(), it) }) {
            session = it
            onDone()
        }
    }

    fun close(counted: Long, onDone: () -> Unit) {
        val current = session ?: return
        val values = CashRules.closingValues(methods, current, counted)
        run("close:${current.id}:${current.version}:$counted", { client.close(current, values, it) }) {
            closed = it
            session = null
            onDone()
        }
    }
}

/** Caixa simples: abrir com troco, lançar entradas e saídas, fechar com conferência. */
@Composable
fun CaixaScreen(container: AppContainer, onBack: () -> Unit) {
    val vm: CaixaViewModel = viewModel { CaixaViewModel(container) }
    val c = Wb.colors
    val context = LocalContext.current
    val webUrl = WebPanel.url(container.session.serverUrl, WebPanel.CASH)
    var moveKind by remember { mutableStateOf<Boolean?>(null) }
    var closing by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Caixa", onBack, subtitle = vm.session?.let { "Aberto · ${it.accountName}" } ?: "Fechado") },
    ) { padding ->
        when {
            vm.loading -> SkeletonList(Modifier.padding(padding), rows = 5, avatar = false)
            vm.error != null && vm.session == null -> ErrorState(vm.error!!, onRetry = vm::reload, modifier = Modifier.padding(padding))
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize().testTag("caixa.list"), contentPadding = PaddingValues(bottom = 32.dp)) {
                vm.notice?.let { text -> item("notice") { InlineNotice(text, Modifier.padding(16.dp), onDismiss = { vm.notice = null }) } }
                val session = vm.session
                if (session == null) {
                    vm.closed?.let { last -> item("closed") { ClosedSummary(last) } }
                    item("open") { OpenCashCard(vm) }
                } else {
                    item("summary") { SessionSummary(session, vm.methodNames) }
                    item("actions") {
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            PrimaryButton("Lançar entrada", { moveKind = true }, Modifier.testTag("caixa.entry"), icon = Icons.Filled.AddCircle, enabled = !vm.busy)
                            SecondaryButton("Lançar saída", { moveKind = false }, Modifier.testTag("caixa.exit"), icon = Icons.Filled.RemoveCircle, enabled = !vm.busy)
                            SecondaryButton("Fechar caixa", { closing = true }, Modifier.testTag("caixa.close"), icon = Icons.Filled.Lock, color = c.danger, enabled = !vm.busy)
                        }
                    }
                    item("moves-label") { SectionLabel("Lançamentos de hoje") }
                    if (session.moves.isEmpty()) item("moves-empty") {
                        Text("Nenhum lançamento ainda.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = 20.dp))
                    } else item("moves") {
                        WbCard(Modifier.padding(horizontal = 16.dp)) {
                            session.moves.asReversed().forEachIndexed { i, move ->
                                if (i > 0) RowDivider(16.dp)
                                MoveRow(move, vm.methodNames)
                            }
                        }
                    }
                }
                if (webUrl != null) item("web") {
                    WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp)) {
                        SettingsRow(
                            Icons.Filled.OpenInBrowser, "Abrir no navegador",
                            subtitle = "Sangria, reabrir, conferido e outros caixas ficam no controle de caixa do painel",
                            tint = c.textSecondary, onClick = { Links.open(context, webUrl) },
                        )
                    }
                }
            }
        }
    }

    moveKind?.let { entry -> MoveDialog(vm, entry, onDismiss = { moveKind = null }) }
    if (closing) vm.session?.let { CloseDialog(vm, it, onDismiss = { closing = false }) }
}

@Composable
private fun OpenCashCard(vm: CaixaViewModel) {
    val c = Wb.colors
    var change by remember { mutableStateOf("") }
    var account by remember(vm.accounts) { mutableStateOf(vm.accounts.firstOrNull()?.id) }
    WbCard(Modifier.padding(16.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Abrir o caixa", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            if (vm.accounts.isEmpty()) {
                Text(
                    "Nenhuma conta do tipo Caixa cadastrada. Cadastre uma em Financeiro → Contas, no painel, e puxe para atualizar.",
                    style = MaterialTheme.typography.bodySmall, color = c.textSecondary,
                )
                SecondaryButton("Atualizar", vm::reload)
                return@Column
            }
            if (vm.accounts.size > 1) {
                FilterRow { vm.accounts.forEach { a -> WbFilterChip(a.name, account == a.id, onClick = { account = a.id }) } }
            }
            OutlinedTextField(
                change, { change = it }, label = { Text("Troco inicial (R$)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth().testTag("caixa.change"),
            )
            val cents = if (change.isBlank()) 0L else Money.parse(change)
            if (cents == null) Text("Digite o valor como 50 ou 50,00.", style = MaterialTheme.typography.bodySmall, color = c.danger)
            PrimaryButton(
                "Abrir caixa", { account?.let { id -> cents?.let { vm.open(id, it) } } },
                Modifier.testTag("caixa.open"), icon = Icons.Filled.PointOfSale, loading = vm.busy, enabled = cents != null && account != null,
            )
        }
    }
}

@Composable
private fun SessionSummary(session: CashSession, methods: List<String>) {
    val c = Wb.colors
    WbCard(Modifier.padding(16.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Line("Troco inicial", Money.format(session.change))
            Line("Entradas", "+ " + Money.format(session.entries))
            Line("Saídas", "− " + Money.format(session.exits))
            Line("Dinheiro esperado na gaveta", Money.format(CashRules.expectedDrawer(session, methods)), bold = true)
            val byMethod = CashRules.totalsByMethod(session.moves, methods)
            if (byMethod.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text("Por forma de pagamento", style = MaterialTheme.typography.labelMedium, color = c.textSecondary)
                byMethod.forEach { (name, cents) -> Line(name, Money.format(cents)) }
            }
            Text("Aberto por ${session.operatorName.ifBlank { "você" }}", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }
    }
}

@Composable
private fun ClosedSummary(session: CashSession) {
    val c = Wb.colors
    WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), color = c.soft(c.ok, 0.12f)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Caixa fechado", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            Line("Troco inicial", Money.format(session.change))
            Line("Entradas", "+ " + Money.format(session.entries))
            Line("Saídas", "− " + Money.format(session.exits))
            Line("Informado no fechamento", Money.format(session.informedCents.toLongOrNull() ?: 0), bold = true)
        }
    }
}

@Composable
private fun Line(label: String, value: String, bold: Boolean = false) {
    val c = Wb.colors
    Row(Modifier.fillMaxWidth()) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal)
    }
}

@Composable
private fun MoveRow(move: CashMove, methods: List<String>) {
    val c = Wb.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
        Column(Modifier.weight(1f)) {
            Text(CashRules.descriptionOf(move.note, methods).ifBlank { if (move.isEntry) "Entrada" else "Saída" }, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
            Text(CashRules.methodOf(move.note, methods) ?: "Dinheiro", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }
        Text(
            (if (move.isEntry) "+ " else "− ") + Money.format(move.cents),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = if (move.isEntry) c.ok else c.danger,
        )
    }
}

@Composable
private fun MoveDialog(vm: CaixaViewModel, entry: Boolean, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf("") }
    var method by remember { mutableStateOf(vm.methodNames.first()) }
    var description by remember { mutableStateOf("") }
    val cents = Money.parse(value)?.takeIf { it > 0 }
    AlertDialog(
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text(if (entry) "Lançar entrada" else "Lançar saída") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value, { value = it }, label = { Text("Valor (R$)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth().testTag("caixa.value"),
                )
                Text("Forma de pagamento", style = MaterialTheme.typography.labelMedium, color = Wb.colors.textSecondary)
                FilterRow { vm.methodNames.forEach { m -> WbFilterChip(m, method == m, onClick = { method = m }) } }
                OutlinedTextField(
                    description, { description = it.take(200) }, label = { Text(if (entry) "Descrição (ex.: corte e barba)" else "Descrição (ex.: compra de lâminas)") },
                    modifier = Modifier.fillMaxWidth().testTag("caixa.description"),
                )
                vm.notice?.let { Text(it, color = Wb.colors.danger, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(enabled = cents != null && !vm.busy, onClick = { cents?.let { vm.move(entry, it, method, description, onDismiss) } }) {
                Text(if (vm.busy) "Lançando…" else "Lançar")
            }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text("Voltar") } },
    )
}

@Composable
private fun CloseDialog(vm: CaixaViewModel, session: CashSession, onDismiss: () -> Unit) {
    val expected = CashRules.expectedDrawer(session, vm.methodNames)
    var counted by remember { mutableStateOf(Money.format(expected.coerceAtLeast(0)).removePrefix("R$ ")) }
    val cents = Money.parse(counted)
    AlertDialog(
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text("Fechar o caixa") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Conte o dinheiro da gaveta. Esperado: ${Money.format(expected)}.", style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(
                    counted, { counted = it }, label = { Text("Dinheiro contado (R$)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth().testTag("caixa.counted"),
                )
                cents?.let { Text(CashRules.difference(expected, it), style = MaterialTheme.typography.bodySmall, color = if (it == expected) Wb.colors.ok else Wb.colors.warn) }
                CashRules.totalsByMethod(session.moves, vm.methodNames).filter { !it.first.equals("Dinheiro", true) }.forEach { (name, total) ->
                    Text("$name: ${Money.format(total)}", style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary)
                }
                if (vm.methods.isEmpty()) {
                    Text("As formas de pagamento não vieram do servidor: a conferência por forma fica no painel.", style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary)
                }
                vm.notice?.let { Text(it, color = Wb.colors.danger, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(enabled = cents != null && !vm.busy, onClick = { cents?.let { vm.close(it, onDismiss) } }) {
                Text(if (vm.busy) "Fechando…" else "Fechar caixa", color = Wb.colors.danger)
            }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text("Voltar") } },
    )
}
