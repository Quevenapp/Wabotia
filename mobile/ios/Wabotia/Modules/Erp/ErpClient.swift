import Foundation

/// A última resposta de cada leitura da Gestão, por área, para ver sem conexão (listas, fichas, saldos e contas já
/// vistos). Arquivos na pasta privada do app (`PrivateFileStore`, fora do backup), com nomes `cache.erp.<área>.…`, que a
/// saída da conta apaga com os outros caches. Nada é enfileirado: sem conexão a tela mostra a cópia com o aviso e os
/// botões de mudança ficam desligados. A demonstração não usa a cópia.
final class ErpCache {
    struct Entry: Codable, Equatable {
        var key: String
        var savedAt: Int64
        var body: Data
    }

    private struct Index: Codable { var keys: [String] = [] }

    let maxEntries: Int
    private let store: PrivateFileStore
    private let prefix: String
    private let lock = NSLock()

    init(store: PrivateFileStore, profileId: String, maxEntries: Int = 120) {
        self.store = store
        self.maxEntries = maxEntries
        let safe = String(profileId.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
        prefix = "cache.erp.\(safe)."
    }

    /// A cópia da sessão atual; `nil` na demonstração ou sem área.
    @MainActor
    static func current(_ container: AppContainer = .shared) -> ErpCache? {
        guard !container.isDemo, let profile = container.profileId, !profile.isEmpty, let store = PrivateFileStore.standard else { return nil }
        return ErpCache(store: store, profileId: profile)
    }

    private var index: Index {
        get { store.read(prefix + "index").flatMap { try? JSONDecoder().decode(Index.self, from: $0) } ?? Index() }
        set { if let data = try? JSONEncoder().encode(newValue) { store.write(data, prefix + "index", protection: .complete) } }
    }

    func save(_ key: String, body: Data, now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONEncoder().encode(Entry(key: key, savedAt: BrasiliaTime.millis(now), body: body)) else { return }
        store.write(data, prefix + WorkOrderCache.hash(key), protection: .complete)
        var idx = index
        idx.keys.removeAll { $0 == key }
        idx.keys.insert(key, at: 0)
        while idx.keys.count > maxEntries { store.remove(prefix + WorkOrderCache.hash(idx.keys.removeLast())) }
        index = idx
    }

    func entry(_ key: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        guard let data = store.read(prefix + WorkOrderCache.hash(key)), let entry = try? JSONDecoder().decode(Entry.self, from: data), entry.key == key else { return nil }
        return entry
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        store.removeAll(prefix: prefix)
    }
}

/// As rotas da Gestão: a erp-api do painel (`erp/v1/…`) e o envio pelo WhatsApp (`erp-conversa/…`). Leituras passam pela
/// cópia guardada; escritas levam `command_id` (o ERP repete a mesma resposta para o mesmo comando) e `Idempotency-Key`.
final class ErpClient {
    let api: ProfileAPI
    private let cache: ErpCache?

    init(api: ProfileAPI, cache: ErpCache?) {
        self.api = api
        self.cache = cache
    }

    @MainActor
    static func current(_ container: AppContainer = .shared) -> ErpClient { ErpClient(api: .current(container), cache: ErpCache.current(container)) }

    static func cacheKey(_ path: String, _ query: [String: String?]) -> String {
        path + "?" + query.compactMap { k, v in v.map { "\(k)=\($0)" } }.sorted().joined(separator: "&")
    }

    /// Leitura com cópia: a resposta nova é guardada; sem conexão, volta a última cópia (com a hora dela).
    private func read<T: Decodable>(_ path: String, _ query: [String: String?] = [:]) async throws -> ErpRead<T> {
        let key = Self.cacheKey(path, query)
        do {
            let data = try await api.getData(path, query: query)
            let value = try QueueHTTP.decode(T.self, data)
            cache?.save(key, body: data)
            return ErpRead(value: value)
        } catch {
            guard ErpText.isOffline(error), let copy = cache?.entry(key) else { throw error }
            return ErpRead(value: try QueueHTTP.decode(T.self, copy.body), offlineAt: copy.savedAt)
        }
    }

