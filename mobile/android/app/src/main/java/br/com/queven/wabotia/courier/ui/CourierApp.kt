package br.com.queven.wabotia.courier.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Geocoder
import android.net.Uri
import android.os.BatteryManager
import android.os.Looper
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Directions
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.TwoWheeler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import br.com.queven.wabotia.courier.CourierConfirm
import br.com.queven.wabotia.courier.CourierDelivery
import br.com.queven.wabotia.courier.CourierLinks
import br.com.queven.wabotia.courier.CourierMessage
import br.com.queven.wabotia.courier.CourierParty
import br.com.queven.wabotia.courier.CourierTexts
import br.com.queven.wabotia.courier.CourierViewModel
import br.com.queven.wabotia.courier.DemoCourierBackend
import br.com.queven.wabotia.courier.LatLng
import br.com.queven.wabotia.courier.PositionPoint
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * O modo entregador: escanear o pedido, a lista quando há mais de uma entrega, e a tela da entrega com destino, rota,
 * previsão, conversa com a loja e com o cliente, Iniciar rota, Entreguei e Não consegui entregar. Sem entregas depois de
 * ter tido alguma (acesso revogado ou tudo concluído), [onExit] leva de volta à primeira tela do app.
 */
@Composable
fun CourierApp(vm: CourierViewModel, demo: Boolean, onExit: () -> Unit) {
    val state by vm.state.collectAsState()
    val c = Wb.colors
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var located by remember { mutableStateOf(hasLocation(context)) }

    LaunchedEffect(state.notice) {
        val msg = state.notice ?: return@LaunchedEffect
        vm.consumeNotice()
        snackbar.showSnackbar(msg)
    }
    LaunchedEffect(state.ended) {
        if (state.ended) {
            delay(1800) // deixa ler "Pedido nº 12 entregue"
            onExit()
        }
    }
    LaunchedEffect(state.deliveries.size) { if (state.deliveries.isNotEmpty()) scanning = false }

    // A posição só é lida e enviada com a tela em uso (ciclo de vida STARTED), e só com alguma entrega a caminho.
    val enRoute = state.deliveries.any { it.enRoute }
    CourierLocationEffect(vm, enabled = located && enRoute)
    CourierUploadEffect(vm, active = enRoute)

    val showScanner = scanning || (state.deliveries.isEmpty() && !state.restoring && !state.ended)
    val open = state.deliveries.firstOrNull { it.id == state.open } ?: state.deliveries.singleOrNull()

    BackHandler(enabled = scanning && state.deliveries.isNotEmpty()) { scanning = false }
    BackHandler(enabled = !scanning && state.open != null && state.deliveries.size > 1) { vm.open(null) }

    Scaffold(containerColor = c.background, contentWindowInsets = WindowInsets(0, 0, 0, 0), snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when {
                state.restoring -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                state.ended && state.deliveries.isEmpty() -> EmptyState(Icons.Filled.CheckCircle, "Entregas encerradas", subtitle = "O acesso às entregas terminou. Voltando à tela inicial…")
                showScanner -> ScanScreen(
                    demo = demo,
                    claiming = state.claiming || state.confirm != null,
                    canGoBack = state.deliveries.isNotEmpty(),
                    onBack = { if (state.deliveries.isNotEmpty()) scanning = false else onExit() },
                    onCode = vm::scanned,
                )
                state.open == null && state.deliveries.size > 1 -> DeliveryList(state.deliveries, onOpen = vm::open, onScan = { scanning = true }, onExit = onExit)
                open != null -> DeliveryScreen(
                    vm = vm,
                    delivery = open,
                    demo = demo,
                    located = located,
                    lastFixAt = state.lastFixAt,
                    messages = state.messages[open.id].orEmpty(),
                    customerOpen = state.customerOpen[open.id] ?: false,
                    sending = state.sending,
                    busy = state.busy == open.id,
                    // Com uma entrega só, voltar sai do modo entregador; a entrega continua e o app reabre nela.
                    onBack = if (state.deliveries.size > 1) ({ vm.open(null) }) else onExit,
                    onScan = { scanning = true },
                    onLocationGranted = { located = hasLocation(context) },
                )
            }
        }
    }

    state.confirm?.let { ConfirmStoreDialog(it, onContinue = vm::confirmContinue, onCancel = vm::cancelConfirm) }
    state.pendingLink?.let { NameDialog(initial = state.name.orEmpty(), onConfirm = vm::claimWithName, onDismiss = vm::dismissName) }
}

