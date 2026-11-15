import Foundation
import Security

/// Servidor, token (Keychain), usuário e preferências locais.
final class SessionStore {
    private let defaults: UserDefaults
    private let keychainService = SessionStore.sessionService
    /// Sessão isolada: nada vai para o Keychain nem para as preferências reais do aparelho.
    private let isolated: Bool

    /// `isolatedSuite` guarda tudo em um domínio à parte (demonstração aberta por variável de ambiente no build
    /// de depuração, testes),
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

    /// Token da pessoa para o servidor configurado. Fica preso à origem (esquema, host e porta) do servidor em que a
    /// pessoa entrou: com outro `serverURL`, ou sem nenhum, não há token, e nada vai para um endereço novo.
    /// Gravar usa a origem do `serverURL` atual, então o servidor é gravado antes do token.
    var token: String? {
        get { serverURL.flatMap { token(for: $0) } }
        set {
            let origin = newValue == nil ? nil : serverURL.map(Self.origin)
            if isolated {
                defaults.set(newValue, forKey: "isolated_token")
                defaults.set(origin, forKey: "isolated_token_origin")
                return
            }
            if let newValue, let origin {
                Keychain.write(newValue, service: keychainService, account: "token")
                Keychain.write(origin, service: keychainService, account: "origin")
            } else {
                Keychain.delete(service: keychainService, account: "token")
                Keychain.delete(service: keychainService, account: "origin")
            }
        }
    }

    /// O token só sai para a origem que o emitiu.
    func token(for url: URL) -> String? {
        let stored = isolated ? defaults.string(forKey: "isolated_token") : Keychain.read(service: keychainService, account: "token")
        let origin = isolated ? defaults.string(forKey: "isolated_token_origin") : Keychain.read(service: keychainService, account: "origin")
        guard let stored, let origin, origin == Self.origin(url) else { return nil }
        return stored
    }

    /// `https://host[:porta]`, em minúsculas, sem caminho.
    static func origin(_ url: URL) -> String {
        let scheme = (url.scheme ?? "https").lowercased()
        let host = (url.host ?? "").lowercased()
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    /// O iOS não apaga o Keychain quando o app é desinstalado, mas apaga as preferências. Na primeira abertura depois
    /// de instalar (preferências do app vazias, sem a marca), apaga os serviços do Keychain do app (`services`): o token
    /// de uma conta antiga não vai para o próximo servidor digitado e um totem "desativado" apagando o app não volta
    /// pareado. Numa atualização (preferências já existem), só grava a marca e a origem do token que veio de versões
    /// que não a guardavam.
    static func resetKeychainAfterReinstall(defaults: UserDefaults = .standard, domain: String? = Bundle.main.bundleIdentifier,
                                            services: [String] = [sessionService, KeychainDeviceConfigStore.productionService]) {
        guard !defaults.bool(forKey: Keys.installMarker) else { return }
        let existing = domain.flatMap { defaults.persistentDomain(forName: $0) } ?? [:]
        if existing.isEmpty {
            services.forEach(Keychain.deleteAll(service:))
        } else if services.contains(sessionService),
                  Keychain.read(service: sessionService, account: "token") != nil,
                  Keychain.read(service: sessionService, account: "origin") == nil,
                  let server = defaults.string(forKey: Keys.server).flatMap(URL.init(string:)) {
            Keychain.write(origin(server), service: sessionService, account: "origin")
        }
        defaults.set(true, forKey: Keys.installMarker)
    }

    static let sessionService = "br.com.queven.wabotia.session"

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

    /// Encerra a sessão sem deixar dados de clientes no aparelho: token, usuário, perfil, token de push,
    /// caches `cache.*` (prévias de mensagens), cursores de eventos, anexos baixados e arquivos temporários.
    /// Ficam só o endereço do servidor (se `keepServer`), o identificador da instalação (`device_id`, que
    /// não é dado de cliente e faz o próximo login reaproveitar o mesmo registro em /devices/{id}) e as
    /// preferências do aparelho (notificações, aparência).
    func clearSession(keepServer: Bool) {
        let server = serverURL
        token = nil
        tokenExpires = nil
        user = nil
        profileId = nil
        pushToken = nil
        registeredPushToken = nil
        clearLocalCaches()
        serverURL = keepServer ? server : nil
        Self.removeLocalFiles()
    }

    /// Caches `cache.*` (prévias, não lidas, eventos do atendimento) e cursores de eventos. A demonstração
    /// também usa ao entrar e ao reabrir o app, porque os dados de exemplo recomeçam do zero.
    func clearLocalCaches() {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("cache.") || key.hasPrefix("\(Keys.eventCursor).") {
            defaults.removeObject(forKey: key)
        }
    }

    /// Apaga do disco o que o app baixou ou gerou: anexos em Caches/media, respostas HTTP em cache e tudo
    /// o que estiver na pasta temporária (documentos abertos, anexos de bots, gravações de voz, vídeos convertidos).
    static func removeLocalFiles() {
        URLCache.shared.removeAllCachedResponses()
        let files = FileManager.default
        var folders = [files.temporaryDirectory]
        if let caches = files.urls(for: .cachesDirectory, in: .userDomainMask).first {
            folders.append(caches.appendingPathComponent("media", isDirectory: true))
        }
        for folder in folders {
            let items = (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            for item in items { try? files.removeItem(at: item) }
        }
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
        static let installMarker = "install_marker"
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

    /// Todos os itens de um serviço, qualquer que seja a conta.
    static func deleteAll(service: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
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
