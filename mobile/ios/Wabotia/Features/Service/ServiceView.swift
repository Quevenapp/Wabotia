import SwiftUI

/// Grupos da aba Atendimento, na ordem em que aparecem.
enum ServiceSection: String, CaseIterable {
    case modules, management, lines

    var title: String {
        switch self {
        case .modules: return "Módulos da área"
        case .management: return "Gestão"
        case .lines: return "Linhas e menus"
        }
    }
}

/// Uma entrada da aba Atendimento: `id` estável (ícone, cor e testes) e a rota que ela abre.
struct ServiceEntry: Equatable, Identifiable {
    let id: String
    let section: ServiceSection
    let title: String
    let subtitle: String
    let route: Route
}

/// O que a aba Atendimento mostra (antes era a seção Atendimento dos Ajustes), igual ao Android (`ui/service/ServiceHub.kt`).
/// Cada módulo só aparece ligado na área; a Gestão só com o ERP ligado e um papel do ERP (ou administrador), item a item
/// pela parte e pelo papel (`ErpAccess`); menus e linhas dos bots só para administrador.
enum ServiceHub {
    static func entries(modules: Set<String>, erp: ErpAccess?, isAdmin: Bool) -> [ServiceEntry] {
        var list: [ServiceEntry] = []
        func module(_ id: String, _ title: String, _ subtitle: String, _ route: Route) {
            list.append(ServiceEntry(id: id, section: .modules, title: title, subtitle: subtitle, route: route))
        }
        if modules.contains(ModuleId.queue) { module("counter", "Guichê da fila de senhas", "Chamar a próxima senha, rechamar, concluir e transferir", .counter) }
        if modules.contains(ModuleId.agenda) { module("agenda", "Agenda", "Agendamentos do dia e da semana por profissional", .agenda) }
        if modules.contains(ModuleId.serviceOrders) { module("os", "Ordens de serviço", "Recebidas, orçamentos, execução e entrega", .serviceOrders) }
        if modules.contains(ModuleId.reserva) { module("reserva", "Reservas", "Ocupação das unidades, sinal e check-in", .reserva) }
        if modules.contains(ModuleId.mensalidade) { module("mensalidade", "Mensalidades", "Parcelas do mês, assinaturas e inadimplentes", .mensalidade) }
        if modules.contains(ModuleId.pedido) { module("pedido", "Pedidos", "Quadro da cozinha, comanda, pausa da loja e esgotados", .pedido) }

        if let erp {
            func management(_ id: String, _ title: String, _ subtitle: String, _ route: Route) {
                list.append(ServiceEntry(id: id, section: .management, title: title, subtitle: subtitle, route: route))
            }
            if erp.customers { management("erp.customers", "Clientes", "Busca, ficha, ligar e WhatsApp" + (erp.canCreateCustomer ? "; cadastro rápido" : ""), .erpCustomers) }
            if erp.products { management("erp.products", "Produtos e estoque", "Busca por nome, código ou código de barras" + (erp.stock ? "; saldo por depósito" : ""), .erpProducts) }
            if erp.quickOrder { management("erp.order", "Pedido rápido", "Cliente, itens, desconto e pagamento", .erpOrder) }
            if erp.bills { management("erp.bills", "Contas", "A receber e a pagar do dia e vencidas", .erpBills) }
        }

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

/// Aba Atendimento (mobile/DESIGN.md, seção 10): os módulos ligados na área, a Gestão do ERP e as linhas e menus. Os
/// Ajustes ficam na engrenagem do topo.
struct ServiceView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared
    @Environment(\.pushRoute) private var push

    var body: some View {
        let sessionAdmin = container.user?.isAdmin ?? false
        let isAdmin = feature.isAdmin(container.profileId, sessionIsAdmin: sessionAdmin)
        let erp = feature.erpAccess(container.profileId, isAdmin: sessionAdmin)
        let modules = container.profileId.flatMap { feature.modules[$0] } ?? []
        let sections = ServiceHub.sections(ServiceHub.entries(modules: modules, erp: erp, isAdmin: isAdmin))
        VStack(spacing: 0) {
            ScreenHeader(title: "Atendimento") { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !sections.contains(where: { $0.section != .lines }) {
                        Text("Nenhum módulo de atendimento está ligado nesta área. Um administrador liga agenda, ordens de serviço, pedidos, Gestão e os outros em Módulos, no painel do Wabotia.")
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 14)
                    }
                    ForEach(sections, id: \.section) { group in
                        VStack(alignment: .leading, spacing: 6) {
                            SectionCard(title: title(group.section, erp: erp), footer: footer(group.section, isAdmin: isAdmin)) {
                                ForEach(Array(group.entries.enumerated()), id: \.element.id) { index, entry in
                                    let look = Self.look(entry.id)
                                    Button { push(entry.route) } label: {
                                        CardRow(icon: look.icon, iconColor: look.color, title: entry.title, subtitle: entry.subtitle, chevron: true, divider: index < group.entries.count - 1)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("service.\(entry.id)")
                                }
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

    private func title(_ section: ServiceSection, erp: ErpAccess?) -> String {
        if section == .management, let erp { return "\(section.title) · seu papel: \(erp.role.label)" }
        return section.title
    }

    private func footer(_ section: ServiceSection, isAdmin: Bool) -> String? {
        switch section {
        case .management: return "Notas fiscais, compras, relatórios e configurações da Gestão ficam no painel, no navegador."
        case .lines: return isAdmin ? nil : "Atendentes consultam as linhas; a edição é do administrador."
        case .modules: return nil
        }
    }

    /// Ícone e cor de cada entrada (os mesmos que tinham em Ajustes e na Gestão).
    static func look(_ id: String) -> (icon: String, color: Color) {
        switch id {
        case "counter": return ("ticket", Theme.ticket)
        case "agenda": return ("calendar", Theme.brand)
        case "os": return ("wrench.and.screwdriver.fill", Theme.warn)
        case "reserva": return ("bed.double.fill", Theme.ticket)
        case "mensalidade": return ("creditcard.fill", Theme.bot)
        case "pedido": return ("takeoutbag.and.cup.and.straw.fill", Theme.warn)
        case "erp.customers": return ("person.2.fill", Theme.brand)
        case "erp.products": return ("shippingbox.fill", Theme.warn)
        case "erp.order": return ("cart.fill", Theme.ok)
        case "erp.bills": return ("banknote.fill", Theme.ticket)
        case "menus": return ("list.bullet.indent", Theme.brand)
        case "bot-lines": return ("cpu", Theme.bot)
        default: return ("phone.connection", Theme.ok)
        }
    }
}
