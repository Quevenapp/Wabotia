package br.com.queven.wabotia.device.ui

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.automirrored.filled.ViewQuilt
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.device.DeviceRole
import br.com.queven.wabotia.device.core.PanelPin
import br.com.queven.wabotia.device.DeviceState
import br.com.queven.wabotia.device.DeviceViewModel
import br.com.queven.wabotia.device.toRuntime
import br.com.queven.wabotia.printing.CouponData
import br.com.queven.wabotia.printing.CouponText
import br.com.queven.wabotia.printing.TicketPrint
import br.com.queven.wabotia.queue.QueueTicket
import br.com.queven.wabotia.ui.auth.AuthFieldShape
import br.com.queven.wabotia.ui.auth.AuthHelp
import br.com.queven.wabotia.ui.auth.AuthScaffold
import br.com.queven.wabotia.ui.auth.authFieldColors
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.printing.PrinterScreen
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay

/**
 * O modo aparelho tem quatro lugares: parear com o Wabotia, escolher o papel (e os ajustes), a tela do papel (totem,
 * painel de chamadas ou híbrido) e a impressora. Ajustes e saída ficam atrás da engrenagem e do PIN.
 */
@Composable
fun DeviceApp(container: AppContainer, vm: DeviceViewModel, onFinish: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    var printer by rememberSaveable { mutableStateOf(false) }
    var settings by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(state.finished) { if (state.finished) onFinish() }
    val config = state.config
    // Ajustes (e impressora) abertos com o PIN por cima da tela do papel: fecham sozinhos depois de um minuto sem toque
    // e quando o app vai para segundo plano, para não ficarem destravados à espera de alguém tocar em "Voltar à tela".
    val unlocked = config?.role != null && (settings || printer)
    val idle = remember { IdleTimer() }
    LaunchedEffect(unlocked) {
        if (!unlocked) return@LaunchedEffect
        idle.touch()
        while (true) {
            delay(1000)
            if (idle.paused) idle.touch()
            else if (idle.idleMillis() >= UNLOCKED_IDLE_MS) {
                settings = false
                printer = false
                break
            }
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        if (unlocked) {
            settings = false
            printer = false
        }
    }
    Box(Modifier.fillMaxSize().reportTouches(idle::touch)) {
        DeviceAppContent(container, state, vm, printer, settings, idle, onPrinter = { printer = it }, onSettings = { settings = it }, onFinish = onFinish)
    }
}

@Composable
private fun DeviceAppContent(
    container: AppContainer,
    state: DeviceState,
    vm: DeviceViewModel,
    printer: Boolean,
    settings: Boolean,
    idle: IdleTimer,
    onPrinter: (Boolean) -> Unit,
    onSettings: (Boolean) -> Unit,
    onFinish: () -> Unit,
) {
    val config = state.config
    when {
        state.finished -> Box(Modifier.fillMaxSize().background(Wb.colors.background))
        config == null -> PairingScreen(state, vm, onBack = onFinish)
        printer -> {
            BackHandler { onPrinter(false) }
            PrinterScreen(container, onBack = { onPrinter(false) })
        }
        config.role == null || settings ->
            DeviceSettingsScreen(
                state = state,
                vm = vm,
                idle = idle,
                onPrinter = { onPrinter(true) },
                onDone = if (config.role != null) ({ onSettings(false) }) else null,
            )
        else -> PanelScreen(state, vm, onSettings = { onSettings(true) })
    }
}

/** Um minuto sem toque fecha os ajustes destravados. */
private const val UNLOCKED_IDLE_MS = 60_000L

/** O último toque na tela; com um diálogo aberto (PIN, confirmação), o tempo não corre. Sem estado de Compose. */
private class IdleTimer {
    private var last = SystemClock.elapsedRealtime()
    var paused = false

    fun touch() {
        last = SystemClock.elapsedRealtime()
    }

    fun idleMillis(): Long = SystemClock.elapsedRealtime() - last
}

/** Avisa cada toque (e arraste) na área, sem consumir: os botões e a rolagem continuam funcionando. */
private fun Modifier.reportTouches(onTouch: () -> Unit): Modifier = pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) {
            awaitPointerEvent(PointerEventPass.Initial)
            onTouch()
        }
    }
}

// --- parear ---------------------------------------------------------------------

