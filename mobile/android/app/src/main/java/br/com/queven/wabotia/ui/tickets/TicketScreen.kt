@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.tickets

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.PresenceEntry
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.core.model.TicketCategory
import br.com.queven.wabotia.core.model.TicketDetail
import br.com.queven.wabotia.core.model.TicketStatus
import br.com.queven.wabotia.core.model.TicketUpdate
import br.com.queven.wabotia.core.model.nameOf
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.core.push.Notifications
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RoundIconButton
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.formatPhone
import br.com.queven.wabotia.ui.components.formatWhen
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
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
    /** Categorias de `settings.ticket_categories`; vazio em servidores 0.13 ou sem categorias configuradas. */
    var categories by mutableStateOf<List<TicketCategory>>(container.profileData.cached(profileId)?.ticketCategories().orEmpty())
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
                if (e.isUnauthorized) container.handleError(e)
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
                    val s = async { container.profileData.load(profileId) }
                    detail = d.await()
                    p.await()?.let { presence = it }
                    s.await()?.let { categories = it.ticketCategories() }
                }
                started = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
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

    /** Presença do responsável, ou null quando a pessoa não está na lista de presença. */
    fun ownerOnline(owner: String?): Boolean? = presence.firstOrNull { it.actor == owner }?.let { it.present == 1 }

    fun actorName(actor: String): String = when {
        actor.isBlank() -> ""
        actor == "system" -> "Sistema"
        else -> ownerName(actor)
    }

    fun registerProgress(text: String) = update(buildJsonObject { put("text", text.trim()) }, "registrar andamento")
    fun changeStatus(status: String) = update(buildJsonObject { put("status", status) }, "mudar estado")
    fun changeOwner(owner: String) = update(buildJsonObject { put("owner", owner) }, "mudar responsável")
    /** `null` limpa a categoria (o servidor espera `category: null` explícito). */
    fun changeCategory(category: String?) = update(buildJsonObject { if (category == null) put("category", JsonNull) else put("category", category) }, "mudar categoria")
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

    fun dismissActionError() {
        if (pending == null) actionError = null
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
                    actionError = container.handleError(e)
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

/** Detalhe do protocolo: cabeçalho com estado, responsável e prazo; conversa; linha do tempo; campo fixo de andamento. */
@Composable
fun TicketScreen(container: AppContainer, ticketId: String, onBack: () -> Unit, openConversation: (String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: TicketViewModel = viewModel(key = "ticket-$profileId-$ticketId") { TicketViewModel(container, profileId, ticketId) }
    LaunchedEffect(vm) { vm.start() }

    // Abrir o protocolo (inclusive pelo push `type=ticket`) limpa a notificação dele e atualiza o resumo/badge "Protocolos".
    val context = LocalContext.current
    LaunchedEffect(ticketId) { Notifications.cancelTicket(context, ticketId) }

    // Em primeiro plano, eventos `ticket.*` deste protocolo (outro atendente mudou estado/responsável) recarregam o detalhe.
    EventPolling(container, profileId) { events ->
        if (events.any { it.kind.startsWith("ticket.") && it.resource_id == ticketId }) vm.reloadSilently()
    }

    var progressText by rememberSaveable { mutableStateOf("") }
    var showOwnerSheet by remember { mutableStateOf(false) }
    var showCategorySheet by remember { mutableStateOf(false) }
    /** Estado final (`resolved` ou `closed`) aguardando confirmação. */
    var confirmStatus by remember { mutableStateOf<String?>(null) }
    var dueStep by remember { mutableStateOf(0) } // 0 fechado, 1 data, 2 hora
    var dueDateMillis by remember { mutableStateOf<Long?>(null) }
    val haptics = rememberHaptics()
    val now by rememberNow()
    val c = Wb.colors

    // Mensagem informativa some sozinha depois de alguns segundos.
    LaunchedEffect(vm.info) {
        if (vm.info != null) {
            delay(3000)
            vm.clearInfo()
        }
    }

    val ticket = vm.ticket
    val detail = vm.detail
    Column(Modifier.fillMaxSize().background(c.background).imePadding()) {
        DetailTopBar(
            title = ticket?.number?.ifBlank { null } ?: "Protocolo",
            onBack = onBack,
            subtitle = ticket?.let { ticketStatusLabel(it.status) },
        ) {
            IconButton(onClick = { vm.load() }, enabled = !vm.loading) {
                Icon(Icons.Filled.Refresh, contentDescription = "Atualizar protocolo", tint = c.textPrimary)
            }
        }
        Box(Modifier.fillMaxWidth().height(2.dp)) {
            if (vm.busy || (vm.loading && ticket != null)) LinearProgressIndicator(Modifier.fillMaxSize(), color = c.brand, trackColor = c.divider)
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            when {
                ticket != null && detail != null -> TicketBody(
                    vm = vm,
                    ticket = ticket,
                    detail = detail,
                    now = now,
                    onOpenConversation = { openConversation(ticket.conversation_id) },
                    onChangeOwner = { showOwnerSheet = true },
                    onChangeStatus = { s -> if (!TicketStatus.isActive(s) && ticket.isActive) confirmStatus = s else vm.changeStatus(s) },
                    onChangeCategory = { showCategorySheet = true },
                    onAdjustDue = { dueStep = 1 },
                    onClearDue = { vm.clearDue() },
                )
                vm.error != null -> ErrorState(vm.error ?: "", onRetry = { vm.load() })
                else -> SkeletonList(Modifier.fillMaxSize(), rows = 6, avatar = false)
            }
        }
        if (ticket != null) {
            ProgressComposer(
                ticket = ticket,
                value = progressText,
                onValueChange = { progressText = it },
                canEdit = vm.canEdit,
                busy = vm.busy,
                onSend = {
                    if (progressText.isNotBlank()) {
                        haptics.tick()
                        vm.registerProgress(progressText)
                        progressText = ""
                    }
                },
            )
        }
    }

    if (showOwnerSheet && ticket != null) {
        OwnerSheet(
            entries = vm.presence,
            current = ticket.owner,
            onDismiss = { showOwnerSheet = false },
            onPick = { owner -> showOwnerSheet = false; vm.changeOwner(owner) },
        )
    }

    if (showCategorySheet && ticket != null) {
        CategorySheet(
            categories = vm.categories,
            current = ticket.category,
            onDismiss = { showCategorySheet = false },
            onPick = { category -> showCategorySheet = false; vm.changeCategory(category) },
        )
    }

    confirmStatus?.let { target ->
        val resolved = target == TicketStatus.RESOLVED
        AlertDialog(
            onDismissRequest = { confirmStatus = null },
            title = { Text(if (resolved) "Marcar como resolvido?" else "Encerrar protocolo?") },
            text = { Text("O protocolo passa para ${ticketStatusLabel(target)} e deixa de contar como ativo. O prazo deixa de ser acompanhado.") },
            confirmButton = { TextButton(onClick = { confirmStatus = null; vm.changeStatus(target) }) { Text(if (resolved) "Resolver" else "Encerrar") } },
            dismissButton = { TextButton(onClick = { confirmStatus = null }) { Text("Cancelar") } },
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
    now: Long,
    onOpenConversation: () -> Unit,
    onChangeOwner: () -> Unit,
    onChangeStatus: (String) -> Unit,
    onChangeCategory: () -> Unit,
    onAdjustDue: () -> Unit,
    onClearDue: () -> Unit,
) {
    val c = Wb.colors
    val tone = ticket.dueTone(now)
    val canEdit = vm.canEdit
    val editable = canEdit && !vm.busy
    val dueEditable = ticket.first_response_at == null && ticket.isActive
    val categoryName = vm.categories.nameOf(ticket.category)
    val hasCategories = vm.categories.any { it.enabled }
    val conv = detail.conversation
    val contactName = conv?.string("contact_name")?.takeIf { it.isNotBlank() }
    val phone = conv?.string("phone")?.takeIf { it.isNotBlank() }
    val convTitle = contactName ?: conv?.string("title")?.takeIf { it.isNotBlank() } ?: phone?.let { formatPhone(it) } ?: conv?.string("external_id") ?: "Conversa"
    val isGroup = conv?.string("chat_type") == "group"
    val convSubtitle = listOfNotNull(
        phone?.takeIf { contactName != null || conv?.string("title")?.isNotBlank() == true }?.let { formatPhone(it) },
        conv?.string("state")?.let { conversationStateLabel(it) },
        conv?.string("owner")?.let { owner -> if (owner == vm.myId) "com você" else "com ${vm.ownerName(owner)}" },
    ).joinToString(" · ")
    val updates = remember(detail.updates) { detail.updates.sortedByDescending { it.created } }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
        // Erros de ação do servidor (ex.: "Somente o responsável pode alterar o protocolo.") e retorno das ações.
        val actionError = vm.actionError
        val info = vm.info
        if (actionError != null) {
            item("action-error") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) {
                    if (vm.pending != null) {
                        InlineNotice(actionError, actionLabel = "Tentar de novo", onAction = { vm.retryPending() })
                        TextButton(onClick = { vm.dismissPending() }, modifier = Modifier.align(Alignment.End)) {
                            Text("Abandonar pedido", color = c.textSecondary)
                        }
                    } else {
                        InlineNotice(actionError, onDismiss = { vm.dismissActionError() })
                    }
                }
            }
        } else if (info != null) {
            item("info") {
                InlineNotice(info, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp), color = c.ok, onDismiss = { vm.clearInfo() })
            }
        }

        // Cabeçalho: número, título, datas e seletor de estado.
        item("header") {
            WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Text(
                        ticket.number.ifBlank { "Protocolo" },
                        color = c.ticket,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.5.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(ticket.title.ifBlank { "Sem título" }, style = MaterialTheme.typography.titleLarge, color = c.textPrimary)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Aberto ${formatWhen(ticket.created)} · Atualizado ${formatWhen(ticket.updated)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                    )
                    if (categoryName != null || hasCategories) {
                        Spacer(Modifier.height(10.dp))
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(c.field)
                                .clickable(enabled = editable, role = Role.Button, onClick = onChangeCategory)
                                .heightIn(min = 48.dp)
                                .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.Category, contentDescription = null, tint = c.ticket, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text("Categoria", style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
                                Text(
                                    categoryName ?: "Sem categoria",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = if (categoryName != null) c.textPrimary else c.textSecondary,
                                )
                            }
                            if (canEdit) {
                                Spacer(Modifier.width(8.dp))
                                Text("Alterar", color = if (editable) c.brand else c.muted, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    Text("Estado", style = MaterialTheme.typography.labelMedium, color = c.textSecondary)
                    Spacer(Modifier.height(8.dp))
                    StatusSelector(
                        current = ticket.status,
                        enabled = editable,
                        onSelect = { s -> if (editable && ticket.status != s) onChangeStatus(s) },
                    )
                    if (!TicketStatus.isKnown(ticket.status)) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Estado atual: ${ticketStatusLabel(ticket.status)}. Atualize o aplicativo para ver todos os estados deste servidor.",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textSecondary,
                        )
                    }
                    if (!canEdit) {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "Somente o responsável (ou um administrador) altera este protocolo.",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textSecondary,
                        )
                    }
                }
            }
        }

        // Responsável e prazo.
        item("owner-due") {
            SectionLabel("Responsável e prazo")
            WbCard(Modifier.padding(horizontal = 16.dp)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 68.dp).padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    val online = vm.ownerOnline(ticket.owner)
                    if (ticket.owner.isNullOrBlank()) {
                        Avatar("?", seed = "sem-responsavel", size = 44.dp, ringColor = c.surface)
                    } else {
                        Avatar(vm.ownerName(ticket.owner), seed = ticket.owner, size = 44.dp, online = online, ringColor = c.surface)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(vm.ownerName(ticket.owner), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            when {
                                ticket.owner.isNullOrBlank() -> "Ninguém assumiu este protocolo"
                                online == true -> "Online"
                                online == false -> "Offline"
                                else -> "Responsável"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = if (online == true) c.ok else c.textSecondary,
                        )
                    }
                    TextButton(onClick = onChangeOwner, enabled = editable) { Text("Alterar", fontWeight = FontWeight.SemiBold) }
                }
                HorizontalDivider(Modifier.padding(start = 72.dp), color = c.hairline)
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { DueRing(ticket, now, size = 36.dp) }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Prazo da primeira resposta", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                        Text(
                            ticket.dueDetail(now),
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = if (tone == DueTone.Scheduled) c.textPrimary else tone.textColor(),
                        )
                        if (tone == DueTone.Responded && ticket.response_due_at != null) {
                            Text("Prazo era ${formatWhen(ticket.response_due_at)}", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                        }
                    }
                }
                if (dueEditable) {
                    Row(Modifier.fillMaxWidth().padding(start = 64.dp, end = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = onAdjustDue, enabled = editable) {
                            Text(if (ticket.response_due_at != null) "Ajustar" else "Definir prazo", fontWeight = FontWeight.SemiBold)
                        }
                        if (ticket.response_due_at != null) {
                            TextButton(onClick = onClearDue, enabled = editable) { Text("Remover prazo", color = if (editable) c.danger else c.muted) }
                        }
                    }
                } else {
                    Text(
                        if (!ticket.isActive) "O prazo não pode ser alterado em protocolos resolvidos ou encerrados." else "O prazo só pode ser alterado antes da primeira resposta.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                        modifier = Modifier.padding(start = 72.dp, end = 16.dp, top = 6.dp, bottom = 14.dp),
                    )
                }
            }
        }

        // Conversa.
        item("conversation") {
            SectionLabel("Conversa")
            WbCard(Modifier.padding(horizontal = 16.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(convTitle, seed = ticket.conversation_id.ifBlank { convTitle }, size = 44.dp, kind = if (isGroup) AvatarKind.Group else AvatarKind.Person, ringColor = c.surface)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(convTitle, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (convSubtitle.isNotBlank()) {
                                Text(convSubtitle, style = MaterialTheme.typography.bodySmall, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    SecondaryButton("Abrir conversa", onClick = onOpenConversation, icon = Icons.AutoMirrored.Filled.Chat, enabled = ticket.conversation_id.isNotBlank())
                }
            }
        }

        // Linha do tempo.
        item("timeline-title") { SectionLabel("Linha do tempo") }
        if (updates.isEmpty()) {
            item("timeline-empty") {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.History, contentDescription = null, tint = c.muted, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Nenhum andamento registrado.", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
                }
            }
        } else {
            itemsIndexed(updates, key = { _, u -> u.id }) { index, u ->
                TimelineRow(u, vm.actorName(u.actor), first = index == 0, last = index == updates.lastIndex)
            }
        }
    }
}

