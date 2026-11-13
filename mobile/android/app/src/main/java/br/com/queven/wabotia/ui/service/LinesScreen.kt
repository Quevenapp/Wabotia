package br.com.queven.wabotia.ui.service

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.ServiceLine
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.parseJsonStringList
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.IconBubble
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Linhas de atendimento: quem atende cada linha, quando os menus aparecem e a participação no roteador. */
@Composable
fun LinesScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val c = Wb.colors
    var lines by remember(profile) { mutableStateOf<List<ServiceLine>>(emptyList()) }
    var bots by remember(profile) { mutableStateOf<List<Bot>>(emptyList()) }
    var editing by remember(profile) { mutableStateOf<ServiceLine?>(null) }
    var error by remember(profile) { mutableStateOf<String?>(null) }
    var loading by remember(profile) { mutableStateOf(true) }
    suspend fun load() {
        try {
            lines = container.api.lines(profile).data
            bots = container.api.bots(profile).data
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
        } finally {
            loading = false
        }
    }
    LaunchedEffect(profile) { load() }

    val current = editing
    if (current != null) {
        LineEditor(container, current, bots, onBack = { editing = null }, onSaved = { editing = null; scope.launch { load() } })
        return
    }

    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar("Linhas de atendimento", onBack)
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item("hint") {
                ServiceHint("Escolha quem atende cada linha e quando os menus aparecem. A participação no roteador é independente.", Modifier.padding(top = 8.dp))
            }
            error?.let { message ->
                item("error") {
                    InlineNotice(message, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), actionLabel = "Tentar de novo", onAction = { loading = true; scope.launch { load() } })
                }
            }
            when {
                loading && lines.isEmpty() -> item("skeleton") { SkeletonList(rows = 4, avatar = true) }
                lines.isEmpty() && error == null -> item("empty") {
                    EmptyState(Icons.Filled.Phone, "Nenhuma linha neste perfil", Modifier.height(360.dp), subtitle = "Conecte um número de WhatsApp no painel para ele aparecer aqui.")
                }
                else -> items(lines, key = { it.id }) { line ->
                    Row(
                        Modifier.fillMaxWidth().clickable { editing = line }.heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconBubble(Icons.Filled.Phone, if (line.status == "active") c.brand else c.muted, size = 44.dp)
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(line.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull(
                                    line.number,
                                    if (line.status == "active") "Ativa" else "Pausada",
                                    if (line.number_policy.bool("pool") == true) "No roteador" else "Fora do roteador",
                                ).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = c.textSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Spacer(Modifier.height(5.dp))
                            Pill(lineKindLabel(line.kind), if (line.kind == "meta" || line.kind == "zernio") c.ok else c.textSecondary)
                        }
                        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = c.muted)
                    }
                    RowDivider(startIndent = 74.dp)
                }
            }
        }
    }
}

