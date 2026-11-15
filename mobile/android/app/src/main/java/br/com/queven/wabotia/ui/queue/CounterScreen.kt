package br.com.queven.wabotia.ui.queue

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Shortcut
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Desk
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Queue
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.queue.CounterInfo
import br.com.queven.wabotia.queue.QueueInfo
import br.com.queven.wabotia.queue.QueueOverview
import br.com.queven.wabotia.queue.QueueTicket
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SheetAction
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.formatPhone
import br.com.queven.wabotia.ui.components.formatTime
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.theme.Wb

/**
 * Guichê da fila de senhas (docs/FILA-SENHAS.md) dentro do app logado: escolher o guichê deste aparelho, abrir, pausar
 * e fechar, chamar a próxima e cuidar da senha atual (rechamar, iniciar, concluir, ausente, transferir).
 */
@Composable
fun CounterScreen(container: AppContainer, onBack: () -> Unit, openConversation: (String) -> Unit) {
    val profileId = container.session.profileId.orEmpty()
    val vm: CounterViewModel = viewModel(key = "counter:$profileId") { CounterViewModel(container) }
    val state by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val haptics = rememberHaptics()
    var choosing by remember { mutableStateOf(false) }
    var transferring by remember { mutableStateOf(false) }
    val c = Wb.colors

    // Ao vivo só enquanto a tela está à frente.
    LifecycleResumeEffect(vm) {
        vm.start()
        onPauseOrDispose { vm.stop() }
    }
    LaunchedEffect(state.message) {
        val msg = state.message ?: return@LaunchedEffect
        vm.consumeMessage()
        haptics.tick()
        snackbar.showSnackbar(msg)
    }

    val counter = state.counter
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DetailTopBar(
                title = counter?.name ?: "Guichê",
                subtitle = when {
                    counter == null -> "Fila de senhas"
                    state.live -> "Fila de senhas · ao vivo"
                    else -> "Fila de senhas"
                },
                onBack = onBack,
                actions = {
                    if (counter != null) {
                        IconButton(onClick = { choosing = true }) { Icon(Icons.Filled.SwapHoriz, contentDescription = "Trocar de guichê", tint = c.textPrimary) }
                    }
                    IconButton(onClick = vm::reload) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textPrimary) }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val overview = state.overview
            when {
                overview == null && state.loading -> SkeletonList(rows = 5, avatar = false)
                overview == null -> ErrorState(state.error ?: "A fila não respondeu.", onRetry = vm::reload)
                counter == null || choosing -> CounterPicker(
                    overview = overview,
                    selected = state.counterId,
                    onChoose = { vm.chooseCounter(it); choosing = false },
                    onCancel = if (counter != null) ({ choosing = false }) else null,
                )
                else -> CounterBody(
                    overview = overview,
                    counter = counter,
                    state = state,
                    vm = vm,
                    onTransfer = { transferring = true },
                    openConversation = openConversation,
                )
            }
        }
    }

    val current = state.current
    if (transferring && current != null && state.overview != null) {
        TransferTicketSheet(
            ticket = current,
            overview = state.overview!!,
            fromCounter = state.counterId,
            onDismiss = { transferring = false },
            onTransfer = { queueId, counterId ->
                transferring = false
                vm.transfer(queueId, counterId)
            },
        )
    }
}

