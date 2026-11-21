import Foundation
import UIKit

/// Estado da entrada "Ordens de serviço": carregando o catálogo, servidor sem modelos (lista antiga) ou pronta.
enum WorkEntryMode: Equatable {
    case loading
    case legacy
    case ready
    case failed(String)
}

// MARK: - Lista

/// Lista das ordens por modelo: filtro de modelo, situação, etapa (com modelo escolhido) e busca, paginada pelo cursor.
/// Sem catálogo no servidor (versão anterior aos modelos) ou sem modelo próprio ativo, a tela mostra a lista antiga.
@MainActor
final class WorkOrdersViewModel: ObservableObject {
    @Published private(set) var mode: WorkEntryMode = .loading
    @Published private(set) var catalog: WorkTypeCatalog?
    @Published private(set) var typeId: String?
    @Published private(set) var situation: WorkOrderRules.Situation = .open
    @Published private(set) var stage: String?
    @Published private(set) var query = ""
    @Published private(set) var orders: [WorkOrder] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var error: String?
    /// Sem conexão: hora da cópia mostrada.
    @Published private(set) var offlineSince: Int64?

    private let client: WorkOrderClient
    private let cache: WorkOrderCache?
    private let onFailure: (QueueError) -> Void
    private var events: ModuleEvents?
    private var generation = 0
    private var searchTask: Task<Void, Never>?

    init(client: WorkOrderClient, cache: WorkOrderCache?, onFailure: @escaping (QueueError) -> Void) {
        self.client = client
        self.cache = cache
        self.onFailure = onFailure
    }

    convenience init() {
        self.init(client: WorkOrderClient(api: .current()), cache: WorkOrderCache.current(), onFailure: ModuleFailure.handler(ModuleId.serviceOrders))
    }

    var selectedType: WorkTypeView? { catalog?.type(typeId) }
    var types: [WorkTypeView] { catalog?.active ?? [] }
    var showsTypeLabel: Bool { types.count > 1 }
    var stages: [WorkStage] { selectedType?.stages ?? [] }
    var currentQuery: [String: String] { WorkOrderRules.listQuery(catalog: catalog, typeId: typeId, situation: situation, stage: stage, query: query) }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "os.") { [weak self] in
            guard let self, self.mode == .ready else { return }
            await self.load()
        }
    }

    func start() async {
        if catalog == nil || mode != .ready { await loadCatalog() }
        if mode == .ready { await load() }
    }

    func loadCatalog() async {
        do {
            let result = try await client.types()
            cache?.saveCatalog(result)
            apply(result)
        } catch {
            if WorkOrderRules.isOldServer(error) { mode = .legacy; return }
            if WorkOrderRules.isNetwork(error), let cached = cache?.catalog() {
                apply(cached.catalog)
                offlineSince = cached.savedAt
                return
            }
            if WorkOrderRules.isNetwork(error) { mode = .legacy; return }
            if let e = error as? QueueError { onFailure(e) }
            mode = .failed(WorkOrderRules.message(error))
        }
    }

    private func apply(_ result: WorkTypeCatalog) {
        catalog = result
        if let typeId, result.type(typeId)?.isActive != true { self.typeId = nil; stage = nil }
        mode = result.activeCustom.isEmpty ? .legacy : .ready
    }

    func setType(_ id: String?) {
        guard typeId != id else { return }
        typeId = id
        stage = nil
        reload()
    }

    func setSituation(_ value: WorkOrderRules.Situation) {
        guard situation != value || stage != nil else { return }
        situation = value
        stage = nil
        reload()
    }

    func setStage(_ id: String?) {
        guard stage != id else { return }
        stage = id
        reload()
    }

    func search(_ text: String) {
        query = text
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    private func reload() {
        orders = []
        nextCursor = nil
        Task { await load() }
    }

    func load() async {
        generation += 1
        let mine = generation
        let params = currentQuery
        let key = WorkOrderRules.listKey(params)
        loading = true
        do {
            let page = try await client.list(params)
            guard mine == generation else { return }
            orders = page.data ?? []
            nextCursor = page.nextCursor
            error = nil
            offlineSince = nil
            cache?.saveList(key: key, orders: orders, nextCursor: nil)
        } catch {
            guard mine == generation else { return }
            if WorkOrderRules.isNetwork(error), let cached = cache?.list(key: key) {
                orders = cached.orders
                nextCursor = nil
                offlineSince = cached.savedAt
                self.error = nil
            } else {
                if let e = error as? QueueError { onFailure(e) }
                self.error = WorkOrderRules.isNetwork(error) ? "Sem conexão com o Vinki e ainda não há cópia desta lista no aparelho. Conecte-se e tente de novo." : WorkOrderRules.message(error)
            }
        }
        loading = false
    }

    func loadMore() async {
        guard !loadingMore, offlineSince == nil, let cursor = nextCursor else { return }
        loadingMore = true
        let mine = generation
        if let more = try? await client.list(currentQuery, cursor: cursor), mine == generation {
            nextCursor = more.nextCursor
            let known = Set(orders.map(\.id))
            orders += (more.data ?? []).filter { !known.contains($0.id) }
        }
        loadingMore = false
    }
}

