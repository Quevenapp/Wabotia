import CoreLocation
import Foundation

/// O que o modo entregador usa do sistema; trocável nos testes.
@MainActor
struct CourierServices {
    var api: CourierAPI
    var store: CourierGrantStore
    var location: CourierLocating
    var demo: Bool
    /// Destino do endereço em texto, no próprio aparelho (CLGeocoder), uma vez por entrega.
    var geocode: (String) async -> CourierCoordinate?
    var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    /// O aviso de compartilhamento já foi aceito neste aparelho (mostrado antes de pedir a permissão).
    var disclosureAccepted: () -> Bool
    var acceptDisclosure: () -> Void
    /// Quanto esperar entre duas leituras de conferência das entregas (revogação, mudanças da loja).
    var refreshSeconds: TimeInterval = 30

    static func live() -> CourierServices {
        CourierServices(api: HTTPCourierAPI(), store: KeychainCourierGrantStore(), location: SystemCourierLocation(), demo: false,
                        geocode: { address in
                            let marks = try? await CLGeocoder().geocodeAddressString(address.replacingOccurrences(of: "\n", with: ", "))
                            return marks?.first?.location.map { CourierCoordinate(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude) }
                        },
                        disclosureAccepted: { UserDefaults.standard.bool(forKey: "courier.disclosure.accepted") },
                        acceptDisclosure: { UserDefaults.standard.set(true, forKey: "courier.disclosure.accepted") })
    }

    /// Demonstração: pedidos fictícios, posição simulada, nada guardado.
    static func demo() -> CourierServices {
        var accepted = false
        return CourierServices(api: DemoCourierAPI(), store: MemoryCourierGrantStore(), location: SimulatedCourierLocation(), demo: true,
                               geocode: { _ in nil }, disclosureAccepted: { accepted }, acceptDisclosure: { accepted = true }, refreshSeconds: 5)
    }
}

/// O entregador sem conta: as entregas lidas pelo QR (várias ao mesmo tempo), a rota com a posição em lotes, a conversa
/// com a loja e com o cliente, e o fim. Cada entrega tem a própria credencial; quando o servidor a revoga (ou a entrega
/// termina), ela sai do aparelho, e sem nenhuma o app volta à primeira tela.
@MainActor
final class CourierViewModel: ObservableObject {
    @Published private(set) var grants: [CourierGrant]
    @Published private(set) var deliveries: [String: CourierDelivery] = [:]
    @Published private(set) var chats: [String: [CourierMessage]] = [:]
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

    init(services: CourierServices) {
        self.services = services
        grants = services.store.load()
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
        services.location.stop()
    }

    func refreshAll() async {
        for grant in grants { await refresh(grant) }
        updateTracking()
    }

    private func refresh(_ grant: CourierGrant) async {
        do {
            let d = try await services.api.delivery(grant)
            deliveries[grant.deliveryId] = d
            if let app = d.app { rhythm = app }
            if !d.open { drop(grant.deliveryId, reason: "\(grant.label): \(d.statusText.lowercased()). O acesso a ela terminou.") }
        } catch let error as CourierError {
            handle(error, grant.deliveryId)
        } catch {}
    }

    // MARK: - QR

    /// O texto lido do QR (ou digitado). `true` quando virou uma entrega neste aparelho.
    @discardableResult
    func scanned(_ text: String) async -> Bool {
        scanError = nil
        guard let scan = CourierScan.parse(text) else {
            scanError = "Este QR não é de um pedido do Wabotia. Peça à loja o QR da entrega."
            return false
        }
        if scan.demo != demo {
            scanError = demo ? "Na demonstração, use o pedido de demonstração." : "Este é um pedido de demonstração."
            return false
        }
        scanning = true
        defer { scanning = false }
        do {
            let grant = try await services.api.redeem(scan)
            if !grants.contains(where: { $0.deliveryId == grant.deliveryId }) { grants.append(grant) } else {
                grants = grants.map { $0.deliveryId == grant.deliveryId ? grant : $0 }
            }
            services.store.save(grants)
            await refresh(grant)
            notice = nil
            return true
        } catch let error as CourierError {
            scanError = error == .revoked ? "Este QR já foi usado ou venceu. Peça à loja um novo." : error.message
        } catch {
            scanError = CourierError.network.message
        }
        return false
    }

    // MARK: - Rota

    /// "Iniciar rota": o aviso de compartilhamento primeiro (uma vez), depois a permissão Quando em uso, depois a saída.
    func startRoute(_ id: String) {
        guard !services.disclosureAccepted() else { proceedStart(id); return }
        disclosureFor = id
    }

    func acceptDisclosure() {
        guard let id = disclosureFor else { return }
        services.acceptDisclosure()
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
        if destination == nil, let address = deliveries[id]?.addressText, !address.isEmpty { destination = await services.geocode(address) }
        do {
            var d = try await services.api.start(grant, destination: destination)
            if d.destination == nil { d.destination = destination }
            deliveries[id] = d
            if let app = d.app { rhythm = app }
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
            try await services.api.delivered(grant)
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

    private func received(_ point: CourierPoint) {
        lastPoint = point
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
        let onRoad = deliveries.values.contains { $0.enRoute && grant($0.id) != nil }
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
            } catch let error as CourierError {
                handle(error, id)
                return
            } catch { return }
        }
    }

    // MARK: - Conversa

    func chatKey(_ id: String, _ peer: CourierPeer) -> String { "\(id)|\(peer.rawValue)" }

    func loadChat(_ id: String, _ peer: CourierPeer) async {
        guard let grant = grant(id) else { return }
        do { chats[chatKey(id, peer)] = try await services.api.messages(grant, with: peer) } catch let error as CourierError { handle(error, id) } catch {}
    }

    func send(_ id: String, _ peer: CourierPeer, _ text: String) async -> Bool {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let grant = grant(id), !clean.isEmpty else { return false }
        do {
            let sent = try await services.api.send(grant, to: peer, text: clean)
            chats[chatKey(id, peer), default: []].append(sent)
            return true
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
        grants.removeAll { $0.deliveryId == id }
        services.store.save(grants)
        deliveries[id] = nil
        queues[id] = nil
        for peer in CourierPeer.allCases { chats[chatKey(id, peer)] = nil }
        notice = reason
        updateTracking()
        if grants.isEmpty {
            close()
            finished = true
        }
    }
}
