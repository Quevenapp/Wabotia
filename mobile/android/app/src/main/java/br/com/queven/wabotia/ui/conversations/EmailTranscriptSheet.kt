package br.com.queven.wabotia.ui.conversations

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.*
import br.com.queven.wabotia.ui.components.WbBottomSheet
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.time.Instant

/** Prévia e tentativa vivem no ViewModel: fechar a folha não perde a chave de uma requisição incerta. */
@Composable
internal fun EmailTranscriptSheet(container: AppContainer, vm: ConversationViewModel, onDismiss: () -> Unit) {
    val options = vm.detail?.email_transcript
    var destination by remember { mutableStateOf(options?.destinations?.firstOrNull { it in setOf("self", "contact", "custom") }.orEmpty()) }
    var address by remember { mutableStateOf("") }
    var range by remember { mutableStateOf(options?.ranges?.firstOrNull { it in setOf("session", "dates") }.orEmpty()) }
    var from by remember { mutableStateOf("") }
    var to by remember { mutableStateOf("") }
    var confirmed by remember(vm.emailPreview?.previewToken) { mutableStateOf(false) }
    var requested by remember(vm.emailPreview?.previewToken) { mutableStateOf(false) }
    var validation by remember { mutableStateOf<String?>(null) }
    val preview = vm.emailPreview
    val result = vm.emailResult
    val locked = vm.emailBusy || vm.emailPending || preview != null

    WbBottomSheet(onDismiss = onDismiss, title = "Enviar conversa por e-mail") {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (options?.available != true) {
                Text(transcriptUnavailableMessage(options?.reason))
            } else if (vm.emailRejected) {
                Text("O servidor recusou esta tentativa. Você pode corrigir os dados e preparar uma nova prévia.")
                TextButton(onClick = vm::newEmail) { Text("Preparar outro envio") }
            } else if (result != null) {
                Text(when (result.status) {
                    "sent" -> "Conversa enviada para ${result.to_masked}."
                    "failed" -> "O envio falhou. Confira o registro antes de iniciar outro envio."
                    "reserved", "sending", "queued" -> "Envio registrado para ${result.to_masked}. Aguarde a confirmação no histórico de e-mail."
                    else -> "Resultado indeterminado. Confira o histórico de e-mail com a equipe antes de qualquer novo envio."
                })
                if (result.duplicate) Text("Esta tentativa já havia sido registrada; nenhum novo envio foi solicitado.")
                if (result.status in setOf("sent", "failed")) TextButton(onClick = vm::newEmail) { Text("Preparar outro envio") }
            } else {
                Text("A transcrição inclui apenas mensagens públicas. Notas internas e arquivos não são enviados.")
                Text("Até ${options.limits.maxMessages} mensagens. Se necessário, selecione um período menor.", style = MaterialTheme.typography.bodySmall)
                if (preview == null) {
                    Text("Destino", style = MaterialTheme.typography.titleSmall)
                    options.destinations.filter { it in setOf("self", "contact", "custom") }.forEach { value ->
                        Row {
                            RadioButton(selected = destination == value, enabled = !locked, onClick = { destination = value; vm.clearEmailPreview() })
                            Text(when (value) { "self" -> "Meu e-mail"; "contact" -> "E-mail do contato"; else -> "Outro endereço" }, Modifier.padding(top = 12.dp))
                        }
                    }
                    if (destination == "custom") OutlinedTextField(address, { address = it }, label = { Text("Endereço de e-mail") }, enabled = !locked, singleLine = true)
                    Text("Período", style = MaterialTheme.typography.titleSmall)
                    options.ranges.filter { it in setOf("session", "dates") }.forEach { value ->
                        Row {
                            RadioButton(selected = range == value, enabled = !locked, onClick = { range = value; vm.clearEmailPreview() })
                            Text(if (value == "session") "Este atendimento" else "Intervalo de datas", Modifier.padding(top = 12.dp))
                        }
                    }
                    if (range == "dates") {
                        OutlinedTextField(from, { from = it }, label = { Text("De (dd/mm/aaaa)") }, enabled = !locked, singleLine = true)
                        OutlinedTextField(to, { to = it }, label = { Text("Até (dd/mm/aaaa)") }, enabled = !locked, singleLine = true)
                    }
                    Button(enabled = !locked && destination in setOf("self", "contact", "custom") && range in setOf("session", "dates"), onClick = {
                        validation = null
                        val selectedRange = if (range == "dates") {
                            val formatter = DateTimeFormatter.ofPattern("dd/MM/uuuu").withResolverStyle(ResolverStyle.STRICT)
                            val zone = ZoneId.systemDefault()
                            val start = runCatching { LocalDate.parse(from.trim(), formatter).atStartOfDay(zone).toInstant().toEpochMilli() }.getOrNull()
                            val end = runCatching { LocalDate.parse(to.trim(), formatter).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli() - 1 }.getOrNull()
                            if (start == null || end == null || start > end) { validation = "Informe um intervalo de datas válido."; return@Button }
                            TranscriptRange(kind = "dates", from = start, to = end)
                        } else TranscriptRange(kind = "session")
                        if (destination == "custom" && address.trim().isBlank()) { validation = "Informe o endereço de e-mail."; return@Button }
                        vm.previewEmail(TranscriptPreviewRequest(TranscriptDestination(destination, address.trim().takeIf { destination == "custom" }), selectedRange))
                    }) { Text(if (vm.emailBusy) "Preparando…" else "Gerar prévia") }
                }
                if (preview != null) {
                    HorizontalDivider()
                    Text("Destinatário: ${preview.recipient}", style = MaterialTheme.typography.titleMedium)
                    val formatter = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm").withZone(ZoneId.systemDefault())
                    Text("${formatter.format(Instant.ofEpochMilli(preview.period.from))} a ${formatter.format(Instant.ofEpochMilli(preview.period.to))}")
                    Text("${preview.messageCount} mensagens · ${preview.size.textChars} caracteres de texto · ${preview.size.htmlChars} de HTML")
                    preview.warnings.forEach { Text(it) }
                    if (preview.requiresConfirmation || preview.requiresCustomerRequest) Row {
                        Checkbox(checked = confirmed, onCheckedChange = { confirmed = it }, enabled = !vm.emailBusy && !vm.emailPending)
                        Text("Confirmo o envio para ${preview.recipient}", Modifier.padding(top = 10.dp))
                    }
                    if (preview.requiresCustomerRequest) Row {
                        Checkbox(checked = requested, onCheckedChange = { requested = it }, enabled = !vm.emailBusy && !vm.emailPending)
                        Text("O cliente solicitou este envio", Modifier.padding(top = 10.dp))
                    }
                    val recipient = if (confirmed) preview.recipient else ""
                    Button(enabled = !vm.emailBusy && (vm.emailCanRetry || preview.canConfirm(recipient, requested, System.currentTimeMillis())), onClick = { vm.sendEmail(recipient, requested) }) {
                        Text(if (vm.emailBusy) "Enviando…" else if (vm.emailPending) "Repetir a mesma tentativa" else "Confirmar envio")
                    }
                    if (!vm.emailPending) TextButton(onClick = vm::clearEmailPreview, enabled = !vm.emailBusy) { Text("Alterar destino ou período") }
                }
            }
            (validation ?: vm.emailError)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            TextButton(onClick = onDismiss) { Text("Fechar") }
        }
    }
}

private fun transcriptUnavailableMessage(reason: String?): String = when (reason) {
    "not_configured", "email_not_configured", "email_unconfigured" -> "Configure o envio em Gestão → Sistema → E-mail."
    "forbidden", "permission_denied" -> "Você não tem permissão para enviar esta conversa por e-mail."
    null, "channel_not_ready" -> "O envio de conversa por e-mail ainda não está disponível neste servidor."
    else -> if (Regex("^[a-z][a-z0-9_]*$").matches(reason)) "O envio de conversa por e-mail está indisponível para esta conversa." else reason
}
