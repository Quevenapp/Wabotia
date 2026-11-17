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
    /// `WABOTIA_DEMO_ACCESS=caixa` ou `conversations,tickets`: a lista de acessos da pessoa na demonstração
    /// (`AppAccess`), para ver a barra e as telas montadas só com ela.
    static let accessOverride: [String]? = env("WABOTIA_DEMO_ACCESS")?.split(separator: ",").map { String($0) }
    /// Modo entregador contra um servidor de verdade, sem câmera: `WABOTIA_COURIER_QR` (o link do QR) abre o modo
    /// entregador e lê o QR; `WABOTIA_COURIER_NAME` é o nome; `WABOTIA_COURIER_STEPS` (`confirm,route,chat,deliver`) faz os
    /// passos, registrando no console; `WABOTIA_COURIER_SIMULATED=1` usa a posição simulada (o pedido de permissão do
    /// sistema pede um toque).
    static let courierQR: String? = env("WABOTIA_COURIER_QR")
    static let courierName: String? = env("WABOTIA_COURIER_NAME")
    static let courierSteps: [String] = env("WABOTIA_COURIER_STEPS")?.split(separator: ",").map(String.init) ?? []
    static let courierSimulated = env("WABOTIA_COURIER_SIMULATED") == "1"
    /// Pausa entre os passos (s), para as capturas de tela pegarem cada tela.
    static let courierPause: UInt64 = UInt64(env("WABOTIA_COURIER_PAUSE").flatMap(Double.init).map { $0 * 1_000_000_000 } ?? 2_000_000_000)
    static let anchor: String? = env("WABOTIA_DEMO_ANCHOR")
    /// Ação feita sozinha no modo aparelho e no guichê, para conferir por print: `choose`, `issue`, `settings`,
    /// `printer`, `pin`, `unpair` (aparelho), `call` (guichê 2 chama a próxima), `week` (agenda) e `quote` (ordem).
    static let action: String? = env("WABOTIA_DEMO_ACTION")
    /// Modo aparelho contra um servidor de verdade (teste em aparelho, sem tocar na tela): `WABOTIA_DEVICE_SERVER` abre o
    /// modo aparelho e pede o código com `WABOTIA_DEVICE_NAME` (o código sai no console); `WABOTIA_DEVICE_ROLE`
    /// (`totem`, `panel`, `hybrid`) escolhe o papel; `WABOTIA_DEVICE_ACTION` (`issue`, `settings`, `printer`, `unpair`).
    static let deviceServer: String? = env("WABOTIA_DEVICE_SERVER")
    static let deviceName: String? = env("WABOTIA_DEVICE_NAME")
    static let deviceRole: String? = env("WABOTIA_DEVICE_ROLE")
    static let deviceAction: String? = env("WABOTIA_DEVICE_ACTION")
    /// `WABOTIA_DEVICE_PRINT=off`: o totem emite sem mandar nada à impressora escolhida (a senha fica na tela), para
    /// testar a emissão sem gastar papel nem imprimir sem o OK de quem está com a impressora.
    static let devicePrintOff = env("WABOTIA_DEVICE_PRINT")?.lowercased() == "off"

    /// `WABOTIA_LOGIN_SERVER`, `WABOTIA_LOGIN_EMAIL` e `WABOTIA_LOGIN_PASSWORD`: entra numa conta de teste sem tocar na
    /// tela, pelo mesmo login da tela Entrar (sem o pedido de permissão de notificações). A senha não é registrada.
    static var debugLogin: (server: URL, email: String, password: String)? {
        guard let s = env("WABOTIA_LOGIN_SERVER"), let server = URL(string: s), server.scheme == "https",
              let email = env("WABOTIA_LOGIN_EMAIL"), let password = ProcessInfo.processInfo.environment["WABOTIA_LOGIN_PASSWORD"], !password.isEmpty
        else { return nil }
        return (server, email, password)
    }

    /// `WABOTIA_OPEN=<tela>` (com a sessão de verdade, nada de demonstração): abre uma tela depois de entrar —
    /// `counter`, `agenda`, `os`, `reserva`, `mensalidade`, `settings`, `os:<id>` ou `appointment:<id>`.
    static let openScreen: String? = env("WABOTIA_OPEN")
    /// `WABOTIA_COUNTER=<guichê>:<passos>` (sessão de verdade): escolhe o guichê pelo número do nome ou pelo id e faz os
    /// passos, um a cada 6 s — `open`, `paused`, `closed`, `call`, `recall`, `start`, `finish`, `no-show`.
    static let counterScript: String? = env("WABOTIA_COUNTER")
    /// `WABOTIA_PEDIDO=<passos>` (sessão de verdade): passos separados por vírgula, um a cada 6 s, registrados no console.
    /// No quadro: `mode:menu|list|board`, `pause:<mensagem>`, `resume`, `off:<item>`, `on:<item>` (id ou nome do item).
    /// No pedido (`WABOTIA_OPEN=pedido:<id>`): `status:<estado>` (também um que não vale, para ver a recusa), `paid`,
    /// `method:cash|card`, `print`.
    static let pedidoScript: String? = env("WABOTIA_PEDIDO")
    /// `WABOTIA_ACTION=charge` (sessão de verdade, `WABOTIA_OPEN=installment:<id>`): reenvia a cobrança da parcela e
    /// registra o resultado no console.
    static let moduleAction: String? = env("WABOTIA_ACTION")
    /// `WABOTIA_CONVERSA=<passos>` (sessão de verdade, `WABOTIA_OPEN=conversation:<id>`): `claim`, `forms`,
    /// `form:<id>`, `charge:<pix|link>:<centavos>:<descrição>`, `resolve`, um a cada 5 s, com o resultado no console.
    static let conversationScript: String? = env("WABOTIA_CONVERSA")
    /// Consumida uma vez pela tela inicial.
    static var pendingScreen: String? = launchScreen ?? openScreen
    /// Folha a abrir sozinha na tela pedida (`transfer`, `presence`, `attach`, `actions`, `window`, `tags`…).
    static var pendingSheet: String?

    /// Sessão pronta gravada no armazenamento isolado (abertura por variável de ambiente).
    /// `server`, `login` e `profile` param nas telas de entrada.
    static func seed(_ store: SessionStore) {
        if forceDark { AppAppearance.override = .dark }
        switch launchScreen {
        case "server", "typed": return
        case "login", "login-mfa":
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
        // Sessão de verdade: telas por id (`os:<id>`, `appointment:<id>`).
        if let colon = screen.firstIndex(of: ":") {
            let kind = screen[..<colon], id = String(screen[screen.index(after: colon)...])
            launch.tab = "attendance"
            if kind == "os" { launch.route = .serviceOrder(id: id) }
            if kind == "appointment" { launch.route = .appointment(id: id) }
            if kind == "pedido" { launch.route = .pedidoOrder(id: id) }
            if kind == "subscription" { launch.route = .subscription(id: id) }
            if kind == "installment" { launch.route = .installment(id: id) }
            if kind == "conversation" { launch.tab = "conversations"; launch.route = .conversation(id: id) }
            if kind == "conversation-info" { launch.tab = "conversations"; launch.route = .conversationInfo(id: id) }
            return launch
        }
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
        case "ticket-progress": launch.tab = "attendance"; launch.route = .ticket(id: "t_troca"); launch.sheet = "do-progress"
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
        case "attendance": launch.tab = "attendance"
        case "tickets": launch.tab = "attendance"; launch.route = .tickets(filter: nil)
        case "ticket": launch.tab = "attendance"; launch.route = .ticket(id: "t_troca")
        case "ticket-answered", "ticket-waiting": launch.tab = "attendance"; launch.route = .ticket(id: "t_nota")
        case "ticket-overdue": launch.tab = "attendance"; launch.route = .ticket(id: "t_cobranca")
        case "ticket-progress-state": launch.tab = "attendance"; launch.route = .ticket(id: "t_endereco")
        case "ticket-third": launch.tab = "attendance"; launch.route = .ticket(id: "t_integracao")
        case "ticket-resolved": launch.tab = "attendance"; launch.route = .ticket(id: "t_etiqueta")
        case "ticket-closed": launch.tab = "attendance"; launch.route = .ticket(id: "t_garantia")
        case "ticket-category": launch.tab = "attendance"; launch.route = .ticket(id: "t_troca"); launch.sheet = "ticket-category"
        // Lista de protocolos já em um filtro (`tickets-all`, `tickets-waiting`, `tickets-resolved`, `tickets-overdue`).
        case "tickets-all", "tickets-waiting", "tickets-resolved", "tickets-overdue": launch.tab = "attendance"; launch.route = .tickets(filter: nil); launch.sheet = screen
        case "ticket-new": launch.route = .newTicket(conversationId: "c_rich")
        case "team": launch.tab = "team"
        case "team-people", "team-bots", "team-departments": launch.tab = "team"; launch.sheet = screen
        case "internal": launch.tab = "team"; launch.route = .internalChat(peer: TeamContact(id: "u_ana", kind: "user", name: "Ana Souza", online: true), chatId: "ic_ana")
        case "bot": launch.tab = "team"; launch.route = .bot(id: "b_vendas", conversationId: nil)
        // Ações pelo bot: a conversa interna com o bot Vendas (propostas e pedidos de aprovação) e um pedido aberto pelo aviso.
        case "bot-actions": launch.tab = "team"; launch.route = .internalChat(peer: TeamContact(id: "bot:b_vendas", kind: "bot", name: "Vendas", online: true), chatId: DemoBotActions.chatId)
        case "approval": launch.tab = "attendance"; launch.route = .approval(id: "ap_128")
        case "calls": launch.tab = "calls"
        case "settings": launch.tab = "settings"
        case "licenses": launch.tab = "settings"; launch.sheet = "licenses"
        // Segundo fator: Ajustes → Segurança e o cadastro do autenticador (código 123456).
        case "mfa": launch.tab = "settings"; launch.sheet = "mfa-enroll"
        case "lines": launch.tab = "attendance"; launch.route = .lines
        case "counter": launch.tab = "attendance"; launch.route = .counter
        // Agenda e Ordem de Serviço (WABOTIA_DEMO_ACTION=week abre a agenda na semana).
        case "agenda": launch.tab = "attendance"; launch.route = .agenda
        case "appointment": launch.tab = "attendance"; launch.route = .appointment(id: "ag_3")
        case "booking": launch.route = .newAppointment(conversationId: "c_rich", customer: "Mariana Costa")
        case "os": launch.tab = "attendance"; launch.route = .serviceOrders
        case "os-detail": launch.tab = "attendance"; launch.route = .serviceOrder(id: "os_6")
        case "os-new": launch.route = .newServiceOrder(conversationId: "c_rich", customer: "Mariana Costa")
        // Reserva e Mensalidade (WABOTIA_DEMO_ACTION=list abre a lista de reservas; subscriptions e delinquents, as abas).
        case "reserva": launch.tab = "attendance"; launch.route = .reserva
        case "reserva-booking": launch.tab = "attendance"; launch.route = .booking(id: "rs_1")
        case "booking-new": launch.route = .bookingForm(conversationId: "c_rich", customer: "Mariana Costa", unitId: nil, date: nil)
        case "mensalidade": launch.tab = "attendance"; launch.route = .mensalidade
        case "installment": launch.tab = "attendance"; launch.route = .installment(id: "mi_6")
        case "subscription": launch.tab = "attendance"; launch.route = .subscription(id: "ms_3")
        case "menus": launch.tab = "attendance"; launch.route = .menus
        // Pedido (lanchonete): WABOTIA_DEMO_ACTION=list ou menu abre a lista ou o cardápio. pedido-order: o X-Burger em duas
        // montagens; pedido-delivery: entrega paga, ligada à conversa; pedido-choosing: cliente escolhendo como pagar.
        case "pedido": launch.tab = "attendance"; launch.route = .pedido
        case "pedido-order": launch.tab = "attendance"; launch.route = .pedidoOrder(id: "pd_44")
        case "pedido-delivery": launch.tab = "attendance"; launch.route = .pedidoOrder(id: "pd_42")
        case "pedido-choosing": launch.tab = "attendance"; launch.route = .pedidoOrder(id: "pd_46")
        // Passagem para humano pelo Suporte pago: a conversa com a faixa e os dados da conversa com as ações.
        // Formulário e Cobrança na conversa da Mariana: as folhas e o cartão dos dados (WABOTIA_DEMO_ANCHOR=items).
        case "charge", "forms": launch.route = .conversation(id: "c_rich"); launch.sheet = screen
        case "items": launch.route = .conversationInfo(id: "c_rich")
        case "handoff": launch.route = .conversation(id: DemoSuporte.conversationId)
        case "handoff-info": launch.route = .conversationInfo(id: DemoSuporte.conversationId)
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
