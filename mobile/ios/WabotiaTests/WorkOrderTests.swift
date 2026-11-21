import XCTest
@testable import Wabotia

/// A ordem de serviço por modelo: regras das telas, campos próprios, corpo da abertura e cache (sem rede).
final class WorkOrderRulesTests: XCTestCase {
    private func next(_ stage: String, _ base: String, kind: String = "manual") -> WorkNextStage {
        WorkNextStage(transitionId: "t-\(stage)", stage: stage, stageLabel: stage.capitalized, baseStatus: base, kind: kind)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try WorkJSON.decode(T.self, Data(json.utf8)) }

    /// 21/11/2026 13:05 em Brasília.
    private let moment: Int64 = 1_795_277_100_000

    func testReasonForCancelAndGoingBackLikeTheServer() {
        XCTAssertTrue(WorkOrderRules.needsReason(from: "in_progress", to: "cancelled"))
        XCTAssertTrue(WorkOrderRules.needsReason(from: "ready", to: "in_progress"))
        XCTAssertTrue(WorkOrderRules.needsReason(from: "analyzing", to: "received"))
        XCTAssertFalse(WorkOrderRules.needsReason(from: "received", to: "analyzing"))
        XCTAssertFalse(WorkOrderRules.needsReason(from: "cancelled", to: "cancelled"))
        XCTAssertFalse(WorkOrderRules.needsReason(from: "approved", to: "declined"))
        XCTAssertEqual(WorkOrderRules.reasonTitle(from: "received", to: "cancelled"), "Motivo do cancelamento")
        XCTAssertEqual(WorkOrderRules.reasonTitle(from: "ready", to: "in_progress"), "Motivo do retrabalho")
        XCTAssertEqual(WorkOrderRules.reasonTitle(from: "in_progress", to: "analyzing"), "Motivo para voltar à análise")
    }

    func testStageButtonsKeepCancelLast() {
        let order = WorkOrder(id: "o", status: "ready", nextStages: [next("cancelada", "cancelled"), next("execucao", "in_progress"), next("entregue", "delivered"),
                                                                    next("aprovacao", "approved", kind: "customer_approval")])
        let buttons = WorkOrderRules.stageButtons(order)
        XCTAssertEqual(buttons.map(\.title), ["Voltar para Execucao", "Avançar para Entregue", "Pedir aprovação do cliente: Aprovacao", "Cancelar ordem"])
        XCTAssertEqual(buttons.map(\.danger), [false, false, false, true])
    }

    func testListQueryMatchesThePanel() {
        let catalog = WorkTypeCatalog(data: [WorkTypeView(id: "service_order", kind: "builtin"), WorkTypeView(id: "oficina"), WorkTypeView(id: "velho", archived: true)])
        let all = WorkOrderRules.listQuery(catalog: catalog, typeId: nil, situation: .open, stage: nil, query: "  placa ")
        XCTAssertEqual(all, ["type_ids": "service_order,oficina", "open": "1", "q": "placa"])
        let staged = WorkOrderRules.listQuery(catalog: catalog, typeId: "oficina", situation: .open, stage: "pronto", query: "")
        XCTAssertEqual(staged, ["type_id": "oficina", "stage": "pronto"])
        XCTAssertEqual(WorkOrderRules.listQuery(catalog: catalog, typeId: "oficina", situation: .delivered, stage: nil, query: "")["status"], "delivered")
        XCTAssertNil(WorkOrderRules.listQuery(catalog: catalog, typeId: nil, situation: .all, stage: nil, query: "")["open"])
        XCTAssertEqual(WorkOrderRules.listKey(["type_id": "oficina", "stage": "pronto"]), "stage=pronto&type_id=oficina")
    }

