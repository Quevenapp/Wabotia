import Foundation
import Combine
import UIKit
import UserNotifications

/// Estado da aba Mais: presença da equipe, perfil, notificações, dispositivo, servidor e saída.
/// Cada bloco carrega de forma independente; falhas são exibidas no próprio bloco, sem derrubar a tela.
@MainActor
final class SettingsViewModel: ObservableObject {
    // MARK: Disponibilidade
    @Published var team: [PresenceEntry] = []
    @Published var present = false
    @Published var presenceBusy = false
    @Published var presenceLoading = false
    @Published var presenceError: String?

    // MARK: Perfil
    @Published var profiles: [Profile] = []
    @Published var profilesError: String?

    // MARK: Notificações
    @Published var notificationsEnabled = true
    @Published var notificationsBusy = false
    @Published var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published var testBusy = false

    // MARK: Dispositivo
    @Published var pushRegistered = false
    @Published var hasPushToken = false
    @Published var registering = false
    /// Registro visto pelo servidor (GET /api/v1/devices), quando disponível.
    @Published var serverDeviceEnabled: Bool?
    @Published var serverDeviceLastError: String?

    // MARK: Servidor
    @Published var serverVersion: String?
    @Published var serverError: String?

    // MARK: Sair
    @Published var loggingOut = false
    /// Falha ao avisar o servidor na saída; oferece repetir (mesma chave) ou sair mesmo assim.
    @Published var logoutFailure: String?

    /// Mensagem genérica (alerta).
    @Published var alertMessage: String?

    private var loadTask: Task<Void, Never>?
    private var presenceKey: String?
    private var pendingPresence: Bool?
    private var testKey: String?
    private var logoutKey: String?
    private var logoutKeepServer = true

    init() {}

    private var container: AppContainer { AppContainer.shared }
    private var session: SessionStore { container.session }
    var profileId: String? { container.profileId }
    var userId: String? { container.user?.id }
    var userName: String { container.user?.name ?? "" }
    var userEmail: String { container.user?.email ?? "" }
    var isAdmin: Bool { container.user?.isAdmin ?? false }

