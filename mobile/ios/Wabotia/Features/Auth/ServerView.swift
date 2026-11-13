import SwiftUI

/// Moldura das telas de entrada (servidor, login, perfil): marca no topo, um cartão com os campos,
/// botão principal em largura total e textos de ajuda curtos.
struct AuthScaffold<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                BrandTile(size: 76).padding(.top, 28)
                Text(title).font(Theme.font(26, .bold)).foregroundStyle(Theme.brand).padding(.top, 14)
                Text(subtitle)
                    .font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4).padding(.horizontal, 12)
                VStack(alignment: .leading, spacing: 14) { content() }
                    .padding(.top, 22)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
    }
}

/// Campo dentro de um cartão `surface`, com rótulo pequeno em cima.
struct AuthField<Field: View>: View {
    let label: String
    var error = false
    @ViewBuilder var field: () -> Field

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
            HStack(spacing: 4) { field() }
                .font(Theme.font(16))
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(error ? Theme.danger : Theme.divider, lineWidth: 1))
        }
    }
}

/// Primeira tela: a pessoa informa o endereço da SUA instalação Wabotia.
struct ServerView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.openURL) private var openURL
    @State private var input = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        AuthScaffold(title: "Wabotia", subtitle: "Atendimento pelo WhatsApp com a sua equipe e os seus bots.") {
            AuthField(label: "Endereço do seu servidor", error: error != nil) {
                Text("https://").foregroundStyle(Theme.textSecondary)
                TextField("wabotia.suaempresa.com.br", text: $input)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit(connect)
            }
            if let error { InlineError(text: error) }
            PrimaryButton(title: "Conectar", busy: busy, disabled: input.trimmingCharacters(in: .whitespaces).isEmpty, action: connect)
            Text("Cada empresa tem a própria instalação. Use o mesmo endereço do painel, por exemplo wabotia.suaempresa.com.br.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            Button("Política de privacidade") { openURL(AppLinks.privacyPolicy) }
                .font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
        }
        .onAppear {
            input = container.session.serverURL?.host ?? ""
            #if DEBUG
            // WABOTIA_DEMO=typed: percorre o mesmo caminho de quem digita "demo" e toca em Conectar.
            if DemoMode.launchScreen == "typed", DemoMode.pendingScreen == "typed" {
                DemoMode.pendingScreen = "conversations"
                input = "demo"
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { connect() }
            }
            #endif
        }
    }

    private func connect() {
        #if DEBUG
        if DemoMode.wantsDemo(input) {
            DemoMode.signIn(container)
            return
        }
        #endif
        guard let url = SessionStore.normalizeServer(input) else {
            error = "Digite um endereço válido, por exemplo wabotia.suaempresa.com.br"
            return
        }
        busy = true; error = nil
        Task {
            do {
                let client = container.client(for: url)
                let health = try await client.health()
                guard health.service == "wabotia" else { throw APIError(status: 200, code: "not_wabotia", message: "Este endereço não é um servidor Wabotia.") }
                let status = try await client.authStatus()
                guard status.initialized else { throw APIError(status: 200, code: "setup_required", message: "Este servidor ainda não tem administrador. Conclua a instalação pelo navegador em \(url.absoluteString)/app.") }
                container.session.serverURL = url
                container.objectWillChange.send()
            } catch {
                self.error = APIError.describe(error)
            }
            busy = false
        }
    }
}
