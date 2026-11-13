package br.com.queven.wabotia.ui.team

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.InternalChat
import br.com.queven.wabotia.core.model.InternalMessage
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.BubbleText
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.formatDayLabel
import br.com.queven.wabotia.ui.components.formatTime
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.components.localDayOf
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Conversa interna com uma pessoa ou bot da equipe (não passa pelo WhatsApp). Abre pelo id do contato
 * (`POST /internal-chats`, idempotente) ou reaproveita a conversa já existente, o que mantém o histórico acessível quando
 * o contato fica indisponível. Envio com Idempotency-Key guardada: repetir após falha de rede reutiliza a mesma chave.
 */
class InternalChatViewModel(private val container: AppContainer, private val profile: String, val peerId: String) : ViewModel() {
    var peer by mutableStateOf<TeamContact?>(null); private set
    var chat by mutableStateOf<InternalChat?>(null); private set
    var draft by mutableStateOf("")
    var error by mutableStateOf<String?>(null); private set
    var busy by mutableStateOf(false); private set
    var loading by mutableStateOf(true); private set
    /** Envio sem confirmação: (texto, chave). */
    var pending by mutableStateOf<Pair<String, String>?>(null); private set

    private val openKey = ApiClient.newIdempotencyKey()
    private var opening = false
    val meId: String? get() = container.session.user?.id

    suspend fun refresh() {
        try {
            container.internalChats.use(profile)
            refreshChat()
            if (pending == null) error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
        } finally {
            loading = false
        }
    }

    private suspend fun refreshChat() {
        if (opening) return
        if (chat == null) {
            opening = true
            try {
                // Conversa já existente com este contato (inclusive quando ele saiu do diretório) dispensa o POST.
                val existing = runCatching { container.api.internalChats(profile).data.firstOrNull { it.peer?.id == peerId } }.getOrNull()
                if (existing != null) {
                    chat = existing
                    peer = existing.peer
                } else {
                    val opened = container.api.openInternalChat(profile, openKey, buildJsonObject { put("peer_id", peerId) })
                    chat = opened
                    opened.peer?.let { peer = it }
                }
            } finally {
                opening = false
            }
        }
        val id = chat?.id ?: return
        val result = container.api.internalChat(profile, id)
        chat = result
        result.peer?.let { peer = it }
        container.internalChats.markSeen(result.id, result.updated)
    }

    /** False quando há envio pendente: a pessoa precisa confirmar ou descartar antes de sair. */
    fun canLeave(): Boolean {
        if (busy || pending != null) {
            error = "Confirme o envio pendente antes de sair desta conversa."
            return false
        }
        return true
    }

    fun discardAttempt() {
        if (!busy) {
            pending = null
            draft = ""
            error = null
        }
    }

    fun dismissError() { error = null }

    fun send() {
        val id = chat?.id ?: return
        if (busy) return
        val request = pending ?: (draft.trim() to ApiClient.newIdempotencyKey())
        if (request.first.isEmpty()) return
        pending = request
        busy = true
        viewModelScope.launch {
            try {
                container.api.sendInternal(profile, id, request.second, buildJsonObject { put("text", request.first) })
                pending = null
                draft = ""
                error = null
                refreshChat()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
                if (e is ApiException && e.isDefinitiveWriteRejection) pending = null
            } finally {
                busy = false
            }
        }
    }
}

private sealed interface InternalItem {
    val key: String
    data class Day(val label: String, override val key: String) : InternalItem
    data class Bubble(val message: InternalMessage, val first: Boolean) : InternalItem {
        override val key: String get() = message.id
    }
}

private fun buildItems(messages: List<InternalMessage>): List<InternalItem> {
    val items = ArrayList<InternalItem>(messages.size + 4)
    var lastDay: java.time.LocalDate? = null
    var lastAuthor: String? = null
    for (m in messages) {
        val day = localDayOf(m.created)
        if (day != lastDay) {
            items += InternalItem.Day(formatDayLabel(m.created), "day:$day")
            lastDay = day
            lastAuthor = null
        }
        items += InternalItem.Bubble(m, first = m.author != lastAuthor)
        lastAuthor = m.author
    }
    return items
}

