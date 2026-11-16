import SwiftUI

enum HomeTab: String, CaseIterable, Identifiable {
    case conversations, attendance, team, calls, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .conversations: return "Conversas"
        case .attendance: return "Atendimento"
        case .team: return "Equipe"
        case .calls: return "Ligações"
        case .settings: return "Ajustes"
        }
    }
    var icon: String {
        switch self {
        case .conversations: return "bubble.left.and.bubble.right"
        case .attendance: return "briefcase"
        case .team: return "person.2"
        case .calls: return "phone"
        case .settings: return "gearshape"
        }
    }
}

/// Raiz do app depois do login: cinco abas na base e uma única pilha de navegação por cima delas
/// (toda tela empilhada cobre a barra de abas, como no WhatsApp).
struct HomeView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var router = Router()
    @StateObject private var conversations = ConversationsViewModel()
    @ObservedObject private var workspace = Workspace.shared
    @ObservedObject private var moduleFeature = ModuleFeature.shared
    @State private var tab: HomeTab = .conversations
    @State private var visited: Set<HomeTab> = [.conversations]

    var body: some View {
        VStack(spacing: 0) {
            // Acima da pilha de navegação: a faixa aparece em todas as telas da demonstração.
            if container.isDemo { DemoBanner { container.exitDemo() } }
            if workspace.offline { OfflineBanner().transition(.move(edge: .top).combined(with: .opacity)) }
            RootNavigation(router: router) {
                VStack(spacing: 0) {
                    ZStack {
                        ForEach(tabs) { t in
                            if visited.contains(t) {
                                root(t)
                                    .opacity(tab == t ? 1 : 0)
                                    .allowsHitTesting(tab == t)
                                    .accessibilityHidden(tab != t)
                            }
                        }
                    }
                    HomeTabBar(tab: $tab, tabs: tabs, badge: badge)
                }
                .background(Theme.background.ignoresSafeArea())
                .ignoresSafeArea(.keyboard, edges: .bottom)
                .navigationBarTitleDisplayMode(.inline)
                .appNavigationBarHidden(true)
            }
        }
        .animation(.quick, value: workspace.offline)
        .overlay { ToastOverlay(workspace: workspace, bottomPadding: 64) }
        .onChange(of: tab) { visited.insert($0) }
        .onChange(of: tabs) { _ in keepTabAllowed() }
        .onChange(of: container.pendingLink) { link in
            guard let link else { return }
            open(link)
            container.pendingLink = nil
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                workspace.activate()
                AppAppearance.apply()
            } else if phase == .background {
                workspace.deactivate()
            }
        }
        .onChange(of: container.profileId) { _ in
            router.popToRoot()
            workspace.activate()
        }
        .onAppear {
            workspace.activate()
            AppAppearance.apply()
            if let link = container.pendingLink { open(link); container.pendingLink = nil }
            #if DEBUG
            if let launch = DemoMode.consumeLaunch() {
                if let wanted = HomeTab(rawValue: launch.tab) { tab = wanted; visited.insert(wanted) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { keepTabAllowed() }
                if let route = launch.route { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { router.open(route) } }
            }
            #endif
        }
        .task {
            await container.refreshTokenIfNeeded()
            // Módulos ligados na área (fila, agenda, ordem de serviço): decidem as entradas em Ajustes e na conversa.
            await ModuleFeature.shared.refresh(container: container)
        }
    }

    /// Só o que a pessoa acessa (lista em `/capabilities`; sem lista, todas as abas).
    private var tabs: [HomeTab] { moduleFeature.access(container.profileId).tabs }

    /// A aba aberta deixou de existir (lista nova, troca de área): vai para a primeira que ficou.
    private func keepTabAllowed() {
        guard !tabs.contains(tab), let first = tabs.first else { return }
        tab = first
        visited.insert(first)
    }

    @ViewBuilder
    private func root(_ t: HomeTab) -> some View {
        switch t {
        case .conversations: ConversationsView(active: tab == t, vm: conversations)
        case .attendance: AttendanceView(active: tab == t)
        case .team: TeamView(active: tab == t)
        case .calls: CallsView(active: tab == t)
        case .settings: SettingsView(active: tab == t)
        }
    }

    /// Contador de cada aba: não lidas, protocolos atrasados (em `danger`) ou recebidos (só os ativos contam) em
    /// Atendimento, internas não lidas.
    private func badge(_ t: HomeTab) -> (count: Int, color: Color)? {
        switch t {
        case .conversations:
            let n = workspace.totalUnread
            return n > 0 ? (n, Theme.accent) : nil
        case .attendance:
            // Sem acesso aos protocolos, a aba não conta protocolos.
            guard moduleFeature.access(container.profileId).allows(AppAccess.Area.tickets) else { return nil }
            let counts = workspace.ticketCounts
            if counts.overdue > 0 { return (counts.overdue, Theme.danger) }
            return counts.open > 0 ? (counts.open, Theme.accent) : nil
        case .team:
            let n = workspace.totalInternalUnread
            return n > 0 ? (n, Theme.accent) : nil
        case .calls, .settings:
            return nil
        }
    }

    private func open(_ link: DeepLink) {
        // Aviso de algo que a pessoa não acessa (a lista mudou depois do envio): só abre o app.
        let access = moduleFeature.access(container.profileId)
        let needed = ["ticket": AppAccess.Area.tickets, "ticket_due": AppAccess.Area.tickets][link.type] ?? AppAccess.Area.conversations
        guard access.allows(needed) else { return }
        switch link.type {
        case "call":
            // O app não atende ligações: o aviso abre a conversa; sem conversa, é ignorado.
            guard let c = link.conversationId else { return }
            tab = .conversations
            router.open(.conversation(id: c))
        case "ticket", "ticket_due":
            tab = .attendance
            router.open(link.ticketId.map { .ticket(id: $0) } ?? .tickets(filter: link.type == "ticket_due" ? TicketFilter.overdue.rawValue : nil))
        default:
            tab = .conversations
            if let c = link.conversationId { router.open(.conversation(id: c)) }
        }
    }
}

/// Barra inferior com cinco abas: ícone, rótulo e contador em bolinha.
struct HomeTabBar: View {
    @Binding var tab: HomeTab
    /// As abas que a pessoa acessa (AppAccess.tabs).
    var tabs: [HomeTab] = HomeTab.allCases
    var badge: (HomeTab) -> (count: Int, color: Color)?

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs) { t in
                let selected = tab == t
                let info = badge(t)
                Button { tab = t } label: {
                    VStack(spacing: 3) {
                        Image(systemName: selected ? t.icon + ".fill" : t.icon)
                            .font(.system(size: 20, weight: .regular))
                            .frame(height: 24)
                            .overlay(alignment: .topTrailing) {
                                if let info { CountBadge(count: info.count, color: info.color).scaleEffect(0.85).offset(x: 14, y: -6) }
                            }
                        Text(t.title).font(.system(size: 10, weight: selected ? .semibold : .medium)).lineLimit(1)
                    }
                    .foregroundStyle(selected ? Theme.brand : Theme.textSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(info.map { "\(t.title), \($0.count)" } ?? t.title)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(.horizontal, 4)
        .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ThinDivider() }
    }
}
