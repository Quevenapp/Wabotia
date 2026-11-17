import CoreLocation
import Foundation
import UIKit

/// O que o modo entregador usa do sistema; trocável nos testes.
@MainActor
struct CourierServices {
    var api: CourierAPI
    var store: CourierGrantStore
    var location: CourierLocating
    var demo: Bool
    /// Destino do endereço em texto, no próprio aparelho (CLGeocoder), uma vez por entrega, perto da posição do entregador
    /// (o endereço da loja vem sem cidade nem país: sem essa referência, "Rua das Flores, 200" pode cair em outro país).
    var geocode: (_ address: String, _ near: CourierCoordinate) async -> CourierCoordinate?
    var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    /// O aviso de compartilhamento já foi aceito neste aparelho (mostrado antes de pedir a permissão).
    /// O aviso de compartilhamento já foi aceito para esta loja (o servidor da entrega): o aviso diz de qual loja é.
    var disclosureAccepted: (String) -> Bool
    var acceptDisclosure: (String) -> Void
    /// Quanto esperar entre duas leituras de conferência das entregas (revogação, mudanças da loja).
    var refreshSeconds: TimeInterval = 30
    /// Sondagem da conversa aberta na tela (sem WebSocket nesta versão).
    var chatPollSeconds: TimeInterval = 15
    /// O nome que o entregador digitou (vai na troca do QR; a loja e o cliente veem o primeiro nome).
    var loadName: () -> String = { UserDefaults.standard.string(forKey: "courier.name") ?? "" }
    var saveName: (String) -> Void = { UserDefaults.standard.set($0, forKey: "courier.name") }
    /// O aparelho, para a loja saber quem leu o QR: modelo e sistema, nunca o nome que a pessoa deu ao aparelho.
    var device: String = "\(UIDevice.current.model) (iOS \(UIDevice.current.systemVersion))"

    static func live() -> CourierServices {
        var location: CourierLocating = SystemCourierLocation()
        #if DEBUG
        if DemoMode.courierSimulated { location = SimulatedCourierLocation(step: 5, stride: 150) }
        #endif
        return CourierServices(api: HTTPCourierAPI(), store: KeychainCourierGrantStore(), location: location, demo: false,
                        geocode: { address, near in
                            let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: near.lat, longitude: near.lng),
                                                          radius: CourierGeocode.searchRadius, identifier: "courier.destination")
                            let marks = (try? await CLGeocoder().geocodeAddressString(address.replacingOccurrences(of: "\n", with: ", "),
                                                                                       in: region, preferredLocale: nil)) ?? []
                            let found = marks.compactMap { $0.location.map { CourierCoordinate(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude) } }
                            return CourierGeocode.pick(found, near: near)
                        },
                        disclosureAccepted: { (UserDefaults.standard.stringArray(forKey: "courier.disclosure.stores") ?? []).contains($0) },
                        acceptDisclosure: { store in
                            let list = UserDefaults.standard.stringArray(forKey: "courier.disclosure.stores") ?? []
                            if !list.contains(store) { UserDefaults.standard.set(list + [store], forKey: "courier.disclosure.stores") }
                        })
    }

    /// Demonstração: pedidos fictícios, posição simulada, nada guardado.
    static func demo() -> CourierServices {
        var accepted: Set<String> = []
        var name = "Carlos"
        return CourierServices(api: DemoCourierAPI(), store: MemoryCourierGrantStore(), location: SimulatedCourierLocation(), demo: true,
                               // A demonstração já traz o destino de cada entrega.
                               geocode: { _, _ in nil }, disclosureAccepted: { accepted.contains($0) }, acceptDisclosure: { accepted.insert($0) }, refreshSeconds: 5,
                               chatPollSeconds: 3, loadName: { name }, saveName: { name = $0 })
    }
}

