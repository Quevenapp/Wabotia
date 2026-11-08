@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package br.com.queven.wabotia.ui.conversations

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Label
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.MediaFile
import br.com.queven.wabotia.core.model.Message
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.push.IncomingCallBus
import br.com.queven.wabotia.core.push.Notifications

private enum class ConversationSheet { Transfer, Tags, Bots, Policy }

/**
 * Tela da conversa (mobile/README.md, seção Conversa): cabeçalho com estado e responsável, menu de ações,
 * lista de mensagens com mídia autenticada, ações por toque longo e composer completo.
 */
@Composable
fun ConversationScreen(
    container: AppContainer,
    conversationId: String,
    onBack: () -> Unit,
    openTicket: (String) -> Unit,
    newTicket: () -> Unit,
    openBot: (botId: String) -> Unit,
    openCall: (callId: String?) -> Unit,
) {
    val vm: ConversationViewModel = viewModel(key = "conversation:$conversationId") { ConversationViewModel(container, conversationId) }
    val profileId = container.session.profileId ?: ""
    val snackbar = remember { SnackbarHostState() }

    EventPolling(
        container = container,
        profileId = profileId,
        onStart = {
            vm.load(silent = true)
            vm.refreshCalls()
        },
        onEvents = { vm.onEvents(it) },
    )
    LaunchedEffect(Unit) { IncomingCallBus.calls.collect { vm.refreshCalls() } }

    // Avisos desta conversa: limpa os existentes ao abrir e suprime novos enquanto ela estiver visível.
    val context = LocalContext.current
    LaunchedEffect(conversationId) { Notifications.cancelConversation(context, conversationId) }
    LifecycleResumeEffect(conversationId) {
        Notifications.visibleConversationId = conversationId
        Notifications.cancelConversation(context, conversationId)
        onPauseOrDispose {
            if (Notifications.visibleConversationId == conversationId) Notifications.visibleConversationId = null
        }
    }
    LaunchedEffect(vm.notice) {
        val text = vm.notice ?: return@LaunchedEffect
        snackbar.showSnackbar(text)
        if (vm.notice == text) vm.notice = null
    }

    val detail = vm.detail
    val conversation = detail?.conversation
    var menuOpen by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<ConversationSheet?>(null) }
    var selectedMessage by remember { mutableStateOf<Message?>(null) }
    var viewerMedia by remember { mutableStateOf<MediaFile?>(null) }
    var confirmDelete by remember { mutableStateOf<Message?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            conversation?.displayName ?: "Conversa",
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (conversation != null) {
                            val ownerLabel = conversation.owner?.let { owner ->
                                "Responsável: " + (if (owner == vm.meId) "você" else vm.names[owner] ?: "atendente")
                            }
                            val subtitle = listOfNotNull(
                                conversation.phone?.takeIf { !conversation.isGroup && it != conversation.displayName },
                                stateLabel(conversation.state),
                                if (conversation.state == "human") ownerLabel else null,
                            ).joinToString(" · ")
                            Text(
                                subtitle,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar") }
                },
                actions = {
                    if (detail?.can("calls") == true) {
                        IconButton(onClick = { openCall(null) }) { Icon(Icons.Filled.Call, contentDescription = "Ligar") }
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }, enabled = detail != null) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "Mais ações")
                        }
                        if (detail != null) {
                            ConversationMenu(
                                expanded = menuOpen,
                                onDismiss = { menuOpen = false },
                                detail = detail,
                                vm = vm,
                                onTransfer = { sheet = ConversationSheet.Transfer },
                                onTags = { sheet = ConversationSheet.Tags },
                                onBots = { vm.loadBots(); sheet = ConversationSheet.Bots },
                                onPolicy = { sheet = ConversationSheet.Policy },
                                onNewTicket = newTicket,
                                onCall = { openCall(null) },
                            )
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),
        ) {
            when {
                vm.loading && detail == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                detail == null || conversation == null -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(vm.loadError ?: "Não foi possível carregar a conversa.", color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { vm.load() }) { Text("Tentar novamente") }
                    }
                }
                else -> {
                    if (vm.busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    vm.ringing.forEach { call ->
                        RingingCallStrip(
                            name = conversation.displayName,
                            busy = vm.busy,
                            onAnswer = { openCall(call.id) },
                            onReject = { vm.rejectCall(call) },
                        )
                    }
                    if (conversation.isGroup) {
                        GroupStrip(detail, onChangePolicy = { sheet = ConversationSheet.Policy })
                    }
                    MessagesList(
                        modifier = Modifier.weight(1f),
                        detail = detail,
                        vm = vm,
                        container = container,
                        profileId = profileId,
                        onLongPress = { selectedMessage = it },
                        onOpenImage = { viewerMedia = it },
                    )
                    Composer(vm = vm, container = container, detail = detail, onClaim = { vm.claim() })
                }
            }
        }
    }

    // --- folhas e diálogos ---
    if (detail != null && conversation != null) {
        when (sheet) {
            ConversationSheet.Transfer -> TransferSheet(
                presence = vm.presence,
                meId = vm.meId,
                onPick = { sheet = null; vm.transfer(it) },
                onDismiss = { sheet = null },
            )
            ConversationSheet.Tags -> TagsDialog(
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
        viewerMedia?.let { media ->
            ImageViewerDialog(media = media, profileId = profileId, container = container, onDismiss = { viewerMedia = null })
        }
    }
}

@Composable
private fun ConversationMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    detail: ConversationDetail,
    vm: ConversationViewModel,
    onTransfer: () -> Unit,
    onTags: () -> Unit,
    onBots: () -> Unit,
    onPolicy: () -> Unit,
    onNewTicket: () -> Unit,
    onCall: () -> Unit,
) {
    val c = detail.conversation
    val own = vm.isOwn
    val claimable = !own && (c.owner == null || c.owner == vm.meId || c.state != "human")
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        if (claimable) {
            DropdownMenuItem(
                text = { Text("Assumir") },
                leadingIcon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) },
                onClick = { onDismiss(); vm.claim() },
            )
        }
        if (own || vm.isAdmin) {
            DropdownMenuItem(
                text = { Text("Transferir") },
                leadingIcon = { Icon(Icons.Filled.SwapHoriz, contentDescription = null) },
                onClick = { onDismiss(); onTransfer() },
            )
        }
        if (own) {
            DropdownMenuItem(
                text = { Text("Devolver à IA") },
                leadingIcon = { Icon(Icons.Filled.Undo, contentDescription = null) },
                onClick = { onDismiss(); vm.resume() },
            )
            DropdownMenuItem(
                text = { Text("Concluir") },
                leadingIcon = { Icon(Icons.Filled.TaskAlt, contentDescription = null) },
                onClick = { onDismiss(); vm.resolve() },
            )
        }
        DropdownMenuItem(
            text = { Text("Etiquetas") },
            leadingIcon = { Icon(Icons.Filled.Label, contentDescription = null) },
            onClick = { onDismiss(); onTags() },
        )
        DropdownMenuItem(
            text = { Text("Abrir protocolo") },
            leadingIcon = { Icon(Icons.Filled.Description, contentDescription = null) },
            onClick = { onDismiss(); onNewTicket() },
        )
        DropdownMenuItem(
            text = { Text("Consultar bot") },
            leadingIcon = { Icon(Icons.Filled.SmartToy, contentDescription = null) },
            onClick = { onDismiss(); onBots() },
        )
        if (detail.can("calls")) {
            DropdownMenuItem(
                text = { Text("Ligar") },
                leadingIcon = { Icon(Icons.Filled.Call, contentDescription = null) },
                onClick = { onDismiss(); onCall() },
            )
        }
        if (c.isGroup) {
            DropdownMenuItem(
                text = { Text("Respostas da IA no grupo") },
                leadingIcon = { Icon(Icons.Filled.Group, contentDescription = null) },
                onClick = { onDismiss(); onPolicy() },
            )
        }
    }
}

