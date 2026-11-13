@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package br.com.queven.wabotia.ui.conversations

import android.Manifest
import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.media.DeviceInputs
import br.com.queven.wabotia.core.media.MediaKinds
import br.com.queven.wabotia.core.media.PickContactPhone
import br.com.queven.wabotia.core.media.MediaUploader
import br.com.queven.wabotia.core.media.VoiceRecorder
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RoundIconButton
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WindowInfo
import br.com.queven.wabotia.ui.components.formatClock
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale

/**
 * Composer da conversa (DESIGN.md §5): campo arredondado "Mensagem", **+** à esquerda (folha de anexos), câmera dentro do
 * campo e botão redondo `brand` que é microfone com o campo vazio e enviar com texto. Mantém tudo o que já existia:
 * galeria, câmera, arquivo, gravação de voz com prévia, localização, contato, menções em grupo, "enviar como documento",
 * progresso de upload, resposta citada, edição e pedido pendente (mesma Idempotency-Key).
 */
@Composable
internal fun Composer(
    vm: ConversationViewModel,
    container: AppContainer,
    detail: ConversationDetail,
    window: WindowInfo?,
    openAttachInitially: Boolean,
    onMenu: () -> Unit,
    onTicket: () -> Unit,
    onNote: () -> Unit,
) {
    val context = LocalContext.current
    val c = Wb.colors
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val conversation = detail.conversation
    val canVoice = detail.can("voice") || detail.can("audio")
    val members = remember(detail.group) { detail.groupMembers() }
    val locked = vm.sending || vm.pending != null

    // --- gravação de voz ---
    val recorder = remember { VoiceRecorder(context) }
    var recording by remember { mutableStateOf(false) }
    var seconds by remember { mutableIntStateOf(0) }
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    fun stopRecording(): Boolean {
        if (!recording) return false
        recording = false
        haptics.tick()
        val file = recorder.stop()
        return if (file != null && file.length() > 0) {
            vm.attachVoice(PendingAttachment.fromFile(file, recorder.mime, recorder.contentType, "Mensagem de voz"))
            true
        } else {
            vm.composerError = "A gravação ficou vazia. Grave um pouco mais antes de parar."
            false
        }
    }

    fun cancelRecording() {
        recording = false
        recorder.cancel()
        haptics.tick()
    }

    fun startRecording() {
        try {
            recorder.start()
            recording = true
            vm.composerError = null
            haptics.tick()
        } catch (e: Exception) {
            vm.composerError = "Não foi possível iniciar a gravação. Confira se outro app está usando o microfone."
        }
    }

    LaunchedEffect(recording) {
        if (recording) {
            seconds = 0
            while (recording) {
                delay(1000)
                seconds++
                if (seconds >= 120) stopRecording()
            }
        }
    }

    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else vm.composerError = "Permita o microfone nas configurações para gravar áudio."
    }

    fun requestRecord() {
        if (DeviceInputs.hasPermission(context, Manifest.permission.RECORD_AUDIO)) startRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    // --- anexos ---
    fun addUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val items = withContext(Dispatchers.IO) { uris.mapNotNull { MediaUploader.readUploadItem(context, it) } }
            if (items.size < uris.size) vm.composerError = "Alguns arquivos não puderam ser lidos."
            vm.addAttachments(items.map { PendingAttachment(it) })
        }
    }

    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MediaKinds.MAX_ATTACHMENTS)) { addUris(it) }
    val pickDocuments = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { addUris(it) }

    var cameraPath by rememberSaveable { mutableStateOf<String?>(null) }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = cameraPath
        cameraPath = null
        if (path != null) {
            val file = File(path)
            if (ok && file.exists() && file.length() > 0) {
                vm.addAttachments(listOf(PendingAttachment.fromFile(file, "image/jpeg", null, file.name)))
            } else {
                file.delete()
            }
        }
    }

    fun openCamera() {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "foto-${System.currentTimeMillis()}.jpg")
        cameraPath = file.absolutePath
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        try {
            takePicture.launch(uri)
        } catch (e: Exception) {
            cameraPath = null
            vm.composerError = "Nenhum aplicativo de câmera disponível."
        }
    }

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) openCamera() else vm.composerError = "Permita a câmera nas configurações para tirar fotos."
    }

    fun requestCamera() {
        if (DeviceInputs.hasPermission(context, Manifest.permission.CAMERA)) openCamera() else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    // --- localização ---
    var locating by remember { mutableStateOf(false) }

    fun fetchLocation() {
        if (locating) return
        locating = true
        scope.launch {
            val location = DeviceInputs.currentLocation(context)
            locating = false
            if (location == null) {
                vm.composerError = "Não foi possível obter a posição do aparelho. Informe as coordenadas manualmente."
            } else {
                vm.location = vm.location.copy(
                    latitude = String.format(Locale.US, "%.6f", location.latitude),
                    longitude = String.format(Locale.US, "%.6f", location.longitude),
                )
            }
        }
    }

    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.any { it }) fetchLocation() else vm.composerError = "Sem permissão de localização. Informe as coordenadas manualmente."
    }

    fun requestLocation() {
        vm.kind = ComposeKind.Location
        if (DeviceInputs.hasLocationPermission(context)) fetchLocation()
        else locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    // --- contato ---
    // Seletor do sistema: devolve só o número escolhido, sem permissão de leitura da agenda.
    val pickContact = rememberLauncherForActivityResult(PickContactPhone()) { uri ->
        if (uri != null) {
            scope.launch {
                val picked = DeviceInputs.readContact(context, uri)
                if (picked == null) vm.composerError = "Não foi possível ler o contato. Informe nome e telefone manualmente."
                else vm.contact = ContactDraft(name = picked.first, phone = picked.second)
            }
        }
    }

    fun requestContact() {
        vm.kind = ComposeKind.Contacts
        try {
            pickContact.launch(Unit)
        } catch (e: ActivityNotFoundException) {
            vm.composerError = "Nenhum aplicativo de contatos disponível. Informe nome e telefone manualmente."
        }
    }

    var attachSheet by rememberSaveable { mutableStateOf(openAttachInitially) }
    var mentionSheet by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 6.dp, end = 6.dp, top = 4.dp, bottom = 6.dp)) {
        // Aviso de janela fechada: o envio continua permitido (o servidor guarda e entrega quando a janela reabrir).
        if (window != null && window.closed) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 3.dp).clip(RoundedCornerShape(12.dp)).background(c.bubbleSystem).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = c.muted, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(10.dp))
                Text("Fora da janela de 24h. A mensagem fica na fila até o cliente escrever.", color = c.textSecondary, fontSize = 12.5.sp, lineHeight = 16.sp)
            }
        }
        vm.composerError?.let { InlineNotice(it, Modifier.padding(horizontal = 2.dp, vertical = 3.dp), onDismiss = { vm.composerError = null }) }
        vm.pending?.let {
            Column(Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 3.dp).clip(RoundedCornerShape(14.dp)).background(c.soft(c.warn, 0.16f)).padding(12.dp)) {
                Text("O envio não foi confirmado. O pedido está guardado para uma nova tentativa segura, sem duplicar a mensagem.", color = c.textPrimary, fontSize = 13.sp, lineHeight = 17.sp)
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    PrimaryButton("Tentar novamente", onClick = { vm.send() }, modifier = Modifier.weight(1f), loading = vm.sending)
                    Spacer(Modifier.width(8.dp))
                    TextButton(onClick = { vm.abandonPending() }, enabled = !vm.sending) { Text("Abandonar pedido", color = c.textSecondary) }
                }
            }
        }
        vm.progress?.let { label ->
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 3.dp)) {
                Text(label, color = c.textSecondary, fontSize = 12.sp)
                val pct = vm.progressPercent
                if (pct != null) LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 3.dp).clip(CircleShape), color = c.brand, trackColor = c.field)
                else LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(top = 3.dp).clip(CircleShape), color = c.brand, trackColor = c.field)
            }
        }
        if (vm.attachments.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 3.dp).clip(RoundedCornerShape(14.dp)).background(composerSurface()).padding(vertical = 4.dp)) {
                vm.attachments.forEach { attachment ->
                    AttachmentPreviewRow(attachment, document = vm.kind == ComposeKind.Document, enabled = !locked) { vm.removeAttachment(attachment.key) }
                }
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !locked, role = Role.Checkbox) {
                        vm.kind = if (vm.kind == ComposeKind.Document) ComposeKind.Auto else ComposeKind.Document
                    }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val on = vm.kind == ComposeKind.Document
                    Box(Modifier.size(20.dp).clip(RoundedCornerShape(6.dp)).background(if (on) c.brand else c.field), contentAlignment = Alignment.Center) {
                        if (on) Icon(Icons.Filled.Check, contentDescription = null, tint = c.onBrand, modifier = Modifier.size(15.dp))
                    }
                    Spacer(Modifier.width(10.dp))
                    Text("Enviar como documento", color = c.textPrimary, fontSize = 13.5.sp)
                }
            }
        }
        vm.voice?.let { voice ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 3.dp).clip(RoundedCornerShape(26.dp)).background(composerSurface()).padding(start = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AudioPlayerBar(uri = voice.item.source.localUri().toString(), container = container, modifier = Modifier.weight(1f), seed = voice.key, voice = voice.contentType == "voice")
                IconButton(onClick = { vm.clearVoice() }, enabled = !locked) { Icon(Icons.Filled.Delete, contentDescription = "Descartar gravação", tint = c.danger) }
            }
        }
        if (vm.kind == ComposeKind.Location) {
            LocationFields(vm, locating = locating, enabled = !locked, onUseDevice = { requestLocation() }, onRemove = { vm.kind = ComposeKind.Auto })
        }
        if (vm.kind == ComposeKind.Contacts) {
            ContactFields(vm, enabled = !locked, onPick = { requestContact() }, onRemove = { vm.kind = ComposeKind.Auto })
        }
        if (vm.mentions.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.AlternateEmail, contentDescription = "Menções", modifier = Modifier.size(16.dp), tint = c.textSecondary)
                vm.mentions.forEach { member ->
                    Row(
                        Modifier.clip(CircleShape).background(composerSurface()).clickable(enabled = !locked) { vm.removeMention(member.id) }.padding(start = 10.dp, end = 6.dp, top = 5.dp, bottom = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(member.display, color = c.textPrimary, fontSize = 13.sp, maxLines = 1)
                        Spacer(Modifier.width(4.dp))
                        Icon(Icons.Filled.Close, contentDescription = "Remover menção a ${member.display}", tint = c.textSecondary, modifier = Modifier.size(15.dp))
                    }
                }
            }
        }

        if (recording) {
            RecordingBar(
                seconds = seconds,
                onDiscard = { cancelRecording() },
                onStop = { stopRecording() },
                onSend = { if (stopRecording()) vm.send() },
            )
            return@Column
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f).clip(RoundedCornerShape(24.dp)).background(composerSurface())) {
                vm.quote?.let { quoted ->
                    DraftStrip(
                        icon = null,
                        label = if (quoted.isIncoming) conversation.displayName else "Você",
                        text = quoted.text.ifBlank { "Anexo" },
                        onCancel = { vm.quote = null },
                    )
                }
                vm.editing?.let {
                    DraftStrip(icon = Icons.Filled.Edit, label = "Editando mensagem", text = "Limite de 15 minutos após o envio.", onCancel = { vm.cancelEdit() })
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    IconButton(onClick = { attachSheet = true }, enabled = !locked && vm.editing == null, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Filled.Add, contentDescription = "Anexar ou escolher conteúdo", tint = c.textSecondary, modifier = Modifier.size(26.dp))
                    }
                    Box(Modifier.weight(1f).heightIn(min = 48.dp).padding(vertical = 13.dp), contentAlignment = Alignment.CenterStart) {
                        if (vm.text.isEmpty()) {
                            Text(if (vm.editing != null) "Novo texto da mensagem" else "Mensagem", color = c.textSecondary, fontSize = 16.5.sp, maxLines = 1)
                        }
                        BasicTextField(
                            value = vm.text,
                            onValueChange = { vm.text = it },
                            enabled = !locked,
                            maxLines = 6,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.textPrimary, fontSize = 16.5.sp, lineHeight = 22.sp),
                            cursorBrush = SolidColor(c.brand),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (vm.text.isEmpty() && vm.editing == null && detail.can("image")) {
                        IconButton(onClick = { requestCamera() }, enabled = !locked, modifier = Modifier.size(48.dp)) {
                            Icon(Icons.Filled.PhotoCamera, contentDescription = "Tirar foto", tint = c.textSecondary)
                        }
                    } else {
                        Spacer(Modifier.width(12.dp))
                    }
                }
                if (vm.text.length > MediaKinds.MAX_TEXT) {
                    Text("${vm.text.length}/${MediaKinds.MAX_TEXT} caracteres", color = c.danger, fontSize = 12.sp, modifier = Modifier.padding(start = 16.dp, bottom = 6.dp))
                }
            }
            Spacer(Modifier.width(6.dp))
            val showMic = canVoice && vm.editing == null && vm.text.isBlank() && vm.attachments.isEmpty() && vm.voice == null &&
                vm.kind != ComposeKind.Location && vm.kind != ComposeKind.Contacts && vm.pending == null
            if (showMic) {
                RoundIconButton(Icons.Filled.Mic, "Gravar áudio", onClick = { requestRecord() }, size = 48.dp, color = c.brand, contentColor = c.onBrand, enabled = !vm.sending)
            } else {
                Box(
                    Modifier.size(48.dp).clip(CircleShape).background(if (vm.canSend) c.brand else c.field).clickable(enabled = vm.canSend, role = Role.Button) {
                        haptics.tick()
                        vm.send()
                    },
                    contentAlignment = Alignment.Center,
                ) {
                    if (vm.sending) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.onBrand)
                    else Icon(
                        if (vm.editing != null) Icons.Filled.Check else Icons.AutoMirrored.Filled.Send,
                        contentDescription = if (vm.editing != null) "Salvar edição" else "Enviar",
                        tint = if (vm.canSend) c.onBrand else c.muted,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        }
    }

    if (attachSheet) {
        AttachSheet(
            detail = detail,
            onDismiss = { attachSheet = false },
            onGallery = { attachSheet = false; pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            onCamera = { attachSheet = false; requestCamera() },
            onDocument = { attachSheet = false; pickDocuments.launch(arrayOf("*/*")) },
            onAudio = { attachSheet = false; pickDocuments.launch(arrayOf("audio/*")) },
            onLocation = { attachSheet = false; requestLocation() },
            onContact = { attachSheet = false; requestContact() },
            onMention = { attachSheet = false; mentionSheet = true },
            onMenu = { attachSheet = false; onMenu() },
            onTicket = { attachSheet = false; onTicket() },
            onNote = { attachSheet = false; onNote() },
        )
    }
    if (mentionSheet) {
        MentionSheet(members = members, onPick = { vm.addMention(it); mentionSheet = false }, onDismiss = { mentionSheet = false })
    }
}

