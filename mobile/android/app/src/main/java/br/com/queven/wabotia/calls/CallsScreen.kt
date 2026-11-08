package br.com.queven.wabotia.calls

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallMissed
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Call
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.core.push.Notifications
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Aba Ligações: histórico (GET /calls) com estado em português e duração; ligações tocando no topo
 * com Atender (abre a tela da ligação) e Recusar (claim + reject). Atualiza a cada 5 s em primeiro plano.
 */
@Composable
fun CallsScreen(container: AppContainer, modifier: Modifier = Modifier, openCall: (conversationId: String, callId: String?) -> Unit, openConversation: (String) -> Unit) {
    val vm: CallsViewModel = viewModel { CallsViewModel(container) }
    val lifecycleOwner = LocalLifecycleOwner.current

    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (isActive) {
                vm.refresh()
                delay(5_000)
            }
        }
    }

    val meId = container.session.user?.id
    val ringing = vm.calls.filter { CallText.isRingingFor(it, meId) }
    val history = vm.calls.filter { !CallText.isRingingFor(it, meId) }

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Ligações", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            IconButton(onClick = { vm.refresh(manual = true) }, enabled = !vm.loading) {
                Icon(Icons.Filled.Refresh, contentDescription = "Atualizar")
            }
        }
        if (vm.loading && vm.calls.isEmpty()) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        vm.error?.let { message ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { vm.refresh(manual = true) }) { Text("Tentar novamente") }
            }
        }

        if (!vm.loading && vm.calls.isEmpty() && vm.error == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Call, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
                    Spacer(Modifier.height(8.dp))
                    Text("Nenhuma ligação ainda.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        "Ligações recebidas pelo WhatsApp aparecem aqui.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            return@Column
        }

        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
            items(ringing, key = { "ringing-${it.id}" }) { call ->
                RingingCallCard(
                    call = call,
                    name = vm.conversationNames[call.conversation_id],
                    busy = vm.busyCallId == call.id,
                    onAnswer = { openCall(call.conversation_id, call.id) },
                    onReject = { vm.reject(call) },
                    onOpenConversation = { openConversation(call.conversation_id) },
                )
            }
            if (ringing.isNotEmpty() && history.isNotEmpty()) {
                item("history-header") {
                    Text(
                        "Histórico",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
            items(history, key = { it.id }) { call ->
                CallHistoryRow(
                    call = call,
                    meId = meId,
                    name = vm.conversationNames[call.conversation_id],
                    onClick = {
                        if (!CallText.isFinal(call.status) && call.actor == meId) openCall(call.conversation_id, call.id)
                        else openConversation(call.conversation_id)
                    },
                )
                HorizontalDivider(Modifier.padding(start = 72.dp))
            }
        }
    }
}

@Composable
private fun RingingCallCard(call: Call, name: String?, busy: Boolean, onAnswer: () -> Unit, onReject: () -> Unit, onOpenConversation: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Filled.CallReceived, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text("Recebendo ligação", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    Text(
                        name ?: "WhatsApp · ${CallText.date(call.created)}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onAnswer, enabled = !busy, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E9E5A), contentColor = Color.White),
                ) {
                    Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Atender")
                }
                OutlinedButton(
                    onClick = onReject, enabled = !busy, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Icon(Icons.Filled.CallEnd, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Recusar")
                }
            }
            TextButton(onClick = onOpenConversation, enabled = !busy) { Text("Abrir conversa") }
        }
    }
}

@Composable
private fun CallHistoryRow(call: Call, meId: String?, name: String?, onClick: () -> Unit) {
    val final = CallText.isFinal(call.status)
    val missed = call.status == "missed" || call.status == "rejected" || call.status == "failed"
    val icon: ImageVector = when {
        missed && call.direction == "inbound" -> Icons.AutoMirrored.Filled.CallMissed
        call.direction == "inbound" -> Icons.AutoMirrored.Filled.CallReceived
        else -> Icons.AutoMirrored.Filled.CallMade
    }
    val tint = when {
        missed -> MaterialTheme.colorScheme.error
        !final -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = CallText.direction(call), tint = tint)
        }
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(
                name ?: CallText.direction(call),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (!final) FontWeight.SemiBold else FontWeight.Normal,
            )
            val details = buildList {
                if (name != null) add(CallText.direction(call))
                add(CallText.status(call.status))
                call.duration?.takeIf { it > 0 }?.let { add(CallText.duration(it)) }
                if (!final && call.actor != null && call.actor != meId) add("com outro atendente")
            }
            Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            call.error?.takeIf { it.isNotBlank() && call.status == "unknown" }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(CallText.date(call.created), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

class CallsViewModel(private val container: AppContainer) : ViewModel() {
    var calls by mutableStateOf<List<Call>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var busyCallId by mutableStateOf<String?>(null)
        private set
    /** Nomes das conversas das ligações (carregados sob demanda para a lista). */
    var conversationNames by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    private var refreshing = false
    private val namesRequested = HashSet<String>()

    fun refresh(manual: Boolean = false) {
        val profile = container.session.profileId ?: return
        if (refreshing) return
        refreshing = true
        if (manual || calls.isEmpty()) loading = true
        viewModelScope.launch {
            try {
                val page = container.api.calls(profile, limit = 30)
                calls = page.data
                error = null
                loadNames(profile, page.data)
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                loading = false
                refreshing = false
            }
        }
    }

    /** Recusar = assumir (claim) e recusar (reject), cada um com a própria chave de idempotência. */
    fun reject(call: Call) {
        val profile = container.session.profileId ?: return
        if (busyCallId != null) return
        busyCallId = call.id
        viewModelScope.launch {
            try {
                runCatching { container.api.claimCall(profile, call.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap())) }
                    .onFailure { if (it is ApiException && it.isUnauthorized) throw it }
                container.api.rejectCall(profile, call.id, ApiClient.newIdempotencyKey(), JsonObject(emptyMap()))
                Notifications.cancelIncomingCall(container.appContext, call.id)
                error = null
            } catch (e: Exception) {
                error = describe(e)
            } finally {
                busyCallId = null
                refreshing = false
                refresh()
            }
        }
    }

    private fun loadNames(profile: String, list: List<Call>) {
        val pending = list.map { it.conversation_id }.filter { it.isNotBlank() && it !in namesRequested }.distinct().take(20)
        if (pending.isEmpty()) return
        namesRequested.addAll(pending)
        viewModelScope.launch {
            for (id in pending) {
                val name = runCatching { container.api.conversation(profile, id).conversation.displayName }.getOrNull()
                if (name != null) conversationNames = conversationNames + (id to name)
                else namesRequested.remove(id)
            }
        }
    }

    private fun describe(e: Throwable): String {
        if (e is ApiException && e.isUnauthorized) container.onLoggedOut(keepServer = true)
        return ApiClient.describe(e)
    }
}