/**
 * Seletor dos seis estados em pílulas, duas por linha (cabe em 375 pt sem cortar "Aguardando terceiro"):
 * Recebido · Em análise / Aguardando cliente · Aguardando terceiro / Resolvido · Encerrado.
 */
@Composable
private fun StatusSelector(current: String, enabled: Boolean, onSelect: (String) -> Unit) {
    val c = Wb.colors
    Column(Modifier.fillMaxWidth().alpha(if (enabled) 1f else 0.6f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TicketStatus.all.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                pair.forEach { status ->
                    val selected = status == current
                    val color = ticketStatusColor(status)
                    Row(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 44.dp)
                            .clip(CircleShape)
                            .background(if (selected) c.soft(color, 0.18f) else c.field)
                            .then(if (selected) Modifier.border(1.5.dp, color, CircleShape) else Modifier)
                            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton) { onSelect(status) }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        if (selected) {
                            Icon(Icons.Filled.Check, contentDescription = null, tint = color, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(4.dp))
                        } else {
                            Box(Modifier.size(8.dp).background(color, CircleShape))
                            Spacer(Modifier.width(7.dp))
                        }
                        Text(
                            ticketStatusLabel(status),
                            color = c.textPrimary,
                            fontSize = 13.sp,
                            lineHeight = 16.sp,
                            // Mesmo peso nos dois estados: o selecionado se distingue pelo contorno, fundo e check, e o
                            // rótulo mais longo ("Aguardando terceiro") continua em uma linha.
                            fontWeight = FontWeight.Medium,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                        )
                    }
                }
            }
        }
    }
}

