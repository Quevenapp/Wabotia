import SwiftUI
import UIKit

// Segundo fator (docs/API.md, "Login e segundo fator", `feat/login-mfa`): login em duas etapas, elevação sob demanda
// (`403 mfa_required` → "Confirme que é você" → `POST /api/v1/account/mfa/challenge` → repetir), cadastro do aplicativo
// autenticador e a política `all` (sessão sem fator restrita: o app leva ao código ou ao cadastro, sem deslogar).

/// Resposta de `POST /api/v1/account/mfa/enroll`.
struct MFAEnrollment: Codable, Equatable { var factor_id: String; var secret: String; var otpauth_url: String }
/// Resposta de `POST /api/v1/account/mfa/verify` e de `…/recovery-codes`.
struct MFARecovery: Codable, Equatable { var aal: Int?; var recovery_codes: [String] }

/// As rotas da conta usadas pelo app.
@MainActor
protocol SecondFactorVerifying: AnyObject {
    /// Sobe a sessão para aal2. Lança `APIError` (`invalid_code`, `mfa_locked`) quando o código não vale.
    func verify(code: String?, recoveryCode: String?) async throws
}

@MainActor
protocol SecondFactorAccount: SecondFactorVerifying {
    func status() async throws -> MFAState
    func enroll(password: String) async throws -> MFAEnrollment
    func confirmEnrollment(factorId: String, code: String) async throws -> MFARecovery
    func newRecoveryCodes() async throws -> MFARecovery
}

@MainActor
final class LiveSecondFactor: SecondFactorAccount {
    static let challengeRoute = "api/v1/account/mfa/challenge"
    let api: APIClient
    init(api: APIClient) { self.api = api }

    func verify(code: String?, recoveryCode: String?) async throws {
        var body: [String: String] = [:]
        if let code { body["code"] = code }
        if let recoveryCode { body["recovery_code"] = recoveryCode }
        _ = try await api.raw(.post, Self.challengeRoute, body: try JSONEncoder.wabotia.encode(body), contentType: "application/json",
                              key: APIClient.newIdempotencyKey())
    }

    func status() async throws -> MFAState { (try await api.me()).mfa ?? MFAState() }

    func enroll(password: String) async throws -> MFAEnrollment {
        try await api.request(.post, "api/v1/account/mfa/enroll", body: ["password": password], key: APIClient.newIdempotencyKey())
    }

    func confirmEnrollment(factorId: String, code: String) async throws -> MFARecovery {
        try await api.request(.post, "api/v1/account/mfa/verify", body: ["factor_id": factorId, "code": code], key: APIClient.newIdempotencyKey())
    }

    func newRecoveryCodes() async throws -> MFARecovery {
        try await api.request(.post, "api/v1/account/mfa/recovery-codes", body: [String: String](), key: APIClient.newIdempotencyKey())
    }
}

/// A porta central do `403 mfa_required`: qualquer tela que não trate o código ela mesma (como os cartões do bot, que
/// repetem o toque) leva a pessoa a "Confirme que é você" (com fator) ou ao cadastro (sem fator), sem deslogar.
@MainActor
final class MFAGate: ObservableObject {
    static let shared = MFAGate()

    enum Prompt: String, Identifiable { case challenge, enroll; var id: String { rawValue } }

    /// Dentro de uma ação que pede o código ela mesma, a porta central não abre outra janela.
    @TaskLocal nonisolated static var handledLocally = false

    @Published var prompt: Prompt?
    /// Situação conhecida (do login, do refresh ou de `/me`).
    @Published private(set) var state: MFAState?
    @Published private(set) var aal: Int?
    private var dismissedAt: Date?

    /// Chamado em toda recusa HTTP do app.
    nonisolated static func report(status: Int, code: String) {
        guard status == 403, code == "mfa_required", !handledLocally else { return }
        Task { @MainActor in await shared.required() }
    }

    func remember(_ state: MFAState?, aal: Int?) {
        if let state { self.state = state }
        if let aal { self.aal = aal }
        // Instalação com a política `all` e a pessoa sem fator: o cadastro aparece logo depois do login.
        if state?.next == "enroll" { prompt = .enroll }
    }

