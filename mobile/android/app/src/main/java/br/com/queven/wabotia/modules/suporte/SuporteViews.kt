package br.com.queven.wabotia.modules.suporte

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb

/**
 * A faixa no topo da conversa quando um módulo passou o cliente à equipe: de onde veio, o resumo e os marcadores como
 * avisos ao atendente e, com o Suporte pago ligado, a situação e as ações (vincular, confirmar e liberar, cortesia)
 * para quem atende a conversa ou é administrador. Toque abre e fecha o resumo inteiro.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HandoffBand(
    handoff: ModuleHandoff?,
    suporte: SuporteStatus?,
    canAct: Boolean,
    busy: String?,
    onLink: () -> Unit,
    onConfirm: () -> Unit,
    onCourtesy: () -> Unit,
    modifier: Modifier = Modifier,
    startExpanded: Boolean = false,
) {
    if (handoff == null && suporte == null) return
    val c = Wb.colors
    var expanded by rememberSaveable { mutableStateOf(startExpanded) }
    Column(modifier.fillMaxWidth().background(if (c.isDark) c.surface else c.background).background(c.soft(c.bot, 0.08f)).testTag("conversation.handoff")) {
        Row(
            Modifier.fillMaxWidth().clickable(onClickLabel = if (expanded) "Recolher a passagem" else "Ver a passagem inteira") { expanded = !expanded }.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(Icons.Filled.VerifiedUser, contentDescription = null, tint = c.bot, modifier = Modifier.size(20.dp).padding(top = 1.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                val title = handoff?.let { "Passada pelo ${SuporteRules.moduleName(it.module)}" } ?: "Suporte pago"
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold, fontSize = 13.5.sp)
                    if (expanded) handoff?.at?.let { Text(BrasiliaTime.shortWithTime(it), color = c.textSecondary, fontSize = 12.sp) }
                }
                handoff?.summary?.trim()?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = c.textSecondary, fontSize = 13.sp, maxLines = if (expanded) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
                }
                // Na faixa recolhida, um aviso por linha; aberta, o texto inteiro.
                handoff?.visibleFlags?.forEach { flag -> FlagPill(flag, if (expanded) Int.MAX_VALUE else 1) }
                suporte?.let { s ->
                    Text(
                        "Suporte pago · " + SuporteRules.statusText(s), color = if (s.allowed == true && s.awaitingTeam != true) c.ok else c.warn,
                        fontSize = 12.5.sp, fontWeight = FontWeight.Medium, modifier = Modifier.testTag("suporte.status"),
                    )
                }
            }
            Icon(if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, contentDescription = null, tint = c.muted, modifier = Modifier.size(20.dp))
        }
        val s = suporte
        if (canAct && s != null && (SuporteRules.canLink(s) || SuporteRules.canConfirm(s) || SuporteRules.canCourtesy(s))) {
            FlowRow(Modifier.padding(start = 44.dp, end = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (SuporteRules.canLink(s)) ActionChip(SuporteRules.linkTitle(s), Icons.Filled.Link, c.brand, busy == "link", busy == null, "suporte.link", onLink)
                if (SuporteRules.canConfirm(s)) ActionChip("Confirmar e liberar", Icons.Filled.CheckCircle, c.ok, busy == "confirm", busy == null, "suporte.confirm", onConfirm)
                if (SuporteRules.canCourtesy(s)) ActionChip("Liberar como cortesia", Icons.Filled.CardGiftcard, c.bot, busy == "courtesy", busy == null, "suporte.courtesy", onCourtesy)
            }
        }
        HorizontalDivider(color = c.hairline)
    }
}

@Composable
private fun FlagPill(text: String, maxLines: Int) {
    val c = Wb.colors
    Row(Modifier.clip(RoundedCornerShape(50)).background(c.soft(c.warn, 0.12f)).padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = c.warn, modifier = Modifier.size(13.dp))
        Spacer(Modifier.width(4.dp))
        Text(text, color = if (c.isDark) c.textPrimary else c.warn, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ActionChip(label: String, icon: ImageVector, color: Color, loading: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val c = Wb.colors
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(c.soft(color, 0.14f)).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp, vertical = 7.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = color)
        else Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = if (c.isDark) c.textPrimary else color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Confirmação de vincular o telefone e de confirmar e liberar. */
@Composable
fun SuporteConfirmDialog(action: String, status: SuporteStatus?, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val c = Wb.colors
    val link = action == "link"
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (link) SuporteRules.linkTitle(status) + "?" else "Confirmar e liberar?") },
        text = {
            Text(
                if (link) "O número desta conversa passa a ser um telefone autorizado do pagador. Da próxima vez, o cliente é reconhecido sem informar o CPF ou CNPJ."
                else "Você confere que quem está na conversa fala pelo pagador. O telefone é vinculado e o atendimento fica liberado.",
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text(if (link) "Vincular" else "Confirmar e liberar", color = if (link) c.brand else c.ok, fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Voltar") } },
    )
}

/** Liberar sem pagamento: o motivo fica registrado e a validade é até o protocolo fechar ou por horas. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CourtesyDialog(onRelease: (String, Int?) -> Unit, onDismiss: () -> Unit) {
    val c = Wb.colors
    var reason by remember { mutableStateOf("") }
    var hours by remember { mutableStateOf<Int?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Liberar como cortesia") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("O cliente é atendido sem pagar desta vez. Fica registrado quem liberou, o motivo e até quando.")
                OutlinedTextField(
                    reason, { reason = it.take(300) }, label = { Text("Motivo") }, placeholder = { Text("Ex.: cliente antigo, problema nosso") },
                    modifier = Modifier.fillMaxWidth().testTag("suporte.courtesy.reason"),
                )
                Text("Validade", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    SuporteRules.COURTESY_OPTIONS.forEach { (h, title) -> WbFilterChip(title, hours == h, { hours = h }) }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onRelease(reason.trim(), hours) }, enabled = reason.isNotBlank(), modifier = Modifier.testTag("suporte.courtesy.confirm")) {
                Text("Liberar", color = if (reason.isNotBlank()) c.bot else c.muted, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Voltar") } },
    )
}