/**
 * Antes de gastar o código: a loja (lida sem gastar o QR) e o servidor do QR, para o entregador conferir que é a loja
 * certa. Continuar troca o código; Cancelar não gasta nada.
 */
@Composable
private fun ConfirmStoreDialog(confirm: CourierConfirm, onContinue: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        icon = { Icon(Icons.Filled.Storefront, contentDescription = null, tint = Wb.colors.brand) },
        title = { Text(if (confirm.loading) "Lendo o pedido…" else "Entrega da loja ${confirm.store ?: confirm.link.host}") },
        text = {
            Column {
                if (confirm.loading) {
                    CircularProgressIndicator(color = Wb.colors.brand)
                } else {
                    Text(CourierTexts.confirmBody(confirm.store, confirm.link.host), style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = { TextButton(onClick = onContinue, enabled = !confirm.loading, modifier = Modifier.testTag("courier.continue")) { Text("Continuar", fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancelar") } },
    )
}

/** O servidor exige o nome na troca do QR: o cliente vê "Carlos - Entregador" nas mensagens. Pergunta uma vez só. */
@Composable
private fun NameDialog(initial: String, onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Filled.TwoWheeler, contentDescription = null, tint = Wb.colors.brand) },
        title = { Text("Seu nome") },
        text = {
            Column {
                Text(CourierTexts.NAME_HELP, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(60) },
                    singleLine = true,
                    label = { Text("Nome") },
                    modifier = Modifier.fillMaxWidth().testTag("courier.name"),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (name.trim().length >= 2) onConfirm(name) }),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(name) }, enabled = name.trim().length >= 2) { Text("Continuar", fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

// --- escanear -------------------------------------------------------------------------------------------------------

@Composable
private fun ScanScreen(
    demo: Boolean,
    claiming: Boolean,
    canGoBack: Boolean,
    onBack: () -> Unit,
    onCode: (String) -> Unit,
) {
    val c = Wb.colors
    val context = LocalContext.current
    var camera by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var asked by rememberSaveable { mutableStateOf(false) }
    var typed by rememberSaveable { mutableStateOf("") }
    // A câmera lê o mesmo QR várias vezes por segundo: cada texto vai uma vez só.
    var last by remember { mutableStateOf<String?>(null) }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it }
    LaunchedEffect(Unit) {
        // Na demonstração não pede a câmera: os botões dos pedidos fictícios bastam (e o revisor da loja não tem o QR).
        if (!camera && !asked && !demo) {
            asked = true
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }
    Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        DetailTopBar(if (canGoBack) "Escanear outro pedido" else "Escanear pedido", onBack = onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item("help") {
                Text(
                    "Aponte a câmera para o QR do pedido que a loja entregou. O acesso vale só para esta entrega e termina quando ela é concluída.",
                    color = c.textSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            item("camera") {
                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp)).background(c.surface), contentAlignment = Alignment.Center) {
                    when {
                        claiming -> CircularProgressIndicator(color = c.brand)
                        camera && !demo -> QrScanner(onCode = { raw -> if (!claiming && raw != last) { last = raw; onCode(raw) } }, modifier = Modifier.fillMaxSize())
                        demo -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                            Icon(Icons.Filled.QrCodeScanner, contentDescription = null, tint = c.muted, modifier = Modifier.size(64.dp))
                            Spacer(Modifier.height(8.dp))
                            Text("Na demonstração não há câmera: use Simular leitura abaixo.", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
                        }
                        else -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                            Text("Sem acesso à câmera. Libere para ler o QR, ou cole o link abaixo.", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { askCamera.launch(Manifest.permission.CAMERA) }) { Text("Liberar a câmera") }
                        }
                    }
                }
            }
            if (demo) {
                // Duas lojas diferentes, cada uma no próprio servidor: o mesmo caminho da câmera, com o texto do QR.
                item("demo-label") { SectionLabel("Simular leitura") }
                item("demo") {
                    WbCard {
                        DemoCourierBackend.QRS.forEachIndexed { i, qr ->
                            if (i > 0) RowDivider()
                            SettingsRow(
                                Icons.Filled.QrCodeScanner,
                                "Simular leitura · ${DemoCourierBackend.storeOf(i)}",
                                subtitle = qr.removePrefix("https://").substringBefore('/'),
                                enabled = !claiming,
                                onClick = { onCode(qr) },
                                modifier = Modifier.testTag("courier.simulate.$i"),
                            )
                        }
                    }
                }
            }
            item("typed") {
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    modifier = Modifier.fillMaxWidth().testTag("courier.code"),
                    singleLine = true,
                    label = { Text("Ou cole o link do pedido") },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { onCode(typed) }),
                )
            }
            item("go") { PrimaryButton("Abrir pedido", onClick = { onCode(typed) }, enabled = typed.isNotBlank() && !claiming, loading = claiming) }
        }
    }
}

