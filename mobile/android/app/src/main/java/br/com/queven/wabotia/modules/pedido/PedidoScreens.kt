package br.com.queven.wabotia.modules.pedido

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DeliveryDining
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.RestaurantMenu
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
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
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SecureScreenEffect
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay

@Composable
internal fun pedidoColor(status: String): Color {
    val c = Wb.colors
    return when (status) {
        "awaiting_payment" -> c.warn
        "received" -> c.brand
        "preparing" -> c.bot
        "ready" -> c.ok
        "out_for_delivery" -> c.ticket
        "cancelled" -> c.danger
        else -> c.muted
    }
}

@Composable
internal fun pedidoPaymentColor(status: String?): Color {
    val c = Wb.colors
    return when (status) {
        "paid" -> c.ok
        "choosing", "awaiting" -> c.warn
        "expired", "failed" -> c.danger
        else -> c.muted
    }
}

/** Pedidos: o quadro da cozinha, a lista e o cardápio com os esgotados, com a situação da loja no topo. */
@Composable
fun PedidoScreen(container: AppContainer, onBack: () -> Unit, openOrder: (String) -> Unit, initialMode: PedidoViewModel.Mode = PedidoViewModel.Mode.BOARD) {
    val vm: PedidoViewModel = viewModel { PedidoViewModel(PedidoDeps.of(container), container, initialMode) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var pausing by remember { mutableStateOf(false) }
    SecureScreenEffect(container)
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    // O quadro relê a cada minuto: o tempo no estado e o destaque de atraso andam sozinhos.
    LaunchedEffect(vm.mode) {
        while (vm.mode == PedidoViewModel.Mode.BOARD) {
            delay(60_000)
            vm.load()
        }
    }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DetailTopBar("Pedidos", onBack, actions = {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SegmentedTabs(
                PedidoViewModel.Mode.entries.map { it to it.label },
                vm.mode,
                { vm.changeMode(it) },
                Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp),
            )
            if (vm.mode == PedidoViewModel.Mode.LIST) {
                SearchField(vm.query, { vm.search(it) }, "Cliente, número ou telefone", Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp))
                LazyRow(contentPadding = PaddingValues(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(PedidoRules.FILTERS, key = { it.first }) { (id, title) ->
                        WbFilterChip(title, vm.filter == id, { vm.changeFilter(id) }, count = vm.count(id)?.takeIf { it > 0 })
                    }
                }
            }
            vm.store?.let { StoreBanner(it, vm, onPause = { pausing = true }) }
            vm.notice?.let { InlineNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), onDismiss = { vm.notice = null }) }
            when {
                vm.loading && vm.board == null && vm.orders.isEmpty() && vm.menu == null ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                vm.error != null -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.mode == PedidoViewModel.Mode.BOARD -> BoardContent(vm, openOrder)
                vm.mode == PedidoViewModel.Mode.LIST -> ListContent(vm, openOrder)
                else -> MenuContent(vm)
            }
        }
    }
    if (pausing) PauseDialog(onDismiss = { pausing = false }, onPause = { message -> pausing = false; vm.setPaused(true, message) })
}

