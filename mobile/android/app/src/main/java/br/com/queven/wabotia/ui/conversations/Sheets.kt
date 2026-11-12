@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.Message
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.obj
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.IconBubble
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SheetAction
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WindowInfo
import br.com.queven.wabotia.ui.components.WindowRing
import br.com.queven.wabotia.ui.theme.Wb

// Folhas e diálogos da conversa: etiquetas, ações da mensagem, nota interna, janela de 24 h, bots, grupo.

/** Campo arredondado usado nas folhas (etiqueta, título do protocolo, nota). */
@Composable
internal fun SheetField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minHeight: Int = 46,
    enabled: Boolean = true,
    background: Color? = null,
    onDone: (() -> Unit)? = null,
) {
    val c = Wb.colors
    Box(
        modifier.fillMaxWidth().heightIn(min = minHeight.dp).clip(RoundedCornerShape(if (singleLine) 23.dp else 16.dp)).background(background ?: c.field).padding(horizontal = 16.dp, vertical = 12.dp),
        contentAlignment = if (singleLine) Alignment.CenterStart else Alignment.TopStart,
    ) {
        if (value.isEmpty()) Text(placeholder, color = c.textSecondary, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = singleLine,
            maxLines = if (singleLine) 1 else 6,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.textPrimary),
            cursorBrush = SolidColor(c.brand),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = if (onDone != null) ImeAction.Done else ImeAction.Default),
            keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Etiquetas da conversa em pílulas editáveis (action: tags, até 20 de 40 caracteres). */
@Composable
internal fun TagsSheet(current: List<String>, onSave: (List<String>) -> Unit, onDismiss: () -> Unit) {
    val c = Wb.colors
    var tags by remember { mutableStateOf(current) }
    var input by remember { mutableStateOf("") }
    fun addInput() {
        val value = input.trim().trimStart('#').take(40)
        if (value.isNotEmpty() && tags.none { it.equals(value, ignoreCase = true) } && tags.size < 20) tags = tags + value
        input = ""
    }
    WbBottomSheet(onDismiss = onDismiss, title = "Etiquetas") {
        Column(Modifier.padding(horizontal = 20.dp).imePadding()) {
            if (tags.isEmpty()) {
                Text("Nenhuma etiqueta nesta conversa.", color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
            } else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    tags.forEach { tag ->
                        Row(
                            Modifier.clip(CircleShape).background(c.soft(c.brand, 0.15f)).clickable { tags = tags - tag }.padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(tag, color = c.brand, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Spacer(Modifier.width(4.dp))
                            Icon(Icons.Filled.Close, contentDescription = "Remover $tag", tint = c.brand, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                SheetField(input, { if (it.length <= 40) input = it }, "Nova etiqueta", Modifier.weight(1f), onDone = { addInput() })
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier.size(46.dp).clip(CircleShape).background(if (input.isNotBlank()) c.brand else c.field).clickable(enabled = input.isNotBlank()) { addInput() },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Add, contentDescription = "Adicionar etiqueta", tint = if (input.isNotBlank()) c.onBrand else c.muted) }
            }
            Text("Até 20 etiquetas de 40 caracteres. Toque em uma etiqueta para remover.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp, bottom = 14.dp))
            PrimaryButton("Salvar etiquetas", onClick = {
                if (input.isNotBlank()) addInput()
                onSave(tags)
            })
        }
    }
}

/** Nota interna: fica só para a equipe, nunca vai ao WhatsApp. */
@Composable
internal fun NoteSheet(busy: Boolean, error: String?, onSend: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Wb.colors
    var text by remember { mutableStateOf("") }
    WbBottomSheet(onDismiss = onDismiss, title = "Nota interna", subtitle = "Só a equipe vê. Não é enviada ao cliente.") {
        Column(Modifier.padding(horizontal = 20.dp).imePadding()) {
            SheetField(text, { if (it.length <= 3800) text = it }, "Escreva a nota…", singleLine = false, minHeight = 110, enabled = !busy, background = c.bubbleNote)
            error?.let { InlineNotice(it, Modifier.padding(top = 10.dp)) }
            Spacer(Modifier.height(14.dp))
            PrimaryButton("Registrar nota", onClick = { onSend(text) }, loading = busy, enabled = text.isNotBlank(), icon = Icons.Filled.Lock)
        }
    }
}

/** Explica a regra da janela de 24 h em três linhas (toque na faixa da conversa). */
@Composable
internal fun WindowInfoSheet(info: WindowInfo, onDismiss: () -> Unit) {
    val c = Wb.colors
    WbBottomSheet(onDismiss = onDismiss, title = "Janela de 24 horas") {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WindowRing(info, size = 44.dp, strokeWidth = 4.dp)
                Spacer(Modifier.width(14.dp))
                Column {
                    Text(if (info.closed) "Janela fechada" else "${info.longText()} restantes", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                    Text(
                        if (info.closed) "Só volta quando o cliente escrever" else "Aberta ${info.untilText()}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textSecondary,
                    )
                }
            }
            Spacer(Modifier.height(16.dp))
            RuleLine(Icons.Filled.Schedule, "O WhatsApp só aceita mensagem livre até 24 horas depois da última mensagem do cliente.")
            RuleLine(Icons.Filled.Refresh, "Cada nova mensagem do cliente reinicia o prazo e o anel volta a encher.")
            RuleLine(Icons.Filled.Lock, "Com a janela fechada, sua mensagem fica na fila e é entregue quando o cliente escrever de novo.")
        }
    }
}

@Composable
private fun RuleLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, tint = Wb.colors.brand, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = Wb.colors.textPrimary)
    }
}

