import XCTest
import ThermalPrinterKit
@testable import Wabotia

/// Gongo e falas registrados, sem som.
final class RecordingAudio: PanelCallAudio {
    var chimes = 0
    var spoken: [String] = []
    func chime() { chimes += 1 }
    func speak(_ text: String) { spoken.append(text) }
    func stop() {}
}

@MainActor
final class FakePrinter: CouponPrinting {
    var hasPrinter = true
    var result: TicketPrint = .printed
    var printed: [CouponData] = []
    func print(_ data: CouponData) async -> TicketPrint {
        printed.append(data)
        return hasPrinter ? result : .noPrinter
    }
}

final class TotemCouponTests: XCTestCase {
    private let ticket = QueueTicket(id: "t1", queueId: "q1", queueName: "Atendimento geral", code: "P004", preferential: true, status: "waiting",
                                     ahead: 3, waitMinutes: 12, createdAt: 1_763_215_200_000, whatsappLink: "https://wa.me/552090000000?text=SENHA%20P004%20X")

    func testCouponText() {
        let data = CouponData.of(ticket, header: "Totem da entrada")
        XCTAssertEqual(CouponText.type(data), "PREFERENCIAL")
        XCTAssertEqual(CouponText.position(data), "3 pessoas à sua frente · cerca de 12 min")
        XCTAssertEqual(CouponText.issued(data), "Emitida em 15/11/2025 11:00", "hora de Brasília")
        var next = data
        next.ahead = 0
        XCTAssertEqual(CouponText.position(next), "Você é o próximo")
        next.ahead = 1
        next.waitMinutes = nil
        XCTAssertEqual(CouponText.position(next), "1 pessoa à sua frente", "sem estimativa (wait_mode off), só as pessoas")
    }

    func testOnlyHttpsLinkGoesToTheQr() {
        var t = ticket
        t.whatsappLink = "javascript:alert(1)"
        XCTAssertNil(CouponData.of(t, header: "x").whatsappLink)
    }

    func testReceiptBytesCarryTheCodeAndClear() throws {
        let receipt = SenhaTicketReceipt(CouponData.of(ticket, header: "Totem da entrada"))
        let bytes = try XCTUnwrap(receipt.receiptBytes(layout: .portable58mm))
        let text = String(decoding: bytes, as: UTF8.self)
        XCTAssertTrue(text.contains("P004"))
        XCTAssertTrue(text.contains("SENHA PREFERENCIAL"))
        receipt.clear()
        XCTAssertNil(receipt.receiptBytes(layout: .portable58mm), "depois de imprimir, o cupom não guarda a senha")
    }

    func testPrintResultMapping() {
        XCTAssertEqual(TicketPrint.of(.delivered), .printed)
        XCTAssertEqual(TicketPrint.of(.failed(message: "x", delivery: .notSent)), .failed(message: "x", reprintNeedsConfirmation: false))
        XCTAssertEqual(TicketPrint.of(.failed(message: "y", delivery: .indeterminate)), .failed(message: "y", reprintNeedsConfirmation: true))
        XCTAssertEqual(issuedCardSeconds(printed: true), 20)
        XCTAssertEqual(issuedCardSeconds(printed: false), 60)
    }
}

@MainActor
final class DeviceViewModelTests: XCTestCase {
    private var audio = RecordingAudio()
    private var printer = FakePrinter()
    private var store = MemoryDeviceConfigStore()
    private var settings = MemoryPanelSettingsStore()

    private func overview(calls: [(String, String, Int)]) -> String {
        let frames = calls.enumerated().map { i, c in
            #"{"ticket_id":"\#(c.0)","code":"\#(c.1)","counter_name":"Guichê 2","call_count":1,"at":\#(c.2)}"#
        }
        return #"{"queues":[{"id":"q1","name":"Geral","prefix_normal":"N","channels":["whatsapp","kiosk"],"waiting":{"normal":2,"preferential":0}}],"counters":[],"recent_calls":[\#(frames.joined(separator: ","))]}"#
    }

