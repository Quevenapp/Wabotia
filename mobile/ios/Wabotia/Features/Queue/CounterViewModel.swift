import Foundation

/// O guichê dentro do app logado, com o token da pessoa (`Bearer wabu_…`, aceito em todas as rotas `/queue`): escolher
/// o guichê, abrir, pausar, fechar, chamar a próxima, rechamar, iniciar, concluir, ausente e transferir. A fila é
/// decidida no servidor; aqui só se pede.
///
/// Idempotência (mobile/README.md): cada intenção ganha uma `Idempotency-Key`; se a resposta não chegar (rede, 5xx), a
/// chave fica guardada e tocar de novo na mesma ação repete com ela — o Wabotia devolve a mesma resposta em vez de
/// chamar outra senha. Erro definitivo, sucesso ou uma leitura que mostra o guichê mudado liberam a chave.
@MainActor
final class CounterViewModel: ObservableObject {
    @Published private(set) var overview: QueueOverview?
    @Published private(set) var loading = true
    /// Erro do primeiro carregamento (tela inteira).
    @Published private(set) var error: String?
    /// Guichê escolhido neste aparelho (por perfil).
    @Published private(set) var counterId: String?
    /// A ação em andamento (assinatura), para o botão mostrar progresso e os demais esperarem.
    @Published private(set) var busy: String?
    /// Erro de uma ação; fica até a pessoa fechar ou agir de novo.
    @Published var notice: String?
    @Published private(set) var live = false

    var counter: CounterInfo? { overview?.counters?.first { $0.id == counterId } }
    var current: QueueTicket? { counter?.current }

    /// As filas que o guichê atende, com quem aguarda.
    var servedQueues: [QueueInfo] {
        let ids = Set(counter?.queueIds ?? [])
        return (overview?.queues ?? []).filter { ids.contains($0.id) }
    }

    private let client: QueueClient
    private let profileId: String
    private let demo: Bool
    private let defaults: UserDefaults
    private let onUnauthorized: () -> Void
    private let onMessage: (String) -> Void
    private let onModuleDisabled: () -> Void
    private var feed: QueueLiveFeed?

    /// Escrita sem resposta: a mesma intenção repete com esta chave até o servidor confirmar.
    private struct PendingWrite { let signature: String; let key: String; let fingerprint: String }
    private var pending: PendingWrite?

    init(client: QueueClient, demo: Bool, defaults: UserDefaults = .standard, onUnauthorized: @escaping () -> Void,
         onMessage: @escaping (String) -> Void, onModuleDisabled: @escaping () -> Void = {}) {
        self.client = client
        self.profileId = client.profileId
        self.demo = demo
        self.defaults = defaults
        self.onUnauthorized = onUnauthorized
        self.onMessage = onMessage
        self.onModuleDisabled = onModuleDisabled
        counterId = defaults.string(forKey: "queue.counter.\(client.profileId)")
    }

    /// Com a sessão de pessoa do app.
    convenience init(container: AppContainer) {
        let session = container.session
        let profile = container.profileId ?? ""
        let client = QueueClient(baseURL: session.serverURL?.absoluteString ?? "", profileId: profile) { session.token }
        self.init(client: client, demo: container.isDemo, onUnauthorized: { container.handleUnauthorized() },
                  onMessage: { Workspace.shared.show($0, style: .success) },
                  onModuleDisabled: { ModuleFeature.shared.markDisabled(ModuleId.queue, profile: profile) })
    }

    // MARK: - Leitura

    /// Enquanto a tela está visível: WebSocket (com volta) e, sem ele, leitura a cada 5 s.
    func start() {
        guard feed == nil else { return }
        let feed = QueueLiveFeed(client: client, useSocket: !demo, pollInterval: demo ? 3 : 5)
        feed.onEvent = { [weak self] in self?.handle($0) }
        self.feed = feed
        feed.start()
    }

    func stop() {
        feed?.stop()
        feed = nil
        live = false
    }

    func reload() async {
        if overview == nil { loading = true }
        error = nil
        if let feed { await feed.refresh() } else { await readOnce() }
    }

    private func readOnce() async {
        do { handle(.snapshot(try await client.overview())) }
        catch let e as QueueError { handle(.failure(e)) }
        catch {}
    }

    func handle(_ event: QueueLiveFeed.Event) {
        switch event {
        case .snapshot(let overview):
            self.overview = overview
            loading = false
            error = nil
            // Guichê guardado que não existe mais (apagado no painel): volta à escolha.
            if let id = counterId, !(overview.counters ?? []).contains(where: { $0.id == id }) { chooseCounter(nil) }
            settlePending()
        case .failure(let e):
            if e.unauthorized { onUnauthorized() }
            if e.moduleDisabled { onModuleDisabled() }
            loading = false
            if overview == nil {
                error = e.moduleDisabled ? "A fila de senhas está desligada neste Wabotia. Um administrador liga em Módulos." : e.message
            }
        case .live(let on):
            live = on
        case .call:
            break
        }
    }

