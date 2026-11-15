package br.com.queven.wabotia.modules.reserva

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Hotel
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Remove
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
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb

/** A cor de cada estado da reserva ou da célula da ocupação (sempre com o texto ao lado: nunca só cor). */
@Composable
internal fun reservaColor(state: String?): Color {
    val c = Wb.colors
    return when (state) {
        "pending_payment" -> c.warn
        "confirmed" -> c.brand
        "completed" -> c.ok
        "partial" -> c.ticket
        "blocked", "cancelled", "expired" -> c.muted
        else -> c.divider
    }
}

/** Reservas: ocupação por unidade e dia (14 dias) e a lista com filtro e busca. */
@Composable
fun ReservaScreen(
    container: AppContainer,
    onBack: () -> Unit,
    openBooking: (String) -> Unit,
    newBooking: (unitId: String?, date: String?) -> Unit,
    initialMode: ReservaViewModel.Mode = ReservaViewModel.Mode.OCCUPANCY,
) {
    val vm: ReservaViewModel = viewModel { ReservaViewModel(ReservaDeps.of(container), container, initialMode) }
    val c = Wb.colors
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            DetailTopBar("Reservas", onBack, subtitle = "Ocupação das unidades e reservas", actions = {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { newBooking(null, null) },
                containerColor = c.brand,
                contentColor = c.onBrand,
                modifier = Modifier.navigationBarsPadding().testTag("reserva.new"),
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("Nova reserva") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SegmentedTabs(
                ReservaViewModel.Mode.entries.map { it to it.label },
                vm.mode,
                { vm.changeMode(it) },
                Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp),
            )
            if (vm.mode == ReservaViewModel.Mode.OCCUPANCY) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { vm.shift(-1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Período anterior", tint = c.textPrimary) }
                    Text(
                        "${BrasiliaTime.compact(vm.from)} a ${BrasiliaTime.compact(vm.to)}",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall,
                        color = c.textPrimary,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                    if (vm.from != BrasiliaTime.today()) TextButton(onClick = { vm.goToday() }) { Text("Hoje", color = c.brand) }
                    IconButton(onClick = { vm.shift(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Próximo período", tint = c.textPrimary) }
                }
            } else {
                SearchField(vm.query, { vm.search(it) }, "Cliente, telefone ou número", Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp))
                LazyRow(contentPadding = PaddingValues(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(ReservaRules.FILTERS, key = { it.first }) { (id, title) -> WbFilterChip(title, vm.filter == id, { vm.changeFilter(id) }) }
                }
            }
            vm.depositWarning?.let { InlineNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = c.warn) }
            when {
                vm.loading && vm.calendar == null && vm.bookings.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                vm.error != null && vm.calendar == null && vm.bookings.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.mode == ReservaViewModel.Mode.OCCUPANCY -> Occupancy(vm, openBooking, newBooking)
                vm.bookings.isEmpty() -> EmptyState(
                    Icons.Filled.Hotel, "Nenhuma reserva aqui",
                    subtitle = if (vm.query.isBlank()) "Toque em Nova reserva para reservar uma unidade para um cliente." else "Nada encontrado para essa busca.",
                )
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 4.dp, bottom = 96.dp)) {
                    items(vm.bookings, key = { it.id }) { b -> BookingRow(b) { openBooking(b.id) } }
                }
            }
        }
    }
}