    func testQuoteIsReadOnlyAndSendNeedsAConversation() {
        var order = WorkOrder(id: "o", status: "analyzing", customer: WorkOrderCustomer(conversationId: "c1"), quote: WorkQuote(totalCents: 100), nextStatuses: ["quoted"])
        XCTAssertTrue(WorkOrderRules.canSendQuote(order))
        order.customer = WorkOrderCustomer()
        XCTAssertFalse(WorkOrderRules.canSendQuote(order))
        let sent = WorkOrder(id: "o", quote: WorkQuote(totalCents: 12_000, validUntil: moment + 7 * 86_400_000, sentAt: moment))
        XCTAssertEqual(WorkOrderRules.quoteStatus(sent), "Enviado em 21/11/2026 13:05, válido até 28/11/2026")
        XCTAssertEqual(WorkOrderRules.quoteStatus(WorkOrder(id: "o", quote: WorkQuote(), decision: WorkDecision(decision: "approved", at: moment))), "Aprovado em 21/11/2026 13:05")
        XCTAssertEqual(WorkOrderRules.quoteStatus(WorkOrder(id: "o", quote: WorkQuote())), "Ainda não enviado")
        XCTAssertEqual(WorkOrderRules.quoteTotal(WorkQuote(items: [WorkQuoteItem(quantity: 4, unitCents: 4_200), WorkQuoteItem(quantity: 1, unitCents: 3_500, discountCents: 500)])), 19_800)
    }

    func testHistoryNeverShowsRawCodes() {
        let stages = [WorkStage(id: "pronto", label: "Pronto", baseStatus: "ready")]
        XCTAssertEqual(WorkOrderRules.historyText(WorkHistoryEntry(id: "1", kind: "opened")), "Ordem aberta")
        XCTAssertEqual(WorkOrderRules.historyText(WorkHistoryEntry(id: "2", kind: "os.checklist_marked", note: "Checklist (Recebido): Foto feito")), "Checklist (Recebido): Foto feito")
        XCTAssertNil(WorkOrderRules.historyNote(WorkHistoryEntry(id: "2", kind: "os.checklist_marked", note: "x")))
        XCTAssertEqual(WorkOrderRules.historyText(WorkHistoryEntry(id: "3", kind: "os.stage_changed", toStage: "pronto"), stages: stages), "Etapa: Pronto")
        XCTAssertEqual(WorkOrderRules.historyNote(WorkHistoryEntry(id: "3", kind: "os.stage_changed", note: " Desistiu ")), "Desistiu")
        XCTAssertEqual(WorkOrderRules.historyText(WorkHistoryEntry(id: "4", kind: "os.codigo_novo")), "Alteração")
    }

    func testMessagesSayWhatToDo() {
        XCTAssertTrue(WorkOrderRules.message(QueueError(status: 413, code: "document_too_large", message: "Documento: document_too_large.")).hasPrefix("A foto não foi aceita"))
        XCTAssertEqual(WorkOrderRules.message(QueueError(status: 409, code: "version_conflict", message: "x")), WorkOrderRules.versionConflict)
        XCTAssertEqual(WorkOrderRules.message(QueueError(status: 403, code: "insufficient_scope", message: "x")), WorkOrderRules.forbidden)
        XCTAssertEqual(WorkOrderRules.message(QueueError(status: 0, code: QueueError.network, message: "x")), WorkOrderRules.offlineAction)
        XCTAssertEqual(WorkOrderRules.message(QueueError(status: 409, code: "module_disabled", message: "x")), ModuleFailure.disabledMessage)
        XCTAssertTrue(WorkOrderRules.isOldServer(QueueError(status: 404, code: "not_found", message: "x")))
        XCTAssertFalse(WorkOrderRules.isOldServer(QueueError(status: 409, code: "module_disabled", message: "x")))
        XCTAssertEqual(WorkOrderRules.offlineBanner(moment), "Sem conexão. Você está vendo a cópia de 21/11 13:05. Para mudar a ordem, conecte-se.")
    }