/** A faixa da loja: aberta, fechada pelo horário ou pausada (com a mensagem que o cliente lê), e o botão de pausa. */
@Composable
private fun StoreBanner(store: PedidoStore, vm: PedidoViewModel, onPause: () -> Unit) {
    val c = Wb.colors
    val paused = store.paused == true
    val color = if (paused) c.danger else if (store.open == false) c.warn else c.ok
    val busy = "pause" in vm.busy
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.soft(color, 0.10f)).padding(10.dp).testTag("pedido.store"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(PedidoRules.storeText(store), color = c.textPrimary, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
            val pause = PedidoRules.pauseText(store)
            val today = vm.board?.today
            when {
                pause != null -> Text(pause, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                today != null && vm.mode == PedidoViewModel.Mode.BOARD ->
                    Text("Hoje: ${today.orders ?: 0} pedido(s) · ${today.delivered ?: 0} entregue(s) · ${Money.format(today.totalCents ?: 0)}", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
        }
        Spacer(Modifier.width(6.dp))
        TextButton(onClick = { if (paused) vm.setPaused(false) else onPause() }, enabled = !busy, modifier = Modifier.testTag("pedido.pause")) {
            if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = if (paused) c.ok else c.danger)
            else Text(if (paused) "Voltar a receber" else "Pausar a loja", color = if (paused) c.ok else c.danger, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun PauseDialog(onDismiss: () -> Unit, onPause: (String) -> Unit) {
    val c = Wb.colors
    var message by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Pausar a loja?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("O Cardápio no WhatsApp responde que a loja está fechada agora, e um carrinho aberto antes é recusado ao concluir. Os pedidos já feitos seguem no quadro.")
                OutlinedTextField(message, { message = it.take(300) }, label = { Text("Mensagem ao cliente (opcional)") }, placeholder = { Text("Ex.: voltamos às 19h") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = { TextButton(onClick = { onPause(message) }, modifier = Modifier.testTag("pedido.pause.confirm")) { Text("Pausar a loja", color = c.danger) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Voltar") } },
    )
}

/** Uma seção por estado em andamento, do mais antigo para o mais novo, com o tempo no estado. */
@Composable
private fun BoardContent(vm: PedidoViewModel, openOrder: (String) -> Unit) {
    val board = vm.board ?: return
    if (board.count == 0) {
        EmptyState(Icons.Filled.RestaurantMenu, "Nenhum pedido em andamento", subtitle = "Os pedidos novos do WhatsApp aparecem aqui assim que o cliente conclui o carrinho.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        board.columns.filter { it.orders.isNotEmpty() }.forEach { column ->
            item("h-${column.status}") {
                Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(pedidoColor(column.status)))
                    Spacer(Modifier.width(8.dp))
                    Text(PedidoRules.columnLabel(column.status), color = Wb.colors.textPrimary, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.width(8.dp))
                    Text(column.orders.size.toString(), color = Wb.colors.textSecondary, fontWeight = FontWeight.SemiBold)
                }
            }
            items(column.orders, key = { "${column.status}-${it.id}" }) { order -> PedidoCard(order) { openOrder(order.id) } }
        }
    }
}

@Composable
private fun ListContent(vm: PedidoViewModel, openOrder: (String) -> Unit) {
    if (vm.orders.isEmpty()) {
        EmptyState(
            Icons.Filled.RestaurantMenu, "Nenhum pedido aqui",
            subtitle = if (vm.query.isBlank()) "Troque o filtro para ver pedidos entregues ou cancelados." else "Nada encontrado para essa busca.",
        )
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        items(vm.orders, key = { it.id }) { order -> PedidoCard(order) { openOrder(order.id) } }
        if (vm.page?.nextCursor != null) item("more") {
            LaunchedEffect(vm.orders.size) { vm.loadMore() }
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Wb.colors.brand) }
        }
    }
}

/** O cartão do pedido no quadro e na lista: número, cliente, itens, tempo no estado (vermelho quando atrasa), total. */
@Composable
private fun PedidoCard(order: PedidoOrder, onClick: () -> Unit) {
    val c = Wb.colors
    val late = order.late == true
    WbCard(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).then(if (late) Modifier.border(BorderStroke(1.5.dp, c.danger), RoundedCornerShape(16.dp)) else Modifier).testTag("pedido.order"),
        onClick = onClick,
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.numberText, color = c.ticket, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(6.dp))
                Icon(if (order.delivery) Icons.Filled.DeliveryDining else Icons.Filled.ShoppingBag, contentDescription = order.fulfillmentText, tint = c.textSecondary, modifier = Modifier.size(16.dp))
                Spacer(Modifier.weight(1f))
                val minutes = PedidoRules.elapsed(order.minutesInStatus)
                if (minutes != null) {
                    Icon(Icons.Filled.Schedule, contentDescription = null, tint = if (late) c.danger else c.textSecondary, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(
                        minutes, color = if (late) c.danger else c.textSecondary, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.semantics { contentDescription = if (late) "$minutes no estado, atrasado" else "$minutes no estado" },
                    )
                } else {
                    Pill(order.label, pedidoColor(order.state))
                }
            }
            Text(order.customerName, color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            order.lines.take(4).forEach { line ->
                Text(
                    "${line.quantity ?: 1}x ${line.name ?: "Item"}" + (PedidoRules.optionsText(line)?.let { " · $it" } ?: ""),
                    color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (order.lines.size > 4) Text("e mais ${order.lines.size - 4}…", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill(PedidoRules.paymentPill(order), pedidoPaymentColor(order.payment?.status))
                Spacer(Modifier.weight(1f))
                Text(Money.format(order.totalCents ?: 0), color = c.textPrimary, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** O cardápio com os interruptores de esgotado (itens e opções dos adicionais). */
@Composable
private fun MenuContent(vm: PedidoViewModel) {
    val c = Wb.colors
    val menu = vm.menu ?: return
    if (menu.categories.isEmpty() && menu.groups.isEmpty()) {
        EmptyState(Icons.Filled.RestaurantMenu, "Cardápio vazio", subtitle = "O cardápio é montado no painel, em Cardápio e loja.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item("hint") {
            Text("Desligue o que acabou: o item aparece no carrinho sem quantidade até voltar.", Modifier.padding(16.dp), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
        menu.categories.forEach { category ->
            item("c-${category.id}") { SectionLabel(category.name ?: "Categoria") }
            item("ci-${category.id}") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    if (category.items.isEmpty()) Text("Sem itens.", Modifier.padding(16.dp), color = c.textSecondary)
                    category.items.forEachIndexed { i, item ->
                        if (i > 0) HorizontalDivider(color = c.hairline)
                        AvailabilityRow(item.name ?: "Item", item.priceCents?.let { Money.format(it) }, item.available != false, "item:${item.id}" in vm.busy, "pedido.item.${item.id}") {
                            vm.setItem(item, it)
                        }
                    }
                }
            }
        }
        menu.groups.forEach { group ->
            item("g-${group.id}") { SectionLabel((group.name ?: "Adicionais") + " · " + groupRule(group)) }
            item("gi-${group.id}") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    group.options.forEachIndexed { i, option ->
                        if (i > 0) HorizontalDivider(color = c.hairline)
                        AvailabilityRow(
                            option.name ?: "Opção", option.priceCents?.takeIf { it > 0 }?.let { "+ " + Money.format(it) }, option.available != false,
                            "option:${group.id}:${option.id}" in vm.busy, "pedido.option.${group.id}.${option.id}",
                        ) { vm.setOption(group, option, it) }
                    }
                }
            }
        }
    }
}

private fun groupRule(g: PedidoMenuGroup): String {
    val min = g.min ?: 0
    val max = g.max ?: 1
    return when {
        min >= 1 && max == 1 -> "escolha única obrigatória"
        min == 0 -> "opcional, até $max"
        else -> "de $min a $max"
    }
}

@Composable
private fun AvailabilityRow(title: String, subtitle: String?, available: Boolean, busy: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    val c = Wb.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                title, color = if (available) c.textPrimary else c.textSecondary, fontWeight = FontWeight.SemiBold,
                textDecoration = if (available) null else TextDecoration.LineThrough,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                subtitle?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                if (!available) Pill("Esgotado", c.danger)
            }
        }
        Box(Modifier.size(width = 56.dp, height = 48.dp), contentAlignment = Alignment.Center) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.ok)
            } else {
                Switch(
                    checked = available, onCheckedChange = onChange,
                    colors = SwitchDefaults.colors(checkedTrackColor = c.ok, checkedThumbColor = Color.White, checkedBorderColor = c.ok),
                    modifier = Modifier.testTag(tag).semantics { contentDescription = "$title disponível" },
                )
            }
        }
    }
}

/** Detalhe do pedido: estado, itens por montagem, pagamento, cliente e entrega, histórico e comanda. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PedidoOrderScreen(container: AppContainer, id: String, onBack: () -> Unit, openConversation: (String) -> Unit, openPrinter: () -> Unit) {
    val vm: PedidoOrderViewModel = viewModel(key = "pedido:$id") { PedidoOrderViewModel(id, PedidoDeps.of(container), container) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var confirm by remember { mutableStateOf<Pair<String, String>?>(null) }
    var confirmPaid by remember { mutableStateOf(false) }
    var confirmReprint by remember { mutableStateOf(false) }
    SecureScreenEffect(container)
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    LaunchedEffect(vm.print) {
        when (val p = vm.print) {
            TicketPrint.Printed -> { snackbar.showSnackbar("Comanda enviada à impressora. Confira o papel."); vm.clearPrint() }
            TicketPrint.NoPrinter -> {
                val r = snackbar.showSnackbar("Nenhuma impressora escolhida neste aparelho.", actionLabel = "Escolher")
                vm.clearPrint()
                if (r == SnackbarResult.ActionPerformed) openPrinter()
            }
            is TicketPrint.Failed -> {
                if (p.reprintNeedsConfirmation) confirmReprint = true
                else { snackbar.showSnackbar("A comanda não saiu: ${p.message}"); vm.clearPrint() }
            }
            else -> Unit
        }
    }
    val order = vm.order
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DetailTopBar("Pedido ${order?.numberText ?: ""}".trim(), onBack, subtitle = order?.label, actions = {
                if (order != null) IconButton(onClick = { vm.printTicket() }, enabled = vm.print != TicketPrint.Printing, modifier = Modifier.testTag("pedido.print")) {
                    Icon(Icons.Filled.Print, contentDescription = "Imprimir comanda", tint = c.textSecondary)
                }
            })
        },
    ) { padding ->
        when {
            order == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            order == null -> ErrorState(vm.notice ?: "Pedido não encontrado.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(order.numberText, Modifier.weight(1f), color = c.ticket, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                            Pill(order.label, pedidoColor(order.state), filled = true)
                        }
                        Text(
                            listOfNotNull(order.fulfillmentText, order.created?.let(BrasiliaTime::shortWithTime), order.etaAt?.let { "previsão ${BrasiliaTime.clock(it)}" }).joinToString(" · "),
                            color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                        )
                        order.note?.takeIf { it.isNotBlank() }?.let { Field("Observação do cliente", it) }
                        order.notes?.takeIf { it.isNotBlank() }?.let { Field("Observação interna", it) }
                        order.cancelReason?.takeIf { it.isNotBlank() }?.let { Text("Motivo do cancelamento: $it", color = c.danger, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                val actions = PedidoRules.actions(order)
                if (actions.isNotEmpty()) {
                    SectionLabel("O que fazer agora", Modifier.padding(start = 0.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        actions.forEach { (status, title) ->
                            val tone = if (status == "cancelled") c.danger else pedidoColor(status)
                            SecondaryButton(title, { confirm = status to title }, Modifier.testTag("pedido.action.$status"), enabled = vm.busy == null, loading = vm.busy == "status:$status", color = tone)
                        }
                    }
                }
                ItemsCard(order)
                PaymentCard(order, vm, onMarkPaid = { confirmPaid = true })
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(if (order.delivery) "Cliente e entrega" else "Cliente", fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                        Field("Cliente", order.customerName)
                        PhoneText.display(order.customer?.phone)?.takeIf { it != order.customerName }?.let { Field("Telefone", it) }
                        if (order.delivery) {
                            Field("Endereço", order.addressText?.takeIf { it.isNotBlank() } ?: "Endereço não informado")
                            order.address?.reference?.takeIf { it.isNotBlank() }?.let { Field("Referência", it) }
                        }
                        Field("Origem", PedidoRules.sourceLabel(order.source))
                    }
                }
                order.customer?.conversationId?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
                SecondaryButton("Imprimir comanda", { vm.printTicket() }, loading = vm.print == TicketPrint.Printing, icon = Icons.Filled.Print)
                order.history?.takeIf { it.isNotEmpty() }?.let { history ->
                    SectionLabel("Histórico")
                    WbCard {
                        Column(Modifier.padding(vertical = 6.dp)) {
                            history.sortedByDescending { it.created ?: 0 }.forEachIndexed { i, h ->
                                if (i > 0) HorizontalDivider(color = c.hairline)
                                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                                    Text(PedidoRules.historyText(h), color = c.textPrimary, fontWeight = FontWeight.Medium)
                                    Text(
                                        listOfNotNull(h.created?.let(BrasiliaTime::shortWithTime), PedidoRules.actorLabel(h.actor), h.note?.takeIf { it.isNotBlank() }).joinToString(" · "),
                                        color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    confirm?.let { (status, title) ->
        val cancel = status == "cancelled"
        val hasChat = order?.customer?.conversationId != null
        var note by remember(status) { mutableStateOf("") }
        var notify by remember(status) { mutableStateOf(hasChat) }
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("$title?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (cancel) {
                        Text("Uma cobrança Pix ou link aberta é cancelada junto. Se o cliente pagar mesmo assim, o pedido fica marcado para estorno.")
                        OutlinedTextField(note, { note = it }, label = { Text("Motivo (vai ao cliente)") }, placeholder = { Text("Ex.: acabou o pão de hambúrguer") }, modifier = Modifier.fillMaxWidth())
                    } else {
                        OutlinedTextField(note, { note = it }, label = { Text("Observação no histórico (opcional)") }, placeholder = { Text("Ex.: motoboy João") }, modifier = Modifier.fillMaxWidth())
                    }
                    if (hasChat) {
                        Row(Modifier.fillMaxWidth().clickable { notify = !notify }, verticalAlignment = Alignment.CenterVertically) {
                            Text("Avisar o cliente no WhatsApp", Modifier.weight(1f), color = c.textPrimary)
                            Switch(notify, { notify = it }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                        }
                    } else {
                        Text("Pedido sem conversa ligada: o cliente não é avisado.", color = c.warn, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = null
                        vm.perform(status, note = if (cancel) null else note, reason = if (cancel) note else null, notify = notify && hasChat)
                    },
                    enabled = !cancel || note.isNotBlank(),
                    modifier = Modifier.testTag("pedido.confirm"),
                ) { Text(title, color = if (cancel) c.danger else c.brand) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Voltar") } },
        )
    }
    if (confirmPaid) {
        AlertDialog(
            onDismissRequest = { confirmPaid = false },
            title = { Text("Registrar o pagamento recebido?") },
            text = { Text("Use para dinheiro, maquininha ou pagamento feito por fora. Fica no histórico com o seu nome.") },
            confirmButton = { TextButton(onClick = { confirmPaid = false; vm.markPaid() }) { Text("Recebi ${Money.format(order?.totalCents ?: 0)}", color = c.ok) } },
            dismissButton = { TextButton(onClick = { confirmPaid = false }) { Text("Voltar") } },
        )
    }
    if (confirmReprint) {
        AlertDialog(
            onDismissRequest = { confirmReprint = false; vm.clearPrint() },
            title = { Text("A comanda saiu?") },
            text = { Text("A impressora pode ter impresso sem confirmar. Imprima de novo só se nada saiu.") },
            confirmButton = { TextButton(onClick = { confirmReprint = false; vm.printTicket(confirmed = true) }) { Text("Nada saiu, imprimir") } },
            dismissButton = { TextButton(onClick = { confirmReprint = false; vm.clearPrint() }) { Text("Saiu, cancelar") } },
        )
    }
}

/** Cada montagem na sua linha: o mesmo item em duas montagens aparece duas vezes, nunca somado. */
@Composable
private fun ItemsCard(order: PedidoOrder) {
    val c = Wb.colors
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Itens", fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            PedidoRules.assemblies(order).forEach { (line, assembly) ->
                Column(Modifier.fillMaxWidth().testTag("pedido.line")) {
                    Row {
                        Text("${line.quantity ?: 1}x ${line.name ?: "Item"}", Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                        Text(Money.format(line.totalCents ?: 0), color = c.textPrimary)
                    }
                    assembly?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.labelSmall) }
                    line.options.forEach { option ->
                        Text(
                            "+ ${option.name.orEmpty()}" + (option.priceCents?.takeIf { it > 0 }?.let { " (${Money.format(it)})" } ?: ""),
                            color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    line.note?.takeIf { it.isNotBlank() }?.let { Text("Obs.: $it", color = c.warn, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall) }
                }
            }
            HorizontalDivider(color = c.hairline)
            Row { Text("Subtotal", Modifier.weight(1f), color = c.textSecondary); Text(Money.format(order.subtotalCents ?: 0), color = c.textPrimary) }
            if (order.delivery) Row { Text("Entrega", Modifier.weight(1f), color = c.textSecondary); Text(Money.format(order.deliveryFeeCents ?: 0), color = c.textPrimary) }
            Row { Text("Total", Modifier.weight(1f), fontWeight = FontWeight.Bold, color = c.textPrimary); Text(Money.format(order.totalCents ?: 0), fontWeight = FontWeight.Bold, color = c.textPrimary) }
        }
    }
}

