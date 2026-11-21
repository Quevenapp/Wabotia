package br.com.queven.wabotia.modules.clientes

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.SkeletonList
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Clientes do atendimento (o cadastro de contatos da área, `GET/POST/PATCH /contacts`), só o básico: nome, telefone,
 * e-mail e observação. Ficha completa, importação, mesclagem e ERP ficam no painel. Mesmo desenho do iOS
 * (`Modules/Clientes/ClientesViews.swift`).
 */

@Serializable
data class BasicContact(
    val id: String,
    val name: String = "",
    val phone: String = "",
    val email: String = "",
    val notes: String = "",
    val version: Int = 1,
    @SerialName("erp_contact_id") val erpContactId: String? = null,
) {
    val title: String get() = name.ifBlank { PhoneText.display(phone) ?: "Sem nome" }
}

@Serializable
data class BasicContactPage(val data: List<BasicContact> = emptyList(), @SerialName("next_cursor") val nextCursor: String? = null)

/** Regras do formulário, sem rede (as mesmas mensagens do servidor, para não precisar ir até ele). */
object ContactForm {
    private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

    /** O que falta ou está errado; `null` quando dá para salvar. */
    fun problem(name: String, phone: String, email: String, notes: String): String? = when {
        name.isBlank() -> "Informe o nome do cliente."
        name.trim().length > 200 -> "Nome: use até 200 caracteres."
        phone.isNotBlank() && phone.count(Char::isDigit) !in 8..15 -> "Telefone: informe de 8 a 15 dígitos, com DDD."
        email.isNotBlank() && !EMAIL.matches(email.trim()) -> "E-mail inválido."
        notes.length > 2000 -> "Observação: use até 2000 caracteres."
        else -> null
    }

    /** Corpo do cadastro (`phone_mode: human_br`: aceita "(11) 99999-0000"). Na edição, vai a versão esperada. */
    fun body(name: String, phone: String, email: String, notes: String, version: Int? = null): JsonObject = JsonObject(
        buildMap {
            put("name", JsonPrimitive(name.trim()))
            put("phone", JsonPrimitive(phone.trim()))
            put("email", JsonPrimitive(email.trim()))
            put("notes", JsonPrimitive(notes.trim()))
            put("phone_mode", JsonPrimitive("human_br"))
            version?.let { put("expected_version", JsonPrimitive(it)) }
        },
    )
}

class ClientesClient(private val api: ProfileApi) {
    suspend fun list(query: String): List<BasicContact> =
        api.get("contacts", BasicContactPage.serializer(), mapOf("limit" to "50", "q" to query.trim().takeIf { it.isNotEmpty() })).data

    suspend fun get(id: String): BasicContact = api.get("contacts/$id", BasicContact.serializer())

    suspend fun create(body: JsonObject, key: String): BasicContact = api.send("POST", "contacts", body, key, BasicContact.serializer())

    suspend fun update(id: String, body: JsonObject, key: String): BasicContact = api.send("PATCH", "contacts/$id", body, key, BasicContact.serializer())
}

private fun contactMessage(e: Throwable): String = when {
    e is QueueException && e.status == 403 -> "Seu acesso não inclui o cadastro de clientes. Peça ao administrador em Gestão → Pessoas e acessos."
    e is QueueException && e.status == 409 -> "O cadastro mudou em outro aparelho. Volte e abra o cliente de novo."
    else -> ModuleFailure.actionMessage(e)
}

class ClientesViewModel(private val container: AppContainer) : ViewModel() {
    private val client = ClientesClient(ProfileApi.current(container))
    var query by mutableStateOf("")
    var items by mutableStateOf<List<BasicContact>>(emptyList()); private set
    var loading by mutableStateOf(true); private set
    var error by mutableStateOf<String?>(null); private set
    private var job: Job? = null

    init { reload() }

    fun search(text: String) {
        query = text
        job?.cancel()
        job = viewModelScope.launch { delay(300); load() }
    }

    fun reload() {
        job?.cancel()
        job = viewModelScope.launch { load() }
    }

    private suspend fun load() {
        try {
            items = client.list(query)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ModuleFailure.handle(container, "contacts", e)
            error = contactMessage(e)
        }
        loading = false
    }
}

