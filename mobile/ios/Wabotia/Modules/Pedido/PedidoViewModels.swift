import Foundation

/// Pedidos (aba Atendimento): o quadro da cozinha por estado, a lista com filtro e busca e o cardápio com os
/// interruptores de esgotado. Os eventos `pedido.*` recarregam; o quadro também relê a cada minuto, para o tempo no
/// estado e o destaque de atraso andarem sozinhos.
@MainActor
final class PedidoViewModel: ObservableObject {
    enum Mode: String, CaseIterable, Identifiable {
        case board, list, menu
        var id: String { rawValue }
        var label: String {
            switch self {
            case .board: return "Quadro"
            case .list: return "Pedidos"
            case .menu: return "Cardápio"
            }
        }
    }

    @Published private(set) var mode: Mode = .board
    @Published private(set) var board: PedidoBoard?
    @Published private(set) var orders: [PedidoOrder] = []
    @Published private(set) var page: PedidoPage?
    @Published private(set) var menu: PedidoMenu?
    @Published private(set) var filter = "open"
    @Published var query = ""
    @Published private(set) var loading = true
    @Published private(set) var loadingMore = false
    @Published private(set) var error: String?
    @Published var notice: String?
    @Published private(set) var done: String?
    /// Item ou opção com a troca de esgotado em andamento (`item:<id>`, `option:<grupo>:<opção>`), e a pausa da loja.
    @Published private(set) var busy: Set<String> = []

    let client: PedidoClient
    private let onFailure: (QueueError) -> Void
    /// Uma chave por interruptor: trocas de itens diferentes podem andar juntas.
    private var keys: [String: IntentKeys] = [:]
    private var events: ModuleEvents?
    private var generation = 0
    private var searchTask: Task<Void, Never>?
    #if DEBUG
    private var lastBoardLog = ""
    #endif

    init(client: PedidoClient, onFailure: @escaping (QueueError) -> Void) {
        self.client = client
        self.onFailure = onFailure
    }

    convenience init() {
        self.init(client: PedidoClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.pedido))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "pedido.") { [weak self] in await self?.load() }
    }

    var store: PedidoStore? { board?.store }
    var columns: [PedidoColumn] { board?.columns ?? [] }
    var boardCount: Int { columns.reduce(0) { $0 + ($1.orders?.count ?? 0) } }

    func setMode(_ mode: Mode) {
        guard self.mode != mode else { return }
        self.mode = mode
        error = nil
        Task { await load() }
    }

    func count(_ filter: String) -> Int? {
        guard let page else { return nil }
        switch filter {
        case "all": return nil
        case "open": return PedidoRules.active.reduce(0) { $0 + page.count($1) }
        default: return page.count(filter)
        }
    }

    func setFilter(_ filter: String) {
        guard self.filter != filter else { return }
        self.filter = filter
        orders = []
        Task { await load() }
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

    func load() async {
        generation += 1
        let mine = generation
        if isEmpty { loading = true }
        do {
            switch mode {
            case .board:
                let result = try await client.board()
                guard mine == generation else { return }
                #if DEBUG
                let text = (result.columns ?? []).map { "\($0.status)=\(($0.orders ?? []).compactMap { $0.number.map(String.init) }.joined(separator: "/"))" }.joined(separator: " ")
                if text != lastBoardLog { lastBoardLog = text; print("[Wabotia] pedido: quadro \(text)") }
                #endif
                board = result
            case .list:
                let result = try await fetch(cursor: nil)
                guard mine == generation else { return }
                page = result
                orders = result.data ?? []
            case .menu:
                let result = try await client.menu()
                guard mine == generation else { return }
                menu = result
                // A faixa da loja (pausa) fica visível em todas as visões.
                if board == nil { board = try? await client.board() }
            }
            error = nil
        } catch {
            guard mine == generation else { return }
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
        loading = false
    }

    private var isEmpty: Bool {
        switch mode {
        case .board: return board == nil
        case .list: return orders.isEmpty
        case .menu: return menu == nil
        }
    }

    /// O quadro relê a cada minuto enquanto está na tela (a tarefa da tela cancela ao sair).
    func tick() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard !Task.isCancelled else { return }
            if mode == .board { await load() }
        }
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

    private func fetch(cursor: String?) async throws -> PedidoPage {
        let statuses = filter == "open" || filter == "all" ? [] : [filter]
        return try await client.list(statuses: statuses, open: filter == "open", query: query, cursor: cursor)
    }

    // MARK: - Loja e cardápio

    /// "Loja fechada agora" e a volta; qualquer pessoa da equipe pode.
    func setPaused(_ paused: Bool, message: String) {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        write("pause", signature: "pause:\(paused):\(text)", success: paused ? "Loja pausada" : "Loja recebendo pedidos de novo") { [client] key in
            let store = try await client.pause(paused, message: paused && !text.isEmpty ? text : nil, key: key)
            await MainActor.run { self.board?.store = store }
        }
    }

    func setItem(_ item: PedidoMenuItem, available: Bool) {
        let tag = "item:\(item.id)"
        setAvailable(item: item.id, option: nil, available: available)
        write(tag, signature: "\(tag):\(available)", success: available ? "\(item.name ?? "Item") disponível" : "\(item.name ?? "Item") esgotado") { [client] key in
            _ = try await client.setItemAvailable(item.id, available: available, key: key)
        }
    }

    func setOption(group: PedidoMenuGroup, option: PedidoMenuOption, available: Bool) {
        let tag = "option:\(group.id):\(option.id)"
        setAvailable(item: nil, option: (group.id, option.id), available: available)
        write(tag, signature: "\(tag):\(available)", success: available ? "\(option.name ?? "Opção") disponível" : "\(option.name ?? "Opção") esgotada") { [client] key in
            _ = try await client.setOptionAvailable(groupId: group.id, optionId: option.id, available: available, key: key)
        }
    }

    /// Mostra a troca na hora; a leitura depois da resposta (ou da recusa) corrige.
    private func setAvailable(item: String?, option: (String, String)?, available: Bool) {
        guard var menu else { return }
        if let item {
            for c in menu.categories?.indices ?? 0..<0 {
                for i in menu.categories?[c].items?.indices ?? 0..<0 where menu.categories?[c].items?[i].id == item {
                    menu.categories?[c].items?[i].available = available
                }
            }
        }
        if let (group, opt) = option {
            for g in menu.groups?.indices ?? 0..<0 where menu.groups?[g].id == group {
                for o in menu.groups?[g].options?.indices ?? 0..<0 where menu.groups?[g].options?[o].id == opt {
                    menu.groups?[g].options?[o].available = available
                }
            }
        }
        self.menu = menu
    }

    private func write(_ tag: String, signature: String, success: String, _ block: @escaping (String) async throws -> Void) {
        guard !busy.contains(tag) else { return }
        let keys = self.keys[tag] ?? IntentKeys()
        self.keys[tag] = keys
        let key = keys.key(for: signature)
        busy.insert(tag)
        notice = nil
        Task {
            do {
                try await block(key)
                keys.settle(nil)
                done = success
            } catch {
                keys.settle(error)
                if let e = error as? QueueError { onFailure(e) }
                let retry = (error as? QueueError)?.retryable == true
                notice = ModuleFailure.message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
            }
            busy.remove(tag)
            await load()
        }
    }
}

