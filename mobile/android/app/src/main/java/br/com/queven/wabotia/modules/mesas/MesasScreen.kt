package br.com.queven.wabotia.modules.mesas

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.TableRestaurant
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.Links
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.service.WebPanel
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * Mesas do garçom (`GET mesas`, `POST mesas/tabs`, `POST mesas/tabs/{id}/bill`): o mapa das mesas, abrir uma mesa livre
 * e pedir a conta. Lançar itens, pagamentos, transferir e juntar ficam no painel. Mesmo desenho do iOS
 * (`Modules/Mesas/MesasViews.swift`).
 */

@Serializable
data class TabBill(@SerialName("total_cents") val totalCents: Long = 0, @SerialName("due_cents") val dueCents: Long = 0)

@Serializable
data class TableTab(
    val id: String,
    val number: Int = 0,
    val status: String = "open",
    @SerialName("status_label") val statusLabel: String = "",
    val guests: Int = 0,
    @SerialName("customer_name") val customerName: String? = null,
    val bill: TabBill = TabBill(),
    @SerialName("minutes_open") val minutesOpen: Int = 0,
    @SerialName("ready_count") val readyCount: Int? = null,
)

@Serializable
data class DiningTable(
    val id: String,
    val name: String = "",
    val section: String = "",
    val seats: Int = 0,
    val state: String = "free",
    @SerialName("state_label") val stateLabel: String = "",
    val tab: TableTab? = null,
)

@Serializable
data class MesasOverview(@SerialName("can_operate") val canOperate: Boolean = false, val tables: List<DiningTable> = emptyList())

object MesasText {
    /** "Mesa 4 · 3 pessoas · 25 min · R$ 120,00". */
    fun subtitle(table: DiningTable): String {
        val tab = table.tab ?: return "Livre · ${table.seats} lugares"
        return listOfNotNull(
            table.stateLabel.ifBlank { if (table.state == "closing") "Fechando" else "Ocupada" },
            if (tab.guests > 0) "${tab.guests} pessoas" else null,
            "${tab.minutesOpen} min",
            Money.format(tab.bill.totalCents),
            tab.readyCount?.takeIf { it > 0 }?.let { "$it pronto(s) para servir" },
        ).joinToString(" · ")
    }
}

class MesasViewModel(private val container: AppContainer) : ViewModel() {
    private val api = ProfileApi.current(container)
    private val keys = IntentKeys()
    var overview by mutableStateOf<MesasOverview?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false); private set

    init {
        reload()
        observeModuleEvents(container, "mesas.") { load() }
    }

    fun reload() { viewModelScope.launch { load() } }

    private suspend fun load() {
        try {
            overview = api.get("mesas", MesasOverview.serializer())
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ModuleFailure.handle(container, ModuleIds.MESAS, e)
            error = ModuleFailure.message(e)
        }
    }

    private fun write(signature: String, path: String, body: JsonObject, done: () -> Unit = {}) {
        if (busy) return
        busy = true
        viewModelScope.launch {
            val key = keys.key(signature)
            try {
                api.send("POST", path, body, key, JsonObject.serializer())
                keys.settle(null)
                done()
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                ModuleFailure.handle(container, ModuleIds.MESAS, e)
                notice = ModuleFailure.actionMessage(e)
            }
            busy = false
        }
    }

    fun open(table: DiningTable, guests: Int, customer: String, done: () -> Unit) =
        write("open:${table.id}:$guests:$customer", "mesas/tabs", jsonBody("table_id" to table.id, "guests" to guests, "customer_name" to customer.trim().ifBlank { null }), done)

    fun requestBill(tab: TableTab) = write("bill:${tab.id}", "mesas/tabs/${tab.id}/bill", jsonBody())
}