/** Folha de escolha da categoria: "Sem categoria" + habilitadas (+ a atual, se foi desabilitada ou removida). */
@Composable
private fun CategorySheet(categories: List<TicketCategory>, current: String?, onDismiss: () -> Unit, onPick: (String?) -> Unit) {
    val c = Wb.colors
    val options: List<Pair<String?, String>> = buildList {
        add(null to "Sem categoria")
        categories.filter { it.enabled || it.id == current }.forEach { add(it.id to it.name) }
        if (current != null && categories.none { it.id == current }) add(current to current)
    }
    WbBottomSheet(onDismiss = onDismiss, title = "Categoria do protocolo", subtitle = "Aplicativo ou assunto a que a solicitação se refere.") {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
            itemsIndexed(options, key = { _, o -> o.first ?: " sem-categoria" }) { _, (id, name) ->
                val selected = id == current
                Row(
                    Modifier
                        .fillMaxWidth()
                        .selectable(selected = selected, role = Role.RadioButton) { if (selected) onDismiss() else onPick(id) }
                        .background(if (selected) c.soft(c.ticket, 0.1f) else androidx.compose.ui.graphics.Color.Transparent)
                        .heightIn(min = 52.dp)
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        name,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (id == null && !selected) c.textSecondary else c.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    if (selected) Icon(Icons.Filled.Check, contentDescription = "Selecionada", tint = c.ticket)
                }
            }
        }
    }
}

