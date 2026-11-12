package br.com.queven.wabotia.ui.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import br.com.queven.wabotia.core.model.Profile
import br.com.queven.wabotia.core.push.PushRegistrar
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PresenceViewModel
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.rememberPresence
import br.com.queven.wabotia.ui.theme.ThemeController
import br.com.queven.wabotia.ui.theme.ThemeMode
import br.com.queven.wabotia.ui.theme.Wb
import java.text.DateFormat
import java.util.Date

/**
 * Aba Ajustes (DESIGN.md, seção 10): cartão do usuário com presença e grupos em cartões — Atendimento, Notificações,
 * Aparência, Servidor, Dispositivo e Sair. Tudo o que existia na antiga aba "Mais" continua aqui; a lista da equipe
 * passou para a aba Equipe.
 */
@Composable
fun SettingsScreen(container: AppContainer, modifier: Modifier = Modifier, openLines: () -> Unit, openMenus: () -> Unit, openBotLines: () -> Unit) {
    val vm: SettingsViewModel = viewModel { SettingsViewModel(container) }
    val state by vm.state.collectAsState()
    val presence = rememberPresence(container)
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var systemAllows by remember { mutableStateOf(notificationsAllowed(context)) }
    var showProfiles by remember { mutableStateOf(false) }
    var showLogout by remember { mutableStateOf(false) }
    val c = Wb.colors

    // Cada vez que a aba volta a ficar visível: permissão do sistema pode ter mudado; dados são recarregados.
    LifecycleResumeEffect(Unit) {
        systemAllows = notificationsAllowed(context)
        vm.refresh()
        onPauseOrDispose { }
    }

    LaunchedEffect(state.message) {
        val msg = state.message ?: return@LaunchedEffect
        vm.consumeMessage()
        snackbar.showSnackbar(msg)
    }
    LaunchedEffect(presence.message) {
        val msg = presence.message ?: return@LaunchedEffect
        presence.consumeMessage()
        snackbar.showSnackbar(msg)
    }

    Scaffold(
        modifier = modifier,
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TabTopBar("Ajustes")
                ConnectionStrip(container)
            }
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            item("user") { UserCard(state, container.session.user?.id ?: "me", presence, Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp)) }

            // --- Atendimento ---
            item("service-label") { SectionLabel("Atendimento") }
            item("service") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(Icons.Filled.SupportAgent, "Linhas de atendimento", subtitle = "Quem atende cada número e quando os menus aparecem", onClick = openLines)
                    if (state.isAdmin) {
                        RowDivider()
                        SettingsRow(Icons.Filled.AccountTree, "Menus e submenus", subtitle = "Opções, destinos e linhas permitidas", tint = c.ticket, onClick = openMenus)
                        RowDivider()
                        SettingsRow(Icons.Filled.SmartToy, "Linhas dos bots", subtitle = "Em quais linhas cada bot pode atender", tint = c.bot, onClick = openBotLines)
                    }
                }
            }

            // --- Notificações ---
            item("notifications-label") { SectionLabel("Notificações") }
            item("notifications") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(
                        if (state.notificationsEnabled) Icons.Filled.Notifications else Icons.Filled.NotificationsOff,
                        "Receber notificações",
                        subtitle = if (state.notificationsEnabled) "Mensagens, fila, transferências, protocolos e ligações." else "Este aparelho não recebe avisos (ligações continuam tocando).",
                        tint = if (state.notificationsEnabled) c.brand else c.muted,
                        trailing = {
                            BusySwitch(
                                checked = state.notificationsEnabled,
                                busy = state.notificationsBusy,
                                onChange = { vm.setNotifications(it) },
                                description = if (state.notificationsEnabled) "Desativar notificações" else "Ativar notificações",
                            )
                        },
                    )
                    if (!systemAllows) {
                        InlineNotice(
                            "O Android está bloqueando as notificações do Wabotia. Libere nas configurações do sistema.",
                            Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            actionLabel = "Abrir",
                            onAction = { openNotificationSettings(context) },
                        )
                    }
                    RowDivider()
                    SettingsRow(
                        Icons.AutoMirrored.Filled.Send,
                        "Enviar teste",
                        subtitle = if (state.pushRegistered) "Envia uma notificação de teste para este aparelho." else "Registre o aparelho para poder enviar uma notificação de teste.",
                        enabled = !state.testBusy && state.pushRegistered,
                        onClick = { vm.sendTest() },
                        trailing = if (state.testBusy) ({ CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.brand) }) else null,
                    )
                    RowDivider()
                    SettingsRow(Icons.Filled.Settings, "Configurações do sistema", subtitle = "Sons, vibração e permissão de notificações no Android", tint = c.textSecondary, onClick = { openNotificationSettings(context) })
                    RowDivider()
                    SettingsRow(
                        if (state.pushRegistered) Icons.Filled.CloudDone else Icons.Filled.CloudOff,
                        when {
                            state.pushRegistered -> "Registrado para notificações"
                            state.pushTokenAvailable -> "Registro pendente no servidor"
                            else -> "Sem token de push"
                        },
                        subtitle = when {
                            state.pushRegistered -> "O servidor conhece este aparelho e envia avisos para ele."
                            state.pushTokenAvailable -> "O token do aparelho existe, mas o servidor ainda não o recebeu."
                            else -> "Este build não tem Firebase configurado ou o Google Play Services não está disponível."
                        },
                        tint = if (state.pushRegistered) c.ok else c.warn,
                        trailing = if (!state.pushRegistered) ({
                            TextButton(onClick = { vm.registerPush() }, enabled = !state.registerBusy) {
                                if (state.registerBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.brand)
                                else Text("Registrar agora", fontWeight = FontWeight.SemiBold, maxLines = 1)
                            }
                        }) else null,
                    )
                }
            }

            // --- Aparência ---
            item("appearance-label") { SectionLabel("Aparência") }
            item("appearance") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    Column(Modifier.padding(14.dp)) {
                        SegmentedTabs(ThemeMode.entries.map { it to it.label }, ThemeController.mode, { ThemeController.set(it) })
                        Spacer(Modifier.height(8.dp))
                        Text(
                            when (ThemeController.mode) {
                                ThemeMode.System -> "Acompanha o modo claro ou escuro do aparelho."
                                ThemeMode.Light -> "Sempre claro, mesmo com o aparelho em modo escuro."
                                ThemeMode.Dark -> "Sempre escuro."
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textSecondary,
                            modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                }
            }

            // --- Servidor ---
            item("server-label") { SectionLabel("Servidor") }
            item("server") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(
                        Icons.Filled.Dns,
                        state.serverUrl.removePrefix("https://").ifBlank { "Não configurado" },
                        subtitle = when {
                            state.healthLoading && state.health == null -> "Consultando versão…"
                            state.health != null -> buildString {
                                append("Wabotia ")
                                append(state.health!!.version.ifBlank { "(versão desconhecida)" })
                                if (state.health!!.commit.isNotBlank()) append(" · ").append(state.health!!.commit.take(7))
                            }
                            state.healthError != null -> state.healthError
                            else -> null
                        },
                        tint = c.ticket,
                        trailing = {
                            IconButton(onClick = { vm.loadHealth() }, enabled = !state.healthLoading) {
                                if (state.healthLoading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.brand)
                                else Icon(Icons.Filled.Refresh, contentDescription = "Consultar versão do servidor", tint = c.textSecondary)
                            }
                        },
                    )
                    RowDivider()
                    SettingsRow(
                        Icons.AutoMirrored.Filled.OpenInNew,
                        "Abrir painel no navegador",
                        subtitle = "Configurações completas do Wabotia",
                        enabled = state.serverUrl.isNotBlank(),
                        onClick = { openPanel(context, state.serverUrl) },
                    )
                    RowDivider()
                    SettingsRow(
                        Icons.Filled.SwapHoriz,
                        if (state.canSwitchProfile) "Trocar perfil" else "Perfil de atendimento",
                        subtitle = when {
                            state.profilesError != null -> state.profilesError
                            state.canSwitchProfile -> "${state.profileName.ifBlank { "Nenhum perfil" }} · acesso a ${state.profiles.size} perfis"
                            else -> "${state.profileName.ifBlank { "Nenhum perfil selecionado" }} · único perfil com acesso"
                        },
                        onClick = if (state.canSwitchProfile) ({ showProfiles = true }) else null,
                    )
                }
            }
            item("server-hint") { Hint("Para usar outro servidor, saia da conta e informe o novo endereço na tela de login.") }

            // --- Dispositivo ---
            item("device-label") { SectionLabel("Dispositivo") }
            item("device") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(
                        Icons.Filled.PhoneAndroid,
                        PushRegistrar.deviceName(),
                        subtitle = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\nWabotia ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})\nIdentificador: ${state.deviceId.take(8)}…",
                        tint = c.textSecondary,
                    )
                    sessionText(state.tokenExpires)?.let { text ->
                        RowDivider()
                        SettingsRow(Icons.Filled.Tune, "Sessão", subtitle = text, tint = c.textSecondary)
                    }
                }
            }

            // --- Sair ---
            item("logout") {
                WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp)) {
                    SettingsRow(
                        Icons.AutoMirrored.Filled.Logout,
                        "Sair da conta",
                        subtitle = "Este aparelho deixa de receber notificações",
                        tint = c.danger,
                        titleColor = c.danger,
                        enabled = !state.loggingOut,
                        onClick = { showLogout = true },
                        trailing = if (state.loggingOut) ({ CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.danger) }) else null,
                    )
                }
            }
        }
    }

    if (showProfiles) {
        ProfileSheet(
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
            confirmButton = { TextButton(onClick = { showLogout = false; vm.logout() }) { Text("Sair", color = c.danger, fontWeight = FontWeight.SemiBold) } },
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
            confirmButton = { TextButton(onClick = { vm.logout() }) { Text("Tentar de novo") } },
            dismissButton = {
                Row {
                    TextButton(onClick = { vm.logout(force = true) }) { Text("Sair mesmo assim", color = c.danger) }
                    TextButton(onClick = { vm.clearLogoutError() }) { Text("Cancelar") }
                }
            },
        )
    }
}

