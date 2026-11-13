package br.com.queven.wabotia.calls

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Call
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Aba Ligações: somente o histórico (GET /calls), no estilo do WhatsApp (avatar, nome, seta de entrada/saída colorida,
 * data e duração). O app não faz nem atende ligações; tocar em uma linha abre a conversa. Atualiza a cada 30 s em
 * primeiro plano.
 */
@Composable
fun CallsScreen(container: AppContainer, modifier: Modifier = Modifier, openConversation: (String) -> Unit) {
    val vm: CallsViewModel = viewModel { CallsViewModel(container) }
    val lifecycleOwner = LocalLifecycleOwner.current

    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (isActive) {
                vm.refresh()
                delay(30_000)
            }
        }
    }

    val c = Wb.colors
    val meId = container.session.user?.id

    Column(modifier.fillMaxSize().background(c.background)) {
        TabTopBar("Ligações") {
            IconButton(onClick = { vm.refresh(manual = true) }, enabled = !vm.loading) {
                Icon(Icons.Filled.Refresh, contentDescription = "Atualizar ligações", tint = c.textPrimary)
            }
        }
        ConnectionStrip(container)
        vm.error?.let { message ->
            InlineNotice(
                message,
                Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                actionLabel = "Tentar de novo",
                onAction = { vm.refresh(manual = true) },
            )
        }

        when {
            vm.loading && vm.calls.isEmpty() -> SkeletonList(Modifier.fillMaxSize())
            vm.calls.isEmpty() && vm.error == null -> EmptyState(Icons.Filled.Call, "Nenhuma ligação ainda", subtitle = "Ligações recebidas pelo WhatsApp aparecem aqui.")
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                items(vm.calls, key = { it.id }) { call ->
                    CallHistoryRow(
                        call = call,
                        meId = meId,
                        name = vm.conversationNames[call.conversation_id],
                        onClick = call.conversation_id.takeIf { it.isNotBlank() }?.let { id -> { openConversation(id) } },
                    )
                    RowDivider(startIndent = 78.dp)
                }
            }
        }
    }
}

@Composable
private fun CallHistoryRow(call: Call, meId: String?, name: String?, onClick: (() -> Unit)?) {
    val c = Wb.colors
    val final = CallText.isFinal(call.status)
    val missed = call.status == "missed" || call.status == "rejected" || call.status == "failed"
    val inbound = call.direction == "inbound"
    val icon: ImageVector = when {
        missed && inbound -> Icons.AutoMirrored.Filled.CallMissed
        inbound -> Icons.AutoMirrored.Filled.CallReceived
        else -> Icons.AutoMirrored.Filled.CallMade
    }
    val tint = when {
        missed -> c.danger
        !final -> c.brand
        else -> c.ok
    }
    val displayName = name ?: "WhatsApp"
    val details = buildList {
        // Encerrada normalmente: basta a direção; nos demais casos o estado diz mais ("Não atendida", "Em ligação").
        add(if (call.status == "completed") CallText.direction(call) else CallText.status(call.status))
        CallText.date(call.created).takeIf { it.isNotBlank() }?.let { add(it) }
        call.duration?.takeIf { it > 0 }?.let { add(CallText.duration(it)) }
        if (!final && call.actor != null && call.actor != meId) add("com outro atendente")
    }.joinToString(" · ")

    Row(
        Modifier.fillMaxWidth().clickable(enabled = onClick != null, onClick = { onClick?.invoke() }).heightIn(min = 72.dp).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(displayName, seed = call.conversation_id.ifBlank { call.id }, size = 48.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                displayName,
                fontSize = 16.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (missed) c.danger else c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = if (missed && inbound) "Perdida" else CallText.direction(call), tint = tint, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(5.dp))
                Text(details, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            call.error?.takeIf { it.isNotBlank() && call.status == "unknown" }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

class CallsViewModel(private val container: AppContainer) : ViewModel() {
    var calls by mutableStateOf<List<Call>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
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
