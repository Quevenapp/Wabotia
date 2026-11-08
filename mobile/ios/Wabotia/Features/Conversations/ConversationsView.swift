import SwiftUI

/// Aba Conversas: filtros Fila/Minhas/IA/Concluídas/Todas, busca, paginação por cursor, pull-to-refresh,
/// faixa de ligações tocando e atualização por eventos a cada 4 s enquanto visível.
struct ConversationsView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var vm = ConversationsViewModel()

    var body: some View {
        List {
            if !vm.ringing.isEmpty {
                Section {
                    ForEach(vm.ringing) { call in RingingCallRow(call: call, vm: vm) }
                }
            }
            Section {
                Picker("Filtro", selection: $vm.filter) {
                    ForEach(ConversationsViewModel.Filter.allCases) { f in Text(f.title).tag(f) }
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                .listRowBackground(Color.clear)
            }
            if let error = vm.error {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).font(.footnote).foregroundStyle(.red)
                        Button("Tentar novamente") { vm.load(reset: true) }.font(.footnote)
                    }
                }
            }
            Section {
                if vm.loading && vm.items.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
                } else if vm.items.isEmpty && vm.error == nil {
                    EmptyStateView(title: emptyTitle, systemImage: "tray", message: emptyMessage)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(vm.items) { c in
                        NavigationLink(value: Route.conversation(id: c.id)) {
                            ConversationRow(conversation: c, meId: vm.meId)
                        }
                        .onAppear { vm.loadMoreIfNeeded(current: c) }
                    }
                    if vm.loadingMore {
                        HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Conversas")
        .searchable(text: $vm.query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Telefone ou nome")
        .onChange(of: vm.query) { _ in vm.queryChanged() }
        .refreshable { await vm.refresh() }
        .onAppear {
            vm.appear()
            vm.startPolling()
        }
        .onDisappear { vm.stopPolling() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { vm.startPolling(); vm.load(reset: true, silent: true) } else { vm.stopPolling() }
        }
        .onChange(of: container.profileId) { _ in
            vm.stopPolling()
            vm.load(reset: true)
            vm.startPolling()
        }
        .alert("Ligação", isPresented: Binding(get: { vm.callError != nil }, set: { if !$0 { vm.callError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(vm.callError ?? "") }
    }

    private var emptyTitle: String {
        switch vm.filter {
        case .queue: return "Fila vazia"
        case .mine: return "Nenhum atendimento seu"
        case .ai: return "Nenhuma conversa com a IA"
        case .closed: return "Nenhuma conversa concluída"
        case .all: return "Nenhuma conversa"
        }
    }

    private var emptyMessage: String? {
        if !vm.query.trimmingCharacters(in: .whitespaces).isEmpty { return "Nenhum resultado para \"\(vm.query)\"." }
        switch vm.filter {
        case .queue: return "Quando um cliente pedir atendimento humano, a conversa aparece aqui."
        case .mine: return "Assuma uma conversa da fila para atender pelo celular."
        default: return nil
        }
    }
}

/// Linha da lista: avatar, nome, horário, estado, grupo e etiquetas.
struct ConversationRow: View {
    let conversation: Conversation
    let meId: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            InitialAvatar(name: conversation.displayName, isGroup: conversation.isGroup)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    if conversation.isGroup { Image(systemName: "person.3").font(.caption).foregroundStyle(.secondary) }
                    Text(conversation.displayName).font(.body.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(ConversationFormatting.listDate(conversation.updated)).font(.caption).foregroundStyle(.secondary)
                }
                if let phone = conversation.phone, !phone.isEmpty, phone != conversation.displayName {
                    Text(phone).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack(spacing: 6) {
                    StateChip(state: conversation.state)
                    if conversation.state == "human", let owner = conversation.owner, owner == meId {
                        Text("Você").font(.caption2).foregroundStyle(.secondary)
                    }
                    let tags = JSONValue.parseStringList(conversation.tags)
                    ForEach(tags.prefix(3), id: \.self) { TagChip(text: $0) }
                    if tags.count > 3 { Text("+\(tags.count - 3)").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Faixa de ligação tocando: Atender abre a tela da ligação; Recusar faz claim + reject.
struct RingingCallRow: View {
    let call: Call
    @ObservedObject var vm: ConversationsViewModel
    @State private var busy = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "phone.arrow.down.left.fill").font(.title3).foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("Ligação recebida").font(.subheadline.weight(.semibold))
                Text(ConversationFormatting.callStatusLabel(call.status) + " · " + ConversationFormatting.date(call.created)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            NavigationLink(value: Route.call(conversationId: call.conversation_id, callId: call.id)) {
                Text("Atender").font(.footnote.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            Button(role: .destructive) {
                busy = true
                Task { await vm.reject(call: call); busy = false }
            } label: {
                if busy { ProgressView() } else { Text("Recusar").font(.footnote.weight(.semibold)) }
            }
            .buttonStyle(.bordered)
            .disabled(busy)
        }
        .listRowBackground(Color.green.opacity(0.08))
    }
}
