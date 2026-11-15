package br.com.queven.wabotia.modules.os

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.RequestQuote
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.agenda.Field
import br.com.queven.wabotia.printing.TicketPrint
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb

@Composable
internal fun orderColor(state: String): Color {
    val c = Wb.colors
    return when (state) {
        "received", "analyzing" -> c.brand
        "quoted" -> c.warn
        "approved", "in_progress" -> c.ticket
        "ready" -> c.ok
        "declined", "cancelled" -> c.danger
        else -> c.muted
    }
}

/** Lista de ordens: filtro por estado com as contagens da área, busca e "Nova ordem". */
@Composable
fun ServiceOrdersScreen(container: AppContainer, onBack: () -> Unit, openOrder: (String) -> Unit, newOrder: () -> Unit) {
    val vm: ServiceOrdersViewModel = viewModel { ServiceOrdersViewModel(ServiceOrderDeps.of(container), container) }
    val c = Wb.colors
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            DetailTopBar("Ordens de serviço", onBack, actions = {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = newOrder, containerColor = c.brand, contentColor = c.onBrand,
                modifier = Modifier.navigationBarsPadding().testTag("os.new"),
                icon = { Icon(Icons.Filled.Add, contentDescription = null) }, text = { Text("Nova ordem") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SearchField(vm.query, { vm.search(it) }, "Item, cliente, número ou telefone", Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp))
            LazyRow(contentPadding = PaddingValues(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(ServiceOrderRules.FILTERS, key = { it.first }) { (id, title) ->
                    WbFilterChip(title, vm.filter == id, { vm.changeFilter(id) }, count = vm.count(id)?.takeIf { it > 0 })
                }
            }
            when {
                vm.loading && vm.orders.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                vm.error != null && vm.orders.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.orders.isEmpty() -> EmptyState(Icons.Filled.Build, "Nenhuma ordem aqui", subtitle = if (vm.query.isBlank()) "Abra uma ordem no balcão ou pela conversa do cliente." else "Nada encontrado para essa busca.")
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    items(vm.orders, key = { it.id }) { order -> OrderRow(order) { openOrder(order.id) } }
                    if (vm.page?.nextCursor != null) item("more") {
                        LaunchedEffect(vm.orders.size) { vm.loadMore() }
                        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                    }
                }
            }
        }
    }
}

