package br.com.queven.wabotia.modules.os

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.moduleDisabled
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** As dependências das telas da ordem por modelo (trocáveis nos testes). Na demonstração não há cache em disco. */
class WorkDeps(
    val client: WorkOrderClient,
    val onFailure: (Throwable) -> Unit,
    val cache: WorkOrderCache?,
    val profile: String,
    val now: () -> Long = { System.currentTimeMillis() },
) {
    companion object {
        fun of(container: AppContainer) = WorkDeps(
            WorkOrderClient(ProfileApi.current(container)),
            { ModuleFailure.handle(container, ModuleIds.SERVICE_ORDERS, it) },
            if (container.isDemo) null else WorkOrderCache.of(container.appContext),
            container.session.profileId.orEmpty(),
        )
    }
}

private const val OFFLINE_READ = "Sem conexão com o Wabotia e nenhuma cópia guardada neste aparelho. Confira a internet e toque em Tentar de novo."

/** A mensagem de uma falha de leitura (lista, ficha, catálogo). */
internal fun readMessage(e: Throwable): String = when {
    WorkOrderRules.isOffline(e) && (e as? QueueException)?.status in setOf(null, 0) -> OFFLINE_READ
    e is QueueException && e.moduleDisabled -> ModuleFailure.DISABLED_MESSAGE
    e is QueueException && (e.status == 403 || e.code == "forbidden") -> WorkOrderRules.FORBIDDEN
    else -> ModuleFailure.message(e)
}

/** O catálogo de modelos: do servidor (guardado no cache) ou, sem conexão, a cópia. */
internal suspend fun loadCatalog(deps: WorkDeps): Pair<List<WorkType>, Long?> {
    return try {
        val raw = deps.client.typesRaw()
        val catalog = WabotiaJson.decodeFromJsonElement(WorkTypeCatalog.serializer(), raw)
        deps.cache?.saveCatalog(deps.profile, raw.toString(), deps.now())
        catalog.data to null
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        val copy = if (WorkOrderRules.isOffline(e)) deps.cache?.catalog(deps.profile) else null
        val types = copy?.let { runCatching { WabotiaJson.decodeFromString(WorkTypeCatalog.serializer(), it.body).data }.getOrNull() }
        if (copy == null || types == null) throw e
        types to copy.savedAt
    }
}

/**
 * Lista das ordens por modelo, com os filtros do painel (modelo, busca, situação e etapa) e paginação. Servidor sem
 * catálogo de modelos (ou só com a ordem simples): [legacy] liga e a tela mostra a lista antiga.
 */
class WorkOrdersViewModel(private val deps: WorkDeps, container: AppContainer? = null) : ViewModel() {
    var catalog by mutableStateOf<List<WorkType>?>(null)
        private set
    var legacy by mutableStateOf(false)
        private set
    var typeId by mutableStateOf<String?>(null)
        private set
    var situation by mutableStateOf("open")
        private set
    var stage by mutableStateOf<String?>(null)
        private set
    var query by mutableStateOf("")
        private set
    var orders by mutableStateOf<List<WorkOrder>>(emptyList())
        private set
    var nextCursor by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** Sem conexão: quando a cópia mostrada foi lida. */
    var offlineAt by mutableStateOf<Long?>(null)
        private set

    private var job: Job? = null

    init {
        container?.let { observeModuleEvents(it, "os.") { load() } }
    }

    val types: List<WorkType> get() = WorkOrderRules.activeTypes(catalog.orEmpty())
    val selectedType: WorkType? get() = catalog?.firstOrNull { it.id == typeId }
    val showTypeLabel: Boolean get() = WorkOrderRules.showTypeLabel(catalog.orEmpty())

    fun selectType(id: String?) {
        if (typeId == id) return
        typeId = id
        stage = null
        orders = emptyList()
        refresh()
    }

    fun selectSituation(value: String) {
        if (situation == value && stage == null) return
        situation = value
        stage = null
        orders = emptyList()
        refresh()
    }

    fun selectStage(value: String?) {
        if (stage == value) return
        stage = value
        orders = emptyList()
        refresh()
    }