// --- partes ---

/** Cartão do usuário: avatar, nome, e-mail, papel, perfil atual e o interruptor de presença. */
@Composable
private fun UserCard(state: SettingsUiState, seed: String, presence: PresenceViewModel, modifier: Modifier = Modifier) {
    val c = Wb.colors
    val name = state.userName.ifBlank { "Atendente" }
    val online = presence.present == true
    WbCard(modifier) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(name, seed = seed, size = 56.dp, online = presence.present, ringColor = c.surface)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (state.userEmail.isNotBlank()) {
                    Text(state.userEmail, style = MaterialTheme.typography.bodySmall, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Pill(if (state.isAdmin) "Administrador" else "Atendente", if (state.isAdmin) c.brand else c.textSecondary)
                    if (state.profileName.isNotBlank()) {
                        Spacer(Modifier.width(8.dp))
                        Text(state.profileName, style = MaterialTheme.typography.bodySmall, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        HorizontalDivider(color = c.hairline, modifier = Modifier.padding(horizontal = 16.dp))
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 16.dp, end = 12.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    when (presence.present) {
                        true -> "Você está online"
                        false -> "Você está offline"
                        null -> "Consultando presença…"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    color = c.textPrimary,
                )
                Text(
                    if (online) "Você recebe novos atendimentos e transferências." else "Novos atendimentos não são encaminhados a você.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
            Spacer(Modifier.width(8.dp))
            BusySwitch(
                checked = online,
                busy = presence.busy,
                enabled = presence.present != null,
                onChange = { presence.set(it) },
                description = if (online) "Ficar offline" else "Ficar online",
                checkedColor = c.ok,
            )
        }
    }
}

/** Interruptor que vira indicador de progresso enquanto o pedido está em curso. */
@Composable
private fun BusySwitch(checked: Boolean, busy: Boolean, onChange: (Boolean) -> Unit, description: String, enabled: Boolean = true, checkedColor: Color = Wb.colors.brand) {
    Box(Modifier.size(width = 56.dp, height = 48.dp), contentAlignment = Alignment.Center) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = checkedColor)
        } else {
            Switch(
                checked = checked,
                onCheckedChange = onChange,
                enabled = enabled,
                colors = SwitchDefaults.colors(checkedTrackColor = checkedColor, checkedThumbColor = Color.White, checkedBorderColor = checkedColor),
                modifier = Modifier.semantics { contentDescription = description },
            )
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp))
}

