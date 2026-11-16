package br.com.queven.wabotia.ui.auth

import android.os.Build
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.DeviceInfo
import br.com.queven.wabotia.core.model.MobileLoginRequest
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.platform.testTag
import br.com.queven.wabotia.core.push.PushRegistrar
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Textos do login, sem Compose, para testar. */
object LoginTexts {
    /** Os erros do login em duas etapas que pedem texto próprio; `null` usa a mensagem do servidor. */
    fun error(status: Int?, code: String?): String? = when {
        code == "invalid_code" -> "Código errado ou já usado. Confira o relógio do celular e tente o próximo código."
        status == 429 && code == "mfa_locked" -> "Muitos códigos errados. Espere 15 minutos e tente de novo."
        status == 403 && code == "outside_schedule" -> "Fora do seu horário de acesso. Fale com o administrador."
        else -> null
    }
}

/**
 * Login com e-mail e senha de atendente no servidor escolhido. Com segundo fator cadastrado, o servidor responde
 * `401 mfa_required` e a tela pede o código do autenticador (ou um código de recuperação) e repete o pedido.
 */
@Composable
fun LoginScreen(container: AppContainer, onChangeServer: () -> Unit) {
    val c = Wb.colors
    val server = container.session.serverUrl ?: ""
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Segunda etapa: a pessoa tem segundo fator e o servidor pediu o código (`401 mfa_required`).
    var needCode by rememberSaveable { mutableStateOf(false) }
    var code by rememberSaveable { mutableStateOf("") }
    var recovery by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun login() {
        if (busy) return
        if (email.isBlank() || password.isBlank()) { error = "Informe e-mail e senha."; return }
        if (needCode && code.isBlank()) { error = if (recovery) "Digite um código de recuperação." else "Digite o código de 6 dígitos do autenticador."; return }
        busy = true; error = null
        scope.launch {
            try {
                val client = container.clientFor(server)
                val result = client.api.mobileLogin(
                    MobileLoginRequest(
                        email = email.trim().lowercase(),
                        password = password,
                        device = DeviceInfo(platform = "android", name = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(80), app_version = BuildConfig.VERSION_NAME),
                        totp = code.trim().takeIf { needCode && !recovery },
                        recovery_code = code.trim().takeIf { needCode && recovery },
                    ),
                )
                container.onLoggedIn(server, result.token, result.expires, result.user)
                // `next: enroll`: a instalação exige o segundo fator e a pessoa ainda não cadastrou; a tela global leva ao cadastro.
                container.mfa.update(result.aal, result.mfa)
                PushRegistrar.registerIfNeeded(container, force = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val api = e as? ApiException
                if (api?.status == 401 && api.code == "mfa_required") {
                    // Senha certa; falta o código. Nenhuma sessão foi criada.
                    needCode = true
                    error = null
                } else {
                    error = LoginTexts.error(api?.status, api?.code) ?: ApiClient.describe(e)
                    if (api?.code == "invalid_code") code = ""
                }
            } finally {
                busy = false
            }
        }
    }

    AuthScaffold(title = "Entrar", subtitle = "Use a sua conta de atendente", topSpace = 36.dp) {
        Pill(server.removePrefix("https://").ifBlank { "Servidor não configurado" }, c.brand, icon = Icons.Filled.Dns)
        Spacer(Modifier.height(16.dp))
        WbCard {
            Column(Modifier.padding(16.dp)) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it; error = null },
                    label = { Text("E-mail") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                    shape = AuthFieldShape,
                    colors = authFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; error = null },
                    label = { Text("Senha") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                    shape = AuthFieldShape,
                    colors = authFieldColors(),
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(
                                if (showPassword) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                                contentDescription = if (showPassword) "Ocultar senha" else "Mostrar senha",
                                tint = c.textSecondary,
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { login() }),
                )
            }
        }
        if (needCode) {
            Spacer(Modifier.height(12.dp))
            WbCard {
                Column(Modifier.padding(16.dp)) {
                    Text(if (recovery) "Código de recuperação" else "Código do autenticador", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                    Text(
                        if (recovery) "Um dos códigos que você guardou ao cadastrar o segundo fator. Cada um vale uma vez." else "Abra o aplicativo autenticador e digite os 6 dígitos do Wabotia.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = if (recovery) it.take(40) else it.filter(Char::isDigit).take(6); error = null },
                        label = { Text("Código") },
                        singleLine = true,
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().testTag("login.code"),
                        shape = AuthFieldShape,
                        colors = authFieldColors(),
                        keyboardOptions = KeyboardOptions(keyboardType = if (recovery) KeyboardType.Ascii else KeyboardType.NumberPassword, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                        keyboardActions = KeyboardActions(onDone = { login() }),
                    )
                    TextButton(onClick = { recovery = !recovery; code = ""; error = null }, enabled = !busy) {
                        Text(if (recovery) "Usar o código do autenticador" else "Usar um código de recuperação")
                    }
                }
            }
        }
        error?.let {
            Spacer(Modifier.height(12.dp))
            InlineNotice(it)
        }
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Entrar", onClick = { login() }, loading = busy)
        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onChangeServer, enabled = !busy) { Text("Trocar servidor", fontWeight = FontWeight.SemiBold) }
        Spacer(Modifier.height(8.dp))
        AuthHelp("Conta cadastrada em Pessoas no painel. A senha nunca fica no aparelho; só um token de sessão de 30 dias.")
    }
}