    func testUploadOnlyToTheSameServer() {
        let base = "https://loja.example"
        XCTAssertEqual(ProfileAPI.sameOrigin(base: base, "/api/v1/profiles/p/service-orders/o/documents/d/content")?.absoluteString,
                       "https://loja.example/api/v1/profiles/p/service-orders/o/documents/d/content")
        XCTAssertNotNil(ProfileAPI.sameOrigin(base: base, "https://LOJA.example/api/x"))
        XCTAssertNil(ProfileAPI.sameOrigin(base: base, "https://outro.example/api/x"))
        XCTAssertNil(ProfileAPI.sameOrigin(base: base, "http://loja.example/api/x"))
        XCTAssertNil(ProfileAPI.sameOrigin(base: base, "https://loja.example:8443/api/x"))
        XCTAssertNil(ProfileAPI.sameOrigin(base: base, "//outro.example/api/x"))
        XCTAssertNil(ProfileAPI.sameOrigin(base: base, "/files/x"))
        XCTAssertEqual(WorkPhoto.targetSize(CGSize(width: 4000, height: 3000)), CGSize(width: 1600, height: 1200))
        XCTAssertEqual(WorkPhoto.targetSize(CGSize(width: 800, height: 600)), CGSize(width: 800, height: 600))
    }

