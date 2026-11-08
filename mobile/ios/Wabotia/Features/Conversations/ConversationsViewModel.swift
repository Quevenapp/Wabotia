import Foundation
import Combine

/// Lista de conversas: filtros, busca, paginação por cursor, ligações tocando e atualização por eventos.
@MainActor
final class ConversationsViewModel: ObservableObject {
    enum Filter: String, CaseIterable, Identifiable {
        case queue, mine, ai, closed, all
        var id: String { rawValue }
        var title: String {
            switch self {
            case .queue: return "Fila"
            case .mine: return "Minhas"
            case .ai: return "IA"
            case .closed: return "Concluídas"
            case .all: return "Todas"
            }
        }
        var state: String? {
            switch self {
            case .queue: return "waiting"
            case .mine: return "human"
            case .ai: return "ai"
            case .closed: return "closed"
            case .all: return nil
            }
        }
    }

    @Published var filter: Filter = .queue { didSet { if oldValue != filter { load(reset: true) } } }
    @Published var query = ""
    @Published private(set) var items: [Conversation] = []
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasMore = false
    @Published var error: String?
    @Published private(set) var ringing: [Call] = []
    @Published var callError: String?

    private var container: AppContainer { AppContainer.shared }
    private var nextCursor: String?
    private var loadTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var poller: EventsPoller?
    private var loadedOnce = false
    /// Chaves de idempotência (claim, reject) por ligação recusada, reutilizadas ao repetir após falha de rede.
    private var declineKeys: [String: (claim: String, reject: String)] = [:]

    init() {}

    var profileId: String? { container.profileId }
    var meId: String? { container.user?.id }

    // MARK: Carga

    func loadIfNeeded() {
        guard !loadedOnce else { return }
        loadedOnce = true
        load(reset: true)
        Task { await loadRinging() }
    }

    /// Chamado em cada .onAppear. Na primeira vez carrega com indicador; ao voltar (de uma conversa, por
    /// exemplo) recarrega em silêncio, porque o poller da conversa aberta avançou o cursor de eventos
    /// compartilhado do perfil enquanto esta lista estava parada, e os `conversation.updated` daquele
    /// intervalo nunca chegariam aqui.
    func appear() {
        guard loadedOnce else { loadIfNeeded(); return }
        load(reset: true, silent: true)
        Task { await loadRinging() }
    }

    /// Recarrega a primeira página. `silent` evita o indicador de carga (atualização por eventos).
    func load(reset: Bool, silent: Bool = false) {
        loadTask?.cancel()
        loadTask = Task { await fetch(reset: reset, silent: silent) }
    }

    func refresh() async {
        loadTask?.cancel()
        let task = Task { await fetch(reset: true, silent: true) }
        loadTask = task
        await task.value
        await loadRinging()
    }

    func loadMoreIfNeeded(current item: Conversation) {
        guard hasMore, !loadingMore, !loading, let last = items.last, last.id == item.id else { return }
        loadingMore = true
        loadTask = Task { await fetch(reset: false, silent: true) }
    }

    private func fetch(reset: Bool, silent: Bool) async {
        guard let p = profileId else { return }
        if reset {
            nextCursor = nil
            if !silent { loading = true }
        }
        error = nil
        let state = filter.state
        let q = query.trimmingCharacters(in: .whitespaces)
        let cursor = reset ? nil : nextCursor
        var collected: [Conversation] = reset ? [] : items
        var cursorToUse = cursor
        var rounds = 0
        do {
            repeat {
                rounds += 1
                let page = try await container.api.conversations(p, state: state, q: q.isEmpty ? nil : q, cursor: cursorToUse, limit: 50)
                if Task.isCancelled { return }
                let filtered = filter == .mine ? page.data.filter { $0.owner == meId } : page.data
                for c in filtered where !collected.contains(where: { $0.id == c.id }) { collected.append(c) }
                cursorToUse = page.next_cursor
                // "Minhas" pode voltar páginas vazias após o filtro local; avança algumas páginas de uma vez.
                if filter != .mine || !filtered.isEmpty || cursorToUse == nil { break }
            } while rounds < 4
            items = collected
            nextCursor = cursorToUse
            hasMore = cursorToUse != nil
        } catch {
            if Task.isCancelled { return }
            handle(error)
        }
        loading = false
        loadingMore = false
    }

    func queryChanged() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, let self else { return }
            self.load(reset: true)
        }
    }

    // MARK: Ligações tocando

    func loadRinging() async {
        guard let p = profileId else { return }
        do {
            let page = try await container.api.calls(p, limit: 30)
            let me = meId
            ringing = page.data.filter { $0.status == "ringing" && ($0.actor == nil || $0.actor?.isEmpty == true || $0.actor == me) }
        } catch {
            if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized() }
            // Sem permissão de ligações ou canal sem chamadas: a faixa simplesmente não aparece.
        }
    }

    /// Recusar = claim + reject com as MESMAS chaves ao repetir (como CallsViewModel.decline); as chaves só
    /// são descartadas após sucesso ou resposta definitiva do servidor (não rede, não conflito de idempotência).
    func reject(call: Call) async {
        guard let p = profileId else { return }
        callError = nil
        let keys = declineKeys[call.id] ?? (claim: APIClient.newIdempotencyKey(), reject: APIClient.newIdempotencyKey())
        declineKeys[call.id] = keys
        do {
            _ = try await container.api.claimCall(p, id: call.id, key: keys.claim)
            _ = try await container.api.rejectCall(p, id: call.id, key: keys.reject)
            declineKeys[call.id] = nil
            ringing.removeAll { $0.id == call.id }
        } catch {
            if let apiError = error as? APIError, apiError.status != 0, !apiError.isIdempotencyConflict {
                declineKeys[call.id] = nil // resposta definitiva do servidor: a próxima tentativa é outro pedido
            }
            handle(error, into: \.callError)
        }
        await loadRinging()
    }

    // MARK: Eventos

    func startPolling() {
        guard let p = profileId else { return }
        if let poller, poller.isRunning { return }
        poller = EventsPoller(container: container, profileId: p) { [weak self] events in
            self?.handle(events: events)
        }
        poller?.start()
    }

    func stopPolling() {
        poller?.stop()
        poller = nil
    }

    private func handle(events: [Event]) {
        if events.contains(where: { $0.isConversationRelated }) { load(reset: true, silent: true) }
        if events.contains(where: { $0.isCallRelated }) { Task { await loadRinging() } }
    }

    // MARK: Erros

    private func handle(_ error: Error, into keyPath: ReferenceWritableKeyPath<ConversationsViewModel, String?> = \.error) {
        if let e = error as? APIError, e.isUnauthorized {
            container.handleUnauthorized()
            return
        }
        self[keyPath: keyPath] = APIError.describe(error)
    }
}