/** Cor do campo sobre o papel de parede da conversa. */
@Composable
private fun composerSurface(): Color = if (Wb.colors.isDark) Wb.colors.surface else Wb.colors.background

/** Gravação em andamento: lixeira para descartar, cronômetro vermelho com onda, parar (revisar) e enviar. */
@Composable
private fun RecordingBar(seconds: Int, onDiscard: () -> Unit, onStop: () -> Unit, onSend: () -> Unit) {
    val c = Wb.colors
    val transition = rememberInfiniteTransition(label = "recording")
    val blink by transition.animateFloat(1f, 0.25f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "blink")
    val phase by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1400)), label = "wave")
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).height(48.dp).clip(CircleShape).background(composerSurface()).padding(start = 4.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onDiscard) { Icon(Icons.Filled.Delete, contentDescription = "Descartar gravação", tint = c.danger) }
            Box(Modifier.size(10.dp).alpha(blink).clip(CircleShape).background(c.danger))
            Spacer(Modifier.width(8.dp))
            Text(formatClock(seconds * 1000L), color = c.danger, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(10.dp))
            Canvas(Modifier.weight(1f).height(24.dp)) {
                val bars = 26
                val gap = 3.dp.toPx()
                val barWidth = ((size.width - gap * (bars - 1)) / bars).coerceAtLeast(1f)
                repeat(bars) { index ->
                    val wave = kotlin.math.sin((index / bars.toFloat() + phase) * 2 * Math.PI * 2).toFloat()
                    val h = size.height * (0.3f + 0.35f * (wave + 1f))
                    drawRoundRect(
                        color = c.danger.copy(alpha = 0.55f),
                        topLeft = Offset(index * (barWidth + gap), (size.height - h) / 2),
                        size = Size(barWidth, h),
                        cornerRadius = CornerRadius(barWidth / 2),
                    )
                }
            }
            IconButton(onClick = onStop) { Icon(Icons.Filled.Stop, contentDescription = "Parar e ouvir antes de enviar", tint = c.textSecondary) }
        }
        Spacer(Modifier.width(6.dp))
        RoundIconButton(Icons.AutoMirrored.Filled.Send, "Enviar gravação", onClick = onSend, size = 48.dp, color = c.brand, contentColor = c.onBrand)
    }
}

