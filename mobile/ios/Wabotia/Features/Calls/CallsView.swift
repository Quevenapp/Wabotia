import SwiftUI

/// Aba Ligações: ligações tocando no topo (Atender → Route.call, Recusar → claim + reject)
/// e histórico de GET /calls com estado em português e duração. Atualiza a cada 5 s em primeiro plano.
struct CallsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var vm = CallsViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Fora da List: um NavigationLink dentro de uma linha tornaria a linha inteira navegável.
            if !vm.ringing.isEmpty {
                VStack(spacing: 12) {
                    ForEach(vm.ringing) { call in ringingRow(call) }
                }
                .padding()
                .background(Color.green.opacity(0.08))
                Divider()
            }
            if vm.loaded && vm.calls.isEmpty && vm.error == nil {
                EmptyStateView(title: "Nenhuma ligação", systemImage: "phone", message: "As ligações de voz recebidas e realizadas neste perfil aparecem aqui.")
            } else {
                list
            }
        }
        .overlay { if !vm.loaded && vm.calls.isEmpty { ProgressView() } }
        .navigationTitle("Ligações")
        .task { await vm.poll() }
    }

    private var list: some View {
        List {
            if let error = vm.error {
                Section { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            Section("Histórico") {
                ForEach(vm.history) { call in
                    RouteLink(route: Route.conversation(id: call.conversation_id)) {
                        historyRow(call)
                    }
                }
                if vm.nextCursor != nil {
                    Button {
                        Task { await vm.loadMore() }
                    } label: {
                        if vm.loadingMore { ProgressView().frame(maxWidth: .infinity) } else { Text("Carregar mais").frame(maxWidth: .infinity) }
                    }
                    .disabled(vm.loadingMore)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await vm.refresh() }
    }

    private func ringingRow(_ call: Call) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "phone.arrow.down.left").foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(vm.name(for: call.conversation_id)).font(.headline)
                    Text("Recebendo ligação · \(CallLabels.dateLabel(call.created))").font(.footnote).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 12) {
                RouteLink(route: Route.call(conversationId: call.conversation_id, callId: call.id)) {
                    Label("Atender", systemImage: "phone.fill").frame(maxWidth: .infinity)
                }
                .simultaneousGesture(TapGesture().onEnded { CallIntents.answerCallId = call.id })
                .buttonStyle(.borderedProminent)
                .tint(.green)
                Button(role: .destructive) {
                    Task { await vm.decline(call) }
                } label: {
                    if vm.busyCallId == call.id { ProgressView().frame(maxWidth: .infinity) }
                    else { Label("Recusar", systemImage: "phone.down.fill").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.bordered)
                .disabled(vm.busyCallId != nil)
            }
        }
        .task(id: call.conversation_id) { await vm.loadName(for: call.conversation_id) }
    }

    private func historyRow(_ call: Call) -> some View {
        HStack(spacing: 12) {
            Image(systemName: CallLabels.directionIcon(call.direction))
                .foregroundStyle(statusColor(call))
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(vm.name(for: call.conversation_id)).font(.body)
                HStack(spacing: 4) {
                    Text(CallLabels.direction(call.direction))
                    Text("·")
                    Text(CallLabels.status(call.status)).foregroundStyle(statusColor(call))
                    if let duration = CallLabels.duration(call.duration) {
                        Text("·")
                        Text(duration)
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Text(CallLabels.dateLabel(call.created)).font(.caption).foregroundStyle(.secondary)
        }
        .task(id: call.conversation_id) { await vm.loadName(for: call.conversation_id) }
    }

    private func statusColor(_ call: Call) -> Color {
        switch call.status {
        case "missed", "failed": return .red
        case "rejected": return .orange
        case "unknown": return .orange
        case "completed": return .secondary
        default: return .green
        }
    }
}

@MainActor
final class CallsViewModel: ObservableObject {
    @Published private(set) var calls: [Call] = []
    @Published private(set) var loaded = false
    @Published private(set) var loadingMore = false
    @Published private(set) var nextCursor: String?
    @Published private(set) var busyCallId: String?
    @Published var error: String?
    @Published private(set) var names: [String: String] = [:]

    private var loadingNames: Set<String> = []
    /// Chaves de idempotência por ligação recusada, mantidas enquanto o pedido não for confirmado.
    private var declineKeys: [String: (claim: String, reject: String)] = [:]
    private let pageSize = 30

    private var container: AppContainer { AppContainer.shared }
    private var meId: String? { container.user?.id }

    var ringing: [Call] {
        calls.filter { $0.status == "ringing" && $0.direction == "inbound" && ($0.actor == nil || $0.actor == meId) }
    }

    var history: [Call] {
        let ringingIds = Set(ringing.map(\.id))
        return calls.filter { !ringingIds.contains($0.id) }
    }

    func name(for conversationId: String) -> String { names[conversationId] ?? "Cliente" }

    /// Laço de atualização em primeiro plano (cancelado pelo .task ao sair da tela).
    func poll() async {
        while !Task.isCancelled {
            await refresh(silent: true)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    func refresh(silent: Bool = false) async {
        guard let p = container.profileId else { return }
        do {
            let page = try await container.api.calls(p, limit: pageSize)
            if Task.isCancelled { return }
            if calls.count > page.data.count {
                // Páginas extras já carregadas: substitui a primeira e preserva o restante.
                let firstIds = Set(page.data.map(\.id))
                calls = page.data + calls.filter { !firstIds.contains($0.id) }
            } else {
                calls = page.data
                nextCursor = page.next_cursor
            }
            error = nil
        } catch {
            if Task.isCancelled { return }
            handle(error, silent: silent)
        }
        loaded = true
    }

    func loadMore() async {
        guard let p = container.profileId, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        do {
            let page = try await container.api.calls(p, limit: pageSize, cursor: cursor)
            let known = Set(calls.map(\.id))
            calls += page.data.filter { !known.contains($0.id) }
            nextCursor = page.next_cursor
        } catch {
            handle(error, silent: false)
        }
        loadingMore = false
    }

    /// Recusar = claim + reject, com as mesmas chaves ao repetir após falha.
    func decline(_ call: Call) async {
        guard let p = container.profileId, busyCallId == nil else { return }
        busyCallId = call.id
        let keys = declineKeys[call.id] ?? (claim: APIClient.newIdempotencyKey(), reject: APIClient.newIdempotencyKey())
        declineKeys[call.id] = keys
        do {
            _ = try await container.api.claimCall(p, id: call.id, key: keys.claim)
            _ = try await container.api.rejectCall(p, id: call.id, key: keys.reject)
            declineKeys[call.id] = nil
            error = nil
            await refresh(silent: true)
        } catch {
            if let apiError = error as? APIError, apiError.status != 0, !apiError.isIdempotencyConflict {
                declineKeys[call.id] = nil // resposta definitiva do servidor: a próxima tentativa é outro pedido
            }
            handle(error, silent: false)
        }
        busyCallId = nil
    }

    func loadName(for conversationId: String) async {
        guard names[conversationId] == nil, !loadingNames.contains(conversationId), let p = container.profileId else { return }
        loadingNames.insert(conversationId)
        defer { loadingNames.remove(conversationId) }
        if let detail = try? await container.api.conversation(p, id: conversationId) {
            names[conversationId] = detail.displayName
        }
    }

    private func handle(_ error: Error, silent: Bool) {
        if let apiError = error as? APIError, apiError.isUnauthorized {
            container.handleUnauthorized()
            return
        }
        if silent && loaded && !calls.isEmpty { return }
        self.error = APIError.describe(error)
    }
}
