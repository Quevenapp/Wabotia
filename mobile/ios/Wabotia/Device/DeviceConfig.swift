import Foundation

/// O que este aparelho faz na fila. O guichê não está aqui: ele fica no app logado, com o token da pessoa.
enum DeviceRole: String, Codable, CaseIterable, Identifiable {
    case totem, panel, hybrid

    var id: String { rawValue }

    var label: String {
        switch self {
        case .totem: return "Totem"
        case .panel: return "Painel de chamadas"
        case .hybrid: return "Painel híbrido"
        }
    }

    var detail: String {
        switch self {
        case .totem: return "Retirar senha e imprimir o cupom"
        case .panel: return "TV com as senhas chamadas, voz e gongo"
        case .hybrid: return "Totem e chamadas na mesma tela"
        }
    }

    var icon: String {
        switch self {
        case .totem: return "ticket"
        case .panel: return "tv"
        case .hybrid: return "rectangle.split.2x1"
        }
    }

    var totem: Bool { self != .panel }
    var panel: Bool { self != .totem }
}

/// A ligação deste aparelho com o Wabotia, separada da sessão de pessoa: o token é `wab_…` do pareamento
/// (`client=senhapp`), nunca o `wabu_…` de quem entra no app. Sair da conta não desfaz o aparelho, e desfazer o
/// aparelho não mexe na conta.
struct DeviceConfig: Codable, Equatable, CustomStringConvertible {
    var deviceId: String
    var baseUrl: String
    var token: String
    var profileId: String
    var name: String
    var role: DeviceRole?
    /// O que o administrador aprovou; `nil` quando o servidor não informou.
    var scopes: [String]?
    /// Aparelho da demonstração: vive só na memória e nunca toca a rede.
    var demo: Bool = false

    func allows(_ scope: String) -> Bool { scopes?.contains(scope) ?? true }

    /// O painel some com os botões do totem quando o administrador não aprovou emitir senhas.
    var canIssue: Bool { allows(DeviceScopes.issue) }

    /// O token nunca aparece em log nem em descrição.
    var description: String { "DeviceConfig(deviceId: \(deviceId), profileId: \(profileId), role: \(role?.rawValue ?? "-"), token: [REDACTED])" }

    static func newDeviceId() -> String { UUID().uuidString.lowercased() }
}

protocol DeviceConfigStore: AnyObject {
    func load() -> DeviceConfig?
    func save(_ config: DeviceConfig?)
}

/// Para a demonstração e para os testes: nada vai para o disco.
final class MemoryDeviceConfigStore: DeviceConfigStore {
    private var config: DeviceConfig?
    init(_ config: DeviceConfig? = nil) { self.config = config }
    func load() -> DeviceConfig? { config }
    func save(_ config: DeviceConfig?) { self.config = config }
}

/// A credencial do aparelho no Keychain, num serviço próprio (`br.com.queven.wabotia.device`), longe do token da
/// pessoa (`br.com.queven.wabotia.session`): sair da conta apaga só a sessão. Acessível depois do primeiro desbloqueio
/// e só neste aparelho (um totem que reinicia volta sozinho, e o vínculo não vai para backup). Desinstalar o app ou
/// desfazer o pareamento apaga; o administrador revoga em Integrações.
final class KeychainDeviceConfigStore: DeviceConfigStore {
    static let productionService = "br.com.queven.wabotia.device"
    let service: String
    private let account = "config"

    init(service: String = KeychainDeviceConfigStore.productionService) { self.service = service }

    func load() -> DeviceConfig? {
        guard let text = Keychain.read(service: service, account: account), let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(DeviceConfig.self, from: data)
    }

    func save(_ config: DeviceConfig?) {
        guard let config, !config.demo, let data = try? JSONEncoder().encode(config), let text = String(data: data, encoding: .utf8) else {
            Keychain.delete(service: service, account: account)
            return
        }
        Keychain.write(text, service: service, account: account)
    }
}