    /// `403 mfa_required` fora de uma ação que trata o código: decide entre o desafio e o cadastro (`/me` responde em aal1).
    func required() async {
        guard prompt == nil, AppContainer.shared.isLoggedIn else { return }
        if let at = dismissedAt, Date().timeIntervalSince(at) < 20 { return }
        if let me = try? await AppContainer.shared.api.me() {
            state = me.mfa ?? state
            aal = me.aal ?? aal
        }
        prompt = state?.factor == false ? .enroll : .challenge
    }

    func dismissed() {
        prompt = nil
        dismissedAt = Date()
    }

    /// Código aceito: a sessão está em aal2; as telas releem o que foi recusado.
    func confirmed() {
        prompt = nil
        aal = 2
        if state?.factor != true { state = MFAState(policy: state?.policy, factor: true, next: nil) }
        Task {
            await Workspace.shared.refreshNow()
            await ModuleFeature.shared.refresh(container: .shared, force: true)
        }
    }

    func reset() {
        prompt = nil
        state = nil
        aal = nil
        dismissedAt = nil
    }
}

/// "Confirme que é você": o código do autenticador (6 números) ou um código de recuperação.
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
            SheetHeader(title: "Confirme que é você", onClose: onClose)
            Text("Esta ação pede o segundo fator. Digite o código de 6 números do seu aplicativo autenticador. A confirmação vale 7 dias neste aparelho.")
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
                        self.error = MFAText.describe(error)
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

enum MFAText {
    /// As recusas do segundo fator em português (a mensagem do servidor quando vier).
    static func describe(_ error: Error) -> String {
        guard let e = error as? APIError else { return APIError.describe(error) }
        switch e.code {
        case "invalid_code": return "Código incorreto ou já usado. Confira o horário do aparelho e tente o código seguinte."
        case "mfa_locked": return "Muitos códigos errados. Espere 15 minutos e tente de novo."
        case "outside_schedule": return e.message.isEmpty ? "Fora do seu horário de acesso." : e.message
        default: return e.message
        }
    }
}

/// Novos códigos de recuperação (exige a sessão em aal2: pede o código aqui mesmo e repete).
struct MFARecoveryCodesSheet: View {
    let account: SecondFactorAccount
    let onClose: () -> Void
    @State private var codes: [String]?
    @State private var busy = false
    @State private var error: String?
    @State private var challenge = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Códigos de recuperação", onClose: onClose)
            if let codes {
                DeviceNotice(text: "Códigos novos: os anteriores deixaram de valer. Guarde estes num lugar seguro; eles não aparecem de novo.", color: Theme.ok)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(codes, id: \.self) { Text($0).font(.system(size: 16, design: .monospaced)).foregroundStyle(Theme.textPrimary) }
                }
                .textSelection(.enabled)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                SecondaryButton(title: copied ? "Códigos copiados" : "Copiar os códigos", icon: "doc.on.doc") {
                    UIPasteboard.general.string = codes.joined(separator: "\n")
                    copied = true
                }
            } else {
                Text("Gera 10 códigos novos, de uso único, para entrar se você perder o aparelho com o autenticador. Os códigos anteriores deixam de valer.")
                    .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                if let error { InlineError(text: error) }
                PrimaryButton(title: "Gerar novos códigos", busy: busy, action: generate)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .sheet(isPresented: $challenge) {
            SecondFactorSheet(verifier: account) { challenge = false; MFAGate.shared.confirmed(); generate() } onClose: { challenge = false }
        }
    }

    private func generate() {
        busy = true
        error = nil
        Task {
            do {
                codes = try await MFAGate.$handledLocally.withValue(true) { try await account.newRecoveryCodes() }.recovery_codes
            } catch let e as APIError where e.status == 403 && e.code == "mfa_required" {
                challenge = true
            } catch {
                self.error = MFAText.describe(error)
            }
            busy = false
        }
    }
}

