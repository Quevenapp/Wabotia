import UIKit
import UserNotifications

/// Registra o aparelho para push e encaminha toques em notificações.
/// O Firebase (FCM) é inicializado apenas se GoogleService-Info.plist estiver no pacote;
/// sem ele o app funciona normalmente, só não recebe notificações.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        PushManager.shared.configure()
        PushManager.shared.registerCategories()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushManager.shared.didRegister(apnsToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushManager.shared.didFail(error)
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        PushManager.shared.didReceive(userInfo: userInfo, foreground: application.applicationState == .active)
        return .newData
    }

    // Notificação chegando com o app aberto.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        PushManager.shared.didReceive(userInfo: info, foreground: true)
        // Os avisos aparecem como banner discreto se a tela atual não for a conversa.
        return PushManager.shared.shouldPresentForeground(info) ? [.banner, .sound, .list] : []
    }

    // Toque na notificação.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        PushManager.shared.didRespond(action: response.actionIdentifier, userInfo: response.notification.request.content.userInfo)
    }
}
