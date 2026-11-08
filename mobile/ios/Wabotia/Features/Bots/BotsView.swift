import SwiftUI

/// Bots habilitados do perfil (GET /bots, enabled == 1) e histórico de execuções (GET /bot-runs).
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

struct BotsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = BotsViewModel()
    @State private var selectedRun: BotRun?

    var body: some View {
        List {
            if let error = model.errorMessage, model.hasLoaded {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            Section {
                if model.bots.isEmpty && model.hasLoaded {
                    Text("Nenhum bot habilitado neste perfil. Habilite bots em Equipe Bot, no painel.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.bots) { bot in
                    NavigationLink(value: Route.bot(id: bot.id, conversationId: nil)) {
                        BotRowView(bot: bot)
                    }
                }
            } header: {
                Text("Bots habilitados")
            } footer: {
                if !model.bots.isEmpty {
                    Text("Toque em um bot para conversar. Para devolver uma conversa ao bot do perfil, use Devolver à IA na própria conversa.")
                }
            }
            Section("Execuções recentes") {
                if model.runs.isEmpty && model.hasLoaded {
                    Text("Nenhuma execução ainda.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(model.runs) { run in
                    Button { selectedRun = run } label: {
                        BotRunRowView(run: run, botName: model.botName(run.bot_id))
                    }
                    .buttonStyle(.plain)
                }
                if model.nextCursor != nil {
                    HStack {
                        Spacer()
                        if model.loadingMore { ProgressView() } else { Button("Carregar mais") { model.loadMore() } }
                        Spacer()
                    }
                    .onAppear { model.loadMore() }
                }
            }
        }
        .overlay {
            if !model.hasLoaded {
                if model.loading {
                    ProgressView()
                } else if let error = model.errorMessage {
                    EmptyStateView(title: "Não foi possível carregar", systemImage: "exclamationmark.triangle", message: error)
                }
            }
        }
        .refreshable { await model.load(quiet: true) }
        .navigationTitle("Bots")
        // Roda ao aparecer (inclusive ao voltar de um bot) e quando o perfil muda.
        .task(id: container.profileId ?? "") { await model.load(quiet: model.hasLoaded) }
        .sheet(item: $selectedRun) { run in
            BotRunDetailView(run: run, botName: model.botName(run.bot_id))
        }
    }
}

struct BotRowView: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "cpu")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 32, height: 32)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name.isEmpty ? "Bot" : bot.name)
                if !bot.remote_profile.isEmpty {
                    Text(bot.remote_profile).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Linha do histórico: bot, trecho do pedido, estado colorido e data.
struct BotRunRowView: View {
    let run: BotRun
    let botName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(botName).font(.subheadline.weight(.semibold))
                Spacer()
                BotRunStatusBadge(status: run.status)
            }
            if let input = run.input, !input.isEmpty {
                Text(input).font(.footnote).foregroundStyle(.primary).lineLimit(2)
            }
            HStack {
                if let error = run.error, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(.red).lineLimit(1)
                }
                Spacer()
                Text(TicketsSupport.shortDate(run.created)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
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
        NavigationStack {
            List {
                Section("Pedido") {
                    Text(run.input ?? "").textSelection(.enabled)
                    LabeledContent("Enviado", value: TicketsSupport.shortDate(run.created))
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