@Composable
private fun PairingScreen(state: DeviceState, vm: DeviceViewModel, onBack: () -> Unit) {
    val c = Wb.colors
    var url by rememberSaveable { mutableStateOf(state.serverUrl?.removePrefix("https://").orEmpty()) }
    var name by rememberSaveable { mutableStateOf("") }
    val code = state.pairing.userCode
    BackHandler { if (code != null) vm.cancelPairing() else onBack() }
    AuthScaffold(
        title = if (code == null) "Painel ou totem" else "Aprove no Wabotia",
        subtitle = if (code == null) "Este aparelho vira um totem de senhas, um painel de chamadas ou os dois." else "Digite este código no painel do Wabotia.",
        markSize = 64.dp,
        topSpace = 24.dp,
    ) {
        if (state.demo) {
            InlineNotice("Demonstração: o código é aprovado sozinho em alguns segundos e nada sai do aparelho.", color = c.warn)
            Spacer(Modifier.height(12.dp))
        }
        if (code == null) {
            WbCard {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = url,
                        onValueChange = { url = it },
                        label = { Text("Servidor") },
                        prefix = { Text("https://", color = c.textSecondary) },
                        singleLine = true,
                        enabled = !state.pairing.busy && !state.demo,
                        shape = AuthFieldShape,
                        colors = authFieldColors(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().testTag("device.url"),
                    )
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it.take(80) },
                        label = { Text("Nome deste aparelho") },
                        placeholder = { Text("Totem da entrada") },
                        singleLine = true,
                        enabled = !state.pairing.busy,
                        shape = AuthFieldShape,
                        colors = authFieldColors(),
                        modifier = Modifier.fillMaxWidth().testTag("device.name"),
                    )
                }
            }
            Spacer(Modifier.height(20.dp))
            PrimaryButton(
                "Gerar código",
                onClick = { vm.startPairing(if (state.demo) state.serverUrl.orEmpty() else url, name) },
                loading = state.pairing.busy,
                enabled = url.isNotBlank() && name.isNotBlank(),
                modifier = Modifier.testTag("device.start"),
            )
            Spacer(Modifier.height(16.dp))
            AuthHelp("O aparelho recebe uma credencial própria, separada de qualquer conta de pessoa. Ele só lê a fila e emite senhas; chamar senhas fica no guichê, dentro do app.")
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onBack) { Text("Voltar", color = c.brand, fontWeight = FontWeight.SemiBold) }
        } else {
            WbCard {
                Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        code,
                        fontSize = 48.sp,
                        fontWeight = FontWeight.Black,
                        fontFamily = FontFamily.Monospace,
                        color = c.textPrimary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.testTag("device.code"),
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.brand)
                        Spacer(Modifier.width(10.dp))
                        Text("Esperando a aprovação…", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            AuthHelp("No painel do Wabotia, um administrador abre Integrações → Parear Senhapp, digita o código e aprova só “Ler a fila” e “Emitir senhas (totem)”. O código vale 10 minutos.")
            Spacer(Modifier.height(16.dp))
            SecondaryButton("Cancelar", onClick = vm::cancelPairing)
        }
        state.pairing.error?.let {
            Spacer(Modifier.height(12.dp))
            InlineNotice(it, Modifier.testTag("device.error"))
        }
    }
}

// --- papel e ajustes ---------------------------------------------------------------

/** Volume de alarme do aparelho (atual, máximo), relido a cada meio segundo enquanto a tela está aberta. */
@Composable
private fun rememberAlarmVolume(): Pair<Int, Int>? {
    val context = androidx.compose.ui.platform.LocalContext.current
    val audio = remember { context.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager }
    var value by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    LaunchedEffect(audio) {
        while (audio != null) {
            value = audio.getStreamVolume(android.media.AudioManager.STREAM_ALARM) to audio.getStreamMaxVolume(android.media.AudioManager.STREAM_ALARM)
            kotlinx.coroutines.delay(500)
        }
    }
    return value
}

