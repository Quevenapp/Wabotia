package br.com.queven.wabotia.modules.os

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.agenda.Field
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.time.ZoneOffset

// ---------------------------------------------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------------------------------------------

/**
 * Entrada "Ordens de serviço": a lista por modelo; servidor sem catálogo de modelos (ou só com a ordem simples) mostra a
 * lista antiga, sem mudança.
 */
@Composable
fun WorkOrdersEntry(
    container: AppContainer,
    onBack: () -> Unit,
    openOrder: (WorkOrder) -> Unit,
    openLegacyOrder: (String) -> Unit,
    newOrder: () -> Unit,
    newLegacyOrder: () -> Unit,
) {
    val vm: WorkOrdersViewModel = viewModel { WorkOrdersViewModel(WorkDeps.of(container), container) }
    if (vm.legacy) {
        ServiceOrdersScreen(container, onBack, openLegacyOrder, newLegacyOrder)
        return
    }
    WorkOrdersScreen(vm, onBack, openOrder, newOrder)
}

@Composable
private fun WorkOrdersScreen(vm: WorkOrdersViewModel, onBack: () -> Unit, openOrder: (WorkOrder) -> Unit, newOrder: () -> Unit) {
    val c = Wb.colors
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            DetailTopBar("Ordens de serviço", onBack, actions = {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
        floatingActionButton = {
            if (vm.offlineAt == null && vm.catalog != null) ExtendedFloatingActionButton(
                onClick = newOrder, containerColor = c.brand, contentColor = c.onBrand,
                modifier = Modifier.navigationBarsPadding().testTag("os.work.new"),
                icon = { Icon(Icons.Filled.Add, contentDescription = null) }, text = { Text("Nova ordem") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SearchField(vm.query, { vm.search(it) }, "Número, cliente ou item", Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp))
            val types = vm.types
            if (types.size > 1) {
                LazyRow(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item("all") { WbFilterChip("Todos os modelos", vm.typeId == null, { vm.selectType(null) }) }
                    items(types, key = { it.id }) { t -> WbFilterChip(t.title, vm.typeId == t.id, { vm.selectType(t.id) }) }
                }
            }
            LazyRow(contentPadding = PaddingValues(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(WorkOrderRules.SITUATIONS, key = { it.first }) { (id, title) ->
                    WbFilterChip(title, vm.stage == null && vm.situation == id, { vm.selectSituation(id) })
                }
            }
            val stages = vm.selectedType?.takeIf { !it.isBuiltin }?.stages.orEmpty()
            if (stages.isNotEmpty()) {
                LazyRow(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(stages, key = { it.id }) { s ->
                        WbFilterChip(s.label, vm.stage == s.id, { vm.selectStage(if (vm.stage == s.id) null else s.id) }, tone = if (vm.stage == s.id) orderColor(s.baseStatus) else null)
                    }
                }
            }
            vm.offlineAt?.let { InlineNotice(WorkOrderRules.offlineBanner(it), Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = c.warn) }
            when {
                vm.loading && vm.orders.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                vm.error != null && vm.orders.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.orders.isEmpty() -> EmptyState(
                    Icons.Filled.Build, "Nenhuma ordem aqui",
                    subtitle = if (vm.query.isBlank()) "Abra uma ordem com \"Nova ordem\" ou pela conversa do cliente." else "Nada encontrado para essa busca.",
                )
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    items(vm.orders, key = { it.id }) { order -> WorkOrderRow(order, vm.showTypeLabel) { openOrder(order) } }
                    if (vm.nextCursor != null) item("more") {
                        LaunchedEffect(vm.orders.size) { vm.loadMore() }
                        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkOrderRow(order: WorkOrder, showType: Boolean, onClick: () -> Unit) {
    val c = Wb.colors
    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("os.work.order"), onClick = onClick) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.numberText, fontWeight = FontWeight.Bold, color = c.textPrimary)
                if (showType && !order.typeLabel.isNullOrBlank()) {
                    Text("  ·  ${order.typeLabel}", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                } else {
                    Spacer(Modifier.weight(1f))
                }
                Pill(order.stageText, orderColor(order.state))
            }
            Text(order.customerName, color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            order.item?.takeIf { it.isNotBlank() }?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            val extras = listOfNotNull(
                order.dueAt?.let { "Prazo ${BrasiliaTime.short(it)}" },
                order.quote?.let { "Orçamento ${Money.format(it.total)}" },
            )
            if (extras.isNotEmpty() || WorkOrderRules.overdue(order)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(extras.joinToString(" · "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    if (WorkOrderRules.overdue(order)) Pill("Atrasado", c.danger)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Campos próprios
// ---------------------------------------------------------------------------------------------------------------

/** O editor dos campos comuns (nunca os sensíveis), um por tipo. */
@Composable
fun WorkFieldsEditor(
    fields: List<WorkField>,
    draft: Map<String, String>,
    onChange: (Map<String, String>) -> Unit,
    required: Set<String>,
    hints: Set<String> = emptySet(),
    enabled: Boolean = true,
) {
    val c = Wb.colors
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        WorkFields.common(fields).forEach { field ->
            val value = draft[field.id].orEmpty()
            fun set(v: String) = onChange(draft + (field.id to v))
            val label = field.label + (if (field.id in required) " *" else "") + (if (field.id in hints) " (pedido na próxima etapa)" else "")
            when (field.kind) {
                "boolean" -> ChoiceRow(label, listOf("true" to "Sim", "false" to "Não"), value, field.id !in required, enabled, ::set)
                "choice" -> ChoiceRow(label, field.options.map { it.id to it.label }, value, field.id !in required, enabled, ::set)
                "date" -> DateField(label, value, field.id !in required, enabled, ::set)
                "integer", "decimal" -> OutlinedTextField(
                    value, { v -> set(v.filter { it.isDigit() || it == ',' || it == '.' || it == '-' }.take(24)) },
                    label = { Text(label) }, singleLine = true, enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = if (field.kind == "integer") KeyboardType.Number else KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth().testTag("os.field.${field.id}"),
                )
                else -> {
                    val max = field.maxLength
                    val counter: (@Composable () -> Unit)? = if (field.multiline && max != null) {
                        { Text("${value.length}/$max") }
                    } else {
                        null
                    }
                    OutlinedTextField(
                        value, { v -> set(if (max != null) v.take(max) else v) },
                        label = { Text(label) }, singleLine = !field.multiline, minLines = if (field.multiline) 3 else 1, enabled = enabled,
                        supportingText = counter,
                        modifier = Modifier.fillMaxWidth().testTag("os.field.${field.id}"),
                    )
                }
            }
            if (field.help.isNotBlank()) Text(field.help, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ChoiceRow(label: String, options: List<Pair<String, String>>, value: String, clearable: Boolean, enabled: Boolean, onSet: (String) -> Unit) {
    val c = Wb.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { (id, title) -> WbFilterChip(title, value == id, { if (enabled) onSet(id) }) }
            if (clearable) WbFilterChip("Não informado", value.isEmpty(), { if (enabled) onSet("") })
        }
    }
}

@Composable
private fun DateField(label: String, value: String, clearable: Boolean, enabled: Boolean, onSet: (String) -> Unit) {
    val c = Wb.colors
    var picking by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        Row(verticalAlignment = Alignment.CenterVertically) {
            val shown = BrasiliaTime.parse(value)?.let { BrasiliaTime.shortDay(value) } ?: "Sem data"
            Text(shown, Modifier.weight(1f), color = c.textPrimary)
            TextButton(onClick = { picking = true }, enabled = enabled) { Text("Escolher data", color = c.brand) }
            if (clearable && value.isNotEmpty()) TextButton(onClick = { onSet("") }, enabled = enabled) { Text("Limpar", color = c.textSecondary) }
        }
    }
    if (picking) {
        val initial = BrasiliaTime.parse(value)?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
        val state = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { picking = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onSet(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()) }
                    picking = false
                }) { Text("Escolher") }
            },
            dismissButton = { TextButton(onClick = { picking = false }) { Text("Voltar") } },
        ) { DatePicker(state) }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------------------------------------------

/** Ficha da ordem por modelo; uma ordem antiga (sem modelo) abre a ficha antiga. */
@Composable
fun WorkOrderScreen(container: AppContainer, id: String, onBack: () -> Unit, openConversation: (String) -> Unit, openPrinter: () -> Unit) {
    val vm: WorkOrderViewModel = viewModel(key = "os-work:$id") { WorkOrderViewModel(id, WorkDeps.of(container), container) }
    if (vm.order?.isLegacy == true) {
        ServiceOrderScreen(container, id, onBack, openConversation, openPrinter)
        return
    }
    val c = Wb.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var reasonFor by remember { mutableStateOf<NextStage?>(null) }
    var confirmQuote by remember { mutableStateOf(false) }
    var editFields by remember { mutableStateOf<Map<String, String>?>(null) }
    var photoItemId by rememberSaveable { mutableStateOf<String?>(null) }
    var cameraPath by rememberSaveable { mutableStateOf<String?>(null) }

    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }

    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = cameraPath
        val itemId = photoItemId
        cameraPath = null
        photoItemId = null
        if (path == null) return@rememberLauncherForActivityResult
        val file = File(path)
        val item = vm.order?.checklist?.firstOrNull { it.current }?.items?.firstOrNull { it.id == itemId }
        if (!ok || item == null || !file.exists() || file.length() == 0L) {
            file.delete()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            val jpeg = withContext(Dispatchers.IO) { runCatching { shrinkPhoto(file) }.getOrNull().also { file.delete() } }
            if (jpeg == null) vm.notice = "Não deu para ler a foto. Tire de novo." else vm.markWithPhoto(item, jpeg)
        }
    }

    fun openCamera(item: ChecklistEntry) {
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            vm.cameraUnavailable()
            return
        }
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "checklist-${System.currentTimeMillis()}.jpg")
        cameraPath = file.absolutePath
        photoItemId = item.id
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        try {
            takePicture.launch(uri)
        } catch (e: Exception) {
            cameraPath = null
            photoItemId = null
            vm.cameraUnavailable()
        }
    }

    var pendingCameraItem by remember { mutableStateOf<ChecklistEntry?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val item = pendingCameraItem
        pendingCameraItem = null
        if (granted && item != null) openCamera(item) else vm.cameraUnavailable()
    }

    fun onCheck(item: ChecklistEntry) {
        if (!item.done && item.photoRequired) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera(item)
            else {
                pendingCameraItem = item
                cameraPermission.launch(Manifest.permission.CAMERA)
            }
        } else {
            vm.toggle(item)
        }
    }

    val order = vm.order
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DetailTopBar(
                listOfNotNull(order?.typeLabel?.takeIf { it.isNotBlank() }, order?.numberText).joinToString(" ").ifBlank { "Ordem" },
                onBack,
                subtitle = order?.stageText,
                actions = { IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) } },
            )
        },
    ) { padding ->
        when {
            order == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            order == null -> ErrorState(vm.loadError ?: "Ordem não encontrada.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                vm.offlineAt?.let { InlineNotice(WorkOrderRules.offlineBanner(it), color = c.warn) }
                HeaderCard(order)
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                vm.progress?.let { text ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.width(18.dp).height(18.dp), color = c.brand, strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(text, color = c.textSecondary)
                    }
                }
                order.stageApproval?.takeIf { it.state == "pending" }?.let { approval ->
                    InlineNotice(
                        "Esperando a aprovação do cliente" + (approval.expiresAt?.let { " até ${BrasiliaTime.shortWithTime(it)}" } ?: "") + ". A decisão é registrada no painel.",
                        color = c.warn,
                    )
                }
                if (!vm.readOnly) {
                    val buttons = WorkOrderRules.stageButtons(order)
                    if (buttons.isNotEmpty()) {
                        SectionLabel("O que fazer agora", Modifier.padding(start = 0.dp))
                        buttons.forEach { (next, title) ->
                            val cancel = next.baseStatus == "cancelled"
                            SecondaryButton(
                                title,
                                {
                                    if (WorkOrderRules.needsReason(order.state, next.baseStatus)) reasonFor = next else vm.move(next, null)
                                },
                                enabled = vm.busy == null,
                                loading = vm.busy?.startsWith("stage:${next.transitionId}:") == true,
                                color = if (cancel) c.danger else c.brand,
                            )
                        }
                    }
                }
                ChecklistCard(order, enabled = vm.canEdit, onCheck = ::onCheck, onPhoto = { vm.openPhoto(it) })
                FieldsCard(order, vm.neededNext, canEdit = vm.canEdit) { editFields = WorkFields.draftOf(order.fields, order.extra) }
                order.quote?.let { QuoteReadCard(order, it, canSend = !vm.readOnly && WorkOrderRules.canSendQuote(order), busy = vm.busy != null) { confirmQuote = true } }
                order.customer?.conversationId?.takeIf { it.isNotBlank() }?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
                HistoryCard(vm.history, vm.type?.stages.orEmpty(), hasMore = vm.historyCursor != null && vm.offlineAt == null) { vm.loadMoreHistory() }
            }
        }
    }

    reasonFor?.let { next ->
        val current = order ?: return@let
        ReasonDialog(
            title = WorkOrderRules.reasonTitle(current.state, next.baseStatus),
            confirm = if (next.baseStatus == "cancelled") "Cancelar a ordem" else "Confirmar",
            danger = next.baseStatus == "cancelled",
            onDismiss = { reasonFor = null },
        ) { reason ->
            reasonFor = null
            vm.move(next, reason)
        }
    }
    if (confirmQuote) {
        AlertDialog(
            onDismissRequest = { confirmQuote = false },
            title = { Text("Enviar o orçamento ao cliente?") },
            text = { Text("O cliente recebe os itens, o total e a validade no WhatsApp e responde Aprovar ou Recusar.") },
            confirmButton = { TextButton(onClick = { confirmQuote = false; vm.sendQuote() }) { Text("Enviar", color = c.brand) } },
            dismissButton = { TextButton(onClick = { confirmQuote = false }) { Text("Voltar") } },
        )
    }
    editFields?.let { draft ->
        val current = order ?: return@let
        WbBottomSheet(onDismiss = { editFields = null }, title = "Editar campos") {
            Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                WorkFieldsEditor(current.fields, draft, { editFields = it }, WorkFields.required(current.fields), vm.neededNext)
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                PrimaryButton("Salvar campos", { if (vm.saveFields(draft)) editFields = null }, enabled = vm.busy == null)
            }
        }
    }
    vm.missingSheet?.let { sheet ->
        val current = order ?: return@let
        var draft by remember(sheet) { mutableStateOf(WorkFields.draftOf(sheet.fields, current.extra)) }
        WbBottomSheet(onDismiss = { vm.missingSheet = null }, title = "Complete os dados desta etapa", subtitle = "Para ${sheet.next.stageLabel.ifBlank { sheet.next.stage }}") {
            Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                WorkFieldsEditor(sheet.fields, draft, { draft = it }, sheet.fields.map { it.id }.toSet())
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                PrimaryButton("Salvar e tentar de novo", { vm.saveMissingAndRetry(sheet, draft) }, enabled = vm.busy == null)
            }
        }
    }
    if (vm.photo != null || vm.photoLoading) {
        val bytes = vm.photo
        val bitmap = remember(bytes) { bytes?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() } }
        WbBottomSheet(onDismiss = { vm.photo = null }, title = "Foto do checklist") {
            Box(Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(16.dp), contentAlignment = Alignment.Center) {
                when {
                    bitmap != null -> Image(bitmap.asImageBitmap(), contentDescription = "Foto do item do checklist", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth())
                    vm.photoLoading -> CircularProgressIndicator(color = c.brand)
                    else -> Text("Não deu para abrir a foto.", color = c.textSecondary)
                }
            }
        }
    }
}

