import Foundation
import Combine

/// Lista de conversas: filtros, busca, paginação por cursor, ações rápidas e atualização por eventos.
@MainActor
final class ConversationsViewModel: ObservableObject {
    enum Filter: String, CaseIterable, Identifiable {
        case all, queue, mine, ai, closed
        var id: String { rawValue }
        var title: String {
            switch self {
            case .all: return "Todas"
            case .queue: return "Fila"
            case .mine: return "Minhas"
            case .ai: return "Bots"
            case .closed: return "Concluídas"
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

    @Published var filter: Filter = .all { didSet { if oldValue != filter { load(reset: true) } } }
    @Published var query = ""
    @Published private(set) var items: [Conversation] = []
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var mineCount = 0
    @Published var error: String?
    /// Conversa com uma ação rápida em andamento (assumir/concluir).
    @Published private(set) var busyId: String?

    private var container: AppContainer { AppContainer.shared }
    private var workspace: Workspace { Workspace.shared }
    private var nextCursor: String?
    private var loadTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var eventsSubscription: AnyCancellable?
    private var loadedOnce = false
    private var visible = false
    private var stale = false
    /// Chave por ação rápida pendente (conversa + ação), mantida até o servidor responder.
    private var actionKeys: [String: String] = [:]

    init() {
        eventsSubscription = Workspace.shared.events.sink { [weak self] events in self?.handle(events: events) }
    }

    var profileId: String? { container.profileId }
    var meId: String? { container.user?.id }

    // MARK: Carga

    /// Chamado quando a aba aparece. Na primeira vez carrega com esqueleto; ao voltar (de uma conversa,
    /// por exemplo) recarrega em silêncio.
    func appear() {
        visible = true
        guard loadedOnce else {
            loadedOnce = true
            load(reset: true)
            return
        }
        load(reset: true, silent: true)
    }

    func disappear() { visible = false }

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
        await workspace.refreshNow()
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
        stale = false
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
            hasLoaded = true
            error = nil
            if q.isEmpty, filter == .all || filter == .mine {
                // "Minhas" é contado nas conversas carregadas; a carga por pessoa alimenta a aba Equipe.
                mineCount = collected.filter { $0.isOwned(by: meId) }.count
                if filter == .all {
                    var load: [String: Int] = [:]
                    for c in collected where c.state == "human" { if let owner = c.owner { load[owner, default: 0] += 1 } }
                    workspace.ownerLoad = load
                }
            }
            workspace.backfill(collected)
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

    // MARK: Ações rápidas (deslizar e toque longo)

    func canClaim(_ c: Conversation) -> Bool {
        if c.isOwned(by: meId) { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty { return false }
        return true
    }

    func claim(_ c: Conversation) async {
        if await act(c, "claim") {
            Haptics.success()
            workspace.addLocalEvent("claim", "Você assumiu a conversa", to: c.id)
            workspace.show("Conversa assumida", style: .success)
        }
    }

    func resolve(_ c: Conversation) async {
        if await act(c, "resolve") {
            workspace.addLocalEvent("resolve", "Você concluiu a conversa", to: c.id)
            workspace.show("Conversa concluída", style: .success)
        }
    }

    private func act(_ c: Conversation, _ action: String) async -> Bool {
        guard let p = profileId, busyId == nil else { return false }
        busyId = c.id
        defer { busyId = nil }
        let slot = "\(c.id):\(action)"
        let key = actionKeys[slot] ?? APIClient.newIdempotencyKey()
        actionKeys[slot] = key
        do {
            _ = try await container.api.act(p, conversation: c.id, ActionRequest(action: action), key: key)
            actionKeys[slot] = nil
            await fetchQuietly()
            workspace.refreshCounts()
            return true
        } catch {
            if let e = error as? APIError {
                if e.isUnauthorized { container.handleUnauthorized(); return false }
                if e.isDefinitiveWriteRejection || e.isIdempotencyConflict { actionKeys[slot] = nil }
            }
            workspace.show(APIError.describe(error), style: .error)
            return false
        }
    }

    private func fetchQuietly() async {
        loadTask?.cancel()
        let task = Task { await fetch(reset: true, silent: true) }
        loadTask = task
        await task.value
    }

    // MARK: Eventos

    private func handle(events: [Event]) {
        guard loadedOnce, events.contains(where: { $0.isConversationRelated }) else { return }
        // Fora da tela, só marca; a lista recarrega ao voltar (appear).
        if visible { load(reset: true, silent: true) } else { stale = true }
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
