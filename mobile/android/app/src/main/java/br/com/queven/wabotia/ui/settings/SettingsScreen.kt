package br.com.queven.wabotia.ui.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.SessionRefresher
import br.com.queven.wabotia.core.model.PresenceEntry
import br.com.queven.wabotia.core.model.Profile
import br.com.queven.wabotia.core.push.PushRegistrar
import br.com.queven.wabotia.ui.theme.BrandLight
import java.text.DateFormat
import java.util.Date

/**
 * Aba Mais (mobile/README.md): disponibilidade, perfil, notificações, dispositivo, servidor e sair.
 * Assinatura usada por ui/home/HomeScreen.kt; não alterar.
 */
@Composable
fun SettingsScreen(container: AppContainer, modifier: Modifier = Modifier, openTeam: () -> Unit = {}, openLines: () -> Unit = {}, openMenus: () -> Unit = {}, openBotLines: () -> Unit = {}) {
    val vm: SettingsViewModel = viewModel { SettingsViewModel(container) }
    val state by vm.state.collectAsState()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var systemAllows by remember { mutableStateOf(notificationsAllowed(context)) }
    var showProfiles by remember { mutableStateOf(false) }
    var showLogout by remember { mutableStateOf(false) }

    // Cada vez que a aba volta a ficar visível: permissão do sistema pode ter mudado; dados são recarregados.
    LifecycleResumeEffect(Unit) {
        systemAllows = notificationsAllowed(context)
        vm.refresh()
        onPauseOrDispose { }
    }

    LaunchedEffect(state.message) {
        val msg = state.message ?: return@LaunchedEffect
        snackbar.showSnackbar(msg)
        vm.consumeMessage()
    }

    Box(modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
            item {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    TextButton(onClick = openTeam) { Text("Equipe e conversas internas") }
                    TextButton(onClick = openLines) { Text("Linhas de atendimento") }
                    if (container.session.user?.isAdmin == true) {
                        TextButton(onClick = openMenus) { Text("Menus e submenus") }
                        TextButton(onClick = openBotLines) { Text("Linhas dos bots") }
                    }
                }
            }

            item { AccountHeader(state) }

            // --- Disponibilidade ---
            item { SectionTitle("Disponibilidade") }
            item {
                ListItem(
                    headlineContent = { Text(if (state.present) "Presente" else "Ausente") },
                    supportingContent = {
                        Text(if (state.present) "Você recebe novos atendimentos e transferências." else "A equipe vê você como indisponível.")
                    },
                    leadingContent = { PresenceDot(state.present, large = true) },
                    trailingContent = {
                        if (state.presenceBusy) {
                            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                        } else {
                            Switch(
                                checked = state.present,
                                onCheckedChange = { vm.setPresent(it) },
                                enabled = state.profileId != null && !state.presenceLoading,
                                modifier = Modifier.semantics { contentDescription = if (state.present) "Marcar como ausente" else "Marcar como presente" },
                            )
                        }
                    },
                )
            }
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Equipe do perfil", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    IconButton(onClick = { vm.loadPresence() }, enabled = !state.presenceLoading) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Atualizar equipe")
                    }
                }
            }
            when {
                state.presenceError != null -> item { ErrorText(state.presenceError!!) }
                state.presenceLoading && state.team.isEmpty() -> item { LoadingRow() }
                state.team.isEmpty() -> item { HintText("Nenhuma pessoa com acesso a este perfil.") }
                else -> items(state.team, key = { it.actor }) { TeamRow(it, isMe = it.actor == container.session.user?.id) }
            }
            item { HorizontalDivider(Modifier.padding(top = 8.dp)) }

            // --- Perfil ---
            item { SectionTitle("Perfil de atendimento") }
            item {
                ListItem(
                    headlineContent = { Text(state.profileName.ifBlank { "Nenhum perfil selecionado" }) },
                    supportingContent = {
                        Text(
                            when {
                                state.profilesError != null -> state.profilesError!!
                                state.canSwitchProfile -> "Você tem acesso a ${state.profiles.size} perfis."
                                else -> "Você tem acesso a um único perfil."
                            },
                        )
                    },
                    leadingContent = { Icon(Icons.Filled.Person, contentDescription = null) },
                    trailingContent = {
                        if (state.canSwitchProfile) {
                            TextButton(onClick = { showProfiles = true }) {
                                Icon(Icons.Filled.SwapHoriz, contentDescription = null, Modifier.size(18.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Trocar")
                            }
                        }
                    },
                )
            }
            item { HorizontalDivider() }

            // --- Notificações ---
            item { SectionTitle("Notificações") }
            item {
                ListItem(
                    headlineContent = { Text("Receber notificações") },
                    supportingContent = {
                        Text(if (state.notificationsEnabled) "Mensagens, fila, transferências, protocolos e ligações." else "Este aparelho não recebe avisos (ligações continuam tocando).")
                    },
                    leadingContent = {
                        Icon(if (state.notificationsEnabled) Icons.Filled.Notifications else Icons.Filled.NotificationsOff, contentDescription = null)
                    },
                    trailingContent = {
                        if (state.notificationsBusy) {
                            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                        } else {
                            Switch(
                                checked = state.notificationsEnabled,
                                onCheckedChange = { vm.setNotifications(it) },
                                modifier = Modifier.semantics { contentDescription = if (state.notificationsEnabled) "Desativar notificações" else "Ativar notificações" },
                            )
                        }
                    },
                )
            }
            if (!systemAllows) {
                item {
                    Text(
                        "O Android está bloqueando as notificações do Wabotia. Libere nas configurações do sistema.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { vm.sendTest() },
                        enabled = !state.testBusy && state.pushRegistered,
                        modifier = Modifier.weight(1f),
                    ) {
                        if (state.testBusy) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Enviar teste")
                        }
                    }
                    OutlinedButton(onClick = { openNotificationSettings(context) }, modifier = Modifier.weight(1f)) {
                        Icon(Icons.Filled.Settings, contentDescription = null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Sistema")
                    }
                }
            }
            if (!state.pushRegistered) {
                item { HintText("Registre o aparelho para poder enviar uma notificação de teste.") }
            }
            item { HorizontalDivider() }

            // --- Dispositivo ---
            item { SectionTitle("Dispositivo") }
            item {
                ListItem(
                    headlineContent = { Text(PushRegistrar.deviceName()) },
                    supportingContent = {
                        Column {
                            Text("Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                            Text("Wabotia ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                            Text("Identificador: ${state.deviceId.take(8)}…", style = MaterialTheme.typography.bodySmall)
                        }
                    },
                    leadingContent = { Icon(Icons.Filled.PhoneAndroid, contentDescription = null) },
                )
            }
            item {
                ListItem(
                    headlineContent = {
                        Text(
                            when {
                                state.pushRegistered -> "Registrado para notificações"
                                state.pushTokenAvailable -> "Registro pendente no servidor"
                                else -> "Sem token de push"
                            },
                        )
                    },
                    supportingContent = {
                        Text(
                            when {
                                state.pushRegistered -> "O servidor conhece este aparelho e envia avisos para ele."
                                state.pushTokenAvailable -> "O token do aparelho existe, mas o servidor ainda não o recebeu."
                                else -> "Este build não tem Firebase configurado ou o Google Play Services não está disponível."
                            },
                        )
                    },
                    leadingContent = { PresenceDot(state.pushRegistered, large = true) },
                    trailingContent = {
                        if (!state.pushRegistered) {
                            TextButton(onClick = { vm.registerPush() }, enabled = !state.registerBusy) {
                                if (state.registerBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Registrar agora")
                            }
                        }
                    },
                )
            }
            item { SessionInfo(state.tokenExpires) }
            item { HorizontalDivider() }

            // --- Servidor ---
            item { SectionTitle("Servidor") }
            item {
                ListItem(
                    headlineContent = { Text(state.serverUrl.removePrefix("https://").ifBlank { "Não configurado" }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = {
                        Text(
                            when {
                                state.healthLoading && state.health == null -> "Consultando versão…"
                                state.health != null -> buildString {
                                    append("Wabotia ")
                                    append(state.health!!.version.ifBlank { "(versão desconhecida)" })
                                    if (state.health!!.commit.isNotBlank()) append(" · ").append(state.health!!.commit.take(7))
                                }
                                state.healthError != null -> state.healthError!!
                                else -> ""
                            },
                        )
                    },
                    leadingContent = { Icon(Icons.Filled.Dns, contentDescription = null) },
                    trailingContent = {
                        IconButton(onClick = { vm.loadHealth() }, enabled = !state.healthLoading) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Consultar versão do servidor")
                        }
                    },
                )
            }
            item {
                OutlinedButton(
                    onClick = { openPanel(context, state.serverUrl) },
                    enabled = state.serverUrl.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Abrir painel no navegador")
                }
            }
            item { HintText("Para usar outro servidor, saia da conta e informe o novo endereço na tela de login.") }
            item { HorizontalDivider(Modifier.padding(top = 8.dp)) }

            // --- Sair ---
            item {
                Button(
                    onClick = { showLogout = true },
                    enabled = !state.loggingOut,
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp),
                ) {
                    if (state.loggingOut) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onErrorContainer)
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Sair da conta")
                    }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }

    if (showProfiles) {
        ProfileDialog(
            profiles = state.profiles,
            selected = state.profileId,
            onSelect = { vm.selectProfile(it); showProfiles = false },
            onDismiss = { showProfiles = false },
        )
    }
    if (showLogout) {
        AlertDialog(
            onDismissRequest = { showLogout = false },
            title = { Text("Sair da conta?") },
            text = {
                Text("Este aparelho deixa de receber notificações e você volta para a tela de login. O servidor ${state.serverUrl.removePrefix("https://")} continua salvo.")
            },
            confirmButton = { TextButton(onClick = { showLogout = false; vm.logout() }) { Text("Sair") } },
            dismissButton = { TextButton(onClick = { showLogout = false }) { Text("Cancelar") } },
        )
    }
    state.logoutError?.let { err ->
        AlertDialog(
            onDismissRequest = { vm.clearLogoutError() },
            title = { Text("Não foi possível avisar o servidor") },
            text = {
                Text("$err\n\nVocê pode tentar de novo ou sair apenas deste aparelho. Nesse caso o acesso continua válido no servidor até expirar.")
            },
            confirmButton = { TextButton(onClick = { vm.logout() }) { Text("Tentar novamente") } },
            dismissButton = {
                Row {
                    TextButton(onClick = { vm.logout(force = true) }) { Text("Sair mesmo assim") }
                    TextButton(onClick = { vm.clearLogoutError() }) { Text("Cancelar") }
                }
            },
        )
    }
}

// --- partes ---

@Composable
private fun AccountHeader(state: SettingsUiState) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(48.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                state.userName.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(state.userName.ifBlank { "Atendente" }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (state.userEmail.isNotBlank()) {
                Text(state.userEmail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(if (state.isAdmin) "Administrador" else "Atendente", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun HintText(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
}

@Composable
private fun ErrorText(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
}

@Composable
private fun LoadingRow() {
    Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
    }
}

@Composable
private fun PresenceDot(on: Boolean, large: Boolean = false) {
    val color: Color = if (on) BrandLight else MaterialTheme.colorScheme.outlineVariant
    Box(
        Modifier
            .size(if (large) 14.dp else 10.dp)
            .clip(CircleShape)
            .background(color)
            .semantics { contentDescription = if (on) "Presente" else "Ausente" },
    )
}

@Composable
private fun TeamRow(entry: PresenceEntry, isMe: Boolean) {
    val present = entry.present == 1
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        PresenceDot(present)
        Spacer(Modifier.width(12.dp))
        Text(
            entry.name.ifBlank { entry.actor } + if (isMe) " (você)" else "",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            if (present) "Presente" else "Ausente",
            style = MaterialTheme.typography.labelMedium,
            color = if (present) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SessionInfo(tokenExpires: Long) {
    if (tokenExpires <= 0L) return
    val remaining = tokenExpires - System.currentTimeMillis()
    val date = remember(tokenExpires) { DateFormat.getDateInstance(DateFormat.SHORT).format(Date(tokenExpires)) }
    val text = when {
        remaining <= 0 -> "Sessão expirada. Será preciso entrar novamente."
        remaining < SessionRefresher.THRESHOLD_MS -> "Sessão válida até $date (renovação automática em andamento)."
        else -> "Sessão válida até $date; renova sozinha quando faltarem 7 dias."
    }
    HintText(text)
}

@Composable
private fun ProfileDialog(profiles: List<Profile>, selected: String?, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Trocar perfil") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                profiles.forEach { p ->
                    val isSelected = p.id == selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .selectable(selected = isSelected, role = Role.RadioButton) { onSelect(p.id) }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = isSelected, onClick = null)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(p.name, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                if (p.enabled == 1) "Atendimento ativo" else "Atendimento pausado",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "As listas de conversas, protocolos e ligações passam a mostrar o perfil escolhido.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Fechar") } },
    )
}

// --- utilitários ---

private fun notificationsAllowed(context: Context): Boolean =
    runCatching { NotificationManagerCompat.from(context).areNotificationsEnabled() }.getOrDefault(true)

/** Abre a tela de notificações do app nas configurações do Android (API 26+). */
private fun openNotificationSettings(context: Context) {
    // android.provider.Settings é referenciado pelo nome completo para não colidir com o ícone Icons.Filled.Settings.
    val intent = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: ActivityNotFoundException) {
        }
    }
}

/** Abre {serverUrl}/app no navegador. */
private fun openPanel(context: Context, serverUrl: String) {
    if (serverUrl.isBlank()) return
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${serverUrl.trimEnd('/')}/app")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
    }
}
