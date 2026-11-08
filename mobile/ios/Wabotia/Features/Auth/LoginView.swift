import SwiftUI
import UIKit

struct LoginView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?

    private var server: URL? { container.session.serverURL }

    var body: some View {
        AppNavigationStack {
            Form {
                Section {
                    HStack {
                        Text("Servidor")
                        Spacer()
                        Text(server?.host ?? "").foregroundStyle(.secondary).lineLimit(1)
                    }
                    Button("Trocar servidor") { container.onLoggedOut(keepServer: false) }.disabled(busy)
                }
                Section("Conta de atendente") {
                    TextField("E-mail", text: $email)
                        .keyboardType(.emailAddress).textContentType(.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    HStack {
                        if showPassword { TextField("Senha", text: $password).textContentType(.password) }
                        else { SecureField("Senha", text: $password).textContentType(.password) }
                        Button { showPassword.toggle() } label: { Image(systemName: showPassword ? "eye.slash" : "eye") }
                            .buttonStyle(.borderless)
                    }
                    .onSubmit(login)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                Section {
                    Button(action: login) {
                        if busy { ProgressView().frame(maxWidth: .infinity) } else { Text("Entrar").frame(maxWidth: .infinity) }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                } footer: {
                    Text("Use a conta cadastrada em Pessoas no painel. A senha não é guardada no aparelho; apenas um token de sessão de 30 dias, no Keychain.")
                }
            }
            .navigationTitle("Entrar")
        }
    }

    private func login() {
        guard let server else { return }
        busy = true; error = nil
        Task {
            do {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
                let device = DeviceInfo(name: String(UIDevice.current.name.prefix(80)), app_version: version)
                let result = try await container.client(for: server).mobileLogin(MobileLoginRequest(email: email.trimmingCharacters(in: .whitespaces).lowercased(), password: password, device: device))
                container.onLoggedIn(server: server, result: result)
                _ = await PushManager.shared.requestPermission()
            } catch {
                self.error = APIError.describe(error)
            }
            busy = false
        }
    }
}
