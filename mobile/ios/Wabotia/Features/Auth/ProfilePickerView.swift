import SwiftUI

/// Escolha do perfil quando a pessoa tem acesso a mais de um (administradores veem todos).
struct ProfilePickerView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var profiles: [Profile]?
    @State private var error: String?
    @State private var leaving = false

    var body: some View {
        AuthScaffold(title: "Escolha o perfil", subtitle: "Cada perfil tem as próprias conversas, linhas e equipe.") {
            if let error {
                InlineError(text: error) { Task { await load() } }
            } else if let profiles {
                if profiles.isEmpty {
                    Text("Sua conta não tem perfis de atendimento. Peça ao administrador para incluir você em um perfil.")
                        .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity).card()
                } else {
                    VStack(spacing: 0) {
                        ForEach(profiles) { p in
                            Button { container.profileId = p.id } label: {
                                HStack(spacing: 12) {
                                    AvatarView(name: p.name, seed: p.id, size: 44)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(p.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                        HStack(spacing: 5) {
                                            Circle().fill(p.enabled == 1 ? Theme.ok : Theme.muted).frame(width: 7, height: 7)
                                            Text(p.enabled == 1 ? "Atendimento ativo" : "Atendimento pausado").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 66)
                                .contentShape(Rectangle())
                                .overlay(alignment: .bottom) { if p.id != profiles.last?.id { ThinDivider(leading: 70, onCard: true) } }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
            }
            Button(leaving ? "Saindo…" : "Sair da conta") {
                leaving = true
                Task {
                    // Mesma sequência de Ajustes: DELETE /devices → POST /logout → limpar sessão.
                    await PushManager.shared.unregister()
                    _ = try? await container.api.logout()
                    PushManager.shared.clearAllNotifications()
                    container.onLoggedOut(keepServer: true)
                }
            }
            .font(Theme.font(15, .semibold)).foregroundStyle(Theme.danger)
            .frame(maxWidth: .infinity, minHeight: Theme.touch)
            .disabled(leaving)
        }
        .task { await load() }
    }

    private func load() async {
        error = nil
        do {
            let list = try await container.api.profiles()
            if list.count == 1 { container.profileId = list[0].id } else { profiles = list }
        } catch {
            if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized(); return }
            self.error = APIError.describe(error)
        }
    }
}