/// Escolha do destino geocodificado: só um resultado perto do entregador vale (o resto é outro lugar com o mesmo nome).
enum CourierGeocode {
    /// Raio da busca em volta do entregador.
    static let searchRadius: CLLocationDistance = 50_000
    /// Mais longe que isso do entregador, o resultado é descartado (sem destino, a loja informa ou o app tenta de novo).
    static let maxDistance: Double = 150_000

    nonisolated static func pick(_ found: [CourierCoordinate], near: CourierCoordinate) -> CourierCoordinate? {
        found.first { $0.distance(to: near) <= maxDistance }
    }
}

/// O entregador sem conta: as entregas lidas pelo QR (várias ao mesmo tempo), a rota com a posição em lotes, a conversa
/// com a loja e com o cliente, e o fim. Cada entrega tem a própria credencial; quando o servidor a revoga (ou a entrega
/// termina), ela sai do aparelho, e sem nenhuma o app volta à primeira tela.
@MainActor
final class CourierViewModel: ObservableObject {
    @Published private(set) var grants: [CourierGrant]
    @Published private(set) var deliveries: [String: CourierDelivery] = [:]
    /// A conversa de cada entrega (os dois canais juntos, em ordem de `seq`).
    @Published private(set) var feeds: [String: [CourierMessage]] = [:]
    /// Mensagens da loja ou do cliente ainda não vistas, por entrega e canal (`chatKey`).
    @Published private(set) var unread: [String: Int] = [:]
    /// O nome que vai na troca do QR.
    @Published var courierName: String
    /// Recusa ao mandar mensagem (janela do cliente fechada, por exemplo), mostrada na conversa.
    @Published var chatError: String?
    @Published var notice: String?
    @Published var scanError: String?
    @Published private(set) var scanning = false
    @Published private(set) var busy: Set<String> = []
    /// Entrega esperando o aviso de compartilhamento (antes de pedir a permissão).
    @Published var disclosureFor: String?
    @Published private(set) var locationDenied = false
    @Published private(set) var lastPoint: CourierPoint?
    /// Sem nenhuma entrega: o modo entregador fecha e o app volta à primeira tela.
    @Published private(set) var finished = false

    let services: CourierServices
    var demo: Bool { services.demo }
    private var queues: [String: PositionQueue] = [:]
    private var rhythm = CourierRhythm.standard
    private var uploadTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var near = false
    /// A última mensagem lida de cada entrega (`after` da próxima busca).
    private var lastSeq: [String: Int] = [:]
    /// Conversa aberta na tela (não conta como não lida).
    private var viewing: String?
    /// App em segundo plano: GPS parado (permissão só durante o uso).
    private var paused = false

    init(services: CourierServices) {
        self.services = services
        grants = services.store.load()
        courierName = services.loadName()
        services.location.onPoint = { [weak self] point in self?.received(point) }
        services.location.onAuthorization = { [weak self] auth in self?.authorizationChanged(auth) }
    }

    /// As entregas na ordem em que foram lidas.
    var ordered: [CourierDelivery] {
        grants.map { deliveries[$0.deliveryId] ?? CourierDelivery(id: $0.deliveryId, label: $0.label) }
    }

    func grant(_ id: String) -> CourierGrant? { grants.first { $0.deliveryId == id } }

    // MARK: - Abrir e conferir

