package br.com.queven.wabotia.ui

import br.com.queven.wabotia.core.model.Approval
import br.com.queven.wabotia.core.model.ApprovalAdjust
import br.com.queven.wabotia.core.model.BotProposal
import br.com.queven.wabotia.core.model.InternalMessage
import br.com.queven.wabotia.core.model.StructuredMessage
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.demo.DemoBotActions
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.demo.j
import br.com.queven.wabotia.ui.team.BotActionError
import br.com.queven.wabotia.ui.team.BotActionTexts
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mensagens estruturadas da conversa interna com o bot (feat/bot-acoes 3bb3d68, docs/API.md). */
class BotActionsTest {
    private fun message(kind: String, payload: String?) =
        WabotiaJson.decodeFromString(
            InternalMessage.serializer(),
            """{"id":"m1","author":"bot:b1","text":"Texto de reserva","created":1,"kind":"$kind","payload":${payload ?: "null"}}""",
        )

    private val proposalJson = """{"operation_summary":"Mudar o estado da ordem de serviço","module":"os","actions":["confirm","cancel"],
        "proposal":{"id":"5f0c","status":"pending","operation":"os.status","summary":"Mudar a OS nº 12 para Pronta",
        "params":{"id":"o1","status":"ready"},"sensitive":false,"expires_at":1794840000000,"decided_at":null,"result":null,"error":null,
        "bot_id":"3a1e","chat_id":"c1","created":1794839400000}}"""

    private val approvalJson = """{"approval":{"id":"a1","module_id":"pedido","kind":"desconto","ref_id":"r","conversation_id":"c9",
        "title":"Desconto de 10% no pedido nº 128 de Mariana Costa","status":"pending",
        "fields":[{"key":"total","label":"Total de tabela","value":"R$ 62,00"},{"key":"n","label":"Pedidos","value":4}],
        "hidden_fields":1,"model_summary":"Cliente frequente.","adjust":{"label":"Desconto concedido (R$)","type":"money","min":0,"max":6.2},
        "can_decide":true,"value":null,"reason":null,"decided_by":null,"decided_at":null,"expires_at":1794841500000,"created":1794839700000}}"""

    @Test fun mensagensEstruturadasDoContrato() {
        val p = StructuredMessage.of(message("proposal", proposalJson)) as StructuredMessage.Proposal
        assertEquals("Mudar a OS nº 12 para Pronta", p.payload.proposal.summary)
        assertEquals(listOf("id" to "o1", "status" to "ready"), BotActionTexts.params(p.payload.proposal.params))
        assertTrue(StructuredMessage.of(message("result", proposalJson)) is StructuredMessage.Result)
        val a = (StructuredMessage.of(message("approval", approvalJson)) as StructuredMessage.ApprovalRequest).approval
        assertEquals(listOf("R$ 62,00", "4"), a.fields.map { it.text })
        assertEquals(1, a.hiddenFields)
        assertNull(a.decidedByName)
    }

    @Test fun tipoDesconhecidoOuPayloadRuimViraTexto() {
        assertEquals(StructuredMessage.Text, StructuredMessage.of(message("text", null)))
        assertEquals(StructuredMessage.Text, StructuredMessage.of(message("checklist", """{"x":1}""")))
        assertEquals(StructuredMessage.Text, StructuredMessage.of(message("proposal", """{"sem":"proposta"}""")))
        // Servidor antigo: sem `kind` nem `payload`.
        val old = WabotiaJson.decodeFromString(InternalMessage.serializer(), """{"id":"m","author":"u","text":"oi","created":1}""")
        assertEquals(StructuredMessage.Text, StructuredMessage.of(old))
    }

    @Test fun prazoEEstado() {
        val p = BotProposal(id = "p", expiresAt = 1_000_000)
        assertEquals("Vence em 7 min", BotActionTexts.countdown(1_000_000, 1_000_000 - 7 * 60_000 - 5_000))
        assertEquals("Vence em menos de 1 min", BotActionTexts.countdown(1_000_000, 999_000))
        assertNull(BotActionTexts.countdown(1_000_000, 1_000_000))
        assertEquals("pending", BotActionTexts.effectiveStatus(p, 999_999))
        assertEquals("expired", BotActionTexts.effectiveStatus(p, 1_000_000))
        assertEquals("Venceu", BotActionTexts.proposalStatus("expired"))
        assertEquals("Erro do módulo", BotActionTexts.outcome(p.copy(status = "failed", error = j("message" to "Erro do módulo"))))
        assertEquals("OS pronta", BotActionTexts.outcome(p.copy(status = "done", result = JsonPrimitive("OS pronta"))))
    }

    @Test fun quemDecidiu() {
        val a = Approval(id = "a", status = "approved", value = 6.2, reason = "frequente", decidedBy = j("id" to "u1", "name" to "Ana"))
        assertEquals("Aprovado por Ana · R$ 6,20 · frequente", BotActionTexts.decided(a, money = true))
        assertNull(BotActionTexts.decided(a.copy(decidedBy = null), money = true))
    }

