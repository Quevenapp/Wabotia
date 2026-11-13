import SwiftUI

/// Etiquetas da conversa em pílulas (até 20, 40 caracteres cada).
struct TagsSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var tags: [String] = []
    @State private var newTag = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    private var trimmed: String { newTag.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Etiquetas", subtitle: vm.displayName) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        TextField("Nova etiqueta", text: $newTag)
                            .font(Theme.font(16))
                            .focused($focused)
                            .submitLabel(.done)
                            .onSubmit(add)
                            .padding(.horizontal, 12)
                            .frame(height: 44)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
                        Button(action: add) {
                            Image(systemName: "plus").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.onBrand)
                                .frame(width: 44, height: 44).background(Circle().fill(Theme.brand))
                        }
                        .buttonStyle(.plain)
                        .disabled(trimmed.isEmpty || tags.count >= 20)
                        .opacity(trimmed.isEmpty || tags.count >= 20 ? 0.4 : 1)
                        .accessibilityLabel("Adicionar etiqueta")
                    }
                    if tags.isEmpty {
                        Text("Nenhuma etiqueta. Use etiquetas para agrupar conversas por assunto.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(tags, id: \.self) { tag in
                                HStack {
                                    Pill(text: tag, color: Theme.brand, icon: "tag.fill")
                                    Spacer()
                                    Button { tags.removeAll { $0 == tag } } label: {
                                        Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSecondary)
                                            .frame(width: 26, height: 26).background(Circle().fill(Theme.muted.opacity(0.18)))
                                            .frame(width: Theme.touch, height: Theme.touch)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Remover etiqueta \(tag)")
                                }
                                .padding(.leading, 12)
                                .overlay(alignment: .bottom) { if tag != tags.last { ThinDivider(leading: 12, onCard: true) } }
                            }
                        }
                        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                    }
                    Text("Até 20 etiquetas com 40 caracteres cada.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                    if let e = vm.actionError { InlineError(text: e) }
                }
                .padding(16)
            }
            PrimaryButton(title: "Salvar etiquetas", busy: busy) {
                busy = true
                Task {
                    if await vm.act("tags", tags: tags) {
                        Workspace.shared.show("Etiquetas salvas", style: .success)
                        dismiss()
                    }
                    busy = false
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
        .onAppear { tags = vm.tags; vm.actionError = nil }
    }

    private func add() {
        let t = String(trimmed.prefix(40))
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
        VStack(spacing: 0) {
            SheetHeader(title: "Consultar bot") { dismiss() }
            if let error {
                InlineError(text: error).padding(16)
                Spacer()
            } else if let bots {
                if bots.isEmpty {
                    EmptyStateView(title: "Nenhum bot habilitado", systemImage: "cpu", message: "Habilite bots neste perfil pelo painel.")
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(bots) { bot in
                                Button {
                                    onPick(bot)
                                    dismiss()
                                } label: {
                                    HStack(spacing: 12) {
                                        AvatarView(name: bot.name, kind: .bot, size: 44)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(bot.name.isEmpty ? "Bot" : bot.name).font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary)
                                            Text("Pergunte com o contexto desta conversa").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
                                    }
                                    .padding(.horizontal, 16)
                                    .frame(minHeight: 64)
                                    .contentShape(Rectangle())
                                    .overlay(alignment: .bottom) { ThinDivider(leading: 72) }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            } else {
                Spacer()
                ProgressView()
                Spacer()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
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

/// Salvar/vincular o cliente na agenda (PUT /conversations/{id}/contact).
struct SaveContactSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var phone = ""
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Salvar contato") { dismiss() }
            VStack(alignment: .leading, spacing: 12) {
                VStack(spacing: 0) {
                    TextField("Nome", text: $name).textContentType(.name).font(Theme.font(16)).padding(.horizontal, 14).frame(height: 48)
                    ThinDivider(leading: 14, onCard: true)
                    TextField("Telefone", text: $phone).keyboardType(.phonePad).font(Theme.font(16)).padding(.horizontal, 14).frame(height: 48)
                }
                .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                Text("Cria o contato na agenda do perfil e vincula a esta conversa.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                if let e = vm.actionError { InlineError(text: e) }
                PrimaryButton(title: "Salvar", busy: busy, disabled: name.trimmingCharacters(in: .whitespaces).isEmpty) {
                    busy = true
                    Task {
                        if await vm.saveContact(name: name.trimmingCharacters(in: .whitespaces), phone: AttachmentFactory.normalizePhone(phone)) { dismiss() }
                        busy = false
                    }
                }
            }
            .padding(16)
            Spacer(minLength: 0)
        }
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
        .onAppear {
            name = vm.linkedContactName ?? vm.conversation?.contact_name ?? ""
            phone = vm.linkedContactPhone ?? vm.conversation?.phone ?? ""
            vm.actionError = nil
        }
    }
}
