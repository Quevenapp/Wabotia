@file:OptIn(ExperimentalLayoutApi::class)

package br.com.queven.wabotia.ui.conversations

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.automirrored.filled.Shortcut
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.SentimentSatisfiedAlt
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.media.AuthenticatedMedia
import br.com.queven.wabotia.core.model.MediaFile
import br.com.queven.wabotia.core.model.nameOf
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.EventPolling
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WindowRing
import br.com.queven.wabotia.ui.components.color
import br.com.queven.wabotia.ui.components.conversationBadge
import br.com.queven.wabotia.ui.components.formatPhone
import br.com.queven.wabotia.ui.components.formatWhen
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.components.windowInfo
import br.com.queven.wabotia.ui.theme.Wb
import br.com.queven.wabotia.ui.tickets.TicketCard
import coil.compose.AsyncImage

/**
 * Dados da conversa (DESIGN.md §7): contato, linha, anel grande da janela, estado e responsável, etiquetas, protocolos
 * desta conversa, mídia compartilhada e ações (salvar contato, consultar bot, pesquisa, devolver ao bot, concluir).
 */
@Composable
fun ConversationInfoScreen(
    container: AppContainer,
    conversationId: String,
    onBack: () -> Unit,
    openTicket: (String) -> Unit,
    newTicket: () -> Unit,
    openBot: (botId: String) -> Unit,
    openTransfer: () -> Unit,
) {
    val vm: ConversationViewModel = viewModel(key = "conversation-info:$conversationId") { ConversationViewModel(container, conversationId) }
    val profileId = container.session.profileId ?: ""
    val c = Wb.colors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val snackbar = remember { SnackbarHostState() }
    val now by rememberNow()

    EventPolling(container, profileId, onStart = { vm.load(silent = true); vm.loadTransferData() }, onEvents = { vm.onEvents(it) })
    LaunchedEffect(vm.notice) {
        val text = vm.notice ?: return@LaunchedEffect
        vm.notice = null
        snackbar.showSnackbar(text)
    }

    var tagsSheet by remember { mutableStateOf(false) }
    var botsSheet by remember { mutableStateOf(false) }
    var policyDialog by remember { mutableStateOf(false) }
    var confirmResolve by remember { mutableStateOf(false) }
    var viewer by remember { mutableStateOf<MediaFile?>(null) }

    val detail = vm.detail
    Box(Modifier.fillMaxSize().background(c.background)) {
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(title = "Dados da conversa", onBack = onBack)
            when {
                vm.loading && detail == null -> SkeletonList(rows = 6)
                detail == null -> ErrorState(vm.loadError ?: "Não foi possível carregar a conversa.", onRetry = { vm.load() })
                else -> {
                    val conversation = detail.conversation
                    val team = vm.teamById
                    val window = windowInfo(conversation, vm.lineKinds, now)
                    val status = container.profileData.cached(profileId)
                    val line = status?.connections?.firstOrNull { it.id == conversation.connection_id }
                    val departments = vm.departments.orEmpty()
                    val tags = conversation.tagList()
                    val images = remember(detail.media) { detail.media.filter { it.isImage() } }
                    val own = vm.isOwn
                    val canHandOff = own || vm.isAdmin

                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 24.dp)) {
                        // Cabeçalho
                        Column(Modifier.fillMaxWidth().padding(top = 20.dp, start = 24.dp, end = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Avatar(
                                conversation.displayName,
                                seed = conversation.id,
                                size = 96.dp,
                                kind = if (conversation.isGroup) AvatarKind.Group else AvatarKind.Person,
                                badge = conversationBadge(conversation, vm.meId),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(conversation.displayName, color = c.textPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            val phone = conversation.phone?.takeIf { it.isNotBlank() && !conversation.isGroup }
                            if (phone != null) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(formatPhone(phone), color = c.textSecondary, fontSize = 15.sp)
                                    IconButton(onClick = {
                                        clipboard.setText(AnnotatedString(phone))
                                        vm.notice = "Telefone copiado"
                                    }) { Icon(Icons.Filled.ContentCopy, contentDescription = "Copiar telefone", tint = c.textSecondary, modifier = Modifier.size(18.dp)) }
                                }
                            } else {
                                Spacer(Modifier.height(6.dp))
                            }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (line != null) Pill(line.name.ifBlank { "Linha de atendimento" }, c.brand)
                                Pill(conversation.stateSubtitle(vm.meId, team, now), stateColor(conversation.state, own))
                            }
                        }

                        // Janela de 24 h
                        if (window != null) {
                            SectionLabel("Janela de 24 horas")
                            WbCard(Modifier.padding(horizontal = 16.dp)) {
                                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                    WindowRing(window, size = 96.dp, strokeWidth = 7.dp) {
                                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                            if (window.closed) {
                                                Icon(Icons.Filled.Lock, contentDescription = null, tint = c.muted, modifier = Modifier.size(24.dp))
                                                Text("Fechada", color = c.muted, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                                            } else {
                                                val minutes = window.remainingMs / 60_000
                                                Text(
                                                    if (minutes >= 60) "${minutes / 60}h" else "${minutes.coerceAtLeast(1)}",
                                                    color = window.tone.color(),
                                                    fontSize = 24.sp,
                                                    fontWeight = FontWeight.Bold,
                                                    lineHeight = 26.sp,
                                                )
                                                Text(
                                                    if (minutes >= 60) "${(minutes % 60).toString().padStart(2, '0')}min" else "min",
                                                    color = window.tone.color(),
                                                    fontSize = 12.sp,
                                                    fontWeight = FontWeight.SemiBold,
                                                )
                                            }
                                        }
                                    }
                                    Spacer(Modifier.width(16.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            if (window.closed) "Janela fechada" else "${window.longText()} restantes",
                                            color = c.textPrimary,
                                            style = MaterialTheme.typography.titleMedium,
                                        )
                                        Text(
                                            if (window.closed) "Só volta quando o cliente escrever." else "Mensagem livre ${window.untilText()}.",
                                            color = c.textSecondary,
                                            style = MaterialTheme.typography.bodyMedium,
                                        )
                                        Spacer(Modifier.height(6.dp))
                                        Text(
                                            if (window.lastCustomer > 0) "Última mensagem do cliente: ${formatWhen(window.lastCustomer)}" else "O cliente ainda não escreveu.",
                                            color = c.textSecondary,
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                    }
                                }
                            }
                        }

                        // Estado e responsável
                        SectionLabel("Atendimento")
                        WbCard(Modifier.padding(horizontal = 16.dp)) {
                            InfoLine("Estado", conversation.stateText(vm.meId, team))
                            RowDivider(startIndent = 16.dp)
                            InfoLine(
                                "Responsável",
                                when {
                                    conversation.state == "human" && conversation.owner == vm.meId -> "Você"
                                    conversation.state == "human" -> team[conversation.owner]?.name ?: "Outro atendente"
                                    conversation.state == "ai" -> conversation.botName(team)?.let { "Bot $it" } ?: "Bot do atendimento"
                                    conversation.state == "waiting" -> "Ninguém ainda"
                                    else -> "—"
                                },
                            )
                            conversation.department_id?.let { id ->
                                departments.firstOrNull { it.id == id }?.let { department ->
                                    RowDivider(startIndent = 16.dp)
                                    InfoLine("Setor", department.name)
                                }
                            }
                            if (line != null) {
                                RowDivider(startIndent = 16.dp)
                                InfoLine("Linha", line.name + if (line.kind == "meta" || line.kind == "zernio") " · WhatsApp oficial" else "")
                            }
                            if (canHandOff) {
                                RowDivider(startIndent = 16.dp)
                                SettingsRow(Icons.AutoMirrored.Filled.Shortcut, "Encaminhar atendimento", subtitle = "Pessoas, bots, setores, menu e protocolo", onClick = openTransfer)
                            }
                        }

                        // Etiquetas
                        SectionLabel("Etiquetas")
                        WbCard(Modifier.padding(horizontal = 16.dp)) {
                            Row(Modifier.padding(start = 16.dp, end = 6.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (tags.isEmpty()) {
                                    Text("Nenhuma etiqueta", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                                } else {
                                    FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        tags.forEach { Pill(it, c.brand) }
                                    }
                                }
                                IconButton(onClick = { tagsSheet = true }) { Icon(Icons.Filled.Edit, contentDescription = "Editar etiquetas", tint = c.brand, modifier = Modifier.size(20.dp)) }
                            }
                        }

                        // Protocolos desta conversa
                        SectionLabel("Protocolos desta conversa")
                        val tickets = vm.tickets
                        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            when {
                                tickets == null -> WbCard { Text("Carregando…", color = c.textSecondary, modifier = Modifier.padding(16.dp)) }
                                tickets.isEmpty() -> WbCard { Text("Esta conversa ainda não tem protocolos.", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp)) }
                                else -> tickets.forEach { ticket ->
                                    TicketCard(
                                        ticket,
                                        ownerName = ticket.owner?.let { if (it == vm.meId) "Você" else team[it]?.name },
                                        now = now,
                                        onClick = { openTicket(ticket.id) },
                                        compact = true,
                                        categoryName = vm.ticketCategories.nameOf(ticket.category),
                                    )
                                }
                            }
                            if (canHandOff) {
                                SecondaryButton("Abrir protocolo", onClick = newTicket, icon = Icons.Filled.ConfirmationNumber, color = c.ticket)
                            }
                        }

                        // Mídia compartilhada
                        if (images.isNotEmpty()) {
                            SectionLabel("Mídia compartilhada")
                            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                images.take(9).chunked(3).forEach { row ->
                                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        row.forEach { media ->
                                            AsyncImage(
                                                model = AuthenticatedMedia.url(container, profileId, media.id, inline = true),
                                                contentDescription = media.name.ifBlank { "Imagem" },
                                                imageLoader = AuthenticatedMedia.imageLoader(container),
                                                contentScale = ContentScale.Crop,
                                                modifier = Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(c.field).clickable { viewer = media },
                                            )
                                        }
                                        repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                                    }
                                }
                            }
                        }

                        // Grupo
                        if (conversation.isGroup) {
                            SectionLabel("Grupo")
                            WbCard(Modifier.padding(horizontal = 16.dp)) {
                                SettingsRow(Icons.Filled.Groups, "Respostas do bot no grupo", subtitle = botPolicyLabel(conversation.bot_policy), onClick = { policyDialog = true })
                                RowDivider()
                                InfoLine("Participantes", detail.groupMembers().size.toString())
                            }
                        }

                        // Ações
                        SectionLabel("Ações")
                        WbCard(Modifier.padding(horizontal = 16.dp)) {
                            var first = true
                            @Composable
                            fun divider() {
                                if (!first) RowDivider()
                                first = false
                            }
                            if (!conversation.isGroup && !conversation.phone.isNullOrBlank()) {
                                divider()
                                SettingsRow(Icons.Filled.PersonAdd, "Salvar contato", subtitle = "Adicionar à agenda do aparelho", onClick = {
                                    if (!saveContact(context, conversation.displayName, conversation.phone)) vm.notice = "Nenhum aplicativo de contatos disponível."
                                })
                            }
                            divider()
                            SettingsRow(Icons.Filled.SmartToy, "Consultar bot", subtitle = "Pergunte a um bot com o contexto desta conversa", tint = c.bot, onClick = { vm.loadBots(); botsSheet = true })
                            if (canHandOff && !conversation.isGroup) {
                                divider()
                                SettingsRow(Icons.Filled.SentimentSatisfiedAlt, "Pesquisa de satisfação", subtitle = "Envia a pesquisa ao cliente", tint = c.warn, onClick = { vm.survey() }, enabled = !vm.busy)
                            }
                            if (own) {
                                divider()
                                SettingsRow(Icons.Filled.Undo, "Devolver ao bot", subtitle = "O bot do atendimento volta a responder", tint = c.bot, onClick = { vm.resume() }, enabled = !vm.busy)
                                divider()
                                SettingsRow(Icons.Filled.TaskAlt, "Concluir", subtitle = "Encerra este atendimento", tint = c.danger, titleColor = c.danger, onClick = { confirmResolve = true }, enabled = !vm.busy)
                            }
                        }
                    }

                    if (tagsSheet) TagsSheet(tags, onSave = { tagsSheet = false; vm.saveTags(it) }, onDismiss = { tagsSheet = false })
                    if (botsSheet) BotsSheet(vm.bots, onPick = { botsSheet = false; openBot(it.id) }, onDismiss = { botsSheet = false })
                    if (policyDialog) GroupPolicyDialog(conversation.bot_policy, onPick = { policyDialog = false; vm.setGroupPolicy(it) }, onDismiss = { policyDialog = false })
                    if (confirmResolve) {
                        AlertDialog(
                            onDismissRequest = { confirmResolve = false },
                            title = { Text("Concluir conversa?") },
                            text = { Text("O atendimento de ${conversation.displayName} será encerrado. Se o cliente escrever de novo, a conversa volta para a fila.") },
                            confirmButton = { TextButton(onClick = { confirmResolve = false; vm.resolve() }) { Text("Concluir", color = c.danger, fontWeight = FontWeight.SemiBold) } },
                            dismissButton = { TextButton(onClick = { confirmResolve = false }) { Text("Cancelar") } },
                        )
                    }
                    viewer?.let { media -> ImageViewerDialog(media, profileId, container) { viewer = null } }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
    }
}

@Composable
private fun stateColor(state: String, own: Boolean) = when (state) {
    "waiting" -> Wb.colors.warn
    "ai" -> Wb.colors.bot
    "human" -> if (own) Wb.colors.brand else Wb.colors.muted
    else -> Wb.colors.muted
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Wb.colors.textSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(110.dp))
        Text(value, color = Wb.colors.textPrimary, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