/// Cadastro do aplicativo autenticador (Ajustes → Segurança, ou depois do login quando a instalação exige): a senha, o
/// QR (ou a chave para digitar), o primeiro código e os 10 códigos de recuperação, mostrados uma vez só.
struct MFAEnrollView: View {
    let account: SecondFactorAccount
    let onDone: () -> Void
    let onClose: () -> Void
    @Environment(\.openURL) private var openURL
    @State private var password = ""
    @State private var enrollment: MFAEnrollment?
    @State private var code = ""
    @State private var codes: [String]?
    @State private var busy = false
    @State private var error: String?
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SheetHeader(title: "Aplicativo autenticador", onClose: codes == nil ? onClose : nil)
                if let codes {
                    recoveryStep(codes)
                } else if let enrollment {
                    qrStep(enrollment)
                } else {
                    passwordStep
                }
                if let error { InlineError(text: error) }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .background(Theme.background.ignoresSafeArea())
        .interactiveDismissDisabled(codes != nil)
        #if DEBUG
        .onAppear {
            // WABOTIA_DEMO=mfa com WABOTIA_DEMO_ACTION=qr (ou codes): o cadastro já no QR (ou nos códigos de recuperação).
            guard enrollment == nil, let action = DemoMode.action, ["qr", "codes"].contains(action) else { return }
            run {
                let e = try await account.enroll(password: "demo")
                enrollment = e
                if action == "codes" { codes = try await account.confirmEnrollment(factorId: e.factor_id, code: DemoBotActions.mfaCode).recovery_codes }
            }
        }
        #endif
    }

    private var passwordStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("O segundo fator protege a conta: além da senha, entrar e algumas ações pedem o código de 6 números de um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password, o app Senhas do iPhone…).")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            AuthField(label: "Sua senha", error: error != nil) {
                SecureField("Para confirmar que é você", text: $password).textContentType(.password).accessibilityIdentifier("mfa.password")
            }
            PrimaryButton(title: "Continuar", busy: busy, disabled: password.isEmpty) {
                run { enrollment = try await account.enroll(password: password); password = "" }
            }
        }
    }

    private func qrStep(_ e: MFAEnrollment) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("1. Leia o QR no aplicativo autenticador, ou toque em Abrir no autenticador. Sem câmera, digite a chave.")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            if let image = QRCode.image(e.otpauth_url) {
                Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                    .frame(width: 200, height: 200).padding(10).background(Color.white)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("QR do aplicativo autenticador")
            }
            SecondaryButton(title: "Abrir no autenticador", icon: "key.fill") { if let url = URL(string: e.otpauth_url) { openURL(url) } }
            HStack {
                Text(Self.grouped(e.secret)).font(.system(size: 15, design: .monospaced)).foregroundStyle(Theme.textPrimary).textSelection(.enabled)
                Spacer()
                Button(copied ? "Copiada" : "Copiar chave") { UIPasteboard.general.string = e.secret; copied = true }
                    .font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand)
            }
            .padding(12).background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            Text("2. Digite o código que o autenticador mostra.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
            AuthField(label: "Código", error: error != nil) {
                TextField("000000", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode).accessibilityIdentifier("mfa.enroll.code")
            }
            PrimaryButton(title: "Ativar", busy: busy, disabled: code.trimmingCharacters(in: .whitespaces).count != 6) {
                run { codes = try await account.confirmEnrollment(factorId: e.factor_id, code: code.trimmingCharacters(in: .whitespaces)).recovery_codes }
            }
        }
    }

    private func recoveryStep(_ codes: [String]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            DeviceNotice(text: "Segundo fator ativado. Guarde estes códigos de recuperação num lugar seguro: cada um vale uma vez, se você perder o aparelho. Eles não aparecem de novo.", color: Theme.ok)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(codes, id: \.self) { Text($0).font(.system(size: 16, design: .monospaced)).foregroundStyle(Theme.textPrimary) }
            }
            .textSelection(.enabled)
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .accessibilityIdentifier("mfa.recovery")
            SecondaryButton(title: copied ? "Códigos copiados" : "Copiar os códigos", icon: "doc.on.doc") {
                UIPasteboard.general.string = codes.joined(separator: "\n")
                copied = true
            }
            Text("As outras sessões desta conta foram encerradas; neste aparelho você continua.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            PrimaryButton(title: "Concluir", action: onDone).accessibilityIdentifier("mfa.done")
        }
    }

    /// "JBSW Y3DP EHPK 3PXP".
    static func grouped(_ secret: String) -> String {
        stride(from: 0, to: secret.count, by: 4).map { i -> String in
            let start = secret.index(secret.startIndex, offsetBy: i)
            return String(secret[start..<(secret.index(start, offsetBy: 4, limitedBy: secret.endIndex) ?? secret.endIndex)])
        }.joined(separator: " ")
    }

    private func run(_ body: @escaping () async throws -> Void) {
        busy = true
        error = nil
        copied = false
        Task {
            do { try await body() } catch { self.error = MFAText.describe(error) }
            busy = false
        }
    }
}
