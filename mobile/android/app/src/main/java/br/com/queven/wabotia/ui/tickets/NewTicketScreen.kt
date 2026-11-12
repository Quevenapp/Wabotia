package br.com.queven.wabotia.ui.tickets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.TicketCreate
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.IconBubble
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
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
    // Categoria (aplicativo ou assunto): opcional, só oferecida quando o perfil tem categorias (servidor 0.14+).
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var categories by remember { mutableStateOf(container.profileData.cached(profileId)?.ticketCategories().orEmpty()) }
    LaunchedEffect(profileId) {
        if (profileId.isNotBlank()) container.profileData.load(profileId)?.let { categories = it.ticketCategories() }
    }
    val offered = categories.filter { it.enabled }
    val scope = rememberCoroutineScope()
    val c = Wb.colors

    fun submit() {
        val t = title.trim()
        if (t.isEmpty()) { error = "Informe o título do protocolo."; return }
        if (t.length > TITLE_MAX) { error = "O título deve ter no máximo $TITLE_MAX caracteres."; return }
        if (profileId.isBlank()) { error = "Perfil não selecionado."; return }
        busy = true; error = null; retryable = false
        scope.launch {
            try {
                val chosen = category?.takeIf { id -> offered.any { it.id == id } }
                val ticket = container.api.createTicket(profileId, key, TicketCreate(conversation_id = conversationId, title = t, category = chosen))
                onCreated(ticket.id)
            } catch (e: ApiException) {
                if (e.isIdempotencyConflict) {
                    key = ApiClient.newIdempotencyKey()
                    error = "O servidor já recebeu um pedido diferente com a mesma chave. Toque em Abrir protocolo novamente."
                } else {
                    error = container.handleError(e)
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

    Column(Modifier.fillMaxSize().background(c.background).imePadding()) {
        DetailTopBar("Abrir protocolo", onBack = onBack, backEnabled = !busy)
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBubble(Icons.Filled.ConfirmationNumber, c.ticket, size = 44.dp)
                Spacer(Modifier.width(14.dp))
                Text(
                    "O protocolo recebe um número WA-… e acompanha a solicitação do cliente até a conclusão. Você precisa ter assumido a conversa.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(16.dp))
            WbCard {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Text("Título da solicitação", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                    Spacer(Modifier.height(10.dp))
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 96.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(c.field)
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                    ) {
                        if (title.isEmpty()) {
                            Text("Ex.: Segunda via da fatura de outubro", style = MaterialTheme.typography.bodyLarge, color = c.textSecondary)
                        }
                        BasicTextField(
                            value = title,
                            onValueChange = { v ->
                                if (v != title) {
                                    title = v
                                    key = ApiClient.newIdempotencyKey()
                                    retryable = false
                                }
                            },
                            enabled = !busy,
                            maxLines = 6,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.textPrimary),
                            cursorBrush = SolidColor(c.brand),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                            keyboardActions = KeyboardActions(onDone = { submit() }),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "${title.length}/$TITLE_MAX",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = if (title.length > TITLE_MAX) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (title.length > TITLE_MAX) c.danger else c.textSecondary,
                        modifier = Modifier.align(Alignment.End),
                    )
                }
            }
            if (offered.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                WbCard {
                    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
                        Text("Categoria", style = MaterialTheme.typography.titleSmall, color = c.textPrimary, modifier = Modifier.padding(horizontal = 16.dp))
                        Text(
                            "Aplicativo ou assunto da solicitação. Opcional.",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textSecondary,
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 10.dp),
                        )
                        CategoryChips(
                            offered,
                            selected = category,
                            onSelect = { id ->
                                if (id != category) {
                                    category = id
                                    key = ApiClient.newIdempotencyKey()
                                    retryable = false
                                }
                            },
                            modifier = Modifier.padding(horizontal = 16.dp),
                            enabled = !busy,
                        )
                    }
                }
            }
            error?.let {
                Spacer(Modifier.height(12.dp))
                InlineNotice(it, onDismiss = { error = null })
            }
        }
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            PrimaryButton(
                if (retryable) "Tentar de novo" else "Abrir protocolo",
                onClick = { submit() },
                loading = busy,
                enabled = busy || (title.isNotBlank() && title.length <= TITLE_MAX),
            )
            TextButton(onClick = onBack, enabled = !busy) { Text("Cancelar", color = c.textSecondary) }
        }
    }
}
