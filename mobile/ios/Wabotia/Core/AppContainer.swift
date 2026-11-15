import Foundation
import Combine
import UIKit

/// Endereços públicos fixos do app.
enum AppLinks {
    /// Política de privacidade (Ajustes e primeira tela).
    static let privacyPolicy = URL(string: "https://wabotia.queven.app/privacidade")!
}

/// Dependências compartilhadas e estado de autenticação observável.
/// O servidor é escolhido pela pessoa na primeira tela; o cliente é recriado quando o endereço muda.
@MainActor
final class AppContainer: ObservableObject {
    static let shared = AppContainer()

    let session: SessionStore
    @Published private(set) var isLoggedIn: Bool
    @Published private(set) var user: User?
    @Published var profileId: String? {
        didSet { session.profileId = profileId }
    }
    /// Destino pendente vindo de notificação/deep link; consumido pela HomeView.
    @Published var pendingLink: DeepLink?
    /// Modo aparelho aberto (totem, painel de chamadas, híbrido): ocupa o app inteiro, fora do login.
    @Published var deviceLaunch: DeviceLaunch?
    /// Na tela depois do servidor, a pessoa escolheu "Entrar" (e não o modo aparelho).
    @Published var loginChosen = false

    private var client: APIClient?

    private init() {
        // Antes de ler qualquer credencial: o Keychain de uma instalação anterior não vale para esta.
        SessionStore.resetKeychainAfterReinstall()
        #if DEBUG
        // Demonstração aberta por WABOTIA_DEMO=<tela>: sessão isolada, em nada parecida com a real.
        if DemoMode.launchScreen != nil {
            session = SessionStore(isolatedSuite: DemoMode.suiteName)
            DemoMode.seed(session)
        } else {
            // Abertura normal: não sobra nada da última demonstração aberta por variável de ambiente.
            UserDefaults.standard.removePersistentDomain(forName: DemoMode.suiteName)
            session = SessionStore()
        }
        #else
        session = SessionStore()
        #endif
        // Demonstração aberta na última vez: os dados de exemplo recomeçam, então o estado local também.
        DemoMode.prepareRelaunch(session)
        isLoggedIn = session.token != nil && session.user != nil && session.serverURL != nil
        user = session.user
        profileId = session.profileId
        loginChosen = isLoggedIn
        // Aparelho pareado (totem ou painel): abre direto na tela dele, como um quiosque que reinicia sozinho.
        var debugLaunch = false
        #if DEBUG
        debugLaunch = DemoMode.launchScreen != nil
        if DemoMode.launchScreen == "login" { loginChosen = true }
        // WABOTIA_DEMO=device | device-totem | device-panel | device-hybrid: o modo aparelho da demonstração.
        if let screen = DemoMode.launchScreen, screen.hasPrefix("device") {
            deviceLaunch = DeviceLaunch(demo: true, serverURL: DemoMode.serverURL.absoluteString, role: DeviceRole(rawValue: String(screen.dropFirst("device-".count))))
        }
        #endif
        if !debugLaunch, KeychainDeviceConfigStore().load() != nil {
            deviceLaunch = DeviceLaunch(demo: false, serverURL: nil)
        }
        #if DEBUG
        // WABOTIA_DEVICE_SERVER (só depuração): o modo aparelho contra esse servidor, para parear sem tocar na tela.
        if deviceLaunch == nil, let server = DemoMode.deviceServer {
            deviceLaunch = DeviceLaunch(demo: false, serverURL: server)
        }
        // WABOTIA_LOGIN_* (só depuração): entra na conta de teste sem tocar na tela, se ainda não houver sessão.
        if deviceLaunch == nil, !isLoggedIn, let login = DemoMode.debugLogin {
            Task { await debugLogin(login) }
        }
        #endif
    }

