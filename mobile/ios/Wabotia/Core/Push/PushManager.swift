import Foundation
import UIKit
import UserNotifications
#if canImport(FirebaseCore)
import FirebaseCore
import FirebaseMessaging
#endif

/// Token FCM, registro no servidor (PUT /api/v1/devices/{id}), categorias e tratamento de toques.
/// O payload `data` do push segue docs/MOBILE.md: type, profile_id, conversation_id, ticket_id, call_id, server.
///
/// Sem `GoogleService-Info.plist` o Firebase não é inicializado: o app funciona normalmente, só não há token
/// de push e, portanto, nenhum registro no servidor (`registeredPushToken` fica nulo e a tela Mais explica o motivo).
final class PushManager: NSObject {
    static let shared = PushManager()
    static let callCategory = "CALL"
    static let messageCategory = "MESSAGE"
    static let ticketCategory = "TICKET"
    static let answerAction = "ANSWER"
    static let declineAction = "DECLINE"

    /// Tempo máximo esperando o token FCM antes de seguir sem push (evita travar o registro).
    private static let tokenTimeout: Double = 10

    private var firebaseReady = false
    /// Conversa aberta no momento (para não mostrar banner da própria conversa).
    /// Ao abrir uma conversa, as notificações já entregues dela são removidas da Central de Notificações.
    var visibleConversationId: String? {
        didSet { if let id = visibleConversationId { clearNotifications(conversationId: id) } }
    }