// --- lista --------------------------------------------------------------------------------------------------------

@Composable
private fun DeliveryList(deliveries: List<CourierDelivery>, onOpen: (String) -> Unit, onScan: () -> Unit, onExit: () -> Unit) {
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        DetailTopBar("Minhas entregas", onBack = onExit, subtitle = "${deliveries.size} em andamento")
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            deliveries.forEach { d ->
                item(d.id) {
                    WbCard(onClick = { onOpen(d.id) }) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(d.label, style = MaterialTheme.typography.titleMedium, color = Wb.colors.textPrimary, modifier = Modifier.weight(1f))
                                (CourierTexts.eta(d) ?: d.statusLabel)?.let { Pill(it, if (d.enRoute) Wb.colors.ok else Wb.colors.warn) }
                            }
                            Text(listOfNotNull(d.store, d.customerName.ifBlank { null }).joinToString(" · "), color = Wb.colors.textSecondary, style = MaterialTheme.typography.bodyMedium)
                            Text(d.address.lines().firstOrNull().orEmpty(), color = Wb.colors.textSecondary, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
        SecondaryButton("Escanear outro pedido", onClick = onScan, icon = Icons.Filled.QrCodeScanner, modifier = Modifier.padding(16.dp))
    }
}

// --- entrega ------------------------------------------------------------------------------------------------------

@Composable
private fun DeliveryScreen(
    vm: CourierViewModel,
    delivery: CourierDelivery,
    demo: Boolean,
    located: Boolean,
    lastFixAt: Long?,
    messages: List<CourierMessage>,
    customerOpen: Boolean,
    sending: Boolean,
    busy: Boolean,
    onBack: () -> Unit,
    onScan: () -> Unit,
    onLocationGranted: () -> Unit,
) {
    val c = Wb.colors
    val context = LocalContext.current
    var party by rememberSaveable(delivery.id) { mutableStateOf(CourierParty.CUSTOMER) }
    var draft by rememberSaveable(delivery.id) { mutableStateOf("") }
    var consent by remember { mutableStateOf(false) }
    var startAfterConsent by remember { mutableStateOf(false) }
    var confirmDone by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    // Na demonstração o endereço é fictício: não geocodifica (o servidor de exemplo põe o destino perto de você).
    val geocode: suspend (String) -> LatLng? = { address -> if (demo) null else geocode(context, address) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        onLocationGranted()
        if (startAfterConsent) {
            startAfterConsent = false
            vm.start(delivery.id, geocode)
        }
    }

    // A conversa é sondada a cada 15 s enquanto a tela da entrega está à vista (sem WebSocket nesta versão).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(delivery.id, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                vm.refreshMessages(delivery.id)
                delay(15_000)
            }
        }
    }

    Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        DetailTopBar(delivery.label, onBack = onBack, subtitle = listOfNotNull(delivery.store, delivery.statusLabel).joinToString(" · ").ifBlank { null }) {
            IconButton(onClick = onScan) { Icon(Icons.Filled.QrCodeScanner, contentDescription = "Escanear outro pedido", tint = c.textPrimary) }
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item("sharing") {
                when {
                    !delivery.enRoute -> InlineNotice("Toque em Iniciar rota quando sair com o pedido. A loja e o cliente passam a ver a previsão de chegada.", color = c.ticket)
                    located -> InlineNotice(
                        CourierTexts.sharing(delivery) + (lastFixAt?.let { " · última posição às ${clock(it)}" } ?: " · procurando o GPS…"),
                        color = c.ok,
                    )
                    else -> InlineNotice(
                        "A loja e o cliente não veem onde você está. Ative a localização para mandar a previsão de chegada.",
                        color = c.warn,
                        actionLabel = "Ativar",
                        onAction = { consent = true },
                    )
                }
            }
            item("destination") {
                WbCard {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.LocationOn, contentDescription = null, tint = c.brand)
                            Spacer(Modifier.size(8.dp))
                            Text(delivery.customerName.ifBlank { "Cliente" }, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, modifier = Modifier.weight(1f))
                            CourierTexts.eta(delivery)?.let { Pill(it, c.ok) }
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(delivery.address, style = MaterialTheme.typography.bodyLarge, color = c.textPrimary)
                        delivery.order?.customerNote?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.warn) }
                        Spacer(Modifier.height(12.dp))
                        SecondaryButton("Abrir a rota no mapa", onClick = { openRoute(context, delivery) }, icon = Icons.Filled.Directions)
                    }
                }
            }
            if (delivery.items.isNotEmpty() || delivery.paymentText != null) item("order") {
                WbCard {
                    Column(Modifier.padding(16.dp)) {
                        delivery.items.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary) }
                        delivery.paymentText?.let { Spacer(Modifier.height(6.dp)); Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary) }
                        delivery.changeText?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.textPrimary) }
                    }
                }
            }
            item("chat-tabs") {
                SegmentedTabs(listOf(CourierParty.CUSTOMER to "Conversa com cliente", CourierParty.STORE to "Conversa com loja"), party, { party = it })
            }
            if (party == CourierParty.CUSTOMER && !customerOpen) item("closed") {
                InlineNotice(CourierTexts.CUSTOMER_CLOSED, color = c.warn, actionLabel = "Falar com a loja", onAction = { party = CourierParty.STORE })
            }
            val list = messages.filter { it.channel == party.wire }
            if (list.isEmpty()) item("chat-empty") {
                Text("Nenhuma mensagem ainda.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
            list.takeLast(40).forEach { m ->
                item("m-${m.seq}") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (m.mine) Arrangement.End else Arrangement.Start) {
                        Column(
                            Modifier
                                .widthIn(max = 300.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(if (m.mine) c.soft(c.brand, 0.18f) else c.surface)
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        ) {
                            if (!m.mine && m.authorName.isNotBlank()) Text(m.authorName, color = c.textSecondary, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
                            Text(m.text, color = c.textPrimary, style = MaterialTheme.typography.bodyMedium)
                            Text(clock(m.created), color = c.textSecondary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
        val canWrite = party == CourierParty.STORE || customerOpen
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it.take(1000) },
                modifier = Modifier.weight(1f).testTag("courier.message"),
                enabled = canWrite,
                placeholder = { Text(if (party == CourierParty.STORE) "Mensagem para a loja" else "Mensagem para o cliente") },
                maxLines = 3,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { vm.send(delivery.id, party, draft); draft = "" }),
            )
            IconButton(onClick = { vm.send(delivery.id, party, draft); draft = "" }, enabled = canWrite && draft.isNotBlank() && !sending) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Enviar", tint = c.brand)
            }
        }
        if (!delivery.enRoute) {
            PrimaryButton(
                "Iniciar rota",
                onClick = {
                    // Aviso em destaque antes da permissão; sem ela a rota começa assim mesmo, só sem a previsão.
                    if (hasLocation(context)) vm.start(delivery.id, geocode) else { startAfterConsent = true; consent = true }
                },
                loading = busy,
                icon = Icons.Filled.TwoWheeler,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp).testTag("courier.start"),
            )
        } else {
            PrimaryButton(
                "Entreguei",
                onClick = { confirmDone = true },
                loading = busy,
                icon = Icons.Filled.CheckCircle,
                color = c.ok,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp).testTag("courier.delivered"),
            )
            TextButton(onClick = { cancelling = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                Text("Não consegui entregar", color = c.danger)
            }
        }
    }

    if (consent) {
        // Aviso em destaque antes da permissão (Política de Dados do Usuário do Google Play; LGPD).
        AlertDialog(
            onDismissRequest = { consent = false; if (startAfterConsent) { startAfterConsent = false; vm.start(delivery.id, geocode) } },
            icon = { Icon(Icons.Filled.LocationOn, contentDescription = null, tint = c.brand) },
            title = { Text("Compartilhar sua localização") },
            text = { Text(CourierTexts.CONSENT) },
            confirmButton = {
                TextButton(onClick = {
                    consent = false
                    askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }) { Text("Continuar", fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = {
                TextButton(onClick = {
                    consent = false
                    if (startAfterConsent) { startAfterConsent = false; vm.start(delivery.id, geocode) }
                }) { Text("Agora não") }
            },
        )
    }
    if (confirmDone) {
        AlertDialog(
            onDismissRequest = { confirmDone = false },
            title = { Text("Entregou ${delivery.label}?") },
            text = { Text("A loja e o cliente recebem o aviso, a localização para de ser enviada e o acesso a esta entrega termina.") },
            confirmButton = { TextButton(onClick = { confirmDone = false; vm.delivered(delivery.id, battery(context)) }) { Text("Entreguei", fontWeight = FontWeight.SemiBold, color = c.ok) } },
            dismissButton = { TextButton(onClick = { confirmDone = false }) { Text("Ainda não") } },
        )
    }
    if (cancelling) {
        var reason by rememberSaveable { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { cancelling = false },
            title = { Text("Não conseguiu entregar?") },
            text = {
                Column {
                    Text("A loja recebe o motivo e decide o que fazer com o pedido. O acesso a esta entrega termina.", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(value = reason, onValueChange = { reason = it.take(300) }, label = { Text("Motivo") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                }
            },
            confirmButton = { TextButton(onClick = { cancelling = false; vm.cancel(delivery.id, reason) }, enabled = reason.isNotBlank()) { Text("Avisar a loja", fontWeight = FontWeight.SemiBold, color = c.danger) } },
            dismissButton = { TextButton(onClick = { cancelling = false }) { Text("Voltar") } },
        )
    }
}

// --- localização e envio, presos à tela -----------------------------------------------------------------------------

/**
 * Lê o GPS só enquanto a tela está em uso (STARTED). Equilíbrio entre precisão e bateria longe do destino, alta
 * precisão perto; 25 m de distância mínima entre leituras. Sem `ACCESS_BACKGROUND_LOCATION` e sem serviço em primeiro
 * plano: tela apagada ou app no fundo, a leitura para.
 */
@SuppressLint("MissingPermission")
@Composable
private fun CourierLocationEffect(vm: CourierViewModel, enabled: Boolean) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var near by remember { mutableStateOf(vm.isNear) }
    LaunchedEffect(enabled) {
        while (enabled) {
            near = vm.isNear
            delay(10_000)
        }
    }
    DisposableEffect(enabled, near, lifecycle) {
        if (!enabled || !hasLocation(context)) return@DisposableEffect onDispose { }
        val client = LocationServices.getFusedLocationProviderClient(context)
        val request = LocationRequest.Builder(
            if (near) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY,
            vm.sampleMillis(battery(context)),
        ).setMinUpdateDistanceMeters(25f).build()
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.locations.forEach { l ->
                    vm.onLocation(PositionPoint(l.time, l.latitude, l.longitude, if (l.hasAccuracy()) l.accuracy else null, if (l.hasSpeed()) l.speed else null))
                }
            }
        }
        var requesting = false
        val observer = androidx.lifecycle.LifecycleEventObserver { _, _ ->
            val visible = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            if (visible && !requesting) {
                runCatching { client.requestLocationUpdates(request, callback, Looper.getMainLooper()) }
                requesting = true
            } else if (!visible && requesting) {
                client.removeLocationUpdates(callback)
                requesting = false
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            if (requesting) client.removeLocationUpdates(callback)
        }
    }
}

/**
 * Manda os lotes no ritmo do servidor enquanto a tela está em uso. Ao sair da tela, manda o que está na fila (o
 * contrato pede) e para; sem rede, a fila guarda.
 */
@Composable
private fun CourierUploadEffect(vm: CourierViewModel, active: Boolean) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(active, lifecycle) {
        if (!active) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                while (isActive) {
                    delay(vm.uploadMillis(battery(context)))
                    vm.flush(battery(context))
                }
            } finally {
                // Indo para segundo plano: o último lote sai antes de o GPS parar.
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { runCatching { vm.flush(battery(context)) } }
            }
        }
    }
}

