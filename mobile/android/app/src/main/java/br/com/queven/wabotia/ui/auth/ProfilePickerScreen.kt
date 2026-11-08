@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Profile
import br.com.queven.wabotia.core.net.ApiClient

/** Escolha do perfil de atendimento quando a pessoa tem acesso a mais de um (administradores veem todos). */
@Composable
fun ProfilePickerScreen(container: AppContainer) {
    var profiles by remember { mutableStateOf<List<Profile>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        try {
            val list = container.api.profiles()
            if (list.size == 1) container.onProfileSelected(list.first().id) else profiles = list
        } catch (e: Exception) {
            error = ApiClient.describe(e)
        }
    }
    Scaffold(topBar = { TopAppBar(title = { Text("Escolha o perfil") }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            when {
                error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                profiles == null -> Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) { CircularProgressIndicator() }
                profiles!!.isEmpty() -> Text("Sua conta não tem perfis de atendimento. Peça ao administrador para incluir você em um perfil.", modifier = Modifier.padding(16.dp))
                else -> LazyColumn {
                    items(profiles!!, key = { it.id }) { p ->
                        ListItem(
                            headlineContent = { Text(p.name) },
                            supportingContent = { Text(if (p.enabled == 1) "Atendimento ativo" else "Atendimento pausado") },
                            modifier = Modifier.clickable { container.onProfileSelected(p.id) },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
