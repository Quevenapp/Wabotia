package br.com.queven.wabotia.ui.team

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Apartment
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Department
import br.com.queven.wabotia.core.model.InternalChat
import br.com.queven.wabotia.core.model.InternalMessage
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.IconBubble
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PresenceDot
import br.com.queven.wabotia.ui.components.PresenceViewModel
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.formatListTime
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.components.rememberPresence
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class TeamSegment(val key: String, val label: String) {
    Chats("chats", "Conversas"),
    People("people", "Pessoas"),
    Bots("bots", "Bots"),
    Sectors("sectors", "Setores"),
}

/** Prévia da última mensagem de uma conversa interna; [updated] invalida o cache quando a conversa muda. */
data class InternalPreview(val updated: Long, val last: InternalMessage?)

/**
 * Aba Equipe: diretório (`GET /team`), conversas internas recentes (`GET /internal-chats`), setores
 * (`settings.departments` de `GET /status`) e, quando o servidor permite, quantas conversas cada pessoa tem em atendimento.
 */
class TeamViewModel(private val container: AppContainer, private val profile: String) : ViewModel() {
    var contacts by mutableStateOf<List<TeamContact>>(emptyList()); private set
    var chats by mutableStateOf<List<InternalChat>>(emptyList()); private set
    var previews by mutableStateOf<Map<String, InternalPreview>>(emptyMap()); private set
    var departments by mutableStateOf<List<Department>>(emptyList()); private set
    /** `user id` → conversas em atendimento; null quando não foi possível consultar. */
    var workload by mutableStateOf<Map<String, Int>?>(null); private set
    var loaded by mutableStateOf(false); private set
    var refreshing by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set

    private var workloadAt = 0L
    private var previewJob: Job? = null
    val meId: String? get() = container.session.user?.id

    val people: List<TeamContact>
        get() = contacts.filter { !it.isBot && it.id != meId }.sortedWith(compareByDescending<TeamContact> { it.online }.thenBy { it.name.lowercase() })
    val bots: List<TeamContact>
        get() = contacts.filter { it.isBot }.sortedWith(compareByDescending<TeamContact> { it.online }.thenBy { it.name.lowercase() })

    fun pullRefresh() {
        refreshing = true
        viewModelScope.launch {
            refresh()
            refreshing = false
        }
    }

    suspend fun refresh() {
        try {
            container.internalChats.use(profile)
            contacts = container.api.team(profile).data
            val list = container.api.internalChats(profile).data
            container.internalChats.baseline(list)
            chats = list
            error = null
            loaded = true
            fillPreviews()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
            loaded = true
        }
        container.profileData.load(profile)?.let { status -> departments = status.departments().filter { it.enabled } }
        loadWorkload()
    }

    /** A lista não traz mensagens: busca o detalhe das 12 primeiras conversas sem prévia atual, duas por vez. */
    private fun fillPreviews() {
        if (previewJob?.isActive == true) return
        val missing = chats.take(12).filter { previews[it.id]?.updated != it.updated }
        if (missing.isEmpty()) return
        previewJob = viewModelScope.launch {
            for (pair in missing.chunked(2)) {
                coroutineScope {
                    pair.map { chat ->
                        async {
                            val detail = runCatching { container.api.internalChat(profile, chat.id) }.getOrNull() ?: return@async
                            previews = previews + (chat.id to InternalPreview(chat.updated, detail.messages.lastOrNull()))
                        }
                    }.awaitAll()
                }
            }
        }
    }

    private suspend fun loadWorkload() {
        val now = System.currentTimeMillis()
        if (now - workloadAt < 60_000) return
        workloadAt = now
        try {
            val page = container.api.conversations(profile, state = "human", limit = 100)
            workload = page.data.mapNotNull { it.owner }.groupingBy { it }.eachCount()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Sem permissão ou sem rede: a contagem é complementar e simplesmente não aparece.
        }
    }
}