    fun search(text: String) {
        query = text
        job?.cancel()
        job = viewModelScope.launch {
            delay(350)
            load()
        }
    }

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (orders.isEmpty()) loading = true
        try {
            if (catalog == null) {
                val (types, savedAt) = try {
                    loadCatalog(deps)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (WorkOrderRules.catalogMissing(e)) {
                        legacy = true
                        return
                    }
                    throw e
                }
                if (WorkOrderRules.activeTypes(types).none { !it.isBuiltin }) {
                    legacy = true
                    return
                }
                catalog = types
                if (savedAt != null) offlineAt = savedAt
            }
            val key = WorkOrderRules.listKey(typeId, situation, stage, query)
            try {
                val raw = deps.client.listRaw(WorkOrderRules.listQuery(catalog.orEmpty(), typeId, situation, stage, query))
                val page = WorkOrderClient.page(raw)
                orders = page.data
                nextCursor = page.nextCursor
                error = null
                offlineAt = null
                deps.cache?.saveList(deps.profile, key, raw.toString(), deps.now())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val copy = if (WorkOrderRules.isOffline(e)) deps.cache?.list(deps.profile, key) else null
                if (copy == null) throw e
                deps.onFailure(e)
                val page = runCatching { WorkOrderClient.page(WabotiaJson.parseToJsonElement(copy.body) as JsonObject) }.getOrNull()
                orders = page?.data.orEmpty()
                nextCursor = null
                offlineAt = copy.savedAt
                error = null
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            error = readMessage(e)
            orders = emptyList()
        } finally {
            loading = false
        }
    }

    fun loadMore() {
        val cursor = nextCursor ?: return
        if (loadingMore || offlineAt != null) return
        loadingMore = true
        viewModelScope.launch {
            try {
                val page = WorkOrderClient.page(deps.client.listRaw(WorkOrderRules.listQuery(catalog.orEmpty(), typeId, situation, stage, query, cursor)))
                val known = orders.map { it.id }.toSet()
                orders = orders + page.data.filter { it.id !in known }
                nextCursor = page.nextCursor
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                deps.onFailure(e)
                nextCursor = null
            } finally {
                loadingMore = false
            }
        }
    }
}

/** A folha "Complete os dados desta etapa": os campos faltantes e o passo que será repetido depois de salvar. */
data class MissingFieldsSheet(val next: NextStage, val note: String?, val fields: List<WorkField>, val labels: List<String>)