@Composable
private fun DeviceSettingsScreen(state: DeviceState, vm: DeviceViewModel, idle: IdleTimer, onPrinter: () -> Unit, onDone: (() -> Unit)?) {
    val config = state.config ?: return
    val c = Wb.colors
    var pinDialog by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }
    /** O papel tocado antes de haver PIN: escolhido assim que o PIN é criado. */
    var pendingRole by remember { mutableStateOf<DeviceRole?>(null) }
    // Com um diálogo aberto, o minuto sem toque não corre (o teclado do PIN não conta como toque na tela).
    LaunchedEffect(pinDialog, confirmLeave) {
        idle.paused = pinDialog || confirmLeave
        idle.touch()
    }
    // Aparelho pareado antes do PIN obrigatório: pede o PIN ao abrir os ajustes.
    LaunchedEffect(Unit) { if (state.pinRequired && !state.pinSet && config.role != null) pinDialog = true }
    val needsPin = state.pinRequired && !state.pinSet
    val done: (() -> Unit)? = onDone?.let { back -> { if (needsPin) pinDialog = true else back() } }
    done?.let { BackHandler(onBack = it) }
    // O Android não avisa quando a fixação muda (pergunta aceita, gesto do sistema): lê de novo a cada segundo.
    val context = LocalContext.current
    val activity = context.findActivity()
    var lockState by remember { mutableStateOf(DeviceLock.state(context)) }
    LaunchedEffect(Unit) {
        while (true) {
            lockState = DeviceLock.state(context)
            delay(1000)
        }
    }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            if (done != null) DetailTopBar("Ajustes deste aparelho", onBack = done, subtitle = config.name)
            else DetailTopBar("O que este aparelho faz?", onBack = { confirmLeave = true }, subtitle = config.name)
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(bottom = 24.dp),
        ) {
            Column(Modifier.fillMaxWidth().widthIn(max = 720.dp).align(Alignment.CenterHorizontally)) {
                state.notice?.let { InlineNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), color = c.warn) }
                SectionLabel("Papel")
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    DeviceRole.entries.forEach { role ->
                        RoleCard(role, selected = config.role == role, enabled = !role.totem || config.canIssue()) {
                            // Pareamento real: o papel só vale com o PIN de saída criado.
                            if (needsPin) {
                                pendingRole = role
                                pinDialog = true
                            } else {
                                vm.chooseRole(role)
                            }
                        }
                    }
                }
                if (config.role?.panel == true || config.role?.totem == true) {
                    SectionLabel("Visual da tela")
                    Box(Modifier.padding(horizontal = 16.dp)) { TemplatePicker(state.template, vm::setTemplate) }
                }
                SectionLabel("Aparelho")
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    if (config.role?.panel == true) {
                        // Gongo e voz saem no volume de ALARME: com ele no mínimo o painel fica mudo e nada na tela dizia.
                        val alarm = rememberAlarmVolume()
                        val lowAlarm = alarm != null && alarm.first * 3 < alarm.second
                        SettingsRow(
                            Icons.Filled.RecordVoiceOver,
                            "Voz das chamadas",
                            subtitle = if (state.soundEnabled && lowAlarm) {
                                "Volume do alarme do aparelho está baixo (${alarm!!.first} de ${alarm.second}): suba em Configurações → Sons → Volume → Alarme, ou o painel quase não se ouve."
                            } else {
                                "Gongo e a senha falada duas vezes, no volume do alarme"
                            },
                            trailing = {
                                Switch(
                                    checked = state.soundEnabled,
                                    onCheckedChange = vm::setSound,
                                    colors = SwitchDefaults.colors(checkedTrackColor = c.brand, checkedThumbColor = c.onBrand),
                                )
                            },
                        )
                        RowDivider()
                        // O volume do alarme do aparelho, aqui dentro: com o app fixado, quem cuida do painel não chega às
                        // Configurações do sistema, e os botões físicos às vezes mexem em outro canal.
                        if (alarm != null) {
                            val context = androidx.compose.ui.platform.LocalContext.current
                            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                                Text("Volume do painel: ${alarm.first} de ${alarm.second}", color = c.textPrimary, style = MaterialTheme.typography.bodyLarge)
                                androidx.compose.material3.Slider(
                                    value = alarm.first.toFloat(),
                                    onValueChange = { v ->
                                        (context.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager)
                                            ?.setStreamVolume(android.media.AudioManager.STREAM_ALARM, v.toInt().coerceIn(1, alarm.second), 0)
                                    },
                                    valueRange = 1f..alarm.second.toFloat(),
                                    steps = (alarm.second - 2).coerceAtLeast(0),
                                    modifier = Modifier.testTag("device.volume"),
                                )
                                Text("É o volume de alarme do aparelho: o painel toca mesmo com o aparelho no silencioso.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                            }
                            RowDivider()
                        }
                        SettingsRow(Icons.AutoMirrored.Filled.VolumeUp, "Testar som", subtitle = "“Senha N 1. Guichê 1.”", tint = c.ticket, onClick = vm::testSound)
                        RowDivider()
                    }
                    // Em qualquer papel: no Painel de chamadas nada é impresso, mas a impressora pode ficar pronta para quando o
                    // aparelho virar Totem ou Híbrido (antes a linha sumia no Painel e ninguém achava onde configurar).
                    SettingsRow(
                        Icons.Filled.Print,
                        "Impressora do cupom",
                        subtitle = if (config.role?.totem == true) "Bluetooth, USB ou Wi-Fi" else "O Painel de chamadas não imprime: só o Totem e o Painel híbrido imprimem o cupom. Dá para deixar a impressora pronta aqui.",
                        tint = c.textSecondary,
                        onClick = onPrinter,
                    )
                    RowDivider()
                    // Por que o QR do WhatsApp não sai no cupom (sem linha, linha sem número, desligado): aviso para quem
                    // configura, aqui atrás do PIN; o cupom não fala disso.
                    DeviceTexts.qrNotice(config.role?.totem == true, state.overview?.coupon)?.let { notice ->
                        SettingsRow(
                            Icons.Filled.QrCode2,
                            "QR do WhatsApp fora do cupom",
                            subtitle = notice,
                            tint = if (state.overview?.coupon?.whatsappQrIssue == "disabled") c.muted else c.warn,
                        )
                        RowDivider()
                    }
                    SettingsRow(
                        if (state.pinSet) Icons.Filled.Lock else Icons.Filled.LockOpen,
                        if (state.pinSet) "Trocar o PIN de saída" else "Criar PIN de saída",
                        // A promessa depende da trava: o PIN guarda os botões do app; sair da tela depende da fixação.
                        subtitle = when {
                            state.demo -> "Sem o PIN, ninguém abre estes ajustes nem sai da demonstração pelo app"
                            lockState == DeviceLockState.LOCKED -> "Sem o PIN, ninguém abre estes ajustes nem sai da tela do aparelho"
                            lockState == DeviceLockState.PINNED -> "Sem o PIN, ninguém abre estes ajustes; a tela fixada só sai pelo gesto do sistema"
                            else -> "Sem o PIN, ninguém abre estes ajustes. Fixe a tela (abaixo) para ninguém sair dela"
                        },
                        tint = if (state.pinSet) c.ok else c.warn,
                        onClick = { pinDialog = true },
                    )
                    // Num pareamento real o PIN é obrigatório: troca-se, não se remove.
                    if (state.pinSet && !state.pinRequired) {
                        RowDivider()
                        SettingsRow(Icons.Filled.LockOpen, "Remover o PIN", tint = c.muted, onClick = vm::removePin)
                    }
                }
                if (!state.demo) {
                    SectionLabel("Trava da tela")
                    LockCard(
                        lockState,
                        canPin = config.role != null,
                        onPin = { activity?.let(DeviceLock::enter) },
                        onRelease = { activity?.let(DeviceLock::exit) },
                    )
                }
                SectionLabel("Conexão")
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(
                        Icons.Filled.Info,
                        config.baseUrl.removePrefix("https://"),
                        subtitle = when {
                            state.demo -> "Demonstração: dados fictícios, nada sai do aparelho"
                            state.revoked -> "Credencial revogada no servidor"
                            state.offline -> "Sem conexão agora"
                            state.live -> "Ao vivo (WebSocket)"
                            else -> "Conectado (consulta a cada 5 s)"
                        },
                        tint = if (state.revoked || state.offline) c.danger else c.ok,
                    )
                    RowDivider()
                    SettingsRow(
                        Icons.Filled.LinkOff,
                        if (state.demo) "Sair da demonstração" else "Desfazer pareamento",
                        subtitle = if (state.demo) null else "O aparelho esquece a credencial e avisa o Wabotia",
                        tint = c.danger,
                        titleColor = c.danger,
                        onClick = { confirmLeave = true },
                    )
                }
                done?.let {
                    Spacer(Modifier.height(20.dp))
                    PrimaryButton("Voltar à tela", onClick = it, modifier = Modifier.padding(horizontal = 16.dp))
                }
            }
        }
    }
    if (pinDialog) {
        PinCreateDialog(
            required = needsPin,
            onCreate = { pin, again ->
                vm.createPin(pin, again).also { problem ->
                    if (problem == null) pendingRole?.let(vm::chooseRole)
                }
            },
            onClose = {
                pinDialog = false
                pendingRole = null
            },
        )
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text(if (state.demo) "Sair da demonstração?" else "Desfazer pareamento?") },
            text = {
                Text(
                    if (state.demo) "O aparelho volta à tela inicial do Wabotia."
                    else "O aparelho esquece o vínculo e avisa o Wabotia. Para voltar a ser painel ou totem, pareie de novo.",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmLeave = false; vm.unpair() }) { Text(if (state.demo) "Sair" else "Desfazer", color = Wb.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("Cancelar") } },
        )
    }
}

