package br.com.queven.wabotia.modules.cobranca

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb

@Composable
internal fun webStepColor(status: String?): Color {
    val c = Wb.colors
    return when (status) {
        "sent" -> c.ticket
        "opened" -> c.warn
        "completed" -> c.ok
        else -> c.muted
    }
}

@Composable
internal fun paymentColor(status: String?): Color {
    val c = Wb.colors
    return when (status) {
        "created" -> c.warn
        "paid" -> c.ok
        "expired", "refunded" -> c.danger
        else -> c.muted
    }
}

/** A faixa de links e cobranças no topo da conversa: um chip por item, com o estado. Toque abre a lista completa. */
@Composable
fun ConversationItemsBar(steps: List<WebStep>, payments: List<ConversationPayment>, onClick: () -> Unit) {
    if (steps.isEmpty() && payments.isEmpty()) return
    val c = Wb.colors
    Column(Modifier.fillMaxWidth().background(if (c.isDark) c.surface else c.background).clickable(onClickLabel = "Ver formulários e cobranças", onClick = onClick).testTag("conversation.items")) {
        LazyRow(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(payments, key = { "p-${it.id}" }) { p ->
                Chip(if (p.method == "link") Icons.Filled.Link else Icons.Filled.QrCode2, "${Money.format(p.amountCents ?: 0)} · ${ConversationItemsRules.paymentLabel(p.status)}", paymentColor(p.status))
            }
            items(steps, key = { "s-${it.id}" }) { s ->
                Chip(Icons.Filled.Description, "${ConversationItemsRules.stepTitle(s)} · ${ConversationItemsRules.webStepLabel(s.status)}", webStepColor(s.status))
            }
        }
        HorizontalDivider(color = c.hairline)
    }
}

@Composable
private fun Chip(icon: ImageVector, text: String, color: Color) {
    val c = Wb.colors
    Row(Modifier.clip(RoundedCornerShape(50)).background(c.soft(color, 0.12f)).padding(horizontal = 9.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(4.dp))
        Text(text, color = if (c.isDark) c.textPrimary else color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/**
 * Formulários e cobranças da conversa: cada cobrança com forma, valor, estado, validade e o Pix ou link para copiar; cada
 * link com o estado e as respostas do formulário. "Enviar formulário" e "Cobrar" no fim, quando o módulo está ligado e a
 * conversa é de quem atende.
 */
@Composable
fun ConversationItemsSheet(
    steps: List<WebStep>,
    payments: List<ConversationPayment>,
    canForm: Boolean,
    canCharge: Boolean,
    onForm: () -> Unit,
    onCharge: () -> Unit,
    onCopied: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Wb.colors
    val clipboard = LocalClipboard.current
    fun copy(label: String, value: String) {
        clipboard.nativeClipboard.setPrimaryClip(ClipData.newPlainText(label, value))
        onCopied("$label copiado")
    }
    WbBottomSheet(onDismiss = onDismiss, title = "Formulários e cobranças", subtitle = "Pago só vale com a confirmação do Mercado Pago: mensagem ou comprovante do cliente não mudam o estado.") {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (steps.isEmpty() && payments.isEmpty()) Text("Nada enviado nesta conversa.", color = c.textSecondary, modifier = Modifier.padding(vertical = 8.dp))
            payments.forEach { p ->
                WbCard(Modifier.testTag("conversation.payment")) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (p.method == "link") Icons.Filled.Link else Icons.Filled.QrCode2, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("${ConversationItemsRules.methodLabel(p.method)} · ${Money.format(p.amountCents ?: 0)}", Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                            Pill(ConversationItemsRules.paymentLabel(p.status), paymentColor(p.status))
                        }
                        p.description?.takeIf { it.isNotBlank() }?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                        val dates = listOfNotNull(
                            p.created?.let { "Enviada ${BrasiliaTime.shortWithTime(it)}" },
                            p.paidAt?.let { "paga ${BrasiliaTime.shortWithTime(it)}" } ?: p.expiresAt?.takeIf { p.status == "created" }?.let { "vale até ${BrasiliaTime.shortWithTime(it)}" },
                        ).joinToString(" · ")
                        if (dates.isNotEmpty()) Text(dates, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                        if (ConversationItemsRules.isActive(p)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                p.pixCode?.takeIf { it.isNotBlank() }?.let { code -> CopyButton("Copiar Pix") { copy("Pix", code) } }
                                p.url?.takeIf { it.isNotBlank() }?.let { url -> CopyButton("Copiar link") { copy("Link", url) } }
                            }
                        }
                    }
                }
            }
            steps.forEach { s ->
                WbCard(Modifier.testTag("conversation.webstep")) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Description, contentDescription = null, tint = webStepColor(s.status), modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(ConversationItemsRules.stepTitle(s), Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Pill(ConversationItemsRules.webStepLabel(s.status), webStepColor(s.status))
                        }
                        val subtitle = when {
                            s.completedAt != null -> "Respondido ${BrasiliaTime.shortWithTime(s.completedAt)}"
                            s.openedAt != null -> "Aberto ${BrasiliaTime.shortWithTime(s.openedAt)}"
                            s.expiresAt != null && ConversationItemsRules.isActive(s) -> "Vale até ${BrasiliaTime.shortWithTime(s.expiresAt)}"
                            else -> s.created?.let { "Enviado ${BrasiliaTime.shortWithTime(it)}" }
                        }
                        subtitle?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                        val answers = ConversationItemsRules.answers(s)
                        if (answers.isNotEmpty()) {
                            HorizontalDivider(color = c.hairline, modifier = Modifier.padding(vertical = 4.dp))
                            answers.forEach { (label, value) ->
                                Column {
                                    Text(label, color = c.textSecondary, style = MaterialTheme.typography.labelSmall)
                                    Text(value, color = c.textPrimary, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
            }
            if (canForm) PrimaryButton("Enviar formulário", onForm, Modifier.testTag("conversation.form"), icon = Icons.Filled.Description)
            if (canCharge) PrimaryButton("Cobrar", onCharge, Modifier.testTag("conversation.charge"), icon = Icons.Filled.Payments, color = c.ok)
        }
    }
}

@Composable
private fun CopyButton(label: String, onClick: () -> Unit) {
    val c = Wb.colors
    TextButton(onClick = onClick) {
        Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = c.brand, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = c.brand, fontWeight = FontWeight.SemiBold)
    }
}

/** "Enviar formulário": os formulários ativos da área; o cliente recebe um link de uso único. */
@Composable
fun FormPickerSheet(vm: FormsPaymentsViewModel, windowClosed: Boolean, onDismiss: () -> Unit) {
    val c = Wb.colors
    LaunchedEffect(Unit) { vm.error = null; vm.loadForms() }
    WbBottomSheet(onDismiss = onDismiss, title = "Enviar formulário", subtitle = "O cliente recebe um link de uso único.") {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (windowClosed) InlineNotice("A janela de 24 horas está fechada: o link só sai depois que o cliente escrever.", color = c.warn)
            (vm.error ?: vm.formsError)?.let { InlineNotice(it, Modifier.testTag("form.error")) }
            val forms = vm.forms
            when {
                forms == null && vm.formsError == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).padding(16.dp), color = c.brand)
                forms != null && forms.isEmpty() -> Text("Nenhum formulário ativo. Um administrador cria em Gestão → Formulários.", color = c.textSecondary)
                else -> forms.orEmpty().forEach { form ->
                    WbCard(Modifier.testTag("form.${form.id}"), onClick = { if (vm.busy == null) vm.sendForm(form, onSent = onDismiss) }) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(form.displayName, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                                Text(if (form.fields.size == 1) "1 campo" else "${form.fields.size} campos", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                            }
                            if (vm.busy == "form") CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.brand)
                            else Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Enviar", tint = c.brand)
                        }
                    }
                }
            }
        }
    }
}

