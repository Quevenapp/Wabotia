import SwiftUI

/// Ponto de encaixe do segundo fator: uma ação sensível respondeu `403 mfa_required`; o app pede o código do
/// autenticador, sobe a sessão (aal2 por um tempo) e repete o toque. Não há token por operação.
/// PROVISÓRIO: rota e campos seguem o que `feat/bot-acoes` cita (`POST /api/v1/account/mfa/challenge` com `{code}` ou
/// `{recovery_code}`); o contrato completo vem em "Login e segundo fator" (`feat/login-mfa`).
@MainActor
protocol SecondFactorVerifying: AnyObject {
    /// Lança `APIError` com a mensagem do servidor quando o código não vale.
    func verify(code: String?, recoveryCode: String?) async throws
}

@MainActor
final class LiveSecondFactor: SecondFactorVerifying {
    static let route = "api/v1/account/mfa/challenge"
    let api: APIClient
    init(api: APIClient) { self.api = api }

    func verify(code: String?, recoveryCode: String?) async throws {
        var body: [String: String] = [:]
        if let code { body["code"] = code }
        if let recoveryCode { body["recovery_code"] = recoveryCode }
        _ = try await api.raw(.post, Self.route, body: try JSONEncoder.wabotia.encode(body), contentType: "application/json",
                              key: APIClient.newIdempotencyKey())
    }
}

/// O código do autenticador (6 números) ou um código de recuperação.
struct SecondFactorSheet: View {
    let verifier: SecondFactorVerifying
    /// Chamado depois de o servidor aceitar o código: a tela repete a ação.
    let onVerified: () -> Void
    let onClose: () -> Void
    @State private var code = ""
    @State private var recovery = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var clean: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { recovery ? clean.count >= 6 : (clean.count == 6 && clean.allSatisfy(\.isNumber)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Código do autenticador", onClose: onClose)
            Text("Esta ação pede o segundo fator. Digite o código de 6 números do seu app autenticador; a confirmação é repetida em seguida.")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            AuthField(label: recovery ? "Código de recuperação" : "Código", error: error != nil) {
                TextField(recovery ? "Código de recuperação" : "000000", text: $code)
                    .keyboardType(recovery ? .asciiCapable : .numberPad)
                    .textContentType(.oneTimeCode)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focused)
                    .accessibilityIdentifier("mfa.code")
            }
            if let error { InlineError(text: error) }
            PrimaryButton(title: "Confirmar", busy: busy, disabled: !valid) {
                busy = true
                error = nil
                Task {
                    do {
                        try await verifier.verify(code: recovery ? nil : clean, recoveryCode: recovery ? clean : nil)
                        onVerified()
                    } catch {
                        self.error = APIError.describe(error)
                    }
                    busy = false
                }
            }
            Button(recovery ? "Usar o código do autenticador" : "Usar um código de recuperação") { recovery.toggle(); code = ""; error = nil }
                .font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
        .onAppear { focused = true }
    }
}
