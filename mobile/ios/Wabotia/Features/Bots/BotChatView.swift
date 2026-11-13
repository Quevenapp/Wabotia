import SwiftUI
import UIKit

/// Um par pergunta/resposta desta sessão. A Idempotency-Key nasce ao tocar em Enviar e é mantida
/// enquanto o pedido não for confirmado (repetição após falha de rede reutiliza chave e corpo).
struct BotTurn: Identifiable, Equatable {
    let id: String
    var input: String
    var key: String
    var run: BotRun?
    var sending = false
    var error: String?
    var retryable = false
    /// O POST foi cancelado ao sair da tela antes da resposta; `resume()` repete com a mesma chave.
    var interrupted = false
}

/// Conversa com um bot: POST /api/v1/bot-runs → GET /api/v1/bot-runs/{id} a cada 2 s até o estado final.
@MainActor
final class BotChatViewModel: ObservableObject {
    static let inputLimit = 60_000

    let botId: String
    let conversationId: String?
    @Published private(set) var bot: Bot?
    @Published var input = ""
    @Published private(set) var turns: [BotTurn] = []
    @Published private(set) var history: [BotRun] = []
    @Published private(set) var loading = false
    @Published var loadError: String?
    @Published var showHistory = false
    /// Nome/telefone do cliente quando aberto a partir de uma conversa.
    @Published private(set) var contextLabel: String?

    /// Consultas GET /bot-runs/{id} em andamento, por turno.
    private var pollers: [String: Task<Void, Never>] = [:]
    /// POST /bot-runs em andamento, por turno (separado dos pollers para tratar o cancelamento à parte).
    private var sendTasks: [String: Task<Void, Never>] = [:]
    private var contextLoaded = false
    private var container: AppContainer { AppContainer.shared }
    var profileId: String? { container.profileId }

    init(botId: String, conversationId: String?) {
        self.botId = botId
        self.conversationId = conversationId
    }

    func load() async {
        guard let profile = profileId else { return }
        loading = true
        loadError = nil
        let api = container.api
        let botId = self.botId
        do {
            async let botsRequest = api.bots(profile)
            async let runsRequest = api.botRuns(profile)
            let bots = try await botsRequest
            if Task.isCancelled { return }
            bot = bots.data.first { $0.id == botId }
            if let runs = try? await runsRequest {
                // Execuções anteriores do mesmo bot, da mais antiga para a mais recente (como um histórico de chat).
                history = runs.data
                    .filter { $0.bot_id == botId }
                    .sorted { ($0.created ?? 0) < ($1.created ?? 0) }
                    .suffix(20)
                    .map { $0 }
            }
        } catch {
            if Task.isCancelled { return }
            loadError = TicketsSupport.failure(error)
        }
        if let conversation = conversationId, !contextLoaded {
            await loadContext(profile: profile, conversationId: conversation)
        }
        loading = false
    }

    /// Pré-preenche "Cliente {telefone} perguntou: …" com a última mensagem do cliente.
    private func loadContext(profile: String, conversationId: String) async {
        contextLoaded = true
        do {
            let detail = try await container.api.conversation(profile, id: conversationId)
            if Task.isCancelled { return }
            let name = detail.displayName
            let who = detail.conversation.phone ?? name
            contextLabel = name == who ? who : "\(name) (\(who))"
            guard input.isEmpty else { return }
            let lastCustomer = detail.messages
                .filter { $0.isIncoming && !$0.text.isEmpty }
                .max { $0.created < $1.created }
            if let message = lastCustomer {
                input = "Cliente \(who) perguntou: \(message.text)"
            } else {
                input = "Cliente \(who) perguntou: "
            }
        } catch {
            _ = TicketsSupport.failure(error)
        }
    }

