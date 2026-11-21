import SwiftUI

/// Grupos da aba Atendimento, na ordem em que aparecem.
enum ServiceSection: String, CaseIterable {
    case modules, daily, assistant, lines

    var title: String {
        switch self {
        case .modules: return "Módulos da área"
        case .daily: return "Do dia a dia"
        case .assistant: return "Gestão"
        case .lines: return "Linhas e menus"
        }
    }
}

/// Uma entrada da aba Atendimento: `id` estável (ícone, cor e testes) e a rota que ela abre. Com `webPath`, abre o
/// painel no navegador em vez de empilhar uma tela.
struct ServiceEntry: Equatable, Identifiable {
    let id: String
    let section: ServiceSection
    let title: String
    let subtitle: String
    let route: Route?
    var webPath: String? = nil
}

/// O que a aba Atendimento mostra: só o básico do atendimento, o que dá para fazer sem computador, igual ao Android
/// (`ui/service/ServiceHub.kt`). Cada módulo aparece só ligado na área; o Caixa simples, com a parte Financeiro ligada e
/// um papel que mexe no caixa. Clientes, Equipamentos e o assistente ficam sempre. O ERP, os relatórios e as
/// configurações dos módulos não aparecem: o assistente responde pelo bot e o painel abre no navegador.
enum ServiceHub {
    /// Papéis do ERP que abrem e fecham caixa (o controle de caixa do Financeiro, src/erp/role-resources.ts).
    static let cashRoles: Set<String> = ["erp:admin", "erp:financeiro"]

    static func cashAllowed(modules: Set<String>, grants: Set<String>, isAdmin: Bool) -> Bool {
        modules.contains(ModuleId.erpFinance) && (isAdmin || !grants.isDisjoint(with: cashRoles))
    }

    static func entries(modules: Set<String>, grants: Set<String>, isAdmin: Bool) -> [ServiceEntry] {
        var list: [ServiceEntry] = []
        func module(_ id: String, _ title: String, _ subtitle: String, _ route: Route) {
            list.append(ServiceEntry(id: id, section: .modules, title: title, subtitle: subtitle, route: route))
        }
        if modules.contains(ModuleId.queue) { module("counter", "Fila de senhas", "Guichê: chamar, rechamar e finalizar; painéis ligados", .counter) }
        if modules.contains(ModuleId.agenda) { module("agenda", "Agenda", "Agendamentos do dia e marcar horário", .agenda) }
        if modules.contains(ModuleId.mensalidade) { module("mensalidade", "Mensalidades", "Parcelas do mês e inadimplentes", .mensalidade) }
        if modules.contains(ModuleId.reserva) { module("reserva", "Reservas", "Ocupação das unidades, sinal e check-in", .reserva) }
        if modules.contains(ModuleId.mesas) { module("mesas", "Mesas", "Abrir mesa, ver a conta e pedir o fechamento", .mesas) }
        if modules.contains(ModuleId.entrega) { module("entrega", "Entregas", "Minhas entregas: sair para entregar e confirmar", .entrega) }
        if modules.contains(ModuleId.pedido) { module("pedido", "Pedidos", "Quadro da cozinha, comanda, pausa da loja e esgotados", .pedido) }
        if modules.contains(ModuleId.serviceOrders) { module("os", "Ordens de serviço", "Recebidas, orçamentos, execução e entrega", .serviceOrders) }

        func daily(_ id: String, _ title: String, _ subtitle: String, _ route: Route) {
            list.append(ServiceEntry(id: id, section: .daily, title: title, subtitle: subtitle, route: route))
        }
        if cashAllowed(modules: modules, grants: grants, isAdmin: isAdmin) { daily("caixa", "Caixa", "Abrir com troco, lançar entradas e saídas, fechar com conferência", .caixa) }
        daily("clientes", "Clientes", "Cadastro básico: nome, telefone, e-mail e observação", .clientes)
        daily("equipamentos", "Equipamentos", "Painéis de senha e impressoras: parear, testar e ver situação", .equipamentos)

        list.append(ServiceEntry(id: "assistente", section: .assistant, title: "Perguntar ao assistente", subtitle: "Vendas, estoque, contas e clientes do ERP em linguagem natural", route: .assistente))
        list.append(ServiceEntry(id: "web", section: .assistant, title: "Abrir no navegador", subtitle: "ERP, relatórios e configurações dos módulos ficam no painel", route: nil, webPath: WebPanel.home(modules: modules)))

        list.append(ServiceEntry(id: "lines", section: .lines, title: "Linhas de atendimento", subtitle: "Quem atende cada número e quando os menus aparecem", route: .lines))
        if isAdmin {
            list.append(ServiceEntry(id: "menus", section: .lines, title: "Menus e submenus", subtitle: "Opções, destinos e linhas permitidas", route: .menus))
            list.append(ServiceEntry(id: "bot-lines", section: .lines, title: "Linhas dos bots", subtitle: "Em quais linhas cada bot pode atender", route: .botLines))
        }
        return list
    }

    /// As entradas agrupadas por seção, na ordem da tela; seções vazias somem.
    static func sections(_ entries: [ServiceEntry]) -> [(section: ServiceSection, entries: [ServiceEntry])] {
        ServiceSection.allCases.compactMap { section in
            let items = entries.filter { $0.section == section }
            return items.isEmpty ? nil : (section, items)
        }
    }
}