// MARK: - Ficha

/// Pedido de dados que faltam para mudar de etapa (`missing_fields`).
struct WorkRequirementsRequest: Identifiable, Equatable {
    let next: WorkNextStage
    let note: String?
    let fields: [WorkField]
    let internalMissing: Bool
    var id: String { next.transitionId }
}

/// A ficha da ordem por modelo: etapas, checklist (com foto), campos, orçamento só leitura e histórico.
@MainActor
final class WorkOrderViewModel: ObservableObject {
    @Published private(set) var order: WorkOrder?
    @Published private(set) var history: [WorkHistoryEntry] = []
    @Published private(set) var historyCursor: String?
    @Published private(set) var catalog: WorkTypeCatalog?
    @Published private(set) var type: WorkTypeView?
    @Published private(set) var loading = false
    @Published private(set) var busy: String?
    @Published private(set) var progress: String?
    @Published var notice: String?
    @Published private(set) var done: String?
    @Published private(set) var offlineSince: Int64?
    @Published var requirements: WorkRequirementsRequest?

    let id: String
    let client: WorkOrderClient
    private let cache: WorkOrderCache?
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var events: ModuleEvents?

    init(id: String, client: WorkOrderClient, cache: WorkOrderCache?, catalog: WorkTypeCatalog? = nil, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.client = client
        self.cache = cache
        self.catalog = catalog
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: WorkOrderClient(api: .current()), cache: WorkOrderCache.current(), onFailure: ModuleFailure.handler(ModuleId.serviceOrders))
    }

    /// Sem conexão: tudo só leitura.
    var readOnly: Bool { offlineSince != nil }
    var canChange: Bool { !readOnly && busy == nil && !(order?.isClosed ?? true) }
    var askedNext: Set<String> { order.map { WorkFields.askedNext(type, order: $0) } ?? [] }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "os.") { [weak self] in await self?.load() }
    }

    func load() async {
        if order == nil { loading = true }
        do {
            async let o = client.order(id)
            async let h = client.history(id)
            let (fresh, page) = try await (o, h)
            order = fresh
            history = page.data ?? []
            historyCursor = page.nextCursor
            offlineSince = nil
            await resolveType(fresh)
            cache?.saveDetail(order: fresh, history: history, catalog: catalog)
        } catch {
            if WorkOrderRules.isNetwork(error), let cached = cache?.detail(id) {
                order = cached.order
                history = cached.history
                historyCursor = nil
                if catalog == nil { catalog = cached.catalog }
                type = catalog?.type(cached.order.typeId)
                offlineSince = cached.savedAt
            } else {
                if let e = error as? QueueError { onFailure(e) }
                if order == nil || !WorkOrderRules.isNetwork(error) {
                    notice = WorkOrderRules.isNetwork(error) ? "Sem conexão com o Vinki e esta ficha ainda não foi aberta neste aparelho. Conecte-se e tente de novo." : WorkOrderRules.message(error)
                }
            }
        }
        loading = false
    }

    /// O modelo da ordem: do catálogo (carregado uma vez) ou da rota do modelo. Sem nenhum, nada é marcado.
    private func resolveType(_ order: WorkOrder) async {
        guard let typeId = order.typeId else { type = nil; return }
        if catalog == nil {
            if let c = try? await client.types() { catalog = c; cache?.saveCatalog(c) }
            else { catalog = cache?.catalog()?.catalog }
        }
        if let t = catalog?.type(typeId) { type = t; return }
        if let t = try? await client.type(typeId) { type = t }
    }

    func loadMoreHistory() async {
        guard let cursor = historyCursor, !readOnly else { return }
        guard let page = try? await client.history(id, cursor: cursor) else { return }
        let known = Set(history.map(\.id))
        history += (page.data ?? []).filter { !known.contains($0.id) }
        historyCursor = page.nextCursor
    }

    // MARK: Ações

    func changeStage(_ next: WorkNextStage, note: String?) {
        let text = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = text?.isEmpty == false ? text : nil
        if WorkOrderRules.needsReason(from: order?.state ?? "", to: next.baseStatus ?? ""), note == nil {
            notice = WorkOrderRules.emptyReason
            return
        }
        let label = next.stageLabel ?? ServiceOrderRules.statusLabel(next.baseStatus ?? "")
        let success = next.isApproval ? "Pedido de aprovação enviado ao cliente" : "Etapa: \(label)"
        run("stage:\(next.transitionId)", success: success, handle: { [weak self] error in
            guard let self, error.code == "missing_fields" else { return false }
            await self.askRequirements(next, note: note)
            return true
        }) { [client, id] key, version in
            if next.isApproval { return try await client.requestApproval(id, transitionId: next.transitionId, version: version, key: key) }
            return try await client.changeStage(id, transitionId: next.transitionId, version: version, note: note, key: key)
        }
    }

    private func askRequirements(_ next: WorkNextStage, note: String?) async {
        do {
            let req = try await client.requirements(id, transitionId: next.transitionId)
            let missing = Set((req.missing ?? []).map(\.fieldId))
            let fields = WorkFields.visible(order?.fields).filter { missing.contains($0.id) }
            if fields.isEmpty && req.internalMissing != true {
                notice = "Faltam dados para mudar de etapa. Confira os campos desta ordem e tente de novo."
                return
            }
            requirements = WorkRequirementsRequest(next: next, note: note, fields: fields, internalMissing: req.internalMissing == true)
        } catch {
            notice = WorkOrderRules.message(error)
        }
    }

    /// "Salvar e tentar de novo": grava os campos que faltam (com os demais valores atuais) e repete a mudança de etapa.
    func saveRequirements(_ request: WorkRequirementsRequest, draft: [String: String]) -> String? {
        let required = Set(request.fields.map(\.id))
        let parsed: [String: WorkValue]
        switch WorkFields.parse(request.fields, draft: draft, required: required) {
        case .failure(let e): return e.message
        case .success(let v): parsed = v
        }
        let extra = WorkFields.merged(current: order?.extra, fields: order?.fields, edited: parsed)
        requirements = nil
        let next = request.next, note = request.note
        let label = next.stageLabel ?? ServiceOrderRules.statusLabel(next.baseStatus ?? "")
        run("requirements:\(next.transitionId)", success: next.isApproval ? "Pedido de aprovação enviado ao cliente" : "Etapa: \(label)") { [client, id, keys] key, version in
            let saved = try await client.updateExtra(id, version: version, extra: extra, key: key)
            keys.settle(nil)
            let again = keys.key(for: "stage:\(next.transitionId):\(saved.version ?? 0)")
            if next.isApproval { return try await client.requestApproval(id, transitionId: next.transitionId, version: saved.version ?? 0, key: again) }
            return try await client.changeStage(id, transitionId: next.transitionId, version: saved.version ?? 0, note: note, key: again)
        }
        return nil
    }

    /// "Editar campos": valida como o painel e grava `extra` completo.
    func saveFields(draft: [String: String]) -> String? {
        guard let order else { return nil }
        let required = WorkFields.requiredNow(type, stage: order.stage, fields: order.fields)
        let parsed: [String: WorkValue]
        switch WorkFields.parse(order.fields, draft: draft, required: required) {
        case .failure(let e): return e.message
        case .success(let v): parsed = v
        }
        let extra = WorkFields.merged(current: order.extra, fields: order.fields, edited: parsed)
        run("fields", success: "Campos salvos") { [client, id] key, version in
            try await client.updateExtra(id, version: version, extra: extra, key: key)
        }
        return nil
    }

    func toggle(_ item: WorkChecklistItem) {
        let done = !(item.done ?? false)
        run("checklist:\(item.id):\(done)", success: done ? "Item marcado" : "Item desmarcado") { [client, id] key, version in
            try await client.markChecklist(id, version: version, itemId: item.id, done: done, key: key)
        }
    }

    func markWithPhoto(_ item: WorkChecklistItem, image: UIImage) {
        guard let jpeg = WorkPhoto.jpeg(image) else {
            notice = "Não deu para preparar a foto. Tire de novo, com o item bem enquadrado."
            return
        }
        markWithPhoto(item, jpeg: jpeg)
    }

    func markWithPhoto(_ item: WorkChecklistItem, jpeg: Data) {
        run("photo:\(item.id)", success: "Foto enviada e item marcado") { [client, id, weak self] _, _ in
            try await client.markWithPhoto(id, itemId: item.id, jpeg: jpeg) { text in
                Task { @MainActor in self?.progress = text }
            }
        }
    }

    func sendQuote() {
        run("quote/send", success: "Orçamento enviado ao cliente pelo WhatsApp") { [client, id] key, _ in
            try await client.sendQuote(id, key: key)
        }
    }

    func photo(_ documentId: String) async -> Data? {
        do { return try await client.documentContent(orderId: id, documentId: documentId) }
        catch {
            notice = WorkOrderRules.isNetwork(error) ? "Sem conexão: a foto não pode ser aberta agora." : WorkOrderRules.message(error)
            return nil
        }
    }

    /// Uma mudança: sem conexão nada sai; `version_conflict` recarrega; `handle` trata recusas próprias da ação.
    private func run(_ action: String, success: String, handle: ((QueueError) async -> Bool)? = nil,
                     _ block: @escaping (_ key: String, _ version: Int) async throws -> WorkOrder) {
        guard busy == nil else { return }
        guard !readOnly else { notice = WorkOrderRules.offlineAction; return }
        guard let version = order?.version else { return }
        let key = keys.key(for: "\(action):\(id):\(version)")
        busy = action
        notice = nil
        done = nil
        Task {
            do {
                let updated = try await block(key, version)
                keys.settle(nil)
                order = updated
                done = success
                progress = nil
                await load()
            } catch {
                keys.settle(error)
                progress = nil
                let e = error as? QueueError
                if let e { onFailure(e) }
                if let e, let handle, await handle(e) {
                    // tratado pela própria ação
                } else if e?.code == "version_conflict" {
                    notice = WorkOrderRules.versionConflict
                    await load()
                } else {
                    notice = WorkOrderRules.message(error)
                    if !WorkOrderRules.isNetwork(error), e?.retryable != true { await load() }
                }
            }
            busy = nil
        }
    }

    var pendingKey: String? { keys.pendingKey }
}