/** Faixa acima do campo para resposta citada e edição, com X. */
@Composable
private fun DraftStrip(icon: ImageVector?, label: String, text: String, onCancel: () -> Unit) {
    val c = Wb.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 6.dp, end = 2.dp, top = 6.dp).clip(RoundedCornerShape(14.dp)).background(c.field).height(52.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(4.dp).height(52.dp).background(c.brand))
        Spacer(Modifier.width(10.dp))
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = c.brand, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(label, color = c.brand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(text.replace('\n', ' '), color = c.textSecondary, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onCancel, modifier = Modifier.size(44.dp)) { Icon(Icons.Filled.Close, contentDescription = "Cancelar", tint = c.textSecondary, modifier = Modifier.size(20.dp)) }
    }
}

private class AttachItem(val label: String, val icon: ImageVector, val color: Color, val onClick: () -> Unit)

/** Folha **+** em grade de ícones redondos coloridos. Itens sem capacidade na linha não aparecem. */
@Composable
private fun AttachSheet(
    detail: ConversationDetail,
    onDismiss: () -> Unit,
    onGallery: () -> Unit,
    onCamera: () -> Unit,
    onDocument: () -> Unit,
    onAudio: () -> Unit,
    onLocation: () -> Unit,
    onContact: () -> Unit,
    onMention: () -> Unit,
    onMenu: () -> Unit,
    onTicket: () -> Unit,
    onNote: () -> Unit,
) {
    val c = Wb.colors
    val items = buildList {
        if (detail.can("image") || detail.can("video")) add(AttachItem("Galeria", Icons.Filled.PhotoLibrary, c.bot, onGallery))
        if (detail.can("image")) add(AttachItem("Câmera", Icons.Filled.PhotoCamera, c.danger, onCamera))
        if (detail.can("document")) add(AttachItem("Documento", Icons.AutoMirrored.Filled.InsertDriveFile, c.ticket, onDocument))
        if (detail.can("audio")) add(AttachItem("Áudio", Icons.Filled.Headphones, c.warn, onAudio))
        if (detail.can("location")) add(AttachItem("Localização", Icons.Filled.LocationOn, c.ok, onLocation))
        if (detail.can("contacts")) add(AttachItem("Contato", Icons.Filled.Person, c.tickRead, onContact))
        if (detail.conversation.isGroup && detail.can("mentions")) add(AttachItem("Mencionar", Icons.Filled.AlternateEmail, c.muted, onMention))
        add(AttachItem("Menu", Icons.AutoMirrored.Filled.ListAlt, c.brand, onMenu))
        add(AttachItem("Protocolo", Icons.Filled.ConfirmationNumber, c.ticket, onTicket))
        add(AttachItem("Nota interna", Icons.Filled.Lock, c.warn, onNote))
    }
    WbBottomSheet(onDismiss = onDismiss) {
        FlowRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            maxItemsInEachRow = 3,
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            items.forEach { item ->
                Column(
                    Modifier.width(104.dp).clip(RoundedCornerShape(16.dp)).clickable(onClick = item.onClick).padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(Modifier.size(58.dp).clip(CircleShape).background(item.color), contentAlignment = Alignment.Center) {
                        Icon(item.icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(27.dp))
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(item.label, color = c.textPrimary, fontSize = 13.5.sp, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun AttachmentPreviewRow(attachment: PendingAttachment, document: Boolean, enabled: Boolean, onRemove: () -> Unit) {
    val c = Wb.colors
    val kind = if (document) "document" else MediaKinds.kindOf(attachment.mime)
    val (icon, tint) = when (kind) {
        "image", "sticker" -> Icons.Filled.Image to c.bot
        "video" -> Icons.Filled.Videocam to c.danger
        "audio", "voice" -> Icons.Filled.Audiotrack to c.warn
        else -> Icons.AutoMirrored.Filled.InsertDriveFile to c.ticket
    }
    Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = MediaKinds.label(kind), tint = tint, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(attachment.name, color = c.textPrimary, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${MediaKinds.formatSize(attachment.size)} · ${MediaKinds.label(kind)}${if (attachment.uploadedId != null) " · enviado" else ""}",
                color = c.textSecondary,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }
        IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Filled.Close, contentDescription = "Remover ${attachment.name}", tint = c.textSecondary) }
    }
}

@Composable
private fun PanelCard(icon: ImageVector, title: String, enabled: Boolean, onRemove: () -> Unit, content: @Composable () -> Unit) {
    val c = Wb.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 3.dp).clip(RoundedCornerShape(16.dp)).background(composerSurface()).padding(start = 12.dp, end = 4.dp, bottom = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = c.brand, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(title, color = c.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Filled.Close, contentDescription = "Remover $title", tint = c.textSecondary) }
        }
        Column(Modifier.padding(end = 8.dp)) { content() }
    }
}

