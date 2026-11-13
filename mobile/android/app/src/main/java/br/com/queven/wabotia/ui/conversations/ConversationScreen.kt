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
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.SentimentSatisfiedAlt
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Undo
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.MediaFile
import br.com.queven.wabotia.core.model.Message
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.push.IncomingCallBus
import br.com.queven.wabotia.core.push.Notifications
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.CountBadge
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.components.IncomingCallCard
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WindowInfo
import br.com.queven.wabotia.ui.components.WindowRing
import br.com.queven.wabotia.ui.components.WindowTone
import br.com.queven.wabotia.ui.components.color
import br.com.queven.wabotia.ui.components.conversationBadge
import br.com.queven.wabotia.ui.components.formatDayLabel
import br.com.queven.wabotia.ui.components.formatSpan
import br.com.queven.wabotia.ui.components.localDayOf
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.components.windowInfo
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class ConversationSheet { Transfer, Tags, Bots, Policy, Note, Window }

/** Item da lista de mensagens: chip de data, evento do atendimento ou bolha (com [first] = primeira do grupo). */
private sealed interface ChatItem {
    val key: String

    data class Day(val label: String, override val key: String) : ChatItem
    data class System(val message: Message, override val key: String) : ChatItem
    data class Bubble(val message: Message, val first: Boolean, override val key: String) : ChatItem
}

private fun buildItems(messages: List<Message>): List<ChatItem> {
    val items = ArrayList<ChatItem>(messages.size + 8)
    var lastDay: java.time.LocalDate? = null
    var lastGroup: String? = null
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
        items += ChatItem.Bubble(message, first = group != lastGroup, key = message.id)
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
    openCall: (callId: String?) -> Unit,
) {
    val vm: ConversationViewModel = viewModel(key = "conversation:$conversationId") { ConversationViewModel(container, conversationId) }
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
            vm.refreshCalls()
            vm.loadPresence()
        },
        onEvents = { vm.onEvents(it) },
    )
    LaunchedEffect(Unit) { IncomingCallBus.calls.collect { vm.refreshCalls() } }

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
    val window = conversation?.let { windowInfo(it, vm.lineKinds, now) }
    val canHandOff = vm.isOwn || vm.isAdmin

    fun openTransfer(tab: String?) {
        if (!canHandOff) {
            vm.notice = "Assuma a conversa para encaminhar o atendimento."
            return
        }
        transferTab = tab
        sheet = ConversationSheet.Transfer
    }

    Column(Modifier.fillMaxSize().background(c.chatWallpaper).imePadding()) {
        ChatTopBar(
            conversation = conversation,
            subtitle = conversation?.stateSubtitle(vm.meId, team, now),
            meId = vm.meId,
            canCall = detail?.can("calls") == true,
            canHandOff = canHandOff,
            onBack = onBack,
            onInfo = { if (detail != null) openInfo() },
            onCall = { openCall(null) },
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
                            onResolve = { confirmResolve = true },
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
                if (conversation.isGroup) GroupStrip(detail, onChangePolicy = { sheet = ConversationSheet.Policy })
                vm.ringing.forEach { call ->
                    IncomingCallCard(
                        name = conversation.displayName,
                        seed = conversation.id,
                        busy = vm.busy,
                        onAnswer = { openCall(call.id) },
                        onReject = { vm.rejectCall(call) },
                    )
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
            )
        }
        failedMessage?.let { message ->
            FailedMessageDialog(
                error = detail.deliveries.firstOrNull { it.status == "failed" }?.error,
                canRetry = vm.isOwn,
                onRetry = { failedMessage = null; vm.resend(message) },
                onDismiss = { failedMessage = null },
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
    }
}

/** Barra superior no estilo do WhatsApp: voltar, avatar com selo, nome e estado; toque no nome abre Dados da conversa. */
@Composable
private fun ChatTopBar(
    conversation: Conversation?,
    subtitle: String?,
    meId: String?,
    canCall: Boolean,
    canHandOff: Boolean,
    onBack: () -> Unit,
    onInfo: () -> Unit,
    onCall: () -> Unit,
    onTransfer: () -> Unit,
    menu: @Composable () -> Unit,
) {
    val c = Wb.colors
    val barColor = if (c.isDark) c.surface else c.background
    Column(Modifier.fillMaxWidth().background(barColor)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(60.dp), verticalAlignment = Alignment.CenterVertically) {
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
                }
            }
            if (canCall) {
                IconButton(onClick = onCall, modifier = Modifier.size(44.dp)) { Icon(Icons.Filled.Call, contentDescription = "Ligar", tint = c.textPrimary) }
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
            item("Enviar menu", Icons.AutoMirrored.Filled.ListAlt, action = onMenu)
        }
        if (own) item("Devolver ao bot", Icons.Filled.Undo, action = onResume)
        if (canHandOff && !conversation.isGroup) item("Pesquisa de satisfação", Icons.Filled.SentimentSatisfiedAlt, action = onSurvey)
        item("Consultar bot", Icons.Filled.SmartToy, action = onBots)
        if (!conversation.isGroup && !conversation.phone.isNullOrBlank()) item("Salvar contato", Icons.Filled.PersonAdd, action = onSaveContact)
        if (conversation.isGroup) item("Respostas do bot no grupo", Icons.Filled.Groups, action = onPolicy)
        item("Dados da conversa", Icons.Filled.Info, action = onInfo)
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
    Column(Modifier.fillMaxWidth().background(base).background(background).clickable(onClick = onClick, onClickLabel = "Entender a janela de 24 horas")) {
        Row(Modifier.fillMaxWidth().height(34.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            WindowRing(info, size = 20.dp, strokeWidth = 2.2.dp)
            Spacer(Modifier.width(9.dp))
            Text(
                when (tone) {
                    WindowTone.Closed -> "Janela fechada · só volta quando o cliente escrever"
                    WindowTone.Danger -> "Janela fecha em ${info.longText()}"
                    else -> "Janela de 24h · ${info.longText()} restantes"
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
