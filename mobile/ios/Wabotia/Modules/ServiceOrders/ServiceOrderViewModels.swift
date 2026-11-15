import Foundation

/// Lista de ordens com filtro por estado (o padrão: abertas) e busca por item, cliente, problema, número ou telefone.
@MainActor
final class ServiceOrdersViewModel: ObservableObject {
    @Published private(set) var filter = "open"
    @Published var query = ""
    @Published private(set) var orders: [ServiceOrder] = []
    @Published private(set) var page: ServiceOrderPage?
    @Published private(set) var loading = true
    @Published private(set) var loadingMore = false
    @Published private(set) var error: String?

    private let client: ServiceOrderClient
    private let onFailure: (QueueError) -> Void
    private var events: ModuleEvents?
    private var generation = 0
    private var searchTask: Task<Void, Never>?

    init(client: ServiceOrderClient, onFailure: @escaping (QueueError) -> Void) {
        self.client = client
        self.onFailure = onFailure
    }

    convenience init() {
        self.init(client: ServiceOrderClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.serviceOrders))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "os.") { [weak self] in await self?.load() }
    }

    func count(_ filter: String) -> Int? {
        guard let page else { return nil }
        switch filter {
        case "all": return nil
        case "open": return ServiceOrderRules.statuses.filter { !ServiceOrderRules.closed.contains($0) }.reduce(0) { $0 + page.count($1) }
        default: return page.count(filter)
        }
    }

    func setFilter(_ filter: String) {
        guard self.filter != filter else { return }
        self.filter = filter
        orders = []
        Task { await load() }
    }

    /// Busca com uma pausa curta, para não consultar a cada letra.
    func search(_ text: String) {
        query = text
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    func load() async {
        generation += 1
        let mine = generation
        if orders.isEmpty { loading = true }
        do {
            let result = try await fetch(cursor: nil)
            guard mine == generation else { return }
            page = result
            orders = result.data ?? []
            error = nil
        } catch {
            guard mine == generation else { return }
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
        loading = false
    }

    func loadMore() async {
        guard !loadingMore, let cursor = page?.nextCursor else { return }
        loadingMore = true
        let mine = generation
        if let more = try? await fetch(cursor: cursor), mine == generation {
            page?.nextCursor = more.nextCursor
            let known = Set(orders.map(\.id))
            orders += (more.data ?? []).filter { !known.contains($0.id) }
        }
        loadingMore = false
    }

    private func fetch(cursor: String?) async throws -> ServiceOrderPage {
        let statuses = filter == "open" || filter == "all" ? [] : [filter]
        return try await client.list(statuses: statuses, open: filter == "open", query: query, cursor: cursor)
    }
}

/// Detalhe da ordem: mudar estado, montar e enviar orçamento, resposta do cliente no balcão, entrega e comprovante.
@MainActor
final class ServiceOrderViewModel: ObservableObject {
    @Published private(set) var order: ServiceOrder?
    @Published private(set) var loading = false
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var done: String?

    let id: String
    private let client: ServiceOrderClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var events: ModuleEvents?

    init(id: String, client: ServiceOrderClient, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: ServiceOrderClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.serviceOrders))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "os.") { [weak self] in await self?.load() }
    }

    /// Pessoas da área, para o responsável (lidas uma vez; servidor antigo sem `GET /people` deixa a lista vazia).
    @Published private(set) var people: [AreaPerson] = []
    private var establishmentCache: Establishment?

    func loadPeople() async {
        guard people.isEmpty, let list = try? await client.api.people() else { return }
        people = list
    }

    /// Nome do responsável da ordem pela lista de pessoas (o `id` quando a pessoa saiu da área).
    var assigneeName: String? {
        guard let id = order?.assignee, !id.isEmpty else { return nil }
        return people.first { $0.id == id }?.displayName ?? id
    }

    func assign(_ personId: String?) {
        run("assign:\(personId ?? "-")", success: personId == nil ? "Responsável retirado" : "Responsável alterado") { [client, id] key in
            try await client.assign(id, assignee: personId, key: key)
        }
    }

    /// O cabeçalho do comprovante: o estabelecimento da área (`nil` em servidor antigo, e o comprovante usa o nome).
    func establishment() async -> Establishment? {
        if let establishmentCache { return establishmentCache }
        establishmentCache = try? await client.api.establishment()
        return establishmentCache
    }

    func load() async {
        if order == nil { loading = true }
        do {
            order = try await client.order(id)
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            if order == nil { notice = ModuleFailure.message(error) }
        }
        loading = false
    }

    /// Um dos `next_statuses`: `quoted` envia o orçamento, `approved`/`declined` registram a resposta do cliente.
    func perform(_ status: String, note: String? = nil, notify: Bool = true) {
        let text = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = text?.isEmpty == false ? text : nil
        switch status {
        case "quoted":
            run("quote/send", success: notify ? "Orçamento enviado ao cliente" : "Envio do orçamento registrado") { [client, id] key in try await client.sendQuote(id, notify: notify, key: key) }
        case "approved", "declined":
            let approve = status == "approved"
            run("decision:\(status)", success: approve ? "Aprovação registrada" : "Recusa registrada") { [client, id] key in try await client.decide(id, approve: approve, key: key) }
        default:
            let success = status == "delivered" ? "Entrega registrada" : "Ordem: \(ServiceOrderRules.statusLabel(status))"
            run("status:\(status)", success: success) { [client, id] key in try await client.setStatus(id, status: status, note: note, key: key) }
        }
    }

    func saveQuote(items: [QuoteItem], validDays: Int?, note: String, thenSend: Bool) {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let signature = "quote:" + items.map(\.id).joined(separator: "|") + ":\(validDays ?? 0):\(trimmed)"
        run(signature, success: thenSend ? "Orçamento enviado ao cliente" : "Orçamento salvo") { [client, id, keys] key in
            let saved = try await client.saveQuote(id, items: items, validDays: validDays, note: trimmed.isEmpty ? nil : trimmed, key: key)
            guard thenSend else { return saved }
            keys.settle(nil)
            return try await client.sendQuote(id, notify: true, key: keys.key(for: "quote/send:\(saved.quote?.version ?? 0)"))
        }
    }

    private func run(_ action: String, success: String, _ block: @escaping (String) async throws -> ServiceOrder) {
        guard busy == nil else { return }
        let key = keys.key(for: "\(action):\(id)")
        busy = action
        notice = nil
        Task {
            do {
                let updated = try await block(key)
                keys.settle(nil)
                order = updated.history == nil ? order.map { merge(updated, history: $0.history) } ?? updated : updated
                done = success
                await load()
            } catch {
                keys.settle(error)
                if let e = error as? QueueError { onFailure(e) }
                let retry = (error as? QueueError)?.retryable == true
                notice = message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
                if !retry { await load() }
            }
            busy = nil
        }
    }

    private func merge(_ order: ServiceOrder, history: [ServiceOrderHistory]?) -> ServiceOrder {
        var copy = order
        copy.history = history
        return copy
    }

    private func message(_ error: Error) -> String {
        switch (error as? QueueError)?.code {
        case "quote_expired": return "O orçamento venceu e não pode mais ser aprovado. Envie de novo."
        case "no_conversation": return "Esta ordem não está ligada a uma conversa: registre o envio sem avisar pelo WhatsApp."
        case "invalid_transition": return "Esta mudança não vale para a ordem agora. A tela foi atualizada."
        default: return ModuleFailure.message(error)
        }
    }

    var pendingKey: String? { keys.pendingKey }
}