/** Faixa do grupo: participantes, política de resposta da IA e aviso de "somente administradores". */
@Composable
private fun GroupStrip(detail: ConversationDetail, onChangePolicy: () -> Unit) {
    val members = remember(detail.group) { detail.groupMembers() }
    val announcement = detail.group?.bool("announcement") == true
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth().clickable(onClick = onChangePolicy)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Group, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f)) {
                Text(
                    "Grupo · ${members.size} participantes" + (detail.group?.string("subject")?.takeIf { it.isNotBlank() && it != detail.conversation.title }?.let { " · $it" } ?: ""),
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "IA: ${botPolicyLabel(detail.conversation.bot_policy)} · " +
                        if (announcement) "Somente administradores podem enviar." else "Participantes podem enviar mensagens.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun MessagesList(
    modifier: Modifier,
    detail: ConversationDetail,
    vm: ConversationViewModel,
    container: AppContainer,
    profileId: String,
    onLongPress: (Message) -> Unit,
    onOpenImage: (MediaFile) -> Unit,
) {
    val listState = rememberLazyListState()
    val messages = detail.messages
    val pendingDeliveries = remember(detail.deliveries) { detail.deliveries.filter { it.status != "sent" && it.status != "cancelled" } }
    val mediaById = remember(detail.media) { detail.media.associateBy { it.id } }
    val byId = remember(messages) { messages.associateBy { it.id } }
    val byExternal = remember(messages) { messages.filter { it.external_id != null }.associateBy { it.external_id!! } }
    var lastCount by remember { mutableIntStateOf(0) }

    LaunchedEffect(messages.size, pendingDeliveries.size) {
        val total = messages.size + pendingDeliveries.size
        if (total == 0) return@LaunchedEffect
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        val shouldScroll = lastCount == 0 || lastVisible >= lastCount - 2
        lastCount = total
        if (shouldScroll) listState.scrollToItem(total - 1)
    }

    if (messages.isEmpty() && pendingDeliveries.isEmpty()) {
        Box(modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("Nenhuma mensagem ainda.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
        return
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(messages, key = { it.id }) { message ->
            val content = message.contentJson
            val quotedText = content.string("reply_text")
                ?: content.string("reply_to")?.let { byId[it]?.text }
                ?: content.string("reply_external_id")?.let { byExternal[it]?.text }
            MessageBubble(
                message = message,
                detail = detail,
                meId = vm.meId,
                names = vm.names,
                mediaById = mediaById,
                quotedText = quotedText?.takeIf { it.isNotBlank() },
                container = container,
                profileId = profileId,
                onLongPress = { onLongPress(message) },
                onOpenImage = onOpenImage,
            )
        }
        items(pendingDeliveries, key = { "delivery:${it.id}" }) { delivery -> DeliveryRow(delivery) }
    }
}
