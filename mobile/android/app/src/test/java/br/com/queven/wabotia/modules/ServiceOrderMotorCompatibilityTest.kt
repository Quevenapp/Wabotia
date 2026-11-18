package br.com.queven.wabotia.modules

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.os.ServiceOrder
import br.com.queven.wabotia.modules.os.ServiceOrderClient
import br.com.queven.wabotia.modules.os.ServiceOrderRules
import br.com.queven.wabotia.printing.ServiceOrderReceiptData
import br.com.queven.wabotia.printing.ServiceOrderReceiptText
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test

/** Tarefa C: exemplos do CONTRATO-MOTOR §§2/5 e dos DTOs F0, ainda não capturas HTTP de M/O.
 * As mesmas fixtures ficam no iOS. O interceptor entrega bytes ao cliente real, sem abrir sockets.
 */
class ServiceOrderMotorCompatibilityTest {
    private fun fixture(name: String): String = checkNotNull(javaClass.getResourceAsStream("/work-orders/$name.json")) {
        "Fixture ausente: $name"
    }.bufferedReader(Charsets.UTF_8).use { it.readText() }

    private fun objectFixture(name: String): JsonObject = WabotiaJson.parseToJsonElement(fixture(name)).jsonObject

    private fun decode(raw: JsonElement): ServiceOrder = WabotiaJson.decodeFromJsonElement(ServiceOrder.serializer(), raw)

