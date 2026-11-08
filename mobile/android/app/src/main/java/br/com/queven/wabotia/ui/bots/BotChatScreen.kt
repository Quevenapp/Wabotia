@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.bots

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.BotRun
import br.com.queven.wabotia.core.model.BotRunRequest
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.Locale

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
                error = container.describeError(e)
            } finally {
                loading = false
            }
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
                sendError = if (e.isIdempotencyConflict) "O servidor já recebeu um pedido diferente com a mesma chave. Toque em Enviar novamente." else container.describeError(e)
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
                sendError = container.describeError(e)
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

    val clipboard = LocalClipboardManager.current
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    // Rola até o fim quando chega uma execução nova ou a última muda de estado.
    val lastRun = vm.runs.lastOrNull()
    LaunchedEffect(vm.runs.size, lastRun?.status, lastRun?.result) {
        if (vm.runs.isNotEmpty()) listState.animateScrollToItem(vm.runs.size - 1)
    }

    fun showMessage(text: String) {
        if (text.isBlank()) return
        scope.launch { snackbar.showSnackbar(text) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(vm.bot?.name?.ifBlank { null } ?: "Bot", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            vm.contextTitle ?: "Equipe Bot · Hermes",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar") } },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Composer(
                value = vm.input,
                onValueChange = { vm.input = it; if (vm.sendError != null) vm.clearSendError() },
                sending = vm.sending,
                error = vm.sendError,
                retry = vm.pending != null,
                onSend = { vm.send() },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when {
                vm.loading && vm.runs.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                vm.error != null && vm.runs.isEmpty() -> Column(
                    Modifier.fillMaxSize().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(vm.error ?: "", color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { vm.load() }) { Text("Tentar novamente") }
                }
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (vm.runs.isEmpty()) {
                        item {
                            Text(
                                "Pergunte algo ao bot. A execução roda no Hermes e a resposta aparece aqui; anexos podem ser abertos ou baixados.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    items(vm.runs, key = { it.id }) { run ->
                        RunTurn(
                            run = run,
                            container = container,
                            profileId = profileId,
                            onCancel = { vm.cancel(run.id) },
                            onCopy = { text ->
                                clipboard.setText(AnnotatedString(text))
                                showMessage(if (conversationId != null) "Resposta copiada. Cole no composer da conversa." else "Resposta copiada.")
                            },
                            onMessage = { showMessage(it) },
                        )
                    }
                    if (vm.pollError != null) {
                        item {
                            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("Não foi possível acompanhar a execução: ${vm.pollError}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = { vm.resumePolling() }) { Text("Continuar acompanhando") }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(value: String, onValueChange: (String) -> Unit, sending: Boolean, error: String?, retry: Boolean, onSend: () -> Unit) {
    Surface(tonalElevation = 3.dp) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 8.dp, vertical = 8.dp)) {
            if (error != null) {
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
            }
            Row(verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = value,
                    onValueChange = onValueChange,
                    modifier = Modifier.weight(1f),
                    enabled = !sending,
                    placeholder = { Text("Pergunte ao bot…") },
                    maxLines = 6,
                    isError = value.length > INPUT_MAX,
                    supportingText = if (value.length > INPUT_MAX - 5_000) {
                        { Text("${value.length}/$INPUT_MAX", color = if (value.length > INPUT_MAX) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
                    } else null,
                )
                Spacer(Modifier.width(4.dp))
                IconButton(onClick = onSend, enabled = !sending && value.isNotBlank() && value.length <= INPUT_MAX) {
                    if (sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Icon(Icons.AutoMirrored.Filled.Send, contentDescription = if (retry) "Repetir envio" else "Enviar ao bot", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun RunTurn(
    run: BotRun,
    container: AppContainer,
    profileId: String,
    onCancel: () -> Unit,
    onCopy: (String) -> Unit,
    onMessage: (String) -> Unit,
) {
    val active = isRunActive(run.status)
    val output = run.output()
    Column(Modifier.fillMaxWidth()) {
        // Pergunta (direita)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 4.dp, bottomEnd = 16.dp, bottomStart = 16.dp),
                modifier = Modifier.widthIn(max = 320.dp),
            ) {
                Column(Modifier.padding(12.dp)) {
                    SelectionContainer { Text(run.input.ifBlank { "(sem texto)" }, style = MaterialTheme.typography.bodyMedium) }
                    Text(formatWhen(run.created), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        // Resposta (esquerda)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                shape = RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomEnd = 16.dp, bottomStart = 16.dp),
                modifier = Modifier.widthIn(max = 340.dp),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (active) {
                            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(
                            botRunStatusLabel(run.status),
                            color = botRunStatusColor(run.status),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(formatWhen(if (run.updated > 0) run.updated else run.created), style = MaterialTheme.typography.labelSmall)
                    }
                    if (output.text.isNotBlank()) {
                        Spacer(Modifier.height(6.dp))
                        SelectionContainer {
                            Text(output.text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                    run.error?.takeIf { it.isNotBlank() }?.let { err ->
                        Spacer(Modifier.height(6.dp))
                        // Enquanto roda, `error` traz avisos ("Aguardando aprovação no Hermes"); ao falhar, o motivo.
                        Text(err, color = if (active) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    if (!active && output.text.isBlank() && run.error.isNullOrBlank()) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            when (run.status) {
                                "cancelled" -> "Execução cancelada."
                                "unknown" -> "O Wabotia não conseguiu confirmar o resultado no Hermes."
                                else -> "Sem resposta em texto."
                            },
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (output.attachments.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text("Anexos", style = MaterialTheme.typography.labelMedium)
                        output.attachments.forEach { mediaId ->
                            AttachmentChip(container, profileId, mediaId, onMessage)
                        }
                    }
                    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (active && run.status != "cancelling") {
                            TextButton(onClick = onCancel) {
                                Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Cancelar")
                            }
                        }
                        if (output.text.isNotBlank()) {
                            TextButton(onClick = { onCopy(output.text) }) {
                                Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Copiar resposta")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentChip(container: AppContainer, profileId: String, mediaId: String, onMessage: (String) -> Unit) {
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
                onMessage(container.describeError(e))
            } finally {
                busy = false
            }
        }
    }

    val label = buildString {
        append(info?.name ?: "Anexo ${mediaId.take(8)}")
        info?.size?.let { append(" · ").append(formatSize(it)) }
    }
    Box {
        AssistChip(
            onClick = { menu = true },
            enabled = !busy,
            label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = {
                if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                else Icon(Icons.Filled.AttachFile, contentDescription = null, modifier = Modifier.size(16.dp))
            },
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Abrir") },
                leadingIcon = { Icon(Icons.Filled.OpenInNew, contentDescription = null) },
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

private fun formatSize(bytes: Long): String = when {
    bytes < 1024L -> "$bytes B"
    bytes < 1024L * 1024L -> String.format(Locale.getDefault(), "%.0f KB", bytes / 1024.0)
    else -> String.format(Locale.getDefault(), "%.1f MB", bytes / (1024.0 * 1024.0))
}
