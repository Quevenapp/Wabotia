package br.com.queven.wabotia.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DoNotDisturbOn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.PresenceRequest
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Presença do atendente e da equipe, compartilhada pela pílula da aba Conversas, pelo cartão da aba Equipe e por
 * Ajustes. O estado vem de `GET /presence` (entrada com `actor == eu`) e é relido ao voltar ao primeiro plano;
 * `PUT /presence {present}` mantém a mesma Idempotency-Key ao repetir o mesmo pedido após falha de rede.
 */
class PresenceViewModel(private val container: AppContainer) : ViewModel() {
    /** null enquanto ainda não se sabe (primeira carga). */
    var present by mutableStateOf<Boolean?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var team by mutableStateOf<List<TeamContact>>(emptyList())
        private set
    /** Retorno transitório ("Você está online"); a tela mostra em snackbar e chama [consumeMessage]. */
    var message by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var key: String? = null
    private var keyTarget: Boolean? = null

    val meId: String? get() = container.session.user?.id
    val peopleOnline: Int get() = team.count { !it.isBot && it.online }
    val peopleTotal: Int get() = team.count { !it.isBot }
    val botsOnline: Int get() = team.count { it.isBot && it.online }

    /** "4 pessoas online · 2 bots ativos". */
    val summary: String
        get() {
            val people = peopleOnline
            val bots = botsOnline
            val p = if (people == 1) "1 pessoa online" else "$people pessoas online"
            val b = if (bots == 1) "1 bot ativo" else "$bots bots ativos"
            return "$p · $b"
        }

    fun consumeMessage() { message = null }

    fun refresh() {
        val profile = container.session.profileId ?: return
        viewModelScope.launch {
            try {
                val list = container.api.presence(profile)
                if (!busy) present = list.firstOrNull { it.actor == meId }?.present == 1
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            }
            try {
                team = container.api.team(profile).data
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // a lista da equipe é complementar; a presença própria já foi lida acima
            }
        }
    }

    fun set(value: Boolean) {
        val profile = container.session.profileId ?: return
        if (busy || present == value) return
        val requestKey = key?.takeIf { keyTarget == value } ?: ApiClient.newIdempotencyKey().also {
            key = it
            keyTarget = value
        }
        val previous = present
        present = value
        busy = true
        viewModelScope.launch {
            try {
                container.api.setPresence(profile, requestKey, PresenceRequest(present = value))
                key = null
                keyTarget = null
                team = team.map { if (it.id == meId) it.copy(online = value) else it }
                message = if (value) "Você está online" else "Você está offline"
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiException && (e.isIdempotencyConflict || e.isDefinitiveWriteRejection)) {
                    key = null
                    keyTarget = null
                }
                present = previous
                message = container.handleError(e)
            } finally {
                busy = false
            }
        }
    }
}

/** Instância compartilhada pelas abas (mesmo dono de ViewModel); relê a presença sempre que a tela volta ao primeiro plano. */
@Composable
fun rememberPresence(container: AppContainer): PresenceViewModel {
    val profile = container.session.profileId ?: ""
    val vm: PresenceViewModel = viewModel(key = "presence:$profile") { PresenceViewModel(container) }
    LifecycleResumeEffect(vm) {
        vm.refresh()
        onPauseOrDispose { }
    }
    return vm
}

/** Pílula de presença da barra superior: `● Online` (fundo `ok` a 15%) ou `○ Offline` (cinza). */
@Composable
fun PresencePill(present: Boolean?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Wb.colors
    val online = present == true
    val color = if (online) c.ok else c.muted
    Row(
        modifier
            .height(32.dp)
            .clip(CircleShape)
            .background(if (online) c.soft(c.ok, 0.15f) else c.field)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp)
            .semantics { contentDescription = if (online) "Você está online. Toque para mudar." else "Você está offline. Toque para mudar." },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (online) {
            Box(Modifier.size(8.dp).background(color, CircleShape))
        } else {
            Box(Modifier.size(9.dp).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
                Box(Modifier.size(5.dp).background(c.field, CircleShape))
            }
        }
        Spacer(Modifier.width(6.dp))
        Text(
            when (present) {
                true -> "Online"
                false -> "Offline"
                null -> "…"
            },
            color = if (online) c.ok else c.textSecondary,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

/** Folha de presença: dois botões grandes, o efeito de ficar offline e quantas pessoas da equipe estão online. */
@Composable
fun PresenceSheet(vm: PresenceViewModel, onDismiss: () -> Unit) {
    val c = Wb.colors
    LaunchedEffect(Unit) { vm.refresh() }
    WbBottomSheet(onDismiss = onDismiss, title = "Sua presença") {
        Column(Modifier.padding(horizontal = 20.dp)) {
            val online = vm.present == true
            val offline = vm.present == false
            // Dois botões grandes; o estado atual fica preenchido e o outro em contorno.
            if (online) {
                PrimaryButton("Ficar online", onClick = onDismiss, icon = Icons.Filled.CheckCircle, color = c.ok, contentColor = c.onAccent)
            } else {
                SecondaryButton("Ficar online", onClick = { vm.set(true); onDismiss() }, icon = Icons.Filled.CheckCircle, color = c.ok, loading = vm.busy)
            }
            Spacer(Modifier.height(10.dp))
            if (offline) {
                PrimaryButton("Ficar offline", onClick = onDismiss, icon = Icons.Filled.DoNotDisturbOn, color = c.muted, contentColor = c.onAccent)
            } else {
                SecondaryButton("Ficar offline", onClick = { vm.set(false); onDismiss() }, icon = Icons.Filled.DoNotDisturbOn, color = c.textSecondary, loading = vm.busy)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                when (vm.present) {
                    true -> "Você está online e recebe novos atendimentos."
                    false -> "Você está offline."
                    null -> "Consultando sua presença…"
                },
                style = MaterialTheme.typography.labelMedium,
                color = if (online) c.ok else c.textSecondary,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "Offline: novos atendimentos não são encaminhados a você.",
                style = MaterialTheme.typography.bodyMedium,
                color = c.textSecondary,
            )
            if (vm.team.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PresenceDot(online = vm.peopleOnline > 0)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "${vm.peopleOnline} de ${vm.peopleTotal} ${if (vm.peopleTotal == 1) "pessoa" else "pessoas"} da equipe online agora",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
