import Foundation

/// A entrega da demonstração (e da revisão das lojas): três pedidos fictícios de uma lanchonete, que o "QR" da
/// demonstração entrega um de cada vez. Tudo em memória; nada sai do aparelho. Segue o contrato do app do entregador
/// (docs/ENTREGA.md): a previsão em linha reta × 1,3 a 25 km/h, a conversa por `seq` nos canais `store` e `customer`
/// (a loja e o cliente respondem sozinhos), `chat.last_seq` na resposta das posições, e "Entreguei" revoga o acesso.
@MainActor
final class DemoCourierAPI: CourierAPI {
    private struct Order {
        let id, label, customer, address: String
        let destination: CourierCoordinate
        let lines: [CourierOrder.Line]
        let totalCents: Int
        let payment: CourierOrder.Payment
        let note: String
    }

    private static let orders: [Order] = [
        Order(id: "de_41", label: "Pedido nº 41", customer: "Mariana", address: "Rua Exemplo, 200 — apto 32\nBairro Exemplo",
              destination: CourierCoordinate(lat: -23.5613, lng: -46.6565),
              lines: [.init(name: "X-Burger", quantity: 1, options: ["Molho da casa"], note: nil), .init(name: "Refrigerante lata", quantity: 1)],
              totalCents: 2800, payment: .init(methodLabel: "Dinheiro", status: "pending", statusLabel: "A receber", paid: false, changeForCents: 5000),
              note: "Interfone 32"),
        Order(id: "de_42", label: "Pedido nº 42", customer: "Ricardo", address: "Avenida Fictícia, 1500\nCentro",
              destination: CourierCoordinate(lat: -23.5432, lng: -46.6420),
              lines: [.init(name: "X-Bacon", quantity: 2), .init(name: "Suco natural", quantity: 1)],
              totalCents: 6100, payment: .init(methodLabel: "Pix", status: "paid", statusLabel: "Pago", paid: true), note: ""),
        Order(id: "de_43", label: "Pedido nº 43", customer: "Paula", address: "Travessa Modelo, 12\nVila Exemplo",
              destination: CourierCoordinate(lat: -23.5580, lng: -46.6250),
              lines: [.init(name: "X-Salada", quantity: 1, options: nil, note: "Sem cebola")],
              totalCents: 2200, payment: .init(methodLabel: "Cartão na maquininha", status: "pending", statusLabel: "A receber", paid: false), note: ""),
    ]

    private var deliveries: [String: CourierDelivery] = [:]
    private var lastPosition: [String: CourierPoint] = [:]
    private var feed: [String: [CourierMessage]] = [:]
    private var revoked: Set<String> = []
    private var seq = 0

    static let rhythm = CourierRhythm(sampleSeconds: 3, uploadSeconds: 6, nearUploadSeconds: 4, staleMinutes: 5, maxBatch: 200)

    func claim(_ scan: CourierScan, name: String, device: String) async throws -> CourierClaim {
        await pause()
        guard scan.demo else { throw CourierError.invalidCode("Na demonstração, use o pedido de demonstração.") }
        guard let order = Self.orders.first(where: { deliveries[$0.id] == nil }) else {
            throw CourierError.invalidCode("Os três pedidos de demonstração já foram lidos. Saia do modo entregador e entre de novo para recomeçar.")
        }
        let delivery = CourierDelivery(id: order.id, label: order.label, status: "assigned", statusLabel: "Atribuída", customerName: order.customer,
                                       addressText: order.address, destination: order.destination,
                                       order: CourierOrder(lines: order.lines, totalCents: order.totalCents,
                                                           customerNote: order.note.isEmpty ? nil : order.note, payment: order.payment),
                                       chat: CourierChatState(lastSeq: 0, customerOpen: true), app: Self.rhythm)
        deliveries[order.id] = delivery
        feed[order.id] = []
        post(order.id, .store, "store", "Lanchonete Exemplo", "Oi, \(name.split(separator: " ").first.map(String.init) ?? name)! O \(order.label) já está embalado no balcão.")
        let grant = CourierGrant(deliveryId: order.id, server: DemoMode.serverURL.absoluteString, token: "wabx_demo_\(order.id)",
                                 profileId: DemoMode.profileId, label: order.label, demo: true,
                                 expiresAt: Int64(Date().timeIntervalSince1970 * 1000) + 4 * 3_600_000)
        return CourierClaim(grant: grant, delivery: withChat(order.id))
    }

    func delivery(_ g: CourierGrant) async throws -> CourierDelivery {
        await pause()
        _ = try current(g)
        return withChat(g.deliveryId)
    }