@Composable
private fun CounterPicker(overview: QueueOverview, selected: String?, onChoose: (String) -> Unit, onCancel: (() -> Unit)?) {
    val counters = overview.counters.orEmpty().filter { it.enabled }
    if (counters.isEmpty()) {
        EmptyState(
            Icons.Filled.Desk,
            "Nenhum guichê criado",
            subtitle = "Um administrador cria os guichês no painel do Wabotia, em Fila de senhas. Depois eles aparecem aqui.",
        )
        return
    }
    val c = Wb.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { SectionLabel("Em qual guichê você está?") }
        item {
            WbCard(Modifier.padding(horizontal = 16.dp)) {
                counters.forEachIndexed { index, counter ->
                    if (index > 0) RowDivider()
                    SettingsRow(
                        Icons.Filled.Desk,
                        counter.name,
                        subtitle = buildString {
                            append(CounterViewModel.statusLabel(counter.status))
                            counter.userName?.let { append(" · ").append(it) }
                            val names = overview.queues.orEmpty().filter { counter.queueIds.orEmpty().contains(it.id) }.joinToString { it.name }
                            if (names.isNotBlank()) append(" · ").append(names)
                        },
                        tint = statusColor(counter.status),
                        onClick = { onChoose(counter.id) },
                        trailing = if (counter.id == selected) ({ Icon(Icons.Filled.CheckCircle, contentDescription = "Escolhido", tint = c.brand) }) else null,
                        modifier = Modifier.testTag("counter.pick.${counter.id}"),
                    )
                }
            }
        }
        item {
            Text(
                "A escolha fica guardada neste aparelho. Abrir o guichê o coloca na roda de chamadas; pausar ou fechar tira.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
            )
        }
        if (onCancel != null) item { TextButton(onClick = onCancel, modifier = Modifier.padding(horizontal = 12.dp)) { Text("Cancelar") } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CounterBody(
    overview: QueueOverview,
    counter: CounterInfo,
    state: CounterUiState,
    vm: CounterViewModel,
    onTransfer: () -> Unit,
    openConversation: (String) -> Unit,
) {
    val c = Wb.colors
    val busy = state.busy
    val current = counter.current
    val queues = overview.queues.orEmpty().filter { counter.queueIds.orEmpty().contains(it.id) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        state.notice?.let { notice ->
            item("notice") { InlineNotice(notice, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), onDismiss = vm::dismissNotice) }
        }

        // --- estado do guichê ---
        item("state-label") { SectionLabel("Guichê") }
        item("state") {
            WbCard(Modifier.padding(horizontal = 16.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Pill(CounterViewModel.statusLabel(counter.status), statusColor(counter.status))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            counter.userName?.let { "Com $it" } ?: "Sem atendente",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textSecondary,
                            modifier = Modifier.weight(1f),
                        )
                        if (busy?.startsWith("state:") == true) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.brand)
                    }
                    Spacer(Modifier.height(12.dp))
                    SegmentedTabs(
                        listOf("open" to "Abrir", "paused" to "Pausar", "closed" to "Fechar"),
                        counter.status,
                        { if (busy == null) vm.setStatus(it) },
                    )
                }
            }
        }

        // --- quem espera ---
        item("waiting-label") { SectionLabel("Aguardando") }
        item("waiting") {
            WbCard(Modifier.padding(horizontal = 16.dp)) {
                if (queues.isEmpty()) {
                    Text("Este guichê não atende nenhuma fila.", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
                }
                queues.forEachIndexed { index, q ->
                    if (index > 0) RowDivider(startIndent = 16.dp)
                    QueueWaitingRow(q)
                }
            }
        }

        // --- senha atual ---
        item("current-label") { SectionLabel("Senha atual") }
        item("current") {
            WbCard(Modifier.padding(horizontal = 16.dp)) {
                if (current == null) {
                    Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Filled.ConfirmationNumber, contentDescription = null, tint = c.muted, modifier = Modifier.size(36.dp))
                        Spacer(Modifier.height(6.dp))
                        Text("Nenhuma senha neste guichê", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
                    }
                } else {
                    CurrentTicket(current, openConversation)
                }
            }
        }

        // --- ações ---
        item("actions") {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PrimaryButton(
                    "Chamar próxima",
                    onClick = vm::callNext,
                    loading = busy?.startsWith("call:") == true,
                    enabled = busy == null && counter.status == "open",
                    icon = Icons.Filled.Campaign,
                    modifier = Modifier.heightIn(min = 56.dp).testTag("counter.next"),
                )
                if (counter.status != "open") {
                    Text("Abra o guichê para chamar senhas.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp))
                }
                if (current != null && (current.status == "called" || current.status == "serving")) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ActionChip("Rechamar", Icons.Filled.Campaign, c.warn, busy, "recall:", enabled = current.status == "called") { vm.act("recall") }
                        ActionChip("Iniciar", Icons.Filled.PlayArrow, c.brand, busy, "start:", enabled = current.status == "called") { vm.act("start") }
                        ActionChip("Concluir", Icons.Filled.CheckCircle, c.ok, busy, "finish:") { vm.act("finish") }
                        ActionChip("Ausente", Icons.Filled.PersonOff, c.danger, busy, "no-show:", enabled = current.status == "called") { vm.act("no-show") }
                        ActionChip("Transferir", Icons.AutoMirrored.Filled.Shortcut, c.ticket, busy, "transfer:", onClick = onTransfer)
                    }
                }
            }
        }

        // --- últimas chamadas ---
        val recent = overview.recentCalls.orEmpty().take(5)
        if (recent.isNotEmpty()) {
            item("recent-label") { SectionLabel("Últimas chamadas") }
            item("recent") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    recent.forEachIndexed { index, call ->
                        if (index > 0) RowDivider(startIndent = 16.dp)
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(call.code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = c.textPrimary, modifier = Modifier.width(72.dp))
                            Text(
                                listOfNotNull(call.counterName, call.queueName, if (call.recall) "rechamada" else null).joinToString(" · "),
                                color = c.textSecondary,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f),
                            )
                            Text(formatTime(call.at), color = c.textSecondary, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QueueWaitingRow(q: QueueInfo) {
    val c = Wb.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Queue, contentDescription = null, tint = if (q.enabled) c.brand else c.muted, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(q.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = c.textPrimary)
            val wait = listOfNotNull(
                q.waitMinutes?.normal?.let { "normal ~$it min" },
                q.waitMinutes?.preferential?.let { "preferencial ~$it min" },
            ).joinToString(" · ")
            Text(
                if (!q.enabled) "Fila desativada" else wait.ifBlank { "${q.openCounters} guichê(s) aberto(s)" },
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }
        // A letra é a das senhas da fila (R e S na Retirada), como no painel; sem prefixo, N e P.
        CountTag(q.prefixNormal?.trim()?.ifEmpty { null } ?: "N", q.waiting?.normal ?: 0, c.brand, "normais")
        Spacer(Modifier.width(6.dp))
        CountTag(q.prefixPreferential?.trim()?.ifEmpty { null } ?: "P", q.waiting?.preferential ?: 0, c.bot, "preferenciais")
    }
}

@Composable
private fun CountTag(label: String, count: Int, color: Color, kind: String) {
    val c = Wb.colors
    Row(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(c.soft(color, 0.14f))
            .clearAndSetSemantics { contentDescription = "$count $kind aguardando" }
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = color, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        Spacer(Modifier.width(4.dp))
        Text(count.toString(), color = c.textPrimary, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    }
}

@Composable
private fun CurrentTicket(ticket: QueueTicket, openConversation: (String) -> Unit) {
    val c = Wb.colors
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                ticket.code,
                fontSize = 44.sp,
                fontWeight = FontWeight.Black,
                fontFamily = FontFamily.Monospace,
                color = c.textPrimary,
                modifier = Modifier.weight(1f).testTag("counter.current"),
            )
            Pill(CounterViewModel.ticketStatusLabel(ticket.status), if (ticket.status == "serving") c.ok else c.warn)
        }
        Text(
            listOfNotNull(ticket.queueName, ticket.typeLabel, "chamada ${ticket.callCount}×").joinToString(" · "),
            color = c.textSecondary,
            style = MaterialTheme.typography.bodyMedium,
        )
        ticket.phone?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(6.dp))
            Text(formatPhone(it), color = c.textPrimary, style = MaterialTheme.typography.bodyMedium)
        }
        if (ticket.windowOpen == false) {
            Spacer(Modifier.height(8.dp))
            InlineNotice("Fora da janela de 24h: o aviso da chamada só chega ao cliente por modelo aprovado.", color = c.warn)
        }
        ticket.conversationId?.let { id ->
            Spacer(Modifier.height(10.dp))
            SecondaryButton("Abrir conversa", onClick = { openConversation(id) }, icon = Icons.AutoMirrored.Filled.Chat)
        }
    }
}