// MARK: - Abertura

/// Abrir uma ordem por modelo: modelo, cliente do cadastro (ou o da conversa), objeto do serviço quando o modelo pede,
/// campos do modelo, item, descrição e observação interna.
@MainActor
final class NewWorkOrderViewModel: ObservableObject {
    @Published private(set) var mode: WorkEntryMode = .loading
    @Published private(set) var catalog: WorkTypeCatalog?
    @Published private(set) var typeId: String?
    /// O usuário escolheu a ordem antiga: a tela mostra a abertura antiga.
    @Published private(set) var legacyChosen = false

    let conversationId: String?
    let customerLabel: String?
    @Published var contactQuery = ""
    @Published private(set) var contacts: [WorkContact] = []
    @Published private(set) var searching = false
    @Published private(set) var searched = false
    @Published private(set) var contact: WorkContact?

    @Published private(set) var objectType: ServiceObjectType?
    @Published private(set) var objects: [ServiceObjectView] = []
    @Published private(set) var loadingObjects = false
    @Published var objectId: String?
    @Published var newObject = false
    @Published var objectDraft: [String: String] = [:]

    @Published var fieldDraft: [String: String] = [:]
    @Published var item = ""
    @Published var problem = ""
    @Published var notes = ""
    @Published private(set) var busy = false
    @Published var notice: String?
    @Published private(set) var created: WorkOrder?

