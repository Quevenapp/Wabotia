package br.com.queven.wabotia.ui.auth

import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import br.com.queven.wabotia.core.push.PushRegistrar
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(container: AppContainer, onChangeServer: () -> Unit) {
    val server = container.session.serverUrl ?: ""
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun login() {
        if (email.isBlank() || password.isBlank()) { error = "Informe e-mail e senha."; return }
        busy = true; error = null
        scope.launch {
            try {
                val client = container.clientFor(server)
                val result = client.api.mobileLogin(
                    MobileLoginRequest(
                        email = email.trim().lowercase(),
                        password = password,
                        device = DeviceInfo(platform = "android", name = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(80), app_version = BuildConfig.VERSION_NAME),
                    ),
                )
                container.onLoggedIn(server, result.token, result.expires, result.user)
                PushRegistrar.registerIfNeeded(container, force = true)
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
            Spacer(Modifier.height(40.dp))
            Text("Entrar", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(4.dp))
            Text(server.removePrefix("https://"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onChangeServer, enabled = !busy) { Text("Trocar servidor") }
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = email, onValueChange = { email = it }, label = { Text("E-mail") }, singleLine = true, enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = password, onValueChange = { password = it }, label = { Text("Senha") }, singleLine = true, enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { showPassword = !showPassword }) {
                        Icon(if (showPassword) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, contentDescription = if (showPassword) "Ocultar senha" else "Mostrar senha")
                    }
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { login() }),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { login() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary) else Text("Entrar")
            }
            Spacer(Modifier.height(16.dp))
            Text(
                "Use a conta de atendente cadastrada em Pessoas no painel. A senha nunca é guardada no aparelho; apenas um token de sessão de 30 dias.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