    func start(_ g: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery? {
        await pause()
        var d = try current(g)
        d.status = "en_route"
        d.statusLabel = "A caminho"
        deliveries[g.deliveryId] = d
        later(g.deliveryId, .store, "store", "Lanchonete Exemplo", "Avisamos \(d.customerName ?? "o cliente") que você saiu.", after: 2)
        later(g.deliveryId, .customer, "customer", d.customerName ?? "Cliente", "Oba, obrigado! Estou esperando aqui.", after: 5)
        return withChat(g.deliveryId)
    }

    func setDestination(_ g: CourierGrant, _ destination: CourierCoordinate) async throws {
        var d = try current(g)
        d.destination = destination
        deliveries[g.deliveryId] = d
    }

    func positions(_ g: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply {
        var d = try current(g)
        let chat = CourierChatState(lastSeq: feed[g.deliveryId]?.last?.seq ?? 0, customerOpen: true)
        guard d.enRoute else {
            return CourierPositionsReply(active: d.open, status: d.status, accepted: 0, ignored: points.count, lastAt: nil, app: Self.rhythm, chat: chat)
        }
        let fresh = points.filter { $0.t > (lastPosition[g.deliveryId]?.t ?? 0) }
        if let last = fresh.last { lastPosition[g.deliveryId] = last }
        if let here = lastPosition[g.deliveryId], let target = d.destination {
            let meters = here.coordinate.distance(to: target) * 1.3
            let minutes = Int((meters / (25_000.0 / 60)).rounded(.up))
            d.eta = CourierEta(minutes: minutes, at: Int64(Date().timeIntervalSince1970 * 1000) + Int64(minutes) * 60_000, distanceM: meters)
            if meters <= 500, d.arriving != true {
                d.arriving = true
                later(g.deliveryId, .customer, "customer", d.customerName ?? "Cliente", "Já estou descendo!", after: 2)
            }
        }
        deliveries[g.deliveryId] = d
        return CourierPositionsReply(active: true, status: d.status, accepted: fresh.count, ignored: points.count - fresh.count,
                                     lastAt: lastPosition[g.deliveryId]?.t, eta: d.eta, arriving: d.arriving, app: Self.rhythm, chat: chat)
    }

    func delivered(_ g: CourierGrant, note: String?) async throws {
        await pause()
        var d = try current(g)
        d.status = "delivered"
        deliveries[g.deliveryId] = d
        revoked.insert(g.deliveryId)
    }

    func cancel(_ g: CourierGrant, reason: String) async throws {
        await pause()
        var d = try current(g)
        d.status = "cancelled"
        deliveries[g.deliveryId] = d
        revoked.insert(g.deliveryId)
    }

    func messages(_ g: CourierGrant, after: Int) async throws -> CourierMessagesPage {
        _ = try current(g)
        let list = (feed[g.deliveryId] ?? []).filter { $0.seq > after }
        return CourierMessagesPage(data: Array(list.prefix(100)), lastSeq: list.prefix(100).last?.seq ?? after, customerOpen: true, open: true)
    }

    func send(_ g: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage {
        let d = try current(g)
        let sent = post(g.deliveryId, peer, "courier", "Você", text)
        if peer == .store {
            later(g.deliveryId, .store, "store", "Lanchonete Exemplo", "Certo, obrigado pelo aviso!", after: 3)
        } else {
            later(g.deliveryId, .customer, "customer", d.customerName ?? "Cliente", "Combinado, obrigado!", after: 3)
        }
        return sent
    }

    // MARK: - Apoio

    private func current(_ g: CourierGrant) throws -> CourierDelivery {
        guard !revoked.contains(g.deliveryId), let d = deliveries[g.deliveryId] else { throw CourierError.revoked }
        return d
    }

    private func withChat(_ id: String) -> CourierDelivery {
        var d = deliveries[id]!
        d.chat = CourierChatState(lastSeq: feed[id]?.last?.seq ?? 0, customerOpen: true)
        return d
    }

    @discardableResult
    private func post(_ id: String, _ channel: CourierPeer, _ sender: String, _ author: String, _ text: String) -> CourierMessage {
        seq += 1
        let m = CourierMessage(seq: seq, channel: channel.rawValue, sender: sender, authorName: author, text: text,
                               created: Int64(Date().timeIntervalSince1970 * 1000))
        feed[id, default: []].append(m)
        return m
    }

    private func later(_ id: String, _ channel: CourierPeer, _ sender: String, _ author: String, _ text: String, after seconds: Double) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self, !self.revoked.contains(id) else { return }
            self.post(id, channel, sender, author, text)
        }
    }

    /// A rede de mentira: um instante, para a tela mostrar o "carregando".
    private func pause() async { try? await Task.sleep(nanoseconds: 250_000_000) }
}