@Composable
private fun OrderRow(order: ServiceOrder, onClick: () -> Unit) {
    val c = Wb.colors
    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("os.order"), onClick = onClick) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(order.number?.toString() ?: "—", Modifier.width(48.dp), fontSize = 18.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
            Column(Modifier.weight(1f)) {
                Text(order.item.orEmpty(), color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(order.customerName, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Pill(order.label, orderColor(order.state))
        }
    }
}

/** Detalhe da ordem, com histórico, orçamento, responsável, mudanças de estado e comprovante impresso. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ServiceOrderScreen(container: AppContainer, id: String, onBack: () -> Unit, openConversation: (String) -> Unit, openPrinter: () -> Unit) {
    val vm: ServiceOrderViewModel = viewModel(key = "os:$id") { ServiceOrderViewModel(id, ServiceOrderDeps.of(container), container) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var quoteDraft by remember { mutableStateOf<QuoteDraft?>(null) }
    var confirm by remember { mutableStateOf<Pair<String, String>?>(null) }
    var pickAssignee by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    LaunchedEffect(vm.print) {
        when (val p = vm.print) {
            TicketPrint.Printed -> { snackbar.showSnackbar("Comprovante impresso"); vm.clearPrint() }
            TicketPrint.NoPrinter -> {
                val r = snackbar.showSnackbar("Nenhuma impressora escolhida neste aparelho.", actionLabel = "Escolher")
                vm.clearPrint()
                if (r == androidx.compose.material3.SnackbarResult.ActionPerformed) openPrinter()
            }
            is TicketPrint.Failed -> { snackbar.showSnackbar(p.message); vm.clearPrint() }
            else -> Unit
        }
    }
    val order = vm.order
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DetailTopBar("Ordem ${order?.numberText ?: ""}".trim(), onBack, subtitle = order?.label, actions = {
                if (order != null) IconButton(onClick = { vm.printReceipt() }, enabled = vm.print != TicketPrint.Printing) {
                    Icon(Icons.Filled.Print, contentDescription = "Imprimir comprovante", tint = c.textSecondary)
                }
            })
        },
    ) { padding ->
        when {
            order == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            order == null -> ErrorState(vm.notice ?: "Ordem não encontrada.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(order.item.orEmpty(), Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
                            Pill(order.label, orderColor(order.state))
                        }
                        Field("Problema", order.problem.orEmpty())
                        Field("Cliente", order.customerName)
                        PhoneText.display(order.customer?.phone)?.takeIf { it != order.customerName }?.let { Field("Telefone", it) }
                        order.created?.let { Field("Aberta em", BrasiliaTime.shortWithTime(it)) }
                        order.dueAt?.let { Field("Previsão", BrasiliaTime.short(it)) }
                        order.warrantyUntil?.let { Field("Garantia até", BrasiliaTime.short(it)) }
                        order.notes?.takeIf { it.isNotBlank() }?.let { Field("Observação interna", it) }
                    }
                }
                if (vm.people.isNotEmpty() || order.assignee != null) {
                    WbCard(onClick = { pickAssignee = true }) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Person, contentDescription = null, tint = c.brand)
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text("Responsável", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                Text(vm.assigneeName ?: "Sem responsável", color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                            }
                            Text("Trocar", color = c.brand, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                QuoteCard(order, onEdit = if (ServiceOrderRules.canEditQuote(order)) ({ quoteDraft = QuoteDraft.of(order) }) else null)
                val actions = ServiceOrderRules.actions(order)
                if (actions.isNotEmpty()) {
                    SectionLabel("O que fazer agora", Modifier.padding(start = 0.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        actions.forEach { (status, title) ->
                            val tone = if (status == "cancelled") c.danger else if (status == "declined") c.warn else c.brand
                            SecondaryButton(title, { confirm = status to title }, enabled = vm.busy == null, loading = vm.busy?.contains(status) == true, color = tone)
                        }
                    }
                    if (order.state == "quoted" && ServiceOrderRules.quoteExpired(order)) {
                        Text("O orçamento venceu: envie de novo para o cliente poder aprovar.", color = c.warn, style = MaterialTheme.typography.bodySmall)
                    }
                }
                order.customer?.conversationId?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
                order.history?.takeIf { it.isNotEmpty() }?.let { history ->
                    SectionLabel("Histórico")
                    WbCard {
                        Column(Modifier.padding(vertical = 6.dp)) {
                            history.sortedByDescending { it.created ?: 0 }.forEachIndexed { i, h ->
                                if (i > 0) HorizontalDivider(color = c.hairline)
                                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                                    Text(ServiceOrderRules.historyText(h), color = c.textPrimary, fontWeight = FontWeight.Medium)
                                    val by = h.actor?.let { a -> vm.people.firstOrNull { it.id == a }?.displayName ?: if (a == "customer") "Cliente" else null }
                                    Text(listOfNotNull(h.created?.let(BrasiliaTime::shortWithTime), by, h.note?.takeIf { it.isNotBlank() }).joinToString(" · "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    confirm?.let { (status, title) ->
        var note by remember(status) { mutableStateOf("") }
        val hasConversation = order?.customer?.conversationId != null
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("$title?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (status) {
                        "quoted" -> Text(if (hasConversation) "O cliente recebe os itens, o total e a validade no WhatsApp e responde Aprovar ou Recusar." else "Esta ordem não está ligada a uma conversa: o envio fica só registrado.")
                        "approved", "declined" -> Text("Registra a resposta que o cliente deu no balcão ou por telefone.")
                        else -> OutlinedTextField(note, { note = it }, label = { Text("Observação (opcional)") }, modifier = Modifier.fillMaxWidth())
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    vm.perform(status, note, notify = hasConversation)
                }) { Text(title, color = if (status == "cancelled") c.danger else c.brand) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Voltar") } },
        )
    }
    quoteDraft?.let { draft ->
        QuoteEditor(
            draft,
            onChange = { quoteDraft = it },
            onDismiss = { quoteDraft = null },
            busy = vm.busy != null,
            canSend = order?.customer?.conversationId != null,
            onSave = { items, send ->
                quoteDraft = null
                vm.saveQuote(items, draft.days, draft.note, send)
            },
        )
    }
    if (pickAssignee) {
        WbBottomSheet(onDismiss = { pickAssignee = false }, title = "Responsável") {
            Column(Modifier.padding(bottom = 24.dp)) {
                TextButton(onClick = { pickAssignee = false; vm.assign(null) }, Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                    Text("Sem responsável", Modifier.fillMaxWidth(), color = c.textSecondary)
                }
                vm.people.forEach { p ->
                    TextButton(onClick = { pickAssignee = false; vm.assign(p.id) }, Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                        Text(p.displayName + if (p.id == order?.assignee) "  ✓" else "", Modifier.fillMaxWidth(), color = c.textPrimary)
                    }
                }
            }
        }
    }
}

@Composable
private fun QuoteCard(order: ServiceOrder, onEdit: (() -> Unit)?) {
    val c = Wb.colors
    val quote = order.quote
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Orçamento", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                if (onEdit != null) TextButton(onClick = onEdit) { Text(if (quote?.items.isNullOrEmpty()) "Montar orçamento" else "Alterar", color = c.brand) }
            }
            if (quote == null || quote.items.isEmpty()) {
                Text("Sem orçamento.", color = c.textSecondary)
                return@Column
            }
            quote.items.forEach { item ->
                Row {
                    Text((if (item.quantity > 1) "${item.quantity}x " else "") + item.description, Modifier.weight(1f), color = c.textPrimary)
                    Text(Money.format(item.totalCents), color = c.textPrimary)
                }
            }
            HorizontalDivider(color = c.hairline)
            Row {
                Text("Total", Modifier.weight(1f), fontWeight = FontWeight.Bold, color = c.textPrimary)
                Text(Money.format(quote.total), fontWeight = FontWeight.Bold, color = c.textPrimary)
            }
            val status = listOfNotNull(
                quote.sentAt?.let { "Enviado em ${BrasiliaTime.shortWithTime(it)}" },
                quote.validUntil?.let { "válido até ${BrasiliaTime.short(it)}" },
                order.decision?.decision?.let { if (it == "approve") "aprovado" else "recusado" },
            ).joinToString(" · ")
            if (status.isNotEmpty()) Text(status, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            quote.note?.takeIf { it.isNotBlank() }?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Montar ou alterar o orçamento: linhas com descrição, quantidade e valor, validade e observação. */
@Composable
private fun QuoteEditor(draft: QuoteDraft, onChange: (QuoteDraft) -> Unit, onDismiss: () -> Unit, busy: Boolean, canSend: Boolean, onSave: (List<QuoteItem>, Boolean) -> Unit) {
    val c = Wb.colors
    var error by remember { mutableStateOf<String?>(null) }
    WbBottomSheet(onDismiss = onDismiss, title = "Orçamento", subtitle = "Total ${Money.format(draft.total)}") {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            draft.lines.forEachIndexed { index, line ->
                fun update(l: QuoteDraft.Line) = onChange(draft.copy(lines = draft.lines.toMutableList().also { it[index] = l }))
                OutlinedTextField(line.description, { update(line.copy(description = it)) }, label = { Text("Item ${index + 1}") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        line.quantity.toString(), { v -> update(line.copy(quantity = v.filter(Char::isDigit).take(3).toIntOrNull() ?: 0)) },
                        label = { Text("Qtd.") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(90.dp),
                    )
                    OutlinedTextField(
                        line.value, { update(line.copy(value = it)) }, label = { Text("Valor (R$)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f),
                    )
                    if (draft.lines.size > 1) IconButton(onClick = { onChange(draft.copy(lines = draft.lines.filterIndexed { i, _ -> i != index })) }) {
                        Icon(Icons.Filled.Delete, contentDescription = "Tirar item ${index + 1}", tint = c.danger)
                    }
                }
            }
            TextButton(onClick = { onChange(draft.copy(lines = draft.lines + QuoteDraft.Line())) }) { Text("Adicionar item", color = c.brand) }
            OutlinedTextField(draft.validDays, { onChange(draft.copy(validDays = it.filter(Char::isDigit).take(2))) }, label = { Text("Validade (dias)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(draft.note, { onChange(draft.copy(note = it)) }, label = { Text("Observação ao cliente (opcional)") }, modifier = Modifier.fillMaxWidth())
            error?.let { InlineNotice(it, onDismiss = { error = null }) }
            fun save(send: Boolean) {
                val items = draft.items()
                when {
                    items.isFailure -> error = items.exceptionOrNull()?.message
                    draft.days == null -> error = "Validade de 1 a 90 dias."
                    else -> onSave(items.getOrThrow(), send)
                }
            }
            if (canSend) PrimaryButton("Salvar e enviar ao cliente", { save(true) }, enabled = !busy, icon = Icons.Filled.RequestQuote)
            SecondaryButton(if (canSend) "Só salvar" else "Salvar", { save(false) }, enabled = !busy)
        }
    }
}

/** Abrir ordem pela conversa (o cliente é avisado) ou no balcão, com telefone, responsável e previsão. */
@Composable
fun NewServiceOrderScreen(container: AppContainer, conversationId: String?, customer: String?, onBack: () -> Unit, onCreated: (ServiceOrder) -> Unit) {
    val vm: NewServiceOrderViewModel = viewModel(key = "os-new:${conversationId ?: "balcao"}") { NewServiceOrderViewModel(conversationId, customer, ServiceOrderDeps.of(container)) }
    val c = Wb.colors
    LaunchedEffect(Unit) { vm.loadPeople() }
    LaunchedEffect(vm.result) { vm.result?.let(onCreated) }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Nova ordem de serviço", onBack, subtitle = customer ?: "No balcão", backEnabled = !vm.busy) },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedTextField(vm.item, { vm.item = it }, label = { Text("Item (aparelho, peça, roupa…)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(vm.problem, { vm.problem = it }, label = { Text("Problema relatado") }, minLines = 2, modifier = Modifier.fillMaxWidth())
            if (conversationId == null) {
                OutlinedTextField(vm.phone, { vm.phone = it }, label = { Text("Telefone do cliente (com DDD)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(vm.customerName, { vm.customerName = it }, label = { Text("Nome do cliente (opcional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            OutlinedTextField(vm.notes, { vm.notes = it }, label = { Text("Observação interna (opcional)") }, modifier = Modifier.fillMaxWidth())
            Text("Previsão", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(listOf<Int?>(null, 1, 3, 7, 15)) { d ->
                    WbFilterChip(d?.let { if (it == 1) "1 dia" else "$it dias" } ?: "Sem previsão", vm.dueDays == d, { vm.dueDays = d })
                }
            }
            if (vm.people.isNotEmpty()) {
                Text("Responsável", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item { WbFilterChip("Ninguém", vm.assignee == null, { vm.assignee = null }) }
                    items(vm.people, key = { it.id }) { p -> WbFilterChip(p.displayName, vm.assignee == p.id, { vm.assignee = p.id }) }
                }
            }
            vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
            Spacer(Modifier.height(4.dp))
            PrimaryButton("Abrir ordem", { vm.submit() }, loading = vm.busy, enabled = vm.canSubmit, icon = Icons.Filled.Build)
            Text(
                if (conversationId != null) "O cliente recebe o número da ordem no WhatsApp." else "Sem conversa ligada, os avisos ao cliente dependem de ele falar com a empresa pelo WhatsApp.",
                color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
