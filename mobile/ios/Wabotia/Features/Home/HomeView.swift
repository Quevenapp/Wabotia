import SwiftUI

enum HomeTab: String, CaseIterable, Identifiable {
    case conversations, tickets, team, calls, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .conversations: return "Conversas"
        case .tickets: return "Protocolos"
        case .team: return "Equipe"
        case .calls: return "Ligações"
        case .settings: return "Ajustes"
        }
    }
    var icon: String {
        switch self {
        case .conversations: return "bubble.left.and.bubble.right"
        case .tickets: return "doc.text"
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
    @State private var tab: HomeTab = .conversations
    @State private var visited: Set<HomeTab> = [.conversations]

    var body: some View {
        VStack(spacing: 0) {
            if workspace.offline { OfflineBanner().transition(.move(edge: .top).combined(with: .opacity)) }
            RootNavigation(router: router) {
                VStack(spacing: 0) {
                    ZStack {
                        ForEach(HomeTab.allCases) { t in
                            if visited.contains(t) {
                                root(t)
                                    .opacity(tab == t ? 1 : 0)
                                    .allowsHitTesting(tab == t)
                                    .accessibilityHidden(tab != t)
                            }
                        }
                    }
                    HomeTabBar(tab: $tab, badge: badge)
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
                if let route = launch.route { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { router.open(route) } }
            }
            #endif
        }
        .task { await container.refreshTokenIfNeeded() }
        .fullScreenCover(item: $container.incomingCall) { link in
            // Ligação recebida por push com o app aberto.
            if let conversation = link.conversationId {
                CallView(conversationId: conversation, callId: link.callId)
            }
        }
    }

    @ViewBuilder
    private func root(_ t: HomeTab) -> some View {
        switch t {
        case .conversations: ConversationsView(active: tab == t, vm: conversations)
        case .tickets: TicketsView(active: tab == t)
        case .team: TeamView(active: tab == t)
        case .calls: CallsView(active: tab == t)
        case .settings: SettingsView(active: tab == t)
        }
    }

    /// Contador de cada aba: não lidas, protocolos atrasados (em `danger`) ou recebidos (só os ativos contam), internas não lidas, ligações tocando.
    private func badge(_ t: HomeTab) -> (count: Int, color: Color)? {
        switch t {
        case .conversations:
            let n = workspace.totalUnread
            return n > 0 ? (n, Theme.accent) : nil
        case .tickets:
            let counts = workspace.ticketCounts
            if counts.overdue > 0 { return (counts.overdue, Theme.danger) }
            return counts.open > 0 ? (counts.open, Theme.accent) : nil
        case .team:
            let n = workspace.totalInternalUnread
            return n > 0 ? (n, Theme.accent) : nil
        case .calls:
            let n = workspace.ringing.count
            return n > 0 ? (n, Theme.accent) : nil
        case .settings:
            return nil
        }
    }

    private func open(_ link: DeepLink) {
        switch link.type {
        case "call":
            tab = .calls
            if let c = link.conversationId { router.open(.call(conversationId: c, callId: link.callId)) }
        case "ticket", "ticket_due":
            tab = .tickets
            if let t = link.ticketId { router.open(.ticket(id: t)) }
        default:
            tab = .conversations
            if let c = link.conversationId { router.open(.conversation(id: c)) }
        }
    }
}

/// Barra inferior com cinco abas: ícone, rótulo e contador em bolinha.
struct HomeTabBar: View {
    @Binding var tab: HomeTab
    var badge: (HomeTab) -> (count: Int, color: Color)?

    var body: some View {
        HStack(spacing: 0) {
            ForEach(HomeTab.allCases) { t in
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
