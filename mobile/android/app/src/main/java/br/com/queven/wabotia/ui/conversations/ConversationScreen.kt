@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)

package br.com.queven.wabotia.ui.conversations

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.automirrored.filled.Shortcut
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.RestaurantMenu
import androidx.compose.material.icons.filled.SentimentSatisfiedAlt
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.modules.ModuleShortcut
import br.com.queven.wabotia.modules.cobranca.ChargeSheet
import br.com.queven.wabotia.modules.cobranca.ConversationItems
import br.com.queven.wabotia.modules.cobranca.ConversationItemsBar
import br.com.queven.wabotia.modules.cobranca.ConversationItemsRules
import br.com.queven.wabotia.modules.cobranca.ConversationItemsSheet
import br.com.queven.wabotia.modules.cobranca.FormPickerSheet
import br.com.queven.wabotia.modules.cobranca.FormsPaymentsDeps
import br.com.queven.wabotia.modules.cobranca.FormsPaymentsViewModel
import br.com.queven.wabotia.modules.suporte.CourtesyDialog
import br.com.queven.wabotia.modules.suporte.HandoffBand
import br.com.queven.wabotia.modules.suporte.ModuleHandoff
import br.com.queven.wabotia.modules.suporte.SuporteConfirmDialog
import br.com.queven.wabotia.modules.suporte.SuporteDeps
import br.com.queven.wabotia.modules.suporte.SuporteRules
import br.com.queven.wabotia.modules.suporte.SuporteStatus
import br.com.queven.wabotia.modules.suporte.SuporteViewModel
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.MediaFile
import br.com.queven.wabotia.core.model.Message
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.push.Notifications
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.CountBadge
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SecureScreenEffect
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WindowInfo
import br.com.queven.wabotia.core.model.Channels
import br.com.queven.wabotia.ui.components.WindowRing
import br.com.queven.wabotia.ui.components.WindowTone
import br.com.queven.wabotia.ui.components.color
import br.com.queven.wabotia.ui.components.conversationBadge
import br.com.queven.wabotia.ui.components.formatDayLabel
import br.com.queven.wabotia.ui.components.formatSpan
import br.com.queven.wabotia.ui.components.formatWhen
import br.com.queven.wabotia.ui.components.localDayOf
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.components.rememberServerNow
import br.com.queven.wabotia.ui.components.windowInfo
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class ConversationSheet { Transfer, Tags, Bots, Policy, Note, Window, Email }

/** Item da lista de mensagens: chip de data, evento do atendimento ou bolha (com [first] = primeira do grupo). */
private sealed interface ChatItem {
    val key: String

    data class Day(val label: String, override val key: String) : ChatItem
    data class System(val message: Message, override val key: String) : ChatItem
    data class Bubble(val message: Message, val first: Boolean, val showSubject: Boolean, override val key: String) : ChatItem
}

private fun buildItems(messages: List<Message>): List<ChatItem> {
    val items = ArrayList<ChatItem>(messages.size + 8)
    var lastDay: java.time.LocalDate? = null
    var lastGroup: String? = null
    var lastSubject: String? = null
    for (message in messages) {
        val day = localDayOf(message.created)
        if (day != lastDay) {
            items += ChatItem.Day(formatDayLabel(message.created), "day:$day")
            lastDay = day
            lastGroup = null
        }
        if (message.direction == "system") {
            items += ChatItem.System(message, message.id)
            lastGroup = null
            continue
        }
        val participant = if (message.isIncoming) message.contentJson.string("participant").orEmpty() else ""
        val group = "${message.direction}|${message.author}|$participant"
        val subject = message.emailSubject
        items += ChatItem.Bubble(message, first = group != lastGroup, showSubject = subject != null && subject != lastSubject, key = message.id)
        if (subject != null) lastSubject = subject
        lastGroup = group
    }
    return items
}

/**
 * Tela da conversa (DESIGN.md §5): barra no estilo do WhatsApp, faixa da janela de 24 h, mensagens com bolhas, e rodapé
 * que muda conforme o estado (composer, assumir, em atendimento com outra pessoa, concluída).
 */
