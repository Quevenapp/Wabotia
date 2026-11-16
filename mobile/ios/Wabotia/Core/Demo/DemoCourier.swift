import Foundation

/// A entrega da demonstração (e da revisão das lojas): três pedidos fictícios de uma lanchonete, que o "QR" da
/// demonstração entrega um de cada vez. Tudo em memória; nada sai do aparelho. A previsão segue a regra do servidor
/// (linha reta × 1,3 a 25 km/h), a loja e o cliente respondem sozinhos, e "Entreguei" revoga o acesso, como no servidor.
@MainActor
final class DemoCourierAPI: CourierAPI {
    private struct Order {
        let id, label, customer, address: String
        let destination: CourierCoordinate
        let items: [String]
        let payment: String
    }

    private static let orders: [Order] = [
        Order(id: "de_41", label: "Pedido nº 41", customer: "Mariana Costa", address: "Rua Exemplo, 200 — apto 32\nBairro Exemplo",
              destination: CourierCoordinate(lat: -23.5613, lng: -46.6565), items: ["1× X-Burger (molho da casa)", "1× Refrigerante lata"],
              payment: "Dinheiro, troco para R$ 50,00 (total R$ 28,00)"),
        Order(id: "de_42", label: "Pedido nº 42", customer: "Ricardo Almeida", address: "Avenida Fictícia, 1500\nCentro",
              destination: CourierCoordinate(lat: -23.5432, lng: -46.6420), items: ["2× X-Bacon", "1× Suco natural"],
              payment: "Pago pelo Pix"),
        Order(id: "de_43", label: "Pedido nº 43", customer: "Paula Ribeiro", address: "Travessa Modelo, 12\nVila Exemplo",
              destination: CourierCoordinate(lat: -23.5580, lng: -46.6250), items: ["1× X-Salada"],
              payment: "Cartão na maquininha (R$ 22,00)"),
    ]

    private var deliveries: [String: CourierDelivery] = [:]
    private var lastPosition: [String: CourierPoint] = [:]
    private var chats: [String: [CourierMessage]] = [:]
    private var revoked: Set<String> = []
    private var seq = 0

    static let rhythm = CourierRhythm(sampleSeconds: 3, uploadSeconds: 6, nearUploadSeconds: 4, staleMinutes: 5, maxBatch: 200)

    func redeem(_ scan: CourierScan) async throws -> CourierGrant {
        try await pause()
        guard scan.demo else { throw CourierError.invalidCode("Na demonstração, use o pedido de demonstração.") }
        guard let order = Self.orders.first(where: { deliveries[$0.id] == nil }) else {
            throw CourierError.invalidCode("Os três pedidos de demonstração já foram lidos. Saia do modo entregador e entre de novo para recomeçar.")
        }
        deliveries[order.id] = CourierDelivery(id: order.id, label: order.label, status: "assigned", storeName: "Lanchonete Exemplo",
                                               customerName: order.customer, addressText: order.address, destination: order.destination,
                                               items: order.items, paymentText: order.payment, eta: nil, arriving: false, app: Self.rhythm)
        chats[key(order.id, .store)] = [message(order.id, "store", "Oi! O \(order.label) já está embalado no balcão. Bom trabalho!")]
        chats[key(order.id, .customer)] = []
        return CourierGrant(deliveryId: order.id, server: DemoMode.serverURL.absoluteString, token: "wce_demo_\(order.id)",
                            profileId: DemoMode.profileId, label: order.label, demo: true)
    }

    func delivery(_ g: CourierGrant) async throws -> CourierDelivery {
        try await pause()
        return try current(g)
    }

    func start(_ g: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery {
        try await pause()
        var d = try current(g)
        d.status = "en_route"
        deliveries[g.deliveryId] = d
        let customer = d.customerName?.split(separator: " ").first.map(String.init) ?? "cliente"
        appendLater(g.deliveryId, .customer, "Oba, obrigado! Estou esperando aqui.", after: 4)
        appendLater(g.deliveryId, .store, "Avisamos \(customer) que você saiu.", after: 2)
        return d
    }

    func positions(_ g: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply {
        var d = try current(g)
        guard d.enRoute else { return CourierPositionsReply(active: d.open, status: d.status, accepted: 0, ignored: points.count, lastAt: nil, app: Self.rhythm) }
        let fresh = points.filter { $0.t > (lastPosition[g.deliveryId]?.t ?? 0) }
        if let last = fresh.last { lastPosition[g.deliveryId] = last }
        if let here = lastPosition[g.deliveryId], let target = d.destination {
            let meters = here.coordinate.distance(to: target) * 1.3
            let minutes = Int((meters / (25_000.0 / 60)).rounded(.up))
            d.eta = CourierEta(minutes: minutes, at: Int64(Date().timeIntervalSince1970 * 1000) + Int64(minutes) * 60_000, distanceM: meters)
            if meters <= 500, d.arriving != true {
                d.arriving = true
                appendLater(g.deliveryId, .customer, "Já estou descendo!", after: 2)
            }
        }
        deliveries[g.deliveryId] = d
        return CourierPositionsReply(active: true, status: d.status, accepted: fresh.count, ignored: points.count - fresh.count,
                                     lastAt: lastPosition[g.deliveryId]?.t, eta: d.eta, arriving: d.arriving, app: Self.rhythm)
    }

    func delivered(_ g: CourierGrant) async throws {
        try await pause()
        var d = try current(g)
        d.status = "delivered"
        deliveries[g.deliveryId] = d
        revoked.insert(g.deliveryId)
    }

    func cancel(_ g: CourierGrant, reason: String) async throws {
        try await pause()
        var d = try current(g)
        d.status = "cancelled"
        deliveries[g.deliveryId] = d
        revoked.insert(g.deliveryId)
    }

    func messages(_ g: CourierGrant, with peer: CourierPeer) async throws -> [CourierMessage] {
        _ = try current(g)
        return chats[key(g.deliveryId, peer)] ?? []
    }

    func send(_ g: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage {
        _ = try current(g)
        let sent = message(g.deliveryId, "courier", text)
        chats[key(g.deliveryId, peer), default: []].append(sent)
        appendLater(g.deliveryId, peer, peer == .store ? "Certo, obrigado pelo aviso!" : "Combinado, obrigado!", after: 3)
        return sent
    }

    // MARK: - Apoio

    private func current(_ g: CourierGrant) throws -> CourierDelivery {
        guard !revoked.contains(g.deliveryId), let d = deliveries[g.deliveryId] else { throw CourierError.revoked }
        return d
    }

    private func key(_ id: String, _ peer: CourierPeer) -> String { "\(id)|\(peer.rawValue)" }

    private func message(_ id: String, _ from: String, _ text: String) -> CourierMessage {
        seq += 1
        return CourierMessage(id: "dm_\(seq)", from: from, text: text, at: Int64(Date().timeIntervalSince1970 * 1000))
    }

    private func appendLater(_ id: String, _ peer: CourierPeer, _ text: String, after seconds: Double) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self, !self.revoked.contains(id) else { return }
            let from = peer == .store ? "store" : "customer"
            self.chats[self.key(id, peer), default: []].append(self.message(id, from, text))
        }
    }

    /// A rede de mentira: um instante, para a tela mostrar o "carregando".
    private func pause() async throws { try? await Task.sleep(nanoseconds: 250_000_000) }
}
