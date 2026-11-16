import Foundation

/// Mensalidades: o mês (resumo e parcelas com filtro), as assinaturas e os inadimplentes.
@MainActor
final class MensalidadeViewModel: ObservableObject {
    enum Mode: String, CaseIterable, Identifiable {
        case month, subscriptions, delinquents
        var id: String { rawValue }
        var label: String {
            switch self {
            case .month: return "Mês"
            case .subscriptions: return "Assinaturas"
            case .delinquents: return "Inadimplentes"
            }
        }
    }

    @Published var mode: Mode = .month
    @Published private(set) var month: String
    @Published private(set) var summary: MensalidadeSummary?
    @Published private(set) var installments: [Installment] = []
    @Published private(set) var filter = "all"
    @Published private(set) var subscriptionFilter = "active"
    @Published var query = ""
    @Published private(set) var subscriptions: [Subscription] = []
    @Published private(set) var delinquents: [Delinquent] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?

    private let client: MensalidadeClient
    private let onFailure: (QueueError) -> Void
    private var events: ModuleEvents?
    private var generation = 0
    private var searchTask: Task<Void, Never>?

    init(client: MensalidadeClient, month: String = MensalidadeRules.currentMonth(), onFailure: @escaping (QueueError) -> Void) {
        self.client = client
        self.month = month
        self.onFailure = onFailure
    }

    convenience init() {
        self.init(client: MensalidadeClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.mensalidade))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "mensalidade.") { [weak self] in await self?.load() }
    }

    func load() async {
        generation += 1
        let mine = generation
        loading = summary == nil && installments.isEmpty && subscriptions.isEmpty && delinquents.isEmpty
        do {
            switch mode {
            case .month:
                let month = self.month, query = self.query, client = self.client
                let statuses = MensalidadeRules.filters.first { $0.id == filter }?.statuses ?? []
                async let s = client.summary(month: month)
                async let page = client.installments(month: month, statuses: statuses, query: query)
                let (found, list) = try await (s, page)
                guard mine == generation else { return }
                summary = found
                installments = list.data ?? []
            case .subscriptions:
                let statuses = subscriptionFilter == "all" ? [] : [subscriptionFilter]
                let page = try await client.subscriptions(statuses: statuses, query: query)
                guard mine == generation else { return }
                subscriptions = page.data ?? []
            case .delinquents:
                let list = try await client.delinquents()
                guard mine == generation else { return }
                delinquents = list
            }
            error = nil
        } catch {
            guard mine == generation else { return }
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
        loading = false
    }

    /// Pagador de cada assinatura (inadimplentes): `GET /delinquents` não traz o pagador, então a linha o busca pela
    /// assinatura quando aparece na tela, uma vez. `nil` guardado: sem pagador (servidor antigo).
    @Published private(set) var payers: [String: Payer?] = [:]
    private var payerLoading: Set<String> = []

    func loadPayer(subscriptionId: String) async {
        guard payers[subscriptionId] == nil, !payerLoading.contains(subscriptionId) else { return }
        payerLoading.insert(subscriptionId)
        defer { payerLoading.remove(subscriptionId) }
        guard let ref = try? await client.subscription(subscriptionId).payer, let id = ref.id else {
            payers[subscriptionId] = .some(nil)
            return
        }
        let full = try? await client.payer(id)
        payers[subscriptionId] = .some(full ?? Payer(id: id, name: ref.name, documentDisplay: ref.documentDisplay))
    }

    func setMode(_ mode: Mode) { guard self.mode != mode else { return }; self.mode = mode; Task { await load() } }
    func shiftMonth(_ n: Int) { month = MensalidadeRules.shiftMonth(month, n); Task { await load() } }
    func setFilter(_ id: String) { guard filter != id else { return }; filter = id; installments = []; Task { await load() } }
    func setSubscriptionFilter(_ id: String) { guard subscriptionFilter != id else { return }; subscriptionFilter = id; subscriptions = []; Task { await load() } }

    func search(_ text: String) {
        query = text
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await load()
        }
    }
}

/// Uma parcela: reenviar a cobrança, dar baixa e isentar.
@MainActor
final class InstallmentViewModel: ObservableObject {
    @Published private(set) var installment: Installment?
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var done: String?

    let id: String
    private let client: MensalidadeClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()

    init(id: String, client: MensalidadeClient, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: MensalidadeClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.mensalidade))
    }

    func load() async {
        do { installment = try await client.installment(id) } catch {
            if let e = error as? QueueError { onFailure(e) }
            if installment == nil { notice = ModuleFailure.message(error) }
        }
    }

    func charge() { run("charge", "Cobrança enviada ao cliente") { [client, id] in try await client.charge(id, key: $0) } }

    func pay(note: String, paidAt: Date, notify: Bool) {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines), day = BrasiliaTime.day(paidAt)
        run("pay", "Baixa registrada") { [client, id] in try await client.pay(id, note: text.isEmpty ? nil : text, paidAt: day, notify: notify, key: $0) }
    }

    func waive(note: String) {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        run("waive", "Parcela isenta") { [client, id] in try await client.waive(id, note: text.isEmpty ? nil : text, key: $0) }
    }

    private func run(_ action: String, _ success: String, _ block: @escaping (String) async throws -> Installment) {
        guard busy == nil else { return }
        let key = keys.key(for: "\(action):\(id)")
        busy = action
        notice = nil
        Task {
            do {
                installment = try await block(key)
                keys.settle(nil)
                done = success
            } catch {
                keys.settle(error)
                if let e = error as? QueueError { onFailure(e) }
                let retry = (error as? QueueError)?.retryable == true
                notice = MensalidadeRules.explain(error) + (retry ? " Toque de novo para repetir com segurança." : "")
                if !retry { await load() }
            }
            busy = nil
        }
    }

    var pendingKey: String? { keys.pendingKey }
}

/// Uma assinatura: as parcelas dela, pausar, retomar e encerrar.
@MainActor
final class SubscriptionViewModel: ObservableObject {
    @Published private(set) var subscription: Subscription?
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var done: String?

    let id: String
    private let client: MensalidadeClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()

    init(id: String, client: MensalidadeClient, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: MensalidadeClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.mensalidade))
    }

    /// O pagador com os telefones autorizados (`GET /payers/{id}`); sem a rota, fica o nome e o documento da assinatura.
    @Published private(set) var payer: Payer?

    func load() async {
        do { subscription = try await client.subscription(id) } catch {
            if let e = error as? QueueError { onFailure(e) }
            if subscription == nil { notice = ModuleFailure.message(error) }
        }
        if let ref = subscription?.payer, let payerId = ref.id {
            payer = (try? await client.payer(payerId)) ?? Payer(id: payerId, name: ref.name, documentDisplay: ref.documentDisplay)
        }
    }

    func perform(_ action: String) {
        guard busy == nil else { return }
        let key = keys.key(for: "\(action):\(id)")
        busy = action
        notice = nil
        Task {
            do {
                _ = try await client.subscriptionAction(id, action, key: key)
                keys.settle(nil)
                await load()
                done = action == "pause" ? "Assinatura pausada" : (action == "resume" ? "Assinatura retomada" : "Assinatura encerrada")
            } catch {
                keys.settle(error)
                if let e = error as? QueueError { onFailure(e) }
                let retry = (error as? QueueError)?.retryable == true
                notice = ModuleFailure.message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
                if !retry { await load() }
            }
            busy = nil
        }
    }
}
