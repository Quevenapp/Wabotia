package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.Links
import br.com.queven.wabotia.core.SessionStore
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.demo.DemoMode
import androidx.compose.material.icons.filled.DeliveryDining
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.ui.platform.testTag
import br.com.queven.wabotia.courier.CourierTexts
import br.com.queven.wabotia.courier.ui.CourierActivity
import br.com.queven.wabotia.device.DeviceActivity
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Linha fina com "ou" no meio, separando duas formas de seguir. */
@Composable
private fun OrDivider() {
    val c = Wb.colors
    Row(Modifier.fillMaxWidth().clearAndSetSemantics { }, verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = c.hairline)
        Text("ou", style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = 12.dp))
        HorizontalDivider(Modifier.weight(1f), color = c.hairline)
    }
}

/** Primeira tela: a pessoa informa o endereço da SUA instalação Wabotia, ou abre a demonstração. */
@Composable
fun ServerScreen(container: AppContainer, onConfirmed: () -> Unit) {
    val c = Wb.colors
    val context = LocalContext.current
    var input by rememberSaveable { mutableStateOf(container.session.serverUrl?.removePrefix("https://") ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    /** Demonstração com dados fictícios em memória: sem servidor, sem senha e sem push. */
    fun enterDemo() {
        if (busy) return
        error = null
        DemoMode.signIn(container)
    }

    fun connect() {
        if (busy) return
        // Digitar "demo" como servidor também abre a demonstração (nenhuma chamada sai do aparelho).
        if (DemoMode.wantsDemo(input)) {
            enterDemo()
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
        // Entregador: o QR do pedido já traz o servidor da loja; nada de digitar endereço (várias lojas, um app).
        WbCard {
            Column(Modifier.padding(16.dp)) {
                Text("Vai fazer uma entrega?", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                Spacer(Modifier.height(2.dp))
                Text(CourierTexts.ENTRY_HELP, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                Spacer(Modifier.height(12.dp))
                SecondaryButton("Escanear pedido", onClick = { if (!busy) context.startActivity(CourierActivity.intent(context)) }, enabled = !busy, icon = Icons.Filled.QrCodeScanner, modifier = Modifier.testTag("server.courier"))
            }
        }
        Spacer(Modifier.height(16.dp))
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
        Spacer(Modifier.height(18.dp))
        OrDivider()
        Spacer(Modifier.height(18.dp))
        SecondaryButton("Conhecer o app (demonstração)", onClick = { enterDemo() }, enabled = !busy, icon = Icons.Outlined.PlayCircle)
        Spacer(Modifier.height(10.dp))
        AuthHelp("Ainda não tem um servidor Wabotia? Explore o app com dados fictícios, sem conta e sem enviar nada.")
        Spacer(Modifier.height(6.dp))
        TextButton(onClick = { if (!busy) context.startActivity(DeviceActivity.demoIntent(context)) }) {
            Icon(Icons.Filled.Tv, contentDescription = null, tint = c.brand, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Ver o modo painel ou totem (demonstração)", style = MaterialTheme.typography.bodyMedium, color = c.brand, fontWeight = FontWeight.SemiBold)
        }
        TextButton(onClick = { if (!busy) context.startActivity(CourierActivity.demoIntent(context)) }) {
            Icon(Icons.Filled.DeliveryDining, contentDescription = null, tint = c.brand, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Ver o modo entregador (demonstração)", style = MaterialTheme.typography.bodyMedium, color = c.brand, fontWeight = FontWeight.SemiBold)
        }

        TextButton(onClick = { Links.open(context, Links.PRIVACY_POLICY) }) {
            Text("Política de privacidade", style = MaterialTheme.typography.bodySmall, color = c.brand, fontWeight = FontWeight.SemiBold)
        }
    }
}