/** Ficha da ordem por modelo: etapas, campos, checklist com foto, orçamento (leitura e envio) e histórico. */
class WorkOrderViewModel(val id: String, private val deps: WorkDeps, container: AppContainer? = null) : ViewModel() {
    var order by mutableStateOf<WorkOrder?>(null)
        private set
    var type by mutableStateOf<WorkType?>(null)
        private set
    var history by mutableStateOf<List<WorkHistory>>(emptyList())
        private set
    var historyCursor by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    /** "Enviando a foto…" durante o envio da foto do checklist. */
    var progress by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)
    var offlineAt by mutableStateOf<Long?>(null)
        private set
    var missingSheet by mutableStateOf<MissingFieldsSheet?>(null)
    /** A foto aberta em "Ver foto" (bytes da imagem), ou o erro ao baixar. */
    var photo by mutableStateOf<ByteArray?>(null)
    var photoLoading by mutableStateOf(false)
        private set

    private val keys = IntentKeys()
    private var catalog: List<WorkType>? = null

    init {
        container?.let { observeModuleEvents(it, "os.") { load() } }
    }

    /** Sem conexão ou ordem encerrada: nenhum botão de mudança. */
    val readOnly: Boolean get() = offlineAt != null || order?.closed != false

    val canEdit: Boolean get() = !readOnly && busy == null

    val neededNext: Set<String> get() = order?.let { WorkFields.neededNext(type, it) }.orEmpty()

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (order == null) loading = true
        try {
            val raw = deps.client.orderRaw(id)
            val fresh = WabotiaJson.decodeFromJsonElement(WorkOrder.serializer(), raw)
            order = fresh
            offlineAt = null
            loadError = null
            val historyRaw = runCatching { deps.client.historyRaw(id) }.getOrNull()
            if (historyRaw != null) {
                val page = WorkOrderClient.history(historyRaw)
                history = page.data
                historyCursor = page.nextCursor
            }
            deps.cache?.saveOrder(deps.profile, id, raw.toString(), historyRaw?.toString(), deps.now())
            if (type == null || type?.id != fresh.typeId) loadType(fresh.typeId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            val copy = if (WorkOrderRules.isOffline(e)) deps.cache?.order(deps.profile, id) else null
            val cached = copy?.let { runCatching { WabotiaJson.decodeFromString(WorkOrder.serializer(), it.body) }.getOrNull() }
            if (copy != null && cached != null) {
                order = cached
                history = copy.history?.let { WorkOrderClient.history(WabotiaJson.parseToJsonElement(it)).data }.orEmpty()
                historyCursor = null
                offlineAt = copy.savedAt
                loadError = null
                if (type == null) loadType(cached.typeId)
            } else if (order == null) {
                loadError = readMessage(e)
            } else if (WorkOrderRules.isOffline(e)) {
                // A ficha já estava na tela: continua, mas sem botões de mudança.
                offlineAt = offlineAt ?: deps.now()
            }
        } finally {
            loading = false
        }
    }

    private suspend fun loadType(typeId: String?) {
        if (typeId.isNullOrBlank() || typeId == BUILTIN_WORK_TYPE) return
        val list = catalog ?: runCatching { loadCatalog(deps).first }.getOrNull()?.also { catalog = it }
        type = list?.firstOrNull { it.id == typeId } ?: runCatching { deps.client.type(typeId) }.getOrNull()
    }

    fun loadMoreHistory() {
        val cursor = historyCursor ?: return
        viewModelScope.launch {
            try {
                val page = WorkOrderClient.history(deps.client.historyRaw(id, cursor))
                val known = history.map { it.id }.toSet()
                history = history + page.data.filter { it.id !in known }
                historyCursor = page.nextCursor
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                deps.onFailure(e)
                notice = readMessage(e)
            }
        }
    }

    /** Um botão de `next_stages`. `note` é o motivo (obrigatório para cancelar e voltar). */
    fun move(next: NextStage, note: String?) {
        val current = order ?: return
        val reason = note?.trim()?.takeIf { it.isNotEmpty() }
        if (WorkOrderRules.needsReason(current.state, next.baseStatus) && reason == null) {
            notice = WorkOrderRules.REASON_REQUIRED
            return
        }
        lastNote = reason
        write("stage:${next.transitionId}:${current.version}", successText(next)) { key -> moveNow(next, reason, current.version, key) }
    }

    private fun successText(next: NextStage) =
        if (next.kind == "customer_approval") "Pedido de aprovação enviado ao cliente" else "Etapa: ${next.stageLabel.ifBlank { next.stage }}"

    private suspend fun moveNow(next: NextStage, reason: String?, version: Int, key: String): WorkOrder {
        val approval = next.kind == "customer_approval"
        val body = StageRequest(next.transitionId, version, if (approval) null else reason)
        return deps.client.moveStage(id, body, approval, key)
    }

    /** `missing_fields`: busca o que falta e abre a folha com os campos; sem campo editável, diz o que falta. */
    private suspend fun openMissing(next: NextStage, note: String?, e: QueueException) {
        val requirements = runCatching { deps.client.requirements(id, next.transitionId) }.getOrNull()
        val current = order
        val missingIds = requirements?.missing?.map { it.fieldId }.orEmpty().toSet()
        val fields = WorkFields.common(current?.fields.orEmpty()).filter { it.id in missingIds }
        val labels = requirements?.missing?.map { it.label.ifBlank { it.fieldId } }.orEmpty()
        if (fields.isNotEmpty()) {
            missingSheet = MissingFieldsSheet(next, note, fields, labels)
        } else {
            notice = if (labels.isNotEmpty()) "Para mudar de etapa, falta preencher: ${labels.joinToString(", ")}. Complete no painel." else e.message ?: "Faltam dados para esta etapa. Complete no painel."
        }
    }

    /** "Salvar e tentar de novo": grava os campos (com todos os valores atuais) e repete a mudança de etapa. */
    fun saveMissingAndRetry(sheet: MissingFieldsSheet, draft: Map<String, String>) {
        val current = order ?: return
        val required = sheet.fields.map { it.id }.toSet()
        val full = WorkFields.draftOf(current.fields, current.extra) + draft
        val parsed = WorkFields.parse(current.fields, full, required, current.extra)
        if (parsed is WorkFields.Parsed.Invalid) {
            notice = parsed.message
            return
        }
        val extra = (parsed as WorkFields.Parsed.Ok).values
        missingSheet = null
        write("fields+stage:${sheet.next.transitionId}:${current.version}:${extra}", successText(sheet.next)) { key ->
            val saved = deps.client.updateExtra(id, UpdateExtraRequest(current.version, extra), key)
            order = saved
            keys.settle(null)
            moveNow(sheet.next, sheet.note, saved.version, keys.key("stage:${sheet.next.transitionId}:${saved.version}"))
        }
    }

    /** "Editar campos": `PATCH {version, extra}` com todos os valores comuns (apagar vai como nulo). */
    fun saveFields(draft: Map<String, String>): Boolean {
        val current = order ?: return false
        val parsed = WorkFields.parse(current.fields, draft, WorkFields.required(current.fields), current.extra)
        if (parsed is WorkFields.Parsed.Invalid) {
            notice = parsed.message
            return false
        }
        val extra = (parsed as WorkFields.Parsed.Ok).values
        write("fields:${current.version}:$extra", "Campos salvos") { key -> deps.client.updateExtra(id, UpdateExtraRequest(current.version, extra), key) }
        return true
    }

    /** Marca ou desmarca um item da etapa atual que não pede foto (desmarcar nunca pede foto). */
    fun toggle(item: ChecklistEntry) {
        val current = order ?: return
        val done = !item.done
        write("check:${item.id}:$done:${current.version}", if (done) "Item marcado" else "Item desmarcado") { key ->
            deps.client.markChecklist(id, ChecklistMarkRequest(current.version, item.id, done), key)
        }
    }

    /**
     * Item com foto: reserva o documento, envia os bytes ao `upload_url` (só do mesmo servidor), conclui o envio, relê a
     * ordem para a versão atual e marca o item com a foto.
     */
    fun markWithPhoto(item: ChecklistEntry, jpeg: ByteArray) {
        if (jpeg.isEmpty()) return
        if (jpeg.size > WorkOrderRules.PHOTO_MAX_BYTES) {
            notice = WorkOrderRules.PHOTO_TOO_BIG
            return
        }
        val stamp = deps.now()
        write("photo:${item.id}:${jpeg.size}", "Item marcado com a foto") { key ->
            progress = "Enviando a foto…"
            val reservation = deps.client.reserveDocument(
                id, DocumentReserveRequest("checklist-${item.id}-$stamp.jpg", "image/jpeg", jpeg.size.toLong()), key,
            )
            keys.settle(null)
            val uploaded = deps.client.upload(reservation, jpeg, "image/jpeg", keys.key("upload:${reservation.id}"))
            keys.settle(null)
            deps.client.completeDocument(id, reservation.id, CompleteDocumentRequest(uploaded.version, uploaded.uploadAttempt), keys.key("complete:${reservation.id}"))
            keys.settle(null)
            val fresh = deps.client.order(id)
            order = fresh
            deps.client.markChecklist(id, ChecklistMarkRequest(fresh.version, item.id, true, reservation.id), keys.key("check:${item.id}:true:${fresh.version}"))
        }
    }

    fun cameraUnavailable() {
        notice = WorkOrderRules.CAMERA_DENIED
    }

    fun sendQuote() {
        val current = order ?: return
        write("quote/send:${current.quote?.version ?: 0}", "Orçamento enviado ao cliente") { key -> deps.client.sendQuote(id, key) }
    }

    fun openPhoto(documentId: String) {
        if (photoLoading) return
        photoLoading = true
        viewModelScope.launch {
            try {
                photo = deps.client.documentContent(id, documentId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                deps.onFailure(e)
                notice = if (WorkOrderRules.isOffline(e)) "Sem conexão: a foto não está guardada neste aparelho. Conecte-se para ver." else readMessage(e)
            } finally {
                photoLoading = false
            }
        }
    }

    private fun write(signature: String, success: String, block: suspend (String) -> WorkOrder) {
        if (busy != null) return
        if (offlineAt != null) {
            notice = WorkOrderRules.OFFLINE_WRITE
            return
        }
        val key = keys.key("$signature:$id")
        busy = signature
        notice = null
        viewModelScope.launch {
            try {
                val updated = block(key)
                keys.settle(null)
                order = updated
                done = success
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                deps.onFailure(e)
                handleWriteError(signature, e)
            } finally {
                busy = null
                progress = null
            }
        }
    }

    private suspend fun handleWriteError(signature: String, e: Exception) {
        val q = e as? QueueException
        when (q?.code) {
            "missing_fields" -> {
                val next = order?.nextStages?.firstOrNull { signature.contains(":${it.transitionId}:") }
                if (next != null) openMissing(next, pendingNote(signature), q) else notice = q.message
                return
            }
            "checklist_required", "photo_required", "photo_not_found", "checklist_unavailable" -> {
                notice = q.message ?: WorkOrderRules.message(e)
                load()
                return
            }
            "version_conflict" -> {
                notice = WorkOrderRules.VERSION_CONFLICT
                load()
                return
            }
        }
        notice = WorkOrderRules.message(e)
        if (!WorkOrderRules.isOffline(e)) load()
    }

    /** O motivo do último pedido de etapa, para repetir depois de completar os campos. */
    private var lastNote: String? = null

    private fun pendingNote(signature: String): String? = lastNote.takeIf { signature.startsWith("stage:") || signature.startsWith("fields+stage:") }

    val pendingKey: String? get() = keys.pendingKey
}

