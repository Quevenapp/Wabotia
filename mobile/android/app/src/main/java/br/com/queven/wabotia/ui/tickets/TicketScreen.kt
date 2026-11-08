@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.tickets

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.PresenceEntry
import br.com.queven.wabotia.core.push.Notifications
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.core.model.TicketDetail
import br.com.queven.wabotia.core.model.TicketUpdate
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset

/** Pedido PATCH pendente: mesma chave e mesmo corpo ao repetir após falha de rede (docs/API.md). */
data class PendingUpdate(val key: String, val body: JsonObject, val description: String)

class TicketViewModel(private val container: AppContainer, private val profileId: String, private val ticketId: String) : ViewModel() {
    var detail by mutableStateOf<TicketDetail?>(null)
        private set
    var presence by mutableStateOf<List<PresenceEntry>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var actionError by mutableStateOf<String?>(null)
        private set
    var info by mutableStateOf<String?>(null)
        private set
    var pending by mutableStateOf<PendingUpdate?>(null)
        private set

    private var started = false

    val ticket: Ticket? get() = detail?.ticket
    val myId: String? get() = container.session.user?.id
    val canEdit: Boolean
        get() {
            val t = ticket ?: return false
            val user = container.session.user ?: return false
            return user.isAdmin || t.owner == user.id
        }

    fun start() {
        if (!started) load()
    }

    /** Recarga disparada por evento: não mostra o indicador nem substitui o erro exibido enquanto um pedido está em curso. */
    fun reloadSilently() {
        if (profileId.isBlank() || busy) return
        viewModelScope.launch {
            try {
                detail = container.api.ticket(profileId, ticketId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.isUnauthorized) container.describeError(e)
            } catch (_: Exception) {
                // Falha momentânea: a próxima rodada de eventos ou o botão Atualizar tenta de novo.
            }
        }
    }

    fun load() {
        if (profileId.isBlank()) { error = "Perfil não selecionado."; return }
        viewModelScope.launch {
            loading = true
            error = null
            try {
                coroutineScope {
                    val d = async { container.api.ticket(profileId, ticketId) }
                    val p = async { runCatching { container.api.presence(profileId) }.getOrNull() }
                    detail = d.await()
                    p.await()?.let { presence = it }
                }
                started = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.describeError(e)
            } finally {
                loading = false
            }
        }
    }

    fun ownerName(owner: String?): String {
        if (owner.isNullOrBlank()) return "Sem responsável"
        presence.firstOrNull { it.actor == owner }?.name?.takeIf { it.isNotBlank() }?.let { return it }
        container.session.user?.takeIf { it.id == owner }?.let { return it.name.ifBlank { "Você" } }
        return "Atendente ${owner.take(8)}"
    }

    fun actorName(actor: String): String = when {
        actor.isBlank() -> ""
        actor == "system" -> "Sistema"
        else -> ownerName(actor)
    }

    fun registerProgress(text: String) = update(buildJsonObject { put("text", text.trim()) }, "registrar andamento")
    fun changeStatus(status: String) = update(buildJsonObject { put("status", status) }, "mudar estado")
    fun changeOwner(owner: String) = update(buildJsonObject { put("owner", owner) }, "mudar responsável")
    fun setDue(ms: Long) = update(buildJsonObject { put("response_due_at", ms) }, "ajustar prazo")
    fun clearDue() = update(buildJsonObject { put("response_due_at", JsonNull) }, "remover prazo")

    private fun update(body: JsonObject, description: String) {
        send(PendingUpdate(ApiClient.newIdempotencyKey(), body, description))
    }

    fun retryPending() {
        pending?.let { send(it) }
    }

    fun dismissPending() {
        pending = null
        actionError = null
    }

    fun clearInfo() { info = null }

    private fun send(request: PendingUpdate) {
        if (busy) return
        viewModelScope.launch {
            busy = true
            actionError = null
            try {
                val updated = container.api.updateTicket(profileId, ticketId, request.key, request.body)
                pending = null
                detail = detail?.copy(ticket = updated) ?: TicketDetail(ticket = updated)
                info = "Protocolo atualizado."
                // Recarrega para trazer a linha do tempo (andamentos) atualizada.
                runCatching { container.api.ticket(profileId, ticketId) }.getOrNull()?.let { detail = it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.isIdempotencyConflict) {
                    pending = null
                    actionError = "O servidor já recebeu um pedido diferente com a mesma chave. Tente de novo."
                } else {
                    pending = null
                    actionError = container.describeError(e)
                }
            } catch (e: IOException) {
                // Falha de rede: mantém o pedido com a mesma chave para repetir.
                pending = request
                actionError = ApiClient.describe(e) + " Você pode repetir o pedido (${request.description})."
            } catch (e: Exception) {
                pending = null
                actionError = ApiClient.describe(e)
            } finally {
                busy = false
            }
        }
    }
}

