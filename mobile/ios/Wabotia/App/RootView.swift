import SwiftUI

/// Decide a tela inicial: servidor → login → perfil → abas.
struct RootView: View {
    @EnvironmentObject private var container: AppContainer

    var body: some View {
        Group {
            if container.session.serverURL == nil {
                ServerView()
            } else if !container.isLoggedIn {
                LoginView()
            } else if container.session.profileId == nil {
                ProfilePickerView()
            } else {
                HomeView()
            }
        }
        .animation(.default, value: container.isLoggedIn)
        .animation(.default, value: container.session.profileId)
        .tint(Color("AccentColor"))
    }
}