@Composable
private fun HeaderCard(order: WorkOrder) {
    val c = Wb.colors
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.item.orEmpty(), Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
                Pill(order.stageText, orderColor(order.state))
            }
            Field("Cliente", order.customerName)
            PhoneText.display(order.customer?.phone)?.takeIf { it != order.customerName }?.let { Field("Telefone", it) }
            Field(order.itemLabel, order.item.orEmpty().ifBlank { "—" })
            Field(order.problemLabel, order.problem.orEmpty().ifBlank { "—" })
            order.dueAt?.let { Field("Prazo", BrasiliaTime.short(it) + if (WorkOrderRules.overdue(order)) " · Atrasado" else "") }
            order.created?.let { Field("Aberta em", BrasiliaTime.shortWithTime(it)) }
            order.notes?.takeIf { it.isNotBlank() }?.let { Field("Observação interna", it) }
            order.serviceObject?.let { obj ->
                HorizontalDivider(color = c.hairline)
                Text(obj.type.labels.singular.ifBlank { "Objeto do serviço" }, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                if (obj.identifier.isNotBlank()) Text(obj.identifier, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                WorkFields.lines(obj.type.fields, obj.values).filter { it.first.id != obj.type.identifierFieldId }.forEach { (field, text) -> Field(field.label, text) }
            }
        }
    }
}