/**
 * Abrir ordem por modelo: modelo, cliente do cadastro, objeto do serviço (quando o modelo pede), campos do modelo,
 * item, descrição e observação. O modelo simples (embutido) e o servidor sem modelos abrem a tela antiga ([legacy]).
 */
class NewWorkOrderViewModel(val conversationId: String?, val customerLabel: String?, private val deps: WorkDeps) : ViewModel() {
    var catalog by mutableStateOf<List<WorkType>?>(null)
        private set
    var legacy by mutableStateOf(false)
        private set
    var loading by mutableStateOf(true)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    var type by mutableStateOf<WorkType?>(null)
        private set

    var contactQuery by mutableStateOf("")
        private set
    var contacts by mutableStateOf<List<WorkContact>>(emptyList())
        private set
    var searching by mutableStateOf(false)
        private set
    var searched by mutableStateOf(false)
        private set
    var contact by mutableStateOf<WorkContact?>(null)
        private set
    /** O cliente veio da conversa (não troca). */
    var fromConversation by mutableStateOf(false)
        private set

    var objectType by mutableStateOf<ServiceObjectType?>(null)
        private set
    var objects by mutableStateOf<List<ServiceObjectView>>(emptyList())
        private set
    var objectsLoading by mutableStateOf(false)
        private set
    var chosenObject by mutableStateOf<ServiceObjectView?>(null)
        private set
    var newObject by mutableStateOf(false)
        private set
    var objectDraft by mutableStateOf<Map<String, String>>(emptyMap())

