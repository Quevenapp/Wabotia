import Foundation

/// O que esta pessoa acessa no app (docs/API.md, "Acesso por pessoa"; recurso `person_access` em `/capabilities`).
/// Cada área de `profiles` traz `access`, já expandido e só com módulos ligados: áreas do atendimento
/// (`conversations`, `tickets`, `contacts`, `calls`, `team`, `reports`), módulos (`queue`, `agenda`, `os`…) e papéis de
/// módulo (`os:technician`, `mesas:waiter`, `entrega:courier`, `caixa:cashier`). A barra inferior e as telas são
/// montadas só com o que vier. `access: null` (aparelho pareado, aplicação) ou servidor sem o recurso: sem restrição,
/// como antes (valem `modules` e os escopos). `["*"]` é o atendente completo: tudo, menos os papéis.
struct AppAccess: Equatable {
    /// `nil`: sem restrição.
    var areas: Set<String>?

    static let all = AppAccess(areas: nil)

    enum Area {
        static let conversations = "conversations"
        static let tickets = "tickets"
        static let contacts = "contacts"
        static let team = "team"
        static let calls = "calls"
        static let reports = "reports"
        /// Linhas de atendimento, menus e linhas dos bots: vão com as conversas (não há item próprio).
        static let lines = "conversations"
    }

    /// As áreas que moram na aba Atendimento.
    static let attendanceAreas: Set<String> = [Area.tickets, ModuleId.queue, ModuleId.agenda, ModuleId.serviceOrders,
                                               ModuleId.reserva, ModuleId.pedido, ModuleId.mensalidade]

    /// Itens do atendimento que não têm tela própria no app (ficam no painel), sem pedir explicação.
    static let panelOnly: Set<String> = [Area.contacts, Area.reports]

    /// `area` é um item (`tickets`, `os`) ou um papel (`os:technician`). `*` dá tudo menos os papéis.
    func allows(_ area: String) -> Bool {
        guard let areas else { return true }
        if areas.contains(area) { return true }
        return !area.contains(":") && (areas.contains("*") || areas.contains("all"))
    }

    var restricted: Bool { areas != nil && !(areas?.contains("*") ?? false) }

    /// As abas, na ordem de sempre. Ajustes sempre; Atendimento também quando nada mais sobra, para explicar.
    var tabs: [HomeTab] {
        var out: [HomeTab] = []
        if allows(Area.conversations) { out.append(.conversations) }
        if !Self.attendanceAreas.filter(allows).isEmpty || allows(Area.conversations) { out.append(.attendance) }
        if allows(Area.team) { out.append(.team) }
        if allows(Area.calls) { out.append(.calls) }
        if out.isEmpty { out.append(.attendance) }
        out.append(.settings)
        return out
    }

    /// Módulos e papéis da lista que ainda não têm tela neste app (caixa, garçom, entregador com login…), um por módulo:
    /// a aba Atendimento diz que ficam no painel.
    var withoutScreen: [String] {
        guard let areas else { return [] }
        let known = Self.attendanceAreas.union([Area.conversations, Area.team, Area.calls, "*", "all"]).union(Self.panelOnly)
        return Set(areas.map { String($0.split(separator: ":").first ?? Substring($0)) }).subtracting(known).sorted()
    }

    // MARK: - Leitura

    /// `nil` quando a resposta não restringe (sem `access`, ou `access: null`).
    static func parse(_ json: Any, profileId: String?) -> AppAccess? {
        guard let root = json as? [String: Any] else { return nil }
        var places: [[String: Any]] = []
        if let profiles = root["profiles"] as? [[String: Any]] {
            if let area = profiles.first(where: { ($0["id"] as? String) == profileId }) ?? (profiles.count == 1 ? profiles.first : nil) { places.append(area) }
        }
        places.append(root)
        for place in places {
            guard let value = place["access"] else { continue }
            // `null`: aparelho pareado ou aplicação, sem restrição por pessoa.
            if value is NSNull { return nil }
            if let list = value as? [String] { return AppAccess(areas: normalize(list)) }
            if let list = value as? [[String: Any]] { return AppAccess(areas: normalize(list.compactMap { $0["id"] as? String })) }
        }
        return nil
    }

    static func normalize(_ list: [String]) -> Set<String> {
        Set(list.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty })
    }

    /// Nome legível de um módulo sem tela no app.
    static func title(_ area: String) -> String {
        switch area {
        case "caixa": return "Caixa"
        case "mesas": return "Garçom e mesas"
        case "entrega": return "Entregas"
        default: return area.capitalized
        }
    }
}

/// `403 access_denied`: a pessoa não acessa mais aquilo (o administrador mudou o acesso). A tela some e o app relê
/// `/capabilities` (no máximo uma vez a cada poucos segundos).
enum AccessDenial {
    static func report(status: Int, code: String) {
        guard status == 403, code == "access_denied" else { return }
        Task { @MainActor in ModuleFeature.shared.accessDenied() }
    }
}
