import XCTest
@testable import Wabotia

final class CourierScanTests: XCTestCase {
    func testReadsTheServerAndTheCodeFromTheQr() {
        let path = CourierScan.parse("https://wabotia.loja.com.br/entregador/AB12CD34", allowCleartext: false)
        XCTAssertEqual(path?.server.absoluteString, "https://wabotia.loja.com.br")
        XCTAssertEqual(path?.code, "AB12CD34")
        let query = CourierScan.parse(" https://w.example:8443/e?code=xyz_98765 ", allowCleartext: false)
        XCTAssertEqual(query?.server.absoluteString, "https://w.example:8443")
        XCTAssertEqual(query?.code, "xyz_98765")
        XCTAssertEqual(CourierScan.parse("demo-entrega-2")?.demo, true)
    }

    func testRefusesWhatIsNotAnOrderQr() {
        XCTAssertNil(CourierScan.parse("http://w.example/e/AB12CD34", allowCleartext: false), "sem https, fora da depuração, não")
        XCTAssertNil(CourierScan.parse("https://w.example/e/abc", allowCleartext: false), "código curto demais")
        XCTAssertNil(CourierScan.parse("https://w.example/e/AB12<script>", allowCleartext: false))
        XCTAssertNil(CourierScan.parse("Pedido 41"))
        XCTAssertNil(CourierScan.parse("javascript:alert(1)"))
    }
}