    private let client: WorkOrderClient
    private let onFailure: (QueueError) -> Void
    private let conversationContact: (String) async -> WorkContact?
    private let keys = IntentKeys()
    private var objectTypes: [ServiceObjectType]?
    private var searchTask: Task<Void, Never>?

    init(conversationId: String?, customer: String?, client: WorkOrderClient, onFailure: @escaping (QueueError) -> Void,
         conversationContact: @escaping (String) async -> WorkContact? = { _ in nil }) {
        self.conversationId = conversationId
        self.customerLabel = customer
        self.client = client
        self.onFailure = onFailure
        self.conversationContact = conversationContact
    }

    convenience init(conversationId: String?, customer: String?) {
        self.init(conversationId: conversationId, customer: customer, client: WorkOrderClient(api: .current()),
                  onFailure: ModuleFailure.handler(ModuleId.serviceOrders), conversationContact: Self.contactOfConversation)
    }

    /// O contato da conversa (para o objeto do serviço, que é do cadastro do cliente).
    static func contactOfConversation(_ conversationId: String) async -> WorkContact? {
        let container = AppContainer.shared
        guard let profile = container.profileId, container.session.serverURL != nil,
              let detail = try? await container.api.conversation(profile, id: conversationId) else { return nil }
        let c = detail.conversation
        guard let contactId = c.contact_id, !contactId.isEmpty else { return nil }
        return WorkContact(id: contactId, name: c.contact_name, phone: c.phone)
    }