@Composable
fun ConversationScreen(
    container: AppContainer,
    conversationId: String,
    initialSheet: String? = null,
    initialArg: String? = null,
    onBack: () -> Unit,
    openInfo: () -> Unit,
    openTicket: (String) -> Unit,
    openBot: (botId: String) -> Unit,
    /** Telas dos módulos ligados (Agendar, Abrir ordem de serviço…), por [ModuleRoutes]. */
    openRoute: (String) -> Unit = {},
) {
    // A conversa com o cliente: sem captura (Ajustes → Proteger telas com dados de clientes).
    SecureScreenEffect(container)
    val vm: ConversationViewModel = viewModel(key = "conversation:$conversationId") { ConversationViewModel(container, conversationId) }
    val enabledModules by container.modules.enabled.collectAsState()
    LaunchedEffect(Unit) { container.modules.refresh() }
    val profileId = container.session.profileId ?: ""
    val snackbar = remember { SnackbarHostState() }
    val haptics = rememberHaptics()
    val context = LocalContext.current
    val c = Wb.colors
    val now by rememberNow()

    EventPolling(
        container = container,
        profileId = profileId,
        onStart = {
            vm.load(silent = true)
            vm.loadPresence()
        },
        onEvents = { vm.onEvents(it) },
    )

    // Avisos desta conversa: limpa os existentes ao abrir e suprime novos enquanto ela estiver visível.
    LaunchedEffect(conversationId) { Notifications.cancelConversation(context, conversationId) }
    LifecycleResumeEffect(conversationId) {
        Notifications.visibleConversationId = conversationId
        Notifications.cancelConversation(context, conversationId)
        container.conversationCache.markRead(conversationId)
        onPauseOrDispose {
            if (Notifications.visibleConversationId == conversationId) Notifications.visibleConversationId = null
        }
    }
    LaunchedEffect(vm.notice) {
        val text = vm.notice ?: return@LaunchedEffect
        vm.notice = null
        snackbar.showSnackbar(text)
    }

    val detail = vm.detail
    val conversation = detail?.conversation
    val team = vm.teamById
    var menuOpen by rememberSaveable { mutableStateOf(initialSheet == "menu") }
    var sheet by rememberSaveable {
        mutableStateOf(
            when (initialSheet) {
                "transfer" -> ConversationSheet.Transfer
                "note" -> ConversationSheet.Note
                "tags" -> ConversationSheet.Tags
                "window" -> ConversationSheet.Window
                "email" -> ConversationSheet.Email
                else -> null
            },
        )
    }
    var transferTab by rememberSaveable { mutableStateOf(initialArg) }
    var selectedMessage by remember { mutableStateOf<Message?>(null) }
    var viewerMedia by remember { mutableStateOf<MediaFile?>(null) }
    var confirmDelete by remember { mutableStateOf<Message?>(null) }
    var failedMessage by remember { mutableStateOf<Message?>(null) }
    var confirmResolve by remember { mutableStateOf(false) }
    val channelNow = rememberServerNow(detail?.takeIf { it.usesChannelAction }?.let { it.channelWindow?.serverNow ?: it.server_now }, now)
    val window = detail?.let { windowInfo(it, vm.lineKinds, channelNow) }
    val canHandOff = vm.isOwn || vm.isAdmin

    // Passagem feita por módulo e Suporte pago: a faixa e as ações só com o módulo ligado, nunca em grupos.
    val modules = if (detail?.modulesAllowed == true) enabledModules[profileId].orEmpty() else emptySet()
    val suporteEnabled = ModuleIds.SUPORTE in modules
    val suporteVm: SuporteViewModel = viewModel(key = "suporte:$conversationId") { SuporteViewModel(conversationId, SuporteDeps.of(container), container) }
    val handoff = remember(detail?.handoff, detail?.modulesAllowed) { if (detail?.modulesAllowed == true) ModuleHandoff.of(detail.handoff) else null }
    val suporte = suporteVm.status.takeIf { suporteEnabled && conversation?.isGroup == false }
    var suporteDialog by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(suporteEnabled, conversation?.isGroup, conversation?.state, conversation?.owner, handoff) {
        if (detail?.modulesAllowed == true && conversation != null && !conversation.isGroup) suporteVm.load()
    }
    LaunchedEffect(suporteVm.done) {
        val text = suporteVm.done ?: return@LaunchedEffect
        suporteVm.done = null
        vm.notice = text
        // A liberação passa a conversa à equipe: relê o detalhe (estado, faixa).
        vm.load(silent = true)
    }
    LaunchedEffect(suporteVm.notice) {
        val text = suporteVm.notice ?: return@LaunchedEffect
        suporteVm.notice = null
        vm.notice = text
    }

    // Formulários e cobranças: o estado de cada link e de cada cobrança vem do detalhe; enviar só com o módulo ligado.
    val formsEnabled = ModuleIds.FORMS in modules
    val paymentsEnabled = ModuleIds.PAYMENTS in modules
    val itemsVm: FormsPaymentsViewModel = viewModel(key = "items:$conversationId") { FormsPaymentsViewModel(conversationId, FormsPaymentsDeps.of(container)) }
    val webSteps = remember(detail?.web_steps, formsEnabled, detail?.modulesAllowed) { if (detail?.modulesAllowed == true) ConversationItems.steps(detail.web_steps).filter { formsEnabled || it.kind != "form" } else emptyList() }
    val payments = remember(detail?.payments, paymentsEnabled) { if (paymentsEnabled) ConversationItems.payments(detail?.payments) else emptyList() }
    val direct = conversation?.isGroup == false
    val canForm = formsEnabled && canHandOff && direct
    val canCharge = paymentsEnabled && canHandOff && direct
    var itemsSheet by rememberSaveable { mutableStateOf(initialSheet == "items") }
    var formSheet by rememberSaveable { mutableStateOf(initialSheet == "form") }
    var chargeSheet by rememberSaveable { mutableStateOf(initialSheet == "charge") }
    LaunchedEffect(itemsVm.done) {
        val text = itemsVm.done ?: return@LaunchedEffect
        itemsVm.done = null
        vm.notice = text
        vm.load(silent = true)
    }

    fun openTransfer(tab: String?) {
        if (!canHandOff) {
            vm.notice = "Assuma a conversa para encaminhar o atendimento."
            return
        }
        if (tab == "menu") {
            vm.replyBlockReason(automation = true)?.let { vm.notice = it; return }
            if (detail?.can("menu") != true) { vm.notice = "Este canal não oferece envio de menu."; return }
        }
        transferTab = tab
        sheet = ConversationSheet.Transfer
    }

    Column(Modifier.fillMaxSize().background(c.chatWallpaper).imePadding()) {
        ChatTopBar(
            conversation = detail?.let { it.conversation.copy(channel = it.channelId, account_label = it.accountLabel, multichannel = it.isMultichannel) },
            subtitle = conversation?.stateSubtitle(vm.meId, team, now),
            meId = vm.meId,
            canHandOff = canHandOff,
            onBack = onBack,
            onInfo = { if (detail != null) openInfo() },
            onTransfer = { openTransfer(null) },
            menu = {
                Box {
                    IconButton(onClick = { menuOpen = true }, enabled = detail != null) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "Mais ações", tint = c.textPrimary)
                    }
                    if (detail != null && conversation != null) {
                        ConversationMenu(
                            expanded = menuOpen,
                            onDismiss = { menuOpen = false },
                            conversation = conversation,
                            own = vm.isOwn,
                            canHandOff = canHandOff,
                            canAutomate = vm.replyBlockReason(automation = true) == null,
                            canMenu = detail.can("menu"),
                            onTags = { sheet = ConversationSheet.Tags },
                            onTicket = { openTransfer("ticket") },
                            onMenu = { openTransfer("menu") },
                            onResume = { vm.resume() },
                            onSurvey = { vm.survey() },
                            onBots = { vm.loadBots(); sheet = ConversationSheet.Bots },
                            onSaveContact = {
                                if (!saveContact(context, conversation.displayName, conversation.phone.orEmpty())) vm.notice = "Nenhum aplicativo de contatos disponível."
                            },
                            onPolicy = { sheet = ConversationSheet.Policy },
                            onInfo = openInfo,
                            onEmail = if (detail.email_transcript.showsAction()) ({ sheet = ConversationSheet.Email }) else null,
                            onResolve = { confirmResolve = true },
                            shortcuts = if (conversation.isGroup) emptyList() else ModuleRoutes.conversationShortcuts(
                                modules, conversation.id, conversation.displayName,
                            ),
                            onShortcut = { openRoute(it.route) },
                            onPedidoLink = if (!conversation.isGroup && vm.isOwn && ModuleIds.PEDIDO in modules) ({ vm.sendPedidoLink() }) else null,
                            // Suporte pago: só com a conversa assumida (ou administrador), como o servidor exige.
                            suporte = suporte.takeIf { canHandOff },
                            onSuporte = { suporteDialog = it },
                            onForm = if (canForm) ({ formSheet = true }) else null,
                            onCharge = if (canCharge) ({ chargeSheet = true }) else null,
                        )
                    }
                }
            },
        )
        if (vm.busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(2.dp), color = c.brand, trackColor = Color.Transparent)
        ConnectionStrip(container)

        when {
            vm.loading && detail == null -> Box(Modifier.fillMaxSize().background(c.background)) { SkeletonList(rows = 7, avatar = false) }
            detail == null || conversation == null -> ErrorState(vm.loadError ?: "Não foi possível carregar a conversa.", onRetry = { vm.load() }, modifier = Modifier.background(c.background))
            else -> {
                if (window != null) WindowBanner(window, onClick = { sheet = ConversationSheet.Window })
                SecondWaveMetadata(detail, now = channelNow)
                OtherConversationsNotice(detail.other_conversations, onOpen = { openRelatedConversation(context, profileId, it) })
                if (conversation.isGroup) GroupStrip(detail, onChangePolicy = { sheet = ConversationSheet.Policy })
                if (SuporteRules.showBand(handoff, conversation.state, suporteEnabled)) {
                    HandoffBand(
                        handoff = handoff,
                        suporte = suporte,
                        canAct = canHandOff,
                        busy = suporteVm.busy,
                        onLink = { suporteDialog = "link" },
                        onConfirm = { suporteDialog = "confirm" },
                        onCourtesy = { suporteDialog = "courtesy" },
                    )
                }
                if (direct) {
                    val (recentSteps, recentPayments) = ConversationItemsRules.recent(webSteps, payments, now)
                    ConversationItemsBar(recentSteps, recentPayments, onClick = { itemsSheet = true })
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    MessagesList(
                        detail = detail,
                        vm = vm,
                        team = team,
                        container = container,
                        profileId = profileId,
                        onLongPress = { haptics.tick(); selectedMessage = it },
                        onOpenImage = { viewerMedia = it },
                        onFailed = { failedMessage = it },
                        anchorKey = conversation.state + "|" + conversation.owner,
                    )
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
                }
                // Rodapé conforme o estado; a troca para o composer ao assumir é animada.
                val footer = when {
                    vm.isOwn -> "composer"
                    conversation.state == "waiting" -> "waiting"
                    conversation.state == "ai" -> "ai"
                    conversation.state == "closed" -> "closed"
                    else -> "other"
                }
                AnimatedContent(
                    targetState = footer,
                    transitionSpec = { (fadeIn() + slideInVertically { it / 3 }) togetherWith fadeOut() },
                    label = "footer",
                ) { kind ->
                    if (kind == "composer") {
                        Composer(
                            vm = vm,
                            container = container,
                            detail = detail,
                            window = window,
                            openAttachInitially = initialSheet == "attach",
                            onMenu = { openTransfer("menu") },
                            onTicket = { openTransfer("ticket") },
                            onNote = { vm.sheetError = null; sheet = ConversationSheet.Note },
                        )
                    } else {
                        StateFooter(
                            kind = kind,
                            conversation = conversation,
                            team = team,
                            now = now,
                            isAdmin = vm.isAdmin,
                            claiming = vm.busyAction == "claim",
                            transferring = vm.busyAction == "transfer",
                            busy = vm.busy,
                            onClaim = { vm.claim { haptics.tick() } },
                            onTakeOver = { vm.meId?.let { me -> vm.transfer(me, "você", inSheet = false) { haptics.confirm() } } },
                            onNote = { vm.sheetError = null; sheet = ConversationSheet.Note },
                        )
                    }
                }
            }
        }
    }

    // --- folhas e diálogos ---
    if (detail != null && conversation != null) {
        when (sheet) {
            ConversationSheet.Transfer -> TransferSheet(
                vm = vm,
                conversation = conversation,
                initialTab = transferTab,
                onDone = { sheet = null },
                onDismiss = { sheet = null },
                openTicket = { sheet = null; openTicket(it) },
            )
            ConversationSheet.Tags -> TagsSheet(
                current = conversation.tagList(),
                onSave = { sheet = null; vm.saveTags(it) },
                onDismiss = { sheet = null },
            )
            ConversationSheet.Bots -> BotsSheet(
                bots = vm.bots,
                onPick = { sheet = null; openBot(it.id) },
                onDismiss = { sheet = null },
            )
            ConversationSheet.Policy -> GroupPolicyDialog(
                current = conversation.bot_policy,
                onPick = { sheet = null; vm.setGroupPolicy(it) },
                onDismiss = { sheet = null },
            )
            ConversationSheet.Note -> NoteSheet(
                busy = vm.busyAction == "note",
                error = vm.sheetError,
                onSend = { text -> vm.sendNote(text) { sheet = null } },
                onDismiss = { sheet = null },
            )
            ConversationSheet.Window -> if (window != null) WindowInfoSheet(window) { sheet = null } else sheet = null
            ConversationSheet.Email -> EmailTranscriptSheet(container, vm, onDismiss = { sheet = null })
            null -> {}
        }
        selectedMessage?.let { message ->
            MessageActionsSheet(
                message = message,
                detail = detail,
                own = vm.isOwn,
                busy = vm.busy,
                onReply = {
                    if (vm.editing != null) vm.cancelEdit()
                    vm.quote = message
                    selectedMessage = null
                },
                onReact = { emoji -> vm.messageAction("reaction", message, emoji); selectedMessage = null },
                onEdit = { vm.startEdit(message); selectedMessage = null },
                onDelete = { confirmDelete = message; selectedMessage = null },
                onMarkRead = { vm.messageAction("read", message); selectedMessage = null },
                onDismiss = { selectedMessage = null },
            )
        }
        confirmDelete?.let { message ->
            DeleteMessageDialog(
                onConfirm = { vm.messageAction("delete", message); confirmDelete = null },
                onDismiss = { confirmDelete = null },
                channelLabel = detail.channelId?.let { Channels.label(it) } ?: "WhatsApp",
            )
        }
        failedMessage?.let { message ->
            FailedMessageDialog(
                error = detail.deliveries.firstOrNull { it.status == "failed" }?.error,
                canRetry = vm.isOwn,
                onRetry = { failedMessage = null; vm.resend(message) },
                onDismiss = { failedMessage = null },
                channelLabel = detail.channelId?.let { Channels.label(it) } ?: "WhatsApp",
            )
        }
        if (confirmResolve) {
            AlertDialog(
                onDismissRequest = { confirmResolve = false },
                title = { Text("Concluir conversa?") },
                text = { Text("O atendimento de ${conversation.displayName} será encerrado. Se o cliente escrever de novo, a conversa volta para a fila.") },
                confirmButton = { TextButton(onClick = { confirmResolve = false; vm.resolve() }) { Text("Concluir", color = c.danger, fontWeight = FontWeight.SemiBold) } },
                dismissButton = { TextButton(onClick = { confirmResolve = false }) { Text("Cancelar") } },
            )
        }
        viewerMedia?.let { media ->
            ImageViewerDialog(media = media, profileId = profileId, container = container, onDismiss = { viewerMedia = null })
        }
        when (val action = suporteDialog) {
            "link", "confirm" -> SuporteConfirmDialog(
                action, suporte,
                onConfirm = { suporteDialog = null; if (action == "link") suporteVm.link() else suporteVm.confirm() },
                onDismiss = { suporteDialog = null },
            )
            "courtesy" -> CourtesyDialog(onRelease = { reason, hours -> suporteDialog = null; suporteVm.courtesy(reason, hours) }, onDismiss = { suporteDialog = null })
            else -> Unit
        }
        if (itemsSheet) {
            ConversationItemsSheet(
                steps = webSteps,
                payments = payments,
                canForm = canForm,
                canCharge = canCharge,
                onForm = { itemsSheet = false; formSheet = true },
                onCharge = { itemsSheet = false; chargeSheet = true },
                onCopied = { vm.notice = it },
                onDismiss = { itemsSheet = false },
            )
        }
        if (formSheet && canForm) FormPickerSheet(itemsVm, windowClosed = window?.closed == true, onDismiss = { formSheet = false })
        if (chargeSheet && canCharge) ChargeSheet(itemsVm, windowClosed = window?.closed == true, onDismiss = { chargeSheet = false })
    }
}