@Composable
private fun PanelField(value: String, onValueChange: (String) -> Unit, placeholder: String, enabled: Boolean, modifier: Modifier = Modifier, keyboardType: KeyboardType = KeyboardType.Text) {
    val c = Wb.colors
    Box(modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(12.dp)).background(c.field).padding(horizontal = 12.dp, vertical = 11.dp), contentAlignment = Alignment.CenterStart) {
        if (value.isEmpty()) Text(placeholder, color = c.textSecondary, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.textPrimary, fontSize = 15.sp),
            cursorBrush = SolidColor(c.brand),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun LocationFields(vm: ConversationViewModel, locating: Boolean, enabled: Boolean, onUseDevice: () -> Unit, onRemove: () -> Unit) {
    PanelCard(Icons.Filled.LocationOn, "Localização", enabled, onRemove) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PanelField(vm.location.latitude, { vm.location = vm.location.copy(latitude = it) }, "Latitude", enabled, Modifier.weight(1f), KeyboardType.Decimal)
            PanelField(vm.location.longitude, { vm.location = vm.location.copy(longitude = it) }, "Longitude", enabled, Modifier.weight(1f), KeyboardType.Decimal)
        }
        Spacer(Modifier.height(8.dp))
        PanelField(vm.location.name, { if (it.length <= 200) vm.location = vm.location.copy(name = it) }, "Nome do local (opcional)", enabled, Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        PanelField(vm.location.address, { if (it.length <= 500) vm.location = vm.location.copy(address = it) }, "Endereço (opcional)", enabled, Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        SecondaryButton(if (locating) "Obtendo posição…" else "Usar minha localização", onClick = onUseDevice, enabled = enabled, loading = locating, icon = Icons.Filled.MyLocation)
        Text(
            "Revise as coordenadas antes de enviar. Elas são compartilhadas com o cliente no WhatsApp.",
            color = Wb.colors.textSecondary,
            fontSize = 12.sp,
            lineHeight = 16.sp,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun ContactFields(vm: ConversationViewModel, enabled: Boolean, onPick: () -> Unit, onRemove: () -> Unit) {
    PanelCard(Icons.Filled.Person, "Cartão de contato", enabled, onRemove) {
        PanelField(vm.contact.name, { if (it.length <= 100) vm.contact = vm.contact.copy(name = it) }, "Nome", enabled, Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        PanelField(
            vm.contact.phone,
            { vm.contact = vm.contact.copy(phone = DeviceInputs.normalizePhone(it).take(17)) },
            "Telefone com DDI (ex.: 5511999990000)",
            enabled,
            Modifier.fillMaxWidth(),
            KeyboardType.Phone,
        )
        Spacer(Modifier.height(10.dp))
        SecondaryButton("Escolher da agenda", onClick = onPick, enabled = enabled, icon = Icons.Filled.Person)
    }
}