private fun sessionText(tokenExpires: Long): String? {
    if (tokenExpires <= 0L) return null
    val remaining = tokenExpires - System.currentTimeMillis()
    val date = DateFormat.getDateInstance(DateFormat.SHORT).format(Date(tokenExpires))
    return when {
        remaining <= 0 -> "Sessão expirada. Será preciso entrar novamente."
        remaining < SessionRefresher.THRESHOLD_MS -> "Válida até $date (renovação automática em andamento)."
        else -> "Válida até $date; renova sozinha quando faltarem 7 dias."
    }
}

@Composable
private fun ProfileSheet(profiles: List<Profile>, selected: String?, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Wb.colors
    WbBottomSheet(onDismiss = onDismiss, title = "Trocar perfil", subtitle = "As listas de conversas, protocolos e ligações passam a mostrar o perfil escolhido.") {
        profiles.forEach { p ->
            val isSelected = p.id == selected
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.RadioButton) { onSelect(p.id) }
                    .heightIn(min = 64.dp)
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(p.name, seed = p.id, size = 44.dp, ringColor = if (c.isDark) c.surface else c.background)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (p.enabled == 1) "Atendimento ativo" else "Atendimento pausado", style = MaterialTheme.typography.bodySmall, color = if (p.enabled == 1) c.ok else c.textSecondary)
                }
                if (isSelected) Icon(Icons.Filled.Check, contentDescription = "Perfil atual", tint = c.brand)
            }
        }
    }
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