/** Barra superior no estilo do WhatsApp: voltar, avatar com selo, nome e estado; toque no nome abre Dados da conversa. */
@Composable
private fun ChatTopBar(
    conversation: Conversation?,
    subtitle: String?,
    meId: String?,
    canHandOff: Boolean,
    onBack: () -> Unit,
    onInfo: () -> Unit,
    onTransfer: () -> Unit,
    menu: @Composable () -> Unit,
) {
    val c = Wb.colors
    val barColor = if (c.isDark) c.surface else c.background
    Column(Modifier.fillMaxWidth().background(barColor)) {
        val showChannel = conversation != null && (conversation.multichannel || conversation.channel != null && conversation.channel != "whatsapp")
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(if (showChannel) 76.dp else 60.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.padding(start = 2.dp).size(44.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar", tint = c.textPrimary)
            }
            Row(
                Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).clickable(onClick = onInfo, onClickLabel = "Dados da conversa").padding(vertical = 6.dp, horizontal = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (conversation != null) {
                    Avatar(
                        conversation.displayName,
                        seed = conversation.id,
                        size = 40.dp,
                        kind = if (conversation.isGroup) AvatarKind.Group else AvatarKind.Person,
                        badge = conversationBadge(conversation, meId),
                        channel = conversation.channel,
                        multichannel = conversation.multichannel,
                        ringColor = barColor,
                    )
                } else {
                    Box(Modifier.size(40.dp).clip(CircleShape).background(c.field))
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        conversation?.displayName ?: "Conversa",
                        color = c.textPrimary,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!subtitle.isNullOrBlank()) {
                        Text(subtitle, color = c.textSecondary, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (showChannel && conversation != null) {
                        Text(listOf(Channels.label(conversation.channel), if (conversation.isComment) "Comentário" else "", conversation.account_label).filter { it.isNotBlank() }.joinToString(" · "), color = c.textSecondary, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            IconButton(onClick = onTransfer, modifier = Modifier.size(44.dp)) {
                Icon(Icons.AutoMirrored.Filled.Shortcut, contentDescription = "Encaminhar atendimento", tint = if (canHandOff) c.brand else c.muted)
            }
            menu()
        }
        HorizontalDivider(color = c.hairline)
    }
}

@Composable
private fun ConversationMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    conversation: Conversation,
    own: Boolean,
    canHandOff: Boolean,
    canAutomate: Boolean,
    canMenu: Boolean,
    onTags: () -> Unit,
    onTicket: () -> Unit,
    onMenu: () -> Unit,
    onResume: () -> Unit,
    onSurvey: () -> Unit,
    onBots: () -> Unit,
    onSaveContact: () -> Unit,
    onPolicy: () -> Unit,
    onInfo: () -> Unit,
    onResolve: () -> Unit,
    onEmail: (() -> Unit)? = null,
    shortcuts: List<ModuleShortcut> = emptyList(),
    onShortcut: (ModuleShortcut) -> Unit = {},
    /** Pedido ligado e a conversa assumida (nunca em grupos): envia o link do carrinho. */
    onPedidoLink: (() -> Unit)? = null,
    /** Suporte pago ligado e a conversa assumida (ou administrador): `link`, `confirm` ou `courtesy`. */
    suporte: SuporteStatus? = null,
    onSuporte: (String) -> Unit = {},
    /** Formulários ligados e a conversa assumida (ou administrador), fora de grupos. */
    onForm: (() -> Unit)? = null,
    /** Cobrança ligada e a conversa assumida (ou administrador), fora de grupos. */
    onCharge: (() -> Unit)? = null,
) {
    val c = Wb.colors
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss, containerColor = if (c.isDark) c.surface else c.background, shape = RoundedCornerShape(16.dp)) {
        @Composable
        fun item(label: String, icon: ImageVector, tint: Color = c.textPrimary, action: () -> Unit) {
            DropdownMenuItem(
                text = { Text(label, color = tint, fontSize = 15.5.sp) },
                leadingIcon = { Icon(icon, contentDescription = null, tint = if (tint == c.textPrimary) c.textSecondary else tint, modifier = Modifier.size(22.dp)) },
                onClick = { onDismiss(); action() },
            )
        }
        item("Etiquetas", Icons.AutoMirrored.Filled.Label, action = onTags)
        if (canHandOff) {
            item("Abrir protocolo", Icons.Filled.ConfirmationNumber, action = onTicket)
            if (canAutomate && canMenu) item("Enviar menu", Icons.AutoMirrored.Filled.ListAlt, action = onMenu)
        }
        shortcuts.forEach { shortcut -> item(shortcut.label, shortcut.icon, action = { onShortcut(shortcut) }) }
        onForm?.let { item("Enviar formulário", Icons.Filled.Description, action = it) }
        onCharge?.let { item("Cobrar", Icons.Filled.Payments, action = it) }
        onPedidoLink?.let { item("Montar pedido para este cliente", Icons.Filled.RestaurantMenu, action = it) }
        if (SuporteRules.canLink(suporte)) item(SuporteRules.linkTitle(suporte), Icons.Filled.Link, action = { onSuporte("link") })
        if (SuporteRules.canConfirm(suporte)) item("Confirmar e liberar", Icons.Filled.CheckCircle, action = { onSuporte("confirm") })
        if (SuporteRules.canCourtesy(suporte)) item("Liberar como cortesia", Icons.Filled.CardGiftcard, action = { onSuporte("courtesy") })
        if (own && canAutomate) item("Devolver ao bot", Icons.AutoMirrored.Filled.Undo, action = onResume)
        if (canHandOff && canAutomate && !conversation.isGroup) item("Pesquisa de satisfação", Icons.Filled.SentimentSatisfiedAlt, action = onSurvey)
        if (!conversation.isComment) item("Consultar bot", Icons.Filled.SmartToy, action = onBots)
        if (!conversation.isGroup && !conversation.phone.isNullOrBlank()) item("Salvar contato", Icons.Filled.PersonAdd, action = onSaveContact)
        if (conversation.isGroup) item("Respostas do bot no grupo", Icons.Filled.Groups, action = onPolicy)
        item("Dados da conversa", Icons.Filled.Info, action = onInfo)
        onEmail?.let { item("Enviar conversa por e-mail", Icons.Filled.Email, action = it) }
        if (own) item("Concluir", Icons.Filled.TaskAlt, tint = c.danger, action = onResolve)
    }
}

/**
 * Faixa fixa da janela de 24 h (altura 36): anel + "Janela de 24h · 21h 14min restantes" e, à direita, "até 14:32".
 * Abaixo de 1 h o fundo fica `danger` a 12% e o texto vira "Janela fecha em 42 min". Uma linha fina de progresso na base.
 */
@Composable
private fun WindowBanner(info: WindowInfo, onClick: () -> Unit) {
    val c = Wb.colors
    val tone = info.tone
    val color = tone.color()
    val base = if (c.isDark) c.surface else c.background
    val background = if (tone == WindowTone.Danger) c.danger.copy(alpha = 0.12f) else Color.Transparent
    Column(Modifier.fillMaxWidth().background(base).background(background).clickable(onClick = onClick, onClickLabel = "Entender ${info.title.lowercase()}")) {
        Row(Modifier.fillMaxWidth().height(34.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            WindowRing(info, size = 20.dp, strokeWidth = 2.2.dp)
            Spacer(Modifier.width(9.dp))
            Text(
                when {
                    info.humanTextOnly && !info.closed -> "Só texto humano · ${info.longText()} restantes"
                    tone == WindowTone.Closed -> info.reason ?: "Janela fechada · só volta quando o cliente escrever"
                    tone == WindowTone.Danger -> "Janela fecha em ${info.longText()}"
                    else -> "${info.shortTitle} · ${info.longText()} restantes"
                },
                color = if (tone == WindowTone.Danger) c.danger else if (tone == WindowTone.Closed) c.textSecondary else c.textPrimary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (!info.closed) {
                Spacer(Modifier.width(8.dp))
                Text(info.untilText(), color = c.textSecondary, fontSize = 12.sp, maxLines = 1)
            }
        }
        Box(Modifier.fillMaxWidth().height(2.dp).background(color.copy(alpha = 0.2f))) {
            Box(Modifier.fillMaxWidth(info.fraction).height(2.dp).background(color))
        }
    }
}

/** Metadados seguros já carregados no detalhe; ausência da extensão não acrescenta UI nem requisição. */
@Composable
internal fun SecondWaveMetadata(detail: ConversationDetail, now: Long, expanded: Boolean = false) {
    if (!detail.usesChannelAction) return
    val colors = Wb.colors
    val comment = detail.comment
    val email = detail.email
    val telegram = detail.telegram
    val quota = detail.remainingMessages.takeIf { detail.channelId == "tiktok" }
    if (!detail.isComment && email == null && telegram == null && detail.channelId != "tiktok") return
    Column(Modifier.fillMaxWidth().background(colors.surface).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        if (detail.isComment) {
            Text("Comentário · resposta pública ou privada", color = colors.textPrimary, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            if (comment != null) {
                Text(if (comment.hidden) "Comentário oculto" else "Comentário visível na publicação", color = colors.textSecondary, fontSize = 12.sp)
                comment.postText?.takeIf { it.isNotBlank() }?.let {
                    Text("Publicação: $it", color = colors.textSecondary, fontSize = 12.sp, maxLines = if (expanded) 6 else 2, overflow = TextOverflow.Ellipsis)
                }
                SafeChannelLink(comment.permalink, "Abrir publicação")
                val privateStatus = when (comment.privateState) {
                    "available" -> comment.privateExpiresAt?.let { if (it > now) "Resposta privada disponível até ${formatWhen(it)}" else "Prazo da resposta privada encerrado" } ?: "Prazo da resposta privada não informado"
                    "reserved" -> "Tentativa privada reservada"
                    "sent" -> if (comment.privateLinkPending) "Privado enviado; vínculo pendente" else "Resposta privada enviada; tentativa consumida"
                    "failed" -> "Resposta privada falhou; tentativa consumida"
                    "unknown" -> "Resposta privada indeterminada; tentativa consumida"
                    else -> "Situação da resposta privada não informada"
                }
                Text(privateStatus, color = colors.textSecondary, fontSize = 12.sp)
            }
        }
        if (email != null) {
            Text("Remetente não confirmado", color = colors.warn, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            if (expanded) {
                Text("Assunto: ${email.subject}", color = colors.textPrimary, fontSize = 13.sp)
                Text("Remetente do envelope: ${email.sender}", color = colors.textSecondary, fontSize = 12.sp)
                email.from?.takeIf { it.isNotBlank() && it != email.sender }?.let { Text("De informado: $it", color = colors.textSecondary, fontSize = 12.sp) }
                email.replyTo?.takeIf { it.isNotBlank() && it != email.sender }?.let { Text("Responder para informado: $it", color = colors.textSecondary, fontSize = 12.sp) }
                if (email.authentication.isNotEmpty()) {
                    Text("Autenticação recebida (não confirma a pessoa): " + email.authentication.joinToString(" · ") { "${it.method}: ${it.result}" }, color = colors.textSecondary, fontSize = 12.sp)
                }
                email.attachmentWarnings.forEach { Text(it, color = colors.warn, fontSize = 12.sp) }
            }
        }
        if (detail.channelId == "tiktok") {
            Text(quota?.let { "Restam $it de 10 mensagens" } ?: "Contador de mensagens não informado pelo servidor", color = if (quota == 0) colors.warn else colors.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text("Regra conservadora: até 10 envios ou tentativas nas últimas 48 horas. Nova entrada não zera o contador.", color = colors.textSecondary, fontSize = 12.sp)
        }
        if (telegram != null) {
            if (telegram.blocked) Text("O contato bloqueou o bot. O envio está indisponível.", color = colors.warn, fontSize = 13.sp)
            if (expanded) {
                Text("Telegram · sem janela de resposta", color = colors.textSecondary, fontSize = 13.sp)
                SafeChannelLink(telegram.botUrl, "Abrir bot no Telegram")
                telegram.phoneSuggestion?.let { Text("Telefone sugerido: ${it.masked}. Conferência humana pela ficha na web; não comprova identidade.", color = colors.textSecondary, fontSize = 12.sp) }
            }
        }
    }
}

@Composable
private fun SafeChannelLink(url: String?, label: String) {
    val target = url?.takeIf { value ->
        value.length <= 2048 && runCatching { android.net.Uri.parse(value).let { it.scheme in setOf("https", "http") && !it.host.isNullOrBlank() && it.userInfo == null } }.getOrDefault(false)
    } ?: return
    val handler = LocalUriHandler.current
    TextButton(onClick = { runCatching { handler.openUri(target) } }) { Text(label) }
}

/** Faixa do grupo: participantes, política de resposta do bot e aviso de "somente administradores". */
@Composable
private fun GroupStrip(detail: ConversationDetail, onChangePolicy: () -> Unit) {
    val c = Wb.colors
    val members = remember(detail.group) { detail.groupMembers() }
    val announcement = detail.group?.bool("announcement") == true
    Column(Modifier.fillMaxWidth().background(if (c.isDark) c.surface else c.background).clickable(onClick = onChangePolicy)) {
        Row(Modifier.fillMaxWidth().height(34.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Groups, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(9.dp))
            Text(
                "${members.size} participantes · Bot: ${botPolicyLabel(detail.conversation.bot_policy).lowercase()}" + if (announcement) " · só administradores enviam" else "",
                color = c.textSecondary,
                fontSize = 12.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        HorizontalDivider(color = c.hairline)
    }
}

@Composable
private fun MessagesList(
    detail: ConversationDetail,
    vm: ConversationViewModel,
    team: Map<String, TeamContact>,
    container: AppContainer,
    profileId: String,
    onLongPress: (Message) -> Unit,
    onOpenImage: (MediaFile) -> Unit,
    onFailed: (Message) -> Unit,
    anchorKey: String,
) {
    val c = Wb.colors
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val messages = detail.messages
    val items = remember(messages) { buildItems(messages) }
    val pendingDeliveries = remember(detail.deliveries) { detail.deliveries.filter { it.status != "sent" && it.status != "cancelled" } }
    val mediaById = remember(detail.media) { detail.media.associateBy { it.id } }
    val byId = remember(messages) { messages.associateBy { it.id } }
    val byExternal = remember(messages) { messages.filter { it.external_id != null }.associateBy { it.external_id!! } }
    val total = items.size + pendingDeliveries.size
    var lastCount by remember { mutableIntStateOf(0) }
    var newCount by remember { mutableIntStateOf(0) }
    var highlighted by remember { mutableStateOf<String?>(null) }

    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            info.totalItemsCount == 0 || last >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(total) {
        if (total == 0) return@LaunchedEffect
        val first = lastCount == 0
        val added = total - lastCount
        lastCount = total
        if (first) listState.scrollToItem(total - 1)
        else if (atBottom) listState.animateScrollToItem(total - 1)
        else if (added > 0) newCount += added
    }
    LaunchedEffect(atBottom) { if (atBottom) newCount = 0 }
    // O rodapé mudou de tamanho (assumir, transferir): a lista continua ancorada no fim.
    LaunchedEffect(anchorKey) {
        if (lastCount > 0) {
            delay(260)
            listState.animateScrollToItem((total - 1).coerceAtLeast(0))
        }
    }
    // Teclado aberto: a última mensagem continua à vista, como no WhatsApp.
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) { if (imeVisible && total > 0) listState.animateScrollToItem(total - 1) }
    LaunchedEffect(highlighted) {
        if (highlighted != null) {
            delay(1400)
            highlighted = null
        }
    }

    if (messages.isEmpty() && pendingDeliveries.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                "Nenhuma mensagem ainda.",
                color = c.textSecondary,
                fontSize = 13.sp,
                modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(c.bubbleSystem).padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
        return
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val ctx = remember(detail, team, maxWidth, vm.isOwn) {
            BubbleContext(
                detail = detail,
                meId = vm.meId,
                team = team,
                mediaById = mediaById,
                container = container,
                profileId = profileId,
                maxWidth = maxWidth * 0.8f,
                canSwipeReply = vm.isOwn && detail.can("reply"),
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 10.dp),
        ) {
            items.forEach { item ->
                when (item) {
                    is ChatItem.Day -> item(key = item.key) { DayChip(item.label) }
                    is ChatItem.System -> item(key = item.key) { SystemChip(item.message.text) }
                    is ChatItem.Bubble -> item(key = item.key) {
                        val message = item.message
                        val content = message.contentJson
                        val quoted = content.string("reply_to")?.let { byId[it] } ?: content.string("reply_external_id")?.let { byExternal[it] }
                        MessageBubble(
                            message = message,
                            ctx = ctx,
                            first = item.first,
                            highlighted = highlighted == message.id,
                            quotedText = (content.string("reply_text") ?: quoted?.text)?.takeIf { it.isNotBlank() } ?: quoted?.let { "Anexo" },
                            quotedAuthor = quoted?.let { q ->
                                when {
                                    q.isIncoming -> content.string("reply_participant_name") ?: detail.conversation.displayName
                                    q.author == vm.meId -> "Você"
                                    else -> team[q.author]?.name ?: "Atendimento"
                                }
                            },
                            onLongPress = { onLongPress(message) },
                            onOpenImage = onOpenImage,
                            onQuoteClick = {
                                val index = quoted?.let { q -> items.indexOfFirst { it.key == q.id } } ?: -1
                                if (index >= 0) {
                                    scope.launch { listState.animateScrollToItem(index) }
                                    highlighted = quoted?.id
                                }
                            },
                            onFailedClick = { onFailed(message) },
                            onSwipeReply = {
                                if (vm.editing != null) vm.cancelEdit()
                                vm.quote = message
                            },
                            showSubject = item.showSubject,
                            onCommentTarget = if (detail.isComment && vm.isOwn && message.isIncoming && message.commentId != null) ({ vm.selectComment(message) }) else null,
                        )
                    }
                }
            }
            pendingDeliveries.forEach { delivery -> item(key = "delivery:${delivery.id}") { DeliveryRow(delivery) } }
        }

        // Data flutuante no topo enquanto a pessoa rola (some quando a lista para), como no WhatsApp.
        val floatingDay by remember(items) {
            derivedStateOf {
                val first = listState.firstVisibleItemIndex
                if (items.getOrNull(first) is ChatItem.Day && listState.firstVisibleItemScrollOffset < 12) null
                else (first downTo 0).firstNotNullOfOrNull { (items.getOrNull(it) as? ChatItem.Day)?.label }
            }
        }
        var shownDay by remember { mutableStateOf("") }
        LaunchedEffect(floatingDay) { floatingDay?.let { shownDay = it } }
        AnimatedVisibility(
            visible = listState.isScrollInProgress && floatingDay != null,
            enter = fadeIn(tween(120)),
            exit = fadeOut(tween(250, delayMillis = 700)),
            modifier = Modifier.align(Alignment.TopCenter),
        ) { DayChip(shownDay) }

        // Botão flutuante "ir para o fim" com contador de mensagens novas quando a pessoa rolou para cima.
        AnimatedVisibility(
            visible = !atBottom,
            enter = fadeIn() + scaleIn(),
            exit = fadeOut() + scaleOut(),
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 12.dp),
        ) {
            Box {
                Box(
                    Modifier
                        .padding(top = 6.dp)
                        .shadow(3.dp, CircleShape)
                        .size(42.dp)
                        .clip(CircleShape)
                        .background(if (c.isDark) c.surface else c.background)
                        .clickable(onClickLabel = "Ir para o fim da conversa") { scope.launch { listState.animateScrollToItem((total - 1).coerceAtLeast(0)) } },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Ir para o fim", tint = c.textSecondary)
                }
                if (newCount > 0) CountBadge(newCount, Modifier.align(Alignment.TopEnd))
            }
        }
    }
}

/** Rodapé quando a conversa não é minha: cartão com o estado e a ação principal em um toque, sem diálogo. */
@Composable
private fun StateFooter(
    kind: String,
    conversation: Conversation,
    team: Map<String, TeamContact>,
    now: Long,
    isAdmin: Boolean,
    claiming: Boolean,
    transferring: Boolean,
    busy: Boolean,
    onClaim: () -> Unit,
    onTakeOver: () -> Unit,
    onNote: () -> Unit,
) {
    val c = Wb.colors
    val (title, color) = when (kind) {
        "waiting" -> "Na fila há ${formatSpan(now - conversation.updated).let { if (it == "agora") "instantes" else it }}" to c.warn
        "ai" -> (conversation.botName(team)?.let { "O bot $it está atendendo" } ?: "O bot do atendimento está atendendo") to c.bot
        "closed" -> "Conversa concluída" to c.muted
        else -> "Em atendimento com ${team[conversation.owner]?.name ?: "outra pessoa"}" to c.muted
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (c.isDark) c.surface else c.background)
            .navigationBarsPadding()
            .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(color, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(title, color = c.textPrimary, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(
                Modifier.clip(CircleShape).clickable(onClick = onNote).heightIn(min = 36.dp).padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(5.dp))
                Text("Nota interna", color = c.textSecondary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
        when (kind) {
            "waiting", "ai" -> {
                Spacer(Modifier.height(10.dp))
                PrimaryButton("Assumir conversa", onClick = onClaim, loading = claiming, enabled = !busy || claiming, icon = Icons.Filled.PersonAdd)
            }
            "closed" -> {
                Spacer(Modifier.height(10.dp))
                PrimaryButton("Reabrir e assumir", onClick = onClaim, loading = claiming, enabled = !busy || claiming, icon = Icons.Filled.PersonAdd)
            }
            else -> if (isAdmin) {
                Spacer(Modifier.height(10.dp))
                PrimaryButton("Transferir para mim", onClick = onTakeOver, loading = transferring, enabled = !busy || transferring, icon = Icons.AutoMirrored.Filled.Shortcut)
            } else {
                Text(
                    "Só quem está com a conversa responde ao cliente. Você pode deixar uma nota interna.",
                    color = c.textSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}