@Composable
private fun RoleCard(role: DeviceRole, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = Wb.colors
    val shape = RoundedCornerShape(16.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) c.soft(c.brand, 0.14f) else c.surface)
            .border(if (selected) 2.dp else 1.dp, if (selected) c.brand else c.hairline, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(16.dp)
            .testTag("role.${role.name.lowercase()}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            when (role) {
                DeviceRole.TOTEM -> Icons.Filled.ConfirmationNumber
                DeviceRole.PANEL -> Icons.Filled.Tv
                DeviceRole.HYBRID -> Icons.AutoMirrored.Filled.ViewQuilt
            },
            contentDescription = null,
            tint = if (enabled) c.brand else c.muted,
            modifier = Modifier.size(28.dp),
        )
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(role.label, style = MaterialTheme.typography.titleMedium, color = if (enabled) c.textPrimary else c.muted)
            Text(
                if (enabled) role.detail else "Sem permissão de emitir senhas neste pareamento",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }
        if (selected) Icon(Icons.Filled.CheckCircle, contentDescription = "Escolhido", tint = c.brand)
    }
}

/**
 * Como a tela está presa ao app, o que isso garante e, sem trava, como ligar a fixação de apps. Sem *device owner*, o
 * Android pede a confirmação de quem está diante do aparelho, e a fixação sai pelo gesto do sistema.
 */
