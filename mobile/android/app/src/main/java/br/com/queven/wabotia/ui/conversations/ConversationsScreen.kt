@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package br.com.queven.wabotia.ui.conversations

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.automirrored.filled.Shortcut
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.MessagePreview
import br.com.queven.wabotia.core.listPreview
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.Department
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.CountBadge
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.components.FilterRow
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PresencePill
import br.com.queven.wabotia.ui.components.PresenceSheet
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SheetAction
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.components.WindowInfo
import br.com.queven.wabotia.ui.components.WindowRing
import br.com.queven.wabotia.ui.components.color
import br.com.queven.wabotia.ui.components.conversationBadge
import br.com.queven.wabotia.ui.components.formatListTime
import br.com.queven.wabotia.ui.components.formatSpan
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.components.rememberPresence
import br.com.queven.wabotia.ui.components.windowInfo
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Aba Conversas (DESIGN.md §4): barra com presença e busca, chips com contador, linha no estilo do WhatsApp com selo de
 * estado, prévia, etiquetas, responsável, relógio da janela de 24 h e não lidas; deslizar para assumir/concluir, toque
 * longo para ações rápidas, puxar para atualizar e rolagem infinita.
 */
@Composable
fun ConversationsScreen(
    container: AppContainer,
    modifier: Modifier = Modifier,
    initialSheet: String? = null,
    openConversation: (id: String, sheet: String?) -> Unit,
    newTicket: (conversationId: String) -> Unit,
    showMessage: (String) -> Unit,
) {
    val profileId = container.session.profileId ?: ""
    val vm: ConversationsViewModel = viewModel(key = "conversations:$profileId") { ConversationsViewModel(container) }
    val presence = rememberPresence(container)
    val haptics = rememberHaptics()
    val now by rememberNow()
    val statuses by container.profileData.status.collectAsState()
    val lineKinds = statuses[profileId]?.lineKinds()
    val status = statuses[profileId] ?: vm.status
    val departments = remember(status) { status?.departments().orEmpty() }
    val cache = container.conversationCache

    EventPolling(
        container = container,
        profileId = profileId,
        onStart = {
            vm.reloadSilently()
            vm.loadSideData()
        },
        onEvents = { vm.onEvents(it) },
    )
    LaunchedEffect(vm.query) {
        if (vm.query != vm.appliedQuery) {
            delay(400)
            vm.applyQuery()
        }
    }
    LaunchedEffect(vm.notice) {
        val text = vm.notice ?: return@LaunchedEffect
        vm.notice = null
        showMessage(text)
    }
    LaunchedEffect(presence.message) {
        val text = presence.message ?: return@LaunchedEffect
        presence.consumeMessage()
        showMessage(text)
    }

    var searching by rememberSaveable { mutableStateOf(false) }
    var presenceSheet by rememberSaveable { mutableStateOf(initialSheet == "presence") }
    var profileSheet by remember { mutableStateOf(false) }
    var actionsFor by remember { mutableStateOf<Conversation?>(null) }
    var tagsFor by remember { mutableStateOf<Conversation?>(null) }
    var confirmResolve by remember { mutableStateOf<Conversation?>(null) }
    val searchFocus = remember { FocusRequester() }

    BackHandler(enabled = searching) {
        searching = false
        vm.query = ""
    }

    val listState = rememberLazyListState()
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1 }
            .distinctUntilChanged()
            .collect { last -> if (last >= 0 && last >= vm.items.size - 5) vm.loadMore() }
    }

    Column(modifier.fillMaxSize().background(Wb.colors.background)) {
        if (searching) {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 60.dp).padding(start = 4.dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { searching = false; vm.query = "" }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Fechar busca", tint = Wb.colors.textPrimary)
                }
                SearchField(vm.query, { vm.query = it }, "Buscar por nome ou telefone", Modifier.weight(1f), focusRequester = searchFocus)
            }
            LaunchedEffect(Unit) { runCatching { searchFocus.requestFocus() } }
        } else {
            val profileName = vm.profiles.firstOrNull { it.id == profileId }?.name
            TabTopBar(
                title = "Wabotia",
                subtitle = profileName,
                onSubtitleClick = if (vm.profiles.size > 1) ({ profileSheet = true }) else null,
            ) {
                PresencePill(presence.present, onClick = { presenceSheet = true })
                IconButton(onClick = { searching = true }) {
                    Icon(Icons.Filled.Search, contentDescription = "Buscar conversa", tint = Wb.colors.textPrimary)
                }
            }
        }
        ConnectionStrip(container)
        FilterRow {
            val queue = status?.conversationCount("waiting") ?: 0
            ConversationFilter.entries.forEach { f ->
                WbFilterChip(
                    label = f.label,
                    selected = vm.filter == f,
                    onClick = { vm.selectFilter(f) },
                    count = when (f) {
                        ConversationFilter.Queue -> queue
                        ConversationFilter.Mine -> vm.mineCount
                        ConversationFilter.Bots -> status?.conversationCount("ai")
                        else -> null
                    },
                    tone = if (f == ConversationFilter.Queue && queue > 0) Wb.colors.warn else null,
                )
            }
        }
        vm.error?.let { message ->
            InlineNotice(
                message,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                actionLabel = "Tentar de novo",
                onAction = { vm.dismissError(); vm.refresh() },
            )
        }
        PullToRefreshBox(isRefreshing = vm.refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.fillMaxSize()) {
            when {
                !vm.loaded && vm.items.isEmpty() && vm.error == null -> SkeletonList(rows = 9)
                vm.items.isEmpty() -> {
                    val (icon, title, line) = emptyContent(vm.filter, vm.appliedQuery)
                    EmptyState(icon, title, subtitle = line)
                }
                else -> LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                    items(vm.items, key = { it.id }) { c ->
                        val mine = c.isOwnedBy(vm.meId)
                        val claimable = !mine && c.state != "human"
                        SwipeRow(
                            canClaim = claimable,
                            canResolve = mine,
                            onClaim = { haptics.tick(); vm.claim(c) },
                            onResolve = { confirmResolve = c },
                        ) {
                            ConversationRow(
                                c = c,
                                meId = vm.meId,
                                team = vm.team,
                                departments = departments,
                                preview = listPreview(c, cache.previews[c.id]),
                                unread = cache.unread[c.id] ?: 0,
                                window = windowInfo(c, lineKinds, now),
                                now = now,
                                busy = vm.actingOn == c.id,
                                onClick = { openConversation(c.id, null) },
                                onLongClick = { haptics.tick(); actionsFor = c },
                            )
                        }
                        RowDivider(startIndent = 82.dp)
                    }
                    if (vm.loadingMore) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = Wb.colors.brand)
                            }
                        }
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                }
            }
        }
    }

    if (presenceSheet) PresenceSheet(presence) { presenceSheet = false }

    if (profileSheet) {
        WbBottomSheet(onDismiss = { profileSheet = false }, title = "Trocar perfil") {
            vm.profiles.forEach { p ->
                SheetAction(
                    icon = if (p.id == profileId) Icons.Filled.CheckCircle else Icons.AutoMirrored.Filled.Chat,
                    label = p.name,
                    subtitle = if (p.enabled == 1) "Atendimento ativo" else "Atendimento pausado",
                    tint = if (p.id == profileId) Wb.colors.brand else Wb.colors.muted,
                    onClick = { profileSheet = false; vm.selectProfile(p.id) },
                )
            }
        }
    }

    actionsFor?.let { c ->
        val mine = c.isOwnedBy(vm.meId)
        val admin = container.session.user?.isAdmin == true
        WbBottomSheet(onDismiss = { actionsFor = null }, title = c.displayName, subtitle = c.stateSubtitle(vm.meId, vm.team, now)) {
            if (!mine && c.state != "human") {
                SheetAction(Icons.Filled.PersonAdd, if (c.state == "closed") "Reabrir e assumir" else "Assumir", onClick = { actionsFor = null; haptics.tick(); vm.claim(c) })
            }
            if (mine || admin) {
                SheetAction(Icons.AutoMirrored.Filled.Shortcut, "Transferir", onClick = { actionsFor = null; openConversation(c.id, "transfer") })
            }
            SheetAction(Icons.AutoMirrored.Filled.Label, "Etiquetas", onClick = { actionsFor = null; tagsFor = c })
            if (mine || admin) {
                SheetAction(Icons.Filled.ConfirmationNumber, "Abrir protocolo", tint = Wb.colors.ticket, onClick = { actionsFor = null; newTicket(c.id) })
            }
            if (mine) {
                SheetAction(Icons.Filled.TaskAlt, "Concluir", tint = Wb.colors.danger, onClick = { actionsFor = null; confirmResolve = c })
            }
        }
    }

    tagsFor?.let { c ->
        TagsSheet(current = c.tagList(), onSave = { tagsFor = null; vm.saveTags(c, it) }, onDismiss = { tagsFor = null })
    }

    confirmResolve?.let { c ->
        AlertDialog(
            onDismissRequest = { confirmResolve = null },
            title = { Text("Concluir conversa?") },
            text = { Text("O atendimento de ${c.displayName} será encerrado. Se o cliente escrever de novo, a conversa volta para a fila.") },
            confirmButton = { TextButton(onClick = { confirmResolve = null; vm.resolve(c) }) { Text("Concluir", color = Wb.colors.danger, fontWeight = FontWeight.SemiBold) } },
            dismissButton = { TextButton(onClick = { confirmResolve = null }) { Text("Cancelar") } },
        )
    }
}