/** Unidades nas linhas e dias nas colunas: tocar numa reserva abre o detalhe, num dia livre abre a reserva nova. */
@Composable
private fun Occupancy(vm: ReservaViewModel, openBooking: (String) -> Unit, newBooking: (String?, String?) -> Unit) {
    val c = Wb.colors
    val units = vm.calendar?.units.orEmpty()
    val days = vm.days
    val today = BrasiliaTime.today()
    if (vm.calendar != null && units.isEmpty()) {
        EmptyState(Icons.Filled.Hotel, "Nenhuma unidade cadastrada", subtitle = "As unidades e as regras são cadastradas no painel, em Gestão → Unidades e regras.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        item("grid") {
            Row(Modifier.padding(start = 16.dp, top = 8.dp)) {
                Column(Modifier.width(112.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Spacer(Modifier.height(38.dp))
                    units.forEach { u ->
                        Column(Modifier.height(40.dp), verticalArrangement = Arrangement.Center) {
                            Text(u.displayName, color = c.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(if (u.mode == "hourly") "por hora" else "por diária", color = c.textSecondary, fontSize = 11.sp)
                        }
                    }
                }
                Column(Modifier.horizontalScroll(rememberScrollState()).padding(end = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        days.forEach { day ->
                            Column(Modifier.width(40.dp).height(38.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                                Text(BrasiliaTime.compact(day).substringBefore(" "), color = c.textSecondary, fontSize = 10.sp)
                                Text(day.takeLast(2), color = if (day == today) c.brand else c.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                    units.forEach { u ->
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            u.cells.forEach { cell -> OccupancyCell(u, cell, openBooking, newBooking) }
                        }
                    }
                }
            }
        }
        item("legend") { Legend(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
        val upcoming = vm.upcoming
        if (upcoming.isNotEmpty()) {
            item("upcoming") { SectionLabel("No período · ${upcoming.size}") }
            items(upcoming, key = { "u:${it.id}" }) { b -> BookingRow(b) { openBooking(b.id) } }
        }
    }
}

@Composable
private fun OccupancyCell(unit: ReservaCalendarUnit, cell: ReservaCell, openBooking: (String) -> Unit, newBooking: (String?, String?) -> Unit) {
    val c = Wb.colors
    val free = cell.state == null || cell.state == "free"
    val shape = RoundedCornerShape(6.dp)
    val action = ReservaRules.cellAction(cell)
    Box(
        Modifier
            .size(40.dp)
            .clip(shape)
            .background(if (free) c.surface else c.soft(reservaColor(cell.state), if (cell.state == "blocked") 0.35f else 0.8f))
            .then(if (free) Modifier.border(BorderStroke(1.dp, c.divider), shape) else Modifier)
            .clickable(enabled = action != ReservaRules.CellAction.None) {
                when (action) {
                    is ReservaRules.CellAction.Open -> openBooking(action.bookingId)
                    ReservaRules.CellAction.Book -> newBooking(unit.unitId, cell.date)
                    ReservaRules.CellAction.None -> Unit
                }
            }
            .semantics { contentDescription = "${unit.displayName}, ${ReservaRules.shortDay(cell.date)}: ${ReservaRules.cellLabel(cell.state)}" },
        contentAlignment = Alignment.Center,
    ) {
        if (cell.state == "blocked") Icon(Icons.Filled.Close, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(14.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Legend(modifier: Modifier = Modifier) {
    val c = Wb.colors
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf("free", "pending_payment", "confirmed", "partial", "blocked").forEach { state ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(12.dp).clip(RoundedCornerShape(3.dp))
                        .background(if (state == "free") c.surface else c.soft(reservaColor(state), 0.8f))
                        .border(BorderStroke(1.dp, c.divider), RoundedCornerShape(3.dp)),
                )
                Spacer(Modifier.width(4.dp))
                Text(ReservaRules.cellLabel(state), color = c.textSecondary, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun BookingRow(b: ReservaBooking, onClick: () -> Unit) {
    val c = Wb.colors
    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("reserva.booking"), onClick = onClick) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(b.numberText, color = c.ticket, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Spacer(Modifier.width(8.dp))
                Text(b.unitName.orEmpty(), Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Pill(ReservaRules.statusLabel(b.state), reservaColor(b.state))
            }
            Text(b.customer, color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row {
                Text(b.periodText, Modifier.weight(1f), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                b.priceCents?.let { Text(Money.format(it), color = c.textPrimary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}

/** Detalhe da reserva: período, cliente, valores, sinal, check-in e ações. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReservaBookingScreen(container: AppContainer, id: String, onBack: () -> Unit, edit: (String) -> Unit, openConversation: (String) -> Unit) {
    val vm: ReservaBookingViewModel = viewModel(key = "reserva:$id") { ReservaBookingViewModel(id, ReservaDeps.of(container), container) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var askCancel by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(vm.done) {
        vm.done?.let { snackbar.showSnackbar(it); vm.done = null }
    }
    val b = vm.booking
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar("Reserva ${b?.numberText.orEmpty()}".trim(), onBack, subtitle = b?.let { ReservaRules.statusLabel(it.state) }) },
    ) { padding ->
        when {
            b == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            b == null -> ErrorState(vm.notice ?: "Reserva não encontrada.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(b.unitName ?: "Unidade", Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
                            Pill(ReservaRules.statusLabel(b.state), reservaColor(b.state), filled = true)
                        }
                        Text(b.periodText, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                        if (!b.isHourly && b.arrivalTime != null && b.departureTime != null) {
                            Text("Entrada a partir das ${b.arrivalTime} · saída até ${b.departureTime}", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                        }
                        b.guests?.let { Text(ReservaRules.guestsText(it), color = c.textSecondary, style = MaterialTheme.typography.bodyMedium) }
                        b.notes?.takeIf { it.isNotBlank() }?.let { Field("Observação interna", it) }
                        b.cancelReason?.takeIf { it.isNotBlank() && b.state in setOf("cancelled", "expired") }?.let { Field("Motivo", it) }
                        if ((b.changes ?: 0) > 0) Field("Alterações", b.changes.toString())
                    }
                }
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (ReservaRules.canConfirm(b)) {
                        SecondaryButton("Confirmar sem sinal", { vm.confirm() }, loading = vm.busy == "confirm", enabled = vm.busy == null, icon = Icons.Filled.CheckCircle, color = c.ok)
                    }
                    if (ReservaRules.canChargeDeposit(b)) {
                        SecondaryButton("Cobrar o sinal de novo", { vm.chargeDeposit() }, loading = vm.busy == "deposit", enabled = vm.busy == null, icon = Icons.Filled.CreditCard, color = c.warn)
                    }
                    if (ReservaRules.canSendCheckin(b)) {
                        SecondaryButton("Enviar check-in", { vm.sendCheckin() }, loading = vm.busy == "checkin", enabled = vm.busy == null, icon = Icons.Filled.Description, color = c.ticket)
                    }
                    if (ReservaRules.canEdit(b)) {
                        SecondaryButton("Alterar", { edit(b.id) }, enabled = vm.busy == null, icon = Icons.Filled.Edit)
                    }
                    if (ReservaRules.canCancel(b)) {
                        SecondaryButton("Cancelar", { reason = ""; askCancel = true }, loading = vm.busy == "cancel", enabled = vm.busy == null, icon = Icons.Filled.Cancel, color = c.danger)
                    }
                }
                SectionLabel("Valores", Modifier.padding(start = 0.dp))
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Field("Total", b.priceCents?.let(Money::format) ?: "—")
                        Field("Sinal", b.depositCents?.takeIf { it > 0 }?.let(Money::format) ?: "Sem sinal")
                        b.paymentStatus?.let { Field("Pagamento", ReservaRules.paymentLabel(it)) }
                        b.paymentError?.takeIf { it.isNotBlank() }?.let { Field("Cobrança", "Não saiu ($it)") }
                        if (b.state == "pending_payment") b.paymentDueAt?.let { Field("Prazo do sinal", BrasiliaTime.shortWithTime(it)) }
                        b.paidAt?.let { Field("Pago em", BrasiliaTime.shortWithTime(it)) }
                    }
                }
                SectionLabel("Check-in", Modifier.padding(start = 0.dp))
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Field("Situação", ReservaRules.checkinLabel(b.checkinStatus) + (b.checkinAt?.let { " · ${BrasiliaTime.shortWithTime(it)}" } ?: ""))
                        ReservaRules.answers(b).forEach { (label, value) -> Field(label, value) }
                    }
                }
                SectionLabel("Cliente", Modifier.padding(start = 0.dp))
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Field("Nome", b.customer)
                        PhoneText.display(b.customerPhone)?.takeIf { it != b.customer }?.let { Field("Telefone", it) }
                        b.created?.let { Field("Criada em", BrasiliaTime.shortWithTime(it)) }
                    }
                }
                b.conversationId?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                    Text("O cliente recebe pelo WhatsApp a confirmação, a alteração e o cancelamento.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
    if (askCancel) {
        AlertDialog(
            onDismissRequest = { askCancel = false },
            title = { Text("Cancelar reserva?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A unidade fica livre de novo. A devolução do sinal, se houver, é feita no painel do Mercado Pago.", color = c.textSecondary)
                    OutlinedTextField(reason, { reason = it }, label = { Text("Motivo (opcional)") }, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = { TextButton(onClick = { askCancel = false; vm.cancel(reason) }) { Text("Cancelar reserva", color = c.danger) } },
            dismissButton = { TextButton(onClick = { askCancel = false }) { Text("Voltar") } },
        )
    }
}

/**
 * Nova reserva ou alteração: unidade, período, pessoas e cliente. Ligada à conversa, o cliente recebe a confirmação no
 * WhatsApp (e o sinal, se cobrado); no balcão, nome e telefone.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReservaFormScreen(
    container: AppContainer,
    editingId: String?,
    conversationId: String?,
    customer: String?,
    unitId: String?,
    date: String?,
    onBack: () -> Unit,
    onDone: (ReservaBooking) -> Unit,
) {
    val vm: ReservaFormViewModel = viewModel(key = "reserva-form:${editingId ?: conversationId ?: "new"}:${unitId.orEmpty()}:${date.orEmpty()}") {
        ReservaFormViewModel(editingId, conversationId, customer, unitId, date, ReservaDeps.of(container))
    }
    val c = Wb.colors
    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.result) { vm.result?.let(onDone) }
    val title = if (vm.isEdit) "Alterar reserva" else "Nova reserva"
    val subtitle = if (vm.isEdit) vm.editing?.let { "${it.numberText} · ${it.customer}" } else customer ?: "No balcão"
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar(title, onBack, subtitle = subtitle, backEnabled = !vm.busy) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 24.dp)) {
            if (vm.conversationId != null && !vm.isEdit) {
                InlineNotice("Para o cliente desta conversa: ele recebe a confirmação pelo WhatsApp.", Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp), color = c.ok)
            }
            SectionLabel("Unidade")
            FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                vm.units.forEach { u -> WbFilterChip(u.displayName + if (u.isHourly) " · por hora" else "", vm.unitId == u.id, { vm.chooseUnit(u.id) }) }
            }
            if (vm.loaded && vm.units.isEmpty()) {
                Text("Nenhuma unidade ativa. Cadastre no painel, em Gestão → Unidades e regras.", Modifier.padding(16.dp), color = c.textSecondary)
            }
            SectionLabel(if (vm.isHourly) "Dia" else "Entrada")
            val today = BrasiliaTime.today()
            val days = vm.dayChoices
            val dayList = rememberLazyListState()
            // O dia escolhido (por exemplo, tocado na ocupação) fica à vista.
            LaunchedEffect(vm.startDate) { days.indexOf(vm.startDate).takeIf { it > 0 }?.let { dayList.scrollToItem(maxOf(it - 1, 0)) } }
            LazyRow(state = dayList, contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(days) { day ->
                    val label = when (day) {
                        today -> "Hoje"
                        BrasiliaTime.addDays(today, 1) -> "Amanhã"
                        else -> BrasiliaTime.compact(day)
                    }
                    WbFilterChip(label, vm.startDate == day, { vm.chooseStart(day) })
                }
            }
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (vm.isHourly) {
                    Text("Duração", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        vm.durationChoices.forEach { m -> WbFilterChip(ReservaRules.durationText(m), vm.minutes == m, { vm.changeMinutes(m) }) }
                    }
                } else {
                    Stepper("${ReservaRules.nightsText(vm.nights)} · saída ${ReservaRules.shortDay(vm.endDate)}", vm.nights, 1, ReservaFormViewModel.MAX_NIGHTS) { vm.changeNights(it) }
                }
                Stepper(ReservaRules.guestsText(vm.guests), vm.guests, 1, ReservaFormViewModel.MAX_GUESTS) { vm.changeGuests(it) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                SectionLabel(if (vm.isHourly) "Horário · ${BrasiliaTime.title(vm.startDate)}" else "Disponibilidade")
                if (vm.loadingAvailability) CircularProgressIndicator(Modifier.size(16.dp), color = c.brand, strokeWidth = 2.dp)
            }
            if (vm.isHourly) {
                if (vm.slots.isEmpty() && !vm.loadingAvailability) {
                    Text("Nenhum horário livre neste dia. Escolha outro dia ou outra duração.", Modifier.padding(horizontal = 16.dp), color = c.textSecondary)
                }
                FlowRow(Modifier.padding(horizontal = 16.dp).testTag("reserva.slots"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    vm.slots.forEach { s -> WbFilterChip(s.clock, vm.slot?.starts == s.starts, { vm.slot = s }) }
                }
                vm.slot?.priceCents?.let { Text("Valor: ${Money.format(it)}", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), color = c.textSecondary) }
            } else {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    vm.daily.forEachIndexed { index, option ->
                        if (index > 0) HorizontalDivider(color = c.hairline)
                        DailyOptionRow(option, vm.unitId == option.unitId) { vm.chooseUnit(option.unitId) }
                    }
                    if (vm.daily.isEmpty() && !vm.loadingAvailability) {
                        Text("Nenhuma unidade por diária.", Modifier.padding(16.dp), color = c.textSecondary)
                    }
                }
                if (vm.ownBooking) {
                    Text("A disponibilidade conta esta própria reserva como ocupada. O Wabotia confere de novo ao salvar.", Modifier.padding(horizontal = 16.dp, vertical = 6.dp), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (vm.conversationId == null) {
                SectionLabel("Cliente")
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(vm.customerName, { vm.customerName = it }, label = { Text("Nome") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("reserva.name"))
                    OutlinedTextField(
                        vm.customerPhone, { vm.customerPhone = it }, label = { Text("Telefone (opcional)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth(),
                    )
                    if (!vm.isEdit) {
                        Text("Sem conversa ligada, o cliente não recebe confirmação, cobrança do sinal nem check-in pelo WhatsApp.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (!vm.isEdit) {
                OutlinedTextField(
                    vm.notes, { vm.notes = it }, label = { Text("Observação interna (opcional)") },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
                if (vm.canChargeDeposit) {
                    Row(Modifier.fillMaxWidth().clickable { vm.chargeDeposit = !vm.chargeDeposit }.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Cobrar o sinal pela conversa", color = c.textPrimary)
                            Text("A reserva fica aguardando o pagamento até o prazo das regras.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                        }
                        Switch(vm.chargeDeposit, { vm.chargeDeposit = it }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                    }
                } else if (vm.conversationId != null && vm.deposit?.available == false) {
                    vm.deposit?.message?.let { InlineNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = c.warn) }
                }
            }
            vm.notice?.let { InlineNotice(it, Modifier.padding(16.dp).testTag("reserva.notice"), onDismiss = { vm.notice = null }) }
            PrimaryButton(
                if (vm.isEdit) "Salvar alteração" else "Reservar",
                { vm.submit() },
                Modifier.padding(16.dp).widthIn(max = 520.dp).fillMaxWidth().testTag("reserva.submit"),
                loading = vm.busy,
                enabled = vm.canSubmit,
                icon = Icons.Filled.Hotel,
            )
        }
    }
}

@Composable
private fun DailyOptionRow(option: ReservaDailyOption, selected: Boolean, onClick: () -> Unit) {
    val c = Wb.colors
    val available = option.available != false
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (available) Icons.Filled.CheckCircle else Icons.Filled.Cancel, contentDescription = null, tint = if (available) c.ok else c.muted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(option.name ?: "Unidade", color = c.textPrimary, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium)
            val detail = if (!available) option.message ?: "Indisponível"
            else option.depositCents?.takeIf { it > 0 }?.let { "Sinal de ${Money.format(it)}" } ?: option.capacity?.let { "até ${ReservaRules.guestsText(it)}" }
            detail?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
        }
        option.priceCents?.let { Text(Money.format(it), color = c.textPrimary, fontWeight = FontWeight.SemiBold) }
        if (selected) {
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Filled.CheckCircle, contentDescription = "Escolhida", tint = c.brand, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Stepper(label: String, value: Int, min: Int, max: Int, onChange: (Int) -> Unit) {
    val c = Wb.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = c.textPrimary)
        IconButton(onClick = { onChange(value - 1) }, enabled = value > min) { Icon(Icons.Filled.Remove, contentDescription = "Menos", tint = if (value > min) c.brand else c.muted) }
        Text(value.toString(), Modifier.width(32.dp), color = c.textPrimary, fontWeight = FontWeight.SemiBold, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        IconButton(onClick = { onChange(value + 1) }, enabled = value < max) { Icon(Icons.Filled.Add, contentDescription = "Mais", tint = if (value < max) c.brand else c.muted) }
    }
}
