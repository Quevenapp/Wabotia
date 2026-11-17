import Combine
import Foundation

/// O servidor oferece a fila de senhas a esta área?
enum QueueAvailability: Equatable { case available, unavailable, unknown }

/// Ids dos módulos que o app conhece.
enum ModuleId {
    static let queue = "queue"
    static let agenda = "agenda"
    static let serviceOrders = "os"
    static let reserva = "reserva"
    static let mensalidade = "mensalidade"
    static let pedido = "pedido"
    static let suporte = "suporte"
    static let forms = "forms"
    static let payments = "payments"
}

/// Lê os módulos ligados na resposta da rota de capacidades (docs/MODULOS.md, seção 6):
/// `{capabilities_version, server, features, actor, profiles:[{id, modules:[{id,name,version}]}], modules:[…]}`, com
/// `modules` no topo só no caminho por área. Tolerante ao formato: `modules` como lista de objetos (com `enabled`
/// opcional), lista de ids ou mapa `{id: {...}}`, no topo, dentro de `data` ou na área certa de `profiles`. `nil` quando
/// a resposta não diz nada sobre módulos.
enum ModuleCapabilities {
    /// Ids aceitos para a fila presencial (o servidor usa `queue`).
    static let queueIds: Set<String> = ["queue", "fila", "queue_tickets"]

    static func hasModule(_ json: Any, profileId: String? = nil, ids: Set<String> = queueIds) -> Bool? {
        enabledIds(json, profileId: profileId).map { !$0.isDisjoint(with: ids) }
    }

    /// Os ids dos módulos ligados na área (`queue` também quando o servidor usa um dos nomes antigos da fila).
    static func enabledIds(_ json: Any, profileId: String? = nil) -> Set<String>? {
        guard let root = json as? [String: Any] else { return nil }
        var found: Set<String>?
        if let modules = root["modules"] ?? (root["data"] as? [String: Any])?["modules"] {
            found = ids(modules)
        } else if let profiles = root["profiles"] as? [[String: Any]] {
            let area = profiles.first { ($0["id"] as? String) == profileId } ?? (profiles.count == 1 ? profiles.first : nil)
            if let modules = area?["modules"] { found = ids(modules) }
            // A credencial não alcança a área pedida: nenhum módulo aqui.
            else if profileId != nil, area == nil { found = [] }
        }
        guard var set = found else { return nil }
        if !set.isDisjoint(with: queueIds) { set.insert(ModuleId.queue) }
        return set
    }