/** Detalhe do protocolo: dados, conversa, responsável, prazo, estado, andamento e linha do tempo. */
@Composable
fun TicketScreen(container: AppContainer, ticketId: String, onBack: () -> Unit, openConversation: (String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: TicketViewModel = viewModel(key = "ticket-$profileId-$ticketId") { TicketViewModel(container, profileId, ticketId) }
    LaunchedEffect(vm) { vm.start() }

    // Abrir o protocolo (inclusive pelo push `type=ticket`) limpa a notificação dele e atualiza o resumo/badge "Protocolos".
    val context = LocalContext.current
    LaunchedEffect(ticketId) { Notifications.cancelTicket(context, ticketId) }

    // Em primeiro plano, eventos `ticket.*` deste protocolo (outro atendente mudou estado/responsável) recarregam o detalhe.
    TicketEventPolling(container, profileId) { event -> if (event.resource_id == ticketId) vm.reloadSilently() }

    var progressText by rememberSaveable { mutableStateOf("") }
    var showOwnerDialog by remember { mutableStateOf(false) }
    var showCloseConfirm by remember { mutableStateOf(false) }
    var dueStep by remember { mutableStateOf(0) } // 0 fechado, 1 data, 2 hora
    var dueDateMillis by remember { mutableStateOf<Long?>(null) }

    // Mensagem informativa some sozinha depois de alguns segundos.
    LaunchedEffect(vm.info) {
        if (vm.info != null) {
            kotlinx.coroutines.delay(3000)
            vm.clearInfo()
        }
    }

    val ticket = vm.ticket
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(ticket?.number?.ifBlank { null } ?: "Protocolo")
                        if (ticket != null) Text(ticketStatusLabel(ticket.status), style = MaterialTheme.typography.labelMedium, color = ticketStatusColor(ticket.status))
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar") }
                },
                actions = {
                    IconButton(onClick = { vm.load() }, enabled = !vm.loading) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar") }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when {
                vm.loading && ticket == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                vm.error != null && ticket == null -> Column(
                    Modifier.fillMaxSize().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(vm.error ?: "", color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { vm.load() }) { Text("Tentar novamente") }
                }
                ticket != null -> TicketBody(
                    vm = vm,
                    ticket = ticket,
                    detail = vm.detail!!,
                    progressText = progressText,
                    onProgressChange = { progressText = it },
                    onSendProgress = {
                        if (progressText.isNotBlank()) {
                            vm.registerProgress(progressText)
                            progressText = ""
                        }
                    },
                    onOpenConversation = { openConversation(ticket.conversation_id) },
                    onChangeOwner = { showOwnerDialog = true },
                    onChangeStatus = { s -> if (s == "closed") showCloseConfirm = true else vm.changeStatus(s) },
                    onAdjustDue = { dueStep = 1 },
                    onClearDue = { vm.clearDue() },
                )
            }
            if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }

    if (showOwnerDialog && ticket != null) {
        OwnerDialog(
            entries = vm.presence,
            current = ticket.owner,
            onDismiss = { showOwnerDialog = false },
            onPick = { owner -> showOwnerDialog = false; vm.changeOwner(owner) },
        )
    }

    if (showCloseConfirm) {
        AlertDialog(
            onDismissRequest = { showCloseConfirm = false },
            title = { Text("Concluir protocolo?") },
            text = { Text("O protocolo passa para Concluído. O prazo deixa de ser acompanhado.") },
            confirmButton = { TextButton(onClick = { showCloseConfirm = false; vm.changeStatus("closed") }) { Text("Concluir") } },
            dismissButton = { TextButton(onClick = { showCloseConfirm = false }) { Text("Cancelar") } },
        )
    }

    if (dueStep == 1 && ticket != null) {
        val initial = (ticket.response_due_at ?: (System.currentTimeMillis() + 60L * 60L * 1000L))
        val initialUtcDay = Instant.ofEpochMilli(initial).atZone(ZoneId.systemDefault()).toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val dateState = rememberDatePickerState(initialSelectedDateMillis = initialUtcDay)
        DatePickerDialog(
            onDismissRequest = { dueStep = 0 },
            confirmButton = {
                TextButton(
                    onClick = {
                        dueDateMillis = dateState.selectedDateMillis
                        dueStep = if (dueDateMillis != null) 2 else 0
                    },
                ) { Text("Avançar") }
            },
            dismissButton = { TextButton(onClick = { dueStep = 0 }) { Text("Cancelar") } },
        ) {
            DatePicker(state = dateState, title = { Text("Prazo da primeira resposta", Modifier.padding(start = 24.dp, top = 16.dp)) })
        }
    }

    if (dueStep == 2 && ticket != null) {
        val base = Instant.ofEpochMilli(ticket.response_due_at ?: (System.currentTimeMillis() + 60L * 60L * 1000L)).atZone(ZoneId.systemDefault())
        val timeState = rememberTimePickerState(initialHour = base.hour, initialMinute = base.minute, is24Hour = true)
        AlertDialog(
            onDismissRequest = { dueStep = 0 },
            title = { Text("Horário do prazo") },
            text = { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TimePicker(state = timeState) } },
            confirmButton = {
                TextButton(
                    onClick = {
                        val day = dueDateMillis
                        if (day != null) {
                            val date: LocalDate = Instant.ofEpochMilli(day).atZone(ZoneOffset.UTC).toLocalDate()
                            val local = LocalDateTime.of(date, LocalTime.of(timeState.hour, timeState.minute))
                            vm.setDue(local.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli())
                        }
                        dueStep = 0
                    },
                ) { Text("Salvar prazo") }
            },
            dismissButton = { TextButton(onClick = { dueStep = 1 }) { Text("Voltar") } },
        )
    }
}