private fun emptyContent(filter: ConversationFilter, query: String): Triple<ImageVector, String, String> = when {
    query.isNotBlank() -> Triple(Icons.Filled.SearchOff, "Nada encontrado", "Nenhuma conversa para \"$query\".")
    filter == ConversationFilter.Queue -> Triple(Icons.Filled.TaskAlt, "Fila vazia", "Nenhuma conversa na fila. Bom trabalho!")
    filter == ConversationFilter.Mine -> Triple(Icons.AutoMirrored.Filled.Chat, "Nenhum atendimento seu", "Assuma uma conversa da fila para começar.")
    filter == ConversationFilter.Bots -> Triple(Icons.Filled.SmartToy, "Nenhuma conversa com bots", "Quando um bot estiver atendendo, a conversa aparece aqui.")
    filter == ConversationFilter.Closed -> Triple(Icons.Filled.CheckCircle, "Nenhuma conversa concluída", "Os atendimentos encerrados ficam nesta lista.")
    else -> Triple(Icons.AutoMirrored.Filled.Chat, "Nenhuma conversa ainda", "As conversas do WhatsApp deste perfil aparecem aqui.")
}

/** Deslizar para a direita assume (fundo `brand`); para a esquerda conclui (fundo `muted`). A linha sempre volta ao lugar. */
@Composable
private fun SwipeRow(canClaim: Boolean, canResolve: Boolean, onClaim: () -> Unit, onResolve: () -> Unit, content: @Composable () -> Unit) {
    if (!canClaim && !canResolve) {
        content()
        return
    }
    val claim by rememberUpdatedState(onClaim)
    val resolve by rememberUpdatedState(onResolve)
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.StartToEnd -> claim()
                SwipeToDismissBoxValue.EndToStart -> resolve()
                SwipeToDismissBoxValue.Settled -> {}
            }
            false
        },
        positionalThreshold = { distance -> distance * 0.35f },
    )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = canClaim,
        enableDismissFromEndToStart = canResolve,
        backgroundContent = {
            val toClaim = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            val color = when (state.dismissDirection) {
                SwipeToDismissBoxValue.StartToEnd -> Wb.colors.brand
                SwipeToDismissBoxValue.EndToStart -> Wb.colors.muted
                else -> Color.Transparent
            }
            Row(
                Modifier.fillMaxSize().background(color).padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = if (toClaim) Arrangement.Start else Arrangement.End,
            ) {
                if (state.dismissDirection != SwipeToDismissBoxValue.Settled) {
                    Icon(if (toClaim) Icons.Filled.PersonAdd else Icons.Filled.TaskAlt, contentDescription = null, tint = Color.White)
                    Spacer(Modifier.width(10.dp))
                    Text(if (toClaim) "Assumir" else "Concluir", color = Color.White, fontWeight = FontWeight.SemiBold)
                }
            }
        },
    ) {
        Box(Modifier.background(Wb.colors.background)) { content() }
    }
}

