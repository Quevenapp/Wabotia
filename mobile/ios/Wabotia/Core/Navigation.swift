import SwiftUI

/// Destinos empilháveis. Mantenha sincronizado com `RouteDestination`.
enum Route: Hashable {
    case conversation(id: String)
    case conversationInfo(id: String)
    case ticket(id: String)
    case newTicket(conversationId: String)
    case bot(id: String, conversationId: String?)
    case call(conversationId: String, callId: String?)
    case internalChat(peer: TeamContact, chatId: String?)
    case lines
    case menus
    case botLines
}

/// Uma única pilha de navegação para o app inteiro: as abas ficam na raiz e toda tela empilhada cobre a
/// barra de abas, como no WhatsApp. iOS 16+ usa `NavigationStack(path:)`; o iOS 15 usa `NavigationView`
/// com um `NavigationLink` escondido por nível (`LegacyPusher`).
@MainActor
final class Router: ObservableObject {
    @Published var path: [Route] = []
    /// iOS 15: destino empilhado a partir da raiz. O destino é mantido ao voltar, para a tela não
    /// ficar em branco durante a animação.
    @Published var rootRoute: Route?
    @Published var rootActive = false

    func push(_ route: Route) {
        if #available(iOS 16, *) {
            path.append(route)
        } else {
            rootRoute = route
            rootActive = true
        }
    }

    /// Volta à raiz e abre o destino (notificações e deep links).
    func open(_ route: Route) {
        if #available(iOS 16, *) {
            path = [route]
        } else if !rootActive {
            push(route)
        } else {
            rootActive = false
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 500_000_000)
                self.push(route)
            }
        }
    }

    func popToRoot() {
        path = []
        rootActive = false
    }
}

/// Ação de empilhar disponível no ambiente: `@Environment(\.pushRoute) var push` … `push(.ticket(id: x))`.
struct PushRouteAction {
    let handler: (Route) -> Void
    func callAsFunction(_ route: Route) { handler(route) }
}

private struct PushRouteKey: EnvironmentKey {
    static let defaultValue = PushRouteAction { _ in }
}

extension EnvironmentValues {
    var pushRoute: PushRouteAction {
        get { self[PushRouteKey.self] }
        set { self[PushRouteKey.self] = newValue }
    }
}

/// Raiz da pilha de navegação.
struct RootNavigation<Content: View>: View {
    @ObservedObject var router: Router
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 16, *) {
            NavigationStack(path: $router.path) {
                content()
                    .environment(\.pushRoute, PushRouteAction { router.push($0) })
                    .navigationDestination(for: Route.self) { route in
                        RouteDestination(route: route)
                            .environment(\.pushRoute, PushRouteAction { router.push($0) })
                    }
            }
        } else {
            NavigationView {
                content()
                    .environment(\.pushRoute, PushRouteAction { router.push($0) })
                    .background(
                        NavigationLink(isActive: $router.rootActive) {
                            if let route = router.rootRoute { LegacyPusher { RouteDestination(route: route) } }
                        } label: { EmptyView() }
                        .hidden()
                    )
            }
            .navigationViewStyle(.stack)
        }
    }
}

/// iOS 15: cada tela empilhada carrega o próprio `NavigationLink` escondido para o próximo nível.
struct LegacyPusher<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @State private var next: Route?
    @State private var active = false

    var body: some View {
        content()
            .environment(\.pushRoute, PushRouteAction { next = $0; active = true })
            .background(
                NavigationLink(isActive: $active) {
                    if let next { LegacyPusher<RouteDestination> { RouteDestination(route: next) } }
                } label: { EmptyView() }
                .hidden()
            )
    }
}

struct RouteDestination: View {
    let route: Route
    var body: some View {
        Group {
            switch route {
            case .conversation(let id): ConversationView(conversationId: id)
            case .conversationInfo(let id): ConversationInfoView(conversationId: id)
            case .ticket(let id): TicketView(ticketId: id)
            case .newTicket(let id): NewTicketView(conversationId: id)
            case .bot(let id, let conversation): BotChatView(botId: id, conversationId: conversation)
            case .call(let conversation, let call): CallView(conversationId: conversation, callId: call)
            case .internalChat(let peer, let chatId): InternalChatView(peer: peer, existingId: chatId)
            case .lines: LinesView()
            case .menus: MenusView()
            case .botLines: BotLinesView()
            }
        }
        .id(route)
    }
}

extension DeepLink: Identifiable {
    var id: String { "\(type)-\(conversationId ?? "")-\(ticketId ?? "")-\(callId ?? "")" }
}
