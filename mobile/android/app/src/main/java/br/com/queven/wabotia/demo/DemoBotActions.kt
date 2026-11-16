package br.com.queven.wabotia.demo

import kotlinx.serialization.json.JsonObject

/**
 * Ações pelo bot na demonstração (contrato de feat/bot-acoes): na conversa interna com o bot de vendas, uma proposta
 * para mudar a OS nº 12, uma proposta sensível (estorno; o código de demonstração do autenticador é 123456), um pedido
 * de aprovação de desconto pendente e outro já decidido pela Ana. Escrever "muda…" ao bot gera outra proposta.
 */
internal class DemoBotActions(private val s: DemoState, created: Long) {
    private class P(
        val id: String, val chatId: String, val message: Row, val operation: String, val operationSummary: String, val module: String,
        val summary: String, val params: JsonObject, val sensitive: Boolean, val expiresAt: Long, val created: Long,
        var status: String = "pending", var result: String? = null, var error: String? = null, var decidedAt: Long? = null,
    )

    private class A(
        val id: String, val message: Row, val title: String, val fields: List<Pair<String, String>>, val hidden: Int, val summary: String,
        val maxCents: Long, val conversationId: String, val expiresAt: Long, val created: Long,
        var status: String = "pending", var value: Double? = null, var reason: String? = null, var decidedBy: String? = null, var decidedAt: Long? = null,
    )

    private val proposals = LinkedHashMap<String, P>()
    private val approvals = LinkedHashMap<String, A>()
    private var mfaUntil = 0L
    private val bot = "bot:${Ids.BOT_VENDAS}"
    private val chatId = Ids.CHAT_VENDAS

    init {
        // Criado na primeira abertura da conversa: os prazos de 10 minutos contam a partir daí.
        val now = created
        // Em ordem de hora: a conversa mostra as mensagens na ordem em que foram gravadas.
        approval(
            "apr-taxa-121", now - 30 * 60_000, "Dispensa da taxa de entrega no pedido nº 121 de Rafael Lima",
            listOf("Taxa de entrega" to "R$ 7,00", "Pedido do cliente" to "Entrega grátis"),
            hidden = 0, summary = "Atraso de 40 minutos na última entrega.", maxCents = 700,
        ).apply { status = "approved"; value = 7.0; decidedBy = s.userName(Ids.ANA); decidedAt = now - 25 * 60_000; reason = "Compensação pelo atraso" }
        s.addChatMessage(chatId, Ids.ME, "Muda a OS nº 12 para Pronta, por favor.", now - 8 * 60_000)
        propose(now - 8 * 60_000 + 5_000, "os.status", "Mudar o estado da ordem de serviço", "os", "Mudar a OS nº 12 para Pronta", j("ordem" to "OS nº 12", "status" to "ready"), sensitive = false)
        s.addChatMessage(chatId, Ids.ME, "Estorna o pagamento do pedido nº 126, o cliente desistiu.", now - 6 * 60_000)
        propose(now - 6 * 60_000 + 5_000, "pedido.refund", "Estornar o pagamento de um pedido", "pedido", "Estornar R$ 48,00 do pedido nº 126", j("pedido" to "nº 126", "valor" to "R$ 48,00"), sensitive = true)
        approval(
            DESCONTO_ID, now - 4 * 60_000, "Desconto de 10% no pedido nº 128 de Mariana Costa",
            listOf("Itens" to "2x X-Burger, 1x Batata média, 2x Refrigerante", "Total de tabela" to "R$ 62,00", "Pedido do cliente" to "10% de desconto", "Últimas compras" to "4 pedidos em 30 dias (R$ 231,00)"),
            hidden = 1, summary = "Cliente frequente; diz que o concorrente cobra menos.", maxCents = 620,
        )
        refresh(now)
    }