    private func model(role: DeviceRole?, scopes: [String]? = DeviceScopes.requested, handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> DeviceViewModel {
        StubURLProtocol.reset(handler)
        audio = RecordingAudio()
        printer = FakePrinter()
        settings = MemoryPanelSettingsStore()
        store = MemoryDeviceConfigStore(DeviceConfig(deviceId: "dev", baseUrl: "https://w.example", token: "wab_t", profileId: "p1", name: "Totem da entrada", role: role, scopes: scopes))
        let session = StubURLProtocol.session()
        let services = DeviceServices(store: store, pairing: QueuePairing(session: session), session: session, printer: printer, settings: settings,
                                      audio: { [unowned self] in self.audio }, serverURL: "https://w.example", demo: false, pollInterval: 0.05, spotlightSeconds: 0.2)
        return DeviceViewModel(services: services)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<150 where !condition() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testPanelAnnouncesANewCallOnceWithChimeAndTwoReadings() async {
        var reads = 0
        let vm = model(role: .panel) { _ in
            reads += 1
            return .json(200, reads < 3 ? self.overview(calls: [("t1", "N001", 1)]) : self.overview(calls: [("t2", "N002", 2), ("t1", "N001", 1)]))
        }
        await waitUntil { audio.spoken.count >= 2 && reads >= 6 }
        vm.close()
        XCTAssertEqual(audio.chimes, 1, "a chamada nova soa uma vez, por mais leituras que venham")
        XCTAssertEqual(audio.spoken, ["Senha N 2. Guichê 2.", "Senha N 2. Guichê 2."], "uma chamada sozinha é falada duas vezes")
        XCTAssertFalse(audio.spoken.contains { $0.contains("N 1") }, "a chamada que já estava na tela ao abrir não é falada")
    }

    func testSilencedPanelDoesNotSpeakButHighlights() async {
        var reads = 0
        let vm = model(role: .panel) { _ in
            reads += 1
            return .json(200, reads < 2 ? self.overview(calls: []) : self.overview(calls: [("t9", "N009", 9)]))
        }
        vm.setSound(false)
        await waitUntil { vm.spotlight != nil }
        vm.close()
        XCTAssertEqual(vm.spotlight?.publicNumber, "N009")
        XCTAssertEqual(audio.chimes, 0)
        XCTAssertTrue(audio.spoken.isEmpty)
        XCTAssertFalse(settings.soundEnabled("dev"))
    }

    func testTotemIssuesPrintsAndNeverAnnounces() async {
        var issuedKeys: [String?] = []
        let vm = model(role: .totem) { seen in
            if seen.method == "POST" {
                issuedKeys.append(seen.header("Idempotency-Key"))
                return .json(200, #"{"id":"tn","queue_id":"q1","queue_name":"Geral","code":"N003","preferential":false,"status":"waiting","ahead":2,"wait_minutes":8,"created_at":1763215200000,"whatsapp_link":"https://wa.me/55209?text=SENHA%20N003"}"#)
            }
            return .json(200, self.overview(calls: [("t1", "N001", 1)]))
        }
        await waitUntil { vm.overview != nil }
        vm.chooseQueue("q1")
        XCTAssertEqual(vm.choosing?.id, "q1")
        vm.issue(preferential: false)
        await waitUntil { vm.couponPrint == .printed }
        vm.close()
        XCTAssertEqual(vm.issued?.code, "N003")
        XCTAssertEqual(printer.printed.map(\.code), ["N003"])
        XCTAssertEqual(printer.printed.first?.header, "Totem da entrada")
        XCTAssertEqual(issuedKeys.count, 1)
        XCTAssertNotNil(issuedKeys.first ?? nil)
        XCTAssertEqual(audio.chimes, 0, "o totem não fala")
        let issueBody = StubURLProtocol.seen.first { $0.method == "POST" }?.json
        XCTAssertEqual(issueBody?["queue_id"] as? String, "q1")
        XCTAssertEqual(issueBody?["preferential"] as? Bool, false)
    }

    func testIndeterminatePrintAsksBeforeReprinting() async {
        let vm = model(role: .totem) { seen in
            seen.method == "POST"
                ? .json(200, #"{"id":"tn","code":"N003","status":"waiting"}"#)
                : .json(200, self.overview(calls: []))
        }
        printer.result = .failed(message: "Conexão caiu no meio", reprintNeedsConfirmation: true)
        await waitUntil { vm.overview != nil }
        vm.chooseQueue("q1")
        vm.issue(preferential: false)
        await waitUntil { vm.couponPrint?.isFailure == true }
        vm.reprint(confirmed: false)
        XCTAssertEqual(printer.printed.count, 1, "sem confirmação, não sai segunda via")
        printer.result = .printed
        vm.reprint(confirmed: true)
        await waitUntil { vm.couponPrint == .printed }
        vm.close()
        XCTAssertEqual(printer.printed.count, 2)
    }

    func testRevokedCredentialStopsTheTotem() async {
        let vm = model(role: .totem) { _ in .json(401, #"{"error":{"code":"unauthorized","message":"Revogado"}}"#) }
        await waitUntil { vm.revoked }
        vm.close()
        XCTAssertTrue(vm.revoked)
        XCTAssertTrue(vm.offline)
        XCTAssertEqual(vm.notice, DeviceViewModel.revokedNotice)
        vm.chooseQueue("q1")
        XCTAssertNil(vm.choosing, "revogado, o totem não emite")
    }

    func testTotemNeedsTheIssueScope() async {
        let vm = model(role: nil, scopes: [DeviceScopes.read]) { _ in .json(200, self.overview(calls: [])) }
        vm.chooseRole(.totem)
        XCTAssertNil(vm.config?.role)
        XCTAssertNotNil(vm.notice)
        vm.chooseRole(.panel)
        XCTAssertEqual(vm.config?.role, .panel)
        XCTAssertEqual(store.load()?.role, .panel, "o papel fica guardado com a credencial")
        vm.close()
    }

    func testPinGuardsAndUnpairForgetsAndTellsTheServer() async {
        let vm = model(role: .panel) { seen in
            seen.url.path.hasSuffix("/pairings/disconnect") ? .json(200, #"{"ok":true}"#) : .json(200, self.overview(calls: []))
        }
        XCTAssertEqual(vm.createPin("1234", confirmation: "1234"), "Escolha um PIN menos óbvio.")
        XCTAssertEqual(vm.createPin("2580", confirmation: "2581"), "Os dois PINs não conferem.")
        XCTAssertNil(vm.createPin("2580", confirmation: "2580"))
        XCTAssertTrue(vm.pinSet)
        XCTAssertFalse(vm.unlock("0000"))
        XCTAssertEqual(vm.pinError, "PIN incorreto.")
        XCTAssertTrue(vm.unlock("2580"))
        vm.unpair()
        XCTAssertTrue(vm.finished)
        XCTAssertNil(store.load())
        XCTAssertNil(settings.sealedPin("dev"))
        await waitUntil { StubURLProtocol.seen.contains { $0.url.path.hasSuffix("/pairings/disconnect") } }
        let disconnect = StubURLProtocol.seen.first { $0.url.path.hasSuffix("/pairings/disconnect") }
        XCTAssertEqual(disconnect?.header("Authorization"), "Bearer wab_t")
    }
}
