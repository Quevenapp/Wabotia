import SwiftUI

/// Abrir protocolo para uma conversa: título obrigatório (até 300 caracteres) → POST /profiles/{p}/tickets.
/// Ao criar, empilha o protocolo (TicketView) e, quando a pessoa volta, esta tela se fecha sozinha,
/// voltando direto à conversa.
struct NewTicketView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.pushRoute) private var push
    let conversationId: String

    @State private var title = ""
    /// Categoria (aplicativo ou assunto): opcional, só oferecida quando o perfil tem categorias (servidor 0.14+).
    @State private var category: String?
    @ObservedObject private var workspace = Workspace.shared
    @State private var busy = false
    @State private var error: String?
    @State private var created: Ticket?
    @State private var didAutoDismiss = false
    /// Uma chave por intenção; mantida se a rede falhar, para repetir o mesmo pedido.
    @State private var idempotencyKey = APIClient.newIdempotencyKey()
    @FocusState private var focused: Bool

    private static let titleLimit = 300
    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var offeredCategories: [TicketCategory] { workspace.ticketCategories.filter(\.enabled) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text.fill").font(.system(size: 20)).foregroundStyle(Theme.onBrand)
                        .frame(width: 48, height: 48).background(Circle().fill(Theme.ticket))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Novo protocolo").font(Theme.font(18, .bold)).foregroundStyle(Theme.textPrimary)
                        Text("Recebe um número WA-… e fica ligado a esta conversa.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(alignment: .trailing, spacing: 4) {
                    field
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.divider, lineWidth: 1))
                        .onChange(of: title) { value in
                            if value.count > Self.titleLimit { title = String(value.prefix(Self.titleLimit)) }
                        }
                    Text("\(title.count)/\(Self.titleLimit)")
                        .font(Theme.font(12))
                        .foregroundStyle(title.count >= Self.titleLimit ? Theme.warn : Theme.textSecondary)
                }
                if !offeredCategories.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Categoria").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                        Text("Aplicativo ou assunto da solicitação. Opcional.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                        TicketCategoryChips(categories: offeredCategories, selection: $category, disabled: busy)
                            .onChange(of: category) { _ in idempotencyKey = APIClient.newIdempotencyKey() }
                    }
                }
                if let error { InlineError(text: error) }
                PrimaryButton(title: "Abrir protocolo", icon: "doc.text.fill", busy: busy, color: Theme.ticket, disabled: trimmedTitle.isEmpty, action: create)
                Text("Você precisa ter assumido a conversa. O prazo da primeira resposta segue a configuração do perfil.")
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Abrir protocolo")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
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

    @ViewBuilder private var field: some View {
        if #available(iOS 16, *) {
            AppMultilineField("Resumo da solicitação", text: $title, lines: 2...5, font: Theme.font(16))
                .focused($focused).padding(.horizontal, 14).padding(.vertical, 12)
        } else {
            AppMultilineField("Resumo da solicitação", text: $title, lines: 2...5, font: Theme.font(16))
                .focused($focused).padding(.horizontal, 9).padding(.vertical, 4)
        }
    }

    private func create() {
        guard let profile = container.profileId, !busy else { return }
        busy = true
        error = nil
        let chosen = category.flatMap { id in offeredCategories.contains { $0.id == id } ? id : nil }
        let body = TicketCreate(conversation_id: conversationId, title: trimmedTitle, category: chosen)
        let key = idempotencyKey
        Task { @MainActor in
            do {
                let ticket = try await container.api.createTicket(profile, body, key: key)
                created = ticket
                busy = false
                Workspace.shared.addLocalEvent("ticket", "Protocolo \(ticket.number) aberto", to: conversationId)
                Workspace.shared.show("Protocolo \(ticket.number) aberto", style: .success)
                await Workspace.shared.refreshTicketCounts()
                push(.ticket(id: ticket.id))
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
