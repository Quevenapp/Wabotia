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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Bot
import br.com.queven.wabotia.core.model.ServiceLine
import br.com.queven.wabotia.core.model.array
import br.com.queven.wabotia.core.model.asStringOrNull
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
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
import java.util.UUID

/** Menus e submenus (administrador): opções, destino, menu pai, linhas permitidas e exibição automática ou sob demanda. */
@Composable
fun MenusScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val c = Wb.colors
    var menus by remember(profile) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var lines by remember(profile) { mutableStateOf<List<ServiceLine>>(emptyList()) }
    var bots by remember(profile) { mutableStateOf<List<Bot>>(emptyList()) }
    var apps by remember(profile) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var editing by remember { mutableStateOf<JsonObject?>(null) }
    var isNew by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember(profile) { mutableStateOf(true) }
    suspend fun load() {
        try {
            menus = container.api.menus(profile).data
            lines = container.api.lines(profile).data
            bots = container.api.bots(profile).data
            apps = container.api.profileStatus(profile).settings?.array("apps")?.mapNotNull { it as? JsonObject } ?: emptyList()
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

    editing?.let { item ->
        MenuEditor(container, item, isNew, menus, lines, bots, apps, { editing = null }) { editing = null; scope.launch { load() } }
        return
    }

    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar(
            "Menus e submenus",
            onBack,
            actions = {
                IconButton(onClick = {
                    isNew = true
                    editing = buildJsonObject {
                        put("id", UUID.randomUUID().toString())
                        put("label", "")
                        put("type", "human")
                        put("enabled", true)
                        put("trigger", "automatic")
                        put("line_ids", JsonArray(emptyList()))
                    }
                }) { Icon(Icons.Filled.Add, contentDescription = "Criar opção", tint = c.brand) }
            },
        )
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item("hint") {
                ServiceHint("Defina opções, submenus e as linhas em que aparecem. Submenus respeitam também as linhas do menu pai.", Modifier.padding(top = 8.dp))
            }
            error?.let { message ->
                item("error") {
                    InlineNotice(message, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), actionLabel = "Tentar de novo", onAction = { loading = true; scope.launch { load() } })
                }
            }
            when {
                loading && menus.isEmpty() -> item("skeleton") { SkeletonList(rows = 5) }
                menus.isEmpty() && error == null -> item("empty") {
                    EmptyState(Icons.Filled.AccountTree, "Nenhuma opção de menu", Modifier.height(360.dp), subtitle = "Toque em + para criar a primeira opção do menu principal.")
                }
                else -> items(menus, key = { it.string("id") ?: "" }) { menu ->
                    val type = menu.string("type") ?: "human"
                    val disabled = menu.bool("enabled") == false
                    Row(
                        Modifier.fillMaxWidth().clickable { isNew = false; editing = menu }.heightIn(min = 68.dp).padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconBubble(
                            when (type) {
                                "bot" -> Icons.Filled.SmartToy
                                "submenu" -> Icons.Filled.AccountTree
                                "app" -> Icons.Filled.Apps
                                else -> Icons.Filled.Person
                            },
                            when {
                                disabled -> c.muted
                                type == "bot" -> c.bot
                                type == "submenu" -> c.ticket
                                else -> c.brand
                            },
                            size = 44.dp,
                        )
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(menu.string("label")?.ifBlank { null } ?: "Opção", style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                (menus.firstOrNull { it.string("id") == menu.string("parent_id") }?.string("label") ?: "Menu principal") +
                                    " · " + (if (menu.string("trigger") == "manual") "Sob demanda" else "Automático"),
                                style = MaterialTheme.typography.bodySmall,
                                color = c.textSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (disabled) {
                            Pill("Desativado", c.muted)
                            Spacer(Modifier.width(6.dp))
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
private fun MenuEditor(
    container: AppContainer,
    original: JsonObject,
    isNew: Boolean,
    menus: List<JsonObject>,
    lines: List<ServiceLine>,
    bots: List<Bot>,
    apps: List<JsonObject>,
    onBack: () -> Unit,
    onSaved: () -> Unit,
) {
    val profile = container.session.profileId ?: return
    val scope = rememberCoroutineScope()
    val c = Wb.colors
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
    // Mesmo corpo repetido após falha de rede sai com a mesma Idempotency-Key.
    var pending by remember { mutableStateOf<Pair<JsonObject, String>?>(null) }
    BackHandler(enabled = true) { if (!busy) onBack() }

    fun save() {
        val item = JsonObject(original + buildJsonObject {
            put("label", label.trim())
            put("type", type)
            put("parent_id", parent.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
            put("bot_id", bot)
            put("app_id", app)
            put("trigger", trigger)
            put("enabled", enabled)
            put("line_ids", JsonArray((if (all) emptyList() else selected.sorted()).map(::JsonPrimitive)))
        })
        busy = true
        error = null
        scope.launch {
            try {
                val latest = container.api.menus(profile).data
                val current = latest.firstOrNull { it.string("id") == id }
                if (!isNew && current != original && current != item) {
                    error = "Esta opção foi alterada em outro dispositivo. Feche e abra novamente antes de salvar."
                    return@launch
                }
                val next = latest.toMutableList()
                val index = next.indexOfFirst { it.string("id") == id }
                if (index >= 0) next[index] = item else next.add(item)
                val body = buildJsonObject { put("menus", JsonArray(next)) }
                val key = pending?.takeIf { it.first == body }?.second ?: ApiClient.newIdempotencyKey()
                pending = body to key
                container.api.saveSettings(profile, key, body)
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

    val valid = label.isNotBlank() && (all || selected.isNotEmpty()) && (type != "bot" || bot.isNotEmpty()) && (type != "app" || app.isNotEmpty())
    Column(Modifier.fillMaxSize().background(c.background)) {
        DetailTopBar(if (isNew) "Criar opção" else "Editar opção", onBack, backEnabled = !busy, actions = { SaveAction(enabled = valid && !busy, onClick = ::save) })
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.brand, trackColor = c.divider)
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding().imePadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            error?.let { message ->
                item("error") { InlineNotice(message, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp), onDismiss = { error = null }) }
            }
            item("label") {
                WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
                    OutlinedTextField(
                        value = label,
                        onValueChange = { if (!busy) label = it },
                        modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 6.dp),
                        label = { Text("Texto da opção") },
                        placeholder = { Text("Ex.: Falar com o financeiro") },
                        shape = RoundedCornerShape(14.dp),
                        enabled = !busy,
                        maxLines = 3,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    )
                    ServiceToggle("Habilitada", enabled, subtitle = "Desligada, a opção some do menu sem ser apagada", enabled = !busy) { enabled = it }
                }
            }
            item("target-label") { SectionLabel("Destino") }
            item("target") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    ServiceChoice(
                        "Menu pai", parent,
                        listOf("" to "Menu principal") + menus.filter { it.string("type") == "submenu" && it.string("id") != id }.map { (it.string("id") ?: "") to (it.string("label") ?: "Submenu") },
                        enabled = !busy,
                    ) { parent = it }
                    RowDivider(startIndent = 16.dp)
                    ServiceChoice("Destino", type, listOf("human" to "Pessoa", "bot" to "Bot", "submenu" to "Submenu", "app" to "Aplicativo"), enabled = !busy) { type = it }
                    if (type == "bot") {
                        RowDivider(startIndent = 16.dp)
                        ServiceChoice("Bot", bot, listOf("" to "Selecione") + bots.map { it.id to it.name }, enabled = !busy) { bot = it }
                    }
                    if (type == "app") {
                        RowDivider(startIndent = 16.dp)
                        ServiceChoice("Aplicativo", app, listOf("" to "Selecione") + apps.map { (it.string("id") ?: "") to (it.string("name") ?: "Aplicativo") }, enabled = !busy) { app = it }
                    }
                    RowDivider(startIndent = 16.dp)
                    ServiceChoice("Disponibilidade", trigger, listOf("automatic" to "Automática", "manual" to "Quando pessoa ou bot chamar"), enabled = !busy) { trigger = it }
                }
            }
            item("lines-label") { SectionLabel("Linhas") }
            item("lines") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    ServiceToggle("Todas as linhas permitidas", all, enabled = !busy) { all = it }
                    if (!all) {
                        lines.forEach { line ->
                            RowDivider(startIndent = 16.dp)
                            ServiceToggle(line.name, line.id in selected, subtitle = line.number, enabled = !busy) { selected = if (it) selected + line.id else selected - line.id }
                        }
                    }
                }
            }
            if (!all && selected.isEmpty()) {
                item("lines-hint") { ServiceHint("Escolha ao menos uma linha ou ligue \"Todas as linhas permitidas\".") }
            }
        }
    }
}
