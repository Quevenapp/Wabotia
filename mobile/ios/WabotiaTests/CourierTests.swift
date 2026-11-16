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
    private var count = 0

    func redeem(_ scan: CourierScan) async throws -> CourierGrant {
        guard scan.code != "USEDCODE1" else { throw CourierError.revoked }
        count += 1
        let id = "d\(count)"
        deliveries[id] = CourierDelivery(id: id, label: "Pedido nº \(count)", status: "assigned", customerName: "Cliente \(count)",
                                         addressText: "Rua \(count), 10", destination: nil, app: CourierRhythm(uploadSeconds: 5, nearUploadSeconds: 5))
        return CourierGrant(deliveryId: id, server: scan.server.absoluteString, token: "t\(count)", profileId: "p1", label: "Pedido nº \(count)")
    }

    func delivery(_ g: CourierGrant) async throws -> CourierDelivery {
        if revoked.contains(g.deliveryId) { throw CourierError.revoked }
        return deliveries[g.deliveryId]!
    }

    func start(_ g: CourierGrant, destination: CourierCoordinate?) async throws -> CourierDelivery {
        started.append((g.deliveryId, destination))
        deliveries[g.deliveryId]?.status = "en_route"
        return deliveries[g.deliveryId]!
    }

    func positions(_ g: CourierGrant, points: [CourierPoint], battery: Int?) async throws -> CourierPositionsReply {
        batches.append(points)
        var reply = positionsReply
        reply.lastAt = points.last?.t
        return reply
    }

    func delivered(_ g: CourierGrant) async throws { deliveredIds.append(g.deliveryId) }
    func cancel(_ g: CourierGrant, reason: String) async throws {}
    func messages(_ g: CourierGrant, with peer: CourierPeer) async throws -> [CourierMessage] { [] }
    func send(_ g: CourierGrant, to peer: CourierPeer, text: String) async throws -> CourierMessage {
        sent.append("\(peer.rawValue):\(text)")
        return CourierMessage(id: "m\(sent.count)", from: "courier", text: text, at: 0)
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
                                       disclosureAccepted: { [unowned self] in self.accepted }, acceptDisclosure: { [unowned self] in self.accepted = true })
        return CourierViewModel(services: services)
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
        XCTAssertEqual(vm.chats[vm.chatKey("d1", .customer)]?.count, 1)
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
