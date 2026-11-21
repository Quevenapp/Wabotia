package br.com.queven.wabotia.modules.entrega

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DeliveryDining
import androidx.compose.material.icons.filled.OpenInBrowser
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
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.RowDivider
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
 * Entregas no celular (`GET entrega`, `GET entrega/mine`, `GET entrega/deliveries`, `POST …/start` e `…/delivered`):
 * o entregador vê as entregas dele, sai para entregar e confirma (com o código do cliente, quando a loja pede); a equipe
 * vê as abertas e confirma a entrega. Atribuir, mapa e rastreio contínuo ficam no painel. Mesmo desenho do iOS
 * (`Modules/Entrega/EntregaViews.swift`).
 */

@Serializable
data class Delivery(
    val id: String,
    val label: String? = null,
    @SerialName("customer_name") val customerName: String? = null,
    @SerialName("address_text") val addressText: String? = null,
    val status: String = "",
    @SerialName("status_label") val statusLabel: String = "",
) {
    val title: String get() = listOfNotNull(label?.takeIf { it.isNotBlank() }, customerName?.takeIf { it.isNotBlank() }).joinToString(" · ").ifBlank { "Entrega" }
    val canStart: Boolean get() = status == "assigned"
    val canFinish: Boolean get() = status == "assigned" || status == "en_route"
}

@Serializable
data class DeliveryList(val data: List<Delivery> = emptyList(), val courier: Boolean = false)

@Serializable
data class EntregaInfo(val courier: Boolean = false)

class EntregaViewModel(private val container: AppContainer) : ViewModel() {
    private val api = ProfileApi.current(container)
    private val keys = IntentKeys()
    var courier by mutableStateOf(false); private set
    var items by mutableStateOf<List<Delivery>?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false); private set

    init {
        reload()
        observeModuleEvents(container, "entrega.") { load() }
    }

    fun reload() { viewModelScope.launch { load() } }

    private suspend fun load() {
        try {
            courier = api.get("entrega", EntregaInfo.serializer()).courier
            items = if (courier) api.get("entrega/mine", DeliveryList.serializer()).data
            else api.get("entrega/deliveries", DeliveryList.serializer()).data.filter { it.canFinish }
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ModuleFailure.handle(container, ModuleIds.ENTREGA, e)
            error = ModuleFailure.message(e)
        }
    }

    private fun post(signature: String, path: String, body: JsonObject, done: () -> Unit = {}) {
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
                ModuleFailure.handle(container, ModuleIds.ENTREGA, e)
                notice = ModuleFailure.actionMessage(e)
            }
            busy = false
        }
    }

    fun start(d: Delivery) = post("start:${d.id}", "entrega/deliveries/${d.id}/start", jsonBody())

    fun deliver(d: Delivery, code: String, done: () -> Unit) =
        post("deliver:${d.id}:$code", "entrega/deliveries/${d.id}/delivered", jsonBody("code" to code.trim().ifBlank { null }), done)
}

@Composable
fun EntregaScreen(container: AppContainer, onBack: () -> Unit) {
    val vm: EntregaViewModel = viewModel { EntregaViewModel(container) }
    val c = Wb.colors
    val context = LocalContext.current
    var finishing by remember { mutableStateOf<Delivery?>(null) }
    val webUrl = WebPanel.url(container.session.serverUrl, WebPanel.DELIVERIES)

    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Entregas", onBack, subtitle = if (vm.courier) "Minhas entregas" else "Entregas em andamento") },
    ) { padding ->
        val list = vm.items
        when {
            list == null && vm.error != null -> ErrorState(vm.error!!, onRetry = vm::reload, modifier = Modifier.padding(padding))
            list == null -> SkeletonList(Modifier.padding(padding), rows = 5)
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize().testTag("entrega.list"), contentPadding = PaddingValues(bottom = 32.dp)) {
                vm.notice?.let { text -> item("notice") { InlineNotice(text, Modifier.padding(16.dp), onDismiss = { vm.notice = null }) } }
                if (list.isEmpty()) item("empty") {
                    EmptyState(
                        Icons.Filled.DeliveryDining, "Nenhuma entrega agora",
                        subtitle = if (vm.courier) "Quando a loja atribuir uma entrega a você, ela aparece aqui." else "As entregas abertas aparecem aqui.",
                    )
                }
                items(list, key = { it.id }) { d ->
                    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                        SettingsRow(Icons.Filled.DeliveryDining, d.title, subtitle = listOfNotNull(d.statusLabel.ifBlank { null }, d.addressText).joinToString("\n"), tint = c.brand)
                        RowDivider(16.dp)
                        Column(Modifier.padding(horizontal = 8.dp)) {
                            if (vm.courier && d.canStart) TextButton(enabled = !vm.busy, onClick = { vm.start(d) }, modifier = Modifier.testTag("entrega.start.${d.id}")) { Text("Sair para entregar") }
                            if (d.canFinish) TextButton(enabled = !vm.busy, onClick = { finishing = d }, modifier = Modifier.testTag("entrega.done.${d.id}")) { Text("Confirmar entrega") }
                        }
                    }
                }
                if (webUrl != null) item("web") {
                    WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp)) {
                        SettingsRow(
                            Icons.Filled.OpenInBrowser, "Abrir no navegador", subtitle = "Atribuir entregadores, mapa e rastreio",
                            tint = c.textSecondary, onClick = { Links.open(context, webUrl) },
                        )
                    }
                }
            }
        }
    }

    finishing?.let { d ->
        var code by remember(d.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { finishing = null },
            title = { Text("Confirmar entrega") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(d.title, style = MaterialTheme.typography.bodyMedium)
                    if (vm.courier) OutlinedTextField(
                        code, { code = it.filter(Char::isDigit).take(8) }, label = { Text("Código do cliente (se a loja pedir)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = { TextButton(enabled = !vm.busy, onClick = { vm.deliver(d, code) { finishing = null } }) { Text("Entregue") } },
            dismissButton = { TextButton(onClick = { finishing = null }) { Text("Voltar") } },
        )
    }
}