final class CourierContractTests: XCTestCase {
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    func testDecodesTheCourierViewOfTheDelivery() throws {
        let json = #"""
        {"id":"dl_1","label":"Pedido nº 12","status":"assigned","status_label":"Atribuída","customer_name":"Mariana","address_text":"Rua A, 1\nCentro",
         "destination":{"lat":-23.5,"lng":-46.6,"source":"device"},"eta":null,"arriving":false,
         "order":{"number":12,"lines":[{"name":"X-Burger","quantity":2,"options":["Bacon"],"note":"sem cebola"}],"item_count":2,"total_cents":4400,
                  "customer_note":"Interfone 32","payment":{"method_label":"Dinheiro","status":"pending","status_label":"A receber","paid":false,"change_for_cents":5000}},
         "chat":{"last_seq":3,"customer_open":true},"app":{"sample_seconds":15,"upload_seconds":60,"near_upload_seconds":30,"stale_minutes":5}}
        """#
        let d = try decoder.decode(CourierDelivery.self, from: Data(json.utf8))
        XCTAssertEqual(d.items, ["2× X-Burger (Bacon) — sem cebola"])
        XCTAssertEqual(d.paymentText, "Dinheiro · a receber R$ 44,00 · troco para R$ 50,00")
        XCTAssertEqual(d.chat?.lastSeq, 3)
        XCTAssertEqual(d.destination, CourierCoordinate(lat: -23.5, lng: -46.6))
        XCTAssertEqual(d.app?.uploadInterval(near: true, battery: 50), 30)
    }

    func testDecodesTheMessagesPage() throws {
        let json = #"{"data":[{"seq":4,"channel":"customer","sender":"customer","author_name":"Mariana","text":"Oi","created":1}],"last_seq":4,"customer_open":false,"open":true}"#
        let page = try decoder.decode(CourierMessagesPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.data.first?.peer, .customer)
        XCTAssertFalse(page.data.first?.mine ?? true)
        XCTAssertEqual(page.customerOpen, false)
    }

    func testMapsTheServerRefusals() {
        XCTAssertEqual(CourierHTTPError.map(status: 401, code: "invalid_token", message: nil, claim: false), .revoked, "qualquer 401 encerra a entrega")
        XCTAssertEqual(CourierHTTPError.map(status: 503, code: "", message: nil, claim: false), .network)
        XCTAssertEqual(CourierHTTPError.map(status: 409, code: "window_closed", message: "Fale com a loja.", claim: false), .server("Fale com a loja."))
        if case .invalidCode(let text) = CourierHTTPError.map(status: 410, code: "claim_used", message: nil, claim: true) {
            XCTAssertTrue(text.contains("já foi lido"))
        } else { XCTFail() }
        if case .invalidCode = CourierHTTPError.map(status: 404, code: "claim_not_found", message: nil, claim: true) {} else { XCTFail() }
        if case .invalidCode(let text) = CourierHTTPError.map(status: 429, code: "", message: nil, claim: true) {
            XCTAssertTrue(text.contains("Espere"))
        } else { XCTFail() }
        XCTAssertEqual(CourierRoutes.messages(CourierGrant(deliveryId: "dl_1", server: "https://w", token: "t", profileId: "p1", label: ""), after: 7),
                       "/api/v1/profiles/p1/entrega/deliveries/dl_1/messages?after=7")
    }
}

final class PositionQueueTests: XCTestCase {
    private func point(_ t: Int64, accuracy: Double = 10) -> CourierPoint { CourierPoint(t: t, lat: -23.5, lng: -46.6, accuracy: accuracy, speed: 5) }

    func testKeepsOnlyUsableNewerPointsForTwoHours() {
        var q = PositionQueue()
        let now: Int64 = 10_000_000
        q.add(point(now - 100), now: now)
        q.add(point(now - 200), now: now)
        q.add(point(now - 50, accuracy: 900), now: now)
        q.add(CourierPoint(t: now - 40, lat: 0, lng: 0, accuracy: 5), now: now)
        XCTAssertEqual(q.points.map(\.t), [now - 100], "mais velho que o último, precisão ruim e 0,0 não entram")
        q.add(point(now + PositionQueue.maxAgeMs + 1), now: now + PositionQueue.maxAgeMs + 1)
        XCTAssertEqual(q.points.count, 1, "o que passou de 2 horas sai")
    }

    func testBatchesOldestFirstAndConfirmsWhatTheServerJudged() {
        var q = PositionQueue()
        for i in 1...450 { q.add(point(Int64(i)), now: 450) }
        let first = q.batch(limit: 999)
        XCTAssertEqual(first.count, 200, "no máximo 200 por lote")
        XCTAssertEqual(first.first?.t, 1)
        q.confirm(sent: first, lastAt: 150)
        XCTAssertEqual(q.points.first?.t, 201, "aceitos até last_at e ignorados do mesmo lote saem")
        q.confirm(sent: [], lastAt: nil)
        XCTAssertEqual(q.points.count, 250, "resposta sem nada novo não apaga")
    }

    func testRhythmFollowsTheServerAndTheBattery() {
        let r = CourierRhythm(sampleSeconds: 15, uploadSeconds: 60, nearUploadSeconds: 30, staleMinutes: 5, maxBatch: 500)
        XCTAssertEqual(r.uploadInterval(near: false, battery: 80), 60)
        XCTAssertEqual(r.uploadInterval(near: true, battery: 80), 30)
        XCTAssertEqual(r.uploadInterval(near: true, battery: 10), 60, "abaixo de 15 % de bateria, o dobro")
        XCTAssertEqual(r.batchLimit, 200)
        XCTAssertEqual(CourierRhythm(uploadSeconds: nil).uploadInterval(near: false, battery: nil), 60)
    }
}

@MainActor
final class FakeCourierAPI: CourierAPI {
    var deliveries: [String: CourierDelivery] = [:]
    var revoked: Set<String> = []
    var started: [(String, CourierCoordinate?)] = []
    var batches: [[CourierPoint]] = []
    var positionsReply = CourierPositionsReply(active: true, status: "en_route", accepted: 1, ignored: 0, lastAt: nil, eta: CourierEta(minutes: 9, at: nil, distanceM: 2400), arriving: false)
    var deliveredIds: [String] = []
    var sent: [String] = []
    var claims: [(name: String, device: String)] = []
    /// Conversa de cada entrega (servidor de mentira).
    var feed: [String: [CourierMessage]] = [:]
    var windowClosed = false
    private var count = 0
    private var seq = 0

    func claim(_ scan: CourierScan, name: String, device: String) async throws -> CourierClaim {
        guard scan.code != "USEDCODE1" else { throw CourierError.invalidCode("Este QR já foi lido.") }
        claims.append((name, device))
        count += 1
        let id = "d\(count)"
        deliveries[id] = CourierDelivery(id: id, label: "Pedido nº \(count)", status: "assigned", customerName: "Cliente", addressText: "Rua \(count), 10",
                                         chat: CourierChatState(lastSeq: 0, customerOpen: true), app: CourierRhythm(uploadSeconds: 5, nearUploadSeconds: 5))
        let grant = CourierGrant(deliveryId: id, server: scan.server.absoluteString, token: "wabx_\(count)", profileId: "p1", label: "Pedido nº \(count)")
        return CourierClaim(grant: grant, delivery: deliveries[id])
    }

    func delivery(_ g: CourierGrant) async throws -> CourierDelivery {
        if revoked.contains(g.deliveryId) { throw CourierError.revoked }
        return deliveries[g.deliveryId]!
    }

    func start(_ g: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery? {
        started.append((g.deliveryId, destination))
        deliveries[g.deliveryId]?.status = "en_route"
        return deliveries[g.deliveryId]!
    }

    func setDestination(_ g: CourierGrant, _ destination: CourierCoordinate) async throws {}

    func positions(_ g: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply {
        batches.append(points)
        var reply = positionsReply
        reply.lastAt = points.last?.t
        reply.chat = CourierChatState(lastSeq: feed[g.deliveryId]?.last?.seq ?? 0)
        return reply
    }

    func delivered(_ g: CourierGrant, note: String?) async throws { deliveredIds.append(g.deliveryId) }
    func cancel(_ g: CourierGrant, reason: String) async throws {}

    func messages(_ g: CourierGrant, after: Int) async throws -> CourierMessagesPage {
        let list = (feed[g.deliveryId] ?? []).filter { $0.seq > after }
        return CourierMessagesPage(data: list, lastSeq: list.last?.seq ?? after, customerOpen: !windowClosed, open: true)
    }

    func send(_ g: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage {
        if peer == .customer, windowClosed { throw CourierError.server("O cliente não escreve para a loja há mais de 24 horas.") }
        sent.append("\(peer.rawValue):\(text)")
        return post(g.deliveryId, peer, "courier", text)
    }

    @discardableResult
    func post(_ id: String, _ peer: CourierPeer, _ sender: String, _ text: String) -> CourierMessage {
        seq += 1
        let m = CourierMessage(seq: seq, channel: peer.rawValue, sender: sender, authorName: sender == "store" ? "Loja" : nil, text: text, created: 0)
        feed[id, default: []].append(m)
        return m
    }
}

@MainActor
final class FakeCourierLocation: CourierLocating {
    var authorization: CourierLocationAuth = .notDetermined
    var onPoint: ((CourierPoint) -> Void)?
    var onAuthorization: ((CourierLocationAuth) -> Void)?
    var grant = true
    var running = false
    var battery: Int? = 80
    func requestPermission() {
        authorization = grant ? .allowed : .denied
        onAuthorization?(authorization)
    }
    func start(near: Bool, toward destination: CourierCoordinate?) { running = true }
    func stop() { running = false }
}

@MainActor
final class CourierViewModelTests: XCTestCase {
    private var api = FakeCourierAPI()
    private var location = FakeCourierLocation()
    private var store = MemoryCourierGrantStore()
    private var accepted = false
    private var geocoded = CourierCoordinate(lat: -23.56, lng: -46.65)

    private func model() -> CourierViewModel {
        api = FakeCourierAPI()
        location = FakeCourierLocation()
        store = MemoryCourierGrantStore()
        accepted = false
        let services = CourierServices(api: api, store: store, location: location, demo: false, geocode: { [unowned self] _ in self.geocoded },
                                       disclosureAccepted: { [unowned self] in self.accepted }, acceptDisclosure: { [unowned self] in self.accepted = true },
                                       loadName: { "Carlos Souza" }, saveName: { _ in }, device: "iPhone (iOS 16.7)")
        return CourierViewModel(services: services)
    }

    func testTheClaimCarriesTheNameAndTheDeviceAndNeedsAName() async {
        let vm = model()
        await vm.scanned("https://w.example/c/AAAA1111")
        XCTAssertEqual(api.claims.first?.name, "Carlos Souza")
        XCTAssertEqual(api.claims.first?.device, "iPhone (iOS 16.7)")
        vm.courierName = "  "
        let read = await vm.scanned("https://w.example/c/BBBB2222")
        XCTAssertFalse(read, "400 sem nome: o app pede antes")
        XCTAssertEqual(api.claims.count, 1)
    }

    func testNewMessagesArriveByLastSeqAndCountAsUnreadUntilSeen() async {
        let vm = model()
        await vm.scanned("https://w.example/c/AAAA1111")
        accepted = true
        location.authorization = .allowed
        vm.startRoute("d1")
        await waitUntil { vm.deliveries["d1"]?.enRoute == true }
        api.post("d1", .store, "store", "O cliente pediu para tocar o interfone 32.")
        api.post("d1", .customer, "customer", "Estou descendo")
        location.onPoint?(CourierPoint(t: Int64(Date().timeIntervalSince1970 * 1000), lat: -23.55, lng: -46.63, accuracy: 10))
        await vm.flush("d1")
        await waitUntil { vm.messages("d1", .customer).count == 1 }
        XCTAssertEqual(vm.messages("d1", .store).map(\.text), ["O cliente pediu para tocar o interfone 32."], "chat.last_seq do lote mudou: o app busca")
        XCTAssertEqual(vm.unread[vm.chatKey("d1", .customer)], 1)
        vm.viewChat("d1", .customer)
        XCTAssertNil(vm.unread[vm.chatKey("d1", .customer)], "aberta, não conta mais")
        XCTAssertEqual(vm.unread[vm.chatKey("d1", .store)], 1)
        vm.close()
    }

    func testClosedCustomerWindowStaysInTheChat() async {
        let vm = model()
        await vm.scanned("https://w.example/c/AAAA1111")
        api.windowClosed = true
        await vm.loadChat("d1")
        XCTAssertFalse(vm.customerOpen("d1"), "customer_open falso: o app avisa antes")
        let sent = await vm.send("d1", .customer, "Cheguei")
        XCTAssertFalse(sent)
        XCTAssertNotNil(vm.chatError, "409 window_closed fica na conversa, sem derrubar a entrega")
        XCTAssertNotNil(vm.grant("d1"))
    }

    func testBackgroundSendsTheQueueAndStopsTheGps() async {
        let vm = model()
        await vm.scanned("https://w.example/c/AAAA1111")
        accepted = true
        location.authorization = .allowed
        vm.startRoute("d1")
        await waitUntil { vm.deliveries["d1"]?.enRoute == true }
        XCTAssertTrue(location.running)
        location.onPoint?(CourierPoint(t: Int64(Date().timeIntervalSince1970 * 1000), lat: -23.55, lng: -46.63, accuracy: 10))
        await vm.pause()
        XCTAssertFalse(location.running, "só Quando em uso: em segundo plano o GPS para")
        XCTAssertEqual(api.batches.count, 1, "o que estava na fila foi antes de parar")
        await vm.resume()
        XCTAssertTrue(location.running, "de volta ao app, retoma")
        vm.close()
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testScanningTwoOrdersKeepsTwoDeliveries() async {
        let vm = model()
        let first = await vm.scanned("https://w.example/e/AAAA1111")
        let second = await vm.scanned("https://w.example/e/BBBB2222")
        XCTAssertTrue(first && second)
        XCTAssertEqual(vm.ordered.map(\.displayLabel), ["Pedido nº 1", "Pedido nº 2"], "várias entregas ao mesmo tempo")
        XCTAssertEqual(store.load().count, 2, "as credenciais ficam guardadas")
        let used = await vm.scanned("https://w.example/e/USEDCODE1")
        XCTAssertFalse(used)
        XCTAssertNotNil(vm.scanError)
        let demo = await vm.scanned("DEMO-ENTREGA-1")
        XCTAssertFalse(demo, "pedido da demonstração fora da demonstração")
    }

    func testDisclosureComesBeforeThePermissionThenTheRouteStarts() async {
        let vm = model()
        await vm.scanned("https://w.example/e/AAAA1111")
        vm.startRoute("d1")
        XCTAssertEqual(vm.disclosureFor, "d1", "o aviso aparece antes de qualquer pedido de permissão")
        XCTAssertEqual(location.authorization, .notDetermined)
        vm.acceptDisclosure()
        await waitUntil { !api.started.isEmpty }
        XCTAssertEqual(location.authorization, .allowed)
        XCTAssertEqual(api.started.first?.1, geocoded, "sem destino do servidor, o endereço é geocodificado no aparelho")
        XCTAssertTrue(vm.deliveries["d1"]?.enRoute == true)
        XCTAssertTrue(location.running, "GPS ligado só com entrega na rua")
        vm.close()
    }

    func testPositionsGoInBatchesAndTheEndOfTheRouteRevokesAndCloses() async {
        let vm = model()
        await vm.scanned("https://w.example/e/AAAA1111")
        accepted = true
        location.authorization = .allowed
        vm.startRoute("d1")
        await waitUntil { vm.deliveries["d1"]?.enRoute == true }
        let base = Int64(Date().timeIntervalSince1970 * 1000)
        for i in 1...3 { location.onPoint?(CourierPoint(t: base + Int64(i) * 1000, lat: -23.55, lng: -46.63, accuracy: 10)) }
        await vm.flush("d1")
        XCTAssertEqual(api.batches.last?.map(\.t), [base + 1000, base + 2000, base + 3000])
        XCTAssertEqual(vm.deliveries["d1"]?.eta?.minutes, 9, "a previsão vem da resposta do lote")
        api.positionsReply.active = false
        location.onPoint?(CourierPoint(t: base + 4000, lat: -23.55, lng: -46.63, accuracy: 10))
        await vm.flush("d1")
        XCTAssertNil(vm.grant("d1"), "active: false encerra a entrega no aparelho")
        XCTAssertTrue(vm.finished, "sem entregas, volta à primeira tela")
        XCTAssertTrue(store.load().isEmpty)
        XCTAssertFalse(location.running, "GPS desligado")
    }

    func testRevokedOnTheServerLeavesOnlyTheOtherDelivery() async {
        let vm = model()
        await vm.scanned("https://w.example/e/AAAA1111")
        await vm.scanned("https://w.example/e/BBBB2222")
        api.revoked.insert("d1")
        await vm.refreshAll()
        XCTAssertEqual(vm.grants.map(\.deliveryId), ["d2"])
        XCTAssertFalse(vm.finished, "ainda há uma entrega")
        XCTAssertNotNil(vm.notice)
        api.revoked.insert("d2")
        await vm.refreshAll()
        XCTAssertTrue(vm.finished)
    }

    func testDeliveredEndsTheAccessAndChatGoesToTheRightPeer() async {
        let vm = model()
        await vm.scanned("https://w.example/e/AAAA1111")
        let ok = await vm.send("d1", .customer, "  Cheguei na portaria  ")
        XCTAssertTrue(ok)
        XCTAssertEqual(api.sent, ["customer:Cheguei na portaria"])
        XCTAssertEqual(vm.messages("d1", .customer).count, 1)
        XCTAssertTrue(vm.messages("d1", .store).isEmpty, "cada canal na sua conversa")
        await vm.delivered("d1")
        XCTAssertEqual(api.deliveredIds, ["d1"])
        XCTAssertTrue(vm.finished)
        XCTAssertNotNil(vm.notice)
    }

    func testDeniedPermissionAsksForSettingsAndDoesNotStart() async {
        let vm = model()
        await vm.scanned("https://w.example/e/AAAA1111")
        accepted = true
        location.grant = false
        vm.startRoute("d1")
        XCTAssertTrue(vm.locationDenied)
        XCTAssertTrue(api.started.isEmpty)
    }

    func testDemoDeliveryWalksFromScanToDelivered() async {
        let services = CourierServices.demo()
        let vm = CourierViewModel(services: services)
        let read = await vm.scanned("DEMO-ENTREGA-1")
        XCTAssertTrue(read)
        let id = try? XCTUnwrap(vm.grants.first?.deliveryId)
        guard let id else { return }
        XCTAssertNotNil(vm.deliveries[id]?.destination, "a demonstração já tem destino no mapa")
        vm.startRoute(id)
        vm.acceptDisclosure()
        await waitUntil { vm.deliveries[id]?.enRoute == true }
        XCTAssertTrue(vm.deliveries[id]?.enRoute == true)
        await vm.delivered(id)
        XCTAssertTrue(vm.finished, "na demonstração, entregar também revoga e volta à primeira tela")
    }
}
