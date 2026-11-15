import Foundation
import SwiftUI

/// O que o modo aparelho usa do sistema; trocável nos testes.
struct DeviceServices {
    var store: DeviceConfigStore
    var pairing: QueuePairing
    var session: URLSession
    var printer: CouponPrinting
    var settings: PanelSettingsStore
    var audio: () -> PanelCallAudio
    /// O endereço escolhido na tela Servidor (ou o da demonstração).
    var serverURL: String?
    var demo: Bool
    /// Leitura sem WebSocket (3 s na demonstração, 5 s num servidor real).
    var pollInterval: TimeInterval
    /// Quanto o destaque da chamada fica na tela.
    var spotlightSeconds: TimeInterval = 8

    @MainActor
    static func live(serverURL: String?) -> DeviceServices {
        DeviceServices(store: KeychainDeviceConfigStore(), pairing: QueuePairing(), session: QueueHTTP.shared, printer: WabotiaPrinting.shared,
                       settings: DefaultsPanelSettingsStore(), audio: { SpeechPanelAudio() }, serverURL: serverURL, demo: false, pollInterval: 5)
    }

    /// Demonstração: nada vai para o Keychain nem sai do aparelho; o painel fala de verdade. Com `role` (atalhos de
    /// depuração), o aparelho já entra pareado e com o papel escolhido.
    @MainActor
    static func demo(role: DeviceRole? = nil) -> DeviceServices {
        let paired = role.map {
            DeviceConfig(deviceId: "demo-device", baseUrl: DemoMode.serverURL.absoluteString, token: DemoQueue.deviceToken, profileId: DemoMode.profileId,
                         name: "Recepção (demonstração)", role: $0, scopes: DeviceScopes.requested, demo: true)
        }
        return DeviceServices(store: MemoryDeviceConfigStore(paired), pairing: QueuePairing(), session: QueueHTTP.shared, printer: WabotiaPrinting.shared,
                       settings: MemoryPanelSettingsStore(), audio: { SpeechPanelAudio() }, serverURL: DemoMode.serverURL.absoluteString, demo: true, pollInterval: 3)
    }
}

/// O aparelho diante do Wabotia (porta do `DeviceViewModel` do Android): pareamento, a fila ao vivo, a emissão com
/// impressão e a voz das chamadas. A fila nunca é decidida aqui: ordem, número e espera vêm do servidor.
@MainActor
final class DeviceViewModel: ObservableObject {
    struct PairingUI: Equatable {
        var userCode: String?
        var error: String?
        var busy = false
    }

    static let revokedNotice = "Este aparelho foi desconectado no Wabotia. Desfaça o pareamento nos ajustes e conecte de novo."
    static let operateNotice = "O administrador liberou também “Chamar e transferir senhas”, que o modo aparelho não usa. Para um totem mais seguro, revogue e aprove de novo só Ler e Emitir."
    static let moduleOffNotice = "A fila de senhas está desligada neste Wabotia. Um administrador liga em Módulos."

    @Published private(set) var config: DeviceConfig?
    @Published private(set) var serverURL: String?
    let demo: Bool
    @Published private(set) var pairing = PairingUI()
    @Published private(set) var overview: QueueOverview?
    /// WebSocket aberto: as chamadas chegam na hora.
    @Published private(set) var live = false
    /// Sem resposta do Wabotia: o totem não emite.
    @Published private(set) var offline = false
    @Published private(set) var busy = false
    /// Fila tocada no totem, esperando Normal ou Preferencial.
    @Published var choosing: QueueInfo?
    @Published private(set) var issued: QueueTicket?
    @Published private(set) var couponPrint: TicketPrint?
    @Published var notice: String?
    @Published private(set) var spotlight: StationCall?
    @Published private(set) var soundEnabled = true
    @Published private(set) var template = PanelTemplate.default
    @Published private(set) var pinSet = false
    @Published var pinError: String?
    /// O aparelho deixou de valer no servidor (revogado): só resta parear de novo.
    @Published private(set) var revoked = false
    /// O pareamento terminou (desfeito ou saída da demonstração): a tela do modo aparelho fecha.
    @Published private(set) var finished = false

