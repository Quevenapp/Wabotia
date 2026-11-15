import Foundation
import UIKit

/// Modo de demonstração: uma instalação Wabotia fictícia, em memória, para quem ainda não tem servidor
/// (e para a revisão das lojas). Entra pelo botão "Conhecer o app (demonstração)" da primeira tela ou
/// digitando `demo` como servidor; existe em todos os builds.
///
/// - As respostas vêm de `DemoURLProtocol`, registrado na URLSession do app: as telas e os view models
///   de produção rodam sem saber que o servidor não existe. Nada sai do aparelho: `demo.wabotia.localhost`
///   é respondido em memória (e `.localhost` nunca é um endereço da internet). O que não passa pela
///   URLSession (players de áudio e vídeo) toca uma cópia local (`DemoServer.localFile`).
/// - Na demonstração o aparelho nunca é registrado para push e o app não pede permissão de notificações.
/// - Os dados são fictícios e recomeçam a cada entrada e a cada abertura do app.
/// - Uma faixa fixa no topo (`DemoBanner`) avisa que é demonstração e leva de volta à primeira tela.
///
/// Só no build de depuração (extensão abaixo): `WABOTIA_DEMO=<tela>` no ambiente abre o app já na
/// demonstração, em uma sessão isolada, e mostra a tela pedida.
enum DemoMode {
    static let host = "demo.wabotia.localhost"
    static let serverURL = URL(string: "https://demo.wabotia.localhost")!
    static let profileId = "demo"
    static let profileName = "Empresa Exemplo"
    static let meId = "u_diego"
    static let meName = "Diego Andrade"
    /// Domínio `.example` (RFC 2606): nunca é um endereço real.
    static let meEmail = "diego@empresa.example"

    static var user: User {
        User(id: meId, name: meName, email: meEmail, role: "admin", profiles: [profileId])
    }

    static var session: MobileSession {
        MobileSession(token: "wabu_demo", expires: Int64((Date().timeIntervalSince1970 + 30 * 86400) * 1000), user: user)
    }

    static func isDemo(_ url: URL?) -> Bool { url?.host == host }

    /// O texto digitado na tela de servidor pede a demonstração?
    static func wantsDemo(_ input: String) -> Bool {
        input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "demo"
    }

    /// Entra na demonstração: dados de exemplo do zero e uma sessão local, sem push.
    @MainActor
    static func signIn(_ container: AppContainer) {
        DemoServer.reset()
        container.session.clearLocalCaches()
        container.onLoggedIn(server: serverURL, result: session)
    }

    /// Abertura do app com a demonstração aberta na última vez: os dados de exemplo recomeçam (vivem só na
    /// memória), então as prévias, as não lidas e o cursor de eventos guardados também voltam ao início.
    static func prepareRelaunch(_ store: SessionStore) {
        guard isDemo(store.serverURL) else { return }
        store.clearLocalCaches()
    }

    /// Não lidas e chips de eventos de exemplo (esse estado é local do app, não vem do servidor).
    @MainActor
    static func seedLocalState(_ workspace: Workspace) {
        guard isDemo(AppContainer.shared.session.serverURL) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func ago(_ minutes: Double) -> Int64 { now - Int64(minutes * 60_000) }
        workspace.seedDemo(
            unread: ["c_queue": 2, "c_5h": 1, "c_group": 4],
            events: [
                "c_rich": [
                    ServiceEvent(id: "seed-1", kind: "queue", text: "Conversa entrou na fila", created: ago(26 * 60 - 1.5)),
                    ServiceEvent(id: "seed-2", kind: "claim", text: "Você assumiu a conversa", created: ago(26 * 60 - 4)),
                    ServiceEvent(id: "seed-3", kind: "ticket", text: "Protocolo WA-MF3K-7Q2D aberto", created: ago(87)),
                    ServiceEvent(id: "seed-4", kind: "menu", text: "Menu enviado ao cliente", created: ago(50)),
                ],
                "c_other": [ServiceEvent(id: "seed-5", kind: "transfer", text: "Transferida para Ana Souza", created: ago(170))],
                "c_closed": [ServiceEvent(id: "seed-6", kind: "resolve", text: "Conversa concluída", created: ago(2 * 24 * 60 - 30))],
            ]
        )
    }
}