/// Endereços do painel web (web/lib/routes.ts) para o "Abrir no navegador": o que é avançado mora lá. Montados sobre o
/// endereço do servidor da sessão.
enum WebPanel {
    /// ERP ligado: o início do ERP; sem ele, o início da Gestão.
    static func home(modules: Set<String>) -> String { modules.contains(ModuleId.erp) ? "/app/erp" : "/app/gestao/inicio" }

    /// Controle de caixa completo (sangria, reabrir, conferido, outros caixas).
    static let cash = "/app/erp/financeiro-empresa?area=controle-caixa"
    static let contacts = "/app/contatos"
    static let mesas = "/app/gestao/mesas"
    static let deliveries = "/app/gestao/entregas"
    static let queueSettings = "/app/gestao/filas"

    /// O endereço completo; `nil` sem servidor de verdade (demonstração).
    static func url(server: String?, path: String) -> URL? {
        guard var base = server?.trimmingCharacters(in: .whitespaces), base.hasPrefix("http://") || base.hasPrefix("https://") else { return nil }
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + path), !DemoMode.isDemo(url) else { return nil }
        return url
    }
}

/// Linha "Abrir no navegador" das telas do básico, quando há servidor.
struct OpenInBrowserRow: View {
    let path: String
    let subtitle: String
    @EnvironmentObject private var container: AppContainer
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let url = WebPanel.url(server: container.session.serverURL?.absoluteString, path: path) {
            SectionCard {
                Button { openURL(url) } label: {
                    CardRow(icon: "safari", iconColor: Theme.muted, title: "Abrir no navegador", subtitle: subtitle, chevron: true, divider: false)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Aba Atendimento (mobile/DESIGN.md, seção 10): os módulos básicos ligados na área, o caixa, os clientes, os
/// equipamentos, o assistente (consulta do ERP pelo bot) e as linhas e menus. Os Ajustes ficam na engrenagem do topo.
struct ServiceView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared
    @Environment(\.pushRoute) private var push
    @Environment(\.openURL) private var openURL

    var body: some View {
        let sessionAdmin = container.user?.isAdmin ?? false
        let isAdmin = feature.isAdmin(container.profileId, sessionIsAdmin: sessionAdmin)
        let modules = container.profileId.flatMap { feature.modules[$0] } ?? []
        let grants = container.profileId.flatMap { feature.grants[$0] } ?? []
        let server = container.session.serverURL?.absoluteString
        // Sem servidor (demonstração) não há painel para abrir: a entrada do navegador some.
        let entries = ServiceHub.entries(modules: modules, grants: grants, isAdmin: isAdmin)
            .filter { $0.webPath == nil || WebPanel.url(server: server, path: $0.webPath!) != nil }
        let sections = ServiceHub.sections(entries)
        VStack(spacing: 0) {
            ScreenHeader(title: "Atendimento") { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !sections.contains(where: { $0.section == .modules }) {
                        Text("Nenhum módulo de atendimento está ligado nesta área. Um administrador liga fila de senhas, agenda, mensalidades e os outros em Gestão → Módulos, no painel.")
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 14)
                    }
                    ForEach(sections, id: \.section) { group in
                        SectionCard(title: group.section.title, footer: footer(group.section, isAdmin: isAdmin)) {
                            ForEach(Array(group.entries.enumerated()), id: \.element.id) { index, entry in
                                let look = Self.look(entry.id)
                                Button {
                                    if let path = entry.webPath, let url = WebPanel.url(server: server, path: path) { openURL(url) }
                                    else if let route = entry.route { push(route) }
                                } label: {
                                    CardRow(icon: look.icon, iconColor: look.color, title: entry.title, subtitle: entry.subtitle, chevron: true, divider: index < group.entries.count - 1)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("service.\(entry.id)")
                            }
                        }
                    }
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        // Toda vez que a aba abre: módulos e papel podem ter mudado no painel.
        .task(id: "\(active)-\(container.profileId ?? "")") {
            if active { await feature.refresh(container: container, force: true) }
        }
    }

    private func footer(_ section: ServiceSection, isAdmin: Bool) -> String? {
        switch section {
        case .assistant: return "Notas fiscais, compras, estoque e relatórios ficam no painel. No celular, pergunte ao assistente."
        case .lines: return isAdmin ? nil : "Atendentes consultam as linhas; a edição é do administrador."
        case .modules, .daily: return nil
        }
    }

    /// Ícone e cor de cada entrada.
    static func look(_ id: String) -> (icon: String, color: Color) {
        switch id {
        case "counter": return ("ticket", Theme.ticket)
        case "agenda": return ("calendar", Theme.brand)
        case "os": return ("wrench.and.screwdriver.fill", Theme.warn)
        case "reserva": return ("bed.double.fill", Theme.ticket)
        case "mensalidade": return ("creditcard.fill", Theme.bot)
        case "pedido": return ("takeoutbag.and.cup.and.straw.fill", Theme.warn)
        case "mesas": return ("fork.knife", Theme.ticket)
        case "entrega": return ("bicycle", Theme.brand)
        case "caixa": return ("banknote.fill", Theme.ok)
        case "clientes": return ("person.2.fill", Theme.brand)
        case "equipamentos": return ("printer.fill", Theme.muted)
        case "assistente": return ("sparkles", Theme.bot)
        case "web": return ("safari", Theme.muted)
        case "menus": return ("list.bullet.indent", Theme.brand)
        case "bot-lines": return ("cpu", Theme.bot)
        default: return ("phone.connection", Theme.ok)
        }
    }
}
