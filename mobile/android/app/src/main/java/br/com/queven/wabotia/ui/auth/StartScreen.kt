package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Login
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import androidx.compose.material.icons.filled.QrCodeScanner
import br.com.queven.wabotia.courier.CourierTexts
import br.com.queven.wabotia.courier.ui.CourierActivity
import br.com.queven.wabotia.device.DeviceActivity
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.theme.Wb

/**
 * Depois do endereço do servidor: entrar com a conta de pessoa (o fluxo de sempre) ou fazer deste aparelho um totem ou
 * painel de chamadas, fora do login, pelo pareamento com código.
 */
@Composable
fun StartScreen(container: AppContainer, onLogin: () -> Unit, onChangeServer: () -> Unit) {
    val c = Wb.colors
    val context = LocalContext.current
    val server = container.session.serverUrl
    AuthScaffold(title = "Wabotia", subtitle = server?.removePrefix("https://") ?: "Atendimento WhatsApp com IA e equipe humana") {
        PrimaryButton("Entrar", onClick = onLogin, icon = Icons.AutoMirrored.Filled.Login, modifier = Modifier.testTag("start.login"))
        Spacer(Modifier.height(10.dp))
        AuthHelp("Para quem atende: conversas, protocolos, equipe e o guichê da fila de senhas.")
        Spacer(Modifier.height(24.dp))
        SecondaryButton(
            "Usar este aparelho como painel ou totem",
            onClick = { context.startActivity(DeviceActivity.intent(context, server)) },
            icon = Icons.Filled.Tv,
            modifier = Modifier.testTag("start.device"),
        )
        Spacer(Modifier.height(10.dp))
        AuthHelp("Para um tablet ou TV na recepção: retirar senha e imprimir o cupom, mostrar as chamadas com voz, ou os dois. Sem conta de pessoa: um administrador aprova o aparelho por um código.")
        Spacer(Modifier.height(24.dp))
        SecondaryButton(
            "Escanear pedido",
            onClick = { context.startActivity(CourierActivity.intent(context)) },
            icon = Icons.Filled.QrCodeScanner,
            modifier = Modifier.testTag("start.courier"),
        )
        Spacer(Modifier.height(10.dp))
        AuthHelp(CourierTexts.ENTRY_HELP)
        Spacer(Modifier.height(18.dp))
        TextButton(onClick = onChangeServer) {
            Text("Trocar servidor", style = MaterialTheme.typography.bodyMedium, color = c.brand, fontWeight = FontWeight.SemiBold)
        }
    }
}