@Composable
private fun LockCard(lock: DeviceLockState, canPin: Boolean, onPin: () -> Unit, onRelease: () -> Unit) {
    val c = Wb.colors
    WbCard(Modifier.padding(horizontal = 16.dp).testTag("device.lock")) {
        when (lock) {
            DeviceLockState.LOCKED -> {
                SettingsRow(
                    Icons.Filled.Lock,
                    "Modo quiosque ligado",
                    subtitle = "O Wabotia é o administrador deste aparelho: Início, Recentes e a barra do sistema não saem do app, e só o PIN de saída solta a tela.",
                    tint = c.ok,
                )
                RowDivider()
                SettingsRow(Icons.Filled.LockOpen, "Soltar a tela", subtitle = "Até voltar à tela do papel, que prende de novo", tint = c.muted, onClick = onRelease)
            }
            DeviceLockState.PINNED -> {
                SettingsRow(
                    Icons.Filled.Lock,
                    "Tela fixada",
                    subtitle = "Início e Recentes não saem do app. O Android ainda desafixa pelo gesto do sistema (tocar e segurar Voltar e Visão geral, ou deslizar de baixo para cima e segurar): ligue “Pedir PIN antes de liberar” na fixação de apps para esse gesto pedir o bloqueio de tela do aparelho.",
                    tint = c.ok,
                )
                RowDivider()
                SettingsRow(Icons.Filled.LockOpen, "Desafixar a tela", subtitle = "Até voltar à tela do papel, que pede para fixar de novo", tint = c.muted, onClick = onRelease)
            }
            DeviceLockState.NONE -> {
                SettingsRow(
                    Icons.Filled.LockOpen,
                    "Tela não fixada",
                    subtitle = "Quem está diante do aparelho sai pelo gesto de Início ou de Recentes, sem o PIN. Ao voltar à tela do papel, o Wabotia pede para fixar: toque em Fixar na pergunta do Android.",
                    tint = c.warn,
                )
                Text(
                    "Se o Android não perguntar, ligue a fixação de apps:\n" +
                        "• Samsung: Configurações → Segurança e privacidade → Mais configurações de segurança → Fixar apps (em versões antigas, Biometria e segurança → Outras configurações de segurança → Fixar janelas).\n" +
                        "• Outros Android: Configurações → Segurança (ou Segurança e privacidade) → Mais configurações de segurança → Fixação de app.\n" +
                        "Ligue também “Pedir PIN antes de liberar” (o aparelho precisa ter bloqueio de tela): sem ele, o gesto do sistema desafixa sem pedir nada.\n" +
                        "Modo quiosque, sem pergunta nem gesto: o Wabotia precisa ser o administrador do aparelho, uma configuração feita pelo suporte num aparelho zerado.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
                if (canPin) {
                    RowDivider()
                    SettingsRow(Icons.Filled.Lock, "Fixar agora", tint = c.brand, onClick = onPin)
                }
            }
        }
    }
}

@Composable
private fun PinCreateDialog(required: Boolean, onCreate: (String, String) -> String?, onClose: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (required) "Crie o PIN de saída" else "PIN de saída") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (required) Text("Para usar este aparelho como totem ou painel, crie antes o PIN de saída.")
                Text("Quem passa na frente do totem ou da TV não abre os ajustes sem o PIN.")
                PinInput("PIN (4 ou 6 números)", pin) { pin = it }
                PinInput("Repita o PIN", again) { again = it }
                error?.let { Text(it, color = Wb.colors.danger) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                error = onCreate(pin, again)
                if (error == null) onClose()
            }) { Text("Salvar") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancelar") } },
    )
}