/// Abrir ordem: pela conversa (o cliente é avisado no WhatsApp) ou no balcão, com o telefone.
@MainActor
final class NewServiceOrderViewModel: ObservableObject {
    let conversationId: String?
    let customerLabel: String?
    @Published var item = ""
    @Published var problem = ""
    @Published var phone = ""
    @Published var customerName = ""
    @Published var notes = ""
    @Published var hasDue = false
    @Published var due = Date().addingTimeInterval(3 * 86_400)
    /// Responsável (`id` de `GET /people`); `nil`: sem responsável.
    @Published var assignee: String?
    @Published private(set) var people: [AreaPerson] = []

    func loadPeople() async {
        guard people.isEmpty, let list = try? await client.api.people() else { return }
        people = list
    }
    @Published private(set) var busy = false
    @Published var notice: String?
    @Published private(set) var result: ServiceOrder?

    private let client: ServiceOrderClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()

    init(conversationId: String?, customer: String?, client: ServiceOrderClient, onFailure: @escaping (QueueError) -> Void) {
        self.conversationId = conversationId
        self.customerLabel = customer
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(conversationId: String?, customer: String?) {
        self.init(conversationId: conversationId, customer: customer, client: ServiceOrderClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.serviceOrders))
    }

    var canSubmit: Bool {
        let filled = !item.trimmingCharacters(in: .whitespaces).isEmpty && !problem.trimmingCharacters(in: .whitespaces).isEmpty
        return filled && !busy && (conversationId != nil || phone.filter(\.isNumber).count >= 10)
    }