/** O destino pelo endereço, no próprio aparelho (gratuito). Sem Geocoder (aparelho sem serviços do Google): null. */
@Suppress("DEPRECATION")
private suspend fun geocode(context: Context, address: String): LatLng? = withContext(Dispatchers.IO) {
    if (!Geocoder.isPresent()) return@withContext null
    runCatching {
        Geocoder(context, java.util.Locale.forLanguageTag("pt-BR")).getFromLocationName(address.replace('\n', ' '), 1)
            ?.firstOrNull()?.let { LatLng(it.latitude, it.longitude) }
    }.getOrNull()
}

private fun hasLocation(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

private fun battery(context: Context): Int? =
    (context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager)?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }

private val HOUR = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("America/Sao_Paulo"))

private fun clock(at: Long) = HOUR.format(Instant.ofEpochMilli(at))

/** A rota no app de mapas do aparelho: com coordenadas, navegação; sem elas, a busca pelo endereço. */
private fun openRoute(context: Context, d: CourierDelivery) {
    val byAddress = Uri.parse("geo:0,0?q=" + Uri.encode(d.address.replace('\n', ' ')))
    val uri = d.destination?.let { Uri.parse("google.navigation:q=${it.lat},${it.lng}") } ?: byAddress
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, byAddress).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}
