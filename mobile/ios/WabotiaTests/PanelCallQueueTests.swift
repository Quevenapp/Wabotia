import XCTest
@testable import Wabotia

/// Relógio controlado: o tempo só anda em `advance`.
@MainActor
final class ManualPanelClock: PanelClock {
    private(set) var time = Date(timeIntervalSince1970: 1_000)
    private final class Timer: PanelTimer {
        let at: Date
        let run: @MainActor () -> Void
        var cancelled = false
        init(at: Date, run: @escaping @MainActor () -> Void) { self.at = at; self.run = run }
        func cancel() { cancelled = true }
    }
    private var timers: [Timer] = []

    func now() -> Date { time }

    func schedule(after seconds: TimeInterval, _ run: @escaping @MainActor () -> Void) -> PanelTimer {
        let timer = Timer(at: time.addingTimeInterval(seconds), run: run)
        timers.append(timer)
        return timer
    }

    func advance(_ seconds: TimeInterval) async {
        time = time.addingTimeInterval(seconds)
        let due = timers.filter { !$0.cancelled && $0.at <= time }
        timers.removeAll { $0.cancelled || $0.at <= time }
        for timer in due { timer.run() }
        await settle()
    }
}

/// Deixa as tarefas da fila andarem (sem tempo de relógio).
@MainActor
func settle() async {
    for _ in 0..<20 { await Task.yield() }
}

private func call(_ code: String, ticket: String? = nil) -> StationCall {
    StationCall(ticketId: ticket ?? code, publicNumber: code, stationLabel: "Guichê 1", queueName: "Geral")
}

/// Porta de `tests/queue-call-queue.test.ts`: o destaque acompanha a fala.
@MainActor
final class PanelCallQueueTests: XCTestCase {
    private var clock = ManualPanelClock()
    private var shown: [String?] = []
    /// Os anúncios em curso: o código, se a fala se repetiria (anotado ao terminar) e como terminar.
    private var spoken: [(code: String, hurry: () -> Bool, done: CheckedContinuation<Void, Never>)] = []
    private var short: [Bool] = []
    private var queue: PanelCallQueue!

    override func setUp() async throws {
        clock = ManualPanelClock()
        shown = []
        spoken = []
        short = []
        queue = PanelCallQueue(clock: clock, announce: { [unowned self] call, hurry in
            await withCheckedContinuation { done in self.spoken.append((call.publicNumber, hurry, done)) }
        }, show: { [unowned self] call in self.shown.append(call?.publicNumber) })
    }

    /// Termina o anúncio em curso (anota se a fala se repetiria).
    private func finish() async {
        await settle()
        guard let current = spoken.last else { return XCTFail("nenhum anúncio em curso") }
        short.append(current.hurry())
        spoken.removeLast()
        current.done.resume()
        await settle()
    }

    func testTheHighlightIsTheCallBeingAnnouncedAndTheNextOnlyWhenItsAnnouncementStarts() async {
        queue.push(call("N001"))
        queue.push(call("N002"))
        queue.push(call("N003"))
        await settle()
        XCTAssertEqual(shown, ["N001"], "só a N001 na tela, falando")
        XCTAssertEqual(spoken.map(\.code), ["N001"])
        XCTAssertEqual(queue.waiting.map(\.publicNumber), ["N002", "N003"])
        await finish()
        XCTAssertEqual(shown, ["N001", "N002"])
        await finish()
        await finish()
        XCTAssertEqual(shown, ["N001", "N002", "N003"])
        XCTAssertEqual(short, [true, true, false], "com outras esperando, fala uma vez; a última, duas")
        await clock.advance(queue.timing.hold - 1)
        XCTAssertEqual(shown.last, "N003", "acabou: o destaque fica 12 s")
        await clock.advance(1)
        XCTAssertEqual(shown.last, .some(nil), "e volta ao quadro do snapshot")
    }

    func testABurstOfTwentyInTwentySecondsKeepsAtMostThreeWaitingAndEndsSoon() async {
        for i in 1...20 {
            queue.push(call(String(format: "N%03d", i)))
            XCTAssertLessThanOrEqual(queue.waiting.count, PanelCallTiming.standard.cap)
            await clock.advance(1)
        }
        XCTAssertEqual(queue.waiting.map(\.publicNumber), ["N018", "N019", "N020"], "as mais antigas ficam só em Últimas chamadas")
        for _ in 0..<4 { await finish() }
        XCTAssertEqual(shown, ["N001", "N018", "N019", "N020"])
        XCTAssertTrue(spoken.isEmpty, "nada mais a falar")
    }

    func testTooLongAWaitIsNotAnnouncedAndARecallReplacesTheWaitingOne() async {
        queue.push(call("N001"))
        queue.push(call("N002"))
        queue.push(call("N002", ticket: "N002"))
        XCTAssertEqual(queue.waiting.map(\.publicNumber), ["N002"], "rechamada substitui a que espera, no mesmo lugar")
        queue.push(call("N003"))
        await clock.advance(queue.timing.stale + 1)
        queue.push(call("N004"))
        await finish()
        XCTAssertEqual(shown, ["N001", "N004"], "N002 e N003 passaram de 30 s esperando")
    }