/** Aba Equipe (DESIGN.md, seção 9): cartão de presença, e Conversas · Pessoas · Bots · Setores. */
@Composable
fun TeamScreen(
    container: AppContainer,
    modifier: Modifier = Modifier,
    initialSegment: String? = null,
    openInternalChat: (peerId: String) -> Unit,
    openBot: (botId: String) -> Unit,
    openBotRuns: () -> Unit,
) {
    val profile = container.session.profileId ?: return
    val vm: TeamViewModel = viewModel(key = "team:$profile") { TeamViewModel(container, profile) }
    val presence = rememberPresence(container)
    val snackbar = remember { SnackbarHostState() }
    var segment by rememberSaveable { mutableStateOf(TeamSegment.entries.firstOrNull { it.key == initialSegment } ?: TeamSegment.Chats) }
    LaunchedEffect(initialSegment) { TeamSegment.entries.firstOrNull { it.key == initialSegment }?.let { segment = it } }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, vm) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                vm.refresh()
                delay(20_000)
            }
        }
    }
    LaunchedEffect(presence.message) {
        val text = presence.message ?: return@LaunchedEffect
        presence.consumeMessage()
        snackbar.showSnackbar(text)
    }

    val c = Wb.colors
    val me = container.session.user
    Scaffold(
        modifier = modifier,
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TabTopBar("Equipe")
                ConnectionStrip(container)
            }
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = vm.refreshing, onRefresh = { vm.pullRefresh() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item("presence") {
                    PresenceCard(me?.name.orEmpty().ifBlank { "Você" }, me?.id ?: "me", presence, Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp))
                }
                item("segments") {
                    SegmentedTabs(
                        TeamSegment.entries.map { it to it.label },
                        segment,
                        { segment = it },
                        Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp),
                    )
                }
                vm.error?.let { message ->
                    item("error") {
                        InlineNotice(message, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), actionLabel = "Tentar de novo", onAction = { vm.pullRefresh() })
                    }
                }
                if (!vm.loaded) {
                    item("skeleton") { SkeletonList(rows = 6) }
                } else when (segment) {
                    TeamSegment.Chats -> {
                        if (vm.chats.isEmpty()) {
                            item("empty-chats") {
                                EmptyState(Icons.Filled.Forum, "Nenhuma conversa interna ainda", Modifier.height(340.dp), subtitle = "Escolha alguém em Pessoas para começar. As mensagens internas não passam pelo WhatsApp.")
                            }
                        } else {
                            items(vm.chats, key = { "chat:" + it.id }) { chat ->
                                val peer = chat.peer
                                if (peer != null) {
                                    InternalChatRow(
                                        chat = chat,
                                        peer = peer,
                                        preview = vm.previews[chat.id],
                                        meId = vm.meId,
                                        unread = container.internalChats.isUnread(chat),
                                        onClick = { openInternalChat(peer.id) },
                                    )
                                    RowDivider(startIndent = 80.dp)
                                }
                            }
                        }
                    }
                    TeamSegment.People -> {
                        val people = vm.people
                        if (people.isEmpty()) {
                            item("empty-people") {
                                EmptyState(Icons.Filled.People, "Só você por aqui", Modifier.height(340.dp), subtitle = "Outras pessoas com acesso a este perfil aparecem aqui com a presença delas.")
                            }
                        } else {
                            items(people, key = { "person:" + it.id }) { contact ->
                                PersonRow(contact, vm.workload?.get(contact.id), onClick = { openInternalChat(contact.id) })
                                RowDivider(startIndent = 80.dp)
                            }
                        }
                    }
                    TeamSegment.Bots -> {
                        val bots = vm.bots
                        if (bots.isEmpty()) {
                            item("empty-bots") {
                                EmptyState(Icons.Filled.SmartToy, "Nenhum bot neste perfil", Modifier.height(280.dp), subtitle = "Os bots configurados no painel aparecem aqui.")
                            }
                        } else {
                            items(bots, key = { "bot:" + it.id }) { contact ->
                                BotRow(
                                    contact,
                                    onClick = { openBot(contact.bot_id ?: contact.id.removePrefix("bot:")) },
                                    onInternalChat = { openInternalChat(contact.id) },
                                )
                                RowDivider(startIndent = 80.dp)
                            }
                        }
                        item("bot-runs") {
                            SettingsRow(Icons.Filled.History, "Execuções recentes", subtitle = "Perguntas feitas aos bots e as respostas", tint = c.bot, onClick = openBotRuns)
                        }
                    }
                    TeamSegment.Sectors -> {
                        if (vm.departments.isEmpty()) {
                            item("empty-sectors") {
                                EmptyState(Icons.Filled.Apartment, "Nenhum setor configurado no painel", Modifier.height(340.dp), subtitle = "Setores agrupam pessoas para receber transferências, como Financeiro ou Suporte.")
                            }
                        } else {
                            items(vm.departments, key = { "sector:" + it.id }) { department ->
                                SectorRow(department, vm.contacts)
                                RowDivider(startIndent = 70.dp)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Cartão grande de presença: avatar, "Você está online/offline", interruptor e o resumo da equipe. */
@Composable
private fun PresenceCard(name: String, seed: String, presence: PresenceViewModel, modifier: Modifier = Modifier) {
    val c = Wb.colors
    val online = presence.present == true
    WbCard(modifier) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 16.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(name, seed = seed, size = 56.dp, online = presence.present, ringColor = c.surface)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    when (presence.present) {
                        true -> "Você está online"
                        false -> "Você está offline"
                        null -> "Consultando presença…"
                    },
                    style = MaterialTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                Text(
                    if (online) "Novos atendimentos podem ser encaminhados a você." else "Novos atendimentos não são encaminhados a você.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
            Spacer(Modifier.width(8.dp))
            Box(Modifier.size(width = 56.dp, height = 48.dp), contentAlignment = Alignment.Center) {
                if (presence.busy) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = c.brand)
                } else {
                    Switch(
                        checked = online,
                        onCheckedChange = { presence.set(it) },
                        enabled = presence.present != null,
                        colors = SwitchDefaults.colors(checkedTrackColor = c.ok, checkedThumbColor = Color.White, checkedBorderColor = c.ok),
                        modifier = Modifier.semantics { contentDescription = if (online) "Ficar offline" else "Ficar online" },
                    )
                }
            }
        }
        HorizontalDivider(color = c.hairline, modifier = Modifier.padding(horizontal = 16.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            PresenceDot(online = presence.peopleOnline > 0, size = 8.dp)
            Spacer(Modifier.width(8.dp))
            Text(
                if (presence.team.isEmpty()) "Carregando a equipe…" else presence.summary,
                style = MaterialTheme.typography.bodyMedium,
                color = c.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun InternalChatRow(chat: InternalChat, peer: TeamContact, preview: InternalPreview?, meId: String?, unread: Boolean, onClick: () -> Unit) {
    val c = Wb.colors
    val last = preview?.last
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(peer.name, seed = peer.id, size = 50.dp, kind = if (peer.isBot) AvatarKind.Bot else AvatarKind.Person, online = peer.online)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(peer.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(formatListTime(chat.updated), style = MaterialTheme.typography.labelMedium, color = if (unread) c.accent else c.textSecondary, fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        last == null && preview != null -> "Nenhuma mensagem ainda"
                        last == null -> "Conversa interna"
                        last.author == meId -> "Você: ${last.text}"
                        else -> last.text
                    }.replace('\n', ' '),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (unread) c.textPrimary else c.textSecondary,
                    fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (unread) {
                    Spacer(Modifier.width(8.dp))
                    Box(Modifier.size(12.dp).clip(CircleShape).background(c.accent).semantics { contentDescription = "Não lida" })
                }
            }
        }
    }
}

@Composable
private fun PersonRow(contact: TeamContact, conversations: Int?, onClick: () -> Unit) {
    val c = Wb.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(contact.name, seed = contact.id, size = 50.dp, online = contact.online)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(contact.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (contact.online) "Online" else "Offline", style = MaterialTheme.typography.bodyMedium, color = if (contact.online) c.ok else c.textSecondary, maxLines = 1)
                if (conversations != null && conversations > 0) {
                    Text(
                        " · " + if (conversations == 1) "1 conversa em atendimento" else "$conversations conversas em atendimento",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null, tint = c.muted, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun BotRow(contact: TeamContact, onClick: () -> Unit, onInternalChat: () -> Unit) {
    val c = Wb.colors
    val lines = contact.line_ids
    val linesText = when {
        lines == null -> "Todas as linhas"
        lines.isEmpty() -> "Só conversa interna"
        lines.size == 1 -> "1 linha"
        else -> "${lines.size} linhas"
    }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 72.dp).padding(start = 16.dp, end = 6.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(contact.name, seed = contact.id, size = 50.dp, kind = AvatarKind.Bot, online = contact.online)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(contact.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        contact.enabled == false -> "Desativado"
                        contact.online -> "Disponível"
                        else -> "Indisponível"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (contact.online && contact.enabled != false) c.ok else c.textSecondary,
                    maxLines = 1,
                )
                Text(" · $linesText", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        IconButton(onClick = onInternalChat) {
            Icon(Icons.Filled.Forum, contentDescription = "Conversa interna com ${contact.name}", tint = c.bot)
        }
    }
}

@Composable
private fun SectorRow(department: Department, contacts: List<TeamContact>) {
    val c = Wb.colors
    val byId = remember(contacts) { contacts.associateBy { it.id } }
    val total = department.members.size
    val online = department.members.count { byId[it]?.online == true }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBubble(Icons.Filled.Apartment, c.ticket)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(department.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (total > 0) {
                    PresenceDot(online = online > 0, size = 8.dp)
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    if (total == 0) "Sem membros" else "$online de $total online",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (online > 0) c.ok else c.textSecondary,
                    maxLines = 1,
                )
            }
        }
        if (total > 0) {
            Spacer(Modifier.width(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy((-7).dp), verticalAlignment = Alignment.CenterVertically) {
                department.members.take(5).forEach { id ->
                    val member = byId[id]
                    Box(Modifier.size(26.dp).clip(CircleShape).background(c.background), contentAlignment = Alignment.Center) {
                        Avatar(member?.name ?: "?", seed = id, size = 22.dp)
                    }
                }
                if (total > 5) {
                    Box(Modifier.size(26.dp).clip(CircleShape).background(c.background), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(22.dp).clip(CircleShape).background(c.field), contentAlignment = Alignment.Center) {
                            Text("+${total - 5}", style = MaterialTheme.typography.labelSmall, color = c.textSecondary, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}