    @Test fun ajusteDaAprovacao() {
        val money = ApprovalAdjust("Desconto (R$)", "money", 0.0, 6.2)
        assertEquals(null, BotActionTexts.parseAdjust("  ", money).getOrThrow())
        assertEquals(6.2, BotActionTexts.parseAdjust("6,20", money).getOrThrow()!!, 0.0001)
        assertEquals(5.0, BotActionTexts.parseAdjust("R$ 5", money).getOrThrow()!!, 0.0001)
        assertTrue(BotActionTexts.parseAdjust("7", money).exceptionOrNull()!!.message!!.contains("R$ 6,20"))
        assertTrue(BotActionTexts.parseAdjust("abc", money).isFailure)
        assertEquals(10.5, BotActionTexts.parseAdjust("10,5", ApprovalAdjust("%", "number", 0.0, 20.0)).getOrThrow()!!, 0.0001)
    }

    @Test fun segundoFatorEErros() {
        assertEquals("""{"code":"123456"}""", br.com.queven.wabotia.core.MfaState.body(" 123456 ").toString())
        assertEquals("""{"recovery_code":"abcd-efgh"}""", br.com.queven.wabotia.core.MfaState.body("abcd-efgh").toString())
        assertEquals(BotActionError.MFA, BotActionError.of(ApiException(403, "mfa_required", "x")))
        assertEquals(BotActionError.PROPOSAL_EXPIRED, BotActionError.of(ApiException(409, "proposal_expired", "x")))
        assertEquals(BotActionError.PROPOSAL_DECIDED, BotActionError.of(ApiException(409, "proposal_closed", "x")))
        assertEquals(BotActionError.APPROVAL_CLOSED, BotActionError.of(ApiException(409, "approval_closed", "x")))
        assertEquals(BotActionError.GONE, BotActionError.of(ApiException(404, "not_found", "x")))
        assertEquals(BotActionError.FORBIDDEN, BotActionError.of(ApiException(403, "approval_forbidden", "x")))
        assertEquals(BotActionError.OTHER, BotActionError.of(IllegalStateException()))
    }

    // --- demonstração --------------------------------------------------------------------------------------------

    private fun body(reply: br.com.queven.wabotia.demo.Reply) = WabotiaJson.parseToJsonElement(String(reply.body)) as JsonObject

    @Test fun demonstracaoConfirmaComSegundoFatorEAprovaUmaVez() {
        DemoServer.reset()
        DemoServer.withState { s ->
            val now = System.currentTimeMillis()
            val account = br.com.queven.wabotia.demo.DemoAccount()
            val demo = DemoBotActions(s, now, account)
            val messages = s.chatMessages[Ids.CHAT_VENDAS]!!
            val kinds = messages.mapNotNull { (it["kind"] as? JsonPrimitive)?.content }
            assertTrue(kinds.containsAll(listOf("proposal", "approval")))
            val proposals = messages.filter { (it["kind"] as? JsonPrimitive)?.content == "proposal" }
                .map { WabotiaJson.decodeFromJsonElement(br.com.queven.wabotia.core.model.ProposalPayload.serializer(), it["payload"]!!).proposal }
            val sensitive = proposals.first { it.sensitive }
            val normal = proposals.first { !it.sensitive }

            assertEquals(403, demo.decideProposal(sensitive.id, "confirm", now).code)
            // Sem fator, não há desafio: a pessoa cadastra (código 123456) e a sessão sobe para aal2.
            assertEquals(400, account.challenge(j("code" to "123456"), now).code)
            account.route("POST", listOf("mfa", "enroll"), j("password" to "x"), now)
            assertEquals(401, account.route("POST", listOf("mfa", "verify"), j("factor_id" to "fct-demo", "code" to "000000"), now).code)
            assertEquals(200, account.route("POST", listOf("mfa", "verify"), j("factor_id" to "fct-demo", "code" to DemoBotActions.DEMO_CODE), now).code)
            assertEquals("done", (body(demo.decideProposal(sensitive.id, "confirm", now))["status"] as JsonPrimitive).content)
            // Confirmar de novo devolve o mesmo resultado; cancelar a confirmada é recusado.
            assertEquals(200, demo.decideProposal(sensitive.id, "confirm", now).code)
            assertEquals(409, demo.decideProposal(sensitive.id, "cancel", now).code)
            assertTrue(s.chatMessages[Ids.CHAT_VENDAS]!!.any { (it["kind"] as? JsonPrimitive)?.content == "result" })

            // Depois de 10 minutos, a proposta normal venceu.
            assertEquals(409, demo.decideProposal(normal.id, "confirm", now + 11 * 60_000).code)

            val decided = body(demo.approvals("POST", listOf(DemoBotActions.DESCONTO_ID, "decide"), j("decision" to "approve", "value" to 5.5), now))
            assertEquals("approved", (decided["status"] as JsonPrimitive).content)
            assertEquals(200, demo.approvals("POST", listOf(DemoBotActions.DESCONTO_ID, "decide"), j("decision" to "approve"), now).code)
            assertEquals(409, demo.approvals("POST", listOf(DemoBotActions.DESCONTO_ID, "decide"), j("decision" to "decline"), now).code)
            // O outro pedido já foi decidido pela Ana: o primeiro a decidir vence.
            assertEquals(409, demo.approvals("POST", listOf("apr-taxa-121", "decide"), j("decision" to "approve"), now).code)
        }
    }
}