    func testANewCallDuringTheFinalHighlightCancelsTheReturnToTheBoard() async {
        queue.push(call("N001"))
        await finish()
        await clock.advance(5)
        queue.push(call("N002"))
        await clock.advance(queue.timing.hold)
        XCTAssertEqual(shown, ["N001", "N002"], "o destaque final da N001 não apaga a N002")
    }

    func testStopForgetsTheQueueAndALateAnnouncementDoesNotPullIt() async {
        queue.push(call("N001"))
        queue.push(call("N002"))
        await settle()
        queue.stop()
        XCTAssertEqual(shown, ["N001", nil])
        XCTAssertTrue(queue.waiting.isEmpty)
        await finish()
        XCTAssertEqual(shown, ["N001", nil], "o anúncio que termina depois do stop não puxa a N002")
        queue.push(call("N003"))
        await settle()
        XCTAssertEqual(shown.last, "N003", "depois do stop, a fila recomeça")
    }
}

/// O painel inteiro numa rajada de quadros `call` (eventos simulados, sem servidor chamando de verdade).
@MainActor
final class PanelBurstTests: XCTestCase {
    private func frame(_ code: String, count: Int = 1) -> CallFrame {
        CallFrame(ticketId: "t-\(code)", code: code, preferential: false, queueId: "q1", queueName: "Geral", counterId: "c1",
                  counterName: "Guichê 2", callCount: count, recall: count > 1, at: 1, speech: nil)
    }

    private func model(audio: RecordingAudio, clock: ManualPanelClock) -> DeviceViewModel {
        StubURLProtocol.reset { seen in
            if seen.url.path.hasSuffix("/establishment") { return .json(404, "{}") }
            return .json(200, #"{"queues":[],"counters":[],"recent_calls":[]}"#)
        }
        let session = StubURLProtocol.session()
        let store = MemoryDeviceConfigStore(DeviceConfig(deviceId: "dev", baseUrl: "https://w.example", token: "wab_t", profileId: "p1", name: "TV",
                                                         role: .panel, scopes: DeviceScopes.requested))
        let services = DeviceServices(store: store, pairing: QueuePairing(session: session), session: session, printer: FakePrinter(),
                                      settings: MemoryPanelSettingsStore(), audio: { audio }, serverURL: "https://w.example", demo: false,
                                      pollInterval: 30, clock: clock)
        return DeviceViewModel(services: services)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<150 where !condition() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testTheScreenFollowsTheVoiceInABurst() async {
        let audio = RecordingAudio()
        audio.holdSpeech = true
        let clock = ManualPanelClock()
        let vm = model(audio: audio, clock: clock)
        await waitUntil { vm.overview != nil }
        vm.handle(.call(frame("N001")))
        vm.handle(.call(frame("N002")))
        vm.handle(.call(frame("N003")))
        await settle()
        XCTAssertEqual(vm.spotlight?.publicNumber, "N001", "a tela mostra a senha que está sendo falada, não a última chamada")
        XCTAssertEqual(audio.spoken, ["Senha N 1. Guichê 2."])
        audio.finishSpeech()
        await settle()
        XCTAssertEqual(audio.spoken.last, "Senha N 2. Guichê 2.", "com outras esperando, a N001 não se repete")
        XCTAssertEqual(vm.spotlight?.publicNumber, "N002", "a N002 só entra quando a fala dela começa")
        audio.finishSpeech()
        await settle()
        XCTAssertEqual(vm.spotlight?.publicNumber, "N003")
        audio.finishSpeech()
        await settle()
        XCTAssertEqual(audio.spoken.suffix(2), ["Senha N 3. Guichê 2.", "Senha N 3. Guichê 2."], "a última da rajada é falada duas vezes")
        audio.finishSpeech()
        await settle()
        XCTAssertEqual(audio.chimes, 3)
        await clock.advance(11)
        XCTAssertEqual(vm.spotlight?.publicNumber, "N003")
        await clock.advance(1)
        XCTAssertNil(vm.spotlight, "12 s depois, volta ao quadro")
        vm.close()
    }

    func testWithoutSoundEachCallStaysFourSecondsInOrder() async {
        let audio = RecordingAudio()
        let clock = ManualPanelClock()
        let vm = model(audio: audio, clock: clock)
        await waitUntil { vm.overview != nil }
        vm.setSound(false)
        vm.handle(.call(frame("N001")))
        vm.handle(.call(frame("N002")))
        await settle()
        XCTAssertEqual(vm.spotlight?.publicNumber, "N001")
        await clock.advance(3)
        XCTAssertEqual(vm.spotlight?.publicNumber, "N001")
        await clock.advance(1)
        XCTAssertEqual(vm.spotlight?.publicNumber, "N002", "4 s cada, na mesma ordem")
        XCTAssertTrue(audio.spoken.isEmpty)
        XCTAssertEqual(audio.chimes, 0)
        vm.close()
    }

    func testAVoiceThatNeverFinishesDoesNotStopTheQueue() async {
        let audio = RecordingAudio()
        audio.holdSpeech = true
        let clock = ManualPanelClock()
        let vm = model(audio: audio, clock: clock)
        await waitUntil { vm.overview != nil }
        vm.handle(.call(frame("N001")))
        vm.handle(.call(frame("N002")))
        await settle()
        await clock.advance(PanelCallTiming.standard.speechTimeout)
        XCTAssertEqual(vm.spotlight?.publicNumber, "N002", "a voz presa tem teto: a fila segue")
        vm.close()
    }
}