@Composable
fun InternalChatScreen(container: AppContainer, peerId: String, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val vm: InternalChatViewModel = viewModel(key = "internal-chat:$profile:$peerId") { InternalChatViewModel(container, profile, peerId) }
    val c = Wb.colors
    val haptics = rememberHaptics()
    var confirmDiscard by remember { mutableStateOf(false) }

    fun leave() { if (vm.canLeave()) onBack() }
    BackHandler { leave() }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, vm) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                vm.refresh()
                delay(4000)
            }
        }
    }

    val messages = vm.chat?.messages.orEmpty()
    val items = remember(messages) { buildItems(messages) }
    val list = rememberLazyListState()
    LaunchedEffect(messages.lastOrNull()?.id) { if (items.isNotEmpty()) list.animateScrollToItem(items.size - 1) }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Parar de tentar este envio?") },
            text = { Text("Isso não apaga uma mensagem que já tenha sido enviada. Confira o histórico antes de escrever a mesma mensagem novamente.") },
            confirmButton = { TextButton(onClick = { confirmDiscard = false; vm.discardAttempt() }) { Text("Descartar tentativa") } },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Continuar tentando") } },
        )
    }

    val peer = vm.peer
    val isBot = peer?.isBot ?: peerId.startsWith("bot:")
    val name = peer?.name?.ifBlank { null } ?: if (isBot) "Bot" else "Equipe"

    Column(Modifier.fillMaxSize().background(c.chatWallpaper)) {
        ChatTopBar(
            name = name,
            subtitle = when {
                peer == null -> "Conversa interna · não vai ao WhatsApp"
                peer.online -> "Online · conversa interna"
                else -> "Conversa interna · não vai ao WhatsApp"
            },
            onBack = { leave() },
            avatar = { Avatar(name, seed = peerId, size = 40.dp, kind = if (isBot) AvatarKind.Bot else AvatarKind.Person, online = peer?.online) },
        )
        ConnectionStrip(container)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                vm.loading && vm.chat == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp, color = c.brand)
                }
                items.isEmpty() && vm.chat != null -> EmptyState(
                    Icons.Filled.Forum,
                    "Nenhuma mensagem ainda",
                    subtitle = if (isBot) "Escreva para o bot. A resposta aparece aqui mesmo." else "As mensagens internas ficam só no Wabotia; nada vai ao WhatsApp.",
                )
                else -> LazyColumn(
                    state = list,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    items(items, key = { it.key }) { item ->
                        when (item) {
                            is InternalItem.Day -> ChatChip(item.label)
                            is InternalItem.Bubble -> {
                                val m = item.message
                                val mine = m.author == vm.meId
                                Column(Modifier.padding(top = if (item.first) 6.dp else 2.dp)) {
                                    ChatBubble(outgoing = mine, first = item.first) {
                                        if (!mine && isBot && item.first) {
                                            Text("🤖 $name", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = c.bot, maxLines = 1)
                                        }
                                        BubbleText(m.text, formatTime(m.created), timeColor = if (mine) c.bubbleOutMeta else c.textSecondary)
                                        val status = m.status?.takeIf { it !in listOf("sent", "completed") }
                                        if (status != null) {
                                            val failed = status == "failed"
                                            val waiting = status in listOf("queued", "pending", "running", "starting")
                                            Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                                if (waiting) {
                                                    CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 1.5.dp, color = c.bot)
                                                    Spacer(Modifier.width(6.dp))
                                                }
                                                Text(
                                                    when {
                                                        waiting -> "Aguardando resposta"
                                                        failed -> "Falha na resposta"
                                                        else -> "Sem confirmação"
                                                    },
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = if (failed) c.danger else if (waiting) c.bot else c.warn,
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        ChatComposer(
            value = vm.draft,
            onValueChange = { vm.draft = it },
            placeholder = "Mensagem interna",
            onSend = { haptics.tick(); vm.send() },
            canSend = !vm.busy && vm.chat != null && (vm.pending != null || vm.draft.isNotBlank()),
            enabled = !vm.busy && vm.pending == null,
            sending = vm.busy,
            sendDescription = if (vm.pending != null) "Repetir envio" else "Enviar mensagem interna",
            above = {
                vm.error?.let {
                    InlineNotice(it, Modifier.padding(bottom = 6.dp), onDismiss = if (vm.pending == null) ({ vm.dismissError() }) else null)
                }
                if (vm.pending != null && !vm.busy) {
                    InlineNotice(
                        "Envio sem confirmação. Toque em enviar para repetir o mesmo pedido.",
                        Modifier.padding(bottom = 6.dp),
                        color = c.warn,
                        actionLabel = "Parar de tentar",
                        onAction = { confirmDiscard = true },
                    )
                }
            },
        )
    }
}