/** Andamento na linha do tempo vertical: ponto + linha à esquerda, autor, horário e texto; interno leva cadeado. */
@Composable
private fun TimelineRow(u: TicketUpdate, actor: String, first: Boolean, last: Boolean) {
    val c = Wb.colors
    val internal = u.internal == 1
    val system = u.actor == "system" || u.actor.isBlank()
    val dotColor = when {
        internal -> c.warn
        system -> c.muted
        else -> c.ticket
    }
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(start = 20.dp, end = 16.dp)) {
        Box(Modifier.width(20.dp).fillMaxHeight()) {
            if (!first) Box(Modifier.align(Alignment.TopCenter).width(2.dp).height(8.dp).background(c.divider))
            if (!last) Box(Modifier.align(Alignment.TopCenter).padding(top = 8.dp).width(2.dp).fillMaxHeight().background(c.divider))
            Box(Modifier.align(Alignment.TopCenter).padding(top = 4.dp).size(12.dp).background(c.background, CircleShape), contentAlignment = Alignment.Center) {
                Box(Modifier.size(10.dp).background(dotColor, CircleShape))
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(bottom = if (last) 4.dp else 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        actor.ifBlank { "Atendente" },
                        style = MaterialTheme.typography.titleSmall,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (internal) {
                        Spacer(Modifier.width(6.dp))
                        Icon(Icons.Filled.Lock, contentDescription = "Andamento interno", tint = c.textSecondary, modifier = Modifier.size(13.dp))
                        Spacer(Modifier.width(3.dp))
                        Text("Interno", style = MaterialTheme.typography.labelSmall, color = c.textSecondary, maxLines = 1)
                    }
                }
                Spacer(Modifier.width(8.dp))
                Text(formatWhen(u.created), style = MaterialTheme.typography.labelSmall, color = c.textSecondary, maxLines = 1)
            }
            Spacer(Modifier.height(4.dp))
            if (internal) {
                Text(
                    u.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(c.bubbleNote).padding(horizontal = 12.dp, vertical = 8.dp),
                )
            } else {
                Text(u.text, style = MaterialTheme.typography.bodyMedium, color = if (system) c.textSecondary else c.textPrimary)
            }
        }
    }
}

