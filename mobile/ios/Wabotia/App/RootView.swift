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
        .tint(Theme.brand)
        .onAppear {
            AppAppearance.apply()
            #if DEBUG
            // Ajuda a conferir por linha de comando em que tela o app abriu (sem dados da sessão).
            print("[Wabotia] tela inicial: \(container.session.serverURL == nil ? "servidor" : (!container.isLoggedIn ? "login" : (container.session.profileId == nil ? "perfil" : "abas")))")
            #endif
        }
        .onChange(of: container.isLoggedIn) { loggedIn in
            if !loggedIn { Workspace.shared.reset() }
        }
    }
}