/** "Cobrar": Pix (QR e copia e cola) ou link de pagamento, com valor e descrição. A confirmação é do provedor. */
@Composable
fun ChargeSheet(vm: FormsPaymentsViewModel, windowClosed: Boolean, onDismiss: () -> Unit) {
    val c = Wb.colors
    var method by remember { mutableStateOf("pix") }
    var amount by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { vm.error = null }
    val cents = ConversationItemsRules.amount(amount)
    val valid = cents != null && ConversationItemsRules.validDescription(description)
    WbBottomSheet(onDismiss = onDismiss, title = "Cobrar", subtitle = "Pelo Mercado Pago, na conversa do cliente.") {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SegmentedTabs(listOf("pix" to "Pix", "link" to "Link de pagamento"), method, { method = it })
            Text(
                if (method == "pix") "O cliente recebe o botão do QR Code e o código copia e cola numa mensagem separada." else "O cliente recebe o botão \"Pagar agora\" (cartão, Pix e outros meios).",
                color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
            )
            OutlinedTextField(
                amount, { amount = it.take(14) }, label = { Text("Valor (R$)") }, placeholder = { Text("0,00") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth().testTag("charge.amount"),
            )
            OutlinedTextField(
                description, { description = it.take(120) }, label = { Text("Descrição") }, placeholder = { Text("Ex.: consulta, sinal, mensalidade") }, singleLine = true,
                supportingText = { Text("${description.length}/120") }, modifier = Modifier.fillMaxWidth().testTag("charge.description"),
            )
            if (amount.isNotBlank() && cents == null) InlineNotice("Valor entre R$ 0,01 e R$ 100.000,00. Use, por exemplo, 49,90.")
            if (windowClosed) InlineNotice("A janela de 24 horas está fechada: a cobrança só sai depois que o cliente escrever.", color = c.warn)
            vm.error?.let { InlineNotice(it, Modifier.testTag("charge.error")) }
            PrimaryButton(
                "Enviar cobrança de ${Money.format(cents ?: 0)}", { vm.charge(method, amount, description, onSent = onDismiss) },
                Modifier.testTag("charge.submit"), loading = vm.busy == "charge", enabled = valid, icon = Icons.AutoMirrored.Filled.Send,
            )
            Text("O pagamento só é confirmado pelo Mercado Pago. \"Já paguei\" ou comprovante do cliente não mudam o estado.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
    }
}