@Composable
private fun LineEditor(container: AppContainer, line: ServiceLine, bots: List<Bot>, onBack: () -> Unit, onSaved: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val c = Wb.colors
    var mode by remember(line.id) { mutableStateOf(line.service.mode) }
    var bot by remember(line.id) { mutableStateOf(line.service.bot_id ?: "") }
    var menuMode by remember(line.id) { mutableStateOf(line.service.menu_mode) }
    var policy by remember(line.id) { mutableStateOf(line.number_policy) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Mesmo corpo repetido após falha de rede sai com a mesma Idempotency-Key.
    var pending by remember { mutableStateOf<Pair<JsonObject, String>?>(null) }
    val admin = container.session.user?.isAdmin == true
    BackHandler(enabled = true) { if (!busy) onBack() }

    fun save() {
        val body = buildJsonObject {
            put("service", buildJsonObject {
                put("mode", mode)
                put("bot_id", bot.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
                put("menu_mode", menuMode)
            })
            put("number_policy", JsonObject(policy + ("purpose" to JsonPrimitive("custom"))))
        }
        val key = pending?.takeIf { it.first == body }?.second ?: ApiClient.newIdempotencyKey()
        pending = body to key
        busy = true
        error = null
        scope.launch {
            try {
                container.api.saveLine(profile, line.id, key, body)
                pending = null
                onSaved()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
                if ((e as? ApiException)?.isDefinitiveWriteRejection == true) pending = null
            } finally {
                busy = false
            }
        }
    }

    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar(
            line.name,
            onBack,
            subtitle = listOfNotNull(line.number, lineKindLabel(line.kind)).joinToString(" · "),
            backEnabled = !busy,
            actions = { if (admin) SaveAction(enabled = !busy && (mode != "bot" || bot.isNotEmpty()), onClick = ::save) },
        )
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.brand, trackColor = c.divider)
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            error?.let { message ->
                item("error") { InlineNotice(message, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp), onDismiss = { error = null }) }
            }
            if (admin) {
                item("who-label") { SectionLabel("Quem atende") }
                item("who") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        ServiceChoice(
                            "Responsável inicial", mode,
                            listOf("inherit" to "Configuração do perfil", "human" to "Equipe humana", "bot" to "Bot específico"),
                            enabled = !busy,
                        ) { mode = it }
                        if (mode == "bot") {
                            RowDivider(startIndent = 16.dp)
                            ServiceChoice(
                                "Bot", bot,
                                listOf("" to "Selecione") + bots
                                    .filter { it.enabled == 1 && (it.line_ids == null || it.line_ids == "null" || line.id in it.line_ids.parseJsonStringList()) }
                                    .map { it.id to it.name },
                                enabled = !busy,
                            ) { bot = it }
                        }
                        RowDivider(startIndent = 16.dp)
                        ServiceChoice(
                            "Menus", menuMode,
                            listOf("automatic" to "Automáticos e sob demanda", "manual" to "Apenas sob demanda", "off" to "Desativados"),
                            enabled = !busy,
                        ) { menuMode = it }
                    }
                }
                item("policy-label") { SectionLabel("O que esta linha pode fazer") }
                item("policy") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        val toggles = listOf(
                            "pool" to "Participar do roteador",
                            "human" to "Atendimento por pessoas",
                            "bots" to "Atendimento por bots",
                            "menu" to "Permitir menus",
                            "api" to "Integrações por API",
                            "service" to "Mensagens de serviço",
                            "templates" to "Templates",
                        )
                        toggles.forEachIndexed { index, (key, label) ->
                            if (index > 0) RowDivider(startIndent = 16.dp)
                            ServiceToggle(label, policy.bool(key) ?: true, enabled = !busy) { policy = JsonObject(policy + (key to JsonPrimitive(it))) }
                        }
                    }
                }
            } else {
                item("readonly") {
                    WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconBubble(if (mode == "bot") Icons.Filled.SmartToy else Icons.Filled.SupportAgent, if (mode == "bot") c.bot else c.brand)
                            Spacer(Modifier.width(14.dp))
                            Column {
                                Text("Atendimento", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                                Text(
                                    when (mode) {
                                        "human" -> "Equipe humana"
                                        "bot" -> bots.firstOrNull { it.id == bot }?.name ?: "Bot"
                                        else -> "Configuração do perfil"
                                    },
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = c.textPrimary,
                                )
                            }
                        }
                    }
                }
                item("readonly-hint") { ServiceHint("Somente administradores podem alterar as linhas.") }
            }
            item("footer") {
                ServiceHint("Conversas iniciadas continuam no mesmo número. O fim da franquia permite serviço pago; a janela de 24 horas continua obrigatória.")
            }
        }
    }
}

