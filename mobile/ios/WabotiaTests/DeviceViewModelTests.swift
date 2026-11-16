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
    var volumes: [Float] = []
    func setVolume(_ level: Float) { volumes.append(level) }
}

final class PanelVolumeTests: XCTestCase {
    func testClampKeepsTheChosenRange() {
        XCTAssertEqual(PanelVolume.clamp(0), 0.1, "zero pareceria som quebrado; para calar há o interruptor")
        XCTAssertEqual(PanelVolume.clamp(1.4), 1)
        XCTAssertEqual(PanelVolume.clamp(0.55), 0.55)
    }

    func testLowWhenTheEffectiveVolumeIsLow() {
        XCTAssertTrue(PanelVolume.isLow(system: 0.2, panel: 1), "volume de mídia do aparelho baixo")
        XCTAssertTrue(PanelVolume.isLow(system: 0.5, panel: 0.4), "os dois juntos: 20%")
        XCTAssertFalse(PanelVolume.isLow(system: 0.6, panel: 1))
        XCTAssertFalse(PanelVolume.isLow(system: nil, panel: 1), "sem leitura do aparelho, só o do app conta")
        XCTAssertTrue(PanelVolume.isLow(system: nil, panel: 0.2))
        XCTAssertEqual(PanelVolume.percent(0.25), "25%")
    }

    func testDefaultsStoreKeepsTheVolumePerDevice() {
        let defaults = UserDefaults(suiteName: "panel-volume-\(UUID().uuidString)")!
        let store = DefaultsPanelSettingsStore(defaults: defaults, keychainService: "test.volume.\(UUID().uuidString)")
        XCTAssertEqual(store.panelVolume("a"), 1, "nunca mexido: o máximo")
        store.setPanelVolume("a", 0.4)
        XCTAssertEqual(store.panelVolume("a"), 0.4, accuracy: 0.0001)
        XCTAssertEqual(store.panelVolume("b"), 1)
        store.setPanelVolume("a", 0)
        XCTAssertEqual(store.panelVolume("a"), 0.1, accuracy: 0.0001)
    }
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

    func testQrComesOnlyWithTheServerLink() throws {
        let with = try XCTUnwrap(SenhaTicketReceipt(CouponData.of(ticket, header: "Totem")).receiptBytes(layout: .portable58mm))
        var noLink = ticket
        noLink.whatsappLink = nil
        let without = try XCTUnwrap(SenhaTicketReceipt(CouponData.of(noLink, header: "Totem")).receiptBytes(layout: .portable58mm))
        XCTAssertGreaterThan(with.count, without.count + 100, "com o link do servidor, o QR entra no cupom")
        XCTAssertTrue(String(decoding: with, as: UTF8.self).contains("WhatsApp"))
        XCTAssertFalse(String(decoding: without, as: UTF8.self).contains("WhatsApp"),
                       "sem linha de WhatsApp na área o servidor manda whatsapp_link nulo, e o cupom sai sem QR")
    }

