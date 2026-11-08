package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.*
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.ui.conversations.handleError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

@Composable
fun MenusScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    var menus by remember(profile) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var lines by remember(profile) { mutableStateOf<List<ServiceLine>>(emptyList()) }
    var bots by remember(profile) { mutableStateOf<List<Bot>>(emptyList()) }
    var apps by remember(profile) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var editing by remember { mutableStateOf<JsonObject?>(null) }
    var isNew by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        try {
            menus = container.api.menus(profile).data; lines = container.api.lines(profile).data
            bots = container.api.bots(profile).data; apps = container.api.profileStatus(profile).settings?.array("apps")?.mapNotNull { it as? JsonObject } ?: emptyList(); error = null
        } catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e) }
    }
    LaunchedEffect(profile) { load() }
    editing?.let { item -> MenuEditor(container, item, isNew, menus, lines, bots, apps, { editing = null }) { editing = null; scope.launch { load() } }; return }
    Scaffold(topBar = { TopAppBar(title = { Text("Menus e submenus") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }, actions = {
        IconButton(onClick = { isNew = true; editing = buildJsonObject { put("id", UUID.randomUUID().toString()); put("label", ""); put("type", "human"); put("enabled", true); put("trigger", "automatic"); put("line_ids", JsonArray(emptyList())) } }) { Icon(Icons.Default.Add, "Criar opção") }
    }) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item { Text("Defina opções, submenus e as linhas em que aparecem. Submenus respeitam também as linhas do menu pai.", modifier = Modifier.padding(16.dp)) }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)); TextButton(onClick = { scope.launch { load() } }) { Text("Tentar novamente") } } }
            items(menus, key = { it.string("id") ?: "" }) { menu ->
                ListItem(headlineContent = { Text(menu.string("label") ?: "Opção") }, supportingContent = {
                    Text((menus.firstOrNull { it.string("id") == menu.string("parent_id") }?.string("label") ?: "Menu principal") + " · " + (if (menu.string("trigger") == "manual") "Sob demanda" else "Automático") + if (menu.bool("enabled") == false) " · Desativado" else "")
                }, modifier = Modifier.clickable { isNew = false; editing = menu })
            }
        }
    }
}

@Composable
private fun MenuEditor(container: AppContainer, original: JsonObject, isNew: Boolean, menus: List<JsonObject>, lines: List<ServiceLine>, bots: List<Bot>, apps: List<JsonObject>, onBack: () -> Unit, onSaved: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val id = original.string("id") ?: return
    var label by remember(id) { mutableStateOf(original.string("label") ?: "") }
    var type by remember(id) { mutableStateOf(original.string("type") ?: "human") }
    var parent by remember(id) { mutableStateOf(original.string("parent_id") ?: "") }
    var bot by remember(id) { mutableStateOf(original.string("bot_id") ?: "") }
    var app by remember(id) { mutableStateOf(original.string("app_id") ?: "") }
    var trigger by remember(id) { mutableStateOf(original.string("trigger") ?: "automatic") }
    var enabled by remember(id) { mutableStateOf(original.bool("enabled") ?: true) }
    var selected by remember(id) { mutableStateOf(original.array("line_ids")?.mapNotNull { it.asStringOrNull() }?.toSet() ?: emptySet()) }
    var all by remember(id) { mutableStateOf(selected.isEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<JsonObject, String>?>(null) }
    fun save() {
        val item = JsonObject(original + buildJsonObject {
            put("label", label.trim()); put("type", type); put("parent_id", parent.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
            put("bot_id", bot); put("app_id", app); put("trigger", trigger); put("enabled", enabled)
            put("line_ids", JsonArray((if (all) emptyList() else selected.sorted()).map(::JsonPrimitive)))
        })
        busy = true
        scope.launch {
            try {
                val latest = container.api.menus(profile).data
                val current = latest.firstOrNull { it.string("id") == id }
                if (!isNew && current != original && current != item) { error = "Esta opção foi alterada em outro dispositivo. Feche e abra novamente antes de salvar."; return@launch }
                val next = latest.toMutableList(); val index = next.indexOfFirst { it.string("id") == id }
                if (index >= 0) next[index] = item else next.add(item)
                val body = buildJsonObject { put("menus", JsonArray(next)) }
                val key = pending?.takeIf { it.first == body }?.second ?: ApiClient.newIdempotencyKey(); pending = body to key
                container.api.saveSettings(profile, key, body); pending = null; onSaved()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e); if ((e as? br.com.queven.wabotia.core.net.ApiException)?.isDefinitiveWriteRejection == true) pending = null } finally { busy = false }
        }
    }
    val valid = label.isNotBlank() && (all || selected.isNotEmpty()) && (type != "bot" || bot.isNotEmpty()) && (type != "app" || app.isNotEmpty())
    Scaffold(topBar = { TopAppBar(title = { Text(if (isNew) "Criar opção" else "Editar opção") }, navigationIcon = { IconButton(onClick = onBack, enabled = !busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }, actions = { TextButton(onClick = ::save, enabled = valid && !busy) { Text("Salvar") } }) }) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { OutlinedTextField(label, { if (!busy) label = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Texto da opção") }) }
            item { ServiceToggle("Habilitada", enabled) { if (!busy) enabled = it } }
            item { ServiceChoice("Menu pai", parent, listOf("" to "Menu principal") + menus.filter { it.string("type") == "submenu" && it.string("id") != id }.map { (it.string("id") ?: "") to (it.string("label") ?: "Submenu") }) { if (!busy) parent = it } }
            item { ServiceChoice("Destino", type, listOf("human" to "Pessoa", "bot" to "Bot", "submenu" to "Submenu", "app" to "Aplicativo")) { if (!busy) type = it } }
            if (type == "bot") item { ServiceChoice("Bot", bot, listOf("" to "Selecione") + bots.map { it.id to it.name }) { if (!busy) bot = it } }
            if (type == "app") item { ServiceChoice("Aplicativo", app, listOf("" to "Selecione") + apps.map { (it.string("id") ?: "") to (it.string("name") ?: "Aplicativo") }) { if (!busy) app = it } }
            item { ServiceChoice("Disponibilidade", trigger, listOf("automatic" to "Automática", "manual" to "Quando pessoa ou bot chamar")) { if (!busy) trigger = it } }
            item { ServiceToggle("Todas as linhas permitidas", all) { if (!busy) all = it } }
            if (!all) items(lines, key = { it.id }) { line -> ServiceToggle(line.name, line.id in selected) { if (!busy) selected = if (it) selected + line.id else selected - line.id } }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        }
    }
}

@Composable
fun ConversationMenusSheet(container: AppContainer, connectionId: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val profile = container.session.profileId ?: return
    var menus by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(profile, connectionId) { try { menus = container.api.menus(profile, connectionId).data } catch (e: CancellationException) { throw e } catch (e: Exception) { error = container.handleError(e) } }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(contentPadding = PaddingValues(16.dp)) {
            item { Text("Enviar menu", style = MaterialTheme.typography.titleLarge) }
            item { Text("O envio usa o número desta conversa e exige a janela de 24 horas.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 12.dp)) }
            item { TextButton(onClick = { onPick(null) }) { Text("Menu principal") } }
            items(menus.filter { it.string("type") == "submenu" }) { item -> TextButton(onClick = { onPick(item.string("id")) }) { Text(item.string("label") ?: "Submenu") } }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        }
    }
}