    func submit() async {
        guard canSubmit else { return }
        busy = true
        notice = nil
        let item = self.item.trimmingCharacters(in: .whitespacesAndNewlines), problem = self.problem.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = phone.filter(\.isNumber)
        let key = keys.key(for: "open:\(conversationId ?? digits):\(item):\(problem)")
        do {
            result = try await client.create(
                item: item, problem: problem, conversationId: conversationId, phone: conversationId == nil ? digits : nil,
                customerName: customerName.trimmingCharacters(in: .whitespaces).isEmpty ? nil : customerName.trimmingCharacters(in: .whitespaces),
                notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes.trimmingCharacters(in: .whitespacesAndNewlines),
                dueAt: hasDue ? BrasiliaTime.millis(due) : nil, assignee: assignee, key: key)
            keys.settle(nil)
        } catch {
            keys.settle(error)
            if let e = error as? QueueError { onFailure(e) }
            let retry = (error as? QueueError)?.retryable == true
            notice = ModuleFailure.message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
        }
        busy = false
    }

    var pendingKey: String? { keys.pendingKey }
}

/// O orçamento sendo montado: linhas editáveis com descrição, quantidade e valor digitado em reais.
struct QuoteDraft: Equatable {
    struct Line: Equatable, Identifiable {
        var id = UUID()
        var description = ""
        var quantity = 1
        var value = ""
    }

    var lines: [Line]
    var validDays: String
    var note: String

    init(order: ServiceOrder?, defaultDays: Int = 7) {
        let items = order?.quote?.items ?? []
        lines = items.isEmpty ? [Line()] : items.map { Line(description: $0.description, quantity: $0.quantity, value: Money.format($0.unitCents).replacingOccurrences(of: "R$ ", with: "")) }
        validDays = String(order?.quote?.validDays ?? defaultDays)
        note = order?.quote?.note ?? ""
    }

    /// Os itens válidos; `nil` com o problema da primeira linha errada.
    func items() -> Result<[QuoteItem], QuoteDraftError> {
        var out: [QuoteItem] = []
        for (index, line) in lines.enumerated() {
            let description = line.description.trimmingCharacters(in: .whitespacesAndNewlines)
            if description.isEmpty && line.value.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard !description.isEmpty else { return .failure(.init(message: "Descreva o item \(index + 1).")) }
            guard (1...999).contains(line.quantity) else { return .failure(.init(message: "Quantidade do item \(index + 1) de 1 a 999.")) }
            guard let cents = Money.parse(line.value) else { return .failure(.init(message: "Valor do item \(index + 1) inválido. Use, por exemplo, 45,90.")) }
            out.append(QuoteItem(description: description, quantity: line.quantity, unitCents: cents))
        }
        guard !out.isEmpty else { return .failure(.init(message: "Inclua pelo menos um item no orçamento.")) }
        return .success(out)
    }

    var days: Int? { Int(validDays.trimmingCharacters(in: .whitespaces)).flatMap { (1...90).contains($0) ? $0 : nil } }

    var total: Int { (try? items().get())?.reduce(0) { $0 + $1.totalCents } ?? 0 }
}

struct QuoteDraftError: Error, Equatable { let message: String }