    #if DEBUG
    /// O mesmo login da tela Entrar, sem o pedido de permissão de notificações (diálogo do sistema). Nada da senha vai ao console.
    private func debugLogin(_ login: (server: URL, email: String, password: String)) async {
        do {
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
            let device = DeviceInfo(name: String(UIDevice.current.name.prefix(80)), app_version: version)
            let result = try await client(for: login.server).mobileLogin(MobileLoginRequest(email: login.email.lowercased(), password: login.password, device: device))
            session.serverURL = login.server
            loginChosen = true
            onLoggedIn(server: login.server, result: result)
            print("[Wabotia] login de depuração: entrou em \(login.server.host ?? "") com \(result.user.profiles.count) área(s)")
        } catch {
            print("[Wabotia] login de depuração falhou: \(APIError.describe(error))")
        }
    }
    #endif

    /// "Usar este aparelho como painel ou totem", com o servidor já informado.
    func openDeviceMode() {
        deviceLaunch = DeviceLaunch(demo: false, serverURL: session.serverURL?.absoluteString)
    }

    /// O modo aparelho contra a demonstração: nada é guardado e nada sai do aparelho.
    func openDemoDeviceMode(role: DeviceRole? = nil) {
        deviceLaunch = DeviceLaunch(demo: true, serverURL: DemoMode.serverURL.absoluteString, role: role)
    }

    func closeDeviceMode() {
        deviceLaunch = nil
    }

    /// Sessão atual é a demonstração (servidor fictício em memória).
    var isDemo: Bool { DemoMode.isDemo(session.serverURL) }

    /// Cliente para o servidor configurado. Falha se não houver servidor.
    var api: APIClient {
        guard let url = session.serverURL else { preconditionFailure("Servidor não configurado") }
        return client(for: url)
    }

    func client(for url: URL) -> APIClient {
        if let c = client, c.baseURL == url { return c }
        // O token só vai para a origem que o emitiu: a tela Servidor testa um endereço novo sem levar o de outro.
        let c = APIClient(baseURL: url) { [weak self] in self?.session.token(for: url) }
        client = c
        return c
    }

    func onLoggedIn(server: URL, result: MobileSession) {
        session.serverURL = server
        session.token = result.token
        session.tokenExpires = Date(timeIntervalSince1970: Double(result.expires) / 1000)
        session.user = result.user
        user = result.user
        if result.user.profiles.count == 1 { profileId = result.user.profiles[0] } else { profileId = session.profileId }
        client = nil
        isLoggedIn = true
        // A demonstração não tem servidor: nada de token de push nem de registro do aparelho.
        if !DemoMode.isDemo(server) { PushManager.shared.registerIfNeeded(force: true) }
    }

    /// Sai da demonstração e volta à primeira tela (não há servidor a avisar nem aparelho registrado).
    func exitDemo() {
        guard isDemo else { return }
        onLoggedOut(keepServer: false)
    }

    func onLoggedOut(keepServer: Bool) {
        // O endereço da demonstração nunca fica guardado: sair dela (ou um 401) volta à primeira tela.
        let keepServer = keepServer && !isDemo
        // Para os laços antes de limpar, para nenhum deles regravar caches depois da saída.
        Workspace.shared.reset()
        ModuleFeature.shared.clear()
        session.clearSession(keepServer: keepServer)
        // Anexos em memória (os arquivos em disco já foram removidos por `clearSession`).
        Task { await MediaLoader.shared.clear() }
        client = nil
        user = nil
        profileId = nil
        isLoggedIn = false
        if !keepServer { loginChosen = false }
    }

    /// Renova o token quando faltam menos de 7 dias.
    func refreshTokenIfNeeded() async {
        guard isLoggedIn, let expires = session.tokenExpires, expires.timeIntervalSinceNow < 7 * 86400 else { return }
        if let result = try? await api.refresh() {
            session.token = result.token
            session.tokenExpires = Date(timeIntervalSince1970: Double(result.expires) / 1000)
        }
    }

    func handle(deepLink: DeepLink?) {
        // Avisos são de servidores reais; na demonstração não há o que abrir.
        guard let deepLink, !isDemo else { return }
        if let p = deepLink.profileId, p != profileId, let u = user, u.isAdmin || u.profiles.contains(p) { profileId = p }
        pendingLink = deepLink
    }

    /// Sessão rejeitada pelo servidor (401): volta ao login mantendo o servidor.
    func handleUnauthorized() {
        onLoggedOut(keepServer: true)
    }
}
