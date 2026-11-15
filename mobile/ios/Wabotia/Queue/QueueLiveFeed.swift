import Foundation

/// A fila ao vivo para uma tela (totem, painel, guichê): o WebSocket da fila quando ele abre, com volta automática, e a
/// leitura de `GET /queue` como reserva (a cada 5 s sem WebSocket, com espera dobrando até 30 s quando o Wabotia não
/// responde; a cada 60 s com ele, para corrigir qualquer quadro perdido). Quem usa recebe os eventos em `onEvent`, na
/// thread principal.
@MainActor
final class QueueLiveFeed {
    enum Event {
        case snapshot(QueueOverview)
        case call(CallFrame)
        /// A leitura falhou (rede, credencial, módulo desligado).
        case failure(QueueError)
        /// O WebSocket abriu (`true`) ou caiu (`false`).
        case live(Bool)
    }

    private let client: QueueClient
    private let socketSession: URLSession
    private let useSocket: Bool
    private let pollInterval: TimeInterval
    var onEvent: (Event) -> Void = { _ in }

    private(set) var live = false
    private(set) var running = false
    private var loop: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var pinger: Task<Void, Never>?

    /// - Parameters:
    ///   - useSocket: `false` na demonstração (o protocolo em memória não fala WebSocket) e nos testes.
    ///   - pollInterval: leitura sem WebSocket; 3 s na demonstração.
    init(client: QueueClient, useSocket: Bool, pollInterval: TimeInterval = 5, socketSession: URLSession = .shared) {
        self.client = client
        self.useSocket = useSocket
        self.pollInterval = pollInterval
        self.socketSession = socketSession
    }

    func start() {
        guard !running else { return }
        running = true
        restartLoop()
    }

    func stop() {
        running = false
        loop?.cancel()
        loop = nil
        closeSocket()
        setLive(false)
    }

    /// Leitura imediata (puxar para atualizar, depois de uma escrita). `true` quando a fila respondeu.
    @discardableResult
    func refresh() async -> Bool {
        do {
            let overview = try await client.overview()
            onEvent(.snapshot(overview))
            return true
        } catch let error as QueueError {
            onEvent(.failure(error))
            return false
        } catch {
            return false
        }
    }

    private func restartLoop() {
        loop?.cancel()
        loop = Task { [weak self] in await self?.run() }
    }

    private func run() async {
        var backoff: TimeInterval = 1
        while !Task.isCancelled, running {
            let wait: TimeInterval
            if !live {
                let ok = await refresh()
                if Task.isCancelled || !running { return }
                if useSocket, socket == nil { openSocket() }
                if ok {
                    backoff = 1
                    wait = pollInterval
                } else {
                    wait = backoff
                    backoff = min(backoff * 2, 30)
                }
            } else {
                backoff = 1
                wait = 60
            }
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            if live, !Task.isCancelled, running { await refresh() }
        }
    }

    // MARK: - WebSocket

    private func openSocket() {
        guard let request = client.socketRequest() else { return }
        let task = socketSession.webSocketTask(with: request)
        socket = task
        task.resume()
        // O URLSessionWebSocketTask não avisa a abertura sem delegate: o primeiro ping respondido confirma.
        task.sendPing { [weak self] error in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                if error == nil { self.setLive(true) } else { self.dropped(task) }
            }
        }
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self else { return }
                    let text: String?
                    switch message {
                    case .string(let s): text = s
                    case .data(let d): text = String(data: d, encoding: .utf8)
                    @unknown default: text = nil
                    }
                    if !self.live, self.socket === task { self.setLive(true) }
                    guard let text, let frame = QueueFrame.parse(text) else { continue }
                    switch frame {
                    case .snapshot(let overview): self.onEvent(.snapshot(overview))
                    case .call(let call): self.onEvent(.call(call))
                    case .pong: break
                    }
                } catch {
                    self?.dropped(task)
                    return
                }
            }
        }
        pinger = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard !Task.isCancelled, let self, self.socket === task else { return }
                task.send(.string("{\"type\":\"ping\"}")) { _ in }
            }
        }
    }

    private func dropped(_ task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        closeSocket()
        setLive(false)
        // Sem WebSocket: volta logo à leitura por consulta (o laço podia estar no intervalo longo de 60 s).
        if running { restartLoop() }
    }

    private func closeSocket() {
        receiver?.cancel()
        pinger?.cancel()
        receiver = nil
        pinger = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func setLive(_ value: Bool) {
        guard live != value else { return }
        live = value
        onEvent(.live(value))
    }
}
