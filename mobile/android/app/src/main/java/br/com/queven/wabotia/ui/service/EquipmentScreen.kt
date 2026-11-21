package br.com.queven.wabotia.ui.service

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Tablet
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AdminRole
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.Links
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Um painel de TV da fila (`GET queue/displays`): abre pelo link com a chave dele, num navegador da TV. */
@Serializable
data class QueueDisplay(val id: String, val name: String = "", val revoked: Boolean = false, val created: Long = 0)

@Serializable
data class QueueDisplayList(val data: List<QueueDisplay> = emptyList())

/** Um aparelho pareado pelo código (painel ou totem com o app em modo aparelho, `GET /api/v1/pairings`). */
@Serializable
data class PairedDevice(
    val id: String,
    val client: String = "",
    @SerialName("instance_name") val instanceName: String? = null,
    val status: String = "",
    @SerialName("profile_id") val profileId: String? = null,
    val updated: Long = 0,
    @SerialName("allowed_scopes") val allowedScopes: List<String> = emptyList(),
    @SerialName("requested_scopes") val requestedScopes: List<String>? = null,
)

@Serializable
data class PairedDeviceList(val data: List<PairedDevice> = emptyList())

/** Regras de Equipamentos, sem rede. */
object EquipmentRules {
    /** O cliente do pareamento dos painéis e totens (src/pairing.ts). */
    const val PANEL_CLIENT = "senhapp"

    /** "abcd-2345" → "ABCD2345"; o código tem 8 letras e números, sem 0, 1, I e O. */
    fun normalizeCode(text: String): String = text.uppercase().filter { it.isLetterOrDigit() }.take(8)

    fun validCode(code: String): Boolean = Regex("^[A-HJ-NP-Z2-9]{8}$").matches(code)

    /** Os painéis e totens desta área (os outros sistemas pareados ficam no painel, em Sistemas conectados). */
    fun panels(list: List<PairedDevice>, profileId: String?): List<PairedDevice> =
        list.filter { it.client == PANEL_CLIENT && (it.profileId == null || it.profileId == profileId) }

    fun situation(device: PairedDevice): String = when (device.status) {
        "revoked" -> "Desligado"
        "denied" -> "Recusado"
        "pending" -> "Aguardando liberação"
        else -> "Pareado"
    }

    /** Liberar com o que o aparelho pediu (ler a fila, emitir senhas, operar) nesta área. */
    fun approveBody(profileId: String, device: PairedDevice): JsonObject =
        JsonObject(
            mapOf(
                "profile_id" to JsonPrimitive(profileId),
                "scopes" to JsonArray((device.requestedScopes ?: device.allowedScopes).map(::JsonPrimitive)),
            ),
        )
}

