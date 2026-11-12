import SwiftUI
import UIKit
import UserNotifications

/// Aba Ajustes (mobile/DESIGN.md, seção 10): cartão do usuário e grupos em cartões: Atendimento,
/// Notificações, Aparência, Servidor, Este aparelho e Sair. Tudo que existia em "Mais" continua aqui.
struct SettingsView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @StateObject private var vm = SettingsViewModel()
    @ObservedObject private var workspace = Workspace.shared
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.pushRoute) private var push
    @State private var confirmLogout = false
    @State private var confirmChangeServer = false
    @State private var showPresence = false
    @State private var appearance = AppAppearance.current

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Ajustes") { EmptyView() }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 20) {
                        userCard.padding(.horizontal, 16)
                        serviceSection.padding(.horizontal, 16)
                        notificationsSection.padding(.horizontal, 16).id("notifications")
                        appearanceSection.padding(.horizontal, 16).id("appearance")
                        serverSection.padding(.horizontal, 16).id("server")
                        deviceSection.padding(.horizontal, 16).id("device")
                        logoutSection.padding(.horizontal, 16).id("logout")
                    }
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                }
                #if DEBUG
                .onAppear {
                    if active, let anchor = DemoMode.anchor {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { proxy.scrollTo(anchor, anchor: .top) }
                    }
                }
                #endif
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .disabled(vm.loggingOut)
        .overlay {
            if vm.loggingOut {
                VStack(spacing: 10) { ProgressView(); Text("Saindo…").font(Theme.font(14)).foregroundStyle(Theme.textPrimary) }
                    .padding(24)
                    .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                    .shadow(color: Theme.shadow, radius: 12)
            }
        }
        .task(id: active) { if active { await vm.load() } }
        .onDisappear { vm.cancel() }
        .onChange(of: scenePhase) { phase in
            if phase == .active, active { Task { await vm.refreshNotificationStatus() } }
        }
        .sheet(isPresented: $showPresence) { PresenceSheet() }
        .alert("Aviso", isPresented: alertBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(vm.alertMessage ?? "")
        }
        .alert("Não foi possível avisar o servidor", isPresented: logoutFailureBinding) {
            Button("Tentar novamente") { vm.retryLogout() }
            Button("Sair mesmo assim", role: .destructive) { vm.forceLogout() }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("\(vm.logoutFailure ?? "") Você pode tentar de novo ou sair apenas neste aparelho; a sessão no servidor expira sozinha.")
        }
        .confirmationDialog("Sair da conta?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Sair", role: .destructive) { vm.logout(keepServer: true) }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Este aparelho deixa de receber notificações. O servidor \(vm.serverHost) continua configurado para o próximo acesso.")
        }
        .confirmationDialog("Trocar de servidor?", isPresented: $confirmChangeServer, titleVisibility: .visible) {
            Button("Sair e trocar servidor", role: .destructive) { vm.logout(keepServer: false) }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Você sai da conta neste aparelho e informa o endereço de outra instalação Wabotia.")
        }
    }

    // MARK: - Usuário

    private var userCard: some View {
        HStack(spacing: 14) {
            AvatarView(name: vm.userName.isEmpty ? vm.userEmail : vm.userName, seed: vm.userId ?? "", size: 60, badge: .presence(workspace.mePresent), ring: Theme.surface)
            VStack(alignment: .leading, spacing: 2) {
                Text(vm.userName.isEmpty ? "Atendente" : vm.userName).font(Theme.font(19, .bold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text(vm.isAdmin ? "Administrador" : "Atendente").font(Theme.font(13, .medium)).foregroundStyle(Theme.brand)
                Text(workspace.profileName.isEmpty ? vm.currentProfileName : workspace.profileName).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { showPresence = true } label: { PresencePill(online: workspace.mePresent, busy: workspace.presenceBusy) }
                .buttonStyle(.plain)
        }
        .card(padding: 16)
    }

    // MARK: - Atendimento

    private var serviceSection: some View {
        SectionCard(title: "Atendimento", footer: vm.isAdmin ? nil : "Atendentes consultam as linhas; a edição é do administrador.") {
            navRow("Linhas de atendimento", "phone.connection", Theme.ok, divider: vm.isAdmin) { push(.lines) }
            if vm.isAdmin {
                navRow("Menus e submenus", "list.bullet.indent", Theme.brand) { push(.menus) }
                navRow("Linhas dos bots", "cpu", Theme.bot, divider: false) { push(.botLines) }
            }
        }
    }

    private func navRow(_ title: String, _ icon: String, _ color: Color, divider: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) { CardRow(icon: icon, iconColor: color, title: title, chevron: true, divider: divider) }
            .buttonStyle(.plain)
    }

    // MARK: - Notificações

    private var notificationsSection: some View {
        SectionCard(title: "Notificações", footer: notificationsFooter) {
            CardRow(icon: "bell.fill", iconColor: Theme.danger, title: "Receber notificações") {
                if vm.notificationsBusy { ProgressView() }
                Toggle("Receber notificações", isOn: Binding(get: { vm.notificationsEnabled }, set: { vm.setNotifications($0) }))
                    .labelsHidden().tint(Theme.accent).disabled(vm.notificationsBusy)
            }
            Button {
                if vm.authorizationStatus == .notDetermined { vm.requestPermission() } else { openSystemSettings() }
            } label: {
                CardRow(icon: "iphone", iconColor: Theme.muted, title: "Permissão", chevron: true) {
                    Text(vm.authorizationStatus.wabotiaDescription).font(Theme.font(13)).foregroundStyle(vm.authorizationStatus == .denied ? Theme.warn : Theme.textSecondary).lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            Button { vm.sendTest() } label: {
                CardRow(icon: "paperplane.fill", iconColor: Theme.ticket, title: "Enviar notificação de teste") {
                    if vm.testBusy { ProgressView() }
                }
            }
            .buttonStyle(.plain)
            .disabled(vm.testBusy || !vm.pushRegistered)
            .opacity(vm.pushRegistered ? 1 : 0.5)
            CardRow(icon: "checkmark.seal.fill", iconColor: registrationColor, title: "Registro de push", divider: showsReregister || vm.serverDeviceLastError != nil) {
                if vm.registering { ProgressView() } else {
                    Text(registrationText).font(Theme.font(13)).foregroundStyle(registrationColor == Theme.muted ? Theme.textSecondary : registrationColor).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            if let error = vm.serverDeviceLastError {
                Text("Último erro do provedor: \(error)").font(Theme.font(12)).foregroundStyle(Theme.warn)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 8)
            }
            if showsReregister {
                Button { vm.registerDevice() } label: {
                    CardRow(title: "Registrar novamente", titleColor: Theme.brand, divider: false)
                }
                .buttonStyle(.plain)
                .disabled(vm.registering)
            }
        }
    }

    private var showsReregister: Bool {
        vm.hasPushToken && (!vm.pushRegistered || vm.serverDeviceEnabled == false || vm.serverDeviceLastError != nil)
    }

    private var notificationsFooter: String {
        if !vm.hasPushToken {
            return "Este aparelho ainda não tem um token de push. Sem o Firebase no pacote, não há notificações; com o app aberto, tudo continua atualizando sozinho."
        }
        if !vm.pushRegistered { return "O aparelho ainda não foi registrado no servidor. Toque em Registrar novamente." }
        if !vm.notificationsEnabled { return "Com as notificações desligadas, o servidor não envia avisos para este aparelho." }
        if vm.authorizationStatus == .denied { return "O servidor envia os avisos, mas o iPhone está bloqueando as notificações do Wabotia. Libere nos Ajustes." }
        return "Você recebe novas mensagens, fila, transferências, protocolos e ligações. Mensagens atendidas pelo bot não geram aviso."
    }

    private var registrationText: String {
        if !vm.pushRegistered { return vm.hasPushToken ? "Não registrado" : "Sem token de push" }
        if vm.serverDeviceEnabled == false && vm.notificationsEnabled { return "Desativado pelo servidor" }
        if !vm.notificationsEnabled { return "Registrado, avisos desligados" }
        return "Registrado"
    }

    private var registrationColor: Color {
        if !vm.pushRegistered { return vm.hasPushToken ? Theme.warn : Theme.muted }
        if vm.serverDeviceEnabled == false && vm.notificationsEnabled { return Theme.warn }
        return vm.notificationsEnabled ? Theme.ok : Theme.muted
    }

    // MARK: - Aparência

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("APARÊNCIA").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 14)
            HStack(spacing: 4) {
                ForEach(AppAppearance.allCases) { option in
                    let selected = appearance == option
                    Button {
                        appearance = option
                        AppAppearance.current = option
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: option == .system ? "circle.lefthalf.filled" : (option == .light ? "sun.max.fill" : "moon.fill")).font(.system(size: 13))
                            Text(option.title).font(Theme.font(14, selected ? .semibold : .medium))
                        }
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .foregroundStyle(selected ? Theme.onBrand : Theme.textPrimary)
                        .background(Capsule().fill(selected ? Theme.brand : Color.clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(4)
            .background(Capsule().fill(Theme.surface))
        }
    }

    // MARK: - Servidor

    private var serverSection: some View {
        SectionCard(title: "Servidor", footer: "O app guarda um servidor por vez. Para usar outra instalação, troque de servidor.") {
            CardRow(icon: "globe", iconColor: Theme.ticket, title: "Endereço", value: vm.serverHost.isEmpty ? "—" : vm.serverHost)
            CardRow(icon: "number", iconColor: Theme.muted, title: "Versão") {
                if let version = vm.serverVersion {
                    Text(version).font(Theme.font(15)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                } else if vm.serverError != nil {
                    Text("Indisponível").font(Theme.font(15)).foregroundStyle(Theme.danger)
                } else {
                    ProgressView()
                }
            }
            if let error = vm.serverError {
                Text(error).font(Theme.font(12)).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 8)
            }
            if let panel = vm.panelURL {
                Button { openURL(panel) } label: { CardRow(icon: "safari.fill", iconColor: Theme.tickRead, title: "Abrir painel no navegador", chevron: true) }
                    .buttonStyle(.plain)
            }
            profileRow
            if let error = vm.profilesError {
                Text(error).font(Theme.font(12)).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 8)
            }
            Button { confirmChangeServer = true } label: {
                CardRow(icon: "arrow.left.arrow.right", iconColor: Theme.warn, title: "Trocar servidor", chevron: true, divider: false)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var profileRow: some View {
        if vm.profiles.count > 1 {
            Menu {
                ForEach(vm.profiles) { profile in
                    Button { vm.selectProfile(profile.id) } label: {
                        if profile.id == container.profileId { Label(profile.name, systemImage: "checkmark") } else { Text(profile.name) }
                    }
                }
            } label: {
                CardRow(icon: "person.2.fill", iconColor: Theme.brand, title: "Trocar perfil", value: vm.currentProfileName, chevron: true)
            }
        } else if vm.profilesError != nil {
            Button { vm.reopenProfilePicker() } label: {
                CardRow(icon: "person.2.fill", iconColor: Theme.brand, title: "Trocar perfil", value: vm.currentProfileName, chevron: true)
            }
            .buttonStyle(.plain)
        } else {
            CardRow(icon: "person.2.fill", iconColor: Theme.brand, title: "Perfil", value: vm.currentProfileName)
        }
    }

    // MARK: - Aparelho

    private var deviceSection: some View {
        SectionCard(title: "Este aparelho") {
            CardRow(title: "Nome", value: vm.deviceName)
            CardRow(title: "Sistema", value: vm.systemVersion)
            CardRow(title: "Versão do app", value: vm.appVersion)
            CardRow(title: "Identificador", value: String(vm.deviceId.prefix(8)), divider: false)
        }
    }

    // MARK: - Sair

    private var logoutSection: some View {
        SectionCard(footer: "Remove o registro deste aparelho no servidor e encerra a sessão. O endereço do servidor é mantido.") {
            Button { confirmLogout = true } label: {
                HStack {
                    Spacer()
                    Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 15, weight: .semibold))
                    Text("Sair da conta").font(Theme.font(16, .semibold))
                    Spacer()
                }
                .foregroundStyle(Theme.danger)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Auxiliares

    private var alertBinding: Binding<Bool> {
        Binding(get: { vm.alertMessage != nil }, set: { if !$0 { vm.alertMessage = nil } })
    }

    private var logoutFailureBinding: Binding<Bool> {
        Binding(get: { vm.logoutFailure != nil }, set: { if !$0 { vm.logoutFailure = nil } })
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }
}
