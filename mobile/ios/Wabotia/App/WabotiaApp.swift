import SwiftUI

@main
struct WabotiaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var container = AppContainer.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
                .onOpenURL { url in container.handle(deepLink: DeepLink(url: url)) }
        }
    }
}