    var type: WorkTypeView? { catalog?.type(typeId) }
    var types: [WorkTypeView] { catalog?.active ?? [] }
    var fields: [WorkField] { WorkFields.visible(type?.fields) }
    var requiredFields: Set<String> { type.map(WorkFields.requiredAtOpening) ?? [] }
    var needsObject: Bool { type?.objectTypeId?.isEmpty == false }
    var objectFields: [WorkField] { WorkFields.visible(objectType?.fields) }

    func start() async {
        guard catalog == nil else { return }
        do {
            let c = try await client.types()
            catalog = c
            if c.activeCustom.isEmpty { mode = .legacy; return }
            if c.activeCustom.count == 1 { choose(c.activeCustom[0].id) }
            mode = .ready
        } catch {
            if WorkOrderRules.isOldServer(error) { mode = .legacy; return }
            if let e = error as? QueueError { onFailure(e) }
            mode = .failed(WorkOrderRules.message(error))
        }
        if let conversationId, contact == nil {
            if let found = await conversationContact(conversationId) { contact = found; await loadObjects() }
        }
    }

    func choose(_ id: String) {
        guard let t = catalog?.type(id) else { return }
        if t.isBuiltin { legacyChosen = true; return }
        guard typeId != id else { return }
        typeId = id
        fieldDraft = [:]
        objectId = nil
        newObject = false
        objectDraft = [:]
        objects = []
        objectType = nil
        notice = nil
        Task { await loadObjects() }
    }