/** Campo fixo embaixo: "Registrar andamento" com enviar. O texto vai ao cliente como "Protocolo WA-…: texto". */
@Composable
private fun ProgressComposer(ticket: Ticket, value: String, onValueChange: (String) -> Unit, canEdit: Boolean, busy: Boolean, onSend: () -> Unit) {
    val c = Wb.colors
    Column(Modifier.fillMaxWidth().background(c.background)) {
        HorizontalDivider(color = c.hairline)
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 8.dp)) {
            if (!canEdit) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Lock, contentDescription = null, tint = c.muted, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(
                        "Somente o responsável (ou um administrador) registra andamentos neste protocolo.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                    )
                }
            } else {
                Text(
                    "Vai ao cliente como “Protocolo ${ticket.number.ifBlank { "WA-…" }}: sua mensagem” e fica na linha do tempo.",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(start = 8.dp, end = 8.dp, bottom = 6.dp),
                )
                Row(verticalAlignment = Alignment.Bottom) {
                    Box(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp)
                            .clip(RoundedCornerShape(24.dp))
                            .background(c.field)
                            .padding(horizontal = 16.dp, vertical = 13.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (value.isEmpty()) {
                            Text("Registrar andamento", style = MaterialTheme.typography.bodyLarge, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        BasicTextField(
                            value = value,
                            onValueChange = onValueChange,
                            enabled = !busy,
                            maxLines = 5,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.textPrimary),
                            cursorBrush = SolidColor(c.brand),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    RoundIconButton(
                        Icons.AutoMirrored.Filled.Send,
                        "Registrar andamento",
                        onSend,
                        color = c.brand,
                        contentColor = c.onBrand,
                        enabled = !busy && value.isNotBlank(),
                    )
                }
            }
        }
    }
}

