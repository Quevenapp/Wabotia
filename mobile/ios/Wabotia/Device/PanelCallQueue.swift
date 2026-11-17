import Foundation

/*
 Fila de anúncios do painel: a tela acompanha a fala (docs/FILA-SENHAS.md, "Painel: a tela acompanha a fala"; porta de
 `web/queue/call-queue.ts`). Numa rajada, o destaque é sempre a senha que está sendo anunciada; a seguinte só toma o
 destaque quando o anúncio dela começa. O resto do quadro (aguardando, últimas chamadas) vem do `snapshot`, fora daqui.

 1. Uma chamada por vez: gongo e a fala duas vezes; se, ao fim da primeira fala, houver outras esperando, não repete.
 2. Sem som, cada chamada fica `silent` segundos no destaque, na mesma ordem.
 3. No máximo `cap` esperando: chegou mais uma, sai a mais antiga da espera (ela continua em "Últimas chamadas").
 4. Esperando há mais de `stale` segundos desde que chegou: não é anunciada.
 5. Rechamada de uma senha que ainda espera substitui a anterior, no mesmo lugar.
 6. Acabou a fila: o último anunciado fica `hold` segundos em destaque e o painel volta à última chamada do `snapshot`.
 */

struct PanelCallTiming: Equatable {
    var cap = 3
    var stale: TimeInterval = 30
    var hold: TimeInterval = 12
    var silent: TimeInterval = 4
    /// Teto de espera por uma fala que o sistema não termina (voz ausente, áudio preso): a fila não para.
    var speechTimeout: TimeInterval = 15

    static let standard = PanelCallTiming()
}

/// O relógio da fila, trocável nos testes (relógio controlado).
@MainActor
protocol PanelClock: AnyObject {
    func now() -> Date
    @discardableResult
    func schedule(after seconds: TimeInterval, _ run: @escaping @MainActor () -> Void) -> PanelTimer
}

@MainActor
protocol PanelTimer: AnyObject {
    func cancel()
}

extension PanelClock {
    /// Espera pelo relógio (a espera sem som).
    func sleep(_ seconds: TimeInterval) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            schedule(after: seconds) { done.resume() }
        }
    }
}

/// O relógio de verdade.
@MainActor
final class SystemPanelClock: PanelClock {
    nonisolated init() {}

    func now() -> Date { Date() }

    func schedule(after seconds: TimeInterval, _ run: @escaping @MainActor () -> Void) -> PanelTimer {
        let task = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
            if !Task.isCancelled { run() }
        }
        return TaskTimer(task)
    }

    private final class TaskTimer: PanelTimer {
        let task: Task<Void, Never>
        init(_ task: Task<Void, Never>) { self.task = task }
        func cancel() { task.cancel() }
    }
}

/// Roda uma vez só (o fim da fala ou o teto de espera, o que vier primeiro).
@MainActor
final class PanelOnce {
    private var run: (() -> Void)?
    init(_ run: @escaping () -> Void) { self.run = run }
    func fire() {
        let run = self.run
        self.run = nil
        run?()
    }
}

@MainActor
final class PanelCallQueue {
    private struct Waiting {
        var call: StationCall
        var at: Date
    }

    let timing: PanelCallTiming
    private let clock: PanelClock
    /// Gongo e fala (ou a espera sem som). `hurry()`: há outras esperando agora; perguntado antes de repetir a fala.
    private let announce: (StationCall, @escaping () -> Bool) async -> Void
    /// A senha em destaque, ou `nil` para voltar ao quadro do `snapshot`.
    private let show: (StationCall?) -> Void

    private var queue: [Waiting] = []
    private var hold: PanelTimer?
    /// Muda a cada `stop()`: um anúncio que termina depois disso não puxa a fila.
    private var generation = 0
    /// Um anúncio em curso.
    private(set) var running = false
    /// A senha em destaque (anunciando ou no destaque final).
    private(set) var current: StationCall?

    init(timing: PanelCallTiming = .standard, clock: PanelClock, announce: @escaping (StationCall, @escaping () -> Bool) async -> Void,
         show: @escaping (StationCall?) -> Void) {
        self.timing = timing
        self.clock = clock
        self.announce = announce
        self.show = show
    }

    /// Senhas esperando a vez de ser anunciadas (sem a atual).
    var waiting: [StationCall] { queue.map(\.call) }

    func push(_ call: StationCall) {
        let item = Waiting(call: call, at: clock.now())
        if let same = queue.firstIndex(where: { $0.call.ticketId == call.ticketId }) {
            queue[same] = item
        } else {
            queue.append(item)
        }
        while queue.count > timing.cap { queue.removeFirst() }
        if !running { next() }
    }

    /// Tela fechada, som desligado no meio, papel trocado: esquece a fila e o destaque.
    func stop() {
        generation += 1
        queue = []
        hold?.cancel()
        hold = nil
        running = false
        if current != nil {
            current = nil
            show(nil)
        }
    }

    private func next() {
        while !queue.isEmpty {
            let item = queue.removeFirst()
            if clock.now().timeIntervalSince(item.at) > timing.stale { continue }
            hold?.cancel()
            hold = nil
            running = true
            current = item.call
            show(item.call)
            let generation = self.generation
            Task { [weak self] in
                guard let self else { return }
                await self.announce(item.call) { [weak self] in !(self?.queue.isEmpty ?? true) }
                guard generation == self.generation else { return }
                self.next()
            }
            return
        }
        running = false
        guard current != nil else { return }
        hold = clock.schedule(after: timing.hold) { [weak self] in
            guard let self else { return }
            self.hold = nil
            self.current = nil
            self.show(nil)
        }
    }
}
