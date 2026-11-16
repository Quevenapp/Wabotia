import Foundation

/// O que esta pessoa acessa no app (lista por usuário em `/capabilities`: "só caixa", "só garçom"…). A barra inferior e
/// as telas são montadas só com o que a lista deixa. Sem lista (servidor antigo, ou acesso a tudo), tudo aparece, como
/// antes. O contrato ainda está sendo fechado no servidor: as chaves lidas e os nomes das áreas ficam todos aqui.
struct AppAccess: Equatable {
    /// `nil`: sem restrição.
    var areas: Set<String>?

    static let all = AppAccess(areas: nil)

    /// Nomes das áreas (provisórios). Os módulos usam o próprio id (`queue`, `agenda`, `os`, `pedido`…).
    enum Area {
        static let conversations = "conversations"
        static let tickets = "tickets"
        static let team = "team"
        static let calls = "calls"
        static let lines = "lines"
    }

    /// Outros nomes que o servidor pode usar para a mesma área.
    static let aliases: [String: String] = [
        "conversas": Area.conversations, "inbox": Area.conversations, "atendimento": Area.conversations,
        "protocolos": Area.tickets, "equipe": Area.team, "ligacoes": Area.calls, "linhas": Area.lines,
        "fila": ModuleId.queue, "guiche": ModuleId.queue, "ordem_servico": ModuleId.serviceOrders,
        "garcom": "mesas", "waiter": "mesas", "cashier": "caixa", "delivery": "entrega",
    ]

    /// As áreas que moram na aba Atendimento.
    static let attendanceAreas: Set<String> = [Area.tickets, Area.lines, ModuleId.queue, ModuleId.agenda, ModuleId.serviceOrders,
                                               ModuleId.reserva, ModuleId.pedido, ModuleId.mensalidade]

    func allows(_ area: String) -> Bool {
        guard let areas else { return true }
        return areas.contains(area) || areas.contains("*") || areas.contains("all")
    }

    var restricted: Bool { areas != nil && !allows("*") }

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

    /// Áreas da lista que ainda não têm tela no app (caixa, garçom…): a aba Atendimento diz que ficam no painel.
    var withoutScreen: [String] {
        guard let areas else { return [] }
        let known = Self.attendanceAreas.union([Area.conversations, Area.team, Area.calls, "*", "all"])
        return areas.subtracting(known).sorted()
    }

    // MARK: - Leitura

    /// Chaves aceitas para a lista, por ordem: na área da pessoa, em `actor`, no topo.
    static let keys = ["access", "app_access", "areas", "screens"]

    /// `nil` quando a resposta não traz lista nenhuma (sem restrição).
    static func parse(_ json: Any, profileId: String?) -> AppAccess? {
        guard let root = json as? [String: Any] else { return nil }
        var places: [[String: Any]] = []
        if let profiles = root["profiles"] as? [[String: Any]] {
            if let area = profiles.first(where: { ($0["id"] as? String) == profileId }) ?? (profiles.count == 1 ? profiles.first : nil) { places.append(area) }
        }
        if let actor = root["actor"] as? [String: Any] { places.append(actor) }
        places.append(root)
        for place in places {
            for key in keys {
                guard let value = place[key] else { continue }
                if let list = value as? [String] { return AppAccess(areas: normalize(list)) }
                if let list = value as? [[String: Any]] { return AppAccess(areas: normalize(list.compactMap { $0["id"] as? String })) }
                if let map = value as? [String: Any] {
                    return AppAccess(areas: normalize(map.compactMap { key, flag in (flag as? Bool ?? true) ? key : nil }))
                }
            }
        }
        return nil
    }

    static func normalize(_ list: [String]) -> Set<String> {
        Set(list.map { item in
            let id = item.trimmingCharacters(in: .whitespaces).lowercased()
                .folding(options: .diacriticInsensitive, locale: Locale(identifier: "pt_BR"))
            return aliases[id] ?? id
        }.filter { !$0.isEmpty })
    }

    /// Nome legível de uma área sem tela no app.
    static func title(_ area: String) -> String {
        switch area {
        case "caixa": return "Caixa"
        case "mesas": return "Garçom e mesas"
        case "vendas": return "Vendas e orçamento"
        case "entrega": return "Entregas"
        default: return area.capitalized
        }
    }
}
