package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.SessionStore
import br.com.queven.wabotia.core.net.ApiClient
import kotlinx.coroutines.launch

/** Primeira tela: a pessoa informa o endereço da SUA instalação Wabotia. */
@Composable
fun ServerScreen(container: AppContainer, onConfirmed: () -> Unit) {
    var input by rememberSaveable { mutableStateOf(container.session.serverUrl?.removePrefix("https://") ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun connect() {
        val url = SessionStore.normalizeServer(input)
        if (url == null) {
            error = "Digite um endereço válido, por exemplo wabotia.suaempresa.com.br"
            return
        }
        busy = true; error = null; info = null
        scope.launch {
            try {
                val client = container.clientFor(url)
                val health = client.api.health()
                if (health.service != "wabotia") throw IllegalStateException("Este endereço não é um servidor Wabotia.")
                val status = client.api.authStatus()
                if (!status.initialized) throw IllegalStateException("Este servidor ainda não tem administrador. Conclua a instalação pelo navegador em $url/app.")
                container.session.serverUrl = url
                container.refreshAuthState()
                info = "Servidor Wabotia ${health.version} encontrado."
                onConfirmed()
            } catch (e: Exception) {
                error = ApiClient.describe(e)
            } finally {
                busy = false
            }
        }
    }

    Scaffold { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(48.dp))
            Icon(Icons.Filled.Dns, contentDescription = null, Modifier.size(64.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(16.dp))
            Text("Wabotia", style = MaterialTheme.typography.headlineMedium)
            Text("Atendimento WhatsApp com IA e equipe humana", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(32.dp))
            Text("Endereço do seu servidor", style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth())
            Text(
                "Cada empresa tem a própria instalação Wabotia. Informe o endereço que você usa para abrir o painel.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Servidor") },
                placeholder = { Text("wabotia.suaempresa.com.br") },
                prefix = { Text("https://") },
                isError = error != null,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { connect() }),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) }
            info?.let { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { connect() }, enabled = !busy && input.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text("Conectar")
            }
            Spacer(Modifier.height(24.dp))
            Text(
                "Exemplos: wabotia.queven.com.br, wabotia.fagoo.com.br. Use sempre HTTPS em produção.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
