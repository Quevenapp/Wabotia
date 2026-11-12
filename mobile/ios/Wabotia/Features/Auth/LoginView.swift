import SwiftUI
import UIKit

struct LoginView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?
    private enum Field { case email, password }
    @FocusState private var focus: Field?

    private var server: URL? { container.session.serverURL }

    var body: some View {
        AuthScaffold(title: "Entrar", subtitle: server?.host ?? "") {
            AuthField(label: "E-mail") {
                TextField("voce@empresa.com.br", text: $email)
                    .keyboardType(.emailAddress).textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            AuthField(label: "Senha", error: error != nil) {
                Group {
                    if showPassword { TextField("Sua senha", text: $password) } else { SecureField("Sua senha", text: $password) }
                }
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focus, equals: .password)
                .onSubmit(login)
                Button { showPassword.toggle() } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(Theme.textSecondary).frame(width: 36, height: Theme.touch)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showPassword ? "Ocultar senha" : "Mostrar senha")
            }
            if let error { InlineError(text: error) }
            PrimaryButton(title: "Entrar", busy: busy, disabled: email.isEmpty || password.isEmpty, action: login)
            Button("Trocar servidor") { container.onLoggedOut(keepServer: false) }
                .font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
                .disabled(busy)
            Text("Use a conta cadastrada em Pessoas no painel. A senha não fica no aparelho: só um token de sessão de 30 dias, guardado no Keychain.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func login() {
        guard let server, !busy, !email.isEmpty, !password.isEmpty else { return }
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