    func searchContacts(_ text: String) {
        contactQuery = text
        searchTask?.cancel()
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { contacts = []; searched = false; return }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            searching = true
            do {
                let found = try await client.contacts(q)
                guard !Task.isCancelled else { return }
                contacts = found
                searched = true
            } catch {
                if let e = error as? QueueError { onFailure(e) }
                notice = WorkOrderRules.isNetwork(error) ? "Sem conexão: a busca de clientes não funciona agora." : WorkOrderRules.message(error)
            }
            searching = false
        }
    }

    /// Trocar de cliente limpa o objeto escolhido.
    func pick(_ contact: WorkContact?) {
        self.contact = contact
        objectId = nil
        newObject = false
        objectDraft = [:]
        objects = []
        if contact != nil { contacts = []; contactQuery = ""; searched = false }
        Task { await loadObjects() }
    }

    func loadObjects() async {
        guard let type, let objectTypeId = type.objectTypeId, !objectTypeId.isEmpty else { objectType = nil; return }
        loadingObjects = true
        defer { loadingObjects = false }
        do {
            if objectTypes == nil { objectTypes = try await client.objectTypes() }
            objectType = objectTypes?.first { $0.id == objectTypeId }
            if let contactId = contact?.id {
                objects = (try await client.objects(contactId: contactId, typeId: objectTypeId).data ?? []).filter { $0.archived != true }
                if objects.isEmpty { newObject = true }
            } else {
                objects = []
            }
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            notice = WorkOrderRules.message(error)
        }
    }

    /// Valida tudo antes de enviar; `nil` com a mensagem do primeiro problema.
    func validate() -> Result<WorkOrderDraft, WorkFieldError> {
        guard let type else { return .failure(.init(fieldId: "type", message: "Escolha o modelo da ordem.")) }
        if conversationId == nil, contact == nil { return .failure(.init(fieldId: "customer", message: "Escolha o cliente. Busque pelo nome ou telefone.")) }
        var object: WorkObjectChoice?
        if needsObject {
            guard let contactId = contact?.id, !contactId.isEmpty else {
                return .failure(.init(fieldId: "customer", message: "Confirme o cadastro do cliente antes de escolher o objeto."))
            }
            _ = contactId
            let title = objectType?.singular ?? "objeto"
            if newObject {
                switch WorkFields.parse(objectType?.fields, draft: objectDraft) {
                case .failure(let e): return .failure(e)
                case .success(let values): object = .new(typeId: type.objectTypeId!, values: values)
                }
            } else if let id = objectId, let chosen = objects.first(where: { $0.id == id }) {
                object = .existing(id: chosen.id, version: chosen.version ?? 0)
            } else {
                return .failure(.init(fieldId: "object", message: "Escolha o \(title.lowercased()) ou cadastre outro."))
            }
        }
        let extra: [String: WorkValue]
        switch WorkFields.parse(type.fields, draft: fieldDraft, required: requiredFields) {
        case .failure(let e): return .failure(e)
        case .success(let values): extra = values
        }
        let item = self.item.trimmingCharacters(in: .whitespacesAndNewlines)
        let problem = self.problem.trimmingCharacters(in: .whitespacesAndNewlines)
        if item.isEmpty { return .failure(.init(fieldId: "item", message: "\(type.itemLabel): preenchimento obrigatório.")) }
        if item.count > 200 { return .failure(.init(fieldId: "item", message: "\(type.itemLabel): até 200 caracteres.")) }
        if problem.isEmpty { return .failure(.init(fieldId: "problem", message: "\(type.problemLabel): preenchimento obrigatório.")) }
        if problem.count > 2000 { return .failure(.init(fieldId: "problem", message: "\(type.problemLabel): até 2000 caracteres.")) }
        let notes = self.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        return .success(WorkOrderDraft(
            typeId: type.id, item: item, problem: problem, extra: extra, notes: notes.isEmpty ? nil : notes,
            contactId: object == nil ? nil : contact?.id, object: object,
            customerName: contact?.name ?? customerLabel, phone: conversationId == nil ? contact?.phone : nil,
            conversationId: conversationId))
    }

    func submit() async {
        guard !busy else { return }
        let draft: WorkOrderDraft
        switch validate() {
        case .failure(let e): notice = e.message; return
        case .success(let d): draft = d
        }
        busy = true
        notice = nil
        let key = keys.key(for: "open:\(draft.typeId):\(draft.contactId ?? draft.phone ?? draft.conversationId ?? ""):\(draft.item):\(draft.problem)")
        do {
            created = try await client.create(draft, key: key)
            keys.settle(nil)
        } catch {
            keys.settle(error)
            let e = error as? QueueError
            if let e { onFailure(e) }
            notice = WorkOrderRules.message(error)
            if e?.code == "object_definition_conflict" || e?.code == "object_archived" {
                objectId = nil
                objectTypes = nil
                await loadObjects()
            }
        }
        busy = false
    }

    var pendingKey: String? { keys.pendingKey }
}