    /// Versão do app enviada ao servidor (CFBundleShortVersionString).
    static var appVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }
    /// Indica se o Firebase foi configurado neste pacote (há GoogleService-Info.plist).
    var isFirebaseConfigured: Bool { firebaseReady }

    func configure() {
        #if canImport(FirebaseCore)
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil, FirebaseApp.app() == nil {
            FirebaseApp.configure()
            Messaging.messaging().delegate = self
            firebaseReady = true
        }
        #endif
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }

    func registerCategories() {
        let answer = UNNotificationAction(identifier: Self.answerAction, title: "Atender", options: [.foreground])
        let decline = UNNotificationAction(identifier: Self.declineAction, title: "Recusar", options: [.destructive])
        let call = UNNotificationCategory(identifier: Self.callCategory, actions: [answer, decline], intentIdentifiers: [], options: [])
        let message = UNNotificationCategory(identifier: Self.messageCategory, actions: [], intentIdentifiers: [], options: [])
        let ticket = UNNotificationCategory(identifier: Self.ticketCategory, actions: [], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([call, message, ticket])
    }

    /// Pede permissão de notificações ao sistema e registra no APNs. Devolve se foi concedida.
    func requestPermission() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        if granted { registerIfNeeded() }
        return granted
    }

    /// Estado atual da permissão de notificações no sistema.
    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func didRegister(apnsToken: Data) {
        #if canImport(FirebaseCore)
        if firebaseReady {
            Messaging.messaging().apnsToken = apnsToken
            // Com o APNs pronto, o token FCM pode ser obtido (ou já foi entregue pelo delegate).
            registerIfNeeded()
        }
        #endif
    }

    func didFail(_ error: Error) {
        // Simulador ou sem rede: o app segue sem push.
    }

    /// Envia o token FCM ao servidor após login e quando o token muda (dispara e esquece).
    func registerIfNeeded(force: Bool = false) {
        Task { @MainActor in await self.register(force: force) }
    }

    /// Registra (ou atualiza) este aparelho em PUT /api/v1/devices/{id} com `enabled = notificationsEnabled`.
    /// Devolve `true` quando o servidor tem o token atual registrado. Sem Firebase/token, devolve `false` sem travar.
    @MainActor
    @discardableResult
    func register(force: Bool = false) async -> Bool {
        let container = AppContainer.shared
        guard container.isLoggedIn, container.session.serverURL != nil else { return false }
        let store = container.session
        if store.pushToken == nil, let token = await fetchFCMToken() { store.pushToken = token }
        guard let token = store.pushToken else { return false }
        if !force, store.registeredPushToken == token { return true }
        let name = String(UIDevice.current.name.prefix(80))
        let body = DeviceRegistration(token: token, name: name, app_version: Self.appVersion, profiles: [], enabled: store.notificationsEnabled)
        do {
            _ = try await container.api.registerDevice(id: store.deviceId, body)
            store.registeredPushToken = token
            return true
        } catch {
            if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized() }
            // Demais falhas: tenta de novo na próxima abertura / mudança de token.
            return false
        }
    }

    /// Liga ou desliga as notificações deste aparelho e reenvia o registro com o novo `enabled`.
    /// Devolve `true` se o servidor confirmou a alteração.
    @MainActor
    func setNotificationsEnabled(_ enabled: Bool) async -> Bool {
        AppContainer.shared.session.notificationsEnabled = enabled
        return await register(force: true)
    }

    /// Remove o aparelho do servidor (DELETE /api/v1/devices/{id}); chamado antes de sair da conta.
    func unregister() async {
        let target: (APIClient, String)? = await MainActor.run { () -> (APIClient, String)? in
            let container = AppContainer.shared
            guard container.session.serverURL != nil, container.session.token != nil else { return nil }
            return (container.api, container.session.deviceId)
        }
        if let (api, deviceId) = target { _ = try? await api.deleteDevice(id: deviceId) }
        await MainActor.run { AppContainer.shared.session.registeredPushToken = nil }
    }

    /// Remove da Central de Notificações as notificações já entregues de uma conversa.
    func clearNotifications(conversationId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let ids = notifications
                .filter { ($0.request.content.userInfo["conversation_id"] as? String) == conversationId }
                .map { $0.request.identifier }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// Remove todas as notificações entregues (ex.: ao sair da conta).
    func clearAllNotifications() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    func shouldPresentForeground(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let conversation = userInfo["conversation_id"] as? String else { return true }
        return conversation != visibleConversationId
    }

    func didReceive(userInfo: [AnyHashable: Any], foreground: Bool) {
        guard let link = DeepLink(userInfo: userInfo) else { return }
        if foreground, let conversation = link.conversationId, conversation == visibleConversationId {
            clearNotifications(conversationId: conversation)
        }
        guard link.type == "call", link.callId != nil else { return }
        let server = userInfo["server"] as? String
        Task { @MainActor in
            // Ignora pushes de outro servidor (o app guarda um servidor por vez).
            if let server, !server.isEmpty,
               let current = AppContainer.shared.session.serverURL?.absoluteString,
               server.lowercased() != current.lowercased() { return }
            AppContainer.shared.incomingCall = link
        }
    }

    func didRespond(action: String, userInfo: [AnyHashable: Any]) {
        guard let link = DeepLink(userInfo: userInfo) else { return }
        if link.type == "test" { return }
        if action == Self.declineAction, let profile = link.profileId, let callId = link.callId {
            Task {
                let api = await AppContainer.shared.api
                _ = try? await api.claimCall(profile, id: callId)
                _ = try? await api.rejectCall(profile, id: callId)
            }
            return
        }
        let answering = action == Self.answerAction && link.type == "call" && link.callId != nil
        Task { @MainActor in
            // Ação "Atender" da notificação: a CallView consome a marca e inicia o atendimento sozinha.
            if answering { CallIntents.answerCallId = link.callId }
            AppContainer.shared.handle(deepLink: link)
        }
    }

    // MARK: - Token FCM

    /// Obtém o token FCM com tempo limite; `nil` quando o Firebase não está configurado ou não respondeu.
    private func fetchFCMToken() async -> String? {
        #if canImport(FirebaseCore)
        guard firebaseReady else { return nil }
        return await Self.withTimeout(seconds: Self.tokenTimeout) { try await Messaging.messaging().token() }
        #else
        return nil
        #endif
    }

    /// Executa `operation` e devolve `nil` se ela falhar ou ultrapassar `seconds`.
    private static func withTimeout<T: Sendable>(seconds: Double, _ operation: @escaping @Sendable () async throws -> T) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { try? await operation() }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

#if canImport(FirebaseCore)
extension PushManager: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { @MainActor in
            let store = AppContainer.shared.session
            let changed = store.pushToken != fcmToken
            store.pushToken = fcmToken
            await self.register(force: changed)
        }
    }
}
#endif
