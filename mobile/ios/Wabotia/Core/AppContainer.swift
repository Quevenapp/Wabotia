import Foundation
import Combine

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
        #endif
        if !debugLaunch, KeychainDeviceConfigStore().load() != nil {
            deviceLaunch = DeviceLaunch(demo: false, serverURL: nil)
        }
    }

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
        let c = APIClient(baseURL: url) { [weak self] in self?.session.token }
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
