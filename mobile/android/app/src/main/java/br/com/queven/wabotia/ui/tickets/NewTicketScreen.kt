@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.tickets

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.TicketCreate
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import kotlinx.coroutines.launch
import java.io.IOException

private const val TITLE_MAX = 300

/** Abrir protocolo para uma conversa: título obrigatório (até 300) → POST /tickets → onCreated(id). */
@Composable
fun NewTicketScreen(container: AppContainer, conversationId: String, onBack: () -> Unit, onCreated: (ticketId: String) -> Unit) {
    val profileId = container.session.profileId ?: ""
    var title by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retryable by remember { mutableStateOf(false) }
    // Chave de idempotência por intenção: renovada quando o texto muda, mantida ao repetir após falha de rede.
    var key by rememberSaveable { mutableStateOf(ApiClient.newIdempotencyKey()) }
    val scope = rememberCoroutineScope()

    fun submit() {
        val t = title.trim()
        if (t.isEmpty()) { error = "Informe o título do protocolo."; return }
        if (t.length > TITLE_MAX) { error = "O título deve ter no máximo $TITLE_MAX caracteres."; return }
        if (profileId.isBlank()) { error = "Perfil não selecionado."; return }
        busy = true; error = null; retryable = false
        scope.launch {
            try {
                val ticket = container.api.createTicket(profileId, key, TicketCreate(conversation_id = conversationId, title = t))
                onCreated(ticket.id)
            } catch (e: ApiException) {
                if (e.isIdempotencyConflict) {
                    key = ApiClient.newIdempotencyKey()
                    error = "O servidor já recebeu um pedido diferente com a mesma chave. Toque em Abrir protocolo novamente."
                } else {
                    error = container.describeError(e)
                }
            } catch (e: IOException) {
                error = ApiClient.describe(e)
                retryable = true
            } catch (e: Exception) {
                error = ApiClient.describe(e)
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Abrir protocolo") },
                navigationIcon = { IconButton(onClick = onBack, enabled = !busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar") } },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            Text(
                "O protocolo recebe um número WA-… e acompanha a solicitação do cliente até a conclusão. Você precisa ter assumido a conversa.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = title,
                onValueChange = { v ->
                    if (v != title) {
                        title = v
                        key = ApiClient.newIdempotencyKey()
                        retryable = false
                    }
                },
                label = { Text("Título da solicitação") },
                placeholder = { Text("Ex.: Segunda via da fatura de outubro") },
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
                minLines = 2,
                maxLines = 5,
                isError = title.length > TITLE_MAX,
                supportingText = {
                    Text(
                        "${title.length}/$TITLE_MAX",
                        color = if (title.length > TITLE_MAX) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
            )
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { submit() }, enabled = !busy && title.isNotBlank() && title.length <= TITLE_MAX, modifier = Modifier.fillMaxWidth()) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text(if (retryable) "Tentar novamente" else "Abrir protocolo")
            }
            TextButton(onClick = onBack, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Cancelar") }
        }
    }
}