    private static func ids(_ modules: Any) -> Set<String>? {
        if let list = modules as? [Any] {
            return Set(list.compactMap { entry -> String? in
                if let id = entry as? String { return id }
                if let object = entry as? [String: Any], let id = object["id"] as? String, enabled(object) { return id }
                return nil
            })
        }
        if let map = modules as? [String: Any] {
            return Set(map.compactMap { id, value -> String? in
                if let object = value as? [String: Any] { return enabled(object) ? id : nil }
                if let flag = value as? Bool { return flag ? id : nil }
                return id
            })
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

/// Quais módulos o servidor oferece à área. Primeiro a rota de capacidades (`GET /api/v1/profiles/{p}/capabilities`,
/// depois `GET /api/v1/capabilities?profile_id=`); enquanto nenhuma delas existir (servidor anterior aos módulos) ou não
/// falar de módulos, só a fila pode existir, e `GET /queue` é o sinal dela: 200 é fila disponível, recusa é
/// indisponível. Falha de rede é `nil` (quem chama mantém o que sabia).
struct ModulesProbe {
    let baseURL: String
    let profileId: String
    let token: () -> String?
    var session: URLSession = QueueHTTP.shared

    func check() async -> Set<String>? { await probe().modules }

    /// Os módulos, a lista do que a pessoa acessa (`AppAccess`; `nil` = sem restrição) e os recursos do servidor
    /// (`features`: `mfa`, `person_access`…).
    func probe() async -> (modules: Set<String>?, access: AppAccess?, features: Set<String>?) {
        let base = QueueHTTP.normalize(baseURL)
        let p = profileId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? profileId
        for path in ["/api/v1/profiles/\(p)/capabilities", "/api/v1/capabilities?profile_id=\(p)"] {
            switch await get(base + path) {
            case .ok(let json):
                if let ids = ModuleCapabilities.enabledIds(json, profileId: profileId) {
                    let features = ((json as? [String: Any])?["features"] as? [String]).map(Set.init)
                    return (ids, AppAccess.parse(json, profileId: profileId), features)
                }
            case .failed(let status):
                if status == 0 { return (nil, nil, nil) }
                // 404/405 (servidor antigo), 401/403: tenta o próximo sinal.
            }
        }
        switch await get(base + "/api/v1/profiles/\(p)/queue") {
        case .ok: return ([ModuleId.queue], nil, nil)
        case .failed(let status): return (status == 0 || status >= 500 || status == 429 ? nil : [], nil, nil)
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

/// A fila de senhas, com o mesmo critério de `ModulesProbe`.
struct QueueAvailabilityProbe {
    let baseURL: String
    let profileId: String
    let token: () -> String?
    var session: URLSession = QueueHTTP.shared

    func check() async -> QueueAvailability {
        guard let ids = await ModulesProbe(baseURL: baseURL, profileId: profileId, token: token, session: session).check() else { return .unknown }
        return ids.contains(ModuleId.queue) ? .available : .unavailable
    }
}

/// Os módulos que o servidor oferece à área aberta (fila, agenda, ordem de serviço). As telas de um módulo só aparecem
/// quando ele está na lista; servidor antigo, módulo desligado ou sem permissão escondem. Consulta no máximo a cada
/// minuto por área, e de novo quando chega `module.changed`.
@MainActor
final class ModuleFeature: ObservableObject {
    static let shared: ModuleFeature = {
        let feature = ModuleFeature()
        // Um administrador ligou ou desligou um módulo: consulta de novo (evento visível a toda credencial da área).
        feature.subscription = Workspace.shared.events.sink { [weak feature] list in
            guard list.contains(where: { $0.kind == "module.changed" }) else { return }
            Task { @MainActor in await feature?.refresh(container: .shared, force: true) }
        }
        return feature
    }()

    @Published private(set) var modules: [String: Set<String>] = [:]
    /// O que a pessoa acessa em cada área (sem entrada = sem restrição).
    @Published private(set) var accessByProfile: [String: AppAccess] = [:]
    private var checkedAt: [String: Date] = [:]
    private var subscription: AnyCancellable?

    /// O módulo está ligado na área E a pessoa o acessa.
    func isAvailable(_ module: String, _ profileId: String?) -> Bool {
        guard let profileId else { return false }
        return (modules[profileId]?.contains(module) ?? false) && access(profileId).allows(module)
    }

    func access(_ profileId: String?) -> AppAccess {
        profileId.flatMap { accessByProfile[$0] } ?? .all
    }

    func refresh(container: AppContainer, force: Bool = false) async {
        guard container.isLoggedIn, let server = container.session.serverURL, let profile = container.profileId else { return }
        if !force, let last = checkedAt[profile], Date().timeIntervalSince(last) < 60 { return }
        checkedAt[profile] = Date()
        let session = container.session
        let result = await ModulesProbe(baseURL: server.absoluteString, profileId: profile, token: { session.token }).probe()
        apply(result.modules, profile: profile, access: result.access)
        if let features = result.features { self.features = features }
        #if DEBUG
        let areas = result.access?.areas.map { $0.sorted().joined(separator: ",") } ?? "sem restrição"
        print("[Wabotia] acesso: \(container.user?.name ?? "?"), módulos \(result.modules.map { $0.sorted().joined(separator: ",") } ?? "?"), acesso \(areas), abas \((result.access ?? .all).tabs.map { "\($0)" }.joined(separator: ",")), sem tela \((result.access ?? .all).withoutScreen.joined(separator: ","))")
        #endif
    }

    /// Recursos que o servidor anuncia em `/capabilities` (`mfa`, `person_access`…). Sem o recurso, o app age como antes.
    @Published private(set) var features: Set<String> = []
    func has(_ feature: String) -> Bool { features.contains(feature) }

    /// `nil` (sem rede): fica o que já se sabia, e a próxima consulta tenta de novo.
    func apply(_ result: Set<String>?, profile: String, access: AppAccess? = nil) {
        guard let result else { checkedAt[profile] = nil; return }
        modules[profile] = result
        accessByProfile[profile] = access
    }

    private var deniedAt: Date?

    /// `403 access_denied` em qualquer rota: relê `/capabilities` já (a lista nova esconde a tela).
    func accessDenied() {
        if let last = deniedAt, Date().timeIntervalSince(last) < 5 { return }
        deniedAt = Date()
        Task { await refresh(container: .shared, force: true) }
    }

    /// Um 409 `module_disabled` numa rota do módulo esconde a tela até a próxima consulta.
    func markDisabled(_ module: String, profile: String) {
        modules[profile]?.remove(module)
        checkedAt[profile] = nil
    }

    func clear() {
        modules = [:]
        accessByProfile = [:]
        features = []
        checkedAt = [:]
    }
}