@Composable
private fun PinInput(label: String, value: String, onChange: (String) -> Unit) =
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.filter(Char::isDigit).take(PanelPin.MAX_LENGTH)) },
        label = { Text(label) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
    )

@Composable
private fun UnlockDialog(error: String?, onUnlock: (String) -> Unit, onDismiss: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Digite o PIN") },
        text = {
            Column {
                PinInput("PIN", pin) { pin = it }
                error?.let { Text(it, color = Wb.colors.danger) }
            }
        },
        confirmButton = { TextButton(onClick = { onUnlock(pin) }) { Text("Entrar") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

// --- painel, totem e híbrido -------------------------------------------------------

@Composable
private fun PanelScreen(state: DeviceState, vm: DeviceViewModel, onSettings: () -> Unit) {
    val config = state.config ?: return
    val role = config.role ?: return
    KeepScreenOnEffect()
    ImmersiveEffect()
    if (role.panel) PanelVolumeKeysEffect()
    // A tela do papel prende o aparelho no app (AND-1): modo quiosque quando o app é o administrador do aparelho, sem
    // perguntar, a cada volta ao primeiro plano; senão, o pedido de fixação do Android, uma vez por entrada nesta tela
    // (quem recusou não é perguntado de novo a cada segundo). A demonstração não fixa: quem experimenta sai livre.
    val activity = LocalContext.current.findActivity()
    var lockRequested by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        val a = activity ?: return@LifecycleEventEffect
        if (state.demo) return@LifecycleEventEffect
        if (!lockRequested || DeviceLock.isDeviceOwner(a)) {
            lockRequested = true
            DeviceLock.enter(a)
        }
    }
    var unlocking by remember { mutableStateOf<(() -> Unit)?>(null) }
    fun guarded(action: () -> Unit) {
        if (state.pinSet) {
            vm.clearPinError()
            unlocking = action
        } else {
            action()
        }
    }
    // Voltar (gesto ou botão) também passa pelo PIN; Início e Recentes ficam por conta da fixação de tela.
    BackHandler { guarded(onSettings) }
    val runtime = state.overview?.toRuntime(config.name)
    PanelTheme(state.template) {
        val s = LocalPanelStyle.current
        Box(Modifier.fillMaxSize().background(s.bg).testTag("device.panel")) {
            BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                val base = (minOf(maxWidth, maxHeight) * 0.023f).coerceIn(11.dp, 30.dp)
                val landscape = maxWidth > maxHeight
                val compact = maxWidth < 600.dp
                CompositionLocalProvider(LocalPanelBase provides base) {
                    Column(Modifier.fillMaxSize()) {
                        PanelHeaderBar(
                            name = config.name,
                            role = if (state.demo) "Wabotia · demonstração" else "Wabotia",
                            title = if (role.panel) "Chamadas" else "Retire sua senha",
                            onBack = null,
                            compact = compact,
                        ) {
                            Text(
                                when {
                                    state.revoked -> "● desconectado"
                                    state.offline -> "● sem conexão"
                                    state.live || state.demo -> "● ao vivo"
                                    else -> "● conectando"
                                },
                                color = if (state.offline || state.revoked) MaterialTheme.colorScheme.error else s.headerFg,
                                modifier = Modifier.testTag("device.connection"),
                            )
                            // Aviso discreto para quem cuida do painel: o volume do alarme (o canal em que ele fala) está
                            // baixo demais para a recepção ouvir. Sobe com os botões de volume ou na engrenagem.
                            if (role.panel && state.soundEnabled) {
                                val alarm = rememberAlarmVolume()
                                if (alarm != null && alarm.first * 3 < alarm.second) {
                                    Text("  🔈 som baixo", color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("device.lowVolume"))
                                }
                            }
                            IconButton(onClick = { guarded(onSettings) }, modifier = Modifier.testTag("device.settings")) {
                                Icon(Icons.Outlined.Settings, contentDescription = "Ajustes deste aparelho")
                            }
                        }
                        Column(Modifier.fillMaxSize().padding(base * 0.9f), verticalArrangement = Arrangement.spacedBy(base * 0.7f)) {
                            if ((state.offline || state.revoked) && role.totem) {
                                OfflineNotice(
                                    if (state.revoked) "Este aparelho foi desconectado do Wabotia. Dirija-se ao balcão."
                                    else "Sem conexão com o Wabotia: o totem não emite senhas agora. Dirija-se ao balcão.",
                                )
                            } else {
                                state.notice?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("device.notice")) }
                            }
                            val body = Modifier.fillMaxWidth().weight(1f)
                            val issued = state.issued
                            val issuedCard: @Composable () -> Unit = {
                                if (issued != null) IssuedTicketCard(issued, state.print, config.name, vm::reprint, vm::clearIssued)
                            }
                            val blocked = state.busy || state.offline || state.revoked
                            when {
                                runtime == null ->
                                    Box(body, contentAlignment = Alignment.Center) { Text("Lendo a fila…", color = s.muted) }
                                issued != null && role.totem && !(role.panel && landscape) ->
                                    Column(body.verticalScroll(rememberScrollState())) { issuedCard() }
                                role == DeviceRole.HYBRID ->
                                    HybridBoard(runtime, blocked, { queueId, _ -> vm.chooseQueue(queueId) }, null, null, if (issued != null) issuedCard else null, body)
                                role == DeviceRole.TOTEM ->
                                    TotemBoard(runtime, blocked, { queueId, _ -> vm.chooseQueue(queueId) }, null, null, body)
                                else -> CallBoard(runtime.calls, null, null, body)
                            }
                        }
                    }
                }
            }
            if (role.panel) state.spotlight?.let { CallSpotlight(it) }
        }
    }
    state.choosing?.let { queue ->
        TypeChoiceDialog(
            queueName = queue.name,
            notice = queue.preferentialNotice,
            waitNormal = queue.waitMinutes?.normal,
            waitPreferential = queue.waitMinutes?.preferential,
            onChoose = vm::issue,
            onCancel = vm::cancelChoice,
        )
    }
    unlocking?.let { action ->
        UnlockDialog(
            error = state.pinError,
            onUnlock = { pin ->
                if (vm.unlock(pin)) {
                    unlocking = null
                    action()
                }
            },
            onDismiss = { unlocking = null },
        )
    }
}