    var fieldDraft by mutableStateOf<Map<String, String>>(emptyMap())
    var item by mutableStateOf("")
    var problem by mutableStateOf("")
    var notes by mutableStateOf("")

    var busy by mutableStateOf(false)
        private set
    var notice by mutableStateOf<String?>(null)
    var result by mutableStateOf<WorkOrder?>(null)
        private set

    private val keys = IntentKeys()
    private var searchJob: Job? = null

    val customTypes: List<WorkType> get() = WorkOrderRules.activeTypes(catalog.orEmpty()).filter { !it.isBuiltin }
    val hasBuiltin: Boolean get() = catalog.orEmpty().any { it.isBuiltin }
    val needsObject: Boolean get() = !type?.objectTypeId.isNullOrBlank()
    val requiredFields: Set<String> get() = type?.let(WorkFields::requiredAtOpening).orEmpty()

    fun load() {
        if (catalog != null || legacy) return
        viewModelScope.launch {
            loading = true
            try {
                val (types, _) = loadCatalog(deps)
                val custom = WorkOrderRules.activeTypes(types).filter { !it.isBuiltin }
                if (custom.isEmpty()) {
                    legacy = true
                    return@launch
                }
                catalog = types
                if (custom.size == 1) chooseType(custom.first())
                if (conversationId != null) loadConversationContact(conversationId)
                loadError = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (WorkOrderRules.catalogMissing(e)) {
                    legacy = true
                } else {
                    deps.onFailure(e)
                    loadError = readMessage(e)
                }
            } finally {
                loading = false
            }
        }
    }

