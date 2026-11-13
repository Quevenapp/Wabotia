package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Profile
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException

/** Escolha do perfil de atendimento quando a pessoa tem acesso a mais de um (administradores veem todos). */
@Composable
fun ProfilePickerScreen(container: AppContainer) {
    val c = Wb.colors
    var profiles by remember { mutableStateOf<List<Profile>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) {
        error = null
        try {
            val list = container.api.profiles()
            if (list.size == 1) container.onProfileSelected(list.first().id) else profiles = list
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
        }
    }

    val userName = container.session.user?.name?.trim().orEmpty()
    AuthScaffold(
        title = "Escolha o perfil",
        subtitle = if (userName.isNotBlank()) "Olá, ${userName.substringBefore(' ')}. Em qual atendimento você vai trabalhar?" else "Em qual atendimento você vai trabalhar?",
        markSize = 64.dp,
        topSpace = 32.dp,
    ) {
        val list = profiles
        when {
            error != null -> InlineNotice(error ?: "", actionLabel = "Tentar de novo", onAction = { attempt++ })
            list == null -> WbCard { SkeletonList(rows = 3) }
            list.isEmpty() -> WbCard {
                Text(
                    "Sua conta não tem perfis de atendimento. Peça ao administrador para incluir você em um perfil.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                    modifier = Modifier.padding(16.dp),
                )
            }
            else -> Column {
                list.forEach { p ->
                    WbCard(Modifier.padding(bottom = 10.dp), onClick = { container.onProfileSelected(p.id) }) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(p.name, seed = p.id, size = 48.dp, ringColor = c.surface)
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f)) {
                                Text(p.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Spacer(Modifier.height(5.dp))
                                Pill(if (p.enabled == 1) "Atendimento ativo" else "Atendimento pausado", if (p.enabled == 1) c.ok else c.muted)
                            }
                            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = c.muted)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { container.onLoggedOut(keepServer = true) }) { Text("Entrar com outra conta", fontWeight = FontWeight.SemiBold) }
    }
}
