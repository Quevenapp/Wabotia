import Foundation
import Security

/// Servidor, token (Keychain), usuário e preferências locais.
final class SessionStore {
    private let defaults: UserDefaults
    private let keychainService = "br.com.queven.wabotia.session"
    /// Sessão isolada: nada vai para o Keychain nem para as preferências reais do aparelho.
    private let isolated: Bool

    /// `isolatedSuite` guarda tudo em um domínio à parte (demonstração aberta por variável de ambiente),
    /// sem tocar na sessão real do aparelho. O domínio é zerado a cada abertura e o token (de mentira)
    /// fica nele, fora do Keychain.
    init(isolatedSuite: String? = nil) {
        if let isolatedSuite, let suite = UserDefaults(suiteName: isolatedSuite) {
            suite.removePersistentDomain(forName: isolatedSuite)
            defaults = suite
            isolated = true
        } else {
            defaults = .standard
            isolated = false
        }
    }

    /// Pequenos caches locais por perfil (prévias, não lidas, eventos do atendimento).
    func cachedData(_ key: String) -> Data? { defaults.data(forKey: "cache.\(key)") }
    func setCachedData(_ data: Data?, _ key: String) { defaults.set(data, forKey: "cache.\(key)") }

    /// Endereço normalizado sem barra final, ex.: https://wabotia.queven.com.br
    var serverURL: URL? {
        get { defaults.string(forKey: Keys.server).flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: Keys.server) }
    }

    var token: String? {
        get { isolated ? defaults.string(forKey: "isolated_token") : Keychain.read(service: keychainService, account: "token") }
        set {
            if isolated { defaults.set(newValue, forKey: "isolated_token"); return }
            if let newValue { Keychain.write(newValue, service: keychainService, account: "token") }
            else { Keychain.delete(service: keychainService, account: "token") }
        }
    }

    var tokenExpires: Date? {
        get { defaults.object(forKey: Keys.tokenExpires) as? Date }
        set { defaults.set(newValue, forKey: Keys.tokenExpires) }
    }

    var user: User? {
        get { defaults.data(forKey: Keys.user).flatMap { try? JSONDecoder.wabotia.decode(User.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: Keys.user) }
    }

    var profileId: String? {
        get { defaults.string(forKey: Keys.profile) }
        set { defaults.set(newValue, forKey: Keys.profile) }
    }

    /// Identificador estável desta instalação, usado em PUT /api/v1/devices/{id}.
    var deviceId: String {
        if let id = defaults.string(forKey: Keys.deviceId) { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: Keys.deviceId)
        return id
    }

    var pushToken: String? {
        get { defaults.string(forKey: Keys.pushToken) }
        set { defaults.set(newValue, forKey: Keys.pushToken) }
    }

    var registeredPushToken: String? {
        get { defaults.string(forKey: Keys.pushRegistered) }
        set { defaults.set(newValue, forKey: Keys.pushRegistered) }
    }

    var notificationsEnabled: Bool {
        get { defaults.object(forKey: Keys.notifications) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Keys.notifications) }
    }

    func eventCursor(profileId: String) -> Int64 { Int64(defaults.integer(forKey: "\(Keys.eventCursor).\(profileId)")) }
    func setEventCursor(_ cursor: Int64, profileId: String) { defaults.set(Int(cursor), forKey: "\(Keys.eventCursor).\(profileId)") }

    func clearSession(keepServer: Bool) {
        let server = serverURL
        token = nil
        tokenExpires = nil
        user = nil
        profileId = nil
        registeredPushToken = nil
        serverURL = keepServer ? server : nil
    }

    /// Normaliza o que a pessoa digitou: aceita "wabotia.exemplo.com.br", "https://…/app" etc.
    static func normalizeServer(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text), let host = components.host, !host.isEmpty else { return nil }
        let scheme = (components.scheme ?? "https").lowercased()
        guard scheme == "https" || scheme == "http" else { return nil }
        components.scheme = scheme
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) { components.port = nil }
        return components.url
    }

    private enum Keys {
        static let server = "server"
        static let tokenExpires = "token_expires"
        static let user = "user"
        static let profile = "profile"
        static let deviceId = "device_id"
        static let pushToken = "push_token"
        static let pushRegistered = "push_registered"
        static let notifications = "notifications"
        static let eventCursor = "event_cursor"
    }
}

enum Keychain {
    static func read(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String, service: String, account: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            attributes.forEach { insert[$0.key] = $0.value }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func delete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
