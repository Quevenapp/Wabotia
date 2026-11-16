package br.com.queven.wabotia.ui.settings

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.MfaPrompt
import br.com.queven.wabotia.core.model.AccountMfa
import br.com.queven.wabotia.core.model.MfaEnrollment
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.device.ui.QrMatrixImage
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SecureScreenEffect
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.formatDayLabel
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Textos do segundo fator, sem Compose, para testar. */
object MfaTexts {
    /** O segredo em grupos de 4 para digitar no autenticador sem o QR. */
    fun groupedSecret(secret: String) = secret.replace(" ", "").chunked(4).joinToString(" ")

    fun policy(policy: String?) = when (policy) {
        "all" -> "Exigida para todas as pessoas desta instalação."
        "financial" -> "Exigida para operações financeiras (cobranças, mensalidades, suporte pago)."
        else -> "Opcional nesta instalação, e recomendada."
    }

    fun challengeError(e: Throwable): String = when ((e as? ApiException)?.code) {
        "invalid_code" -> "Código errado ou já usado. Tente o próximo código do autenticador."
        "mfa_locked" -> "Muitos códigos errados. Espere 15 minutos."
        "mfa_not_enrolled" -> "Você ainda não cadastrou o segundo fator."
        else -> ApiClient.describe(e)
    }
}

/**
 * A tela global do segundo fator, por cima de qualquer tela: "Confirme que é você" (o código sobe a sessão por 7 dias e a
 * pessoa repete a ação) ou, sem fator cadastrado, o convite ao cadastro. Nunca desloga.
 */
