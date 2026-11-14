package br.com.queven.wabotia.ui.bots

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
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
import br.com.queven.wabotia.core.media.MediaKinds
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.BotRun
import br.com.queven.wabotia.core.model.BotRunRequest
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.BubbleText
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.formatTime
import br.com.queven.wabotia.ui.components.formatWhen
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.team.BubbleTime
import br.com.queven.wabotia.ui.team.ChatBubble
import br.com.queven.wabotia.ui.team.ChatChip
import br.com.queven.wabotia.ui.team.ChatComposer
import br.com.queven.wabotia.ui.team.ChatTopBar
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

private const val INPUT_MAX = 60_000
private const val POLL_INTERVAL_MS = 2_000L

/** Pedido de execução pendente: mesma chave e mesmo texto ao repetir após falha de rede. */
data class PendingRun(val key: String, val input: String)

class BotChatViewModel(
    private val container: AppContainer,
    private val profileId: String,
    private val botId: String,
    private val conversationId: String?,
) : ViewModel() {
    var bot by mutableStateOf<Bot?>(null)
        private set
    /** Execuções deste bot (anteriores + desta sessão), mais antigas em cima. */
    var runs by mutableStateOf<List<BotRun>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var sending by mutableStateOf(false)
        private set
    var sendError by mutableStateOf<String?>(null)
        private set
    var pollError by mutableStateOf<String?>(null)
        private set
    var pending by mutableStateOf<PendingRun?>(null)
        private set
    var contextTitle by mutableStateOf<String?>(null)
        private set
    var input by mutableStateOf("")

    private var started = false
    private var contextApplied = false
    private val pollJobs = HashMap<String, Job>()

    val activeRun: BotRun? get() = runs.lastOrNull { isRunActive(it.status) }

    fun start() {
        if (!started) {
            started = true
            load()
        }
    }

    fun load() {
        if (profileId.isBlank()) { error = "Perfil não selecionado."; return }
        viewModelScope.launch {
            loading = true
            error = null
            try {
                coroutineScope {
                    val b = async { runCatching { container.api.bots(profileId) }.getOrNull() }
                    val r = async { container.api.botRuns(profileId) }
                    val ctx = async {
                        if (conversationId != null && !contextApplied) runCatching { container.api.conversation(profileId, conversationId) }.getOrNull() else null
                    }
                    bot = b.await()?.data?.firstOrNull { it.id == botId }
                    merge(r.await().data.filter { it.bot_id == botId })
                    ctx.await()?.let { applyContext(it) }
                }
                runs.filter { !it.isFinal }.forEach { poll(it.id) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            } finally {
                loading = false
            }
        }
    }

    /**
     * Traz o que chegou por outro caminho: a mesma conversa com o bot também recebe perguntas de outro aparelho e da
     * conversa interna. Silencioso: falha de rede aqui não vira erro na tela.
     */
    suspend fun refresh() {
        if (profileId.isBlank() || loading) return
        try {
            merge(container.api.botRuns(profileId).data.filter { it.bot_id == botId })
            runs.filter { !it.isFinal }.forEach { poll(it.id) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    private fun merge(list: List<BotRun>) {
        val map = LinkedHashMap<String, BotRun>()
        runs.forEach { map[it.id] = it }
        list.forEach { map[it.id] = it }
        runs = map.values.sortedBy { it.created }
    }

    private fun applyContext(detail: ConversationDetail) {
        contextApplied = true
        val c = detail.conversation
        val who = c.phone?.takeIf { it.isNotBlank() } ?: c.displayName
        val lastCustomer = detail.messages.filter { it.isIncoming && it.text.isNotBlank() }.maxByOrNull { it.created }?.text?.trim()
        contextTitle = "Contexto: conversa com ${c.displayName}"
        if (input.isBlank()) {
            input = if (!lastCustomer.isNullOrBlank()) "Cliente $who perguntou: $lastCustomer" else "Cliente $who: "
        }
    }

    fun send() {
        val text = input.trim()
        if (text.isEmpty() || sending) return
        if (text.length > INPUT_MAX) { sendError = "A pergunta deve ter no máximo $INPUT_MAX caracteres."; return }
        // Repetição após falha de rede reutiliza a mesma chave para o mesmo texto.
        val request = pending?.takeIf { it.input == text } ?: PendingRun(ApiClient.newIdempotencyKey(), text)
        pending = request
        viewModelScope.launch {
            sending = true
            sendError = null
            try {
                val created = container.api.startBotRun(request.key, BotRunRequest(profile_id = profileId, bot_id = botId, input = text))
                pending = null
                input = ""
                val now = System.currentTimeMillis()
                // 202 devolve apenas {id,status}; completa com o que já sabemos para exibir de imediato.
                merge(
                    listOf(
                        created.copy(
                            profile_id = created.profile_id.ifBlank { profileId },
                            bot_id = created.bot_id.ifBlank { botId },
                            input = created.input.ifBlank { text },
                            status = created.status.ifBlank { "queued" },
                            created = if (created.created > 0) created.created else now,
                            updated = if (created.updated > 0) created.updated else now,
                        ),
                    ),
                )
                poll(created.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                pending = null
                sendError = if (e.isIdempotencyConflict) "O servidor já recebeu um pedido diferente com a mesma chave. Toque em Enviar novamente." else container.handleError(e)
            } catch (e: IOException) {
                sendError = ApiClient.describe(e) + " Toque em Enviar para repetir o mesmo pedido."
            } catch (e: Exception) {
                pending = null
                sendError = ApiClient.describe(e)
            } finally {
                sending = false
            }
        }
    }

    fun clearSendError() { sendError = null }

    /** Consulta GET /bot-runs/{id} a cada 2 s até estado final. */
    fun poll(id: String) {
        if (pollJobs[id]?.isActive == true) return
        pollJobs[id] = viewModelScope.launch {
            var failures = 0
            while (isActive) {
                delay(POLL_INTERVAL_MS)
                try {
                    val remote = container.api.botRun(id)
                    val local = runs.firstOrNull { it.id == id }
                    val merged = if (local == null) remote else remote.copy(
                        input = remote.input.ifBlank { local.input },
                        bot_id = remote.bot_id.ifBlank { local.bot_id },
                        created = if (remote.created > 0) remote.created else local.created,
                    )
                    merge(listOf(merged))
                    pollError = null
                    failures = 0
                    if (merged.isFinal) break
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    if (e.isUnauthorized) { container.onLoggedOut(keepServer = true); break }
                    if (e.status == 404) { pollError = e.message; break }
                    if (++failures >= 5) { pollError = e.message; break }
                } catch (e: Exception) {
                    if (++failures >= 10) { pollError = ApiClient.describe(e); break }
                }
            }
        }
    }

    fun resumePolling() {
        pollError = null
        runs.filter { !it.isFinal }.forEach { poll(it.id) }
    }

    fun cancel(id: String) {
        viewModelScope.launch {
            try {
                container.api.cancelBotRun(profileId, id, ApiClient.newIdempotencyKey())
                runs.firstOrNull { it.id == id }?.let { merge(listOf(it.copy(status = "cancelling", updated = System.currentTimeMillis()))) }
                poll(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                sendError = container.handleError(e)
            }
        }
    }
}

/** Conversa com um bot: histórico de execuções, envio, acompanhamento a cada 2 s, anexos, cancelar e copiar resposta. */
@Composable
fun BotChatScreen(container: AppContainer, botId: String, conversationId: String?, onBack: () -> Unit) {
    val profileId = container.session.profileId ?: ""
    val vm: BotChatViewModel = viewModel(key = "bot-$profileId-$botId-${conversationId ?: ""}") {
        BotChatViewModel(container, profileId, botId, conversationId)
    }
    LaunchedEffect(vm) { vm.start() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, vm) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                delay(4000)
                vm.refresh()
            }
        }
    }

    val c = Wb.colors
    val clipboard = LocalClipboardManager.current
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val haptics = rememberHaptics()

    // Rola até o fim quando chega uma execução nova ou a última muda de estado.
    val lastRun = vm.runs.lastOrNull()
    LaunchedEffect(vm.runs.size, lastRun?.status, lastRun?.result) {
        if (vm.runs.isNotEmpty()) listState.animateScrollToItem(vm.runs.size - 1)
    }

    fun showMessage(text: String) {
        if (text.isBlank()) return
        scope.launch { snackbar.showSnackbar(text) }
    }

    val botName = vm.bot?.name?.ifBlank { null } ?: "Bot"
    Scaffold(
        containerColor = c.chatWallpaper,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                ChatTopBar(
                    name = botName,
                    subtitle = vm.contextTitle ?: "Bot da equipe",
                    onBack = onBack,
                    avatar = { Avatar(botName, seed = botId, size = 40.dp, kind = AvatarKind.Bot) },
                )
                ConnectionStrip(container)
            }
        },
        bottomBar = {
            ChatComposer(
                value = vm.input,
                onValueChange = { vm.input = it; if (vm.sendError != null) vm.clearSendError() },
                placeholder = "Pergunte ao bot",
                onSend = { haptics.tick(); vm.send() },
                canSend = !vm.sending && vm.input.isNotBlank() && vm.input.length <= INPUT_MAX,
                enabled = !vm.sending,
                sending = vm.sending,
                sendDescription = if (vm.pending != null) "Repetir envio" else "Enviar ao bot",
                counter = if (vm.input.length > INPUT_MAX - 5_000) "${vm.input.length}/$INPUT_MAX" else null,
                counterError = vm.input.length > INPUT_MAX,
                above = {
                    vm.sendError?.let { InlineNotice(it, Modifier.padding(bottom = 6.dp), onDismiss = { vm.clearSendError() }) }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when {
                vm.loading && vm.runs.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp, color = c.bot)
                }
                vm.error != null && vm.runs.isEmpty() -> ErrorState(vm.error ?: "", onRetry = { vm.load() })
                vm.runs.isEmpty() -> EmptyState(
                    Icons.Filled.SmartToy,
                    "Pergunte algo ao bot",
                    subtitle = "A resposta aparece aqui. Anexos podem ser abertos, baixados ou compartilhados.",
                )
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(vm.runs, key = { it.id }) { run ->
                        RunTurn(
                            run = run,
                            botName = botName,
                            container = container,
                            profileId = profileId,
                            onCancel = { vm.cancel(run.id) },
                            onCopy = { text ->
                                clipboard.setText(AnnotatedString(text))
                                showMessage(if (conversationId != null) "Resposta copiada. Cole no campo de mensagem da conversa." else "Resposta copiada.")
                            },
                            onMessage = { showMessage(it) },
                        )
                    }
                    if (vm.pollError != null) {
                        item {
                            InlineNotice(
                                "Não foi possível acompanhar a execução: ${vm.pollError}",
                                actionLabel = "Continuar",
                                onAction = { vm.resumePolling() },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RunTurn(
    run: BotRun,
    botName: String,
    container: AppContainer,
    profileId: String,
    onCancel: () -> Unit,
    onCopy: (String) -> Unit,
    onMessage: (String) -> Unit,
) {
    val c = Wb.colors
    val active = isRunActive(run.status)
    val output = run.output()
    Column(Modifier.fillMaxWidth()) {
        // Pergunta (direita)
        ChatBubble(outgoing = true) {
            SelectionContainer { BubbleText(run.input.ifBlank { "(sem texto)" }, formatWhen(run.created), timeColor = c.bubbleOutMeta) }
        }
        Spacer(Modifier.height(6.dp))
        // Resposta (esquerda)
        ChatBubble(outgoing = false) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("🤖 $botName", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = c.bot, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(8.dp))
                if (active) {
                    CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = c.bot)
                    Spacer(Modifier.width(6.dp))
                }
                Pill(botRunStatusLabel(run.status), botRunStatusColor(run.status))
            }
            if (output.text.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                SelectionContainer { Text(output.text, style = MaterialTheme.typography.bodyLarge, color = c.textPrimary) }
            }
            run.error?.takeIf { it.isNotBlank() }?.let { err ->
                Spacer(Modifier.height(6.dp))
                // Enquanto roda, `error` traz avisos ("Aguardando aprovação no Hermes"); ao falhar, o motivo.
                Text(err, color = if (active) c.textSecondary else c.danger, style = MaterialTheme.typography.bodySmall)
            }
            if (!active && output.text.isBlank() && run.error.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    when (run.status) {
                        "cancelled" -> "Execução cancelada."
                        "unknown" -> "O Wabotia não conseguiu confirmar o resultado no Hermes."
                        else -> "Sem resposta em texto."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                )
            }
            if (output.attachments.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    output.attachments.forEach { mediaId -> AttachmentChip(container, profileId, mediaId, onMessage) }
                }
            }
            val canCancel = active && run.status != "cancelling"
            val canCopy = output.text.isNotBlank()
            if (canCancel || canCopy) {
                Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (canCancel) {
                        TextButton(onClick = onCancel, contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.danger)
                            Spacer(Modifier.width(4.dp))
                            Text("Cancelar", color = c.danger)
                        }
                    }
                    if (canCopy) {
                        TextButton(onClick = { onCopy(output.text) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Copiar resposta")
                        }
                    }
                }
            }
            BubbleTime(formatTime(if (run.updated > 0) run.updated else run.created))
        }
    }
}

/** Anexo de uma execução: nome e tamanho; toque abre o menu Abrir / Baixar / Compartilhar. */
@Composable
private fun AttachmentChip(container: AppContainer, profileId: String, mediaId: String, onMessage: (String) -> Unit) {
    val c = Wb.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var info by remember(mediaId) { mutableStateOf<BotAttachments.Info?>(null) }
    var busy by remember(mediaId) { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    LaunchedEffect(mediaId) {
        try {
            info = BotAttachments.probe(container, profileId, mediaId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Sem metadados: o chip mostra o identificador; abrir/baixar continuam funcionando.
        }
    }

    fun withFile(action: suspend (java.io.File, String) -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val (file, type) = BotAttachments.download(context, container, profileId, mediaId)
                action(file, type)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onMessage(container.handleError(e))
            } finally {
                busy = false
            }
        }
    }

    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(c.soft(c.textSecondary, 0.1f))
                .clickable(enabled = !busy) { menu = true }
                .heightIn(min = 48.dp)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.brand)
            else Icon(Icons.Filled.AttachFile, contentDescription = null, tint = c.brand, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(info?.name ?: "Anexo ${mediaId.take(8)}", style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                info?.size?.let { Text(MediaKinds.formatSize(it), style = MaterialTheme.typography.labelSmall, color = c.textSecondary) }
            }
            Icon(Icons.Filled.Download, contentDescription = "Opções do anexo", tint = c.textSecondary, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Abrir") },
                leadingIcon = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null) },
                onClick = { menu = false; withFile { file, type -> BotAttachments.open(context, file, type) } },
            )
            DropdownMenuItem(
                text = { Text("Baixar") },
                leadingIcon = { Icon(Icons.Filled.Download, contentDescription = null) },
                onClick = {
                    menu = false
                    withFile { file, type ->
                        val saved = BotAttachments.saveToDownloads(context, file, type)
                        if (saved) onMessage("Salvo em Downloads: ${file.name}")
                    }
                },
            )
            DropdownMenuItem(
                text = { Text("Compartilhar") },
                leadingIcon = { Icon(Icons.Filled.Share, contentDescription = null) },
                onClick = { menu = false; withFile { file, type -> BotAttachments.share(context, file, type) } },
            )
        }
    }
}