    // MARK: - Guichê

    func chooseCounter(_ id: String?) {
        if let id { defaults.set(id, forKey: "queue.counter.\(profileId)") } else { defaults.removeObject(forKey: "queue.counter.\(profileId)") }
        pending = nil
        counterId = id
        notice = nil
    }

    func setStatus(_ status: String) {
        guard let counter, counter.state != status else { return }
        write("state:\(counter.id):\(status)", success: { _ in "Guichê \(Self.statusLabel(status).lowercased())" }) { [client] key in
            try await client.counterState(counter.id, status: status, key: key)
            return nil
        }
    }

    func callNext() {
        guard let counter else { return }
        write("call:\(counter.id)", success: { ticket in ticket.map { "Senha \($0.displayCode) chamada" } ?? "Senha chamada" }) { [client] key in
            try await client.callNext(counter.id, key: key)
        }
    }

    /// `recall`, `start`, `finish` ou `no-show` na senha atual.
    func act(_ action: String) {
        guard let ticket = current else { return }
        write("\(action):\(ticket.id)", success: { _ in Self.actionDone(action, ticket.displayCode) }) { [client] key in
            try await client.ticketAction(ticket.id, action, key: key)
        }
    }

    func transfer(queueId: String?, counterId: String?) {
        guard let ticket = current else { return }
        write("transfer:\(ticket.id):\(queueId ?? ""):\(counterId ?? "")", success: { _ in "Senha \(ticket.displayCode) transferida" }) { [client] key in
            try await client.transfer(ticket.id, queueId: queueId, counterId: counterId, key: key)
        }
    }

    /// A ação em andamento é esta?
    func isBusy(_ prefix: String) -> Bool { busy?.hasPrefix(prefix) == true }

    private func write(_ signature: String, success: @escaping (QueueTicket?) -> String, _ block: @escaping (String) async throws -> QueueTicket?) {
        guard busy == nil else { return }
        let key: String
        if let pending, pending.signature == signature {
            key = pending.key
        } else {
            key = QueueClient.newKey()
            pending = PendingWrite(signature: signature, key: key, fingerprint: fingerprint())
        }
        busy = signature
        notice = nil
        Task { [weak self] in
            do {
                let result = try await block(key)
                guard let self else { return }
                self.pending = nil
                await self.reload()
                self.busy = nil
                self.onMessage(success(result))
            } catch {
                guard let self else { return }
                let e = error as? QueueError
                if e?.unauthorized == true { self.onUnauthorized() }
                let retryable = e?.retryable ?? false
                if !retryable { self.pending = nil }
                let text = QueueError.describe(error)
                self.notice = retryable ? "\(text) Toque de novo para repetir com segurança." : text
                self.busy = nil
                if !retryable { await self.reload() }
            }
        }
    }

    /// A leitura nova mostra que o guichê mudou desde a intenção sem resposta (a chamada aconteceu, a senha andou): o
    /// pedido foi confirmado pelo estado, e o próximo toque é uma intenção nova, com chave nova.
    private func settlePending() {
        guard let pending, busy != pending.signature else { return }
        if fingerprint() != pending.fingerprint { self.pending = nil }
    }

    private func fingerprint() -> String {
        [counterId, counter?.status, current?.id, current?.status, current?.callCount.map(String.init), current?.queueId]
            .map { $0 ?? "" }.joined(separator: "|")
    }

    /// A chave guardada para repetir (testes).
    var pendingKey: String? { pending?.key }

    // MARK: - Textos

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "open": return "Aberto"
        case "paused": return "Pausado"
        case "closed": return "Fechado"
        default: return status
        }
    }

    static func ticketStatusLabel(_ status: String) -> String {
        switch status {
        case "waiting": return "Aguardando"
        case "called": return "Chamada"
        case "serving": return "Em atendimento"
        case "done": return "Concluída"
        case "no_show": return "Ausente"
        case "cancelled": return "Cancelada"
        default: return status
        }
    }

    static func actionDone(_ action: String, _ code: String) -> String {
        switch action {
        case "recall": return "Senha \(code) chamada de novo"
        case "start": return "Atendimento de \(code) iniciado"
        case "finish": return "Atendimento de \(code) concluído"
        case "no-show": return "\(code) marcada como ausente"
        default: return "Feito"
        }
    }
}
