import SwiftUI

/// Primeira tela: a pessoa informa o endereço da SUA instalação Wabotia.
struct ServerView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var input = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        AppNavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(spacing: 8) {
                        Image(systemName: "server.rack").font(.system(size: 56)).foregroundStyle(.tint)
                        Text("Wabotia").font(.largeTitle.bold())
                        Text("Atendimento WhatsApp com IA e equipe humana").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)

                    Text("Endereço do seu servidor").font(.headline).padding(.top, 16)
                    Text("Cada empresa tem a própria instalação Wabotia. Informe o endereço que você usa para abrir o painel.")
                        .font(.footnote).foregroundStyle(.secondary)
                    HStack(spacing: 0) {
                        Text("https://").foregroundStyle(.secondary)
                        TextField("wabotia.suaempresa.com.br", text: $input)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .focused($focused)
                            .onSubmit(connect)
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).stroke(error == nil ? Color.secondary.opacity(0.4) : Color.red))

                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }

                    Button(action: connect) {
                        if busy { ProgressView().frame(maxWidth: .infinity) } else { Text("Conectar").frame(maxWidth: .infinity) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || input.trimmingCharacters(in: .whitespaces).isEmpty)

                    Text("Exemplos: wabotia.queven.com.br, wabotia.fagoo.com.br. Use sempre HTTPS em produção.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .onAppear { input = container.session.serverURL?.host ?? ""; focused = true }
        }
    }

    private func connect() {
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