    func testDecodingKeepsFieldIdsAndSkipsNothing() throws {
        let order = try decode(WorkOrder.self, #"{"id":"o1","type_id":"oficina","display_number":"OF-1","stage":"recebido","stage_label":"Recebido","status":"received","extra":{"km_entrada":120,"tem_garantia":true},"fields":[{"id":"km_entrada","label":"Km","kind":"integer","min":0,"max":null}],"object":{"object_id":"obj-1","values":{"placa":"ABC1D23"},"identifier":"ABC1D23","type":{"id":"veiculo","labels":{"singular":"Veículo"},"identifier_field_id":"placa"}},"next_stages":[{"transition_id":"t1","stage":"diagnostico","stage_label":"Diagnóstico","base_status":"analyzing","kind":"manual"}],"checklist":[{"stage_id":"recebido","stage_label":"Recebido","current":true,"items":[{"id":"foto","label":"Foto","required":true,"photo_required":true,"done":false,"photo_document_id":null}],"missing":["Foto"]}],"customer":{"name":"Ana","conversation_id":"c1"},"novo_campo":{"a":1}}"#)
        XCTAssertEqual(order.extra?["km_entrada"], .number(120))
        XCTAssertEqual(order.extra?["tem_garantia"], .bool(true), "as chaves de extra chegam como o servidor mandou")
        XCTAssertEqual(order.object?.values?["placa"], .string("ABC1D23"))
        XCTAssertEqual(order.object?.type?.identifierFieldId, "placa")
        XCTAssertEqual(order.nextStages?.first?.transitionId, "t1")
        XCTAssertEqual(order.checklist?.first?.items?.first?.photoRequired, true)
        XCTAssertEqual(order.customer?.conversationId, "c1")
        XCTAssertFalse(order.isLegacy)
        XCTAssertEqual(order.numberText, "OF-1")
        XCTAssertTrue(try decode(WorkOrder.self, #"{"id":"os_1","status":"received"}"#).isLegacy)
    }
}

final class WorkFieldsTests: XCTestCase {
    private let fields: [WorkField] = [
        WorkField(id: "km", kind: "integer", label: "Km", min: .number(0), max: .number(1000)),
        WorkField(id: "valor", kind: "decimal", label: "Valor", scale: 2),
        WorkField(id: "dia", kind: "date", label: "Dia", min: .string("2026-01-01")),
        WorkField(id: "cor", kind: "choice", label: "Cor", options: [WorkFieldOption(id: "az", label: "Azul")]),
        WorkField(id: "ok", kind: "boolean", label: "Conferido", required: true),
        WorkField(id: "senha", kind: "text", label: "Senha", sensitive: true),
        WorkField(id: "obs", kind: "text", label: "Observação", maxLength: 5),
    ]

    private func message(_ draft: [String: String]) -> String? {
        if case .failure(let e) = WorkFields.parse(fields, draft: draft) { return e.message }
        return nil
    }

    func testValidationLikeThePanel() {
        XCTAssertEqual(message([:]), "Conferido: preenchimento obrigatório.")
        XCTAssertEqual(message(["ok": "true", "km": "1001"]), "Km: confira limites e casas decimais.")
        XCTAssertEqual(message(["ok": "true", "km": "1,5"]), "Km: confira limites e casas decimais.")
        XCTAssertEqual(message(["ok": "true", "km": "1.000,00"]), "Km: número inválido.")
        XCTAssertEqual(message(["ok": "true", "valor": "1,234"]), "Valor: confira limites e casas decimais.")
        XCTAssertEqual(message(["ok": "true", "dia": "2025-12-31"]), "Dia: data inválida.")
        XCTAssertEqual(message(["ok": "true", "dia": "2026-02-30"]), "Dia: data inválida.")
        XCTAssertEqual(message(["ok": "true", "cor": "verde"]), "Cor: escolha uma opção válida.")
        XCTAssertEqual(message(["ok": "true", "obs": "123456"]), "Observação: texto fora do limite.")
        guard case .success(let values) = WorkFields.parse(fields, draft: ["ok": "false", "km": "120", "valor": "12,5", "dia": "2026-03-01", "cor": "az", "senha": "1", "obs": ""]) else {
            return XCTFail("rascunho válido")
        }
        XCTAssertEqual(values, ["ok": .bool(false), "km": .number(120), "valor": .number(12.5), "dia": .string("2026-03-01"), "cor": .string("az"), "obs": .null])
        XCTAssertNil(values["senha"], "campo restrito nunca vai no corpo")
    }

    func testRequiredAtOpeningAndAskedNext() {
        let type = WorkTypeView(id: "oficina", fields: [WorkField(id: "a", label: "A", required: true), WorkField(id: "b", label: "B"), WorkField(id: "c", label: "C"),
                                                         WorkField(id: "s", label: "S", required: true, sensitive: true)],
                                initialStage: "recebido",
                                stageFieldRules: [StageFieldRule(fieldId: "b", requiredFromStage: "recebido"), StageFieldRule(fieldId: "c", requiredFromStage: "pronto"),
                                                  StageFieldRule(fieldId: "a", requiredOnExit: ["execucao"])])
        XCTAssertEqual(WorkFields.requiredAtOpening(type), ["a", "b"])
        let order = WorkOrder(id: "o", stage: "execucao", nextStages: [WorkNextStage(transitionId: "t1", stage: "pronto", baseStatus: "ready"),
                                                                      WorkNextStage(transitionId: "t2", stage: "cancelada", baseStatus: "cancelled")])
        XCTAssertEqual(WorkFields.askedNext(type, order: order), ["c", "a"])
        XCTAssertEqual(WorkFields.askedNext(nil, order: order), [])
        XCTAssertEqual(WorkFields.display(fields[3], .string("az")), "Azul")
        XCTAssertEqual(WorkFields.display(fields[2], .string("2026-03-01")), "01/03/2026")
        XCTAssertEqual(WorkFields.display(fields[1], .number(12.5)), "12,5")
        XCTAssertEqual(WorkFields.display(fields[4], .bool(true)), "Sim")
        XCTAssertEqual(WorkFields.display(fields[5], .string("1234")), "—")
        XCTAssertEqual(WorkFields.merged(current: ["km": .number(5), "senha": .string("x")], fields: fields, edited: ["cor": .string("az")]), ["km": .number(5), "cor": .string("az")])
    }

    func testOpeningBodyLikeAndroid() {
        let withObject = WorkOrderDraft(typeId: "oficina", item: "Revisão", problem: "Barulho", extra: [:], notes: nil, contactId: "ct-1",
                                        object: .existing(id: "obj-1", version: 2), customerName: "Ana", phone: "20900001111", conversationId: nil).body.compactMapValues { $0 }
        XCTAssertEqual(Set(withObject.keys), ["type_id", "item", "problem", "contact_id", "object"])
        XCTAssertEqual((withObject["object"] as? [String: Any])?["mode"] as? String, "existing")
        let counter = WorkOrderDraft(typeId: "celulares", item: "Celular", problem: "Não liga", extra: ["backup": .bool(true)], notes: "x", contactId: nil,
                                     object: nil, customerName: "Rita", phone: "20900001111", conversationId: nil).body.compactMapValues { $0 }
        XCTAssertEqual(Set(counter.keys), ["type_id", "item", "problem", "extra", "notes", "customer_name", "phone"])
        let chat = WorkOrderDraft(typeId: "celulares", item: "Celular", problem: "Não liga", extra: [:], notes: nil, contactId: nil,
                                  object: nil, customerName: "Rita", phone: nil, conversationId: "c1").body.compactMapValues { $0 }
        XCTAssertEqual(Set(chat.keys), ["type_id", "item", "problem", "conversation_id"], "pela conversa, o servidor usa o cliente da conversa")
        let new = WorkObjectChoice.new(typeId: "veiculo", values: ["placa": .string("ABC1D23")]).json
        XCTAssertEqual(new["mode"] as? String, "new")
        XCTAssertEqual((new["values"] as? [String: Any])?["placa"] as? String, "ABC1D23")
    }

    func testCacheKeepsPerAreaAndClears() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wo-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = PrivateFileStore(directory: dir)
        let cache = WorkOrderCache(store: store, profileId: "p1")
        for i in 0..<(WorkOrderCache.maxLists + 1) { cache.saveList(key: "k\(i)", orders: [WorkOrder(id: "o\(i)")], nextCursor: nil) }
        XCTAssertNil(cache.list(key: "k0"), "só as últimas listas ficam")
        XCTAssertEqual(cache.list(key: "k\(WorkOrderCache.maxLists)")?.orders.map(\.id), ["o\(WorkOrderCache.maxLists)"])
        XCTAssertNil(WorkOrderCache(store: store, profileId: "p2").list(key: "k1"), "cada área tem a sua cópia")
        cache.saveDetail(order: WorkOrder(id: "o1", typeId: "oficina", extra: ["km": .number(1)]), history: [WorkHistoryEntry(id: "h1", kind: "opened")], catalog: nil)
        XCTAssertEqual(cache.detail("o1")?.order.extra?["km"], .number(1))
        XCTAssertEqual(cache.detail("o1")?.history.first?.id, "h1")
        cache.clear()
        XCTAssertNil(cache.detail("o1"))
    }
}

/// O fluxo da ordem por modelo contra a demonstração (o mesmo `DemoURLProtocol` do app).
final class WorkOrderDemoTests: XCTestCase {
    private let base = DemoMode.serverURL.absoluteString

    override func setUp() {
        super.setUp()
        DemoServer.reset()
    }

    private var client: WorkOrderClient {
        WorkOrderClient(api: ProfileAPI(baseURL: base, profileId: DemoMode.profileId, session: QueueHTTP.makeSession()) { "wabu_demo" })
    }

    private func refused(_ block: () async throws -> Void) async -> String? {
        do { try await block(); XCTFail("o servidor devia recusar"); return nil } catch { return (error as? QueueError)?.code }
    }

    func testCatalogAndList() async throws {
        let c = client
        let catalog = try await c.types()
        XCTAssertEqual(catalog.data?.map(\.id), ["service_order", "oficina", "celulares"])
        XCTAssertEqual(catalog.activeCustom.count, 2)
        XCTAssertEqual(catalog.type("oficina")?.objectTypeId, "veiculo")
        let all = try await c.list(WorkOrderRules.listQuery(catalog: catalog, typeId: nil, situation: .all, stage: nil, query: ""))
        XCTAssertTrue(all.data?.contains { $0.isLegacy } ?? false, "as ordens simples continuam na lista")
        XCTAssertTrue(all.data?.contains { $0.typeId == "oficina" } ?? false)
        let ready = try await c.list(WorkOrderRules.listQuery(catalog: catalog, typeId: "oficina", situation: .open, stage: "pronto", query: ""))
        XCTAssertEqual(ready.data?.map(\.numberText), ["OF-4"])
        let plate = try await c.list(WorkOrderRules.listQuery(catalog: catalog, typeId: "oficina", situation: .open, stage: nil, query: "abc1d23"))
        XCTAssertEqual(plate.data?.map(\.numberText), ["OF-1"])
        let phone = try await c.order("wo-cel-1")
        XCTAssertFalse(phone.fields?.contains { $0.isSensitive } ?? true)
        XCTAssertNil(phone.extra?["senha_desbloqueio"])
    }

    func testChecklistPhotoBeforeMovingOn() async throws {
        let c = client
        var order = try await c.order("wo-of-1")
        XCTAssertEqual(order.object?.identifier, "ABC1D23")
        let forward = try XCTUnwrap(order.nextStages?.first { $0.stage == "diagnostico" })
        let version = order.version ?? 0
        let blocked = await refused { _ = try await c.changeStage("wo-of-1", transitionId: forward.transitionId, version: version, note: nil, key: "s1") }
        XCTAssertEqual(blocked, "checklist_required")
        order = try await c.markChecklist(order.id, version: order.version ?? 0, itemId: "objetos", done: true, key: "c1")
        let current = order.version ?? 0
        let noPhoto = await refused { _ = try await c.markChecklist("wo-of-1", version: current, itemId: "foto_painel", done: true, key: "c2") }
        XCTAssertEqual(noPhoto, "photo_required")
        let jpeg = Data((0..<2048).map { UInt8($0 % 251) })
        order = try await c.markWithPhoto(order.id, itemId: "foto_painel", jpeg: jpeg)
        let item = try XCTUnwrap(order.checklist?.first { $0.current == true }?.items?.first { $0.id == "foto_painel" })
        XCTAssertEqual(item.done, true)
        let doc = try XCTUnwrap(item.photoDocumentId)
        let bytes = try await c.documentContent(orderId: order.id, documentId: doc)
        XCTAssertEqual(bytes, jpeg)
        order = try await c.changeStage(order.id, transitionId: forward.transitionId, version: order.version ?? 0, note: nil, key: "s2")
        XCTAssertEqual(order.stage, "diagnostico")
        let history = try await c.history(order.id)
        XCTAssertTrue(history.data?.contains { $0.kind == "os.checklist_marked" && ($0.note ?? "").contains("com foto") } ?? false)
    }

    func testGoingBackAndCancellingAskForAReason() async throws {
        let c = client
        var order = try await c.order("wo-of-2")
        let back = try XCTUnwrap(order.nextStages?.first { $0.stage == "recebido" })
        let v1 = order.version ?? 0
        let noReason = await refused { _ = try await c.changeStage("wo-of-2", transitionId: back.transitionId, version: v1, note: nil, key: "b1") }
        XCTAssertEqual(noReason, "reason_required")
        order = try await c.changeStage(order.id, transitionId: back.transitionId, version: v1, note: "Cliente trouxe outra peça", key: "b2")
        XCTAssertEqual(order.stage, "recebido")
        let cancel = try XCTUnwrap(order.nextStages?.first { $0.baseStatus == "cancelled" })
        order = try await c.changeStage(order.id, transitionId: cancel.transitionId, version: order.version ?? 0, note: "Desistiu", key: "b3")
        XCTAssertTrue(order.isClosed)
        XCTAssertTrue(order.nextStages?.isEmpty ?? false)
        let v2 = order.version ?? 0
        let closed = await refused { _ = try await c.markChecklist("wo-of-2", version: v2, itemId: "objetos", done: true, key: "b4") }
        XCTAssertEqual(closed, "order_closed")
    }

    func testFieldAskedAtReadyStage() async throws {
        let c = client
        var order = try await c.order("wo-of-3")
        order = try await c.markChecklist(order.id, version: order.version ?? 0, itemId: "teste_rodagem", done: true, key: "f1")
        let ready = try XCTUnwrap(order.nextStages?.first { $0.stage == "pronto" })
        let type = try await c.type("oficina")
        XCTAssertEqual(WorkFields.askedNext(type, order: order), ["mecanico"])
        let v1 = order.version ?? 0
        let missing = await refused { _ = try await c.changeStage("wo-of-3", transitionId: ready.transitionId, version: v1, note: nil, key: "f2") }
        XCTAssertEqual(missing, "missing_fields")
        let requirements = try await c.requirements(order.id, transitionId: ready.transitionId)
        XCTAssertEqual(requirements.missing?.map(\.fieldId), ["mecanico"])
        let extra = WorkFields.merged(current: order.extra, fields: order.fields, edited: ["mecanico": .string("Carlos")])
        order = try await c.updateExtra(order.id, version: v1, extra: extra, key: "f3")
        XCTAssertEqual(order.extra?["mecanico"], .string("Carlos"))
        order = try await c.changeStage(order.id, transitionId: ready.transitionId, version: order.version ?? 0, note: nil, key: "f4")
        XCTAssertEqual(order.stage, "pronto")
        XCTAssertEqual(order.state, "ready")
    }

    func testOpenOrderWithObjectAndOwnFields() async throws {
        let c = client
        let found = try await c.contacts("Mariana Costa")
        let contact = try XCTUnwrap(found.first { $0.id == "ct_c_rich" })
        let objects = try await c.objects(contactId: contact.id, typeId: "veiculo").data ?? []
        XCTAssertEqual(objects.map(\.identifier), ["ABC1D23"])
        let noObject = await refused {
            _ = try await c.create(WorkOrderDraft(typeId: "oficina", item: "Revisão", problem: "Luz do óleo", extra: [:], contactId: contact.id), key: "n1")
        }
        XCTAssertEqual(noObject, "object_required")
        let created = try await c.create(WorkOrderDraft(typeId: "oficina", item: "Revisão", problem: "Luz do óleo", extra: ["km_entrada": .number(61_000)], contactId: contact.id,
                                                        object: .new(typeId: "veiculo", values: ["placa": .string("NOV0A01"), "modelo": .string("Carro Exemplo")])), key: "n2")
        XCTAssertEqual(created.numberText, "OF-6")
        XCTAssertEqual(created.stage, "recebido")
        XCTAssertEqual(created.object?.identifier, "NOV0A01")
        XCTAssertEqual(created.customerName, contact.displayName)
        let existing = try await c.create(WorkOrderDraft(typeId: "oficina", item: "Lavagem", problem: "Completa", extra: [:], contactId: contact.id,
                                                         object: .existing(id: objects[0].id, version: objects[0].version ?? 0)), key: "n3")
        XCTAssertEqual(existing.object?.identifier, "ABC1D23")
        let backup = await refused {
            _ = try await c.create(WorkOrderDraft(typeId: "celulares", item: "Celular", problem: "Não liga", extra: [:], customerName: "Rita", phone: "2090000111"), key: "n4")
        }
        XCTAssertEqual(backup, "missing_fields")
        let phone = try await c.create(WorkOrderDraft(typeId: "celulares", item: "Celular", problem: "Não liga", extra: ["backup": .bool(true)], customerName: "Rita", phone: "2090000111"), key: "n5")
        XCTAssertEqual(phone.numberText, "CEL-3")
    }

    func testSendQuoteThroughTheConversation() async throws {
        let c = client
        let order = try await c.order("wo-of-2")
        XCTAssertTrue(WorkOrderRules.canSendQuote(order))
        let sent = try await c.sendQuote(order.id, key: "q1")
        XCTAssertNotNil(sent.quote?.sentAt)
        XCTAssertFalse(WorkOrderRules.canSendQuote(sent))
        XCTAssertEqual(sent.quote.map(WorkOrderRules.quoteTotal), 34_500)
    }
}
