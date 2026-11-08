import Foundation
import Combine

/// Dependências compartilhadas e estado de autenticação observável.
/// O servidor é escolhido pela pessoa na primeira tela; o cliente é recriado quando o endereço muda.
@MainActor
final class AppContainer: ObservableObject {
    static let shared = AppContainer()

    let session = SessionStore()
    @Published private(set) var isLoggedIn: Bool
    @Published private(set) var user: User?
    @Published var profileId: String? {
        didSet { session.profileId = profileId }
    }
    /// Destino pendente vindo de notificação/deep link; consumido pela HomeView.
    @Published var pendingLink: DeepLink?
    /// Ligação recebida anunciada por push enquanto o app está aberto.
    @Published var incomingCall: DeepLink?

    private var client: APIClient?

    private init() {
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
        session.clearSession(keepServer: keepServer)
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