/// Detalhe do pedido: mudar o estado (cancelar com motivo ao cliente), registrar o pagamento na hora, escolher a
/// forma de pagamento pela equipe e imprimir a comanda.
@MainActor
final class PedidoOrderViewModel: ObservableObject {
    @Published private(set) var order: PedidoOrder?
    @Published private(set) var loading = false
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var done: String?

    let id: String
    let client: PedidoClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var events: ModuleEvents?

    init(id: String, client: PedidoClient, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: PedidoClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.pedido))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "pedido.") { [weak self] in await self?.load() }
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

    func perform(_ status: String, note: String?, reason: String?, notify: Bool) {
        let note = Self.clean(note), reason = Self.clean(reason)
        let success = status == "cancelled" ? "Pedido cancelado" : "Pedido: \(PedidoRules.statusLabel(status))"
        run("status:\(status)", success: success) { [client, id] key in
            try await client.setStatus(id, status: status, note: note, reason: reason, notify: notify, key: key)
        }
    }

    func markPaid(note: String?) {
        let note = Self.clean(note)
        run("paid", success: "Pagamento registrado") { [client, id] key in try await client.markPaid(id, note: note, key: key) }
    }

    func setMethod(_ method: String) {
        run("method:\(method)", success: "Forma de pagamento definida") { [client, id] key in try await client.setMethod(id, method: method, key: key) }
    }

    /// As três larguras da comanda, para o cupom escolher a que cabe na impressora deste aparelho.
    func tickets() async throws -> [Int: String] {
        try await withThrowingTaskGroup(of: (Int, String?).self) { group in
            for columns in [32, 42, 48] {
                group.addTask { [client, id] in (columns, try await client.ticket(id, columns: columns).text) }
            }
            var out: [Int: String] = [:]
            for try await (columns, text) in group { if let text { out[columns] = text } }
            return out
        }
    }

    private func run(_ action: String, success: String, _ block: @escaping (String) async throws -> PedidoOrder) {
        guard busy == nil else { return }
        let key = keys.key(for: "\(action):\(id)")
        busy = action
        notice = nil
        Task {
            do {
                let updated = try await block(key)
                keys.settle(nil)
                var merged = updated
                if merged.history == nil { merged.history = order?.history }
                order = merged
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

    private func message(_ error: Error) -> String {
        switch (error as? QueueError)?.code {
        case "invalid_transition": return "Esta mudança não vale para o pedido agora. A tela foi atualizada."
        case "payment_online": return "Há uma cobrança online aberta: o pagamento é confirmado pelo Mercado Pago."
        case "already_paid": return "O pedido já está pago."
        case "payment_chosen": return "O cliente já escolheu a forma de pagamento."
        case "pedido_conflict": return "O pedido mudou enquanto isso. A tela foi atualizada; confira e tente de novo."
        default: return ModuleFailure.message(error)
        }
    }

    private static func clean(_ text: String?) -> String? {
        let t = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        return t?.isEmpty == false ? t : nil
    }

    var pendingKey: String? { keys.pendingKey }
}
