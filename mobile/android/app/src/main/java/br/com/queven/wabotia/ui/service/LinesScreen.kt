package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.*
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.ui.conversations.handleError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun ServiceChoice(label: String, value: String, options: List<Pair<String, String>>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) { Text("$label: ${options.firstOrNull { it.first == value }?.second ?: "Selecione"}") }
        DropdownMenu(expanded, { expanded = false }) { options.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { onChange(id); expanded = false }) } }
    }
}

@Composable
internal fun ServiceToggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f)); Switch(checked, onChange)
    }
}

@Composable
fun LinesScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    var lines by remember(profile) { mutableStateOf<List<ServiceLine>>(emptyList()) }
    var bots by remember(profile) { mutableStateOf<List<Bot>>(emptyList()) }
    var editing by remember(profile) { mutableStateOf<ServiceLine?>(null) }
    var error by remember(profile) { mutableStateOf<String?>(null) }
    var loading by remember(profile) { mutableStateOf(true) }
    suspend fun load() {
        try { lines = container.api.lines(profile).data; bots = container.api.bots(profile).data; error = null }
        catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e) }
        finally { loading = false }
    }
    LaunchedEffect(profile) { load() }
    if (editing != null) { LineEditor(container, editing!!, bots, onBack = { editing = null }, onSaved = { editing = null; scope.launch { load() } }); return }
    Scaffold(topBar = { TopAppBar(title = { Text("Linhas de atendimento") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item { Text("Escolha quem atende cada linha e quando os menus aparecem. A participação no roteador é independente.", modifier = Modifier.padding(16.dp)) }
            if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)); TextButton(onClick = { scope.launch { load() } }) { Text("Tentar novamente") } } }
            items(lines, key = { it.id }) { line ->
                ListItem(headlineContent = { Text(line.name) }, supportingContent = { Text(listOfNotNull(line.number, if (line.status == "active") "Ativa" else "Pausada", if (line.number_policy.bool("pool") == true) "No roteador" else "Fora do roteador").joinToString(" · ")) }, modifier = Modifier.clickable { editing = line })
            }
        }
    }
}

@Composable
private fun LineEditor(container: AppContainer, line: ServiceLine, bots: List<Bot>, onBack: () -> Unit, onSaved: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    var mode by remember(line.id) { mutableStateOf(line.service.mode) }
    var bot by remember(line.id) { mutableStateOf(line.service.bot_id ?: "") }
    var menuMode by remember(line.id) { mutableStateOf(line.service.menu_mode) }
    var policy by remember(line.id) { mutableStateOf(line.number_policy) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<JsonObject, String>?>(null) }
    val admin = container.session.user?.isAdmin == true
    fun save() {
        val body = buildJsonObject {
            put("service", buildJsonObject { put("mode", mode); put("bot_id", bot.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull); put("menu_mode", menuMode) })
            put("number_policy", JsonObject(policy + ("purpose" to JsonPrimitive("custom"))))
        }
        val key = pending?.takeIf { it.first == body }?.second ?: ApiClient.newIdempotencyKey()
        pending = body to key; busy = true
        scope.launch { try { container.api.saveLine(profile, line.id, key, body); pending = null; onSaved() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e); if ((e as? br.com.queven.wabotia.core.net.ApiException)?.isDefinitiveWriteRejection == true) pending = null } finally { busy = false } }
    }
    Scaffold(topBar = { TopAppBar(title = { Text(line.name) }, navigationIcon = { IconButton(onClick = onBack, enabled = !busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }, actions = { if (admin) TextButton(onClick = ::save, enabled = !busy && (mode != "bot" || bot.isNotEmpty())) { Text("Salvar") } }) }) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (admin) {
                item { ServiceChoice("Responsável inicial", mode, listOf("inherit" to "Configuração do perfil", "human" to "Equipe humana", "bot" to "Bot específico")) { if (!busy) mode = it } }
                if (mode == "bot") item { ServiceChoice("Bot", bot, listOf("" to "Selecione") + bots.filter { it.enabled == 1 && (it.line_ids == null || it.line_ids == "null" || line.id in it.line_ids.parseJsonStringList()) }.map { it.id to it.name }) { if (!busy) bot = it } }
                item { ServiceChoice("Menus", menuMode, listOf("automatic" to "Automáticos e sob demanda", "manual" to "Apenas sob demanda", "off" to "Desativados")) { if (!busy) menuMode = it } }
                items(listOf("pool" to "Participar do roteador", "human" to "Atendimento por pessoas", "bots" to "Atendimento por bots", "menu" to "Permitir menus", "api" to "Integrações por API", "service" to "Mensagens de serviço", "templates" to "Templates")) { (key, label) ->
                    ServiceToggle(label, policy.bool(key) ?: true) { if (!busy) policy = JsonObject(policy + (key to JsonPrimitive(it))) }
                }
            } else {
                item { Text("Atendimento: ${when (mode) { "human" -> "Equipe humana"; "bot" -> bots.firstOrNull { it.id == bot }?.name ?: "Bot"; else -> "Configuração do perfil" }}") }
                item { Text("Somente administradores podem alterar as linhas.") }
            }
            item { Text("Conversas iniciadas continuam no mesmo número. O fim da franquia permite serviço pago; a janela de 24 horas continua obrigatória.", style = MaterialTheme.typography.bodySmall) }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        }
    }
}

