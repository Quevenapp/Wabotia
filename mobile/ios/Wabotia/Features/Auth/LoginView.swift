import SwiftUI
import UIKit

struct LoginView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?
    /// O servidor pediu o segundo fator: o mesmo pedido vai de novo com `totp` ou `recovery_code`.
    @State private var needsCode = false
    @State private var code = ""
    @State private var recovery = false
    private enum Field { case email, password, code }
    @FocusState private var focus: Field?

    private var cleanCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var codeValid: Bool { recovery ? cleanCode.count >= 6 : (cleanCode.count == 6 && cleanCode.allSatisfy(\.isNumber)) }

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
            if needsCode {
                // Segunda etapa: a pessoa tem segundo fator (401 mfa_required na primeira).
                AuthField(label: recovery ? "Código de recuperação" : "Código do aplicativo autenticador", error: error != nil) {
                    TextField(recovery ? "Código de recuperação" : "000000", text: $code)
                        .keyboardType(recovery ? .asciiCapable : .numberPad)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .code)
                        .accessibilityIdentifier("login.code")
                }
                Button(recovery ? "Usar o código do autenticador" : "Usar um código de recuperação") { recovery.toggle(); code = ""; error = nil }
                    .font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                    .frame(maxWidth: .infinity, minHeight: Theme.touch)
            }
            if let error { InlineError(text: error) }
            PrimaryButton(title: needsCode ? "Confirmar código" : "Entrar", busy: busy,
                          disabled: email.isEmpty || password.isEmpty || (needsCode && !codeValid), action: login)
            Button("Voltar") { container.loginChosen = false }
                .font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
                .disabled(busy)
            Button("Trocar servidor") { container.onLoggedOut(keepServer: false) }
                .font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
                .disabled(busy)
            Text("Use a conta cadastrada em Pessoas no painel. A senha não fica no aparelho: só um token de sessão de 30 dias, guardado no Keychain.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
        }
        #if DEBUG
        .onAppear {
            // WABOTIA_DEMO=login-mfa: a conta da demonstração com segundo fator (senha "mfa"), até o pedido do código.
            if DemoMode.launchScreen == "login-mfa", email.isEmpty {
                email = DemoMode.meEmail
                password = "mfa"
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { login() }
            }
        }
        #endif
    }

    private func login() {
        guard let server, !busy, !email.isEmpty, !password.isEmpty, !needsCode || codeValid else { return }
        busy = true; error = nil
        Task {
            do {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
                let device = DeviceInfo(name: String(UIDevice.current.name.prefix(80)), app_version: version)
                var request = MobileLoginRequest(email: email.trimmingCharacters(in: .whitespaces).lowercased(), password: password, device: device)
                if needsCode {
                    if recovery { request.recovery_code = cleanCode } else { request.totp = cleanCode }
                }
                let result = try await container.client(for: server).mobileLogin(request)
                container.onLoggedIn(server: server, result: result)
                _ = await PushManager.shared.requestPermission()
            } catch let e as APIError where LoginStep.needsCode(e) {
                // Nenhuma sessão foi criada: mostra o campo do código e manda o mesmo pedido de novo.
                needsCode = true
                focus = .code
            } catch {
                self.error = MFAText.describe(error)
                if needsCode { code = "" }
            }
            busy = false
        }
    }
}

enum LoginStep {
    /// `401 mfa_required`: a pessoa tem segundo fator e o login pede o código.
    static func needsCode(_ error: APIError) -> Bool { error.status == 401 && error.code == "mfa_required" }
}