class EquipmentViewModel(private val container: AppContainer) : ViewModel() {
    private val api = ProfileApi.current(container)
    val profileId: String? = container.session.profileId
    var displays by mutableStateOf<List<QueueDisplay>?>(null); private set
    var devices by mutableStateOf<List<PairedDevice>?>(null); private set
    var notice by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false); private set
    /** O link do painel de TV recém-criado: o servidor só mostra a chave uma vez. */
    var createdLink by mutableStateOf<String?>(null)

    fun load(queue: Boolean, admin: Boolean) {
        if (!admin) return
        viewModelScope.launch {
            try {
                if (queue) displays = api.get("queue/displays", QueueDisplayList.serializer()).data
                devices = EquipmentRules.panels(WabotiaJson.decodeFromJsonElement(PairedDeviceList.serializer(), container.api.pairings()).data, profileId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = message(e)
            }
        }
    }

    private fun message(e: Throwable): String =
        if (e is br.com.queven.wabotia.queue.QueueException) ModuleFailure.actionMessage(e).also { ModuleFailure.handle(container, ModuleIds.QUEUE, e) } else container.handleError(e)

    private fun act(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        viewModelScope.launch {
            try {
                block()
                notice = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = message(e)
            }
            busy = false
        }
    }

    fun createDisplay(name: String, queue: Boolean) = act {
        val result = api.send("POST", "queue/displays", jsonBody("name" to name.trim().take(60), "queue_ids" to emptyList<String>()), QueueClient.newKey(), JsonObject.serializer())
        val path = (result["path"] as? JsonPrimitive)?.content
        createdLink = path?.let { WebPanel.url(container.session.serverUrl, it) ?: it }
        load(queue, true)
    }

    fun revokeDisplay(d: QueueDisplay, queue: Boolean) = act {
        api.send("DELETE", "queue/displays/${d.id}", jsonBody(), QueueClient.newKey(), JsonObject.serializer())
        load(queue, true)
    }

    fun pair(code: String, queue: Boolean, done: () -> Unit) = act {
        val profile = profileId ?: return@act
        val found = WabotiaJson.decodeFromJsonElement(PairedDevice.serializer(), container.api.pairingLookup(JsonObject(mapOf("user_code" to JsonPrimitive(code)))))
        if (found.client != EquipmentRules.PANEL_CLIENT) {
            notice = "Este código é de outro sistema, não de um painel ou totem. Libere em Sistemas conectados, no painel."
            return@act
        }
        container.api.pairingApprove(found.id, EquipmentRules.approveBody(profile, found))
        done()
        load(queue, true)
    }

    fun revokeDevice(d: PairedDevice, queue: Boolean) = act {
        container.api.pairingRevoke(d.id)
        load(queue, true)
    }
}

/**
 * Equipamentos: painéis de senha (TV pelo link e aparelhos pareados pelo código) e a impressora térmica. Parear e
 * desligar é do administrador; a impressora é deste aparelho.
 */
