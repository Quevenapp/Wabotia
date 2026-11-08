import SwiftUI

/// Transferir a conversa: lista a equipe do perfil com presença (GET /presence).
struct TransferSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var target: PresenceEntry?
    @State private var busy = false

    private var candidates: [PresenceEntry] {
        vm.presence.filter { $0.actor != vm.meId }.sorted { a, b in
            if (a.present ?? 0) != (b.present ?? 0) { return (a.present ?? 0) > (b.present ?? 0) }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if candidates.isEmpty {
                    EmptyStateView(title: "Ninguém para transferir", systemImage: "person.2.slash", message: "Nenhum outro atendente está vinculado a este perfil.")
                } else {
                    ForEach(candidates) { p in
                        Button {
                            target = p
                        } label: {
                            HStack {
                                Circle().fill((p.present ?? 0) == 1 ? Color.green : Color.gray).frame(width: 10, height: 10)
                                VStack(alignment: .leading) {
                                    Text(p.name.isEmpty ? p.actor : p.name).foregroundStyle(.primary)
                                    Text((p.present ?? 0) == 1 ? "Presente" : "Ausente").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if target?.actor == p.actor { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                }
                if let e = vm.actionError { Section { Text(e).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Transferir para")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        guard let target else { return }
                        busy = true
                        Task {
                            if await vm.act("transfer", target: target.actor) { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Transferir") } }
                    .disabled(target == nil || busy)
                }
            }
            .task { await vm.loadPresence() }
        }
    }
}

/// Etiquetas da conversa (até 20, 40 caracteres cada).
struct TagsSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var tags: [String] = []
    @State private var newTag = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("Nova etiqueta", text: $newTag).onSubmit(add)
                        Button("Adicionar", action: add).disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty || tags.count >= 20)
                    }
                } footer: { Text("Até 20 etiquetas com 40 caracteres cada.") }
                Section {
                    if tags.isEmpty { Text("Nenhuma etiqueta").foregroundStyle(.secondary) }
                    ForEach(tags, id: \.self) { Text($0) }
                        .onDelete { tags.remove(atOffsets: $0) }
                }
                if let e = vm.actionError { Section { Text(e).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Etiquetas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        busy = true
                        Task {
                            if await vm.act("tags", tags: tags) { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Salvar") } }
                    .disabled(busy)
                }
            }
            .onAppear { tags = vm.tags }
        }
    }

    private func add() {
        let t = String(newTag.trimmingCharacters(in: .whitespaces).prefix(40))
        guard !t.isEmpty, !tags.contains(t), tags.count < 20 else { return }
        tags.append(t)
        newTag = ""
    }
}

/// Escolha de bot habilitado (GET /bots) para consultar com o contexto da conversa.
struct BotPickerSheet: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    var onPick: (Bot) -> Void
    @State private var bots: [Bot]?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    EmptyStateView(title: "Não foi possível carregar", systemImage: "exclamationmark.triangle", message: error)
                } else if let bots {
                    if bots.isEmpty {
                        EmptyStateView(title: "Nenhum bot habilitado", systemImage: "cpu", message: "Habilite bots da Equipe Bot neste perfil pelo painel.")
                    } else {
                        List(bots) { bot in
                            Button {
                                onPick(bot)
                                dismiss()
                            } label: {
                                Label(bot.name.isEmpty ? bot.id : bot.name, systemImage: "cpu").foregroundStyle(.primary)
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Consultar bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } } }
            .task {
                guard let p = container.profileId else { return }
                do { bots = try await container.api.bots(p).data.filter { ($0.enabled ?? 0) == 1 } }
                catch {
                    if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized() }
                    self.error = APIError.describe(error)
                }
            }
        }
    }
}

/// Salvar/vincular o cliente na agenda (PUT /conversations/{id}/contact).
struct SaveContactSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var phone = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Nome", text: $name)
                    TextField("Telefone", text: $phone).keyboardType(.phonePad)
                } footer: {
                    Text("Cria o contato na agenda do perfil e vincula a esta conversa.")
                }
                if let e = vm.actionError { Section { Text(e).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Salvar contato")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        busy = true
                        Task {
                            if await vm.saveContact(name: name.trimmingCharacters(in: .whitespaces), phone: AttachmentFactory.normalizePhone(phone)) { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Salvar") } }
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                name = vm.linkedContactName ?? vm.conversation?.contact_name ?? ""
                phone = vm.linkedContactPhone ?? vm.conversation?.phone ?? ""
            }
        }
    }
}
