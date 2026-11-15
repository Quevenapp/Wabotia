package br.com.queven.wabotia.modules.agenda

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
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
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb

/** A cor de cada estado do agendamento (sempre com o texto ao lado: nunca só cor). */
@Composable
internal fun appointmentColor(state: String): Color {
    val c = Wb.colors
    return when (state) {
        "confirmed" -> c.ok
        "cancelled" -> c.muted
        "no_show" -> c.danger
        else -> c.brand
    }
}

/** Agenda do dia (por profissional) ou da semana, com filtro e "Novo agendamento". */
@Composable
fun AgendaScreen(container: AppContainer, onBack: () -> Unit, openAppointment: (String) -> Unit, newBooking: () -> Unit) {
    val vm: AgendaViewModel = viewModel { AgendaViewModel(AgendaDeps.of(container), container) }
    val c = Wb.colors
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            DetailTopBar("Agenda", onBack, subtitle = "Agendamentos por profissional", actions = {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = newBooking,
                containerColor = c.brand,
                contentColor = c.onBrand,
                modifier = Modifier.navigationBarsPadding().testTag("agenda.new"),
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("Novo agendamento") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SegmentedTabs(
                AgendaViewModel.Mode.entries.map { it to it.label },
                vm.mode,
                { vm.changeMode(it) },
                Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp),
            )
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { vm.shift(-1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Anterior", tint = c.textPrimary) }
                Text(
                    if (vm.mode == AgendaViewModel.Mode.DAY) BrasiliaTime.title(vm.day)
                    else "Semana de ${BrasiliaTime.compact(vm.rangeStart)} a ${BrasiliaTime.compact(BrasiliaTime.addDays(vm.rangeStart, 6))}",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall,
                    color = c.textPrimary,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (vm.day != BrasiliaTime.today()) TextButton(onClick = { vm.goToday() }) { Text("Hoje", color = c.brand) }
                IconButton(onClick = { vm.shift(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Próximo", tint = c.textPrimary) }
            }
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { WbFilterChip("Todos", vm.professionalId == null, { vm.professionalId = null }) }
                items(vm.professionals, key = { it.id }) { p -> WbFilterChip(p.displayName, vm.professionalId == p.id, { vm.professionalId = p.id }) }
                item { WbFilterChip("Cancelados", vm.showCancelled, { vm.showCancelled = !vm.showCancelled }, tone = c.muted) }
            }
            Spacer(Modifier.height(4.dp))
            when {
                vm.loading && vm.appointments.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                vm.error != null && vm.appointments.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.mode == AgendaViewModel.Mode.DAY -> DayList(vm.columns, openAppointment)
                else -> WeekList(vm.week, openAppointment)
            }
        }
    }
}

@Composable
private fun DayList(columns: List<Pair<AgendaProfessional, List<Appointment>>>, open: (String) -> Unit) {
    if (columns.isEmpty()) {
        EmptyState(Icons.Filled.EventBusy, "Nenhum profissional na agenda", subtitle = "Os profissionais e serviços são cadastrados no painel, em Gestão → Serviços e horários.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        columns.forEach { (professional, items) ->
            item("p:${professional.id}") { SectionLabel("${professional.displayName} · ${countText(items.size)}") }
            if (items.isEmpty()) item("e:${professional.id}") {
                Text("Dia livre", Modifier.padding(horizontal = 20.dp, vertical = 4.dp), color = Wb.colors.textSecondary, style = MaterialTheme.typography.bodyMedium)
            }
            items(items, key = { it.id }) { AppointmentRow(it, showDay = false) { open(it.id) } }
        }
    }
}

@Composable
private fun WeekList(days: List<Pair<String, List<Appointment>>>, open: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        days.forEach { (day, items) ->
            item("d:$day") { SectionLabel("${BrasiliaTime.title(day)} · ${countText(items.size)}") }
            items(items, key = { it.id }) { AppointmentRow(it, showDay = false, showProfessional = true) { open(it.id) } }
        }
    }
}

private fun countText(n: Int) = when (n) {
    0 -> "livre"
    1 -> "1 agendamento"
    else -> "$n agendamentos"
}

@Composable
private fun AppointmentRow(a: Appointment, showDay: Boolean, showProfessional: Boolean = false, onClick: () -> Unit) {
    val c = Wb.colors
    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("agenda.appointment"), onClick = onClick) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(64.dp)) {
                Text(a.clock, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = if (a.state == "cancelled") c.muted else c.textPrimary)
                if (showDay) Text(BrasiliaTime.compact(a.day), fontSize = 12.sp, color = c.textSecondary)
            }
            Column(Modifier.weight(1f)) {
                Text(a.customer, color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val detail = listOfNotNull(a.serviceName, if (showProfessional) a.professionalName else null).joinToString(" · ")
                if (detail.isNotEmpty()) Text(detail, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Pill(AgendaRules.statusLabel(a.state), appointmentColor(a.state))
        }
    }
}

/** Detalhe do agendamento: confirmar, remarcar, marcar ausência e cancelar. */
@Composable
fun AppointmentScreen(container: AppContainer, id: String, onBack: () -> Unit, move: (String) -> Unit, openConversation: (String) -> Unit) {
    val vm: AppointmentViewModel = viewModel(key = "appointment:$id") { AppointmentViewModel(id, AgendaDeps.of(container), container) }
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
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar("Agendamento", onBack, subtitle = vm.appointment?.let { BrasiliaTime.title(it.day) }) },
    ) { padding ->
        val a = vm.appointment
        when {
            a == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            a == null -> ErrorState(vm.notice ?: "Agendamento não encontrado.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(a.clock, fontSize = 30.sp, fontWeight = FontWeight.Black, color = c.textPrimary, modifier = Modifier.weight(1f))
                            Pill(AgendaRules.statusLabel(a.state), appointmentColor(a.state))
                        }
                        Text(BrasiliaTime.title(a.day) + (AgendaRules.duration(a)?.let { " · $it" } ?: ""), color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
                        Field("Cliente", a.customer)
                        PhoneText.display(a.customerPhone)?.takeIf { it != a.customer }?.let { Field("Telefone", it) }
                        Field("Serviço", a.serviceName ?: "—")
                        Field("Profissional", a.professionalName ?: "Qualquer um")
                        a.priceCents?.takeIf { it > 0 }?.let { Field("Valor", Money.format(it)) }
                        a.notes?.takeIf { it.isNotBlank() }?.let { Field("Observação", it) }
                        a.cancelReason?.takeIf { it.isNotBlank() && a.state == "cancelled" }?.let { Field("Motivo do cancelamento", it) }
                        if ((a.moves ?: 0) > 0) Field("Remarcações", a.moves.toString())
                    }
                }
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                if (AgendaRules.canConfirm(a)) {
                    PrimaryButton("Confirmar", { vm.confirm() }, loading = vm.busy == "confirm", enabled = vm.busy == null, icon = Icons.Filled.CheckCircle, color = c.ok)
                }
                if (AgendaRules.canMove(a)) {
                    SecondaryButton("Remarcar", { move(a.id) }, enabled = vm.busy == null, icon = Icons.Filled.Schedule)
                }
                if (AgendaRules.canMarkNoShow(a)) {
                    SecondaryButton("Marcar ausência", { vm.noShow() }, loading = vm.busy == "no-show", enabled = vm.busy == null, icon = Icons.Filled.PersonOff, color = c.warn)
                }
                if (AgendaRules.canCancel(a)) {
                    SecondaryButton("Cancelar agendamento", { askCancel = true }, enabled = vm.busy == null, icon = Icons.Filled.Cancel, color = c.danger)
                }
                a.conversationId?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
                if (a.conversationId != null) {
                    Text("O cliente recebe pelo WhatsApp o aviso de remarcação e de cancelamento.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
    if (askCancel) {
        AlertDialog(
            onDismissRequest = { askCancel = false },
            title = { Text("Cancelar agendamento?") },
            text = {
                OutlinedTextField(reason, { reason = it }, label = { Text("Motivo (opcional)") }, modifier = Modifier.fillMaxWidth())
            },
            confirmButton = { TextButton(onClick = { askCancel = false; vm.cancel(reason) }) { Text("Cancelar agendamento", color = c.danger) } },
            dismissButton = { TextButton(onClick = { askCancel = false }) { Text("Voltar") } },
        )
    }
}

@Composable
internal fun Field(label: String, value: String) {
    val c = Wb.colors
    Row {
        Text(label, Modifier.width(120.dp), color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
        Text(value, Modifier.weight(1f), color = c.textPrimary, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Novo agendamento ou remarcação: serviço, profissional, dia e um dos horários livres. Ligado à conversa, o cliente
 * recebe a confirmação no WhatsApp; no balcão, nome e telefone.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BookingScreen(
    container: AppContainer,
    movingId: String?,
    conversationId: String?,
    customer: String?,
    onBack: () -> Unit,
    onDone: (Appointment) -> Unit,
) {
    val vm: BookingViewModel = viewModel(key = "booking:${movingId ?: conversationId ?: "new"}") {
        BookingViewModel(movingId, conversationId, customer, AgendaDeps.of(container))
    }
    val c = Wb.colors
    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.result) { vm.result?.let(onDone) }
    val title = if (vm.isMove) "Remarcar" else "Novo agendamento"
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            DetailTopBar(title, onBack, subtitle = if (vm.isMove) vm.moving?.customer else customer ?: "No balcão", backEnabled = !vm.busy)
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 24.dp),
        ) {
            if (!vm.isMove) {
                SectionLabel("Serviço")
                FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    vm.services.forEach { s ->
                        val price = s.priceCents?.takeIf { it > 0 }?.let { " · ${Money.format(it)}" }.orEmpty()
                        WbFilterChip("${s.displayName}$price", vm.serviceId == s.id, { vm.chooseService(s.id) })
                    }
                }
                if (vm.catalog != null && vm.services.isEmpty()) {
                    Text("Nenhum serviço ativo. Cadastre no painel, em Gestão → Serviços e horários.", Modifier.padding(16.dp), color = c.textSecondary)
                }
            } else {
                vm.moving?.let { m ->
                    InlineNotice("Hoje: ${BrasiliaTime.title(m.day)} às ${m.clock}, ${m.serviceName ?: "serviço"}.", Modifier.padding(16.dp), color = c.brand)
                }
            }
            SectionLabel("Profissional")
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { WbFilterChip("Qualquer um", vm.professionalId == null, { vm.chooseProfessional(null) }) }
                items(vm.professionals, key = { it.id }) { p -> WbFilterChip(p.displayName, vm.professionalId == p.id, { vm.chooseProfessional(p.id) }) }
            }
            SectionLabel("Dia")
            val today = BrasiliaTime.today()
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items((0 until 31).map { BrasiliaTime.addDays(today, it) }) { day ->
                    WbFilterChip(if (day == today) "Hoje" else BrasiliaTime.compact(day), vm.day == day, { vm.chooseDay(day) })
                }
            }
            SectionLabel("Horário · ${BrasiliaTime.title(vm.day)}")
            when {
                vm.loadingSlots -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), color = c.brand) }
                vm.slots.isEmpty() -> Text("Nenhum horário livre neste dia. Escolha outro dia ou outro profissional.", Modifier.padding(horizontal = 16.dp), color = c.textSecondary)
                else -> FlowRow(Modifier.padding(horizontal = 16.dp).testTag("agenda.slots"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    vm.slots.forEach { slot -> WbFilterChip(slot.clock, vm.slot?.starts == slot.starts, { vm.slot = slot }) }
                }
            }
            vm.slot?.let { slot ->
                vm.professionalName(slot)?.let { Text("Com $it", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), color = c.textSecondary) }
            }
            if (!vm.isMove && vm.conversationId == null) {
                SectionLabel("Cliente")
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(vm.customerName, { vm.customerName = it }, label = { Text("Nome") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(
                        vm.customerPhone, { vm.customerPhone = it }, label = { Text("Telefone (opcional)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (!vm.isMove) {
                OutlinedTextField(
                    vm.notes, { vm.notes = it }, label = { Text("Observação (opcional)") },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            vm.notice?.let { InlineNotice(it, Modifier.padding(16.dp), onDismiss = { vm.notice = null }) }
            PrimaryButton(
                if (vm.isMove) "Remarcar" else "Agendar",
                { vm.submit() },
                Modifier.padding(16.dp).widthIn(max = 520.dp).fillMaxWidth(),
                loading = vm.busy,
                enabled = vm.canSubmit,
                icon = Icons.Filled.EventAvailable,
            )
            if (vm.conversationId != null && !vm.isMove) {
                Text("O cliente recebe a confirmação na conversa e o lembrete antes do horário.", Modifier.padding(horizontal = 16.dp), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