/** Consultar bot: lista os bots habilitados (GET /bots) e abre o chat do bot com o contexto da conversa. */
@Composable
internal fun BotsSheet(bots: List<Bot>?, onPick: (Bot) -> Unit, onDismiss: () -> Unit) {
    WbBottomSheet(onDismiss = onDismiss, title = "Consultar bot", subtitle = "A pergunta leva o contexto desta conversa. O cliente não vê.") {
        when {
            bots == null -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Wb.colors.brand) }
            bots.isEmpty() -> Text("Nenhum bot habilitado neste perfil.", modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp), color = Wb.colors.textSecondary)
            else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(bots, key = { it.id }) { bot ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onPick(bot) }.padding(horizontal = 20.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(bot.name, seed = bot.id, size = 44.dp, kind = AvatarKind.Bot)
                        Spacer(Modifier.width(14.dp))
                        Column {
                            Text(bot.name.ifBlank { "Bot" }, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = Wb.colors.textPrimary)
                            if (bot.remote_profile.isNotBlank()) Text(bot.remote_profile, style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary)
                        }
                    }
                }
            }
        }
    }
}

/** Mencionar participante do grupo (capabilities.mentions). */
@Composable
internal fun MentionSheet(members: List<GroupMember>, onPick: (GroupMember) -> Unit, onDismiss: () -> Unit) {
    WbBottomSheet(onDismiss = onDismiss, title = "Mencionar participante") {
        if (members.isEmpty()) {
            Text(
                "Os participantes do grupo ainda não foram carregados. Atualize os dados do grupo no painel.",
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                color = Wb.colors.textSecondary,
            )
        } else {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(members, key = { it.id }) { member ->
                    Row(Modifier.fillMaxWidth().clickable { onPick(member) }.padding(horizontal = 20.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(member.display, seed = member.id, size = 40.dp)
                        Spacer(Modifier.width(14.dp))
                        Column {
                            Text(member.display, style = MaterialTheme.typography.bodyLarge, color = Wb.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (member.admin) Text("Administrador do grupo", style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary)
                        }
                    }
                }
            }
        }
    }
}

/** Política de resposta do bot em grupo (PUT /groups/{id}/policy). */
@Composable
internal fun GroupPolicyDialog(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    var selected by remember { mutableStateOf(current.ifBlank { "mentions" }) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Respostas do bot no grupo") },
        text = {
            Column {
                listOf("off", "mentions", "all").forEach { option ->
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = selected == option, onClick = { selected = option }).padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selected == option, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = Wb.colors.brand))
                        Spacer(Modifier.width(12.dp))
                        Text(botPolicyLabel(option), color = Wb.colors.textPrimary)
                    }
                }
                Text(
                    "O controle de atendimento humano continua valendo: devolva ao bot quando quiser que ele responda.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Wb.colors.textSecondary,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onPick(selected) }, enabled = selected != current) { Text("Salvar", fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

/** Confirmação de exclusão no WhatsApp. */
@Composable
internal fun DeleteMessageDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Apagar mensagem?") },
        text = { Text("A mensagem também é apagada no WhatsApp do cliente. O registro de auditoria do atendimento é mantido.") },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Apagar", color = Wb.colors.danger, fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

/** Mensagem que falhou: mostra o erro e oferece "Tentar de novo". */
@Composable
internal fun FailedMessageDialog(error: String?, canRetry: Boolean, onRetry: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { IconBubble(Icons.Filled.Refresh, Wb.colors.danger) },
        title = { Text("A mensagem não foi entregue") },
        text = { Text(error?.takeIf { it.isNotBlank() } ?: "O WhatsApp não confirmou o envio desta mensagem.") },
        confirmButton = { if (canRetry) TextButton(onClick = onRetry) { Text("Tentar de novo", fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Fechar") } },
    )
}

private val reactionChoices = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

/**
 * Ações por mensagem (toque longo): barra de reações (👍 ❤️ 😂 😮 😢 🙏) acima e menu (Responder, Copiar, Editar, Apagar,
 * Marcar como lida), só o que `capabilities` e a posse da conversa permitem. Editar: só enviadas, sem anexo, < 15 min.
 */
@Composable
internal fun MessageActionsSheet(
    message: Message,
    detail: ConversationDetail,
    own: Boolean,
    busy: Boolean,
    onReply: () -> Unit,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onMarkRead: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Wb.colors
    val clipboard = LocalClipboardManager.current
    val content = remember(message.content) { message.contentJson }
    val deleted = content.bool("deleted") == true
    val sendable = message.external_id != null && !message.isNote && !deleted && own
    val canEdit = sendable && detail.can("edit") && message.direction == "outbound" &&
        System.currentTimeMillis() - message.created < 15 * 60 * 1000 && message.attachmentIds.isEmpty()
    val canDelete = sendable && detail.can("delete") && message.direction == "outbound"
    val canRead = sendable && detail.can("read") && message.isIncoming
    val reactions = content.obj("reactions")

    WbBottomSheet(onDismiss = onDismiss) {
        if (sendable && detail.can("reaction")) {
            Row(
                Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(CircleShape).background(c.field).padding(horizontal = 6.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                reactionChoices.forEach { emoji ->
                    Box(Modifier.size(46.dp).clip(CircleShape).clickable(enabled = !busy) { onReact(emoji) }, contentAlignment = Alignment.Center) {
                        Text(emoji, fontSize = 26.sp)
                    }
                }
                if (reactions != null && reactions.isNotEmpty()) {
                    Box(Modifier.size(46.dp).clip(CircleShape).clickable(enabled = !busy) { onReact("") }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, contentDescription = "Remover reação", tint = c.textSecondary)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }
        Text(
            message.text.ifBlank { if (message.attachmentIds.isNotEmpty()) "Anexo" else "Mensagem" },
            style = MaterialTheme.typography.bodyMedium,
            color = c.textSecondary,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (sendable && detail.can("reply")) SheetAction(Icons.AutoMirrored.Filled.Reply, "Responder", onClick = onReply)
        if (message.text.isNotBlank() && !deleted) {
            SheetAction(Icons.Filled.ContentCopy, "Copiar", tint = c.textSecondary, onClick = {
                clipboard.setText(AnnotatedString(message.text))
                onDismiss()
            })
        }
        if (canEdit) SheetAction(Icons.Filled.Edit, "Editar", tint = c.ticket, onClick = onEdit)
        if (canRead) SheetAction(Icons.Filled.DoneAll, "Marcar como lida", tint = c.tickRead, onClick = onMarkRead)
        if (canDelete) SheetAction(Icons.Filled.Delete, "Apagar", tint = c.danger, onClick = onDelete)
        if (!own && !message.isNote) {
            Text(
                "Assuma a conversa para responder, reagir ou alterar mensagens.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
            )
        }
    }
}
