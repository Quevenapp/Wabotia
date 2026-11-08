import SwiftUI

enum HomeTab: Hashable { case conversations, tickets, bots, calls, more }

/// Abas principais. Rotas empilhadas por aba via NavigationStack + `Route`.
struct HomeView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var tab: HomeTab = .conversations
    @State private var conversationsPath = NavigationPath()
    @State private var ticketsPath = NavigationPath()
    @State private var botsPath = NavigationPath()
    @State private var callsPath = NavigationPath()

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $conversationsPath) { ConversationsView().withRoutes() }
                .tabItem { Label("Conversas", systemImage: "bubble.left.and.bubble.right") }.tag(HomeTab.conversations)
            NavigationStack(path: $ticketsPath) { TicketsView().withRoutes() }
                .tabItem { Label("Protocolos", systemImage: "doc.text") }.tag(HomeTab.tickets)
            NavigationStack(path: $botsPath) { BotsView().withRoutes() }
                .tabItem { Label("Bots", systemImage: "cpu") }.tag(HomeTab.bots)
            NavigationStack(path: $callsPath) { CallsView().withRoutes() }
                .tabItem { Label("Ligações", systemImage: "phone") }.tag(HomeTab.calls)
            NavigationStack { SettingsView() }
                .tabItem { Label("Mais", systemImage: "ellipsis.circle") }.tag(HomeTab.more)
        }
        .onChange(of: container.pendingLink) { link in
            guard let link else { return }
            open(link)
            container.pendingLink = nil
        }
        .onAppear { if let link = container.pendingLink { open(link); container.pendingLink = nil } }
        .task { await container.refreshTokenIfNeeded() }
        .fullScreenCover(item: $container.incomingCall) { link in
            // Ligação recebida por push com o app aberto.
            if let conversation = link.conversationId {
                CallView(conversationId: conversation, callId: link.callId)
            }
        }
    }

    private func open(_ link: DeepLink) {
        switch link.type {
        case "call":
            tab = .calls
            if let c = link.conversationId { callsPath.append(Route.call(conversationId: c, callId: link.callId)) }
        case "ticket", "ticket_due":
            tab = .tickets
            if let t = link.ticketId { ticketsPath.append(Route.ticket(id: t)) }
        default:
            tab = .conversations
            if let c = link.conversationId { conversationsPath.append(Route.conversation(id: c)) }
        }
    }
}

extension DeepLink: Identifiable {
    var id: String { "\(type)-\(conversationId ?? "")-\(ticketId ?? "")-\(callId ?? "")" }
}

/// Destinos empilháveis. Mantenha sincronizado com `withRoutes()`.
enum Route: Hashable {
    case conversation(id: String)
    case ticket(id: String)
    case newTicket(conversationId: String)
    case bot(id: String, conversationId: String?)
    case call(conversationId: String, callId: String?)
}

extension View {
    func withRoutes() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .conversation(let id): ConversationView(conversationId: id)
            case .ticket(let id): TicketView(ticketId: id)
            case .newTicket(let conversationId): NewTicketView(conversationId: conversationId)
            case .bot(let id, let conversationId): BotChatView(botId: id, conversationId: conversationId)
            case .call(let conversationId, let callId): CallView(conversationId: conversationId, callId: callId)
            }
        }
    }
}
