package br.com.queven.wabotia.ui.team

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Gavel
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.model.Approval
import br.com.queven.wabotia.core.model.ProposalPayload
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.theme.Wb

/** Moldura comum dos cartões do bot. */
@Composable
private fun BotCard(icon: ImageVector, tint: Color, header: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Wb.colors
    Column(
        modifier
            .widthIn(max = 380.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(c.surface)
            .border(1.dp, c.soft(tint, 0.45f), RoundedCornerShape(16.dp))
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(header, style = MaterialTheme.typography.labelMedium, color = tint, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(8.dp))
        content()
    }
}

@Composable
private fun StatusPill(text: String, tone: Color) = Pill(text, tone)

@Composable
private fun ParamRows(rows: List<Pair<String, String>>) {
    val c = Wb.colors
    rows.forEach { (k, v) ->
        Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
            Text(k, style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.width(110.dp))
            Text(v, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
        }
    }
}

/** Proposta de ação: o resumo do bot, a operação do catálogo, os parâmetros para conferir, o prazo e Confirmar/Cancelar. */
@Composable
fun ProposalCard(payload: ProposalPayload, now: Long, busy: Boolean, onConfirm: () -> Unit, onCancel: () -> Unit) {
    val c = Wb.colors
    val p = payload.proposal
    val status = BotActionTexts.effectiveStatus(p, now)
    val tone = when (status) {
        "pending", "running" -> c.bot
        "done" -> c.ok
        "failed" -> c.danger
        else -> c.muted
    }
    BotCard(Icons.Filled.SmartToy, c.bot, "Proposta do bot", Modifier.testTag("bot.proposal")) {
        Text(p.summary, style = MaterialTheme.typography.titleSmall, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
        payload.operationSummary?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary) }
        val params = BotActionTexts.params(p.params)
        if (params.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            ParamRows(params)
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(BotActionTexts.proposalStatus(status), tone)
            if (status == "pending") BotActionTexts.countdown(p.expiresAt, now)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = c.textSecondary) }
        }
        if (status == "pending" && p.sensitive) {
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = c.warn, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text("Ação sensível: o app vai pedir o código do autenticador.", style = MaterialTheme.typography.labelSmall, color = c.warn)
            }
        }
        BotActionTexts.outcome(p)?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.bodySmall, color = if (status == "failed") c.danger else c.textPrimary)
        }
        if (status == "pending" && "confirm" in payload.actions.ifEmpty { listOf("confirm", "cancel") }) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onConfirm, enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = c.bot), modifier = Modifier.testTag("bot.confirm")) {
                    if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White) else Text("Confirmar")
                }
                OutlinedButton(onClick = onCancel, enabled = !busy) { Text("Cancelar") }
            }
        }
    }
}

/** Resultado de uma proposta: o que foi feito ou por que não foi. */
@Composable
fun ResultCard(payload: ProposalPayload) {
    val c = Wb.colors
    val p = payload.proposal
    val ok = p.status == "done"
    BotCard(
        if (ok) Icons.Filled.CheckCircle else Icons.Filled.Error,
        if (ok) c.ok else if (p.status == "failed") c.danger else c.muted,
        if (ok) "Feito" else if (p.status == "failed") "Não foi possível" else BotActionTexts.proposalStatus(p.status),
        Modifier.testTag("bot.result"),
    ) {
        Text(p.summary, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
        BotActionTexts.outcome(p)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (ok) c.textSecondary else c.danger) }
    }
}

/**
 * Pedido de aprovação: os campos do módulo como vêm, quantos ficaram ocultos, o resumo do bot separado (não verificado),
 * o estado e quem decidiu; com `pending` e `can_decide`, Aprovar (com ajuste opcional), Recusar (com motivo) e Assumir.
 */