    /** O estado vem sempre atual na leitura: vence o que passou do prazo e regrava os payloads. */
    fun refresh(now: Long) {
        proposals.values.forEach { p -> if (p.status == "pending" && now >= p.expiresAt) p.status = "expired"; p.message.assign("payload", proposalPayload(p, withActions = true)) }
        approvals.values.forEach { a -> if (a.status == "pending" && now >= a.expiresAt) a.status = "expired"; a.message.assign("payload", j("approval" to approvalJson(a))) }
    }

    /** Mensagem da pessoa ao bot: "muda…"/"marca…" vira proposta; o resto segue a resposta comum da demonstração. */
    fun onUserMessage(text: String, now: Long): Boolean {
        val t = text.lowercase()
        if (listOf("muda", "mude", "marca", "marque", "altera").none { it in t }) return false
        propose(now + 1_500, "os.status", "Mudar o estado da ordem de serviço", "os", "Mudar a OS nº 12 para Pronta", j("ordem" to "OS nº 12", "status" to "ready"), sensitive = false)
        return true
    }

    /** `POST …/internal-chats/{id}/proposals/{proposta}/confirm|cancel`. */
    fun decideProposal(id: String, action: String, now: Long): Reply {
        refresh(now)
        val p = proposals[id] ?: return Reply.error(404, "not_found", "Proposta não encontrada.")
        when (p.status) {
            "expired" -> return Reply.error(409, "proposal_expired", "A proposta venceu.")
            "cancelled" -> return if (action == "cancel") Reply.json(proposalJson(p)) else Reply.error(409, "proposal_cancelled", "A proposta foi cancelada.")
            "done", "failed" -> return if (action == "confirm") Reply.json(proposalJson(p)) else Reply.error(409, "proposal_closed", "A proposta já foi confirmada.")
        }
        if (action == "confirm") {
            if (p.sensitive && now > mfaUntil) return Reply.error(403, "mfa_required", "Esta ação pede o código do autenticador.")
            p.status = "done"
            p.result = if (p.operation == "pedido.refund") "Estorno de R$ 48,00 pedido ao provedor de pagamento." else "OS nº 12 agora está Pronta; o cliente foi avisado."
        } else {
            p.status = "cancelled"
        }
        p.decidedAt = now
        val text = if (p.status == "done") "Feito: ${p.summary}" else "Cancelada: ${p.summary}"
        s.addChatMessage(chatId, bot, text, now + 1).apply {
            assign("kind", "result")
            assign("payload", proposalPayload(p, withActions = false))
        }
        refresh(now)
        return Reply.json(proposalJson(p))
    }

    /** `GET /approvals`, `GET /approvals/{id}`, `POST /approvals/{id}/decide`. */
    fun approvals(method: String, r: List<String>, body: JsonObject, now: Long): Reply {
        refresh(now)
        if (r.isEmpty()) return Reply.json(j("data" to approvals.values.filter { it.status == "pending" }.map(::approvalJson)))
        val a = approvals[r[0]] ?: return Reply.error(404, "not_found", "Pedido não encontrado.")
        if (r.size == 1) return Reply.json(approvalJson(a))
        if (r.getOrNull(1) != "decide" || method != "POST") return Reply.error(404, "not_found", "Rota não encontrada.")
        val decision = body.str("decision").orEmpty()
        if (a.status == "expired") return Reply.error(409, "approval_expired", "O prazo deste pedido venceu.")
        if (a.status != "pending") {
            val same = a.decidedBy == s.userName(Ids.ME) && a.status == statusOf(decision)
            return if (same) Reply.json(approvalJson(a)) else Reply.error(409, "approval_closed", "Outra pessoa decidiu primeiro.")
        }
        val value = body.str("value")?.toDoubleOrNull()
        if (value != null && (value < 0 || value * 100 > a.maxCents)) return Reply.error(400, "invalid_value", "Ajuste fora dos limites.")
        a.status = statusOf(decision) ?: return Reply.error(400, "invalid_decision", "Decisão inválida.")
        a.value = value
        a.reason = body.str("reason")
        a.decidedBy = s.userName(Ids.ME)
        a.decidedAt = now
        refresh(now)
        return Reply.json(approvalJson(a))
    }