    func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let turn = BotTurn(id: UUID().uuidString, input: String(text.prefix(Self.inputLimit)), key: APIClient.newIdempotencyKey())
        turns.append(turn)
        input = ""
        start(turn)
    }

    /// Repete com a MESMA chave e o mesmo corpo (falha de rede).
    func retry(_ turn: BotTurn) { start(turn) }

    func discard(_ turn: BotTurn) {
        pollers[turn.id]?.cancel()
        pollers[turn.id] = nil
        sendTasks[turn.id]?.cancel()
        sendTasks[turn.id] = nil
        turns.removeAll { $0.id == turn.id }
    }

    func cancel(_ turn: BotTurn) {
        guard let profile = profileId, let run = turn.run else { return }
        let turnId = turn.id
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.container.api.cancelBotRun(profile, id: run.id)
                self.mutate(turnId) { if let status = $0.run?.status, BotsSupport.isCancellable(status) { $0.run?.status = "cancelling" } }
            } catch {
                if let message = TicketsSupport.failure(error) { self.mutate(turnId) { $0.error = message; $0.retryable = false } }
            }
        }
    }

    /// Retoma, ao voltar para a tela, a consulta das execuções em andamento e reenvia (mesma chave e corpo)
    /// os pedidos cujo POST foi interrompido pela saída da tela.
    func resume() {
        for turn in turns {
            if turn.run == nil {
                if turn.interrupted, sendTasks[turn.id] == nil { start(turn) }
                continue
            }
            guard let run = turn.run, !run.isFinal, pollers[turn.id] == nil else { continue }
            startPolling(turnId: turn.id, runId: run.id)
        }
    }

    /// Interrompe consultas e envios (a execução continua no servidor e aparece no histórico). Um POST
    /// cancelado fica marcado como interrompido e é repetido por `resume()` com a mesma Idempotency-Key.
    func stop() {
        pollers.values.forEach { $0.cancel() }
        pollers = [:]
        sendTasks.values.forEach { $0.cancel() }
        sendTasks = [:]
    }

    private func startPolling(turnId: String, runId: String) {
        pollers[turnId]?.cancel()
        pollers[turnId] = Task { [weak self] in await self?.poll(turnId: turnId, runId: runId) }
    }

    private func start(_ turn: BotTurn) {
        guard let profile = profileId else { return }
        mutate(turn.id) { $0.sending = true; $0.error = nil; $0.retryable = false; $0.interrupted = false }
        let body = BotRunRequest(profile_id: profile, bot_id: botId, input: turn.input)
        let key = turn.key
        let turnId = turn.id
        pollers[turnId]?.cancel()
        pollers[turnId] = nil
        sendTasks[turnId]?.cancel()
        sendTasks[turnId] = Task { [weak self] in
            guard let self else { return }
            do {
                let created = try await self.container.api.startBotRun(body, key: key)
                self.sendTasks[turnId] = nil
                self.mutate(turnId) { $0.sending = false; $0.run = created }
                // Cancelado logo após a resposta (tela saiu): guarda a execução e deixa resume() retomar a consulta.
                if !Task.isCancelled { self.startPolling(turnId: turnId, runId: created.id) }
            } catch {
                self.sendTasks[turnId] = nil
                if Task.isCancelled {
                    // A saída da tela cancelou a requisição; o servidor pode ter aceitado o pedido, então a
                    // repetição (automática em resume() ou manual) reutiliza a mesma chave.
                    self.mutate(turnId) { $0.sending = false; $0.interrupted = true; $0.retryable = true; $0.error = "Envio interrompido ao sair da tela. Será repetido ao voltar." }
                    return
                }
                guard let message = TicketsSupport.failure(error) else { return }
                if let apiError = error as? APIError {
                    if apiError.isIdempotencyConflict {
                        // Mesma chave com outro corpo: a próxima tentativa é um novo pedido.
                        self.mutate(turnId) { $0.sending = false; $0.error = "Este pedido já foi enviado com outro conteúdo. Tente novamente."; $0.retryable = true; $0.key = APIClient.newIdempotencyKey() }
                    } else {
                        // O servidor recusou (limite, bot não autorizado…): repetir só com nova chave.
                        self.mutate(turnId) { $0.sending = false; $0.error = message; $0.retryable = true; $0.key = APIClient.newIdempotencyKey() }
                    }
                } else {
                    // Falha de rede: o pedido pode ter sido aceito; repetir com a mesma chave é seguro.
                    self.mutate(turnId) { $0.sending = false; $0.error = message; $0.retryable = true }
                }
            }
        }
    }

    private func poll(turnId: String, runId: String) async {
        var failures = 0
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            do {
                let run = try await container.api.botRun(id: runId)
                failures = 0
                mutate(turnId) { $0.run = run }
                if run.isFinal {
                    pollers[turnId] = nil
                    return
                }
            } catch {
                if Task.isCancelled { return }
                if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized(); return }
                failures += 1
                if failures >= 5 {
                    mutate(turnId) { $0.error = "Não foi possível acompanhar a execução: \(APIError.describe(error))"; $0.retryable = false }
                    pollers[turnId] = nil
                    return
                }
            }
        }
    }

    private func mutate(_ id: String, _ change: (inout BotTurn) -> Void) {
        guard let index = turns.firstIndex(where: { $0.id == id }) else { return }
        change(&turns[index])
    }
}

