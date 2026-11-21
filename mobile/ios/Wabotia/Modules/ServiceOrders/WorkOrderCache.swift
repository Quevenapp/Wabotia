import Foundation

/// A última lista carregada (por filtro) e cada ficha aberta, para consulta sem conexão. Arquivos JSON na pasta privada
/// do app (`PrivateFileStore`: fora do backup e ilegíveis com o aparelho bloqueado), com nomes `cache.wo.<área>.…`,
/// que a saída da conta apaga junto com os outros caches (`SessionStore.clearLocalCaches`). Nada é enfileirado: só
/// leitura. A demonstração não usa o cache.
final class WorkOrderCache {
    struct ListEntry: Codable, Equatable {
        var key: String
        var savedAt: Int64
        var orders: [WorkOrder]
        var nextCursor: String?
    }

    struct DetailEntry: Codable, Equatable {
        var orderId: String
        var savedAt: Int64
        var order: WorkOrder
        var history: [WorkHistoryEntry]
        var catalog: WorkTypeCatalog?
    }

    struct CatalogEntry: Codable, Equatable {
        var savedAt: Int64
        var catalog: WorkTypeCatalog
    }

    private struct Index: Codable {
        var lists: [String] = []
        var details: [String] = []
    }

    static let maxLists = 5
    static let maxDetails = 50

    private let store: PrivateFileStore
    private let prefix: String
    private let lock = NSLock()

    init(store: PrivateFileStore, profileId: String) {
        self.store = store
        let safe = String(profileId.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
        self.prefix = "cache.wo.\(safe)."
    }

    /// O cache da sessão atual; `nil` na demonstração ou sem área.
    @MainActor
    static func current(_ container: AppContainer = .shared) -> WorkOrderCache? {
        guard !container.isDemo, let profile = container.profileId, !profile.isEmpty, let store = PrivateFileStore.standard else { return nil }
        return WorkOrderCache(store: store, profileId: profile)
    }

    /// FNV-1a de 64 bits: nome de arquivo estável e curto para a chave (filtros, ids).
    static func hash(_ text: String) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in text.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
        return String(h, radix: 16)
    }

    private func read<T: Decodable>(_ name: String, _ type: T.Type) -> T? {
        guard let data = store.read(prefix + name) else { return nil }
        return try? WorkJSON.decoder.decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T, _ name: String) {
        guard let data = try? WorkJSON.encoder.encode(value) else { return }
        store.write(data, prefix + name, protection: .complete)
    }

    private var index: Index {
        get { read("index", Index.self) ?? Index() }
        set { write(newValue, "index") }
    }

    // MARK: Lista

    func saveList(key: String, orders: [WorkOrder], nextCursor: String?, now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        write(ListEntry(key: key, savedAt: BrasiliaTime.millis(now), orders: orders, nextCursor: nextCursor), "list." + Self.hash(key))
        var idx = index
        idx.lists.removeAll { $0 == key }
        idx.lists.insert(key, at: 0)
        while idx.lists.count > Self.maxLists { store.remove(prefix + "list." + Self.hash(idx.lists.removeLast())) }
        index = idx
    }

    func list(key: String) -> ListEntry? {
        lock.lock(); defer { lock.unlock() }
        guard let entry = read("list." + Self.hash(key), ListEntry.self), entry.key == key else { return nil }
        return entry
    }

    var listKeys: [String] { lock.lock(); defer { lock.unlock() }; return index.lists }

    // MARK: Ficha

    func saveDetail(order: WorkOrder, history: [WorkHistoryEntry], catalog: WorkTypeCatalog?, now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        write(DetailEntry(orderId: order.id, savedAt: BrasiliaTime.millis(now), order: order, history: history, catalog: catalog), "order." + Self.hash(order.id))
        var idx = index
        idx.details.removeAll { $0 == order.id }
        idx.details.insert(order.id, at: 0)
        while idx.details.count > Self.maxDetails { store.remove(prefix + "order." + Self.hash(idx.details.removeLast())) }
        index = idx
    }

    func detail(_ id: String) -> DetailEntry? {
        lock.lock(); defer { lock.unlock() }
        guard let entry = read("order." + Self.hash(id), DetailEntry.self), entry.orderId == id else { return nil }
        return entry
    }

    var detailIds: [String] { lock.lock(); defer { lock.unlock() }; return index.details }

    // MARK: Catálogo

    func saveCatalog(_ catalog: WorkTypeCatalog, now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        write(CatalogEntry(savedAt: BrasiliaTime.millis(now), catalog: catalog), "catalog")
    }

    func catalog() -> CatalogEntry? {
        lock.lock(); defer { lock.unlock() }
        return read("catalog", CatalogEntry.self)
    }

    /// Tudo desta área (a saída da conta apaga todos os `cache.` de uma vez).
    func clear() {
        lock.lock(); defer { lock.unlock() }
        store.removeAll(prefix: prefix)
    }
}