    private suspend fun loadConversationContact(id: String) {
        val raw = runCatching { deps.client.api.raw("conversations/$id") }.getOrNull() as? JsonObject
        val c = (raw?.get("conversation") as? JsonObject) ?: raw
        fun str(key: String) = (c?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
        val contactId = str("contact_id") ?: return
        fromConversation = true
        contact = WorkContact(id = contactId, name = str("contact_name") ?: customerLabel, phone = str("phone"))
        loadObjects()
    }

    /** O modelo simples abre a tela antiga; um modelo próprio prepara os campos e o objeto. */
    fun chooseType(t: WorkType) {
        if (t.isBuiltin) {
            legacy = true
            return
        }
        if (type?.id == t.id) return
        type = t
        fieldDraft = WorkFields.draftOf(t.fields, JsonObject(emptyMap()))
        clearObject()
        objectType = null
        if (!t.objectTypeId.isNullOrBlank()) {
            viewModelScope.launch {
                objectType = runCatching { deps.client.objectTypes().data.firstOrNull { it.id == t.objectTypeId } }.getOrNull()
                objectDraft = WorkFields.draftOf(objectType?.fields.orEmpty(), JsonObject(emptyMap()))
                loadObjects()
            }
        }
    }

    fun searchContacts(text: String) {
        contactQuery = text
        searchJob?.cancel()
        if (text.trim().length < 2) {
            contacts = emptyList()
            searched = false
            return
        }
        searchJob = viewModelScope.launch {
            delay(350)
            searching = true
            try {
                contacts = deps.client.contacts(text)
                searched = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                deps.onFailure(e)
                notice = readMessage(e)
            } finally {
                searching = false
            }
        }
    }

    /** Trocar de cliente limpa o objeto escolhido. */
    fun chooseContact(c: WorkContact?) {
        if (fromConversation) return
        contact = c
        clearObject()
        if (c != null) viewModelScope.launch { loadObjects() }
    }

    private fun clearObject() {
        chosenObject = null
        newObject = false
        objects = emptyList()
        objectDraft = WorkFields.draftOf(objectType?.fields.orEmpty(), JsonObject(emptyMap()))
    }

    private suspend fun loadObjects() {
        val typeId = type?.objectTypeId?.takeIf { it.isNotBlank() } ?: return
        val contactId = contact?.id?.takeIf { it.isNotBlank() } ?: return
        objectsLoading = true
        try {
            objects = deps.client.objects(contactId, typeId).data.filter { !it.archived }
            if (objects.isEmpty()) newObject = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            notice = readMessage(e)
        } finally {
            objectsLoading = false
        }
    }

    fun chooseObject(o: ServiceObjectView) {
        chosenObject = o
        newObject = false
    }

    fun startNewObject() {
        chosenObject = null
        newObject = true
    }

    /** O corpo do pedido, ou a mensagem do primeiro problema. */
    fun buildRequest(): Result<CreateWorkOrderRequest> {
        val t = type ?: return Result.failure(IllegalStateException("Escolha o modelo da ordem."))
        val itemText = item.trim()
        val problemText = problem.trim()
        val c = contact
        if (c == null && conversationId == null) return Result.failure(IllegalStateException("Escolha o cliente."))
        val extra = when (val parsed = WorkFields.parse(t.fields, fieldDraft, requiredFields)) {
            is WorkFields.Parsed.Invalid -> return Result.failure(IllegalStateException(parsed.message))
            is WorkFields.Parsed.Ok -> parsed.values
        }
        if (itemText.isEmpty()) return Result.failure(IllegalStateException("${t.labels.item.ifBlank { "Item" }}: preenchimento obrigatório."))
        if (itemText.length > 200) return Result.failure(IllegalStateException("${t.labels.item.ifBlank { "Item" }}: até 200 caracteres."))
        if (problemText.isEmpty()) return Result.failure(IllegalStateException("${t.labels.problem.ifBlank { "Descrição" }}: preenchimento obrigatório."))
        if (problemText.length > 2000) return Result.failure(IllegalStateException("${t.labels.problem.ifBlank { "Descrição" }}: até 2000 caracteres."))
        var opening: ObjectOpening? = null
        val objectTypeId = t.objectTypeId?.takeIf { it.isNotBlank() }
        if (objectTypeId != null) {
            val singular = objectType?.labels?.singular?.ifBlank { null } ?: "objeto"
            if (c?.id.isNullOrBlank()) return Result.failure(IllegalStateException(WorkOrderRules.CUSTOMER_REQUIRED))
            val chosen = chosenObject
            opening = when {
                chosen != null -> ObjectOpening.existing(chosen.id, chosen.version)
                newObject -> when (val parsed = WorkFields.parse(objectType?.fields.orEmpty(), objectDraft)) {
                    is WorkFields.Parsed.Invalid -> return Result.failure(IllegalStateException(parsed.message))
                    is WorkFields.Parsed.Ok -> ObjectOpening.new(objectTypeId, parsed.values)
                }
                else -> return Result.failure(IllegalStateException("Escolha o ${singular.lowercase()} ou cadastre outro."))
            }
        }
        val withObject = opening != null
        return Result.success(
            CreateWorkOrderRequest(
                typeId = t.id,
                item = itemText,
                problem = problemText,
                extra = extra.takeIf { it.isNotEmpty() },
                notes = notes.trim().takeIf { it.isNotEmpty() },
                contactId = if (withObject) c?.id else null,
                serviceObject = opening,
                customerName = if (withObject || conversationId != null) null else c?.name?.takeIf { it.isNotBlank() },
                phone = if (withObject || conversationId != null) null else c?.phone?.takeIf { it.isNotBlank() },
                conversationId = conversationId,
            ),
        )
    }

    fun submit() {
        if (busy) return
        val request = buildRequest()
        val body = request.getOrElse {
            notice = it.message
            return
        }
        busy = true
        notice = null
        val key = keys.key("open:" + WorkOrderClient.encode(CreateWorkOrderRequest.serializer(), body).toString())
        viewModelScope.launch {
            try {
                result = deps.client.create(body, key)
                keys.settle(null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                deps.onFailure(e)
                notice = createMessage(e)
                val code = (e as? QueueException)?.code
                if (code == "object_definition_conflict" || code == "object_archived") {
                    clearObject()
                    loadObjects()
                }
            } finally {
                busy = false
            }
        }
    }

    private fun createMessage(e: Exception): String {
        val q = e as? QueueException ?: return WorkOrderRules.message(e)
        return when (q.code) {
            "object_required" -> "Escolha o ${objectType?.labels?.singular?.lowercase()?.ifBlank { null } ?: "objeto"} do serviço ou cadastre outro."
            "missing_fields" -> q.message?.takeIf { it.isNotBlank() } ?: "Faltam campos obrigatórios. Confira e tente de novo."
            else -> WorkOrderRules.message(e)
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}
