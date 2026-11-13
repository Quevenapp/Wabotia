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
        isLoggedIn = session.token != nil && session.user != nil && session.serverURL != nil
        user = session.user
        profileId = session.profileId
    }

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
        PushManager.shared.registerIfNeeded(force: true)
    }

    func onLoggedOut(keepServer: Bool) {
        // Para os laços antes de limpar, para nenhum deles regravar caches depois da saída.
        Workspace.shared.reset()
        session.clearSession(keepServer: keepServer)
        // Anexos em memória (os arquivos em disco já foram removidos por `clearSession`).
        Task { await MediaLoader.shared.clear() }
        client = nil
        user = nil
        profileId = nil
        isLoggedIn = false
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
        guard let deepLink else { return }
        if let p = deepLink.profileId, p != profileId, let u = user, u.isAdmin || u.profiles.contains(p) { profileId = p }
        pendingLink = deepLink
    }

    /// Sessão rejeitada pelo servidor (401): volta ao login mantendo o servidor.
    func handleUnauthorized() {
        onLoggedOut(keepServer: true)
    }
}