@Composable
fun EquipmentScreen(container: AppContainer, onBack: () -> Unit, openPrinter: () -> Unit) {
    val vm: EquipmentViewModel = viewModel { EquipmentViewModel(container) }
    val c = Wb.colors
    val context = LocalContext.current
    val enabled by container.modules.enabled.collectAsState()
    val roles by container.modules.roles.collectAsState()
    val queue = ModuleIds.QUEUE in enabled[container.session.profileId].orEmpty()
    val admin = AdminRole.isAdmin(roles[container.session.profileId], container.session.user?.role)
    var newDisplay by remember { mutableStateOf(false) }
    var pairing by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(queue, admin) { vm.load(queue, admin) }

    Scaffold(containerColor = c.background, contentWindowInsets = WindowInsets(0, 0, 0, 0), topBar = { DetailTopBar("Equipamentos", onBack) }) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().testTag("equipment.list"), contentPadding = PaddingValues(bottom = 32.dp)) {
            vm.notice?.let { text -> item("notice") { InlineNotice(text, Modifier.padding(16.dp), onDismiss = { vm.notice = null }) } }
            vm.createdLink?.let { link ->
                item("created") {
                    InlineNotice(
                        "Painel criado. Abra este link no navegador da TV (ele só aparece agora): $link",
                        Modifier.padding(16.dp), color = c.ok, actionLabel = "Enviar",
                        onAction = {
                            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
                            runCatching { context.startActivity(Intent.createChooser(send, "Enviar link do painel")) }
                        },
                        onDismiss = { vm.createdLink = null },
                    )
                }
            }
            item("printer-label") { SectionLabel("Impressora") }
            item("printer") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(
                        Icons.Filled.Print, "Impressora térmica", subtitle = "Bluetooth, USB ou Wi-Fi: parear, imprimir um teste e ver a situação",
                        tint = c.textSecondary, onClick = openPrinter, modifier = Modifier.testTag("equipment.printer"),
                    )
                }
            }
            item("panels-label") { SectionLabel("Painéis de senha") }
            if (!queue) item("no-queue") {
                Text(
                    "A fila de senhas está desligada nesta área. Um administrador liga em Gestão → Módulos, no painel.",
                    style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = 20.dp),
                )
            } else if (!admin) item("not-admin") {
                Text(
                    "Só o administrador pareia e desliga painéis. Peça a ele, ou entre com uma conta de administrador.",
                    style = MaterialTheme.typography.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = 20.dp),
                )
            } else {
                item("panels") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        SettingsRow(
                            Icons.Filled.Tablet, "Parear painel ou totem pelo código",
                            subtitle = "No aparelho, escolha “Usar este aparelho como painel ou totem” e digite aqui o código que aparece",
                            onClick = { pairing = true }, modifier = Modifier.testTag("equipment.pair"),
                        )
                        RowDivider()
                        SettingsRow(Icons.Filled.Add, "Criar painel de TV", subtitle = "Um link para abrir no navegador da TV", onClick = { newDisplay = true }, modifier = Modifier.testTag("equipment.newDisplay"))
                        vm.devices.orEmpty().forEach { d ->
                            RowDivider()
                            SettingsRow(
                                Icons.Filled.Tablet, d.instanceName?.ifBlank { null } ?: "Painel ou totem",
                                subtitle = EquipmentRules.situation(d) + (if (d.updated > 0) " · desde ${BrasiliaTime.shortWithTime(d.updated)}" else ""),
                                tint = if (d.status == "revoked") c.muted else c.ok,
                                trailing = if (d.status != "revoked") ({ TextButton(enabled = !vm.busy, onClick = { vm.revokeDevice(d, queue) }) { Text("Desligar", color = c.danger) } }) else null,
                            )
                        }
                        vm.displays.orEmpty().forEach { d ->
                            RowDivider()
                            SettingsRow(
                                Icons.Filled.Tv, d.name.ifBlank { "Painel de TV" }, subtitle = if (d.revoked) "Desligado" else "Ligado pelo link",
                                tint = if (d.revoked) c.muted else c.ok,
                                trailing = if (!d.revoked) ({ TextButton(enabled = !vm.busy, onClick = { vm.revokeDisplay(d, queue) }) { Text("Desligar", color = c.danger) } }) else null,
                            )
                        }
                    }
                }
                WebPanel.url(container.session.serverUrl, WebPanel.QUEUE_SETTINGS)?.let { url ->
                    item("web") {
                        WbCard(Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp)) {
                            SettingsRow(
                                Icons.Filled.OpenInBrowser, "Abrir no navegador", subtitle = "Filas, guichês, aparência do painel e campanhas",
                                tint = c.textSecondary, onClick = { Links.open(context, url) },
                            )
                        }
                    }
                }
            }
        }
    }

    if (newDisplay) {
        var name by remember { mutableStateOf("Painel da recepção") }
        AlertDialog(
            onDismissRequest = { newDisplay = false },
            title = { Text("Criar painel de TV") },
            text = { OutlinedTextField(name, { name = it.take(60) }, label = { Text("Nome do painel") }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(enabled = name.isNotBlank() && !vm.busy, onClick = { vm.createDisplay(name, queue); newDisplay = false }) { Text("Criar") } },
            dismissButton = { TextButton(onClick = { newDisplay = false }) { Text("Voltar") } },
        )
    }
    if (pairing) {
        var code by remember { mutableStateOf("") }
        val normalized = EquipmentRules.normalizeCode(code)
        AlertDialog(
            onDismissRequest = { pairing = false },
            title = { Text("Parear painel ou totem") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Digite o código de 8 letras e números que aparece na tela do aparelho.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(code, { code = it.take(12) }, label = { Text("Código") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("equipment.code"))
                }
            },
            confirmButton = {
                TextButton(enabled = EquipmentRules.validCode(normalized) && !vm.busy, onClick = { vm.pair(normalized, queue) { pairing = false } }) {
                    Text(if (vm.busy) "Pareando…" else "Parear")
                }
            },
            dismissButton = { TextButton(onClick = { pairing = false }) { Text("Voltar") } },
        )
    }
}