    /// Nome, documento, endereço, telefone e rodapé do cupom, lidos do servidor ao conectar.
    @Published private(set) var establishment: Establishment?

    private let services: DeviceServices
    private var feed: QueueLiveFeed?
    private var client: QueueClient?
    private var audio: PanelCallAudio = SilentPanelAudio()
    private let announcer = PanelCallAnnouncer()
    private let pinAttempts = PanelPinAttempts()
    private var pairingTask: Task<Void, Never>?
    private var spotlightTask: Task<Void, Never>?
    private var issuedTask: Task<Void, Never>?

    init(services: DeviceServices) {
        self.services = services
        self.demo = services.demo
        self.serverURL = services.serverURL
        self.config = services.store.load()
        if let config { connect(config) }
    }

    // MARK: - Pareamento

    func startPairing(url: String, name: String) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = demo ? (services.serverURL ?? url) : url
        guard !base.trimmingCharacters(in: .whitespaces).isEmpty, !trimmedName.isEmpty else {
            pairing = PairingUI(error: "Informe o endereço do Wabotia e um nome para este aparelho.")
            return
        }
        let normalized = QueueHTTP.normalize(base)
        serverURL = normalized
        pairing = PairingUI(busy: true)
        pairingTask?.cancel()
        var flow = DevicePairingFlow(pairing: services.pairing)
        if demo { flow.minimumInterval = 1 }
        pairingTask = Task { [weak self] in
            do {
                let config = try await flow.run(baseURL: normalized, name: trimmedName, demo: self?.demo ?? false) { start in
                    self?.pairing = PairingUI(userCode: start.userCode, busy: true)
                    #if DEBUG
                    print("[Wabotia] aparelho: código de pareamento \(start.userCode) (escopos pedidos: \(DeviceScopes.requested.joined(separator: ",")))")
                    #endif
                }
                #if DEBUG
                print("[Wabotia] aparelho: pareado com a área \(config.profileId), escopos \(config.scopes?.joined(separator: ",") ?? "-")")
                #endif
                guard let self, !Task.isCancelled else { return }
                self.services.store.save(config)
                self.config = config
                self.pairing = PairingUI()
                self.revoked = false
                self.notice = config.scopes?.contains(DeviceScopes.operate) == true ? Self.operateNotice : nil
                self.connect(config)
            } catch is CancellationError {
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.pairing = PairingUI(error: DevicePairingFlow.message(for: error))
            }
        }
    }

    func cancelPairing() {
        pairingTask?.cancel()
        pairingTask = nil
        pairing = PairingUI()
    }

    func chooseRole(_ role: DeviceRole) {
        guard var config else { return }
        if role.totem, !config.canIssue {
            notice = "O administrador não liberou “Emitir senhas” para este aparelho: use-o como painel de chamadas."
            return
        }
        config.role = role
        services.store.save(config)
        self.config = config
        notice = nil
        audio.stop()
        audio = role.panel ? services.audio() : SilentPanelAudio()
        loadLocalSettings(config)
        // O totem não anuncia, mas guarda o que já foi chamado, para não recitar ao virar painel.
        if let overview { announce(overview.stationCalls) }
    }

    func setTemplate(_ template: PanelTemplate) {
        guard let id = config?.deviceId else { return }
        services.settings.setTemplate(id, template)
        self.template = template
    }

    /// Desfaz o vínculo: avisa o servidor (sem esperar se ele não responder) e esquece a credencial.
    func unpair() {
        let config = self.config
        stopLive()
        if let config { services.settings.savePin(config.deviceId, nil) }
        services.store.save(nil)
        if let config, !config.demo, !revoked {
            let pairing = services.pairing
            Task { try? await pairing.disconnect(baseURL: config.baseUrl, token: config.token) }
        }
        self.config = nil
        overview = nil
        finished = true
    }

    // MARK: - Conexão

    private func connect(_ config: DeviceConfig) {
        stopLive()
        let client = QueueClient(baseURL: config.baseUrl, profileId: config.profileId, session: services.session) { config.token }
        self.client = client
        if config.role?.panel == true { audio = services.audio() }
        loadLocalSettings(config)
        let feed = QueueLiveFeed(client: client, useSocket: !config.demo, pollInterval: services.pollInterval)
        feed.onEvent = { [weak self] event in self?.handle(event) }
        self.feed = feed
        feed.start()
        // Cabeçalho do cupom: o estabelecimento da área (servidor antigo sem a rota: fica o nome do aparelho).
        Task { [weak self] in
            if let found = try? await client.establishment() { self?.establishment = found }
            #if DEBUG
            print("[Wabotia] aparelho: estabelecimento \(self?.establishment.map { "\"\($0.name ?? "")\" configurado=\($0.configured ?? false)" } ?? "indisponível (rota ausente?)")")
            #endif
        }
    }

    private func loadLocalSettings(_ config: DeviceConfig) {
        soundEnabled = services.settings.soundEnabled(config.deviceId)
        pinSet = services.settings.sealedPin(config.deviceId) != nil
        template = services.settings.template(config.deviceId)
    }

    func handle(_ event: QueueLiveFeed.Event) {
        #if DEBUG
        switch event {
        case .live(let on): print("[Wabotia] aparelho: WebSocket \(on ? "aberto" : "fechado")")
        case .failure(let e): print("[Wabotia] aparelho: leitura falhou (\(e.status) \(e.code))")
        case .call(let call): print("[Wabotia] aparelho: quadro call \(call.code ?? "?") \(call.counterName ?? "")")
        case .snapshot(let o): if overview == nil || offline { print("[Wabotia] aparelho: fila lida (\(o.kioskQueues.count) fila(s) no totem, \(o.recentCalls?.count ?? 0) chamada(s))") }
        }
        #endif
        switch event {
        case .snapshot(let overview):
            self.overview = overview
            offline = false
            if notice == Self.revokedNotice || notice == Self.moduleOffNotice { notice = nil }
            announce(overview.stationCalls)
        case .call(let call):
            // A mesma senha na mesma vez não é anunciada duas vezes (o snapshot seguinte a traz de novo).
            announce([call.stationCall(rank: 0)])
        case .failure(let error):
            if error.unauthorized {
                stopLive()
                offline = true
                revoked = true
                notice = Self.revokedNotice
            } else {
                offline = true
                if error.moduleDisabled { notice = Self.moduleOffNotice }
            }
        case .live(let on):
            live = on
        }
    }

    /// Leitura imediata (o botão "tentar de novo" e os testes).
    func refresh() async { await feed?.refresh() }

    func stopLive() {
        feed?.stop()
        feed = nil
        live = false
        audio.stop()
    }

    /// A tela do modo aparelho fechou de vez.
    func close() {
        stopLive()
        pairingTask?.cancel()
        spotlightTask?.cancel()
        issuedTask?.cancel()
    }

    /// Leitura nova (WebSocket ou consulta): as chamadas que o painel ainda não falou são anunciadas. A primeira leitura
    /// só marca o que já estava na tela, para o painel não recitar as chamadas antigas ao abrir.
    private func announce(_ calls: [StationCall]) {
        guard let role = config?.role else { return }
        guard role.panel else {
            announcer.prime(calls)
            return
        }
        let announcement = announcer.announce(calls)
        guard let latest = announcement.latest else { return }
        spotlight = latest
        spotlightTask?.cancel()
        let seconds = services.spotlightSeconds
        spotlightTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.spotlight = nil
        }
        if soundEnabled, announcement.chime {
            audio.chime()
            // Uma chamada sozinha é falada duas vezes, como no Senhapp; várias de uma vez, uma vez cada.
            let times = announcement.spoken.count == 1 ? 2 : 1
            for text in announcement.spoken { for _ in 0..<times { audio.speak(text) } }
        }
    }

    // MARK: - Totem

    func chooseQueue(_ queueId: String) {
        guard !offline, !revoked, config?.canIssue != false, !busy else { return }
        choosing = overview?.queues?.first { $0.id == queueId }
    }

    func cancelChoice() { choosing = nil }

    func issue(preferential: Bool) {
        guard let queue = choosing, let client else { return }
        let key = QueueClient.newKey()
        choosing = nil
        busy = true
        notice = nil
        Task { [weak self] in
            do {
                let ticket = try await issueOnce(client, queueId: queue.id, preferential: preferential, key: key)
                guard let self else { return }
                self.busy = false
                self.issued = ticket
                self.couponPrint = .printing
                #if DEBUG
                print("[Wabotia] aparelho: senha emitida \(ticket.code ?? "?") (\(ticket.source ?? "-"))")
                #endif
                await self.printIssued()
                self.scheduleIssuedDismiss()
            } catch {
                guard let self else { return }
                #if DEBUG
                print("[Wabotia] aparelho: emissão recusada (\((error as? QueueError)?.code ?? "\(error)"))")
                #endif
                self.busy = false
                self.notice = QueueError.describe(error)
                if (error as? QueueError)?.status == 0 { self.offline = true }
            }
        }
    }

    private func printIssued() async {
        guard let issued else { return }
        let header = config?.name.isEmpty == false ? config!.name : "Wabotia"
        couponPrint = await services.printer.print(CouponData.of(issued, header: header, establishment: establishment))
    }

    /// Segunda via: quando a primeira ficou incerta, só com confirmação de quem está no totem.
    func reprint(confirmed: Bool) {
        if case let .failed(_, needsConfirmation)? = couponPrint, needsConfirmation, !confirmed { return }
        couponPrint = .printing
        issuedTask?.cancel()
        Task { [weak self] in
            await self?.printIssued()
            self?.scheduleIssuedDismiss()
        }
    }

    /// O cartão da senha some sozinho, menos quando o cupom falhou: aí fica até "Pronto" ou "Imprimir de novo".
    private func scheduleIssuedDismiss() {
        issuedTask?.cancel()
        guard couponPrint?.isFailure != true else { return }
        let seconds = issuedCardSeconds(printed: couponPrint == .printed)
        issuedTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.clearIssued()
        }
    }

    func clearIssued() {
        issuedTask?.cancel()
        issued = nil
        couponPrint = nil
    }

    // MARK: - Ajustes

    func setSound(_ enabled: Bool) {
        guard let id = config?.deviceId else { return }
        services.settings.setSoundEnabled(id, enabled)
        if !enabled { audio.stop() }
        soundEnabled = enabled
    }

    func testSound() {
        if config?.role?.panel != true { audio = services.audio() }
        audio.chime()
        audio.speak("Senha N 1. Guichê 1.")
    }

    /// `nil` quando o PIN foi guardado; senão, o problema dele.
    func createPin(_ pin: String, confirmation: String) -> String? {
        guard let id = config?.deviceId else { return "Aparelho sem configuração." }
        if let problem = PanelPin.problem(pin) { return problem }
        guard pin == confirmation else { return "Os dois PINs não conferem." }
        services.settings.savePin(id, PanelPin.seal(pin))
        pinSet = true
        return nil
    }

    func removePin() {
        guard let id = config?.deviceId else { return }
        services.settings.savePin(id, nil)
        pinSet = false
    }

    func unlock(_ pin: String) -> Bool {
        guard let id = config?.deviceId, let sealed = services.settings.sealedPin(id) else { return true }
        if pinAttempts.locked {
            pinError = "Muitas tentativas. Aguarde 30 segundos."
            return false
        }
        if PanelPin.matches(pin, sealed: sealed) {
            pinAttempts.succeed()
            pinError = nil
            return true
        }
        pinAttempts.fail()
        pinError = pinAttempts.locked ? "Muitas tentativas. Aguarde 30 segundos." : "PIN incorreto."
        return false
    }
}
