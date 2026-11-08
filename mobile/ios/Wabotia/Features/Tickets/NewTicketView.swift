import SwiftUI

/// Abrir protocolo para uma conversa: título obrigatório (até 300 caracteres) → POST /profiles/{p}/tickets.
/// Ao criar, empilha o protocolo (TicketView) e, quando a pessoa volta, esta tela se fecha sozinha,
/// voltando direto à conversa.
struct NewTicketView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    let conversationId: String

    @State private var title = ""
    @State private var busy = false
    @State private var error: String?
    @State private var created: Ticket?
    @State private var showCreated = false
    @State private var didAutoDismiss = false
    /// Uma chave por intenção; mantida se a rede falhar, para repetir o mesmo pedido.
    @State private var idempotencyKey = APIClient.newIdempotencyKey()
    @FocusState private var focused: Bool

    private static let titleLimit = 300
    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Form {
            Section {
                AppMultilineField("Resumo da solicitação", text: $title, lines: 2...5)
                    .focused($focused)
                    .onChange(of: title) { value in
                        if value.count > Self.titleLimit { title = String(value.prefix(Self.titleLimit)) }
                    }
                HStack {
                    Spacer()
                    Text("\(title.count)/\(Self.titleLimit)")
                        .font(.caption)
                        .foregroundStyle(title.count >= Self.titleLimit ? Color.orange : Color.secondary)
                }
            } header: {
                Text("Título")
            } footer: {
                Text("O protocolo recebe um número WA-… e fica vinculado a esta conversa. Você precisa ter assumido a conversa.")
            }
            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            Section {
                Button(action: create) {
                    if busy {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Abrir protocolo").frame(maxWidth: .infinity)
                    }
                }
                .disabled(busy || trimmedTitle.isEmpty)
            }
        }
        .navigationTitle("Novo protocolo")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationDestination(isPresented: $showCreated) {
            if let created {
                TicketView(ticketId: created.id)
            }
        }
        .onAppear {
            // Voltou do protocolo recém-criado: sai da tela de criação.
            if created != nil, !didAutoDismiss {
                didAutoDismiss = true
                dismiss()
            } else if created == nil {
                focused = true
            }
        }
    }

    private func create() {
        guard let profile = container.profileId, !busy else { return }
        busy = true
        error = nil
        let body = TicketCreate(conversation_id: conversationId, title: trimmedTitle)
        let key = idempotencyKey
        Task { @MainActor in
            do {
                let ticket = try await container.api.createTicket(profile, body, key: key)
                created = ticket
                busy = false
                showCreated = true
            } catch {
                busy = false
                if let apiError = error as? APIError {
                    if apiError.isUnauthorized { container.handleUnauthorized(); return }
                    if apiError.isIdempotencyConflict {
                        // Mesma chave com outro título: nova intenção, nova chave.
                        idempotencyKey = APIClient.newIdempotencyKey()
                        self.error = "O pedido anterior foi registrado com outro conteúdo. Tente novamente."
                        return
                    }
                    // Erro de validação ou permissão: o servidor já respondeu; a próxima tentativa é um novo pedido.
                    idempotencyKey = APIClient.newIdempotencyKey()
                }
                // Falha de rede mantém a mesma chave: repetir é seguro.
                self.error = APIError.describe(error)
            }
        }
    }
}