    private fun client(answer: (Request) -> String): ServiceOrderClient {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(answer(chain.request()).toResponseBody("application/json".toMediaType())).build()
        }.build()
        return ServiceOrderClient(ProfileApi("https://w.example", "p1", { "wabu_x" }, http))
    }

    private fun requestBody(request: Request): JsonObject {
        val buffer = Buffer()
        checkNotNull(request.body).writeTo(buffer)
        return WabotiaJson.parseToJsonElement(buffer.readUtf8()).jsonObject
    }

    @Test fun embutidoAmpliadoConservaEstadoOrcamentoEAcoes() = runTest {
        val order = client { fixture("motor-builtin-quoted") }.order("os_builtin")
        assertEquals("quoted", order.state)
        assertEquals("Orçamento enviado", order.label)
        assertEquals(120, order.number)
        assertEquals("nº 120", order.numberText)
        assertEquals("Celular", order.item)
        assertEquals("Tela trincada", order.problem)
        assertEquals(45000L, order.quote?.total)
        assertEquals(10000L, order.quote?.items?.last()?.totalCents)
        assertEquals("c1", order.customer?.conversationId)
        assertTrue(ServiceOrderRules.canEditQuote(order))
        assertEquals(listOf("Voltar para análise", "Enviar orçamento", "Cliente aprovou", "Cliente recusou", "Cancelar ordem"),
            ServiceOrderRules.actions(order).map { it.second })
        assertEquals("Orçamento enviado", ServiceOrderRules.historyText(order.history!!.single()))
    }

    @Test fun personalizadoIgnoraExtrasEMostraEstadoENumeroDeBase() = runTest {
        val raw = objectFixture("motor-custom-order")
        assertEquals("citacao", raw["stage"]?.jsonPrimitive?.content)
        assertEquals("PROC-12", raw["display_number"]?.jsonPrimitive?.content)
        assertEquals(JsonPrimitive(false), raw["extra"]?.jsonObject?.get("urgente"))
        assertEquals(JsonPrimitive(0), raw["extra"]?.jsonObject?.get("audiencias"))
        val order = client { raw.toString() }.order("os_custom")
        assertEquals("in_progress", order.state)
        assertEquals("Em execução", order.label)
        assertEquals("nº 121", order.numberText)
        assertEquals("Processo demonstrativo 2026/12", order.item)
        assertEquals("Revisão contratual", order.problem)
        assertFalse(ServiceOrderRules.canEditQuote(order))
        assertEquals(listOf("ready", "cancelled"), ServiceOrderRules.actions(order).map { it.first })
        assertEquals(listOf("Marcar como pronta", "Cancelar ordem"), ServiceOrderRules.actions(order).map { it.second })
        // A transição própria instruir (in_progress -> in_progress) não vira botão legado.
        assertFalse(order.nextStatuses.contains("instrucao"))
        assertEquals("Em execução", ServiceOrderRules.historyText(order.history!!.single()))
        val receipt = ServiceOrderReceiptData.of(order, "Área", now = 1794763800000)
        assertEquals("121", receipt.number)
        val fields = ServiceOrderReceiptText.fields(receipt).toMap()
        assertEquals(order.item, fields["Item"])
        assertEquals(order.problem, fields["Problema"])
        assertEquals("Em execução", fields["Estado"])
    }

    @Test fun listaMistaNaoDescartaLinhasEConservaContagemGlobalEsparsa() = runTest {
        val requests = mutableListOf<Request>()
        val c = client { requests += it; fixture("motor-mixed-page") }
        val page = c.list(open = true, query = "Processo")
        assertEquals(listOf("os_custom", "os_builtin"), page.data.map { it.id })
        assertEquals(listOf("Em execução", "Orçamento enviado"), page.data.map { it.label })
        assertEquals(mapOf("received" to 2, "quoted" to 1, "in_progress" to 3, "delivered" to 4, "cancelled" to 1), page.counts)
        assertFalse(page.counts.containsKey("inProgress"))
        assertEquals(0, page.count("ready"))
        assertEquals(6, ServiceOrderRules.openCount(page))
        assertEquals("120", page.nextCursor)
        c.list(cursor = page.nextCursor)
        assertEquals("120", requests.last().url.queryParameter("cursor"))
        assertEquals("Processo", requests.first().url.queryParameter("q"))
        // Totais são da área; não são recalculados pelas duas linhas nem pelas facetas.
        assertEquals(11, page.counts.values.sum())
    }

    @Test fun paginaVaziaAceitaCursorNuloEChavesAusentes() = runTest {
        val page = client { fixture("motor-empty-page") }.list()
        assertTrue(page.data.isEmpty())
        assertNull(page.nextCursor)
        assertTrue(page.counts.isEmpty())
        ServiceOrderRules.STATUSES.forEach { assertEquals(0, page.count(it)) }
        assertEquals(0, ServiceOrderRules.openCount(page))
    }

    @Test fun rotuloDeReservaEONumeroMaximoContinuamCompativeis() {
        val raw = objectFixture("motor-custom-order")
        val order = decode(JsonObject((raw - "status_label") + ("number" to JsonPrimitive(Int.MAX_VALUE))))
        assertEquals("Em execução", order.label)
        assertEquals("nº 2147483647", order.numberText)
        assertEquals("received", decode(JsonObject(raw - "status" - "status_label")).state)
    }

    @Test fun criacaoAntigaNaoEnviaTipoEAcaoManualUsaStatusDeBase() = runTest {
        val bodies = mutableListOf<JsonObject>()
        val paths = mutableListOf<String>()
        val c = client { paths += it.url.encodedPath; bodies += requestBody(it); fixture("motor-builtin-quoted") }
        c.create("Celular", "Tela trincada", "c1", null, null, null, null, null, "create-1")
        assertFalse(bodies[0].containsKey("type_id"))
        assertEquals(JsonPrimitive("Celular"), bodies[0]["item"])
        assertEquals(JsonPrimitive("Tela trincada"), bodies[0]["problem"])
        c.setStatus("os_custom", "ready", null, "status-1")
        assertEquals("/api/v1/profiles/p1/service-orders/os_custom/status", paths.last())
        assertEquals(JsonPrimitive("ready"), bodies.last()["status"])
        assertFalse(bodies.last().containsKey("transition_id"))
    }

    @Test fun decisaoEnviaApproveMasDecodificaApproved() = runTest {
        var sent: Request? = null
        val order = client { sent = it; fixture("motor-builtin-approved") }.decide("os_builtin", true, "decision-1")
        val request = checkNotNull(sent)
        assertEquals("/api/v1/profiles/p1/service-orders/os_builtin/decision", request.url.encodedPath)
        assertEquals("POST", request.method)
        assertEquals("decision-1", request.header("Idempotency-Key"))
        assertEquals(JsonPrimitive("approve"), requestBody(request)["decision"])
        assertEquals("approved", order.decision?.decision)
        assertEquals("approved", order.state)
        assertEquals("Aprovada", order.label)
    }

    @Test fun envioDeOrcamentoContinuaNaRotaEspecial() = runTest {
        var sent: Request? = null
        val order = client { sent = it; fixture("motor-builtin-quoted") }.sendQuote("os_builtin", false, "quote-1")
        val request = checkNotNull(sent)
        assertEquals("/api/v1/profiles/p1/service-orders/os_builtin/quote/send", request.url.encodedPath)
        assertEquals("POST", request.method)
        assertEquals(JsonPrimitive(false), requestBody(request)["notify"])
        assertEquals("quoted", order.state)
        assertEquals("Orçamento enviado", order.label)
    }

    // Testes desativados abaixo expressam o resultado desejado e falham no app atual se habilitados.
    // Os payloads que violam §§2/5 são contraprovas, não propostas de mudança do servidor.
    @Ignore("Contrato §2: number textual descarta silenciosamente a linha no Android; manter número global inteiro.")
    @Test fun numeroFormatadoNaoDeveriaSumirComALinha() = runTest {
        val invalid = JsonObject(objectFixture("motor-custom-order") + ("number" to JsonPrimitive("PROC-12")))
        val page = JsonObject(objectFixture("motor-mixed-page") + ("data" to JsonArray(listOf(invalid, objectFixture("motor-builtin-quoted")))))
        assertEquals(2, client { page.toString() }.list().data.size) // Hoje retorna só a embutida.
    }

    @Ignore("Contrato §2: cursor objeto é ignorado no Android e perde a próxima página; manter texto ou null.")
    @Test fun cursorObjetoNaoDeveriaPerderPaginacao() = runTest {
        val page = JsonObject(objectFixture("motor-mixed-page") + ("next_cursor" to JsonObject(mapOf("number" to JsonPrimitive(120)))))
        assertEquals("120", client { page.toString() }.list().nextCursor) // Hoje é null.
    }

    @Ignore("Contrato §2: counts por etapa não entra na soma de abertas; usar códigos de base.")
    @Test fun contagemPorEtapaNaoDeveriaZerarAbertas() = runTest {
        val page = JsonObject(objectFixture("motor-mixed-page") + ("counts" to JsonObject(mapOf("citacao" to JsonPrimitive(3)))))
        assertEquals(3, ServiceOrderRules.openCount(client { page.toString() }.list())) // Hoje é zero.
    }

    @Ignore("Contrato §2: status com ID de etapa não tem filtro legado; manter in_progress em status.")
    @Test fun etapaEmStatusDeveriaTerFiltro() {
        val order = decode(JsonObject(objectFixture("motor-custom-order") + ("status" to JsonPrimitive("citacao"))))
        assertTrue(ServiceOrderRules.FILTERS.any { it.first == order.state }) // Hoje não existe.
    }

    @Ignore("Contrato §2: etapa em next_statuses vira destino desconhecido; só enviar ações antigas não ambíguas.")
    @Test fun etapaEmNextStatusesDeveriaResolverAcaoDeBase() {
        val order = decode(JsonObject(objectFixture("motor-custom-order") + ("next_statuses" to JsonArray(listOf(JsonPrimitive("conclusao"))))))
        assertEquals("ready", ServiceOrderRules.actions(order).single().first) // Hoje é conclusao.
    }

    @Ignore("Divergência preexistente do contrato §2: comprovante compara approve, mas servidor retorna approved. Correção móvel separada.")
    @Test fun comprovanteDeApprovedDeveriaMostrarAprovado() {
        val receipt = ServiceOrderReceiptData.of(decode(objectFixture("motor-builtin-approved")), "Área", now = 1794763800000)
        assertTrue(ServiceOrderReceiptText.footer(receipt).contains("Orçamento aprovado")) // Hoje imprime recusado.
    }
}