@Composable
fun MfaGate(container: AppContainer, openEnroll: () -> Unit) {
    val prompt by container.mfa.prompt.collectAsState()
    val scope = rememberCoroutineScope()
    when (prompt) {
        MfaPrompt.CHALLENGE -> {
            var code by rememberSaveable { mutableStateOf("") }
            var busy by remember { mutableStateOf(false) }
            var error by remember { mutableStateOf<String?>(null) }
            AlertDialog(
                onDismissRequest = { if (!busy) container.mfa.dismiss() },
                icon = { Icon(Icons.Filled.Lock, contentDescription = null, tint = Wb.colors.brand) },
                title = { Text("Confirme que é você") },
                text = {
                    Column {
                        Text(
                            "Esta ação pede o segundo fator. Digite o código de 6 dígitos do aplicativo autenticador, ou um código de recuperação. A confirmação vale 7 dias neste aparelho.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = code,
                            onValueChange = { code = it.take(40); error = null },
                            singleLine = true,
                            label = { Text("Código") },
                            isError = error != null,
                            supportingText = error?.let { { Text(it) } },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                            modifier = Modifier.testTag("mfa.code"),
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = code.isNotBlank() && !busy,
                        onClick = {
                            busy = true
                            scope.launch {
                                try {
                                    container.mfa.challenge(code)
                                    code = ""
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    error = MfaTexts.challengeError(e)
                                } finally {
                                    busy = false
                                }
                            }
                        },
                    ) { if (busy) CircularProgressIndicator(Modifier.height(18.dp)) else Text("Confirmar", fontWeight = FontWeight.SemiBold) }
                },
                dismissButton = { TextButton(onClick = { container.mfa.dismiss() }, enabled = !busy) { Text("Agora não") } },
            )
        }
        MfaPrompt.ENROLL -> AlertDialog(
            onDismissRequest = { container.mfa.dismiss() },
            icon = { Icon(Icons.Filled.VerifiedUser, contentDescription = null, tint = Wb.colors.brand) },
            title = { Text("Cadastre o segundo fator") },
            text = {
                Text(
                    "Esta instalação pede o segundo fator para continuar. Cadastre um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou outro): leva um minuto.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = { TextButton(onClick = { container.mfa.dismiss(); openEnroll() }) { Text("Cadastrar agora", fontWeight = FontWeight.SemiBold) } },
            dismissButton = { TextButton(onClick = { container.mfa.dismiss() }) { Text("Depois") } },
        )
        null -> Unit
    }
}

/**
 * Ajustes → Verificação em duas etapas: a situação, o cadastro do aplicativo autenticador (QR ou segredo, código,
 * códigos de recuperação mostrados uma vez), códigos novos e remover o fator. O segredo e os códigos não aparecem em
 * capturas de tela.
 */
@Composable
fun AccountMfaScreen(container: AppContainer, onBack: () -> Unit) {
    SecureScreenEffect(container)
    val c = Wb.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<AccountMfa?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var enrollment by remember { mutableStateOf<MfaEnrollment?>(null) }
    var code by remember { mutableStateOf("") }
    var codes by remember { mutableStateOf<List<String>>(emptyList()) }
    var confirmRemove by remember { mutableStateOf(false) }
    val confirmed by container.mfa.confirmed.collectAsState()

    suspend fun load() {
        try {
            status = container.api.accountMfa()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = MfaTexts.challengeError(e)
        } finally {
            loading = false
        }
    }

    fun act(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if ((e as? ApiException)?.isMfaRequired == true) container.mfa.required() else error = MfaTexts.challengeError(e)
            } finally {
                busy = false
            }
        }
    }

    // Relê depois de uma confirmação ("Confirme que é você" pode ter aberto por cima desta tela).
    LaunchedEffect(confirmed) { load() }

    Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        DetailTopBar("Verificação em duas etapas", onBack = onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            error?.let { InlineNotice(it, onDismiss = { error = null }) }
            val s = status
            when {
                loading && s == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally), color = c.brand)
                codes.isNotEmpty() -> RecoveryCodes(codes, onCopy = { copy(context, codes.joinToString("\n")) }, onDone = { codes = emptyList(); scope.launch { load() } })
                enrollment != null -> {
                    val e = enrollment!!
                    WbCard {
                        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("1. Leia o QR no aplicativo autenticador", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                            Spacer(Modifier.height(10.dp))
                            QrMatrixImage(e.otpauth_url, "QR do segundo fator", size = 200.dp)
                            Spacer(Modifier.height(8.dp))
                            Text("Ou digite este código no aplicativo:", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                            Text(MfaTexts.groupedSecret(e.secret), fontFamily = FontFamily.Monospace, color = c.textPrimary, modifier = Modifier.testTag("mfa.secret"))
                            TextButton(onClick = { openOtpauth(context, e.otpauth_url) }) { Text("Abrir no autenticador deste celular") }
                        }
                    }
                    WbCard {
                        Column(Modifier.padding(16.dp)) {
                            Text("2. Digite o código que o aplicativo mostra", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = code,
                                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                                singleLine = true,
                                label = { Text("Código de 6 dígitos") },
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                                modifier = Modifier.fillMaxWidth().testTag("mfa.verify"),
                            )
                        }
                    }
                    PrimaryButton("Ativar", loading = busy, enabled = code.length == 6, onClick = {
                        act {
                            val verified = container.api.mfaVerify(buildJsonObject { put("factor_id", e.factor_id); put("code", code) })
                            container.mfa.onEnrolled()
                            enrollment = null
                            code = ""
                            codes = verified.recovery_codes
                        }
                    })
                    TextButton(onClick = { enrollment = null; code = "" }) { Text("Cancelar") }
                }
                s?.active != null -> {
                    val f = s.active!!
                    WbCard {
                        Column(Modifier.padding(16.dp)) {
                            Text("Ativa", style = MaterialTheme.typography.titleMedium, color = c.ok, fontWeight = FontWeight.SemiBold)
                            Text("Aplicativo autenticador" + (f.activated_at?.let { " · desde ${formatDayLabel(it)}" } ?: ""), style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
                            Text("${s.recovery_codes_left} códigos de recuperação disponíveis", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                            Text(MfaTexts.policy(s.policy), style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                        }
                    }
                    SecondaryButton("Gerar novos códigos de recuperação", loading = busy, onClick = {
                        act { codes = container.api.mfaRecoveryCodes(JsonObject(emptyMap())).recovery_codes }
                    })
                    if (s.policy != "all") TextButton(onClick = { confirmRemove = true }, enabled = !busy) { Text("Remover o segundo fator", color = c.danger) }
                }
                else -> {
                    WbCard {
                        Column(Modifier.padding(16.dp)) {
                            Text("Proteja sua conta", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                            Text(
                                "Além da senha, entrar e as ações sensíveis passam a pedir o código de um aplicativo autenticador no seu celular. " + MfaTexts.policy(s?.policy),
                                style = MaterialTheme.typography.bodyMedium,
                                color = c.textSecondary,
                            )
                            Spacer(Modifier.height(12.dp))
                            OutlinedTextField(
                                value = password,
                                onValueChange = { password = it },
                                singleLine = true,
                                label = { Text("Sua senha") },
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                                modifier = Modifier.fillMaxWidth().testTag("mfa.password"),
                            )
                        }
                    }
                    PrimaryButton("Começar", loading = busy, enabled = password.isNotBlank(), onClick = {
                        act {
                            enrollment = container.api.mfaEnroll(buildJsonObject { put("password", password) })
                            password = ""
                        }
                    })
                }
            }
        }
    }

    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text("Remover o segundo fator?") },
            text = { Text("Entrar volta a pedir só a senha. Os códigos de recuperação deixam de valer.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    val id = status?.active?.id ?: return@TextButton
                    act {
                        container.api.mfaRemoveFactor(id)
                        container.mfa.onRemoved()
                        load()
                    }
                }) { Text("Remover", color = c.danger, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Voltar") } },
        )
    }
}

@Composable
private fun RecoveryCodes(codes: List<String>, onCopy: () -> Unit, onDone: () -> Unit) {
    val c = Wb.colors
    WbCard {
        Column(Modifier.padding(16.dp)) {
            Text("Guarde os códigos de recuperação", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                "Cada código entra uma vez, se você perder o celular. Eles não aparecem de novo: anote ou guarde num gerenciador de senhas.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
            Spacer(Modifier.height(10.dp))
            codes.forEach { Text(it, fontFamily = FontFamily.Monospace, color = c.textPrimary) }
        }
    }
    SecondaryButton("Copiar os códigos", onClick = onCopy)
    PrimaryButton("Já guardei", onClick = onDone)
}

private fun copy(context: Context, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("Códigos de recuperação", text))
}

private fun openOtpauth(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
    }
}