@Composable
private fun TicketBody(
    vm: TicketViewModel,
    ticket: Ticket,
    detail: TicketDetail,
    progressText: String,
    onProgressChange: (String) -> Unit,
    onSendProgress: () -> Unit,
    onOpenConversation: () -> Unit,
    onChangeOwner: () -> Unit,
    onChangeStatus: (String) -> Unit,
    onAdjustDue: () -> Unit,
    onClearDue: () -> Unit,
) {
    val tone = ticket.dueTone()
    val canEdit = vm.canEdit
    val dueEditable = ticket.first_response_at == null && ticket.status != "closed"
    val conv = detail.conversation
    val contactName = conv?.string("contact_name")?.takeIf { it.isNotBlank() }
    val phone = conv?.string("phone")?.takeIf { it.isNotBlank() }
    val convTitle = contactName ?: conv?.string("title")?.takeIf { it.isNotBlank() } ?: phone ?: conv?.string("external_id") ?: "Conversa"
    val convSubtitle = listOfNotNull(
        phone?.takeIf { it != convTitle },
        conv?.string("state")?.let { conversationStateLabel(it) },
        conv?.string("owner")?.let { "com ${vm.ownerName(it)}" },
    ).joinToString(" · ")

    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // Erros de ação do servidor (ex.: "Somente o responsável pode alterar o protocolo.")
        if (vm.actionError != null || vm.info != null) {
            item {
                val isError = vm.actionError != null
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
                    ),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            vm.actionError ?: vm.info ?: "",
                            color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        if (vm.pending != null) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                                Button(onClick = { vm.retryPending() }, enabled = !vm.busy) { Text("Tentar novamente") }
                                TextButton(onClick = { vm.dismissPending() }) { Text("Abandonar pedido") }
                            }
                        }
                    }
                }
            }
        }

        // Dados
        item {
            Column {
                Text(ticket.title.ifBlank { "Sem título" }, style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(8.dp))
                Text(ticket.dueLabel(), color = tone.color(), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Text(
                    "Aberto ${formatWhen(ticket.created)} · Atualizado ${formatWhen(ticket.updated)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!canEdit) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Somente o responsável (ou um administrador) altera este protocolo.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // Conversa
        item {
            SectionCard(title = "Conversa") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(convTitle, style = MaterialTheme.typography.bodyLarge)
                        if (convSubtitle.isNotBlank()) Text(convSubtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedButton(onClick = onOpenConversation) {
                        Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Abrir")
                    }
                }
            }
        }

        // Responsável
        item {
            SectionCard(title = "Responsável") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(vm.ownerName(ticket.owner), style = MaterialTheme.typography.bodyLarge)
                        val present = vm.presence.firstOrNull { it.actor == ticket.owner }?.present
                        if (present != null) Text(if (present == 1) "Presente" else "Ausente", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedButton(onClick = onChangeOwner, enabled = canEdit && !vm.busy) { Text("Alterar") }
                }
            }
        }

        // Estado
        item {
            SectionCard(title = "Estado") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("open", "in_progress", "closed").forEach { s ->
                        FilterChip(
                            selected = ticket.status == s,
                            onClick = { if (ticket.status != s) onChangeStatus(s) },
                            enabled = canEdit && !vm.busy,
                            label = { Text(ticketStatusLabel(s)) },
                        )
                    }
                }
            }
        }

        // Prazo
        item {
            SectionCard(title = "Prazo da primeira resposta") {
                Text(
                    if (ticket.response_due_at != null) formatWhen(ticket.response_due_at) else "Sem prazo definido",
                    color = tone.color(),
                    style = MaterialTheme.typography.bodyLarge,
                )
                if (ticket.first_response_at != null) {
                    Text("Primeira resposta ${formatWhen(ticket.first_response_at)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.height(8.dp))
                if (dueEditable) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = onAdjustDue, enabled = canEdit && !vm.busy) { Text(if (ticket.response_due_at != null) "Ajustar" else "Definir prazo") }
                        if (ticket.response_due_at != null) {
                            TextButton(onClick = onClearDue, enabled = canEdit && !vm.busy) { Text("Remover prazo") }
                        }
                    }
                } else {
                    Text(
                        if (ticket.status == "closed") "O prazo não pode ser alterado em protocolos concluídos." else "O prazo só pode ser alterado antes da primeira resposta.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // Registrar andamento
        item {
            SectionCard(title = "Registrar andamento") {
                OutlinedTextField(
                    value = progressText,
                    onValueChange = onProgressChange,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    maxLines = 6,
                    enabled = canEdit && !vm.busy,
                    label = { Text("Mensagem ao cliente") },
                    supportingText = {
                        Text("Enviado à conversa como “Protocolo ${ticket.number.ifBlank { "WA-…" }}: sua mensagem” e registrado na linha do tempo.")
                    },
                )
                Spacer(Modifier.height(8.dp))
                Button(onClick = onSendProgress, enabled = canEdit && !vm.busy && progressText.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                    Text("Registrar andamento")
                }
            }
        }

        // Linha do tempo
        item {
            Text("Linha do tempo", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp))
        }
        if (detail.updates.isEmpty()) {
            item {
                Text("Nenhum andamento registrado.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            items(detail.updates.sortedByDescending { it.created }, key = { it.id }) { u ->
                TimelineRow(u, vm.actorName(u.actor))
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun TimelineRow(u: TicketUpdate, actor: String) {
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(actor.ifBlank { "Atendente" }, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            Text(formatWhen(u.created), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(2.dp))
        Text(u.text, style = MaterialTheme.typography.bodyMedium)
        if (u.internal == 1) Text("Interno", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        HorizontalDivider()
    }
}

@Composable
private fun OwnerDialog(entries: List<PresenceEntry>, current: String?, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var selected by remember { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Responsável pelo protocolo") },
        text = {
            if (entries.isEmpty()) {
                Text("Nenhuma pessoa encontrada neste perfil.")
            } else {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    entries.sortedWith(compareByDescending<PresenceEntry> { it.present }.thenBy { it.name.lowercase() }).forEach { p ->
                        Row(
                            Modifier.fillMaxWidth().clickable { selected = p.actor }.padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = selected == p.actor, onClick = { selected = p.actor })
                            Column(Modifier.weight(1f)) {
                                Text(p.name.ifBlank { p.actor })
                                Text(
                                    if (p.present == 1) "Presente" else "Ausente",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (p.present == 1) TicketDone else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { selected?.let(onPick) }, enabled = selected != null && selected != current) { Text("Atribuir") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

private fun conversationStateLabel(state: String) = when (state) {
    "ai" -> "Com a IA"
    "waiting" -> "Na fila"
    "human" -> "Com atendente"
    "closed" -> "Concluída"
    else -> state
}
