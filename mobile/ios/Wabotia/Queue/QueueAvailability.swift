import Foundation

/// O servidor oferece a fila de senhas a esta área?
enum QueueAvailability: Equatable { case available, unavailable, unknown }

/// Lê os módulos ligados na resposta da rota de capacidades (docs/MODULOS.md, seção 6):
/// `{capabilities_version, server, features, actor, profiles:[{id, modules:[{id,name,version}]}], modules:[…]}`, com
/// `modules` no topo só no caminho por área. Tolerante ao formato: `modules` como lista de objetos (com `enabled`
/// opcional), lista de ids ou mapa `{id: {...}}`, no topo, dentro de `data` ou na área certa de `profiles`. `nil` quando
/// a resposta não diz nada sobre módulos.
enum ModuleCapabilities {
    /// Ids aceitos para a fila presencial (o servidor usa `queue`).
    static let queueIds: Set<String> = ["queue", "fila", "queue_tickets"]

    static func hasModule(_ json: Any, profileId: String? = nil, ids: Set<String> = queueIds) -> Bool? {
        guard let root = json as? [String: Any] else { return nil }
        if let modules = root["modules"] ?? (root["data"] as? [String: Any])?["modules"] {
            return contains(modules, ids)
        }
        if let profiles = root["profiles"] as? [[String: Any]] {
            let area = profiles.first { ($0["id"] as? String) == profileId } ?? (profiles.count == 1 ? profiles.first : nil)
            if let modules = area?["modules"] { return contains(modules, ids) }
            // A credencial não alcança a área pedida: a fila não está aqui.
            if profileId != nil, area == nil { return false }
        }
        return nil
    }

    private static func contains(_ modules: Any, _ ids: Set<String>) -> Bool? {
        if let list = modules as? [Any] {
            return list.contains { entry in
                if let id = entry as? String { return ids.contains(id) }
                if let object = entry as? [String: Any], let id = object["id"] as? String { return ids.contains(id) && enabled(object) }
                return false
            }
        }
        if let map = modules as? [String: Any] {
            return map.contains { id, value in
                guard ids.contains(id) else { return false }
                if let object = value as? [String: Any] { return enabled(object) }
                if let flag = value as? Bool { return flag }
                return true
            }
        }
        return nil
    }

    private static func enabled(_ object: [String: Any]) -> Bool {
        let flag = object["enabled"] ?? object["active"]
        if let flag = flag as? Bool { return flag }
        if let flag = flag as? NSNumber { return flag.intValue != 0 }
        return true
    }
}

/// Decide se a fila aparece no app. Primeiro a rota de capacidades (`GET /api/v1/profiles/{p}/capabilities`, depois
/// `GET /api/v1/capabilities?profile_id=`); enquanto nenhuma delas existir (servidor anterior aos módulos) ou não falar
/// de módulos, `GET /queue` é o sinal: 200 é fila disponível, recusa é indisponível. Falha de rede é `unknown` e quem
/// chama mantém o que sabia.
struct QueueAvailabilityProbe {
    let baseURL: String
    let profileId: String
    let token: () -> String?
    var session: URLSession = QueueHTTP.shared

    func check() async -> QueueAvailability {
        let base = QueueHTTP.normalize(baseURL)
        let p = profileId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? profileId
        for path in ["/api/v1/profiles/\(p)/capabilities", "/api/v1/capabilities?profile_id=\(p)"] {
            switch await get(base + path) {
            case .ok(let json):
                if let has = ModuleCapabilities.hasModule(json, profileId: profileId) { return has ? .available : .unavailable }
            case .failed(let status):
                if status == 0 { return .unknown }
                // 404/405 (servidor antigo), 401/403: tenta o próximo sinal.
            }
        }
        switch await get(base + "/api/v1/profiles/\(p)/queue") {
        case .ok: return .available
        case .failed(let status): return status == 0 || status >= 500 || status == 429 ? .unknown : .unavailable
        }
    }

    private enum Answer { case ok(Any), failed(Int) }

    private func get(_ text: String) async -> Answer {
        guard let url = URL(string: text) else { return .failed(400) }
        do {
            let (data, response) = try await session.data(for: QueueHTTP.request(url, method: "GET", token: token()))
            guard let http = response as? HTTPURLResponse else { return .failed(0) }
            guard (200..<300).contains(http.statusCode) else { return .failed(http.statusCode) }
            return .ok((try? JSONSerialization.jsonObject(with: data)) ?? [String: Any]())
        } catch {
            return .failed(0)
        }
    }
}

/// Se a fila de senhas existe no servidor para a área aberta (módulo ligado). As telas só mostram guichê e impressora
/// quando sim; servidor antigo, módulo desligado ou sem permissão escondem. Consulta no máximo a cada minuto por área.
@MainActor
final class QueueFeature: ObservableObject {
    static let shared = QueueFeature()

    @Published private(set) var available: [String: Bool] = [:]
    private var checkedAt: [String: Date] = [:]

    func isAvailable(_ profileId: String?) -> Bool { profileId.flatMap { available[$0] } ?? false }

    func refresh(container: AppContainer, force: Bool = false) async {
        guard container.isLoggedIn, let server = container.session.serverURL, let profile = container.profileId else { return }
        if !force, let last = checkedAt[profile], Date().timeIntervalSince(last) < 60 { return }
        checkedAt[profile] = Date()
        let session = container.session
        let result = await QueueAvailabilityProbe(baseURL: server.absoluteString, profileId: profile, token: { session.token }).check()
        apply(result, profile: profile)
    }

    func apply(_ result: QueueAvailability, profile: String) {
        switch result {
        case .available: available[profile] = true
        case .unavailable: available[profile] = false
        // Sem rede: fica o que já se sabia, e a próxima consulta tenta de novo.
        case .unknown: checkedAt[profile] = nil
        }
    }

    /// Um 409 `module_disabled` numa rota da fila esconde a tela até a próxima consulta.
    func markDisabled(_ profile: String) {
        available[profile] = false
        checkedAt[profile] = nil
    }

    func clear() {
        available = [:]
        checkedAt = [:]
    }
}