@Composable
private fun ConversationRow(
    c: Conversation,
    meId: String?,
    team: Map<String, TeamContact>,
    departments: List<Department>,
    preview: MessagePreview?,
    unread: Int,
    window: WindowInfo?,
    now: Long,
    busy: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val colors = Wb.colors
    val waitingMs = now - c.updated
    val longWait = c.state == "waiting" && waitingMs > 5 * 60_000
    val tags = remember(c.tags) { c.tagList() }
    val owner = c.ownerShort(meId, team, departments)
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick, onLongClickLabel = "Ações rápidas")
            .heightIn(min = 74.dp)
            .padding(start = 16.dp, end = 16.dp, top = 9.dp, bottom = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Avatar(
                name = c.displayName,
                seed = c.id,
                size = 52.dp,
                kind = if (c.isGroup) AvatarKind.Group else AvatarKind.Person,
                badge = conversationBadge(c, meId),
            )
            if (busy) CircularProgressIndicator(Modifier.size(52.dp), strokeWidth = 2.5.dp, color = colors.brand)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            // Linha 1: nome e horário
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    c.displayName,
                    color = colors.textPrimary,
                    fontSize = 16.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    if (longWait) "espera ${formatSpan(waitingMs)}" else formatListTime(c.updated),
                    color = when {
                        longWait -> colors.warn
                        unread > 0 -> colors.accent
                        else -> colors.textSecondary
                    },
                    fontSize = 12.sp,
                    fontWeight = if (longWait || unread > 0) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                )
            }
            Spacer(Modifier.height(2.dp))
            // Linha 2: prévia e relógio da janela
            Row(verticalAlignment = Alignment.CenterVertically) {
                val label = preview?.label()?.takeIf { it.isNotBlank() }
                if (label != null && preview.note) {
                    Icon(Icons.Filled.Lock, contentDescription = "Nota interna", tint = colors.textSecondary, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                } else if (label != null && preview.outgoing && preview.status.isNotBlank()) {
                    PreviewTick(preview.status)
                    Spacer(Modifier.width(3.dp))
                }
                Text(
                    label ?: c.stateText(meId, team),
                    color = if (unread > 0 && label != null) colors.textPrimary else colors.textSecondary,
                    fontSize = 14.sp,
                    fontStyle = if (label == null || preview?.note == true || preview?.kind == "deleted") FontStyle.Italic else FontStyle.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (window != null) {
                    Spacer(Modifier.width(8.dp))
                    WindowRing(window, size = 22.dp, strokeWidth = 2.5.dp)
                    val compact = window.compactText()
                    if (compact.isNotEmpty()) {
                        Spacer(Modifier.width(4.dp))
                        Text(compact, color = window.tone.color(), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    }
                }
            }
            // Linha 3: etiquetas, responsável e não lidas (só quando há conteúdo)
            if (tags.isNotEmpty() || owner != null || unread > 0) {
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        tags.take(2).forEach { tag ->
                            Pill(tag, colors.brand, Modifier.padding(end = 5.dp).widthIn(max = 110.dp))
                        }
                        if (tags.size > 2) {
                            Text("+${tags.size - 2}", color = colors.textSecondary, fontSize = 11.5.sp, modifier = Modifier.padding(end = 6.dp))
                        }
                        if (owner != null) {
                            val ownerColor = when (c.state) {
                                "ai" -> colors.bot
                                "waiting" -> colors.warn
                                else -> if (c.owner == meId) colors.brand else colors.textSecondary
                            }
                            Text(
                                (if (tags.isNotEmpty()) "· " else "") + owner,
                                color = ownerColor,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (unread > 0) {
                        Spacer(Modifier.width(8.dp))
                        CountBadge(unread)
                    }
                }
            }
        }
    }
}

/** Tick de entrega na prévia da lista. */
@Composable
private fun PreviewTick(status: String) {
    val c = Wb.colors
    val (icon, tint, label) = when (status) {
        "pending", "sending" -> Triple(Icons.Filled.Schedule, c.textSecondary, "Na fila")
        "sent" -> Triple(Icons.Filled.Done, c.textSecondary, "Enviada")
        "delivered" -> Triple(Icons.Filled.DoneAll, c.textSecondary, "Entregue")
        "read", "played" -> Triple(Icons.Filled.DoneAll, c.tickRead, "Lida")
        "failed" -> Triple(Icons.Filled.ErrorOutline, c.danger, "Falhou")
        else -> Triple(Icons.Filled.HourglassEmpty, c.textSecondary, "Sem confirmação")
    }
    Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(16.dp))
}