@Composable
fun MesasScreen(container: AppContainer, onBack: () -> Unit) {
    val vm: MesasViewModel = viewModel { MesasViewModel(container) }
    val c = Wb.colors
    val context = LocalContext.current
    var opening by remember { mutableStateOf<DiningTable?>(null) }
    var selected by remember { mutableStateOf<DiningTable?>(null) }
    val webUrl = WebPanel.url(container.session.serverUrl, WebPanel.MESAS)

    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Mesas", onBack) },
    ) { padding ->
        val overview = vm.overview
        when {
            overview == null && vm.error != null -> ErrorState(vm.error!!, onRetry = vm::reload, modifier = Modifier.padding(padding))
            overview == null -> SkeletonList(Modifier.padding(padding), rows = 6)
            overview.tables.isEmpty() -> EmptyState(
                Icons.Filled.TableRestaurant, "Nenhuma mesa cadastrada", Modifier.padding(padding),
                subtitle = "As mesas são cadastradas no painel, em Gestão → Mesas.",
            )
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize().testTag("mesas.list"), contentPadding = PaddingValues(bottom = 32.dp)) {
                vm.notice?.let { text -> item("notice") { InlineNotice(text, Modifier.padding(16.dp), onDismiss = { vm.notice = null }) } }
                if (!overview.canOperate) item("readonly") {
                    Text(
                        "Você vê as mesas, mas abrir e pedir a conta é do papel Garçom. Peça ao administrador em Gestão → Pessoas e acessos.",
                        style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(16.dp),
                    )
                }
                overview.tables.groupBy { it.section.ifBlank { "Salão" } }.forEach { (section, tables) ->
                    item("label-$section") { SectionLabel(section) }
                    item("card-$section") {
                        WbCard(Modifier.padding(horizontal = 16.dp)) {
                            tables.forEachIndexed { i, table ->
                                if (i > 0) RowDivider()
                                val tint = when (table.state) { "free" -> c.ok; "closing" -> c.warn; else -> c.brand }
                                SettingsRow(
                                    Icons.Filled.TableRestaurant, table.name, subtitle = MesasText.subtitle(table), tint = tint,
                                    enabled = overview.canOperate,
                                    onClick = { if (table.tab == null) opening = table else selected = table },
                                    modifier = Modifier.testTag("mesa.${table.id}"),
                                    trailing = { Pill(if (table.tab == null) "Livre" else table.stateLabel.ifBlank { "Ocupada" }, tint) },
                                )
                            }
                        }
                    }
                }
                if (webUrl != null) item("web") {
                    WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp)) {
                        SettingsRow(
                            Icons.Filled.OpenInBrowser, "Abrir no navegador",
                            subtitle = "Lançar itens, receber pagamentos, transferir e juntar mesas",
                            tint = c.textSecondary, onClick = { Links.open(context, webUrl) },
                        )
                    }
                }
            }
        }
    }

    opening?.let { table ->
        var guests by remember(table.id) { mutableStateOf("") }
        var customer by remember(table.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { opening = null },
            title = { Text("Abrir ${table.name}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        guests, { guests = it.filter(Char::isDigit).take(3) }, label = { Text("Pessoas (opcional)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(customer, { customer = it.take(80) }, label = { Text("Nome do cliente (opcional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = { TextButton(enabled = !vm.busy, onClick = { vm.open(table, guests.toIntOrNull() ?: 0, customer) { opening = null } }) { Text("Abrir mesa") } },
            dismissButton = { TextButton(onClick = { opening = null }) { Text("Voltar") } },
        )
    }
    selected?.let { table ->
        val tab = table.tab
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text("${table.name} · comanda ${tab?.number ?: ""}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(MesasText.subtitle(table))
                    tab?.customerName?.takeIf { it.isNotBlank() }?.let { Text("Cliente: $it") }
                    tab?.let { Text("Falta pagar: ${Money.format(it.bill.dueCents)}") }
                }
            },
            confirmButton = {
                if (tab != null && tab.status == "open") TextButton(enabled = !vm.busy, onClick = { vm.requestBill(tab); selected = null }) { Text("Pedir a conta") }
            },
            dismissButton = { TextButton(onClick = { selected = null }) { Text("Fechar") } },
        )
    }
}