/** Folha de escolha do responsável (lista de presença: online primeiro). */
@Composable
private fun OwnerSheet(entries: List<PresenceEntry>, current: String?, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val c = Wb.colors
    var selected by remember { mutableStateOf(current) }
    val sorted = remember(entries) { entries.sortedWith(compareByDescending<PresenceEntry> { it.present }.thenBy { it.name.lowercase() }) }
    WbBottomSheet(onDismiss = onDismiss, title = "Responsável pelo protocolo") {
        if (sorted.isEmpty()) {
            Text("Nenhuma pessoa encontrada neste perfil.", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        } else {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 380.dp)) {
                itemsIndexed(sorted, key = { _, p -> p.actor }) { _, p ->
                    val online = p.present == 1
                    val isSelected = selected == p.actor
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.RadioButton) { selected = p.actor }
                            .background(if (isSelected) c.soft(c.brand, 0.1f) else androidx.compose.ui.graphics.Color.Transparent)
                            .heightIn(min = 60.dp)
                            .padding(horizontal = 20.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(p.name.ifBlank { p.actor }, seed = p.actor, size = 40.dp, online = online, ringColor = if (c.isDark) c.surface else c.background)
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                p.name.ifBlank { p.actor } + if (p.actor == current) " (atual)" else "",
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium,
                                color = c.textPrimary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(if (online) "Online" else "Offline", style = MaterialTheme.typography.bodySmall, color = if (online) c.ok else c.textSecondary)
                        }
                        if (isSelected) Icon(Icons.Filled.Check, contentDescription = "Selecionado", tint = c.brand)
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        PrimaryButton(
            "Atribuir",
            onClick = { selected?.let(onPick) },
            modifier = Modifier.padding(horizontal = 20.dp),
            enabled = selected != null && selected != current,
        )
    }
}

private fun conversationStateLabel(state: String) = when (state) {
    "ai" -> "Com o bot"
    "waiting" -> "Na fila"
    "human" -> "Em atendimento"
    "closed" -> "Concluída"
    else -> state
}