@Composable
fun BotLinesScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    var bots by remember(profile) { mutableStateOf<List<Bot>>(emptyList()) }
    var lines by remember(profile) { mutableStateOf<List<ServiceLine>>(emptyList()) }
    var editing by remember { mutableStateOf<Bot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() { try { bots = container.api.bots(profile).data; lines = container.api.lines(profile).data; error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e) } }
    LaunchedEffect(profile) { load() }
    val selectedBot = editing
    if (selectedBot != null) { BotLineEditor(container, selectedBot, lines, { editing = null }) { editing = null; scope.launch { load() } }; return }
    Scaffold(topBar = { TopAppBar(title = { Text("Linhas dos bots") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
            items(bots, key = { it.id }) { bot -> ListItem(headlineContent = { Text(bot.name) }, modifier = Modifier.clickable { editing = bot }) }
        }
    }
}

@Composable
private fun BotLineEditor(container: AppContainer, bot: Bot, lines: List<ServiceLine>, onBack: () -> Unit, onSaved: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    var all by remember(bot.id) { mutableStateOf(bot.line_ids == null || bot.line_ids == "null") }
    var selected by remember(bot.id) { mutableStateOf(bot.line_ids.parseJsonStringList().toSet()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<JsonObject, String>?>(null) }
    fun save() {
        val body = buildJsonObject { put("line_ids", if (all) JsonNull else JsonArray(selected.sorted().map(::JsonPrimitive))) }
        val key = pending?.takeIf { it.first == body }?.second ?: ApiClient.newIdempotencyKey(); pending = body to key; busy = true
        scope.launch { try { container.api.updateBot(profile, bot.id, key, body); onSaved() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e); if ((e as? br.com.queven.wabotia.core.net.ApiException)?.isDefinitiveWriteRejection == true) pending = null } finally { busy = false } }
    }
    Scaffold(topBar = { TopAppBar(title = { Text(bot.name) }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }, actions = { TextButton(onClick = ::save, enabled = !busy) { Text("Salvar") } }) }) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp)) {
            item { ServiceToggle("Todas as linhas", all) { if (!busy) all = it } }
            if (!all) {
                items(lines, key = { it.id }) { line -> ServiceToggle(line.name, line.id in selected) { if (!busy) selected = if (it) selected + line.id else selected - line.id } }
                item { Text("Sem linhas selecionadas, o bot fica disponível apenas para conversas internas.", style = MaterialTheme.typography.bodySmall) }
            }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        }
    }
}