    func open() {
        Task { await refreshAll() }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64((self?.services.refreshSeconds ?? 30) * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                await self.refreshAll()
            }
        }
    }

    func close() {
        refreshTask?.cancel()
        uploadTask?.cancel()
        uploadTask = nil
        services.location.stop()
    }

    /// O app foi para segundo plano: manda o que está na fila e para o GPS (só "Quando em uso", sem modo de fundo).
    func pause() async {
        paused = true
        services.location.stop()
        uploadTask?.cancel()
        uploadTask = nil
        for id in deliveries.keys.sorted() where deliveries[id]?.enRoute == true { await flush(id) }
    }

    /// De volta ao app: confere as entregas e retoma o GPS das que estão na rua.
    func resume() async {
        guard paused else { return }
        paused = false
        await refreshAll()
    }

    func refreshAll() async {
        for grant in grants { await refresh(grant) }
        updateTracking()
    }

    private func refresh(_ grant: CourierGrant) async {
        do {
            let d = try await services.api.delivery(grant)
            apply(d)
            if !d.open { drop(grant.deliveryId, reason: "\(grant.label): \(d.statusText.lowercased()). O acesso a ela terminou.") }
        } catch let error as CourierError {
            handle(error, grant.deliveryId)
        } catch {}
    }

    private func apply(_ d: CourierDelivery) {
        var d = d
        if d.destination == nil { d.destination = deliveries[d.id]?.destination }
        // A troca do QR e as ações (sair, destino) respondem a entrega sem o pedido e sem a conversa: ficam os da última
        // leitura de `…/courier`.
        if d.order == nil { d.order = deliveries[d.id]?.order }
        if d.chat == nil { d.chat = deliveries[d.id]?.chat }
        deliveries[d.id] = d
        if let app = d.app { rhythm = app }
        if let seq = d.chat?.lastSeq { chatMoved(d.id, to: seq) }
    }

    // MARK: - QR

    /// O QR lido, esperando "Continuar": a loja e o servidor, antes de gastar o código.
    @Published var pending: CourierPending?

    /// 1. O texto lido do QR (ou colado): confere o formato e faz a leitura pública (sem gastar o código). `true` quando
    /// a confirmação com a loja e o servidor está pronta (`pending`).
    @discardableResult
    func scanned(_ text: String) async -> Bool {
        scanError = nil
        pending = nil
        let scan: CourierScan
        switch CourierQR.read(text) {
        case .failure(let refusal):
            scanError = refusal.message
            return false
        case .success(let s):
            scan = s
        }
        if scan.demo != demo {
            scanError = demo ? "Na demonstração, use \"Simular leitura\"." : CourierQR.Refusal.notAnOrder.message
            return false
        }
        scanning = true
        defer { scanning = false }
        do {
            let preview = try await services.api.preview(scan)
            guard preview.valid else {
                scanError = "Este QR não vale mais; peça outro à loja."
                return false
            }
            // O servidor tem de ser o do QR: se a resposta apontar para outro host, não segue.
            if let other = preview.server.flatMap(URL.init(string:))?.host?.lowercased(), other != scan.server.host?.lowercased() {
                scanError = "Este QR aponta para um servidor (\(scan.host)) que diz ser outro (\(other)). Por segurança, a leitura foi cancelada; peça outro QR à loja."
                return false
            }
            pending = CourierPending(scan: scan, store: preview.store?.isEmpty == false ? preview.store! : scan.host)
            return true
        } catch let error as CourierError {
            scanError = error.message
        } catch {
            scanError = CourierError.network.message
        }
        return false
    }

    func cancelPending() { pending = nil }

    /// O nome do entregador ainda não foi digitado neste aparelho (vale para todas as lojas).
    var needsName: Bool { courierName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// 2. "Continuar": com o nome (pedido aqui se ainda não houver), troca o código pela credencial daquela entrega,
    /// no servidor do QR. `true` quando virou uma entrega neste aparelho.
    @discardableResult
    func confirmPending() async -> Bool {
        guard let pending else { return false }
        scanError = nil
        let name = courierName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            scanError = "Digite o seu nome: a loja e o cliente veem quem leva o pedido."
            return false
        }
        services.saveName(name)
        scanning = true
        defer { scanning = false }
        do {
            let claim = try await services.api.claim(pending.scan, name: String(name.prefix(80)), device: services.device)
            var grant = claim.grant
            grant.storeName = pending.store
            if !grants.contains(where: { $0.deliveryId == grant.deliveryId }) { grants.append(grant) } else {
                grants = grants.map { $0.deliveryId == grant.deliveryId ? grant : $0 }
            }
            services.store.save(grants)
            if let d = claim.delivery { apply(d) }
            // A resposta da troca não traz o pedido (itens, pagamento) nem a conversa: a leitura completa vem logo.
            if claim.delivery?.order == nil { await refresh(grant) }
            self.pending = nil
            notice = nil
            return true
        } catch let error as CourierError {
            scanError = error == .revoked ? "Este QR não vale mais; peça outro à loja." : error.message
        } catch {
            scanError = CourierError.network.message
        }
        return false
    }

    /// Ler e já continuar (atalhos de depuração e testes).
    @discardableResult
    func scanAndConfirm(_ text: String) async -> Bool {
        guard await scanned(text) else { return false }
        return await confirmPending()
    }

    /// A loja de uma entrega (para a lista, o título e o aviso de localização).
    func store(_ id: String) -> String? { grant(id)?.storeName }

    /// Demonstração: o próximo QR fictício de "Simular leitura" (alterna as duas lojas).
    var nextDemoQR: String {
        let all = DemoCourierAPI.demoQRs
        return all[min(demoReads, all.count - 1)]
    }
    private var demoReads: Int { grants.filter(\.demo).count + droppedDemo }
    private var droppedDemo = 0

    // MARK: - Rota

    /// "Iniciar rota": o aviso de compartilhamento primeiro (uma vez), depois a permissão Quando em uso, depois a saída.
    func startRoute(_ id: String) {
        guard !services.disclosureAccepted(grant(id)?.host ?? "") else { proceedStart(id); return }
        disclosureFor = id
    }

    func acceptDisclosure() {
        guard let id = disclosureFor else { return }
        services.acceptDisclosure(grant(id)?.host ?? "")
        disclosureFor = nil
        proceedStart(id)
    }

    func declineDisclosure() { disclosureFor = nil }

    private var pendingStart: String?

    private func proceedStart(_ id: String) {
        switch services.location.authorization {
        case .allowed: Task { await start(id) }
        case .notDetermined:
            pendingStart = id
            services.location.requestPermission()
        case .denied:
            locationDenied = true
        }
    }

    private func authorizationChanged(_ auth: CourierLocationAuth) {
        locationDenied = auth == .denied
        guard auth == .allowed, let id = pendingStart else { if auth == .denied { pendingStart = nil }; return }
        pendingStart = nil
        Task { await start(id) }
    }

    private func start(_ id: String) async {
        guard let grant = grant(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        var destination = deliveries[id]?.destination
        if destination == nil, let address = deliveries[id]?.addressText, !address.isEmpty {
            // Sem posição ainda (o GPS liga com a rota), o endereço é procurado no primeiro ponto.
            if let near = lastPoint?.coordinate { destination = await services.geocode(address, near) } else { geocodeLater.insert(id) }
        }
        do {
            if var d = try await services.api.start(grant, destination: destination) {
                if d.destination == nil { d.destination = destination }
                apply(d)
            } else {
                await refresh(grant)
            }
            // Resposta sem a entrega (ou atrasada): a saída foi aceita, a rota começa.
            if deliveries[id]?.enRoute != true { deliveries[id]?.status = "en_route" }
            if deliveries[id]?.destination == nil { deliveries[id]?.destination = destination }
            queues[id] = PositionQueue()
            updateTracking()
        } catch let error as CourierError {
            handle(error, id)
        } catch {}
    }

    /// "Entreguei": o servidor conclui, revoga o acesso e a entrega sai do aparelho.
    func delivered(_ id: String) async {
        guard let grant = grant(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        await flush(id)
        do {
            try await services.api.delivered(grant, note: nil)
            drop(id, reason: "\(grant.label) entregue. Obrigado!")
        } catch let error as CourierError {
            handle(error, id)
        } catch {}
    }

    /// "Não consegui entregar", com o motivo.
    func cancel(_ id: String, reason: String) async {
        guard let grant = grant(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            try await services.api.cancel(grant, reason: reason)
            drop(id, reason: "\(grant.label): a loja foi avisada de que a entrega não foi feita.")
        } catch let error as CourierError {
            handle(error, id)
        } catch {}
    }

    /// Esquece todas as entregas deste aparelho (o servidor revoga as credenciais ao fim de cada uma).
    func leave() {
        for id in grants.map(\.deliveryId) { queues[id] = nil }
        grants = []
        services.store.save([])
        close()
        finished = true
    }

    // MARK: - Posições

    /// Entregas na rua sem destino, esperando a primeira posição para procurar o endereço perto dela.
    private var geocodeLater: Set<String> = []

    private func locateDestination(_ id: String, near: CourierCoordinate) async {
        guard let grant = grant(id), deliveries[id]?.destination == nil, let address = deliveries[id]?.addressText, !address.isEmpty,
              let target = await services.geocode(address, near), deliveries[id]?.destination == nil else { return }
        deliveries[id]?.destination = target
        do { try await services.api.setDestination(grant, target) } catch let error as CourierError { handle(error, id) } catch {}
    }

    private func received(_ point: CourierPoint) {
        lastPoint = point
        if !geocodeLater.isEmpty {
            let ids = geocodeLater
            geocodeLater = []
            for id in ids.sorted() { Task { await locateDestination(id, near: point.coordinate) } }
        }
        let now = services.now()
        for (id, d) in deliveries where d.enRoute { queues[id, default: PositionQueue()].add(point, now: now) }
        // Perto de um destino: alta precisão e envio mais curto.
        let close = deliveries.values.contains { d in
            guard d.enRoute, let target = d.destination else { return false }
            return point.coordinate.distance(to: target) <= 1000 || d.arriving == true
        }
        if close != near {
            near = close
            services.location.start(near: near, toward: trackingTarget)
        }
    }

    private var trackingTarget: CourierCoordinate? { ordered.first { $0.enRoute }?.destination }

    /// Liga o GPS e o envio enquanto houver entrega na rua; desliga quando não houver.
    private func updateTracking() {
        // Em segundo plano o GPS fica parado até o app voltar.
        let onRoad = !paused && deliveries.values.contains { $0.enRoute && grant($0.id) != nil }
        if onRoad {
            services.location.start(near: near, toward: trackingTarget)
            if uploadTask == nil {
                uploadTask = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self else { return }
                        let wait = self.rhythm.uploadInterval(near: self.near, battery: self.services.location.battery)
                        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                        if Task.isCancelled { return }
                        for id in self.deliveries.keys.sorted() where self.deliveries[id]?.enRoute == true { await self.flush(id) }
                    }
                }
            }
        } else {
            services.location.stop()
            uploadTask?.cancel()
            uploadTask = nil
        }
    }

    /// Manda o que está na fila, os mais antigos primeiro, em lotes. Sem rede, a fila espera a próxima vez.
    func flush(_ id: String) async {
        guard let grant = grant(id) else { return }
        while let queue = queues[id], !queue.isEmpty {
            let batch = queue.batch(limit: rhythm.batchLimit)
            do {
                let reply = try await services.api.positions(grant, points: batch, battery: services.location.battery)
                queues[id]?.confirm(sent: batch, lastAt: reply.lastAt)
                if let app = reply.app { rhythm = app }
                if var d = deliveries[id] {
                    d.eta = reply.eta ?? d.eta
                    d.arriving = reply.arriving ?? d.arriving
                    if let status = reply.status { d.status = status }
                    deliveries[id] = d
                }
                if reply.active == false {
                    drop(id, reason: "\(grant.label): a rota terminou no Wabotia.")
                    return
                }
                notice = nil
                // Mensagem nova da loja ou do cliente: busca a conversa.
                if let seq = reply.chat?.lastSeq { chatMoved(id, to: seq) }
            } catch let error as CourierError {
                handle(error, id)
                return
            } catch { return }
        }
    }

    // MARK: - Conversa

    func chatKey(_ id: String, _ peer: CourierPeer) -> String { "\(id)|\(peer.rawValue)" }

    /// As mensagens de um canal da entrega.
    func messages(_ id: String, _ peer: CourierPeer) -> [CourierMessage] { (feeds[id] ?? []).filter { $0.peer == peer } }

    /// Pode escrever ao cliente agora (janela de 24 h aberta, `chat.customer_open`).
    func customerOpen(_ id: String) -> Bool { deliveries[id]?.chat?.customerOpen ?? true }

    /// A conversa aberta na tela: o que chega nela não conta como não lida.
    func viewChat(_ id: String, _ peer: CourierPeer?) {
        viewing = peer.map { chatKey(id, $0) }
        if let peer { unread[chatKey(id, peer)] = nil }
    }

    /// `chat.last_seq` da entrega ou do lote andou: busca o que falta.
    private func chatMoved(_ id: String, to seq: Int) {
        guard seq > (lastSeq[id] ?? 0) else { return }
        Task { await loadChat(id) }
    }

    /// `GET …/messages?after=`: junta o que veio à conversa da entrega (até esgotar, 100 por vez).
    func loadChat(_ id: String) async {
        guard let grant = grant(id) else { return }
        do {
            for _ in 0..<10 {
                let after = lastSeq[id] ?? 0
                let page = try await services.api.messages(grant, after: after)
                if let open = page.customerOpen { deliveries[id]?.chat = CourierChatState(lastSeq: page.lastSeq, customerOpen: open) }
                let newer = page.data.filter { $0.seq > after }
                guard !newer.isEmpty else { return }
                lastSeq[id] = newer.map(\.seq).max() ?? after
                // A mensagem que o entregador acabou de mandar já está na conversa (resposta do envio): não repete.
                let known = Set((feeds[id] ?? []).map(\.seq))
                let fresh = newer.filter { !known.contains($0.seq) }
                feeds[id, default: []].append(contentsOf: fresh)
                feeds[id]?.sort { $0.seq < $1.seq }
                for m in fresh where !m.mine {
                    let key = chatKey(id, m.peer)
                    if key != viewing { unread[key, default: 0] += 1 }
                }
                if fresh.count < 100 { return }
            }
        } catch let error as CourierError { handle(error, id) } catch {}
    }

    func send(_ id: String, _ peer: CourierPeer, _ text: String) async -> Bool {
        let clean = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))
        guard let grant = grant(id), !clean.isEmpty else { return false }
        do {
            let sent = try await services.api.send(grant, to: peer, text: clean)
            if !(feeds[id] ?? []).contains(where: { $0.seq == sent.seq }) { feeds[id, default: []].append(sent) }
            chatError = nil
            return true
        } catch CourierError.server(let text) {
            // 409 window_closed (o cliente não escreve há mais de 24 h), no_conversation, texto longo: fica na conversa.
            chatError = text
        } catch let error as CourierError {
            handle(error, id)
        } catch {}
        return false
    }

    // MARK: - Fim do acesso

    private func handle(_ error: CourierError, _ id: String) {
        switch error {
        case .revoked:
            drop(id, reason: "\(grant(id)?.label ?? "Entrega"): o acesso terminou no Wabotia.")
        case .network:
            notice = error.message
        case .server(let text), .invalidCode(let text):
            notice = text
        }
    }

    /// A entrega sai do aparelho (entregue, cancelada ou revogada). Sem nenhuma, o modo entregador fecha.
    private func drop(_ id: String, reason: String) {
        if grant(id)?.demo == true { droppedDemo += 1 }
        grants.removeAll { $0.deliveryId == id }
        services.store.save(grants)
        deliveries[id] = nil
        queues[id] = nil
        feeds[id] = nil
        lastSeq[id] = nil
        for peer in CourierPeer.allCases { unread[chatKey(id, peer)] = nil }
        notice = reason
        updateTracking()
        if grants.isEmpty {
            close()
            finished = true
        }
    }
}