@Composable
fun ApprovalCard(approval: Approval, now: Long, busy: Boolean, onApprove: (Double?) -> Unit, onDecline: (String?) -> Unit, onHandoff: () -> Unit) {
    val c = Wb.colors
    var approving by remember { mutableStateOf(false) }
    var declining by remember { mutableStateOf(false) }
    val expired = approval.status == "pending" && approval.expiresAt != null && approval.expiresAt <= now
    val status = if (expired) "expired" else approval.status
    val tone = when (status) {
        "approved" -> c.ok
        "declined" -> c.danger
        "pending", "deciding" -> c.warn
        else -> c.muted
    }
    BotCard(Icons.Filled.Gavel, c.warn, "Pedido de aprovação", Modifier.testTag("bot.approval")) {
        Text(approval.title, style = MaterialTheme.typography.titleSmall, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
        if (approval.fields.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            ParamRows(approval.fields.map { it.label.ifBlank { it.key } to it.text })
        }
        if (approval.hiddenFields > 0) {
            Text(
                if (approval.hiddenFields == 1) "1 campo restrito não aparece para você." else "${approval.hiddenFields} campos restritos não aparecem para você.",
                style = MaterialTheme.typography.labelSmall,
                color = c.textSecondary,
            )
        }
        approval.modelSummary?.takeIf { it.isNotBlank() }?.let { summary ->
            Spacer(Modifier.height(8.dp))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.soft(c.bot, 0.10f)).padding(10.dp)) {
                Text("Resumo do bot (não verificado)", style = MaterialTheme.typography.labelSmall, color = c.bot, fontWeight = FontWeight.SemiBold)
                Text(summary, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(BotActionTexts.approvalStatus(status), tone)
            if (status == "pending") BotActionTexts.countdown(approval.expiresAt, now)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = c.textSecondary) }
        }
        BotActionTexts.decided(approval, approval.adjust?.type == "money")?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
        }
        if (status == "pending" && approval.canDecide) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { approving = true }, enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = c.ok), modifier = Modifier.testTag("bot.approve")) {
                    if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White) else Text("Aprovar")
                }
                OutlinedButton(onClick = { declining = true }, enabled = !busy) { Text("Recusar") }
            }
            TextButton(onClick = onHandoff, enabled = !busy) { Text("Assumir a conversa") }
        }
    }

    if (approving) {
        var text by remember { mutableStateOf("") }
        var error by remember { mutableStateOf<String?>(null) }
        val adjust = approval.adjust
        AlertDialog(
            onDismissRequest = { approving = false },
            title = { Text("Aprovar?") },
            text = {
                Column {
                    Text(approval.title, style = MaterialTheme.typography.bodyMedium)
                    if (adjust != null) {
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = text,
                            onValueChange = { text = it; error = null },
                            label = { Text("${adjust.label} (opcional)") },
                            singleLine = true,
                            isError = error != null,
                            supportingText = { Text(error ?: "Em branco aprova como pedido.") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    BotActionTexts.parseAdjust(text, adjust)
                        .onSuccess { approving = false; onApprove(it) }
                        .onFailure { error = it.message }
                }) { Text("Aprovar", fontWeight = FontWeight.SemiBold, color = c.ok) }
            },
            dismissButton = { TextButton(onClick = { approving = false }) { Text("Voltar") } },
        )
    }
    if (declining) {
        var reason by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { declining = false },
            title = { Text("Recusar?") },
            text = {
                OutlinedTextField(value = reason, onValueChange = { reason = it.take(300) }, label = { Text("Motivo (opcional)") }, maxLines = 3)
            },
            confirmButton = { TextButton(onClick = { declining = false; onDecline(reason) }) { Text("Recusar", fontWeight = FontWeight.SemiBold, color = c.danger) } },
            dismissButton = { TextButton(onClick = { declining = false }) { Text("Voltar") } },
        )
    }
}

/** O código do autenticador, pedido quando a confirmação responde `403 mfa_required`. */
@Composable
fun MfaDialog(error: String?, onSubmit: (String) -> Unit, onDismiss: () -> Unit) {
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Filled.Lock, contentDescription = null, tint = Wb.colors.brand) },
        title = { Text("Código do autenticador") },
        text = {
            Column {
                Text("Esta ação pede o segundo fator. Digite o código de 6 dígitos do app autenticador, ou um código de recuperação.", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.take(32) },
                    singleLine = true,
                    label = { Text("Código") },
                    isError = error != null,
                    supportingText = error?.let { { Text(it) } },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                    modifier = Modifier.testTag("bot.mfa"),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSubmit(code) }, enabled = code.isNotBlank()) { Text("Confirmar", fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}