@Composable
private fun PaymentCard(order: PedidoOrder, vm: PedidoOrderViewModel, onMarkPaid: () -> Unit) {
    val c = Wb.colors
    val p = order.payment
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Pagamento", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                p?.statusLabel?.takeIf { it.isNotBlank() }?.let { Pill(it, pedidoPaymentColor(p.status)) }
            }
            Text(p?.methodLabel ?: "Forma de pagamento a definir", color = c.textPrimary)
            val detail = listOfNotNull(p?.changeForCents?.let { "troco para ${Money.format(it)}" }, p?.paidAt?.let { "pago em ${BrasiliaTime.shortWithTime(it)}" }, p?.error?.takeIf { it.isNotBlank() })
            if (detail.isNotEmpty()) Text(detail.joinToString(" · "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            if (p?.needsRefund == true) Text("Pago depois de cancelado: estornar no Mercado Pago.", color = c.danger, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall)
            if (PedidoRules.canChooseMethod(order)) {
                Text("O cliente ainda não escolheu. Se ele combinou com a equipe:", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                PedidoRules.STAFF_METHODS.forEach { (method, title) ->
                    SecondaryButton("Vai pagar com ${title.lowercase()}", { vm.setMethod(method) }, Modifier.testTag("pedido.method.$method"), enabled = vm.busy == null, loading = vm.busy == "method:$method")
                }
            }
            if (PedidoRules.canMarkPaid(order)) {
                SecondaryButton("Registrar pagamento recebido", onMarkPaid, Modifier.testTag("pedido.paid"), enabled = vm.busy == null, loading = vm.busy == "paid", color = c.ok)
            }
        }
    }
}