class ContactFormViewModel(private val container: AppContainer, private val id: String?) : ViewModel() {
    private val client = ClientesClient(ProfileApi.current(container))
    var name by mutableStateOf("")
    var phone by mutableStateOf("")
    var email by mutableStateOf("")
    var notes by mutableStateOf("")
    var loading by mutableStateOf(id != null); private set
    var saving by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null)
    private var version: Int = 1
    private var pending: Pair<String, String>? = null

    init {
        if (id != null) viewModelScope.launch {
            try {
                val c = client.get(id)
                name = c.name; phone = c.phone; email = c.email; notes = c.notes; version = c.version
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ModuleFailure.handle(container, "contacts", e)
                notice = contactMessage(e)
            }
            loading = false
        }
    }

    val problem: String? get() = ContactForm.problem(name, phone, email, notes)

    fun save(done: () -> Unit) {
        if (saving || problem != null) return
        val body = ContactForm.body(name, phone, email, notes, if (id != null) version else null)
        val signature = body.toString()
        val key = pending?.takeIf { it.first == signature }?.second ?: QueueClient.newKey().also { pending = signature to it }
        saving = true
        viewModelScope.launch {
            try {
                if (id == null) client.create(body, key) else client.update(id, body, key)
                pending = null
                done()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!(e is QueueException && e.retryable)) pending = null
                ModuleFailure.handle(container, "contacts", e)
                notice = contactMessage(e)
            }
            saving = false
        }
    }
}

@Composable
fun ClientesScreen(container: AppContainer, onBack: () -> Unit, openForm: (String?) -> Unit, refreshKey: Int = 0) {
    val vm: ClientesViewModel = viewModel { ClientesViewModel(container) }
    val c = Wb.colors
    LaunchedEffect(refreshKey) { if (refreshKey > 0) vm.reload() }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Clientes", onBack) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { openForm(null) }, containerColor = c.brand, contentColor = c.onBrand,
                modifier = Modifier.testTag("clientes.new"),
                icon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) }, text = { Text("Novo cliente") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SearchField(vm.query, vm::search, placeholder = "Buscar por nome, telefone ou e-mail", modifier = Modifier.padding(16.dp))
            when {
                vm.loading -> SkeletonList(rows = 6)
                vm.error != null -> ErrorState(vm.error!!, onRetry = vm::reload)
                vm.items.isEmpty() -> EmptyState(
                    Icons.Filled.Person, if (vm.query.isBlank()) "Nenhum cliente cadastrado" else "Nenhum cliente encontrado",
                    subtitle = "Toque em Novo cliente para cadastrar com nome e telefone.",
                )
                else -> LazyColumn(Modifier.fillMaxSize().testTag("clientes.list"), contentPadding = PaddingValues(bottom = 96.dp)) {
                    items(vm.items, key = { it.id }) { contact ->
                        SettingsRow(
                            Icons.Filled.Person, contact.title,
                            subtitle = listOfNotNull(PhoneText.display(contact.phone), contact.email.ifBlank { null }).joinToString(" · ").ifBlank { null },
                            onClick = { openForm(contact.id) },
                        )
                        RowDivider()
                    }
                }
            }
        }
    }
}

@Composable
fun ContactFormScreen(container: AppContainer, id: String?, onBack: () -> Unit, onSaved: () -> Unit) {
    val vm: ContactFormViewModel = viewModel(key = "contact-form-$id") { ContactFormViewModel(container, id) }
    val c = Wb.colors
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar(if (id == null) "Novo cliente" else "Cliente", onBack) },
    ) { padding ->
        if (vm.loading) {
            SkeletonList(Modifier.padding(padding), rows = 4, avatar = false)
            return@Scaffold
        }
        Column(
            Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedTextField(vm.name, { vm.name = it }, label = { Text("Nome") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("cliente.name"))
            OutlinedTextField(
                vm.phone, { vm.phone = it }, label = { Text("Telefone com DDD (opcional)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth().testTag("cliente.phone"),
            )
            OutlinedTextField(
                vm.email, { vm.email = it }, label = { Text("E-mail (opcional)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth().testTag("cliente.email"),
            )
            OutlinedTextField(vm.notes, { vm.notes = it }, label = { Text("Observação (opcional)") }, minLines = 3, modifier = Modifier.fillMaxWidth().testTag("cliente.notes"))
            val problem = vm.problem
            if (problem != null && (vm.name.isNotEmpty() || vm.phone.isNotEmpty() || vm.email.isNotEmpty())) {
                Text(problem, style = MaterialTheme.typography.bodySmall, color = c.danger)
            }
            vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
            PrimaryButton("Salvar", { vm.save(onSaved) }, Modifier.testTag("cliente.save"), loading = vm.saving, enabled = problem == null)
            Text(
                "Documento, endereço, histórico e o cadastro do ERP ficam no painel, em Contatos.",
                style = MaterialTheme.typography.bodySmall, color = c.textSecondary,
            )
        }
    }
}