/** Linhas dos bots: em quais linhas cada bot pode atender (todas, algumas ou só conversas internas). */
@Composable
fun BotLinesScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val c = Wb.colors
    var bots by remember(profile) { mutableStateOf<List<Bot>>(emptyList()) }
    var lines by remember(profile) { mutableStateOf<List<ServiceLine>>(emptyList()) }
    var editing by remember { mutableStateOf<Bot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember(profile) { mutableStateOf(true) }
    suspend fun load() {
        try {
            bots = container.api.bots(profile).data
            lines = container.api.lines(profile).data
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = container.handleError(e)
        } finally {
            loading = false
        }
    }
    LaunchedEffect(profile) { load() }

    val selectedBot = editing
    if (selectedBot != null) {
        BotLineEditor(container, selectedBot, lines, { editing = null }) { editing = null; scope.launch { load() } }
        return
    }

    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar("Linhas dos bots", onBack)
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item("hint") { ServiceHint("Defina em quais linhas cada bot pode atender clientes.", Modifier.padding(top = 8.dp)) }
            error?.let { message ->
                item("error") {
                    InlineNotice(message, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), actionLabel = "Tentar de novo", onAction = { loading = true; scope.launch { load() } })
                }
            }
            when {
                loading && bots.isEmpty() -> item("skeleton") { SkeletonList(rows = 4) }
                bots.isEmpty() && error == null -> item("empty") {
                    EmptyState(Icons.Filled.SmartToy, "Nenhum bot neste perfil", Modifier.height(360.dp), subtitle = "Os bots configurados no painel aparecem aqui.")
                }
                else -> items(bots, key = { it.id }) { bot ->
                    val ids = bot.line_ids
                    val all = ids == null || ids == "null"
                    val count = if (all) 0 else ids.parseJsonStringList().size
                    Row(
                        Modifier.fillMaxWidth().clickable { editing = bot }.heightIn(min = 68.dp).padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(bot.name, seed = bot.id, size = 44.dp, kind = AvatarKind.Bot)
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(bot.name.ifBlank { "Bot" }, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                when {
                                    all -> "Todas as linhas"
                                    count == 0 -> "Só conversa interna"
                                    count == 1 -> "1 linha"
                                    else -> "$count linhas"
                                } + if (bot.enabled != 1) " · Desativado" else "",
                                style = MaterialTheme.typography.bodySmall,
                                color = c.textSecondary,
                                maxLines = 1,
                            )
                        }
                        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = c.muted)
                    }
                    RowDivider(startIndent = 74.dp)
                }
            }
        }
    }
}

@Composable
private fun BotLineEditor(container: AppContainer, bot: Bot, lines: List<ServiceLine>, onBack: () -> Unit, onSaved: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val c = Wb.colors
    var all by remember(bot.id) { mutableStateOf(bot.line_ids == null || bot.line_ids == "null") }
    var selected by remember(bot.id) { mutableStateOf(bot.line_ids.parseJsonStringList().toSet()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<JsonObject, String>?>(null) }
    BackHandler(enabled = true) { if (!busy) onBack() }

    fun save() {
        val body = buildJsonObject { put("line_ids", if (all) JsonNull else JsonArray(selected.sorted().map(::JsonPrimitive))) }
        val key = pending?.takeIf { it.first == body }?.second ?: ApiClient.newIdempotencyKey()
        pending = body to key
        busy = true
        error = null
        scope.launch {
            try {
                container.api.updateBot(profile, bot.id, key, body)
                onSaved()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
                if ((e as? ApiException)?.isDefinitiveWriteRejection == true) pending = null
            } finally {
                busy = false
            }
        }
    }

    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar(bot.name.ifBlank { "Bot" }, onBack, subtitle = "Linhas autorizadas", backEnabled = !busy, actions = { SaveAction(enabled = !busy, onClick = ::save) })
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.brand, trackColor = c.divider)
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            error?.let { message ->
                item("error") { InlineNotice(message, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp), onDismiss = { error = null }) }
            }
            item("all") {
                WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
                    ServiceToggle("Todas as linhas", all, subtitle = "O bot pode atender em qualquer número do perfil", enabled = !busy) { all = it }
                }
            }
            if (!all) {
                item("lines-label") { SectionLabel("Linhas permitidas") }
                item("lines") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        if (lines.isEmpty()) {
                            Text("Nenhuma linha neste perfil.", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary, modifier = Modifier.padding(16.dp))
                        }
                        lines.forEachIndexed { index, line ->
                            if (index > 0) RowDivider(startIndent = 16.dp)
                            ServiceToggle(line.name, line.id in selected, subtitle = line.number, enabled = !busy) { selected = if (it) selected + line.id else selected - line.id }
                        }
                    }
                }
                item("lines-hint") { ServiceHint("Sem linhas selecionadas, o bot fica disponível apenas para conversas internas.") }
            }
        }
    }
}