    func customers(_ query: String, page: Int = 1) async throws -> ErpRead<ErpContactPage> {
        let q = query.trimmingCharacters(in: .whitespaces)
        return try await read("erp/v1/cadastros/contatos", ["page": String(page), "size": "30", "q": q.isEmpty ? nil : q, "sort": q.isEmpty ? nil : "name_asc"])
    }

    func customer(_ id: String) async throws -> ErpRead<ErpContactEnvelope> { try await read("erp/v1/cadastros/contatos/\(Self.seg(id))") }

    func customerOrders(_ id: String) async throws -> ErpRead<ErpSaleHistory> { try await read("erp/v1/cadastros/contatos/\(Self.seg(id))/historico") }

    /// Contas a receber em aberto do cliente: a busca pelo nome e, no aparelho, só as dele.
    func customerBills(_ id: String, name: String) async throws -> ErpRead<[ErpTitle]> {
        let page = try await titles(kind: "receivable", option: "open", query: String(name.prefix(120)))
        return ErpRead(value: (page.value.items ?? []).filter { $0.contactId?.lowercased() == id.lowercased() && $0.isOpen }, offlineAt: page.offlineAt)
    }

    func createCustomer(_ body: [String: Any?], key: String) async throws -> ErpContactEnvelope {
        try await api.send("POST", "erp/v1/cadastros/contatos", body, key: key)
    }

    /// Busca por nome, código ou GTIN (o mesmo campo do painel), só ativos.
    func products(_ query: String) async throws -> ErpRead<ErpProductList> {
        let q = query.trimmingCharacters(in: .whitespaces)
        return try await read("erp/v1/cadastros/products", ["limit": "30", "active": "true", "q": q.isEmpty ? nil : q])
    }

    func product(_ id: String) async throws -> ErpRead<ErpProductEnvelope> { try await read("erp/v1/cadastros/products/\(Self.seg(id))") }

    func stock(_ productId: String) async throws -> ErpRead<ErpStockBalances> { try await read("erp/v1/estoque/saldos", ["product_id": productId]) }

    func productPhoto(_ productId: String) async throws -> Data? {
        let list: ErpProductImages = try await api.get("erp/v1/anexos-cadastros/produtos/\(Self.seg(productId))")
        guard let image = (list.items ?? []).filter({ ($0.status ?? "ready") == "ready" }).min(by: { ($0.position ?? .max) < ($1.position ?? .max) }) else { return nil }
        return try await api.download("erp/v1/anexos-cadastros/produtos/\(Self.seg(productId))/\(Self.seg(image.id))/download")
    }

    func moveStock(_ body: [String: Any?], key: String) async throws {
        _ = try await api.sendData("POST", "erp/v1/estoque/movimentos", body, key: key)
    }

    func paymentOptions() async throws -> ErpRead<ErpPaymentOptions> { try await read("erp/v1/documentos/sales_orders/pagamento") }

    func createOrder(_ body: [String: Any?], key: String) async throws -> ErpOrderSaved {
        try await api.send("POST", "erp/v1/documentos/sales_orders", body, key: key)
    }

    /// O servidor oferece o envio? Recusa ou servidor antigo: o botão não aparece.
    func sendPreview(_ orderId: String) async throws -> ErpSendPreview { try await api.get("erp-conversa/pedido/\(Self.seg(orderId))") }

    func sendOrder(_ orderId: String, phone: String, line: String, key: String) async throws {
        _ = try await api.sendData("POST", "erp-conversa/pedido/\(Self.seg(orderId))/enviar", ["telefone": phone, "linha": line], key: key)
    }

    /// `option`: `open` (em aberto, com período) ou `overdue` (vencidas).
    func titles(kind: String, option: String, from: String? = nil, to: String? = nil, query: String? = nil) async throws -> ErpRead<ErpTitlePage> {
        let q = query?.trimmingCharacters(in: .whitespaces)
        return try await read("erp/v1/financeiro/titles", ["page": "1", "limit": "100", "kind": kind, "option": option, "from": from, "to": to, "q": q?.isEmpty == false ? q : nil])
    }

    func accounts() async throws -> ErpRead<ErpAccountList> { try await read("erp/v1/financeiro/accounts", ["limit": "100"]) }

    func settle(_ body: [String: Any?], key: String) async throws {
        _ = try await api.sendData("POST", "erp/v1/financeiro/actions/settle", body, key: key)
    }

    private static func seg(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
