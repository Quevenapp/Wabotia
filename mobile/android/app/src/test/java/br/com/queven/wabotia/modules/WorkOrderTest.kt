package br.com.queven.wabotia.modules

import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.os.ChecklistMarkRequest
import br.com.queven.wabotia.modules.os.CompleteDocumentRequest
import br.com.queven.wabotia.modules.os.CreateWorkOrderRequest
import br.com.queven.wabotia.modules.os.DocumentReserveRequest
import br.com.queven.wabotia.modules.os.MemoryWorkCacheStorage
import br.com.queven.wabotia.modules.os.NextStage
import br.com.queven.wabotia.modules.os.ObjectOpening
import br.com.queven.wabotia.modules.os.StageFieldRule
import br.com.queven.wabotia.modules.os.StageRequest
import br.com.queven.wabotia.modules.os.UpdateExtraRequest
import br.com.queven.wabotia.modules.os.WorkContact
import br.com.queven.wabotia.modules.os.WorkDecision
import br.com.queven.wabotia.modules.os.WorkField
import br.com.queven.wabotia.modules.os.WorkFieldOption
import br.com.queven.wabotia.modules.os.WorkFields
import br.com.queven.wabotia.modules.os.WorkHistory
import br.com.queven.wabotia.modules.os.WorkOrder
import br.com.queven.wabotia.modules.os.WorkOrderCache
import br.com.queven.wabotia.modules.os.WorkOrderClient
import br.com.queven.wabotia.modules.os.WorkOrderRules
import br.com.queven.wabotia.modules.os.WorkQuote
import br.com.queven.wabotia.modules.os.WorkStage
import br.com.queven.wabotia.modules.os.WorkType
import br.com.queven.wabotia.modules.os.ServiceOrderCustomer
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** A ordem de serviço por modelo: regras das telas, campos próprios, cache e o fluxo completo contra a demonstração. */
class WorkOrderTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val client = WorkOrderClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http))

    @Before fun fresh() {
        DemoServer.reset()
    }

    private fun next(stage: String, base: String, kind: String = "manual") = NextStage("t-$stage", stage, stage.replaceFirstChar { it.uppercase() }, base, kind)

    private suspend fun refused(block: suspend () -> Unit): QueueException {
        try {
            block()
        } catch (e: QueueException) {
            return e
        }
        fail("O servidor devia recusar.")
        throw AssertionError()
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Regras
    // ---------------------------------------------------------------------------------------------------------------

    @Test fun motivoParaCancelarEVoltarComoNoServidor() {
        assertTrue(WorkOrderRules.needsReason("in_progress", "cancelled"))
        assertTrue(WorkOrderRules.needsReason("ready", "in_progress"))
        assertTrue(WorkOrderRules.needsReason("analyzing", "received"))
        assertFalse(WorkOrderRules.needsReason("received", "analyzing"))
        assertFalse(WorkOrderRules.needsReason("cancelled", "cancelled"))
        // Aprovado e recusado têm a mesma posição: ir de um ao outro não é voltar.
        assertFalse(WorkOrderRules.needsReason("approved", "declined"))
        assertEquals("Motivo do cancelamento", WorkOrderRules.reasonTitle("received", "cancelled"))
        assertEquals("Motivo do retrabalho", WorkOrderRules.reasonTitle("ready", "in_progress"))
        assertEquals("Motivo para voltar à análise", WorkOrderRules.reasonTitle("in_progress", "analyzing"))
        assertEquals("Motivo para voltar a etapa", WorkOrderRules.reasonTitle("analyzing", "received"))
    }

    @Test fun botoesDeEtapaComCancelamentoPorUltimo() {
        val order = WorkOrder(
            "o", status = "ready",
            nextStages = listOf(next("cancelada", "cancelled"), next("execucao", "in_progress"), next("entregue", "delivered"), next("aprovacao", "approved", "customer_approval")),
        )
        assertEquals(
            listOf("Voltar para Execucao", "Avançar para Entregue", "Pedir aprovação do cliente: Aprovacao", "Cancelar: Cancelada"),
            WorkOrderRules.stageButtons(order).map { it.second },
        )
    }

    @Test fun consultaDaListaIgualAoPainel() {
        val catalog = listOf(WorkType(kind = "builtin", id = "service_order"), WorkType(id = "oficina"), WorkType(id = "velho", archived = true))
        val all = WorkOrderRules.listQuery(catalog, null, "open", null, "  placa  ")
        assertEquals("service_order,oficina", all["type_ids"])
        assertNull(all["type_id"])
        assertEquals("1", all["open"])
        assertEquals("placa", all["q"])
        val staged = WorkOrderRules.listQuery(catalog, "oficina", "open", "pronto", "")
        assertEquals("oficina", staged["type_id"])
        assertEquals("pronto", staged["stage"])
        assertNull(staged["open"])
        assertNull(staged["type_ids"])
        assertNull(staged["q"])
        assertEquals("delivered", WorkOrderRules.listQuery(catalog, "oficina", "delivered", null, "")["status"])
        assertNull(WorkOrderRules.listQuery(catalog, null, "all", null, "")["open"])
        assertEquals("oficina|stage:pronto|abc", WorkOrderRules.listKey("oficina", "open", "pronto", " ABC "))
        assertEquals("*|open|", WorkOrderRules.listKey(null, "open", "pronto", ""))
        assertTrue(WorkOrderRules.showTypeLabel(catalog))
    }

    @Test fun orcamentoSoLeituraEEnvioPeloWhatsApp() {
        val quote = WorkQuote(totalCents = 12_000, sentAt = 1_795_277_100_000L, validUntil = 1_795_881_900_000L)
        val withChat = WorkOrder("o", status = "analyzing", quote = WorkQuote(totalCents = 100), nextStatuses = listOf("quoted"), customer = ServiceOrderCustomer(conversationId = "c1"))
        assertTrue(WorkOrderRules.canSendQuote(withChat))
        assertFalse(WorkOrderRules.canSendQuote(withChat.copy(customer = ServiceOrderCustomer())))
        assertFalse(WorkOrderRules.canSendQuote(withChat.copy(nextStatuses = emptyList())))
        assertFalse(WorkOrderRules.canSendQuote(withChat.copy(status = "delivered")))
        assertEquals("Ainda não enviado", WorkOrderRules.quoteStatus(withChat))
        assertEquals("Enviado em 21/11/2026 13:05, válido até 28/11/2026", WorkOrderRules.quoteStatus(WorkOrder("o", quote = quote)))
        assertTrue(WorkOrderRules.quoteStatus(WorkOrder("o", quote = quote.copy(expired = true))).endsWith("· Vencido"))
        assertEquals("Aprovado em 21/11/2026 13:05", WorkOrderRules.quoteStatus(WorkOrder("o", quote = quote, decision = WorkDecision("approved", 1_795_277_100_000L))))
    }

    @Test fun historicoSemCodigoCru() {
        val stages = listOf(WorkStage("pronto", "Pronto", "ready"))
        assertEquals("Ordem aberta", WorkOrderRules.historyText(WorkHistory("1", kind = "opened")))
        assertEquals("Checklist (Recebido): Foto feito", WorkOrderRules.historyText(WorkHistory("2", kind = "os.checklist_marked", note = "Checklist (Recebido): Foto feito")))
        assertNull(WorkOrderRules.historyNote(WorkHistory("2", kind = "os.checklist_marked", note = "x")))
        assertEquals("Etapa: Pronto", WorkOrderRules.historyText(WorkHistory("3", kind = "os.stage_changed", toStage = "pronto"), stages))
        assertEquals("Motivo", WorkOrderRules.historyNote(WorkHistory("3", kind = "os.stage_changed", note = " Motivo ".trim())))
        assertEquals("Alteração", WorkOrderRules.historyText(WorkHistory("4", kind = "os.codigo_novo")))
        assertEquals("Dados alterados", WorkOrderRules.historyText(WorkHistory("5", kind = "os.updated")))
    }

    @Test fun envioDaFotoSoParaOMesmoServidor() {
        val root = "https://loja.example"
        assertEquals("https://loja.example/api/v1/profiles/p/service-orders/o/documents/d/content", WorkOrderRules.uploadTarget(root, "/api/v1/profiles/p/service-orders/o/documents/d/content"))
        assertEquals("https://loja.example/api/x", WorkOrderRules.uploadTarget(root, "https://LOJA.example/api/x"))
        assertNull(WorkOrderRules.uploadTarget(root, "https://outro.example/api/x"))
        assertNull(WorkOrderRules.uploadTarget(root, "http://loja.example/api/x"))
        assertNull(WorkOrderRules.uploadTarget(root, "https://loja.example:8443/api/x"))
        assertNull(WorkOrderRules.uploadTarget(root, "/files/x"))
        assertNull(WorkOrderRules.uploadTarget(root, "//outro.example/api/x"))
        assertNull(WorkOrderRules.uploadTarget(root, " "))
    }

    @Test fun tamanhoDaFotoMantemProporcao() {
        assertEquals(1600 to 1200, WorkOrderRules.scaledSize(4000, 3000))
        assertEquals(900 to 1600, WorkOrderRules.scaledSize(2700, 4800))
        assertEquals(800 to 600, WorkOrderRules.scaledSize(800, 600))
    }

    @Test fun mensagensDizemOQueFazer() {
        assertEquals(WorkOrderRules.PHOTO_TOO_BIG, WorkOrderRules.message(QueueException(413, "document_too_large", "Documento: document_too_large.")))
        assertEquals(WorkOrderRules.VERSION_CONFLICT, WorkOrderRules.message(QueueException(409, "version_conflict", "x")))
        assertEquals(WorkOrderRules.FORBIDDEN, WorkOrderRules.message(QueueException(403, "insufficient_scope", "x")))
        assertEquals(WorkOrderRules.OFFLINE_WRITE, WorkOrderRules.message(QueueException(0, QueueException.NETWORK, "x")))
        assertEquals(WorkOrderRules.OBJECT_CHANGED, WorkOrderRules.message(QueueException(409, "object_definition_conflict", "x")))
        assertTrue(WorkOrderRules.catalogMissing(QueueException(404, "not_found", "x")))
        assertFalse(WorkOrderRules.catalogMissing(QueueException(409, "module_disabled", "x")))
        assertTrue(WorkOrderRules.isOffline(QueueException(0, QueueException.NETWORK, "x")))
        assertFalse(WorkOrderRules.isOffline(QueueException(409, "version_conflict", "x")))
        assertEquals("Sem conexão. Você está vendo a cópia de 21/11 13:05. Para mudar a ordem, conecte-se.", WorkOrderRules.offlineBanner(1_795_277_100_000L))
    }

    @Test fun soContatosVivosDaEquipe() {
        assertTrue(WorkOrderRules.visibleContact(WorkContact("1", namespace = "team", identityState = "active")))
        assertTrue(WorkOrderRules.visibleContact(WorkContact("2")))
        assertFalse(WorkOrderRules.visibleContact(WorkContact("3", mergedInto = "1")))
        assertFalse(WorkOrderRules.visibleContact(WorkContact("4", namespace = "app:loja")))
        assertFalse(WorkOrderRules.visibleContact(WorkContact("5", identityState = "pending")))
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Campos próprios
    // ---------------------------------------------------------------------------------------------------------------

    private val fields = listOf(
        WorkField("km", "Km", kind = "integer", min = JsonPrimitive(0), max = JsonPrimitive(1000)),
        WorkField("valor", "Valor", kind = "decimal", scale = 2),
        WorkField("dia", "Dia", kind = "date", min = JsonPrimitive("2026-01-01")),
        WorkField("cor", "Cor", kind = "choice", options = listOf(WorkFieldOption("az", "Azul"))),
        WorkField("ok", "Conferido", kind = "boolean", required = true),
        WorkField("senha", "Senha", sensitive = true),
        WorkField("obs", "Observação", maxLength = 5),
    )

    @Test fun validacaoComoNoPainel() {
        fun msg(draft: Map<String, String>) = (WorkFields.parse(fields, draft) as WorkFields.Parsed.Invalid).message
        assertEquals("Conferido: preenchimento obrigatório.", msg(emptyMap()))
        assertEquals("Km: confira limites e casas decimais.", msg(mapOf("ok" to "true", "km" to "1001")))
        assertEquals("Km: confira limites e casas decimais.", msg(mapOf("ok" to "true", "km" to "1,5")))
        assertEquals("Km: número inválido.", msg(mapOf("ok" to "true", "km" to "1.000,00")))
        assertEquals("Valor: confira limites e casas decimais.", msg(mapOf("ok" to "true", "valor" to "1,234")))
        assertEquals("Dia: data inválida.", msg(mapOf("ok" to "true", "dia" to "2025-12-31")))
        assertEquals("Dia: data inválida.", msg(mapOf("ok" to "true", "dia" to "2026-02-30")))
        assertEquals("Cor: escolha uma opção válida.", msg(mapOf("ok" to "true", "cor" to "verde")))
        assertEquals("Observação: texto fora do limite.", msg(mapOf("ok" to "true", "obs" to "123456")))
        val ok = WorkFields.parse(fields, mapOf("ok" to "false", "km" to "120", "valor" to "12,5", "dia" to "2026-03-01", "cor" to "az", "senha" to "1234")) as WorkFields.Parsed.Ok
        assertEquals(JsonObject(mapOf("km" to JsonPrimitive(120L), "valor" to JsonPrimitive(12.5), "dia" to JsonPrimitive("2026-03-01"), "cor" to JsonPrimitive("az"), "ok" to JsonPrimitive(false))), ok.values)
        // Campo apagado que tinha valor vai como nulo explícito; sensível nunca entra.
        val cleared = WorkFields.parse(fields, mapOf("ok" to "true", "km" to ""), base = JsonObject(mapOf("km" to JsonPrimitive(5), "senha" to JsonPrimitive("x")))) as WorkFields.Parsed.Ok
        assertEquals(JsonNull, cleared.values["km"])
        assertFalse(cleared.values.containsKey("senha"))
    }

    @Test fun obrigatoriosNaAberturaEPedidosNaProximaEtapa() {
        val type = WorkType(
            id = "oficina", initialStage = "recebido",
            fields = listOf(WorkField("a", "A", required = true), WorkField("b", "B"), WorkField("c", "C"), WorkField("s", "S", required = true, sensitive = true)),
            stageFieldRules = listOf(StageFieldRule("b", "recebido"), StageFieldRule("c", "pronto"), StageFieldRule("a", requiredOnExit = listOf("execucao"))),
        )
        assertEquals(setOf("a", "b"), WorkFields.requiredAtOpening(type))
        val order = WorkOrder("o", stage = "execucao", nextStages = listOf(next("pronto", "ready"), next("cancelada", "cancelled")))
        assertEquals(setOf("c", "a"), WorkFields.neededNext(type, order))
        assertEquals(emptySet<String>(), WorkFields.neededNext(null, order))
        assertEquals("Azul", WorkFields.display(fields[3], JsonPrimitive("az")))
        assertEquals("01/03/2026", WorkFields.display(fields[2], JsonPrimitive("2026-03-01")))
        assertEquals("12,5", WorkFields.display(fields[1], JsonPrimitive(12.5)))
        assertEquals("Sim", WorkFields.display(fields[4], JsonPrimitive(true)))
        assertEquals("—", WorkFields.display(fields[5], JsonPrimitive("1234")))
        assertEquals(listOf("km", "valor", "dia", "cor", "ok", "obs"), WorkFields.lines(fields, JsonObject(emptyMap())).map { it.first.id })
    }

    @Test fun cacheGuardaPorAreaEApagaNoLogout() {
        val storage = MemoryWorkCacheStorage()
        val cache = WorkOrderCache(storage, maxLists = 2)
        cache.saveList("p1", "a", "{}", now = 1)
        cache.saveList("p1", "b", "{}", now = 2)
        cache.saveList("p1", "c", "{}", now = 3)
        assertNull(cache.list("p1", "a"))
        assertEquals(3L, cache.list("p1", "c")?.savedAt)
        assertNull(cache.list("p2", "c"))
        cache.saveOrder("p1", "o1", "{\"id\":\"o1\"}", "{\"data\":[]}", now = 4)
        cache.saveOrder("p1", "o1", "{\"id\":\"o1\",\"version\":2}", null, now = 5)
        assertEquals("{\"data\":[]}", cache.order("p1", "o1")?.history)
        cache.wipe()
        assertTrue(storage.files.isEmpty())
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Fluxo contra a demonstração
    // ---------------------------------------------------------------------------------------------------------------

    @Test fun demonstracaoTemModelosEAsOrdensSimples() = runTest {
        val catalog = client.types().data
        assertEquals(listOf("service_order", "oficina", "celulares"), catalog.map { it.id })
        assertTrue(catalog.first().isBuiltin)
        val oficina = catalog.first { it.id == "oficina" }
        assertEquals("veiculo", oficina.objectTypeId)
        assertEquals("pronto", oficina.stageFieldRules.single().requiredFromStage)
        assertTrue(catalog.first { it.id == "celulares" }.fields.any { it.sensitive })
        val all = WorkOrderClient.page(client.listRaw(WorkOrderRules.listQuery(catalog, null, "all", null, "")))
        assertTrue(all.data.any { it.isLegacy })
        assertTrue(all.data.any { it.typeId == "oficina" })
        val ready = WorkOrderClient.page(client.listRaw(WorkOrderRules.listQuery(catalog, "oficina", "open", "pronto", "")))
        assertEquals(listOf("OF-4"), ready.data.map { it.numberText })
        val byPlate = WorkOrderClient.page(client.listRaw(WorkOrderRules.listQuery(catalog, "oficina", "open", null, "abc1d23")))
        assertEquals(listOf("OF-1"), byPlate.data.map { it.numberText })
        // O campo restrito nunca chega à ficha.
        val phone = client.order("wo-cel-1")
        assertFalse(phone.fields.any { it.sensitive })
        assertFalse(phone.extra.containsKey("senha_desbloqueio"))
    }

    @Test fun checklistComFotoAntesDeAvancar() = runTest {
        var order = client.order("wo-of-1")
        assertEquals("recebido", order.stage)
        assertEquals("ABC1D23", order.serviceObject?.identifier)
        val forward = order.nextStages.first { it.stage == "diagnostico" }
        assertEquals("checklist_required", refused { client.moveStage(order.id, StageRequest(forward.transitionId, order.version), false, QueueClient.newKey()) }.code)
        order = client.markChecklist(order.id, ChecklistMarkRequest(order.version, "objetos", true), QueueClient.newKey())
        assertEquals("photo_required", refused { client.markChecklist(order.id, ChecklistMarkRequest(order.version, "foto_painel", true), QueueClient.newKey()) }.code)
        // Versão velha é recusada.
        assertEquals("version_conflict", refused { client.markChecklist(order.id, ChecklistMarkRequest(order.version - 1, "objetos", false), QueueClient.newKey()) }.code)

        val jpeg = ByteArray(2048) { (it % 251).toByte() }
        val reservation = client.reserveDocument(order.id, DocumentReserveRequest("painel.jpg", "image/jpeg", jpeg.size.toLong()), QueueClient.newKey())
        val uploaded = client.upload(reservation, jpeg, "image/jpeg")
        client.completeDocument(order.id, reservation.id, CompleteDocumentRequest(uploaded.version, uploaded.uploadAttempt), QueueClient.newKey())
        order = client.order(order.id)
        order = client.markChecklist(order.id, ChecklistMarkRequest(order.version, "foto_painel", true, reservation.id), QueueClient.newKey())
        val photoItem = order.checklist.first { it.current }.items.first { it.id == "foto_painel" }
        assertTrue(photoItem.done)
        assertEquals(reservation.id, photoItem.photoDocumentId)
        assertTrue(client.documentContent(order.id, reservation.id).contentEquals(jpeg))

        order = client.moveStage(order.id, StageRequest(forward.transitionId, order.version), false, QueueClient.newKey())
        assertEquals("diagnostico", order.stage)
        val history = WorkOrderClient.history(client.historyRaw(order.id)).data
        assertTrue(history.any { it.kind == "os.checklist_marked" && it.note?.contains("com foto") == true })
        assertTrue(history.any { it.toStage == "diagnostico" })
    }

    @Test fun voltarECancelarPedemMotivo() = runTest {
        var order = client.order("wo-of-2")
        val back = order.nextStages.first { it.stage == "recebido" }
        assertTrue(WorkOrderRules.needsReason(order.state, back.baseStatus))
        assertEquals("reason_required", refused { client.moveStage(order.id, StageRequest(back.transitionId, order.version), false, QueueClient.newKey()) }.code)
        order = client.moveStage(order.id, StageRequest(back.transitionId, order.version, "Cliente trouxe outra peça"), false, QueueClient.newKey())
        assertEquals("recebido", order.stage)
        assertEquals("Cliente trouxe outra peça", WorkOrderClient.history(client.historyRaw(order.id)).data.last().note)
        val cancel = order.nextStages.first { it.baseStatus == "cancelled" }
        assertEquals("reason_required", refused { client.moveStage(order.id, StageRequest(cancel.transitionId, order.version, "  "), false, QueueClient.newKey()) }.code)
        order = client.moveStage(order.id, StageRequest(cancel.transitionId, order.version, "Desistiu"), false, QueueClient.newKey())
        assertTrue(order.closed)
        assertTrue(order.nextStages.isEmpty())
        assertEquals("order_closed", refused { client.markChecklist(order.id, ChecklistMarkRequest(order.version, "objetos", true), QueueClient.newKey()) }.code)
    }

    @Test fun campoPedidoNaEtapaProntoECompletarDepois() = runTest {
        var order = client.order("wo-of-3")
        order = client.markChecklist(order.id, ChecklistMarkRequest(order.version, "teste_rodagem", true), QueueClient.newKey())
        val ready = order.nextStages.first { it.stage == "pronto" }
        val type = client.types().data.first { it.id == "oficina" }
        assertEquals(setOf("mecanico"), WorkFields.neededNext(type, order))
        assertEquals("missing_fields", refused { client.moveStage(order.id, StageRequest(ready.transitionId, order.version), false, QueueClient.newKey()) }.code)
        val requirements = client.requirements(order.id, ready.transitionId)
        assertEquals(listOf("mecanico"), requirements.missing.map { it.fieldId })
        val extra = (WorkFields.parse(order.fields, WorkFields.draftOf(order.fields, order.extra) + ("mecanico" to "Carlos"), setOf("mecanico"), order.extra) as WorkFields.Parsed.Ok).values
        order = client.updateExtra(order.id, UpdateExtraRequest(order.version, extra), QueueClient.newKey())
        assertEquals(JsonPrimitive("Carlos"), order.extra["mecanico"])
        order = client.moveStage(order.id, StageRequest(ready.transitionId, order.version), false, QueueClient.newKey())
        assertEquals("pronto", order.stage)
        assertEquals("ready", order.state)
    }

    @Test fun abrirOrdemComObjetoECamposProprios() = runTest {
        val contact = client.contacts("Mariana Costa").first { it.id == "ct-${Ids.C_RICH}" }
        val objects = client.objects(contact.id, "veiculo").data
        assertEquals(listOf("ABC1D23"), objects.map { it.identifier })
        assertEquals("object_required", refused {
            client.create(CreateWorkOrderRequest("oficina", "Revisão", "Luz do óleo acesa", contactId = contact.id), QueueClient.newKey())
        }.code)
        val created = client.create(
            CreateWorkOrderRequest(
                "oficina", "Revisão", "Luz do óleo acesa", extra = JsonObject(mapOf("km_entrada" to JsonPrimitive(61_000))),
                contactId = contact.id, serviceObject = ObjectOpening.new("veiculo", JsonObject(mapOf("placa" to JsonPrimitive("NOV0A01"), "modelo" to JsonPrimitive("Carro Exemplo")))),
            ),
            QueueClient.newKey(),
        )
        assertEquals("OF-6", created.numberText)
        assertEquals("recebido", created.stage)
        assertEquals("NOV0A01", created.serviceObject?.identifier)
        assertEquals(contact.displayName, created.customerName)
        assertEquals(2, client.objects(contact.id, "veiculo").data.size)
        val existing = client.create(
            CreateWorkOrderRequest("oficina", "Lavagem", "Completa", contactId = contact.id, serviceObject = ObjectOpening.existing(objects[0].id, objects[0].version)),
            QueueClient.newKey(),
        )
        assertEquals("ABC1D23", existing.serviceObject?.identifier)
        // Celulares: "Cliente fez backup" é obrigatório na abertura.
        assertEquals("missing_fields", refused {
            client.create(CreateWorkOrderRequest("celulares", "Celular", "Não liga", customerName = "Rita", phone = "20 90000-1111"), QueueClient.newKey())
        }.code)
        val phone = client.create(
            CreateWorkOrderRequest("celulares", "Celular", "Não liga", extra = JsonObject(mapOf("backup" to JsonPrimitive(true))), customerName = "Rita", phone = "2090000111"),
            QueueClient.newKey(),
        )
        assertEquals("CEL-3", phone.numberText)
        assertEquals("entrada", phone.stage)
    }

    @Test fun enviarOrcamentoPelaConversa() = runTest {
        val order = client.order("wo-of-2")
        assertTrue(WorkOrderRules.canSendQuote(order))
        val sent = client.sendQuote(order.id, QueueClient.newKey())
        assertTrue(sent.quote?.sentAt != null)
        assertFalse(WorkOrderRules.canSendQuote(sent))
        assertEquals(34_500L, sent.quote?.total)
    }
}
