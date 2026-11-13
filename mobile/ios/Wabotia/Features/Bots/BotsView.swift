import SwiftUI

/// Bots habilitados do perfil (GET /bots, enabled == 1) e histórico de execuções (GET /bot-runs).
/// Usado pela aba Equipe (lista Bots → Execuções recentes).
@MainActor
final class BotsViewModel: ObservableObject {
    @Published private(set) var bots: [Bot] = []
    @Published private(set) var runs: [BotRun] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    private var moreTask: Task<Void, Never>?
    private var container: AppContainer { AppContainer.shared }

    func load(quiet: Bool = false) async {
        guard let profile = container.profileId else { return }
        moreTask?.cancel()
        if !quiet { loading = true }
        errorMessage = nil
        let api = container.api
        do {
            async let botsRequest = api.bots(profile)
            async let runsRequest = api.botRuns(profile)
            let (botsPage, runsPage) = try await (botsRequest, runsRequest)
            if Task.isCancelled { return }
            bots = botsPage.data
                .filter { $0.enabled == 1 }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            runs = Self.sorted(runsPage.data)
            nextCursor = runsPage.next_cursor
            hasLoaded = true
        } catch {
            if Task.isCancelled { return }
            if let message = TicketsSupport.failure(error) { errorMessage = message }
        }
        loading = false
    }

    func loadMore() {
        guard let cursor = nextCursor, !loadingMore, let profile = container.profileId else { return }
        loadingMore = true
        moreTask = Task { [weak self] in
            guard let self else { return }
            defer { self.loadingMore = false }
            do {
                let page = try await self.container.api.botRuns(profile, cursor: cursor)
                if Task.isCancelled { return }
                var seen = Set(self.runs.map(\.id))
                let fresh = page.data.filter { seen.insert($0.id).inserted }
                self.runs = Self.sorted(self.runs + fresh)
                self.nextCursor = page.next_cursor
            } catch {
                if Task.isCancelled { return }
                if let message = TicketsSupport.failure(error) { self.errorMessage = message }
            }
        }
    }

    func botName(_ id: String?) -> String {
        bots.first { $0.id == id }?.name ?? "Bot"
    }

    /// O servidor ordena por ID opaco; mostramos as execuções mais recentes primeiro.
    private static func sorted(_ list: [BotRun]) -> [BotRun] {
        list.sorted { ($0.created ?? 0) > ($1.created ?? 0) }
    }
}

/// Linha do histórico: bot, trecho do pedido, estado colorido e data.
struct BotRunRowView: View {
    let run: BotRun
    let botName: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(name: botName, kind: .bot, size: 34)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(botName).font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Spacer(minLength: 4)
                    BotRunStatusBadge(status: run.status)
                }
                if let input = run.input, !input.isEmpty {
                    Text(input).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                }
                HStack {
                    if let error = run.error, !error.isEmpty {
                        Text(error).font(Theme.font(12)).foregroundStyle(Theme.danger).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    Text(TicketsSupport.shortDate(run.created)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
        .contentShape(Rectangle())
    }
}
/// Detalhe de uma execução do histórico: pedido, resultado, anexos; consulta a cada 2 s enquanto roda; cancelar.
struct BotRunDetailView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State var run: BotRun
    let botName: String
    @State private var cancelling = false
    @State private var error: String?

    var body: some View {
        AppNavigationStack {
            List {
                Section("Pedido") {
                    Text(run.input ?? "").textSelection(.enabled)
                    AppLabeledContent("Enviado", value: TicketsSupport.shortDate(run.created))
                }
                Section("Resultado") {
                    BotRunResultView(run: run, profileId: container.profileId ?? "")
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                if BotsSupport.isCancellable(run.status) {
                    Section {
                        Button(role: .destructive) { cancel() } label: {
                            if cancelling { ProgressView().frame(maxWidth: .infinity) } else { Text("Cancelar execução").frame(maxWidth: .infinity) }
                        }
                        .disabled(cancelling)
                    } footer: {
                        Text("O cancelamento é uma solicitação e não desfaz o que o bot já executou.")
                    }
                }
            }
            .navigationTitle(botName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fechar") { dismiss() } }
            }
            .task { await poll() }
        }
    }

    /// Consulta GET /bot-runs/{id} a cada 2 s até o estado final; a tarefa é cancelada ao fechar a folha.
    private func poll() async {
        var failures = 0
        while !Task.isCancelled, !run.isFinal {
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            do {
                run = try await container.api.botRun(id: run.id)
                failures = 0
            } catch {
                if Task.isCancelled { return }
                if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized(); return }
                failures += 1
                if failures >= 5 {
                    self.error = "Não foi possível acompanhar a execução: \(APIError.describe(error))"
                    return
                }
            }
        }
    }

    private func cancel() {
        guard let profile = container.profileId else { return }
        cancelling = true
        error = nil
        Task { @MainActor in
            do {
                _ = try await container.api.cancelBotRun(profile, id: run.id)
                if BotsSupport.isCancellable(run.status) { run.status = "cancelling" }
            } catch {
                self.error = TicketsSupport.failure(error)
            }
            cancelling = false
        }
    }
}
