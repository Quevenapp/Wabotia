package br.com.queven.wabotia.ui.team

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Gavel
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Approval
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException

/** Um pedido de aprovação aberto pelo push (`data.type: "approval"`), com as mesmas ações do cartão na conversa interna. */
class ApprovalViewModel(private val container: AppContainer, private val profile: String, private val id: String) : ViewModel() {
    var approval by mutableStateOf<Approval?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(true); private set
    var onOpenConversation: (String) -> Unit = {}

    val actions = BotActionsController(container, profile, viewModelScope, reload = { load() }, openConversation = { onOpenConversation(it) })

    suspend fun load() {
        try {
            approval = container.api.approval(profile, id)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
        } finally {
            loading = false
        }
    }
}

@Composable
fun ApprovalScreen(container: AppContainer, approvalId: String, onBack: () -> Unit, openConversation: (String) -> Unit) {
    val profile = container.session.profileId ?: return
    val vm: ApprovalViewModel = viewModel(key = "approval:$profile:$approvalId") { ApprovalViewModel(container, profile, approvalId) }
    vm.onOpenConversation = openConversation
    val now by rememberNow()
    val c = Wb.colors
    LaunchedEffect(vm) { vm.load() }
    if (vm.actions.mfaPending) MfaDialog(vm.actions.mfaError, onSubmit = vm.actions::submitMfa, onDismiss = vm.actions::dismissMfa)
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        DetailTopBar("Pedido de aprovação", onBack = onBack)
        val a = vm.approval
        when {
            a == null && vm.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            a == null -> EmptyState(Icons.Filled.Gavel, "Pedido indisponível", subtitle = vm.error ?: "Ele pode ter sido decidido por outra pessoa.")
            else -> Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                vm.actions.notice?.let { InlineNotice(it, Modifier.padding(bottom = 10.dp), color = c.warn, onDismiss = vm.actions::consumeNotice) }
                ApprovalCard(
                    a, now, busy = vm.actions.busy == a.id,
                    onApprove = { vm.actions.decide(a, "approve", value = it) },
                    onDecline = { vm.actions.decide(a, "decline", reason = it) },
                    onHandoff = { vm.actions.decide(a, "handoff") },
                )
            }
        }
    }
}
