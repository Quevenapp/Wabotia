package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.DebugHooks
import br.com.queven.wabotia.core.Links
import br.com.queven.wabotia.core.SessionStore
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Primeira tela: a pessoa informa o endereço da SUA instalação Wabotia. */
@Composable
fun ServerScreen(container: AppContainer, onConfirmed: () -> Unit) {
    val c = Wb.colors
    val context = LocalContext.current
    var input by rememberSaveable { mutableStateOf(container.session.serverUrl?.removePrefix("https://") ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun connect() {
        if (busy) return
        // Build de depuração: "demo" entra direto na demonstração em memória (nenhuma chamada sai do aparelho).
        if (DebugHooks.isDemoAlias(input)) {
            DebugHooks.signInDemo(container)
            return
        }
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
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = ApiClient.describe(e)
            } finally {
                busy = false
            }
        }
    }

    AuthScaffold(title = "Wabotia", subtitle = "Atendimento WhatsApp com IA e equipe humana") {
        WbCard {
            Column(Modifier.padding(16.dp)) {
                Text("Endereço do seu servidor", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                Spacer(Modifier.height(2.dp))
                Text(
                    "Cada empresa tem a própria instalação. Use o endereço em que você abre o painel.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
                Spacer(Modifier.height(14.dp))
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it; error = null },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("Servidor") },
                    placeholder = { Text("wabotia.suaempresa.com.br", maxLines = 1) },
                    prefix = { Text("https://", color = c.textSecondary) },
                    isError = error != null,
                    enabled = !busy,
                    shape = AuthFieldShape,
                    colors = authFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { connect() }),
                )
            }
        }
        error?.let {
            Spacer(Modifier.height(12.dp))
            InlineNotice(it)
        }
        info?.let {
            Spacer(Modifier.height(12.dp))
            InlineNotice(it, color = c.ok)
        }
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Conectar", onClick = { connect() }, loading = busy, enabled = input.isNotBlank())
        Spacer(Modifier.height(20.dp))
        AuthHelp("Exemplos: wabotia.queven.com.br, wabotia.fagoo.com.br. Use sempre HTTPS em produção.")
        if (BuildConfig.DEBUG) {
            Spacer(Modifier.height(10.dp))
            AuthHelp("Build de depuração: digite demo para ver uma demonstração.")
        }
        Spacer(Modifier.height(6.dp))
        TextButton(onClick = { Links.open(context, Links.PRIVACY_POLICY) }) {
            Text("Política de privacidade", style = MaterialTheme.typography.bodySmall, color = c.brand, fontWeight = FontWeight.SemiBold)
        }
    }
}