struct BotChatView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: BotChatViewModel
    @FocusState private var focused: Bool
    let botId: String
    let conversationId: String?

    init(botId: String, conversationId: String?) {
        self.botId = botId
        self.conversationId = conversationId
        _model = StateObject(wrappedValue: BotChatViewModel(botId: botId, conversationId: conversationId))
    }

    private var profileId: String { container.profileId ?? "" }
    private var trimmedInput: String { model.input.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if let error = model.loadError {
                            Text(error).font(.footnote).foregroundStyle(Theme.danger)
                        }
                        if let context = model.contextLabel {
                            Label("Contexto da conversa com \(context). Use Copiar resposta para colar no composer.", systemImage: "bubble.left.and.text.bubble.right")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        if !model.history.isEmpty {
                            DisclosureGroup(isExpanded: $model.showHistory) {
                                VStack(alignment: .leading, spacing: 16) {
                                    ForEach(model.history) { run in
                                        BotTurnView(input: run.input ?? "", run: run, sending: false, error: nil, retryable: false, profileId: profileId)
                                    }
                                }
                                .padding(.top, 8)
                            } label: {
                                Text("Execuções anteriores (\(model.history.count))").font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary)
                            }
                            .accentColor(Theme.brand)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.bubbleSystem))
                        }
                        if model.turns.isEmpty && !model.loading && !model.showHistory {
                            VStack(spacing: 8) {
                                AvatarView(name: model.bot?.name ?? "Bot", kind: .bot, size: 72)
                                Text(model.bot?.name ?? "Bot").font(Theme.font(18, .semibold)).foregroundStyle(Theme.textPrimary)
                                Text("Escreva o pedido abaixo. O resultado fica registrado nas execuções do bot.")
                                    .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 48)
                            .padding(.horizontal, 24)
                        }
                        ForEach(model.turns) { turn in
                            BotTurnView(
                                input: turn.input,
                                run: turn.run,
                                sending: turn.sending,
                                error: turn.error,
                                retryable: turn.retryable,
                                profileId: profileId,
                                onCancel: { model.cancel(turn) },
                                onRetry: { model.retry(turn) },
                                onDiscard: { model.discard(turn) }
                            )
                            .id(turn.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(16)
                }
                .appScrollDismissesKeyboard()
                .onChange(of: model.turns) { _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            Divider()
            composer
        }
        .navigationTitle(model.bot?.name ?? "Bot")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .background(Theme.chatWallpaper.ignoresSafeArea())
        .task { await model.load() }
        .onAppear { model.resume() }
        .onDisappear { model.stop() }
    }

    @ViewBuilder private var composerField: some View {
        if #available(iOS 16, *) {
            AppMultilineField("Pergunte ao bot", text: $model.input, lines: 1...6, font: Theme.font(16))
                .focused($focused).padding(.horizontal, 14).padding(.vertical, 9).frame(minHeight: 40)
        } else {
            AppMultilineField("Pergunte ao bot", text: $model.input, lines: 1...6, font: Theme.font(16))
                .focused($focused).padding(.horizontal, 9).padding(.vertical, 1).frame(minHeight: 40)
        }
    }

    private var composer: some View {
        VStack(spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                composerField
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.field))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.divider, lineWidth: 1))
                    .onChange(of: model.input) { value in
                        if value.count > BotChatViewModel.inputLimit { model.input = String(value.prefix(BotChatViewModel.inputLimit)) }
                    }
                Button {
                    model.send()
                } label: {
                    Image(systemName: "paperplane.fill").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.onBrand)
                        .frame(width: 40, height: 40).background(Circle().fill(Theme.bot))
                        .opacity(trimmedInput.isEmpty ? 0.4 : 1)
                }
                .buttonStyle(.plain)
                .disabled(trimmedInput.isEmpty || container.profileId == nil)
                .accessibilityLabel("Enviar")
            }
            if model.input.count > 50_000 {
                HStack {
                    Spacer()
                    Text("\(model.input.count) / \(BotChatViewModel.inputLimit)").font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.bar.ignoresSafeArea(edges: .bottom))
    }
}

/// Pergunta (à direita) e resposta do bot (à esquerda) com estado, erro, anexos e ações.
struct BotTurnView: View {
    let input: String
    let run: BotRun?
    let sending: Bool
    let error: String?
    let retryable: Bool
    let profileId: String
    var onCancel: (() -> Void)? = nil
    var onRetry: (() -> Void)? = nil
    var onDiscard: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Spacer(minLength: 40)
                Text(input)
                    .textSelection(.enabled)
                    .padding(10)
                    .background(Theme.bubbleOut, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            HStack {
                VStack(alignment: .leading, spacing: 8) {
                    if sending {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Enviando…").font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                    } else if let run {
                        BotRunResultView(run: run, profileId: profileId)
                        if BotsSupport.isCancellable(run.status), let onCancel {
                            Button("Cancelar", role: .destructive) { onCancel() }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                    }
                    if let error, !error.isEmpty {
                        Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.danger)
                        if run == nil, onRetry != nil || onDiscard != nil {
                            HStack {
                                if retryable, let onRetry {
                                    Button("Tentar novamente") { onRetry() }
                                }
                                if let onDiscard {
                                    Button("Abandonar pedido", role: .destructive) { onDiscard() }
                                }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.bubbleIn, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Spacer(minLength: 40)
            }
        }
    }
}
