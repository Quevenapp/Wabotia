#if DEBUG
import Foundation
import UIKit

/// Modo de demonstração (somente em compilações Debug).
///
/// - Digitar `demo` como endereço do servidor entra direto em um servidor em memória.
/// - `WABOTIA_DEMO=<tela>` no ambiente abre o app já na demonstração, em uma sessão isolada (não toca na
///   sessão real do aparelho), e mostra a tela pedida. `WABOTIA_DEMO_DARK=1` força a aparência escura.
///   `WABOTIA_DEMO_ANCHOR=<id>` rola a tela aberta até um ponto (ex.: id de mensagem, `bottom`).
///   As telas `claim`, `send`, `transferred` e `ticket-progress` executam a ação de verdade ao abrir
///   (assumir, responder, transferir, registrar andamento), para conferir as escritas por print.
///
/// As respostas vêm de `DemoURLProtocol`, registrado na URLSession do app: as telas e os view models
/// de produção rodam sem saber que o servidor não existe.
enum DemoMode {
    static let host = "demo.wabotia.localhost"
    static let serverURL = URL(string: "https://demo.wabotia.localhost")!
    static let suiteName = "br.com.queven.wabotia.demo"
    static let profileId = "demo"
    static let meId = "u_bruno"

    private static func env(_ name: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    /// Tela pedida por `WABOTIA_DEMO` (nil = abertura normal).
    static let launchScreen: String? = env("WABOTIA_DEMO")?.lowercased()
    static let forceDark: Bool = env("WABOTIA_DEMO_DARK") == "1"
    static let anchor: String? = env("WABOTIA_DEMO_ANCHOR")
    /// Consumida uma vez pela tela inicial.
    static var pendingScreen: String? = launchScreen
    /// Folha a abrir sozinha na tela pedida (`transfer`, `presence`, `attach`, `actions`, `window`, `tags`…).
    static var pendingSheet: String?

    static var user: User {
        User(id: meId, name: "Bruno Martins", email: "bruno@demo.wabotia", role: "admin", profiles: [profileId])
    }

    static var session: MobileSession {
        MobileSession(token: "wabu_demo", expires: Int64((Date().timeIntervalSince1970 + 30 * 86400) * 1000), user: user)
    }

    static func isDemo(_ url: URL?) -> Bool { url?.host == host }

    /// O texto digitado na tela de servidor pede a demonstração?
    static func wantsDemo(_ input: String) -> Bool {
        input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "demo"
    }

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

    /// Entrada direta ao digitar `demo` na tela de servidor.
    @MainActor
    static func signIn(_ container: AppContainer) {
        container.onLoggedIn(server: serverURL, result: session)
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
