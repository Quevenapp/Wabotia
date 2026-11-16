import Foundation

/// Onde ficam as credenciais das entregas abertas neste aparelho.
protocol CourierGrantStore: AnyObject {
    func load() -> [CourierGrant]
    func save(_ grants: [CourierGrant])
}

/// No Keychain, só neste aparelho e fora do backup (`ThisDeviceOnly`); a primeira abertura de uma instalação nova o
/// apaga (`SessionStore.resetKeychainAfterReinstall`). Cada credencial vale uma entrega e é revogada no fim dela.
final class KeychainCourierGrantStore: CourierGrantStore {
    static let productionService = "br.com.queven.wabotia.courier"
    private let service: String
    init(service: String = KeychainCourierGrantStore.productionService) { self.service = service }

    func load() -> [CourierGrant] {
        guard let text = Keychain.read(service: service, account: "grants"), let data = text.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([CourierGrant].self, from: data)) ?? []
    }

    func save(_ grants: [CourierGrant]) {
        if grants.isEmpty { Keychain.delete(service: service, account: "grants"); return }
        guard let data = try? JSONEncoder().encode(grants), let text = String(data: data, encoding: .utf8) else { return }
        Keychain.write(text, service: service, account: "grants")
    }
}

/// Demonstração e testes: só na memória.
final class MemoryCourierGrantStore: CourierGrantStore {
    private var grants: [CourierGrant]
    init(_ grants: [CourierGrant] = []) { self.grants = grants }
    func load() -> [CourierGrant] { grants }
    func save(_ grants: [CourierGrant]) { self.grants = grants }
}