@Composable
private fun OfflineNotice(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(12.dp).testTag("device.offline"),
    )
}

/** Normal ou Preferencial, com o aviso legal; some sozinho em 30 s. */
@Composable
private fun TypeChoiceDialog(
    queueName: String,
    notice: String?,
    waitNormal: Int?,
    waitPreferential: Int?,
    onChoose: (Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    LaunchedEffect(queueName) {
        delay(30_000)
        onCancel()
    }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("$queueName · qual senha?", fontSize = 26.sp) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Button(onClick = { onChoose(false) }, modifier = Modifier.fillMaxWidth().height(96.dp).testTag("choice.normal")) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Normal", fontSize = 28.sp, fontWeight = FontWeight.Bold)
                        waitNormal?.let { Text("cerca de $it min") }
                    }
                }
                OutlinedButton(onClick = { onChoose(true) }, modifier = Modifier.fillMaxWidth().height(96.dp).testTag("choice.preferential")) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Preferencial", fontSize = 28.sp, fontWeight = FontWeight.Bold)
                        waitPreferential?.let { Text("cerca de $it min") }
                    }
                }
                if (!notice.isNullOrBlank()) Text(notice, style = MaterialTheme.typography.bodyMedium)
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onCancel) { Text("Voltar") } },
    )
}