@Composable
private fun ActionChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    color: Color,
    busy: String?,
    prefix: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val c = Wb.colors
    val running = busy?.startsWith(prefix) == true
    val active = enabled && busy == null
    Row(
        Modifier
            .clip(RoundedCornerShape(24.dp))
            .background(if (active) c.soft(color, 0.14f) else c.field)
            .clickable(enabled = active, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (running) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = color)
        else Icon(icon, contentDescription = null, tint = if (active) color else c.muted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, color = if (active) c.textPrimary else c.muted, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun TransferTicketSheet(
    ticket: QueueTicket,
    overview: QueueOverview,
    fromCounter: String?,
    onDismiss: () -> Unit,
    onTransfer: (queueId: String?, counterId: String?) -> Unit,
) {
    val c = Wb.colors
    var confirm by remember { mutableStateOf<Triple<String?, String?, String>?>(null) }
    WbBottomSheet(onDismiss = onDismiss, title = "Transferir ${ticket.code}", subtitle = "A senha volta a aguardar no destino, na ordem de emissão.") {
        val target = confirm
        if (target != null) {
            Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Transferir ${ticket.code} para ${target.third}?", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                PrimaryButton("Transferir", onClick = { onTransfer(target.first, target.second) })
                SecondaryButton("Voltar", onClick = { confirm = null })
            }
            return@WbBottomSheet
        }
        val queues = overview.queues.orEmpty().filter { it.enabled }
        val counters = overview.counters.orEmpty().filter { it.enabled && it.id != fromCounter }
        if (queues.isNotEmpty()) SectionLabel("Filas")
        queues.forEach { q ->
            SheetAction(Icons.Filled.Queue, q.name, onClick = { confirm = Triple(q.id, null, "a fila ${q.name}") }, subtitle = "${q.waiting?.total ?: 0} aguardando")
        }
        if (counters.isNotEmpty()) SectionLabel("Guichês")
        counters.forEach { other ->
            SheetAction(
                Icons.Filled.Desk,
                other.name,
                onClick = { confirm = Triple(null, other.id, other.name) },
                tint = statusColor(other.status),
                subtitle = CounterViewModel.statusLabel(other.status) + (other.userName?.let { " · $it" } ?: ""),
            )
        }
        if (queues.isEmpty() && counters.isEmpty()) {
            Text("Não há outra fila nem outro guichê para receber a senha.", color = c.textSecondary, modifier = Modifier.padding(20.dp))
        }
        Spacer(Modifier.navigationBarsPadding())
    }
}

@Composable
private fun statusColor(status: String): Color = when (status) {
    "open" -> Wb.colors.ok
    "paused" -> Wb.colors.warn
    else -> Wb.colors.muted
}
