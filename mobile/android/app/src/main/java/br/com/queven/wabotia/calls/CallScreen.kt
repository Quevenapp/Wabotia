package br.com.queven.wabotia.calls

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Call
import br.com.queven.wabotia.core.model.CallAccept
import br.com.queven.wabotia.core.model.CallPermissionRequest
import br.com.queven.wabotia.core.model.CallReconcile
import br.com.queven.wabotia.core.model.CallStart
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.array
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.obj
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.core.push.Notifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import org.webrtc.PeerConnection

/**
 * Tela da ligação de voz (WebRTC áudio, sinalização pela API Wabotia / Meta Calling API).
 *
 * Receber: claim → oferta → answer → pre_accept e accept com a mesma sessão. Ligar: exige conversa assumida e
 * `capabilities.calls`; Verificar/Pedir permissão; oferta → POST /calls → consulta a cada 2,5 s até a answer.
 * Durante a chamada: keepalive a cada 20 s, silenciar, viva-voz, cronômetro, Encerrar; `unknown` → Confirmar encerramento.
 * Sair da tela encerra a chamada conduzida NESTA tela (atendida ou iniciada aqui) e para o [CallService]. Quando a tela
 * apenas acompanha uma ligação cujo áudio está no painel ou em outro aparelho, sair não encerra nada (como o painel web,
 * que só termina a chamada que ele mesmo conduz): encerrar é a ação explícita do botão.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallScreen(container: AppContainer, conversationId: String, callId: String?, onClose: () -> Unit) {
    val vm: CallViewModel = viewModel(key = "call-$conversationId-${callId ?: "new"}") { CallViewModel(container, conversationId, callId) }
    val context = LocalContext.current

    // Permissão de microfone em tempo de execução: a ação pendente roda quando a pessoa concede.
    var pendingMicAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val action = pendingMicAction
        pendingMicAction = null
        if (granted) action?.invoke() else vm.onMicrophoneDenied()
    }
    fun withMicrophone(action: () -> Unit) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) action()
        else {
            pendingMicAction = action
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    BackHandler { onClose() }

    var confirmReconcile by remember { mutableStateOf(false) }
    if (confirmReconcile) {
        AlertDialog(
            onDismissRequest = { confirmReconcile = false },
            title = { Text("Confirmar encerramento") },
            text = { Text("Você conferiu no WhatsApp que esta ligação terminou? A confirmação marca a ligação como encerrada sem contatar a Meta.") },
            confirmButton = { TextButton(onClick = { confirmReconcile = false; vm.reconcile() }) { Text("Sim, terminou") } },
            dismissButton = { TextButton(onClick = { confirmReconcile = false }) { Text("Cancelar") } },
        )
    }

    val name = vm.detail?.conversation?.displayName ?: "Ligação"
    val phone = vm.detail?.conversation?.phone

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (vm.detail == null) "Ligação" else "Ligação de voz") },
                navigationIcon = {
                    IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            Box(
                Modifier.size(96.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    name.trim().take(1).uppercase().ifBlank { "?" },
                    style = MaterialTheme.typography.displaySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            Spacer(Modifier.height(16.dp))
            Text(name, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
            if (!phone.isNullOrBlank() && phone != name) {
                Text(phone, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(12.dp))

            Text(vm.statusLabel(), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, textAlign = TextAlign.Center)
            if (vm.call?.status == "active") {
                Text(CallText.duration(vm.elapsedSeconds), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Medium)
            }
            if (vm.busy || vm.phase == CallPhase.LOADING) {
                Spacer(Modifier.height(12.dp))
                CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            }
            vm.note?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            vm.error?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            }
            vm.permissionSummary?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }

            Spacer(Modifier.height(32.dp))

            when (vm.phase) {
                CallPhase.LOADING -> Unit

                CallPhase.INCOMING -> Row(horizontalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(
                        onClick = { vm.rejectIncoming() }, enabled = !vm.busy, modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    ) {
                        Icon(Icons.Filled.CallEnd, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Recusar")
                    }
                    Button(
                        onClick = { withMicrophone { vm.accept() } }, enabled = !vm.busy, modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E9E5A), contentColor = Color.White),
                    ) {
                        Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Atender")
                    }
                }

                CallPhase.READY -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    val canCall = vm.canStartCall()
                    if (!canCall) {
                        Text(vm.cannotCallReason(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        OutlinedButton(onClick = { vm.checkPermission() }, enabled = !vm.busy && canCall, modifier = Modifier.weight(1f)) { Text("Verificar permissão") }
                        OutlinedButton(onClick = { vm.requestPermission() }, enabled = !vm.busy && canCall, modifier = Modifier.weight(1f)) { Text("Pedir permissão") }
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = { withMicrophone { vm.startCall() } }, enabled = !vm.busy && canCall, modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E9E5A), contentColor = Color.White),
                    ) {
                        Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Ligar")
                    }
                }

                CallPhase.NEGOTIATING -> Text("Preparando o áudio…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

                CallPhase.IN_CALL -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    val status = vm.call?.status ?: ""
                    if (vm.hasAudio) {
                        Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                            ToggleControl(
                                active = vm.muted,
                                icon = if (vm.muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                                label = if (vm.muted) "Ativar microfone" else "Silenciar",
                                onClick = { vm.toggleMute() },
                            )
                            ToggleControl(
                                active = vm.speaker,
                                icon = if (vm.speaker) Icons.Filled.VolumeUp else Icons.Filled.VolumeOff,
                                label = "Viva-voz",
                                onClick = { vm.toggleSpeaker() },
                            )
                        }
                        Spacer(Modifier.height(24.dp))
                    }
                    if (status == "unknown") {
                        Button(onClick = { confirmReconcile = true }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth()) { Text("Confirmar encerramento") }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "A Meta não confirmou esta ligação. Confira no WhatsApp se ela terminou antes de confirmar; não inicie outra ligação enquanto isso.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                        )
                    } else {
                        Button(
                            onClick = { vm.hangUp() }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                        ) {
                            Icon(Icons.Filled.CallEnd, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(if (vm.terminatePending) "Tentar encerrar novamente" else "Encerrar")
                        }
                    }
                }

                CallPhase.ENDED -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Button(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Fechar") }
                }
            }
        }
    }
}

@Composable
private fun ToggleControl(active: Boolean, icon: ImageVector, label: String, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        FilledIconButton(
            onClick = onClick,
            modifier = Modifier.size(56.dp),
            colors = IconButtonDefaults.filledIconButtonColors(
                containerColor = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                contentColor = if (active) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
            ),
        ) { Icon(icon, contentDescription = label) }
        Spacer(Modifier.height(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}

enum class CallPhase { LOADING, INCOMING, READY, NEGOTIATING, IN_CALL, ENDED }

class CallViewModel(
    private val container: AppContainer,
    private val conversationId: String,
    private val initialCallId: String?,
) : ViewModel() {
    var phase by mutableStateOf(CallPhase.LOADING)
        private set
    var call by mutableStateOf<Call?>(null)
        private set
    var detail by mutableStateOf<ConversationDetail?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var note by mutableStateOf<String?>(null)
        private set
    var permissionSummary by mutableStateOf<String?>(null)
        private set
    var muted by mutableStateOf(false)
        private set
    var speaker by mutableStateOf(false)
        private set
    var elapsedSeconds by mutableStateOf(0L)
        private set
    /** Há áudio WebRTC neste aparelho (não apenas acompanhamento de uma ligação assumida em outro lugar). */
    var hasAudio by mutableStateOf(false)
        private set
    /** Um pedido de encerramento falhou na rede; repetir reutiliza a mesma Idempotency-Key. */
    var terminatePending by mutableStateOf(false)
        private set

    private val profile: String? get() = container.session.profileId
    private val meId: String? get() = container.session.user?.id

    private var engine: CallEngine? = null
    private var pollJob: Job? = null
    private var keepaliveJob: Job? = null
    private var timerJob: Job? = null
    private var engineStateJob: Job? = null
    private var answerApplied = false
    private var activeSince: Long? = null
    private var serviceRunning = false
    private var ended = false
    /**
     * A chamada é conduzida nesta tela (assumida em [accept] ou iniciada em [startCall]). Só nesse caso sair da tela
     * encerra a ligação; no modo de acompanhamento ([load] com áudio em outro lugar) sair apenas para a consulta.
     */
    private var ownsCall = false
    private var terminateKey: String? = null
    private var reconcileKey: String? = null

    init {
        viewModelScope.launch { load() }
    }

    // --- carga inicial ---

    private suspend fun load() {
        val p = profile ?: run { error = "Perfil não selecionado."; phase = CallPhase.ENDED; return }
        try {
            detail = container.api.conversation(p, conversationId)
        } catch (e: Exception) {
            error = describe(e)
        }
        val id = initialCallId
        if (id != null) {
            try {
                val current = container.api.call(p, id)
                call = current
                when {
                    CallText.isFinal(current.status) -> {
                        phase = CallPhase.ENDED
                        note = "Esta ligação já terminou."
                    }
                    CallText.isRingingFor(current, meId) -> phase = CallPhase.INCOMING
                    current.actor == meId -> {
                        // Já assumida por mim (outro aparelho ou painel): acompanhar e permitir encerrar.
                        note = "O áudio desta ligação está em outro aparelho ou no painel. Sair desta tela não a encerra."
                        enterCall(current, withAudio = false)
                    }
                    else -> {
                        phase = CallPhase.ENDED
                        error = "Outro atendente já assumiu esta ligação."
                    }
                }
            } catch (e: Exception) {
                error = describe(e)
                phase = CallPhase.ENDED
            }
        } else {
            // Ligar: se já houver ligação minha em andamento nesta conversa, acompanha em vez de abrir outra.
            val live = runCatching { container.api.calls(p, conversationId = conversationId, limit = 5).data }.getOrNull().orEmpty()
                .firstOrNull { !CallText.isFinal(it.status) && it.actor == meId }
            if (live != null) {
                call = live
                note = "Já existe uma ligação sua em andamento nesta conversa."
                enterCall(live, withAudio = false)
            } else {
                phase = CallPhase.READY
            }
        }
    }

    fun canStartCall(): Boolean {
        val d = detail ?: return false
        return d.conversation.isOwnedBy(meId) && d.can("calls") && !d.conversation.isGroup
    }

    fun cannotCallReason(): String {
        val d = detail ?: return "Não foi possível carregar a conversa."
        return when {
            d.conversation.isGroup -> "Ligações só estão disponíveis em conversas individuais."
            !d.can("calls") -> "Este canal não oferece ligações de voz."
            !d.conversation.isOwnedBy(meId) -> "Assuma a conversa antes de ligar."
            else -> ""
        }
    }

    fun statusLabel(): String = when (phase) {
        CallPhase.LOADING -> "Carregando…"
        CallPhase.INCOMING -> "Recebendo ligação"
        CallPhase.READY -> "Pronto para ligar"
        CallPhase.NEGOTIATING -> call?.let { CallText.status(it.status) } ?: "Preparando áudio"
        CallPhase.IN_CALL -> call?.let { CallText.status(it.status) } ?: "Conectando áudio"
        CallPhase.ENDED -> call?.let { CallText.status(it.status) } ?: "Encerrada"
    }

    fun onMicrophoneDenied() {
        error = "Sem acesso ao microfone não é possível participar da ligação. Permita o microfone nas configurações do aplicativo."
    }

    // --- receber ---

    fun accept() {
        val p = profile ?: return
        val current = call ?: return
        if (busy) return
        busy = true; error = null; note = null
        phase = CallPhase.NEGOTIATING
        viewModelScope.launch {
            var claimed = false
            try {
                val claimedCall = container.api.claimCall(p, current.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap()))
                claimed = true
                ownsCall = true
                call = claimedCall
                Notifications.cancelIncomingCall(container.appContext, current.id)
                val offer = claimedCall.session?.takeIf { it.sdp_type == "offer" && it.sdp.isNotBlank() }
                    ?: throw CallEngineException("A oferta de áudio ainda não chegou. Aguarde a atualização e tente de novo.")
                val eng = newEngine()
                val session = eng.createAnswer(offer.sdp)
                // Pré-aceitar estabelece a mídia antes de avisar o cliente; o microfone fica mudo até o accept.
                eng.setMuted(true)
                container.api.preAcceptCall(p, current.id, ApiClient.newIdempotencyKey(), CallAccept(session))
                container.api.acceptCall(p, current.id, ApiClient.newIdempotencyKey(), CallAccept(session))
                eng.setMuted(muted)
                note = "Ligação atendida."
                enterCall(call?.copy(status = "active") ?: current.copy(status = "active"), withAudio = true)
            } catch (e: Exception) {
                error = describe(e)
                closeEngine()
                if (claimed) {
                    // Assumimos mas não conseguimos conectar: recusar para liberar a ligação (uma única vez).
                    runCatching { container.api.rejectCall(p, current.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap())) }
                }
                phase = CallPhase.ENDED
                call = call?.copy(status = if (claimed) "rejected" else current.status)
            } finally {
                busy = false
            }
        }
    }

    fun rejectIncoming() {
        val p = profile ?: return
        val current = call ?: return
        if (busy) return
        busy = true; error = null
        viewModelScope.launch {
            try {
                runCatching { container.api.claimCall(p, current.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap())) }
                    .onFailure { if (it is ApiException && it.isUnauthorized) throw it }
                container.api.rejectCall(p, current.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap()))
                Notifications.cancelIncomingCall(container.appContext, current.id)
                call = current.copy(status = "rejected")
                note = "Ligação recusada."
                phase = CallPhase.ENDED
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                busy = false
            }
        }
    }

    // --- ligar ---

    fun checkPermission() {
        val p = profile ?: return
        if (busy) return
        busy = true; error = null; note = null
        viewModelScope.launch {
            try {
                val result = container.api.callPermission(p, conversationId)
                permissionSummary = summarizePermission(result)
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                busy = false
            }
        }
    }

    fun requestPermission() {
        val p = profile ?: return
        if (busy) return
        busy = true; error = null; note = null
        viewModelScope.launch {
            try {
                container.api.requestCallPermission(p, ApiClient.newIdempotencyKey(), CallPermissionRequest(conversationId))
                note = "Pedido de permissão entrou na fila. Aguarde a resposta do cliente."
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                busy = false
            }
        }
    }

    fun startCall() {
        val p = profile ?: return
        if (busy || !canStartCall()) return
        busy = true; error = null; note = null
        phase = CallPhase.NEGOTIATING
        viewModelScope.launch {
            try {
                val eng = newEngine()
                val offer = eng.createOffer()
                val created = container.api.startCall(p, ApiClient.newIdempotencyKey(), CallStart(conversation_id = conversationId, session = offer))
                call = created
                ownsCall = true
                if (created.status == "unknown" || created.status == "failed") {
                    closeEngine()
                    error = created.error ?: "Ligação não confirmada."
                    if (created.status == "unknown") enterCall(created, withAudio = false) else phase = CallPhase.ENDED
                } else {
                    note = "Aguardando o cliente atender."
                    enterCall(created, withAudio = true)
                }
            } catch (e: Exception) {
                error = describe(e)
                closeEngine()
                phase = CallPhase.READY
            } finally {
                busy = false
            }
        }
    }

    // --- durante a chamada ---

    fun toggleMute() {
        muted = !muted
        engine?.setMuted(muted)
    }

    fun toggleSpeaker() {
        speaker = !speaker
        engine?.setSpeaker(speaker)
    }

    fun hangUp() {
        val p = profile ?: return
        val current = call ?: return
        if (busy) return
        busy = true; error = null
        val key = terminateKey ?: ApiClient.newIdempotencyKey().also { terminateKey = it }
        viewModelScope.launch {
            try {
                container.api.terminateCall(p, current.id, key, JsonObject(emptyMap()))
                terminatePending = false
                call = current.copy(status = "completed")
                finish("Ligação encerrada.")
            } catch (e: Exception) {
                if (e is ApiException && !e.isUnauthorized && e.status in 400..499) {
                    // O servidor respondeu (ex.: a ligação já terminou): não há o que repetir.
                    terminatePending = false
                    terminateKey = null
                    error = e.message
                    refreshOnce(p, current.id)
                } else {
                    // Sem resposta: não repetir automaticamente; a pessoa decide tentar de novo com a mesma chave.
                    terminatePending = true
                    error = describe(e)
                }
            } finally {
                busy = false
            }
        }
    }

    fun reconcile() {
        val p = profile ?: return
        val current = call ?: return
        if (busy) return
        busy = true; error = null
        val key = reconcileKey ?: ApiClient.newIdempotencyKey().also { reconcileKey = it }
        viewModelScope.launch {
            try {
                container.api.reconcileCall(p, current.id, key, CallReconcile(confirmed_ended = true))
                call = current.copy(status = "completed")
                finish("Encerramento confirmado.")
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                busy = false
            }
        }
    }

    // --- interno ---

    private fun newEngine(): CallEngine {
        closeEngine()
        val eng = CallEngine(container.appContext)
        eng.start()
        eng.setMuted(muted)
        eng.setSpeaker(speaker)
        engine = eng
        engineStateJob?.cancel()
        engineStateJob = viewModelScope.launch {
            eng.connectionState.collect { state ->
                if (state == PeerConnection.PeerConnectionState.FAILED && !ended) {
                    error = "A rede não conectou o áudio. Encerre a ligação e verifique firewall, VPN ou acesso UDP."
                }
            }
        }
        return eng
    }

    private fun closeEngine() {
        engineStateJob?.cancel(); engineStateJob = null
        engine?.close()
        engine = null
        hasAudio = false
    }

    /** Entra no modo de acompanhamento da chamada: consulta de estado, keepalive, cronômetro e serviço em primeiro plano. */
    private fun enterCall(current: Call, withAudio: Boolean) {
        val p = profile ?: return
        call = current
        hasAudio = withAudio && engine != null
        phase = CallPhase.IN_CALL
        ended = false
        if (current.status == "active" && activeSince == null) activeSince = current.started ?: System.currentTimeMillis()
        if (withAudio) startService()
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(2_500)
                poll(p, current.id)
            }
        }
        keepaliveJob?.cancel()
        keepaliveJob = viewModelScope.launch {
            while (isActive) {
                delay(20_000)
                val c = call ?: break
                if (CallText.isFinal(c.status)) break
                runCatching { container.api.keepaliveCall(p, c.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap())) }
            }
        }
        timerJob?.cancel()
        timerJob = viewModelScope.launch {
            while (isActive) {
                val since = activeSince
                if (since != null) elapsedSeconds = ((System.currentTimeMillis() - since) / 1000).coerceAtLeast(0)
                delay(1_000)
            }
        }
    }

    private suspend fun poll(p: String, id: String) {
        val outbound = call?.direction == "outbound"
        val wantSession = outbound && hasAudio && !answerApplied
        val updated = try {
            container.api.call(p, id, session = if (wantSession) "1" else null)
        } catch (e: Exception) {
            if (e is ApiException && e.isUnauthorized) { container.onLoggedOut(keepServer = true); return }
            // Falha momentânea de rede: mantém o estado atual e tenta na próxima rodada.
            return
        }
        if (ended) return
        call = updated
        if (updated.status == "active" && activeSince == null) activeSince = updated.started ?: System.currentTimeMillis()
        if (updated.status == "active" && hasAudio && !serviceRunning) startService()
        if (CallText.isFinal(updated.status)) {
            finish(
                when (updated.status) {
                    "missed" -> "O cliente não atendeu."
                    "rejected" -> "Ligação recusada."
                    "failed" -> updated.error ?: "A ligação falhou."
                    else -> "Ligação encerrada."
                },
            )
            return
        }
        val answer = updated.session?.takeIf { it.sdp_type == "answer" && it.sdp.isNotBlank() }
        if (wantSession && answer != null) {
            val eng = engine ?: return
            answerApplied = true
            try {
                eng.applyAnswer(answer.sdp)
                note = null
            } catch (e: Exception) {
                error = "Não foi possível conectar o áudio. Encerre a ligação e confira a rede."
            }
        }
    }

    private suspend fun refreshOnce(p: String, id: String) {
        val updated = runCatching { container.api.call(p, id) }.getOrNull() ?: return
        call = updated
        if (CallText.isFinal(updated.status)) finish("Ligação encerrada.")
    }

    private fun finish(message: String) {
        if (ended) return
        ended = true
        pollJob?.cancel(); pollJob = null
        keepaliveJob?.cancel(); keepaliveJob = null
        timerJob?.cancel(); timerJob = null
        closeEngine()
        stopService()
        note = message
        phase = CallPhase.ENDED
    }

    private fun startService() {
        if (serviceRunning) return
        serviceRunning = true
        runCatching { CallService.start(container.appContext, detail?.conversation?.displayName ?: "Ligação de voz") }
    }

    private fun stopService() {
        if (!serviceRunning) return
        serviceRunning = false
        runCatching { CallService.stop(container.appContext) }
    }

    private fun describe(e: Throwable): String {
        if (e is ApiException && e.isUnauthorized) container.onLoggedOut(keepServer = true)
        return if (e is CallEngineException) e.message ?: "Falha no áudio." else ApiClient.describe(e)
    }

    /** Resume GET /call-permission (formato da Meta: permission.status e actions[].can_perform_action). */
    private fun summarizePermission(result: JsonObject): String {
        val status = result.obj("permission")?.string("status")
        val statusText = when (status) {
            null -> "Consultar novamente"
            "no_permission" -> "Ainda não concedida"
            "temporary" -> "Concedida temporariamente"
            "permanent" -> "Concedida"
            else -> status
        }
        val canCall = result.array("actions")?.any { el ->
            val o = el as? JsonObject ?: return@any false
            o.string("action_name") == "start_call" && o.bool("can_perform_action") == true
        } ?: false
        val canRequest = result.array("actions")?.any { el ->
            val o = el as? JsonObject ?: return@any false
            o.string("action_name") == "send_call_permission_request" && o.bool("can_perform_action") == true
        } ?: false
        val action = when {
            canCall -> "Pode ligar agora."
            canRequest -> "Ainda não pode ligar; peça permissão ao cliente."
            else -> "Aguarde a autorização ou o fim do limite informado pela Meta."
        }
        return "Permissão Meta: $statusText · $action"
    }

    override fun onCleared() {
        // Sair da tela encerra a chamada conduzida aqui: fecha o áudio, para o serviço e pede o encerramento uma única vez.
        // No modo de acompanhamento (ownsCall = false: o áudio está no painel ou em outro aparelho) apenas para as consultas,
        // senão voltar da tela derrubaria a ligação que o painel está conduzindo com o cliente.
        val p = profile
        val current = call
        val mine = current != null && ownsCall && !CallText.isFinal(current.status) && current.status != "unknown"
        pollJob?.cancel(); keepaliveJob?.cancel(); timerJob?.cancel(); engineStateJob?.cancel()
        closeEngine()
        stopService()
        if (!ended && mine && p != null && current != null && phase == CallPhase.IN_CALL) {
            val key = terminateKey ?: ApiClient.newIdempotencyKey()
            container.scope.launch(Dispatchers.IO) {
                runCatching { container.api.terminateCall(p, current.id, key, JsonObject(emptyMap())) }
            }
        }
        super.onCleared()
    }
}
