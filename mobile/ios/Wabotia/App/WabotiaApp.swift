import SwiftUI

@main
struct WabotiaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var container = AppContainer.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Theme.applyAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
                .onOpenURL { url in container.handle(deepLink: DeepLink(url: url)) }
        }
        // Seletor de apps e segundo plano: a miniatura mostra só a marca, nunca dados de clientes.
        .onChange(of: scenePhase) { phase in PrivacyShield.shared.update(phase) }
    }
}