@Composable
private fun ChecklistCard(order: WorkOrder, enabled: Boolean, onCheck: (ChecklistEntry) -> Unit, onPhoto: (String) -> Unit) {
    val stages = order.checklist
    if (stages.isEmpty()) return
    val c = Wb.colors
    SectionLabel("Checklist", Modifier.padding(start = 0.dp))
    WbCard {
        Column(Modifier.padding(vertical = 8.dp)) {
            stages.forEachIndexed { index, stage ->
                if (index > 0) HorizontalDivider(color = c.hairline)
                Text(
                    stage.stageLabel + if (stage.current) " · etapa atual" else "",
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold,
                    color = if (stage.current) c.textPrimary else c.textSecondary,
                )
                stage.items.forEach { item ->
                    val canMark = enabled && stage.current && !order.closed
                    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp).testTag("os.check.${item.id}"), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(item.done, { onCheck(item) }, enabled = canMark, colors = CheckboxDefaults.colors(checkedColor = c.brand))
                        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                            Text(
                                item.label + (if (item.required) " (obrigatório)" else "") + (if (item.photoRequired) " · pede foto" else ""),
                                color = c.textPrimary, style = MaterialTheme.typography.bodyMedium,
                            )
                            if (item.done && item.at != null) Text("Marcado em ${BrasiliaTime.shortWithTime(item.at)}", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                        }
                        if (item.done && !item.photoDocumentId.isNullOrBlank()) {
                            TextButton(onClick = { onPhoto(item.photoDocumentId) }) { Text("Ver foto", color = c.brand) }
                        } else if (!item.done && item.photoRequired && canMark) {
                            Icon(Icons.Filled.CameraAlt, contentDescription = null, tint = c.textSecondary, modifier = Modifier.padding(end = 12.dp))
                        }
                    }
                }
                if (stage.current && stage.missing.isNotEmpty()) {
                    Text(
                        "Para avançar de etapa, falta marcar: ${stage.missing.joinToString(", ")}.",
                        Modifier.padding(horizontal = 16.dp, vertical = 6.dp), color = c.warn, style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun FieldsCard(order: WorkOrder, neededNext: Set<String>, canEdit: Boolean, onEdit: () -> Unit) {
    val lines = WorkFields.lines(order.fields, order.extra)
    if (lines.isEmpty()) return
    val c = Wb.colors
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Campos desta ordem", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                if (canEdit) TextButton(onClick = onEdit) { Text("Editar campos", color = c.brand) }
            }
            lines.forEach { (field, text) ->
                Field(field.label + if (field.id in neededNext) " (pedido na próxima etapa)" else "", text)
            }
        }
    }
}

@Composable
private fun QuoteReadCard(order: WorkOrder, quote: WorkQuote, canSend: Boolean, busy: Boolean, onSend: () -> Unit) {
    val c = Wb.colors
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Orçamento", fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            quote.items.forEach { item ->
                Row {
                    val qty = if (item.quantity == Math.floor(item.quantity)) item.quantity.toLong().toString() else item.quantity.toString().replace('.', ',')
                    Text("${qty}x ${item.description}", Modifier.weight(1f), color = c.textPrimary)
                    Text(Money.format(item.lineCents), color = c.textPrimary)
                }
            }
            val discount = (quote.discountCents ?: 0)
            if (discount > 0) Row {
                Text("Desconto", Modifier.weight(1f), color = c.textSecondary)
                Text("-" + Money.format(discount), color = c.textSecondary)
            }
            HorizontalDivider(color = c.hairline)
            Row {
                Text("Total", Modifier.weight(1f), fontWeight = FontWeight.Bold, color = c.textPrimary)
                Text(Money.format(quote.total), fontWeight = FontWeight.Bold, color = c.textPrimary)
            }
            Text(WorkOrderRules.quoteStatus(order), color = if (quote.expired && order.decision == null) c.warn else c.textSecondary, style = MaterialTheme.typography.bodySmall)
            quote.note?.takeIf { it.isNotBlank() }?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
            if (canSend) PrimaryButton("Enviar ao cliente pelo WhatsApp", onSend, enabled = !busy, icon = Icons.Filled.Send)
        }
    }
}