/** A senha recém-emitida: número grande, posição, situação do cupom e o QR do WhatsApp. */
@Composable
private fun IssuedTicketCard(
    ticket: QueueTicket,
    print: TicketPrint?,
    header: String,
    onReprint: (Boolean) -> Unit,
    onDone: () -> Unit,
) {
    val s = LocalPanelStyle.current
    val data = CouponData.of(ticket, header)
    var confirmReprint by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(8.dp).testTag("device.issued"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Sua senha · ${CouponText.type(data)}", color = s.muted, fontSize = 22.sp)
        Text(ticket.code, fontFamily = s.display, fontWeight = s.displayWeight, fontSize = 96.sp, color = s.fg, modifier = Modifier.testTag("device.issued.code"))
        Text(ticket.queueName.orEmpty(), color = s.fg, fontSize = 22.sp)
        Text(CouponText.position(data), color = s.fg, fontSize = 20.sp)
        Text(
            when (print) {
                TicketPrint.Printing -> "Imprimindo o cupom…"
                TicketPrint.Printed -> "Retire o cupom na impressora."
                TicketPrint.NoPrinter -> "Sem impressora: anote ou fotografe a senha."
                is TicketPrint.Failed -> "O cupom não saiu: ${print.message}"
                null -> ""
            },
            color = if (print is TicketPrint.Failed) MaterialTheme.colorScheme.error else s.muted,
            modifier = Modifier.testTag("device.issued.print"),
        )
        data.whatsappLink?.let { link ->
            QrMatrixImage(link, "QR para acompanhar a senha no WhatsApp", size = 180.dp)
            Text(CouponText.WHATSAPP, color = s.muted, textAlign = TextAlign.Center)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (print is TicketPrint.Failed) {
                OutlinedButton(onClick = { if (print.reprintNeedsConfirmation) confirmReprint = true else onReprint(false) }) { Text("Imprimir de novo") }
            }
            Button(onClick = onDone, modifier = Modifier.testTag("device.issued.done")) { Text("Pronto") }
        }
        Spacer(Modifier.height(8.dp))
    }
    if (confirmReprint) {
        AlertDialog(
            onDismissRequest = { confirmReprint = false },
            title = { Text("O cupom saiu?") },
            text = { Text("A impressora pode ter impresso sem confirmar. Imprima de novo só se nada saiu, para não haver dois papéis com a mesma senha.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmReprint = false
                    onReprint(true)
                }) { Text("Nada saiu, imprimir") }
            },
            dismissButton = { TextButton(onClick = { confirmReprint = false }) { Text("Saiu, cancelar") } },
        )
    }
}

/** Textos do modo aparelho que dependem do servidor, sem Compose, para testar. */
object DeviceTexts {
    /**
     * O aviso do QR do WhatsApp para quem configura: só no Totem e no Painel híbrido (o Painel de chamadas não
     * imprime), só quando o servidor diz que o QR não sai, com o texto que ele manda.
     */
    fun qrNotice(prints: Boolean, coupon: br.com.queven.wabotia.queue.QueueCoupon?): String? {
        if (!prints || coupon == null) return null
        val notice = coupon.whatsappQrNotice?.trim()?.takeIf { it.isNotEmpty() }
        return when {
            notice != null -> notice
            coupon.whatsappQrIssue != null -> "O QR do WhatsApp não sai no cupom. Veja em Filas e guichês → Cupom da senha, no painel."
            else -> null
        }
    }
}
