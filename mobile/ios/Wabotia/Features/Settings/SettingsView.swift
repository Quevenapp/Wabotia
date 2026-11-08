import SwiftUI
import UIKit
import UserNotifications

/// Aba Mais: disponibilidade (presença), perfil, notificações, dispositivo, servidor e sair (mobile/README.md).
struct SettingsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var vm = SettingsViewModel()
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmLogout = false
    @State private var confirmChangeServer = false

    var body: some View {
        List {
            accountSection
            presenceSection
            profileSection
            notificationsSection
            deviceSection
            serverSection
            logoutSection
        }
        .navigationTitle("Mais")
        .disabled(vm.loggingOut)
        .overlay {
            if vm.loggingOut {
                ProgressView("Saindo…")
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .onDisappear { vm.cancel() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await vm.refreshNotificationStatus() } }
        }
        .onChange(of: container.profileId) { _ in
            Task { await vm.loadPresence() }
        }
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

    // MARK: - Conta

    private var accountSection: some View {
        Section {
            HStack(spacing: 12) {
                SettingsAvatar(text: vm.userName.isEmpty ? vm.userEmail : vm.userName, active: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(vm.userName.isEmpty ? "Atendente" : vm.userName).font(.headline)
                    if !vm.userEmail.isEmpty { Text(vm.userEmail).font(.footnote).foregroundStyle(.secondary) }
                    Text(vm.isAdmin ? "Administrador" : "Atendente").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Disponibilidade

    private var presenceSection: some View {
        Section {
            Toggle(isOn: Binding(get: { vm.present }, set: { vm.setPresence($0) })) {
                HStack {
                    Label(vm.present ? "Presente" : "Ausente", systemImage: vm.present ? "person.fill.checkmark" : "person.fill.xmark")
                    if vm.presenceBusy { Spacer(); ProgressView() }
                }
            }
            .disabled(vm.presenceBusy || container.profileId == nil)

            if let error = vm.presenceError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            if vm.team.isEmpty {
                if vm.presenceLoading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if vm.presenceError == nil {
                    Text("Nenhuma pessoa com acesso a este perfil.").font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ForEach(vm.team) { entry in
                    TeamRow(entry: entry, isMe: entry.actor == vm.userId)
                }
            }
        } header: {
            Text("Disponibilidade")
        } footer: {
            Text("Presença é uma escolha da equipe: manter o app aberto não marca presença. Sem atendentes presentes, o cliente recebe um protocolo em vez de esperar na fila.")
        }
    }

    // MARK: - Perfil

    private var profileSection: some View {
        Section {
            if vm.profiles.count > 1 {
                Picker("Perfil", selection: Binding(get: { container.profileId ?? "" }, set: { vm.selectProfile($0) })) {
                    ForEach(vm.profiles) { profile in
                        Text(profile.name).tag(profile.id)
                    }
                }
                .pickerStyle(.navigationLink)
            } else {
                LabeledContent("Perfil", value: vm.currentProfileName)
            }
            if let error = vm.profilesError {
                Text(error).font(.footnote).foregroundStyle(.red)
                Button("Trocar perfil") { vm.reopenProfilePicker() }
            }
        } header: {
            Text("Perfil de atendimento")
        } footer: {
            if vm.isAdmin {
                Text("Administradores veem todos os perfis. Notificações chegam de todos os perfis autorizados.")
            } else if vm.profiles.count > 1 {
                Text("As abas mostram o perfil escolhido. Notificações chegam de todos os perfis autorizados.")
            }
        }
    }

    // MARK: - Notificações

    private var notificationsSection: some View {
        Section {
            Toggle(isOn: Binding(get: { vm.notificationsEnabled }, set: { vm.setNotifications($0) })) {
                HStack {
                    Text("Receber notificações")
                    if vm.notificationsBusy { Spacer(); ProgressView() }
                }
            }
            .disabled(vm.notificationsBusy)

            HStack {
                Text("Permissão do sistema")
                Spacer()
                Text(vm.authorizationStatus.wabotiaDescription)
                    .foregroundStyle(vm.authorizationStatus == .denied ? Color.orange : Color.secondary)
            }

            switch vm.authorizationStatus {
            case .notDetermined:
                Button("Permitir notificações") { vm.requestPermission() }
            case .denied:
                Button("Abrir Ajustes do sistema") { openSystemSettings() }
            default:
                Button("Ajustes de notificação do sistema") { openSystemSettings() }
            }

            Button {
                vm.sendTest()
            } label: {
                HStack {
                    Text("Enviar notificação de teste")
                    if vm.testBusy { Spacer(); ProgressView() }
                }
            }
            .disabled(vm.testBusy || !vm.pushRegistered)
        } header: {
            Text("Notificações")
        } footer: {
            Text(notificationsFooter)
        }
    }

    private var notificationsFooter: String {
        if !vm.hasPushToken {
            return "Este aparelho ainda não tem um token de push. Se o app foi compilado sem o Firebase (GoogleService-Info.plist), as notificações não ficam disponíveis; em primeiro plano o app continua atualizando sozinho."
        }
        if !vm.pushRegistered {
            return "O aparelho ainda não foi registrado no servidor. Use \"Registrar novamente\" em Dispositivo."
        }
        if !vm.notificationsEnabled {
            return "Com as notificações desligadas, o servidor não envia avisos para este aparelho. A preferência fica guardada no servidor."
        }
        if vm.authorizationStatus == .denied {
            return "O servidor envia os avisos, mas o iPhone está bloqueando as notificações do Wabotia. Libere em Ajustes."
        }
        return "Você recebe novas mensagens, atendimentos na fila, transferências, protocolos e ligações. Mensagens com a IA não geram aviso."
    }

    // MARK: - Dispositivo

    private var deviceSection: some View {
        Section {
            LabeledContent("Nome", value: vm.deviceName)
            LabeledContent("Sistema", value: vm.systemVersion)
            LabeledContent("Versão do app", value: vm.appVersion)
            LabeledContent("Identificador", value: String(vm.deviceId.prefix(8)))
            HStack {
                Text("Registro de push")
                Spacer()
                if vm.registering {
                    ProgressView()
                } else {
                    Text(registrationText).foregroundStyle(registrationColor)
                }
            }
            if let error = vm.serverDeviceLastError {
                Text("Último erro do provedor: \(error)").font(.footnote).foregroundStyle(.orange)
            }
            if vm.hasPushToken && (!vm.pushRegistered || vm.serverDeviceEnabled == false || vm.serverDeviceLastError != nil) {
                Button("Registrar novamente") { vm.registerDevice() }.disabled(vm.registering)
            }
        } header: {
            Text("Dispositivo")
        }
    }

    private var registrationText: String {
        if !vm.pushRegistered { return vm.hasPushToken ? "Não registrado" : "Sem token de push" }
        if vm.serverDeviceEnabled == false && vm.notificationsEnabled { return "Desativado pelo servidor" }
        if !vm.notificationsEnabled { return "Registrado, avisos desligados" }
        return "Registrado"
    }

    private var registrationColor: Color {
        if !vm.pushRegistered { return vm.hasPushToken ? .orange : .secondary }
        if vm.serverDeviceEnabled == false && vm.notificationsEnabled { return .orange }
        return vm.notificationsEnabled ? .green : .secondary
    }

    // MARK: - Servidor

    private var serverSection: some View {
        Section {
            LabeledContent("Endereço", value: vm.serverURL?.absoluteString ?? "—")
            HStack {
                Text("Versão")
                Spacer()
                if let version = vm.serverVersion {
                    Text(version).foregroundStyle(.secondary)
                } else if vm.serverError != nil {
                    Text("Indisponível").foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            if let error = vm.serverError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            if let panel = vm.panelURL {
                Link(destination: panel) {
                    Label("Abrir painel no navegador", systemImage: "safari")
                }
            }
            Button("Trocar servidor") { confirmChangeServer = true }
        } header: {
            Text("Servidor")
        } footer: {
            Text("O app guarda um servidor por vez. Para usar outra instalação Wabotia, saia da conta e informe o novo endereço.")
        }
    }

    // MARK: - Sair

    private var logoutSection: some View {
        Section {
            Button(role: .destructive) {
                confirmLogout = true
            } label: {
                HStack { Spacer(); Text("Sair da conta"); Spacer() }
            }
        } footer: {
            Text("Remove o registro deste aparelho no servidor e encerra a sessão. O endereço do servidor é mantido para o próximo acesso.")
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

/// Linha da equipe com presença.
private struct TeamRow: View {
    let entry: PresenceEntry
    let isMe: Bool

    private var present: Bool { (entry.present ?? 0) == 1 }
    private var displayName: String { entry.name.isEmpty ? entry.actor : entry.name }

    var body: some View {
        HStack(spacing: 12) {
            SettingsAvatar(text: displayName, active: present)
            HStack(spacing: 6) {
                Text(displayName).lineLimit(1)
                if isMe { Text("você").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Text(present ? "Presente" : "Ausente")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(present ? Color.green.opacity(0.15) : Color.secondary.opacity(0.15)))
                .foregroundStyle(present ? Color.green : Color.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Avatar circular com a inicial do nome (verde quando presente). Nome distinto de `InitialAvatar`
/// (Features/Conversations) para não colidir no módulo.
private struct SettingsAvatar: View {
    let text: String
    let active: Bool

    private var initial: String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(active ? Color.green.opacity(0.18) : Color.secondary.opacity(0.15))
            Text(initial)
                .font(.headline)
                .foregroundStyle(active ? Color.green : Color.secondary)
        }
        .frame(width: 36, height: 36)
    }
}
