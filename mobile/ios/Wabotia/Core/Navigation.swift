import SwiftUI

/// Destinos empilháveis. Mantenha sincronizado com `RouteDestination`.
enum Route: Hashable {
    /// Ajustes (conta, notificações, aparência, servidor, aparelho, sair): pela engrenagem no topo das abas.
    case settings
    case conversation(id: String)
    case conversationInfo(id: String)
    case ticket(id: String)
    case newTicket(conversationId: String)
    case bot(id: String, conversationId: String?)
    case internalChat(peer: TeamContact, chatId: String?)
    case lines
    case menus
    case botLines
    /// Guichê da fila de senhas (só quando o servidor oferece a fila).
    case counter
    /// Agenda (módulo `agenda`).
    case agenda
    case appointment(id: String)
    case newAppointment(conversationId: String?, customer: String?)
    /// Ordem de Serviço (módulo `os`).
    case serviceOrders
    case serviceOrder(id: String)
    case newServiceOrder(conversationId: String?, customer: String?)
    /// Reserva e check-in (módulo `reserva`).
    case reserva
    case booking(id: String)
    case bookingForm(conversationId: String?, customer: String?, unitId: String?, date: String?)
    /// Mensalidade (módulo `mensalidade`).
    case mensalidade
    case installment(id: String)
    case subscription(id: String)
    /// Pedido (módulo `pedido`): quadro da cozinha, lista e cardápio.
    case pedido
    case pedidoOrder(id: String)
    /// O básico do atendimento (aba Atendimento): caixa simples, clientes, mesas, entregas, equipamentos e o assistente
    /// (a conversa interna com o bot, onde se consulta o ERP). O ERP em si fica no navegador.
    case caixa
    case clientes
    /// `nil`: cliente novo.
    case cliente(id: String?)
    case mesas
    case entrega
    case equipamentos
    case assistente
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

/// Abre os Ajustes. A tela inicial com as abas fornece; com ele, todo `ScreenHeader` mostra a engrenagem depois das
/// próprias ações. Fora das abas (Ajustes empilhado) fica `nil`.
struct OpenSettingsAction {
    let handler: () -> Void
    func callAsFunction() { handler() }
}

private struct OpenSettingsKey: EnvironmentKey {
    static let defaultValue: OpenSettingsAction? = nil
}

extension EnvironmentValues {
    var openSettings: OpenSettingsAction? {
        get { self[OpenSettingsKey.self] }
        set { self[OpenSettingsKey.self] = newValue }
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
            case .settings: SettingsView(active: true)
            case .conversation(let id): ConversationView(conversationId: id)
            case .conversationInfo(let id): ConversationInfoView(conversationId: id)
            case .ticket(let id): TicketView(ticketId: id)
            case .newTicket(let id): NewTicketView(conversationId: id)
            case .bot(let id, let conversation): BotChatView(botId: id, conversationId: conversation)
            case .internalChat(let peer, let chatId): InternalChatView(peer: peer, existingId: chatId)
            case .lines: LinesView()
            case .menus: MenusView()
            case .botLines: BotLinesView()
            case .counter: CounterView()
            case .agenda: AgendaView()
            case .appointment(let id): AppointmentDetailView(id: id)
            case .newAppointment(let conversation, let customer): BookingView(purpose: .new(conversationId: conversation, customer: customer))
            // Ordem de serviço por modelo; servidor sem modelos e ordens do modelo simples caem nas telas antigas.
            case .serviceOrders: WorkOrdersView()
            case .serviceOrder(let id): WorkOrderDetailView(id: id)
            case .newServiceOrder(let conversation, let customer): NewWorkOrderView(conversationId: conversation, customer: customer)
            case .reserva: ReservaView()
            case .booking(let id): BookingDetailView(id: id)
            case let .bookingForm(conversation, customer, unit, date): BookingFormView(purpose: .new(conversationId: conversation, customer: customer, unitId: unit, date: date))
            case .mensalidade: MensalidadeView()
            case .installment(let id): InstallmentDetailView(id: id)
            case .subscription(let id): SubscriptionDetailView(id: id)
            case .pedido: PedidoView()
            case .pedidoOrder(let id): PedidoOrderView(id: id)
            case .caixa: CaixaView()
            case .clientes: ClientesView()
            case .cliente(let id): ClienteFormView(id: id)
            case .mesas: MesasView()
            case .entrega: EntregaView()
            case .equipamentos: EquipmentView()
            case .assistente: AssistantView()
            }
        }
        .id(route)
    }
}

extension DeepLink: Identifiable {
    var id: String { "\(type)-\(conversationId ?? "")-\(ticketId ?? "")-\(callId ?? "")" }
}