    var deviceId: String { session.deviceId }
    var deviceName: String { UIDevice.current.name }
    var systemVersion: String { "iOS \(UIDevice.current.systemVersion)" }
    var appVersion: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return build.isEmpty ? short : "\(short) (\(build))"
    }
    var serverURL: URL? { session.serverURL }
    var serverHost: String { serverURL?.host ?? "" }
    var panelURL: URL? { serverURL?.appendingPathComponent("app") }
    var currentProfileName: String {
        guard let id = profileId else { return "—" }
        return profiles.first { $0.id == id }?.name ?? id
    }

    // MARK: - Carga

    /// Carrega tudo em paralelo. Cancela uma carga anterior ainda em andamento.
    func load() async {
        loadTask?.cancel()
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            self.syncLocalState()
            async let a: Void = self.loadPresence()
            async let b: Void = self.loadProfiles()
            async let c: Void = self.loadHealth()
            async let d: Void = self.loadServerDevice()
            async let e: Void = self.refreshNotificationStatus()
            _ = await (a, b, c, d, e)
        }
        loadTask = task
        await task.value
    }

    func cancel() {
        loadTask?.cancel()
        loadTask = nil
    }

    /// Reflete o que está guardado no aparelho (sem rede).
    func syncLocalState() {
        notificationsEnabled = session.notificationsEnabled
        pushRegistered = session.registeredPushToken != nil
        hasPushToken = session.pushToken != nil
    }

    func loadPresence() async {
        guard let p = profileId else { team = []; return }
        presenceLoading = true
        defer { presenceLoading = false }
        do {
            let list = try await container.api.presence(p)
            guard !Task.isCancelled else { return }
            applyTeam(list)
            presenceError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            if unauthorized(error) { return }
            presenceError = APIError.describe(error)
        }
    }

    private func applyTeam(_ list: [PresenceEntry]) {
        let me = userId
        team = list.sorted { l, r in
            let lp = (l.present ?? 0) == 1, rp = (r.present ?? 0) == 1
            if lp != rp { return lp }
            if (l.actor == me) != (r.actor == me) { return l.actor == me }
            return l.name.localizedCaseInsensitiveCompare(r.name) == .orderedAscending
        }
        if pendingPresence == nil, let mine = list.first(where: { $0.actor == me }) {
            present = (mine.present ?? 0) == 1
        }
    }

    func loadProfiles() async {
        do {
            let list = try await container.api.profiles()
            guard !Task.isCancelled else { return }
            profiles = list
            profilesError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            if unauthorized(error) { return }
            profilesError = APIError.describe(error)
        }
    }

    func loadHealth() async {
        guard let url = serverURL else { return }
        do {
            let health = try await container.client(for: url).health()
            guard !Task.isCancelled else { return }
            var version = health.version.isEmpty ? "desconhecida" : health.version
            if let commit = health.commit, !commit.isEmpty, commit != "development", commit != health.version {
                version += " (\(commit.prefix(7)))"
            }
            serverVersion = version
            serverError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            serverError = APIError.describe(error)
        }
    }

    /// GET /api/v1/devices devolve `{data:[Device]}` (profiles já como lista).
    func loadServerDevice() async {
        do {
            let rows = try await container.api.devices()
            guard !Task.isCancelled else { return }
            let id = deviceId
            if let mine = rows.first(where: { $0.id == id }) {
                serverDeviceEnabled = (mine.enabled ?? 1) == 1
                let err = mine.last_error
                serverDeviceLastError = (err?.isEmpty ?? true) ? nil : err
            } else {
                serverDeviceEnabled = nil
                serverDeviceLastError = nil
                // O servidor não conhece mais este aparelho: o registro local está defasado.
                if session.registeredPushToken != nil { session.registeredPushToken = nil; pushRegistered = false }
            }
        } catch is CancellationError {
        } catch {
            // Bloco informativo; silencioso em caso de falha (401 é tratado abaixo).
            _ = unauthorized(error)
        }
    }

    func refreshNotificationStatus() async {
        let status = await PushManager.shared.authorizationStatus()
        guard !Task.isCancelled else { return }
        authorizationStatus = status
        syncLocalState()
    }

    // MARK: - Disponibilidade

    /// Marca presença/ausência com atualização otimista. Repetições após falha reutilizam a mesma Idempotency-Key.
    func setPresence(_ value: Bool) {
        guard let p = profileId, !presenceBusy else { return }
        let previous = present
        present = value
        presenceBusy = true
        presenceError = nil
        if pendingPresence != value || presenceKey == nil { presenceKey = APIClient.newIdempotencyKey() }
        pendingPresence = value
        let key = presenceKey ?? APIClient.newIdempotencyKey()
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let result = try await self.container.api.setPresence(p, present: value, key: key)
                let confirmed = result.present ?? value
                self.present = confirmed
                self.pendingPresence = nil
                self.presenceKey = nil
                if let me = self.userId, let i = self.team.firstIndex(where: { $0.actor == me }) {
                    self.team[i].present = confirmed ? 1 : 0
                }
                await self.loadPresence()
            } catch {
                self.present = previous
                if self.unauthorized(error) { return }
                if let e = error as? APIError, e.isIdempotencyConflict {
                    // Mesma chave com corpo diferente: descarta a chave para a próxima tentativa.
                    self.presenceKey = nil
                    self.pendingPresence = nil
                    self.presenceError = "O pedido anterior ainda estava em andamento. Tente novamente."
                } else {
                    self.presenceError = APIError.describe(error)
                }
            }
            self.presenceBusy = false
        }
    }

    // MARK: - Perfil

    /// Seleção direta de outro perfil; recarrega a presença da equipe desse perfil.
    func selectProfile(_ id: String) {
        guard id != container.profileId, profiles.contains(where: { $0.id == id }) else { return }
        container.profileId = id
        presenceKey = nil
        pendingPresence = nil
        team = []
        Task { @MainActor [weak self] in await self?.loadPresence() }
    }

    /// Reabre a tela de escolha de perfil (RootView mostra o seletor quando `profileId == nil`).
    func reopenProfilePicker() {
        container.profileId = nil
    }

    // MARK: - Notificações

    /// Liga/desliga as notificações deste aparelho e reenvia o registro com o novo `enabled`.
    func setNotifications(_ enabled: Bool) {
        guard !notificationsBusy else { return }
        notificationsEnabled = enabled
        session.notificationsEnabled = enabled
        notificationsBusy = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            if enabled, self.authorizationStatus == .notDetermined {
                _ = await PushManager.shared.requestPermission()
                self.authorizationStatus = await PushManager.shared.authorizationStatus()
            }
            let ok = await PushManager.shared.setNotificationsEnabled(enabled)
            self.syncLocalState()
            if ok {
                self.serverDeviceEnabled = enabled
                self.serverDeviceLastError = nil
            } else if self.container.isLoggedIn {
                if !self.hasPushToken {
                    self.alertMessage = enabled
                        ? "Este aparelho ainda não tem um token de push. Confira a conexão e, se o app foi compilado sem o Firebase, as notificações não ficam disponíveis."
                        : "Preferência guardada. O servidor será avisado quando o aparelho obtiver um token de push."
                } else {
                    self.alertMessage = "Não foi possível atualizar o registro no servidor. A preferência foi guardada e será reenviada na próxima abertura."
                }
            }
            self.notificationsBusy = false
        }
    }

    /// Pede a permissão do sistema (quando ainda não decidida) e atualiza o estado.
    func requestPermission() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            _ = await PushManager.shared.requestPermission()
            await self.refreshNotificationStatus()
        }
    }

    /// POST /devices/{id}/test. Reutiliza a chave enquanto o pedido anterior não for confirmado.
    func sendTest() {
        guard !testBusy else { return }
        testBusy = true
        if testKey == nil { testKey = APIClient.newIdempotencyKey() }
        let key = testKey ?? APIClient.newIdempotencyKey()
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let result = try await self.container.api.testDevice(id: self.deviceId, key: key)
                self.testKey = nil
                self.alertMessage = Self.describeTest(result)
            } catch {
                if self.unauthorized(error) { return }
                if let e = error as? APIError {
                    if e.isIdempotencyConflict { self.testKey = nil }
                    else if e.status == 404 {
                        self.testKey = nil
                        self.alertMessage = "O servidor não encontrou este aparelho. Desative e ative as notificações para registrar novamente."
                        self.testBusy = false
                        return
                    }
                    else if e.status >= 400 && e.status < 500 { self.testKey = nil }
                }
                self.alertMessage = APIError.describe(error)
            }
            self.testBusy = false
        }
    }

    private static func describeTest(_ result: JSONValue) -> String {
        let results = result["results"]?.arrayValue ?? []
        guard let first = results.first else {
            return "O servidor não enviou a notificação: o push está desativado nas configurações do servidor."
        }
        switch first["status"]?.stringValue ?? "" {
        case "ok": return "Notificação de teste enviada. Ela deve chegar em instantes."
        case "unregistered": return "O provedor de push não reconhece mais este aparelho. Desative e ative as notificações para registrar novamente."
        default:
            let detail = first["error"]?.stringValue ?? ""
            return detail.isEmpty ? "O provedor de push recusou a notificação." : "O provedor de push recusou a notificação: \(detail)"
        }
    }

    // MARK: - Dispositivo

    /// Reenvia o registro do aparelho (PUT /devices/{id}).
    func registerDevice() {
        guard !registering else { return }
        registering = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            let ok = await PushManager.shared.register(force: true)
            self.syncLocalState()
            if ok {
                self.serverDeviceEnabled = self.notificationsEnabled
                self.serverDeviceLastError = nil
            } else if self.container.isLoggedIn {
                self.alertMessage = self.hasPushToken
                    ? "Não foi possível registrar o aparelho no servidor. Tente novamente em instantes."
                    : "Este aparelho ainda não tem um token de push. Confira a conexão e, se o app foi compilado sem o Firebase, as notificações não ficam disponíveis."
            }
            self.registering = false
        }
    }

    // MARK: - Sair

    /// DELETE /devices/{id} → POST /logout → limpar sessão. `keepServer` falso também esquece o servidor.
    func logout(keepServer: Bool) {
        guard !loggingOut else { return }
        loggingOut = true
        logoutKeepServer = keepServer
        if logoutKey == nil { logoutKey = APIClient.newIdempotencyKey() }
        let key = logoutKey ?? APIClient.newIdempotencyKey()
        Task { @MainActor [weak self] in
            guard let self else { return }
            await PushManager.shared.unregister()
            do {
                _ = try await self.container.api.logout(key: key)
                self.finishLogout()
            } catch {
                if let e = error as? APIError, e.isUnauthorized || e.isIdempotencyConflict || (e.status >= 400 && e.status < 500 && e.status != 429) {
                    // Sessão já inválida (ou pedido já consumido): basta limpar localmente.
                    self.finishLogout()
                } else {
                    self.loggingOut = false
                    self.logoutFailure = APIError.describe(error)
                }
            }
        }
    }

    /// Repete a saída com a mesma Idempotency-Key.
    func retryLogout() {
        logoutFailure = nil
        logout(keepServer: logoutKeepServer)
    }

    /// Sai sem conseguir avisar o servidor (o token expira sozinho em até 30 dias).
    func forceLogout() {
        logoutFailure = nil
        loggingOut = true
        finishLogout()
    }

    private func finishLogout() {
        cancel()
        PushManager.shared.clearAllNotifications()
        logoutKey = nil
        container.onLoggedOut(keepServer: logoutKeepServer)
        loggingOut = false
    }

    // MARK: - Auxiliares

    /// 401 → volta ao login mantendo o servidor. Devolve `true` quando tratou o erro.
    @discardableResult
    private func unauthorized(_ error: Error) -> Bool {
        guard let e = error as? APIError, e.isUnauthorized else { return false }
        cancel()
        container.handleUnauthorized()
        return true
    }
}

extension UNAuthorizationStatus {
    /// Texto curto em pt-BR para a tela Mais.
    var wabotiaDescription: String {
        switch self {
        case .authorized: return "Permitidas"
        case .denied: return "Bloqueadas"
        case .notDetermined: return "Não solicitada"
        case .provisional: return "Silenciosas"
        case .ephemeral: return "Temporárias"
        @unknown default: return "Desconhecido"
        }
    }
}