#if DEBUG
/// Atalhos de depuração para conferir telas por print, sem tocar na tela:
///
/// - `WABOTIA_DEMO=<tela>` no ambiente abre o app já na demonstração, em uma sessão isolada (não toca na
///   sessão real do aparelho), e mostra a tela pedida. `WABOTIA_DEMO_DARK=1` força a aparência escura.
///   `WABOTIA_DEMO_ANCHOR=<id>` rola a tela aberta até um ponto (ex.: id de mensagem, `bottom`).
///   As telas `claim`, `send`, `transferred` e `ticket-progress` executam a ação de verdade ao abrir
///   (assumir, responder, transferir, registrar andamento), para conferir as escritas por print.
extension DemoMode {
    static let suiteName = "br.com.queven.wabotia.demo"

    private static func env(_ name: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    /// Tela pedida por `WABOTIA_DEMO` (nil = abertura normal).
    static let launchScreen: String? = env("WABOTIA_DEMO")?.lowercased()
    static let forceDark: Bool = env("WABOTIA_DEMO_DARK") == "1"
    static let anchor: String? = env("WABOTIA_DEMO_ANCHOR")
    /// Ação feita sozinha no modo aparelho e no guichê, para conferir por print: `choose`, `issue`, `settings`,
    /// `printer`, `pin`, `unpair` (aparelho), `call` (guichê 2 chama a próxima), `week` (agenda) e `quote` (ordem).
    static let action: String? = env("WABOTIA_DEMO_ACTION")
    /// Consumida uma vez pela tela inicial.
    static var pendingScreen: String? = launchScreen
    /// Folha a abrir sozinha na tela pedida (`transfer`, `presence`, `attach`, `actions`, `window`, `tags`…).
    static var pendingSheet: String?

    /// Sessão pronta gravada no armazenamento isolado (abertura por variável de ambiente).
    /// `server`, `login` e `profile` param nas telas de entrada.
    static func seed(_ store: SessionStore) {
        if forceDark { AppAppearance.override = .dark }
        switch launchScreen {
        case "server", "typed": return
        case "login":
            store.serverURL = serverURL
            return
        default: break
        }
        store.serverURL = serverURL
        store.token = session.token
        store.tokenExpires = Date().addingTimeInterval(30 * 86400)
        store.user = user
        if launchScreen == "profile" {
            DemoServer.shared.extraProfile = true
        } else {
            store.profileId = profileId
        }
        if launchScreen == "offline" { DemoServer.shared.simulateOffline = true }
    }

    /// Destino da tela pedida: aba, rota empilhada e folha.
    struct Launch {
        var tab: String = "conversations"
        var route: Route?
        var sheet: String?
    }

    static func consumeLaunch() -> Launch? {
        guard let screen = pendingScreen else { return nil }
        pendingScreen = nil
        var launch = Launch()
        switch screen {
        case "conversations", "offline": break
        case "presence": launch.sheet = "presence"
        case "search": launch.sheet = "search"
        case "queue": launch.sheet = "filter-queue"
        case "empty": launch.sheet = "filter-empty"
        case "chat": launch.route = .conversation(id: "c_rich")
        case "nested": launch.route = .conversation(id: "c_rich"); launch.sheet = "push-info"
        case "chat-queue": launch.route = .conversation(id: "c_queue")
        // Ações de verdade disparadas sozinhas, para conferir as escritas sem tocar na tela.
        case "claim": launch.route = .conversation(id: "c_queue"); launch.sheet = "do-claim"
        case "send": launch.route = .conversation(id: "c_rich"); launch.sheet = "do-send"
        case "transferred": launch.route = .conversation(id: "c_rich"); launch.sheet = "do-transfer"
        case "ticket-progress": launch.tab = "tickets"; launch.route = .ticket(id: "t_troca"); launch.sheet = "do-progress"
        case "chat-bot": launch.route = .conversation(id: "c_bot")
        case "chat-other": launch.route = .conversation(id: "c_other")
        case "chat-closed": launch.route = .conversation(id: "c_closed")
        case "chat-group": launch.route = .conversation(id: "c_group")
        case "chat-window": launch.route = .conversation(id: "c_closedwin")
        case "chat-40": launch.route = .conversation(id: "c_40")
        case "transfer", "transfer-bots", "transfer-departments", "transfer-menu", "transfer-ticket", "transfer-confirm",
             "attach", "actions", "window", "tags", "note", "reply", "recording":
            launch.route = .conversation(id: "c_rich")
            launch.sheet = screen
        case "info": launch.route = .conversationInfo(id: "c_rich")
        case "info-group": launch.route = .conversationInfo(id: "c_group")
        case "tickets": launch.tab = "tickets"
        case "ticket": launch.tab = "tickets"; launch.route = .ticket(id: "t_troca")
        case "ticket-answered", "ticket-waiting": launch.tab = "tickets"; launch.route = .ticket(id: "t_nota")
        case "ticket-overdue": launch.tab = "tickets"; launch.route = .ticket(id: "t_cobranca")
        case "ticket-progress-state": launch.tab = "tickets"; launch.route = .ticket(id: "t_endereco")
        case "ticket-third": launch.tab = "tickets"; launch.route = .ticket(id: "t_integracao")
        case "ticket-resolved": launch.tab = "tickets"; launch.route = .ticket(id: "t_etiqueta")
        case "ticket-closed": launch.tab = "tickets"; launch.route = .ticket(id: "t_garantia")
        case "ticket-category": launch.tab = "tickets"; launch.route = .ticket(id: "t_troca"); launch.sheet = "ticket-category"
        // Lista de protocolos já em um filtro (`tickets-all`, `tickets-waiting`, `tickets-resolved`, `tickets-overdue`).
        case "tickets-all", "tickets-waiting", "tickets-resolved", "tickets-overdue": launch.tab = "tickets"; launch.sheet = screen
        case "ticket-new": launch.route = .newTicket(conversationId: "c_rich")
        case "team": launch.tab = "team"
        case "team-people", "team-bots", "team-departments": launch.tab = "team"; launch.sheet = screen
        case "internal": launch.tab = "team"; launch.route = .internalChat(peer: TeamContact(id: "u_ana", kind: "user", name: "Ana Souza", online: true), chatId: "ic_ana")
        case "bot": launch.tab = "team"; launch.route = .bot(id: "b_vendas", conversationId: nil)
        case "calls": launch.tab = "calls"
        case "settings": launch.tab = "settings"
        case "lines": launch.tab = "settings"; launch.route = .lines
        case "counter": launch.tab = "settings"; launch.route = .counter
        // Agenda e Ordem de Serviço (WABOTIA_DEMO_ACTION=week abre a agenda na semana).
        case "agenda": launch.tab = "settings"; launch.route = .agenda
        case "appointment": launch.tab = "settings"; launch.route = .appointment(id: "ag_3")
        case "booking": launch.route = .newAppointment(conversationId: "c_rich", customer: "Mariana Costa")
        case "os": launch.tab = "settings"; launch.route = .serviceOrders
        case "os-detail": launch.tab = "settings"; launch.route = .serviceOrder(id: "os_6")
        case "os-new": launch.route = .newServiceOrder(conversationId: "c_rich", customer: "Mariana Costa")
        // Reserva e Mensalidade (WABOTIA_DEMO_ACTION=list abre a lista de reservas; subscriptions e delinquents, as abas).
        case "reserva": launch.tab = "settings"; launch.route = .reserva
        case "reserva-booking": launch.tab = "settings"; launch.route = .booking(id: "rs_1")
        case "booking-new": launch.route = .bookingForm(conversationId: "c_rich", customer: "Mariana Costa", unitId: nil, date: nil)
        case "mensalidade": launch.tab = "settings"; launch.route = .mensalidade
        case "installment": launch.tab = "settings"; launch.route = .installment(id: "mi_6")
        case "subscription": launch.tab = "settings"; launch.route = .subscription(id: "ms_3")
        case "menus": launch.tab = "settings"; launch.route = .menus
        default: break
        }
        pendingSheet = launch.sheet
        return launch
    }

    /// Lê (e limpa) a folha pedida, se for uma das esperadas pela tela.
    static func takeSheet(_ names: String...) -> String? {
        guard let sheet = pendingSheet, names.contains(sheet) else { return nil }
        pendingSheet = nil
        return sheet
    }
}
#endif
