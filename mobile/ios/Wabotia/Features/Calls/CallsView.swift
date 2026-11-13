import SwiftUI

/// Aba Ligações (mobile/DESIGN.md, seção 10): histórico somente para consulta, com seta de entrada/saída
/// colorida (vermelha para perdida), data e duração. O app não inicia nem atende ligações.
/// Atualiza a cada 5 s em primeiro plano.
struct CallsView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @StateObject private var vm = CallsViewModel()

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Ligações", subtitle: "Histórico de chamadas de voz") { EmptyView() }
            ThinDivider()
            if !vm.loaded && vm.calls.isEmpty {
                SkeletonList(rows: 5)
            } else if vm.history.isEmpty, let error = vm.error {
                VStack { InlineError(text: error) { Task { await vm.refresh() } }.padding(16); Spacer() }
            } else if vm.history.isEmpty {
                ScrollView {
                    EmptyStateView(title: "Nenhuma ligação", systemImage: "phone", message: "As ligações de voz recebidas e realizadas neste perfil aparecem aqui.").padding(.top, 40)
                }
            } else {
                list
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .task(id: "\(container.profileId ?? "")|\(active)") {
            guard active else { return }
            await vm.poll()
        }
    }

    private var list: some View {
        List {
            if let error = vm.error {
                InlineError(text: error)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.background)
            }
            ForEach(vm.history) { call in
                Button { push(.conversation(id: call.conversation_id)) } label: { historyRow(call) }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .overlay(alignment: .bottom) { ThinDivider(leading: 76) }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.background)
                    .task(id: call.conversation_id) { await vm.loadName(for: call.conversation_id) }
            }
            if vm.nextCursor != nil {
                HStack { Spacer(); if vm.loadingMore { ProgressView() } else { Button("Carregar mais") { Task { await vm.loadMore() } }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand) }; Spacer() }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.background)
            }
        }
        .listStyle(.plain)
        .appListBackground(Theme.background)
        .refreshable { await vm.refresh() }
    }

    private func historyRow(_ call: Call) -> some View {
        let name = vm.name(for: call.conversation_id)
        let style = Self.style(call)
        return HStack(spacing: 12) {
            AvatarView(name: name, seed: call.conversation_id, size: 48)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(Theme.font(16, .semibold)).foregroundStyle(style.missed ? Theme.danger : Theme.textPrimary).lineLimit(1)
                HStack(spacing: 5) {
                    Image(systemName: style.icon).font(.system(size: 11, weight: .bold)).foregroundStyle(style.color)
                    Text(style.text).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            Text(CallLabels.dateLabel(call.created)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1)
        }
        .frame(minHeight: 68)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Seta, cor e texto de uma ligação do histórico.
    static func style(_ call: Call) -> (icon: String, color: Color, text: String, missed: Bool) {
        let inbound = call.direction == "inbound"
        let icon = inbound ? "arrow.down.left" : "arrow.up.right"
        let direction = CallLabels.direction(call.direction)
        switch call.status {
        case "missed": return (icon, Theme.danger, inbound ? "Perdida" : "Não atendida", inbound)
        case "rejected": return (icon, Theme.danger, "\(direction) · Recusada", false)
        case "failed": return (icon, Theme.danger, "\(direction) · Falhou", false)
        case "completed":
            let duration = CallLabels.duration(call.duration)
            return (icon, inbound ? Theme.ok : Theme.brand, duration.map { "\(direction) · \($0)" } ?? direction, false)
        case "unknown": return (icon, Theme.warn, "\(direction) · Sem confirmação", false)
        default: return (icon, Theme.ok, "\(direction) · \(CallLabels.status(call.status))", false)
        }
    }
}

@MainActor
final class CallsViewModel: ObservableObject {
    @Published private(set) var calls: [Call] = []
    @Published private(set) var loaded = false
    @Published private(set) var loadingMore = false
    @Published private(set) var nextCursor: String?
    @Published var error: String?
    @Published private(set) var names: [String: String] = [:]

    private var loadingNames: Set<String> = []
    private let pageSize = 30

    private var container: AppContainer { AppContainer.shared }

    /// Histórico exibido (todas as ligações registradas, mais recentes primeiro).
    var history: [Call] { calls }

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
            } else if calls != page.data {
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
