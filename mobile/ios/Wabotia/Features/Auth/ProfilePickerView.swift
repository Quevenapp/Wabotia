import SwiftUI

/// Escolha do perfil quando a pessoa tem acesso a mais de um (administradores veem todos).
struct ProfilePickerView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var profiles: [Profile]?
    @State private var error: String?

    var body: some View {
        AppNavigationStack {
            Group {
                if let error {
                    EmptyStateView(title: "Não foi possível carregar", systemImage: "exclamationmark.triangle", message: error)
                } else if let profiles {
                    if profiles.isEmpty {
                        EmptyStateView(title: "Sem perfis", systemImage: "person.crop.circle.badge.questionmark", message: "Sua conta não tem perfis de atendimento. Peça ao administrador para incluir você em um perfil.")
                    } else {
                        List(profiles) { p in
                            Button {
                                container.profileId = p.id
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(p.name).foregroundStyle(.primary)
                                    Text(p.enabled == 1 ? "Atendimento ativo" : "Atendimento pausado").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Escolha o perfil")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Sair") {
                        Task {
                            // Mesma sequência da tela Mais: DELETE /devices → POST /logout → limpar sessão.
                            await PushManager.shared.unregister()
                            _ = try? await container.api.logout()
                            PushManager.shared.clearAllNotifications()
                            container.onLoggedOut(keepServer: true)
                        }
                    }
                }
            }
            .task {
                do {
                    let list = try await container.api.profiles()
                    if list.count == 1 { container.profileId = list[0].id } else { profiles = list }
                } catch { self.error = APIError.describe(error) }
            }
        }
    }
}

/// Substituto de ContentUnavailableView (iOS 17) compatível com iOS 16.
struct EmptyStateView: View {
    let title: String
    let systemImage: String
    var message: String? = nil

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage).font(.system(size: 44)).foregroundStyle(.secondary)
            Text(title).font(.title3.bold())
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