    /** `POST /api/v1/account/mfa/challenge`: na demonstração, o código é 123456 e vale 10 minutos. */
    fun mfaChallenge(body: JsonObject, now: Long): Reply {
        val code = body.str("code") ?: body.str("recovery_code")
        if (code != DEMO_CODE) return Reply.error(400, "invalid_code", "Código não aceito. Na demonstração, use $DEMO_CODE.")
        mfaUntil = now + 10 * 60_000
        return Reply.json(j("aal" to 2, "expires_at" to mfaUntil))
    }

    private fun statusOf(decision: String) = when (decision) {
        "approve" -> "approved"
        "decline" -> "declined"
        "handoff" -> "handoff"
        else -> null
    }

    private fun propose(at: Long, operation: String, operationSummary: String, module: String, summary: String, params: JsonObject, sensitive: Boolean) {
        val message = s.addChatMessage(chatId, bot, "Proposta do bot: $summary\nOperação: $operationSummary\nConfirme no painel ou no app atualizado (vale 10 minutos).", at, status = "completed")
        message.assign("kind", "proposal")
        val p = P(s.nextId("prop"), chatId, message, operation, operationSummary, module, summary, params, sensitive, at + 10 * 60_000, at)
        proposals[p.id] = p
        message.assign("payload", proposalPayload(p, withActions = true))
    }

    private fun approval(id: String, at: Long, title: String, fields: List<Pair<String, String>>, hidden: Int, summary: String, maxCents: Long): A {
        val message = s.addChatMessage(chatId, bot, "Pedido de aprovação: $title\nDecida no painel ou no app atualizado.", at, status = "completed")
        message.assign("kind", "approval")
        val a = A(id, message, title, fields, hidden, summary, maxCents, Ids.C_RICH, at + 20 * 60_000, at)
        approvals[a.id] = a
        return a
    }

    private fun proposalJson(p: P) = j(
        "id" to p.id, "status" to p.status, "operation" to p.operation, "summary" to p.summary, "params" to p.params,
        "sensitive" to p.sensitive, "expires_at" to p.expiresAt, "decided_at" to p.decidedAt,
        "result" to p.result?.let { j("message" to it) }, "error" to p.error?.let { j("message" to it) },
        "bot_id" to Ids.BOT_VENDAS, "chat_id" to p.chatId, "created" to p.created,
    )

    private fun proposalPayload(p: P, withActions: Boolean) = j(
        "operation_summary" to p.operationSummary, "module" to p.module,
        "actions" to if (withActions && p.status == "pending") listOf("confirm", "cancel") else emptyList<String>(),
        "proposal" to proposalJson(p),
    )

    private fun approvalJson(a: A) = j(
        "id" to a.id, "module_id" to "pedido", "kind" to "desconto", "ref_id" to null, "conversation_id" to a.conversationId,
        "title" to a.title, "status" to a.status,
        "fields" to a.fields.mapIndexed { i, (label, value) -> j("key" to "f$i", "label" to label, "value" to value) },
        "hidden_fields" to a.hidden, "model_summary" to a.summary,
        "adjust" to j("label" to "Desconto concedido (R$)", "type" to "money", "min" to 0, "max" to a.maxCents / 100.0),
        "can_decide" to (a.status == "pending"),
        "value" to a.value, "reason" to a.reason, "decided_by" to a.decidedBy, "decided_at" to a.decidedAt,
        "expires_at" to a.expiresAt, "created" to a.created,
    )

    companion object {
        const val DEMO_CODE = "123456"

        /** O pedido de desconto pendente (atalho `--es demo approval`). */
        const val DESCONTO_ID = "apr-desconto-128"
    }
}