    func testLinkTooLongForThePaperStillPrintsTheTicket() throws {
        var long = ticket
        long.whatsappLink = "https://wa.me/552090000000?text=" + String(repeating: "Aperte%20ENVIAR%20", count: 200)
        let bytes = try XCTUnwrap(SenhaTicketReceipt(CouponData.of(long, header: "Totem")).receiptBytes(layout: .portable58mm),
                                  "o QR que não cabe na largura do papel não derruba o cupom")
        XCTAssertTrue(String(decoding: bytes, as: UTF8.self).contains("P004"))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("WhatsApp"), "sem QR, sem a legenda dele")
    }

    private func coupon(_ json: String) throws -> QueueCoupon {
        try QueueJSON.decoder.decode(QueueOverview.self, from: Data(#"{"queues":[],"coupon":\#(json)}"#.utf8)).coupon!
    }

    func testCouponFromTheAreaDecidesTheParts() throws {
        let full = try coupon(#"{"establishment":{"name":"Clínica Exemplo","document_display":"11.222.333/0001-81","address":"Rua A, 1\nCentro","phone":"(11) 3000-0000"},"position":true,"footer":"Obrigado pela visita!\nVolte sempre","whatsapp_qr":true,"whatsapp_qr_issue":null,"whatsapp_qr_notice":null}"#)
        XCTAssertNil(full.qrNotice)
        let data = CouponData.of(ticket, header: "Totem da entrada", coupon: full)
        XCTAssertEqual(data.header, "Clínica Exemplo")
        XCTAssertEqual(data.headerLines, ["CNPJ 11.222.333/0001-81", "Rua A, 1", "Centro", "(11) 3000-0000"])
        XCTAssertEqual(data.footerLines, ["Obrigado pela visita!", "Volte sempre"])
        XCTAssertTrue(data.showPosition)
        XCTAssertNotNil(data.whatsappLink, "o QR segue o whatsapp_link da senha")

        let off = try coupon(#"{"establishment":null,"position":false,"footer":null,"whatsapp_qr":false,"whatsapp_qr_issue":"disabled","whatsapp_qr_notice":"O QR do WhatsApp está desligado nas configurações do cupom."}"#)
        var noLink = ticket
        noLink.whatsappLink = nil
        let bare = CouponData.of(noLink, header: "Totem da entrada", establishment: Establishment(name: "Cadastro antigo"), coupon: off)
        XCTAssertEqual(bare.header, "", "estabelecimento nulo: sem cabeçalho, nem o nome do aparelho")
        XCTAssertTrue(bare.headerLines.isEmpty)
        XCTAssertTrue(bare.footerLines.isEmpty)
        XCTAssertFalse(bare.showPosition)
        XCTAssertEqual(off.qrNotice, "O QR do WhatsApp está desligado nas configurações do cupom.")
        let text = String(decoding: try XCTUnwrap(SenhaTicketReceipt(bare).receiptBytes(layout: .portable58mm)), as: UTF8.self)
        XCTAssertFalse(text.contains("frente"), "sem a posição na fila")
        XCTAssertFalse(text.contains("Totem da entrada"))
        XCTAssertTrue(text.contains("P004"))
        XCTAssertFalse(text.contains("O QR do WhatsApp"), "o motivo vai para quem configura, nunca para o papel")
    }

    func testCouponCpfIsMaskedAndOldServersKeepTheOldCoupon() throws {
        let cpf = try coupon(#"{"establishment":{"name":"Maria MEI","document_display":"123.456.789-09","address":"","phone":""},"position":true,"footer":null,"whatsapp_qr":true,"whatsapp_qr_issue":"no_line","whatsapp_qr_notice":""}"#)
        XCTAssertEqual(CouponData.of(ticket, header: "x", coupon: cpf).headerLines, ["CPF ***.456.789-**"], "CPF de quem cadastrou o próprio sai mascarado")
        XCTAssertNotNil(cpf.qrNotice, "motivo sem texto ainda avisa")
        let legacy = CouponData.of(ticket, header: "Totem da entrada", establishment: Establishment(name: "Centro", footer: "Volte"))
        XCTAssertEqual(legacy.header, "Centro")
        XCTAssertEqual(legacy.footerLines, ["Volte"])
        XCTAssertTrue(legacy.showPosition)
        XCTAssertNil(try QueueJSON.decoder.decode(QueueOverview.self, from: Data(#"{"queues":[]}"#.utf8)).coupon)
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

    private func model(role: DeviceRole?, scopes: [String]? = DeviceScopes.requested, issueRetryPause: UInt64 = 1_500_000_000,
                       handler: @escaping (StubURLProtocol.Seen) -> StubURLProtocol.Answer) -> DeviceViewModel {
        StubURLProtocol.reset(handler)
        audio = RecordingAudio()
        printer = FakePrinter()
        settings = MemoryPanelSettingsStore()
        store = MemoryDeviceConfigStore(DeviceConfig(deviceId: "dev", baseUrl: "https://w.example", token: "wab_t", profileId: "p1", name: "Totem da entrada", role: role, scopes: scopes))
        let session = StubURLProtocol.session()
        let services = DeviceServices(store: store, pairing: QueuePairing(session: session), session: session, printer: printer, settings: settings,
                                      audio: { [unowned self] in self.audio }, serverURL: "https://w.example", demo: false, pollInterval: 0.05, spotlightSeconds: 0.2,
                                      issueRetryPause: issueRetryPause)
        return DeviceViewModel(services: services)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<150 where !condition() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testPanelAnnouncesANewCallOnceWithChimeAndTwoReadings() async {
        var reads = 0
        let vm = model(role: .panel) { seen in
            if seen.url.path.hasSuffix("/establishment") { return .json(404, "{}") }
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
        let vm = model(role: .panel) { seen in
            if seen.url.path.hasSuffix("/establishment") { return .json(404, "{}") }
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

    func testPanelVolumeIsAppliedSavedAndUsedByTheSoundTest() async {
        let vm = model(role: .panel) { seen in
            if seen.url.path.hasSuffix("/establishment") { return .json(404, "{}") }
            return .json(200, self.overview(calls: []))
        }
        await waitUntil { vm.overview != nil }
        XCTAssertEqual(vm.panelVolume, 1)
        vm.setPanelVolume(0.5)
        XCTAssertEqual(settings.panelVolume("dev"), 0.5, accuracy: 0.0001)
        XCTAssertEqual(audio.volumes.last ?? 0, 0.5, accuracy: 0.0001, "o player e a voz recebem o volume na hora")
        vm.testSound()
        vm.close()
        XCTAssertEqual(audio.chimes, 1)
        XCTAssertEqual(audio.spoken, ["Senha N 1. Guichê 1."])
        XCTAssertEqual(audio.volumes.last ?? 0, 0.5, accuracy: 0.0001)
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

    func testTotemPrintsWithTheAreaCouponAndShowsWhyTheQrIsMissing() async {
        let vm = model(role: .totem) { seen in
            if seen.method == "POST" {
                return .json(200, #"{"id":"tn","queue_id":"q1","queue_name":"Geral","code":"N004","preferential":false,"status":"waiting","ahead":2,"wait_minutes":8,"created_at":1763215200000,"whatsapp_link":null}"#)
            }
            if seen.url.path.hasSuffix("/establishment") { return .json(200, #"{"name":"Cadastro","footer":"Rodapé antigo"}"#) }
            return .json(200, #"{"queues":[{"id":"q1","name":"Geral","prefix_normal":"N","channels":["kiosk"],"waiting":{"normal":0,"preferential":0}}],"counters":[],"recent_calls":[],"coupon":{"establishment":{"name":"Clínica Exemplo","document_display":"","address":"Rua A, 1","phone":""},"position":true,"footer":"Obrigado!","whatsapp_qr":true,"whatsapp_qr_issue":"no_line","whatsapp_qr_notice":"A área não tem linha de WhatsApp: o QR não sai no cupom."}}"#)
        }
        await waitUntil { vm.overview != nil }
        XCTAssertEqual(vm.couponQrNotice, "A área não tem linha de WhatsApp: o QR não sai no cupom.")
        vm.chooseQueue("q1")
        vm.issue(preferential: false)
        await waitUntil { vm.couponPrint == .printed }
        vm.close()
        let printed = printer.printed.first
        XCTAssertEqual(printed?.header, "Clínica Exemplo", "o cupom da área vale mais que o cadastro lido à parte")
        XCTAssertEqual(printed?.headerLines, ["Rua A, 1"])
        XCTAssertEqual(printed?.footerLines, ["Obrigado!"])
        XCTAssertNil(printed?.whatsappLink)
    }

    func testUncertainIssueReusesTheKeyOnTheNextSameTap() async {
        var posts: [String?] = []
        let vm = model(role: .totem, issueRetryPause: 1_000_000) { seen in
            guard seen.method == "POST" else { return .json(200, self.overview(calls: [])) }
            posts.append(seen.header("Idempotency-Key"))
            // As duas primeiras (a do toque e a repetição automática) ficam sem resposta definitiva.
            return posts.count <= 2 ? .json(503, #"{"error":{"code":"unavailable","message":"Fora do ar"}}"#)
                                    : .json(200, #"{"id":"tn","code":"N003","status":"waiting"}"#)
        }
        await waitUntil { vm.overview != nil }
        vm.chooseQueue("q1")
        vm.issue(preferential: false)
        await waitUntil { !vm.busy && posts.count == 2 }
        XCTAssertNotNil(vm.pendingIssue, "sem resposta definitiva, o pedido fica guardado")
        vm.chooseQueue("q1")
        vm.issue(preferential: false)
        await waitUntil { vm.issued != nil }
        vm.close()
        XCTAssertEqual(posts.count, 3)
        XCTAssertEqual(Set(posts.compactMap { $0 }).count, 1, "o toque seguinte, na mesma fila e tipo, repete a mesma chave")
        XCTAssertNil(vm.pendingIssue)
    }

    func testDefinitiveRefusalStartsANewIssue() async {
        var posts: [String?] = []
        let vm = model(role: .totem, issueRetryPause: 1_000_000) { seen in
            guard seen.method == "POST" else { return .json(200, self.overview(calls: [])) }
            posts.append(seen.header("Idempotency-Key"))
            return .json(422, #"{"error":{"code":"queue_closed","message":"Fila fechada"}}"#)
        }
        await waitUntil { vm.overview != nil }
        vm.chooseQueue("q1")
        vm.issue(preferential: false)
        await waitUntil { !vm.busy && posts.count == 1 }
        XCTAssertNil(vm.pendingIssue, "recusa definitiva: nada foi gravado")
        vm.chooseQueue("q1")
        vm.issue(preferential: true)
        await waitUntil { !vm.busy && posts.count == 2 }
        vm.close()
        XCTAssertNotEqual(posts[0], posts[1])
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
        XCTAssertTrue(vm.suggestPin, "sem PIN, escolher o primeiro papel pede um")
        XCTAssertNil(vm.createPin("258046", confirmation: "258046"), "seis números também servem")
        XCTAssertFalse(vm.suggestPin)
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

    func testPinLockSurvivesReopeningTheApp() async {
        let vm = model(role: .panel) { _ in .json(200, self.overview(calls: [])) }
        XCTAssertNil(vm.createPin("2580", confirmation: "2580"))
        for _ in 0..<5 { XCTAssertFalse(vm.unlock("0000")) }
        XCTAssertEqual(vm.pinError, "Muitas tentativas. Aguarde 30 segundos.")
        vm.close()

        // O app fechado e aberto de novo lê a trava guardada no aparelho.
        let session = StubURLProtocol.session()
        let reopened = DeviceViewModel(services: DeviceServices(store: store, pairing: QueuePairing(session: session), session: session, printer: printer,
                                                                settings: settings, audio: { RecordingAudio() }, serverURL: "https://w.example",
                                                                demo: false, pollInterval: 0.05))
        XCTAssertFalse(reopened.unlock("2580"), "o PIN certo espera a trava acabar")
        XCTAssertTrue(reopened.pinError?.hasPrefix("Muitas tentativas") == true)
        reopened.close()
    }

    func testRevokedDeviceOpensSettingsWithoutThePin() async {
        let vm = model(role: .panel) { _ in .json(401, #"{"error":{"code":"unauthorized","message":"Revogado"}}"#) }
        XCTAssertNil(vm.createPin("2580", confirmation: "2580"))
        XCTAssertTrue(vm.settingsNeedPin)
        await waitUntil { vm.revoked }
        vm.close()
        XCTAssertFalse(vm.settingsNeedPin, "revogado no Wabotia: os ajustes abrem para desfazer e parear de novo")
    }
}
