package br.com.queven.wabotia.modules

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.printing.CouponData
import br.com.queven.wabotia.queue.ModuleCapabilities
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.QueueTicket
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A base das verticais: capacidades por módulo, estabelecimento, idempotência por intenção, horário, telefone e dinheiro. */
class ModuleCommonTest {
    @Test fun capacidadesDaAreaListamOsModulosLigados() {
        val json = WabotiaJson.parseToJsonElement(
            """{"capabilities_version":1,"profiles":[{"id":"p1","modules":[{"id":"queue"},{"id":"agenda"},{"id":"os"}]},
               {"id":"p2","modules":[{"id":"reserva"}]}]}""",
        )
        assertEquals(setOf("queue", "agenda", "os"), ModuleCapabilities.enabledModules(json, "p1"))
        assertEquals(setOf("reserva"), ModuleCapabilities.enabledModules(json, "p2"))
        val top = WabotiaJson.parseToJsonElement("""{"modules":[{"id":"fila"},{"id":"mensalidade","enabled":false}]}""")
        assertEquals(setOf("queue"), ModuleCapabilities.enabledModules(top, "p9"))
        assertNull(ModuleCapabilities.enabledModules(WabotiaJson.parseToJsonElement("""{"server":{}}"""), "p1"))
    }

    @Test fun estabelecimentoViraCabecalhoERodape() {
        val e = Establishment(
            name = "Assistência Exemplo", documentType = "cnpj", documentDisplay = "11.222.333/0001-81",
            address = "Rua das Flores, 120\nCentro", phone = "(20) 3333-4444", footer = "Garantia de 90 dias.\n\nVolte sempre",
        )
        assertEquals(listOf("CNPJ 11.222.333/0001-81", "Rua das Flores, 120", "Centro", "(20) 3333-4444"), e.headerLines)
        assertEquals(listOf("Garantia de 90 dias.", "Volte sempre"), e.footerLines)
        assertEquals(listOf("CPF ***.456.789-**"), Establishment(documentType = "cpf", documentDisplay = "123.456.789-09").headerLines)

        val ticket = QueueTicket(id = "t1", code = "N007", ahead = 1)
        val coupon = CouponData.of(ticket, "Totem", e)
        assertEquals("Assistência Exemplo", coupon.header)
        assertEquals(e.headerLines, coupon.headerLines)
        assertEquals("Totem", CouponData.of(ticket, "Totem", null).header)
        assertEquals("Totem", CouponData.of(ticket, "Totem", Establishment(name = " ")).header)
    }

    @Test fun cpfDoEstabelecimentoSaiMascaradoNoComprovante() {
        val cpf = Establishment(name = "Ana Manicure", document = "12345678909", documentType = "cpf", documentDisplay = "123.456.789-09", phone = "(20) 90000-1111")
        assertEquals(listOf("CPF ***.456.789-**", "(20) 90000-1111"), cpf.headerLines)
        assertTrue(cpf.headerLines.none { it.contains("123") || it.contains("09") })
        // Sem o tipo, 11 dígitos são CPF; o CNPJ continua inteiro.
        assertEquals(listOf("CPF ***.456.789-**"), Establishment(documentDisplay = "123.456.789-09").headerLines)
        assertEquals(listOf("CNPJ 11.222.333/0001-81"), Establishment(documentDisplay = "11.222.333/0001-81").headerLines)
        // Um CPF que não dá para mascarar não vai para o papel.
        assertEquals(emptyList<String>(), Establishment(documentType = "cpf", documentDisplay = "123.456").headerLines)
        // O cupom do totem e o comprovante da OS usam as mesmas linhas.
        val ticket = QueueTicket(id = "t1", code = "N007", ahead = 1)
        assertEquals(listOf("CPF ***.456.789-**", "(20) 90000-1111"), CouponData.of(ticket, "Totem", cpf).headerLines)
        assertEquals("***.456.789-**", Establishment.maskCpf("12345678909"))
        assertNull(Establishment.maskCpf("1234567890"))
    }

    @Test fun mesmaIntencaoRepeteAChaveSoDepoisDeQuedaDeRede() {
        val keys = IntentKeys()
        val first = keys.key("confirm:a1")
        keys.settle(QueueException(0, QueueException.NETWORK, "Sem conexão"))
        assertEquals(first, keys.key("confirm:a1"))
        keys.settle(QueueException(409, "invalid_transition", "Não"))
        assertNotEquals(first, keys.key("confirm:a1"))
        val other = keys.key("cancel:a1")
        keys.settle(null)
        assertNull(keys.pendingKey)
        assertNotEquals(other, keys.key("cancel:a1"))
    }

    @Test fun horarioDeBrasilia() {
        val ms = 1794763800000L // 2026-11-15 14:30 em Brasília
        assertEquals("2026-11-15", BrasiliaTime.day(ms))
        assertEquals("14:30", BrasiliaTime.clock(ms))
        assertEquals("2026-11-09", BrasiliaTime.weekStart("2026-11-15"))
        assertEquals("2026-11-16", BrasiliaTime.weekStart("2026-11-16"))
        assertEquals("2026-12-01", BrasiliaTime.addDays("2026-11-30", 1))
        val (from, to) = BrasiliaTime.range("2026-11-15", 7)!!
        assertEquals(7 * 86_400_000L, to - from)
        assertEquals("2026-11-15", BrasiliaTime.day(from))
        assertTrue(BrasiliaTime.title("2026-11-15", ms).startsWith("Hoje · Domingo, 15 de novembro"))
        assertEquals("2026-12", BrasiliaTime.addMonths("2026-11", 1))
        assertEquals("Novembro de 2026", BrasiliaTime.month("2026-11"))
    }

    @Test fun telefoneEDinheiro() {
        assertEquals("(20) 90654-3210", PhoneText.display("5520906543210"))
        assertEquals("(20) 3000-0000", PhoneText.display("552030000000"))
        assertEquals("+12025550123", PhoneText.display("12025550123"))
        assertEquals("R$ 1.234,56", Money.format(123456))
        assertEquals("R$ 0,05", Money.format(5))
        assertEquals("-R$ 10,00", Money.format(-1000))
        assertEquals(4590L, Money.parse("45,9"))
        assertEquals(123456L, Money.parse("R$ 1.234,56"))
        assertEquals(4500L, Money.parse("45"))
        assertNull(Money.parse("4,567"))
        assertNull(Money.parse("abc"))
    }

    @Test fun clienteDaAreaMandaChaveEOmiteNulos() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"id":"x"}"""))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"module_disabled","message":"Desligado"}}"""))
        server.start()
        val api = ProfileApi(server.url("/").toString(), "p1", { "wabu_x" })
        api.send("PATCH", "service-orders/o1", jsonBody("assignee" to JsonNull, "note" to null, "items" to listOf(mapOf("q" to 1))), "chave-1", AreaPerson.serializer())
        val sent = server.takeRequest()
        assertEquals("/api/v1/profiles/p1/service-orders/o1", sent.path)
        assertEquals("chave-1", sent.getHeader("Idempotency-Key"))
        assertEquals("""{"assignee":null,"items":[{"q":1}]}""", sent.body.readUtf8())
        val error = runCatching { api.raw("agenda", mapOf("from" to "1", "to" to null)) }.exceptionOrNull() as QueueException
        assertTrue(error.moduleDisabled)
        assertEquals("/api/v1/profiles/p1/agenda?from=1", server.takeRequest().path)
        server.shutdown()
    }
}