@Composable
private fun HistoryCard(history: List<WorkHistory>, stages: List<WorkStage>, hasMore: Boolean, onMore: () -> Unit) {
    if (history.isEmpty()) return
    val c = Wb.colors
    SectionLabel("Histórico", Modifier.padding(start = 0.dp))
    WbCard {
        Column(Modifier.padding(vertical = 6.dp)) {
            history.sortedByDescending { it.created ?: 0 }.forEachIndexed { i, h ->
                if (i > 0) HorizontalDivider(color = c.hairline)
                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                    Text(WorkOrderRules.historyText(h, stages), color = c.textPrimary, fontWeight = FontWeight.Medium)
                    h.created?.let { Text(BrasiliaTime.shortWithTime(it), color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                    WorkOrderRules.historyNote(h)?.let { Text("Motivo: $it", color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                }
            }
            if (hasMore) TextButton(onClick = onMore, modifier = Modifier.padding(horizontal = 8.dp)) { Text("Ver mais", color = c.brand) }
        }
    }
}

@Composable
private fun ReasonDialog(title: String, confirm: String, danger: Boolean, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val c = Wb.colors
    var reason by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(reason, { reason = it.take(500); error = null }, label = { Text("Motivo") }, minLines = 2, modifier = Modifier.fillMaxWidth().testTag("os.reason"))
                Text(error ?: "Fica no histórico da ordem, com quem fez e quando.", color = if (error != null) c.danger else c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (reason.isBlank()) error = WorkOrderRules.REASON_REQUIRED else onConfirm(reason.trim())
            }) { Text(confirm, color = if (danger) c.danger else c.brand) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Voltar") } },
    )
}

/** Reduz a foto da câmera para JPEG com o lado maior até 1600 px, qualidade 80, já na orientação certa. */
private fun shrinkPhoto(file: File): ByteArray? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= WorkOrderRules.PHOTO_MAX_SIDE) sample *= 2
    val decoded = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val (w, h) = WorkOrderRules.scaledSize(decoded.width, decoded.height)
    val scaled = if (w != decoded.width || h != decoded.height) Bitmap.createScaledBitmap(decoded, w, h, true) else decoded
    val rotation = runCatching {
        when (ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
    }.getOrDefault(0f)
    val upright = if (rotation != 0f) Bitmap.createBitmap(scaled, 0, 0, scaled.width, scaled.height, Matrix().apply { postRotate(rotation) }, true) else scaled
    var quality = 80
    var bytes: ByteArray
    do {
        val out = ByteArrayOutputStream()
        upright.compress(Bitmap.CompressFormat.JPEG, quality, out)
        bytes = out.toByteArray()
        quality -= 15
    } while (bytes.size > WorkOrderRules.PHOTO_MAX_BYTES && quality >= 35)
    return bytes
}

// ---------------------------------------------------------------------------------------------------------------
// Abrir ordem
// ---------------------------------------------------------------------------------------------------------------

/**
 * Abrir ordem por modelo. Servidor sem modelos, catálogo só com a ordem simples ou a escolha da ordem simples abrem a
 * tela antiga ([NewServiceOrderScreen]).
 */
@Composable
fun NewWorkOrderScreen(
    container: AppContainer,
    conversationId: String?,
    customer: String?,
    onBack: () -> Unit,
    onCreated: (WorkOrder) -> Unit,
    onCreatedLegacy: (ServiceOrder) -> Unit,
) {
    val vm: NewWorkOrderViewModel = viewModel(key = "os-work-new:${conversationId ?: "balcao"}") { NewWorkOrderViewModel(conversationId, customer, WorkDeps.of(container)) }
    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.result) { vm.result?.let(onCreated) }
    if (vm.legacy) {
        NewServiceOrderScreen(container, conversationId, customer, onBack, onCreatedLegacy)
        return
    }
    val c = Wb.colors
    val type = vm.type
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar(type?.labels?.singular?.ifBlank { null } ?: "Nova ordem", onBack, subtitle = customer ?: vm.contact?.displayName, backEnabled = !vm.busy) },
    ) { padding ->
        when {
            vm.loading && vm.catalog == null -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            vm.catalog == null -> ErrorState(vm.loadError ?: "Não deu para carregar os modelos de ordem.", onRetry = { vm.load() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // 1. Modelo
                if (vm.customTypes.size > 1 || vm.hasBuiltin) {
                    Text("Modelo", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        vm.customTypes.forEach { t -> WbFilterChip(t.labels.singular.ifBlank { t.title }, type?.id == t.id, { vm.chooseType(t) }) }
                        vm.catalog.orEmpty().firstOrNull { it.isBuiltin }?.let { b -> WbFilterChip(b.title, false, { vm.chooseType(b) }) }
                    }
                }
                if (type == null) {
                    Text("Escolha o modelo da ordem para continuar.", color = c.textSecondary)
                    return@Column
                }
                // 2. Cliente
                CustomerStep(vm)
                // 3. Objeto do serviço
                if (vm.needsObject) ObjectStep(vm)
                // 4. Campos do modelo, item, descrição e observação
                if (WorkFields.common(type.fields).isNotEmpty()) {
                    Text("Dados da ordem", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    WorkFieldsEditor(type.fields, vm.fieldDraft, { vm.fieldDraft = it }, vm.requiredFields)
                }
                OutlinedTextField(vm.item, { vm.item = it.take(200) }, label = { Text(type.labels.item.ifBlank { "Item" } + " *") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("os.work.item"))
                OutlinedTextField(vm.problem, { vm.problem = it.take(2000) }, label = { Text(type.labels.problem.ifBlank { "Descrição" } + " *") }, minLines = 2, modifier = Modifier.fillMaxWidth().testTag("os.work.problem"))
                OutlinedTextField(vm.notes, { vm.notes = it }, label = { Text("Observação interna (opcional)") }, modifier = Modifier.fillMaxWidth())
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                Spacer(Modifier.height(4.dp))
                PrimaryButton("Abrir ordem", { vm.submit() }, loading = vm.busy, enabled = !vm.busy, icon = Icons.Filled.Build)
                Text(
                    if (conversationId != null) "O cliente recebe o número da ordem no WhatsApp." else "Sem conversa ligada, os avisos ao cliente dependem de ele falar com a empresa pelo WhatsApp.",
                    color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun CustomerStep(vm: NewWorkOrderViewModel) {
    val c = Wb.colors
    val contact = vm.contact
    Text("Cliente", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
    if (contact != null) {
        WbCard {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(contact.displayName, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                    PhoneText.display(contact.phone)?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                }
                if (!vm.fromConversation) TextButton(onClick = { vm.chooseContact(null) }) { Text("Trocar", color = c.brand) }
            }
        }
        return
    }
    if (vm.conversationId != null) {
        Text("Cliente da conversa: ${vm.customerLabel ?: "cliente"}.", color = c.textPrimary)
        if (!vm.needsObject) return
        Text("Para escolher o objeto do serviço, busque o cadastro deste cliente.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
    }
    SearchField(vm.contactQuery, { vm.searchContacts(it) }, "Nome ou telefone do cliente")
    when {
        vm.searching -> CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), color = c.brand, strokeWidth = 2.dp)
        vm.searched && vm.contacts.isEmpty() -> Text(WorkOrderRules.NO_CONTACTS, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        else -> vm.contacts.forEach { found ->
            WbCard(onClick = { vm.chooseContact(found) }) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Text(found.displayName, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                    PhoneText.display(found.phone)?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}

@Composable
private fun ObjectStep(vm: NewWorkOrderViewModel) {
    val c = Wb.colors
    val objectType = vm.objectType
    val singular = objectType?.labels?.singular?.ifBlank { null } ?: "Objeto do serviço"
    Text(singular, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
    if (vm.contact?.id.isNullOrBlank()) {
        Text("Escolha o cliente para ver os cadastros de ${singular.lowercase()}.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        return
    }
    if (vm.objectsLoading) {
        CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), color = c.brand, strokeWidth = 2.dp)
        return
    }
    vm.objects.forEach { obj ->
        val selected = vm.chosenObject?.id == obj.id
        WbCard(onClick = { vm.chooseObject(obj) }, color = if (selected) c.soft(c.brand, 0.14f) else c.surface) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                Text(obj.identifier.ifBlank { singular }, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                val fields = obj.type?.fields ?: objectType?.fields.orEmpty()
                val identifierField = obj.type?.identifierFieldId ?: objectType?.identifierFieldId
                val details = WorkFields.lines(fields, obj.values).filter { it.first.id != identifierField && it.second != "—" }.joinToString(" · ") { "${it.first.label}: ${it.second}" }
                if (details.isNotEmpty()) Text(details, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    if (!vm.newObject) {
        TextButton(onClick = { vm.startNewObject() }) { Text(if (vm.objects.isEmpty()) "Cadastrar ${singular.lowercase()}" else "Cadastrar outro", color = c.brand) }
    } else if (objectType != null) {
        WbCard {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Novo cadastro de ${singular.lowercase()}", color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                WorkFieldsEditor(objectType.fields, vm.objectDraft, { vm.objectDraft = it }, WorkFields.required(objectType.fields))
            }
        }
    } else {
        Text("Não deu para carregar o cadastro de ${singular.lowercase()}. Volte e abra de novo.", color = c.danger, style = MaterialTheme.typography.bodySmall)
    }
}
