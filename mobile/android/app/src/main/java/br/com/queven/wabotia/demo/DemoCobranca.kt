package br.com.queven.wabotia.demo

import kotlinx.serialization.json.JsonObject

/**
 * Formulários (passo web) e cobranças (Pix e link) da demonstração, no mesmo desenho do iOS (`DemoServer.swift`,
 * "Formulário e Cobrança"): dois formulários ativos, o formulário da coleta já respondido e o Pix do frete aguardando na
 * conversa da Mariana. O envio, o "cliente" que abre e responde e o "Mercado Pago" que confirma ficam em [DemoServer]
 * (ações `form` e `charge`); aqui ficam os dados e o formato das linhas (src/web-steps.ts webStepView,
 * src/payments.ts paymentView).
 */
internal class DemoCobranca(private val t0: Long) {
    private val steps = HashMap<String, MutableList<Row>>()
    private val payments = HashMap<String, MutableList<Row>>()
    private var seq = 0

    val forms: List<JsonObject> = listOf(
        j(
            "id" to "coleta", "name" to "coleta", "title" to "Dados para a coleta",
            "fields" to listOf(
                j("id" to "endereco", "type" to "text", "label" to "Endereço da coleta", "required" to true),
                j("id" to "periodo", "type" to "choice", "label" to "Período", "required" to true),
            ),
        ),
        j(
            "id" to "satisfacao", "name" to "satisfacao", "title" to "Avaliação do atendimento",
            "fields" to listOf(
                j("id" to "nota", "type" to "choice", "label" to "Nota", "required" to true),
                j("id" to "comentario", "type" to "text", "label" to "Comentário", "required" to false),
            ),
        ),
    )

    init {
        // Na conversa da Mariana: o formulário da coleta já respondido e o Pix do frete aguardando.
        val m = t0 - 50 * 60_000
        steps[Ids.C_RICH] = mutableListOf(
            step("ws-coleta", Ids.C_RICH, forms[0], m).apply {
                assign("status", "completed")
                assign("opened_at", m + 120_000)
                assign("completed_at", m + 300_000)
                assign("answers", j("endereco" to "Rua Exemplo, 100 — Centro", "periodo" to "Manhã"))
            },
        )
        payments[Ids.C_RICH] = mutableListOf(payment("pay-frete", Ids.C_RICH, "pix", 1890, "Frete da troca", t0 - 20 * 60_000))
    }

    fun nextId(prefix: String) = "$prefix-${++seq}"

    fun form(id: String?): JsonObject? = forms.firstOrNull { it.str("id") == id }

    /** Do mais novo para o mais antigo, como o detalhe do servidor. */
    fun stepsOf(conversationId: String): List<JsonObject> = steps[conversationId].orEmpty().reversed().map { it.json() }

    fun paymentsOf(conversationId: String): List<JsonObject> = payments[conversationId].orEmpty().reversed().map { it.json() }

    fun addStep(conversationId: String, form: JsonObject, now: Long): Row = step(nextId("ws"), conversationId, form, now).also { steps.getOrPut(conversationId) { ArrayList() } += it }

    fun addPayment(conversationId: String, method: String, cents: Long, description: String, now: Long): Row =
        payment(nextId("pay"), conversationId, method, cents, description, now).also { payments.getOrPut(conversationId) { ArrayList() } += it }

    private fun step(id: String, conversationId: String, form: JsonObject, now: Long): Row = row(
        "id" to id, "conversation_id" to conversationId, "module_id" to "forms", "kind" to "form", "ref_id" to form.str("id"), "title" to form.str("title"),
        "status" to "sent", "trigger" to "agent", "actor" to Ids.ME, "expires_at" to now + 86_400_000, "opened_at" to null, "completed_at" to null,
        "ticket_id" to null, "contact_id" to null, "answers" to null, "delivery" to "link", "page" to "form",
        "fields" to (form["fields"] ?: emptyList<String>()), "created" to now, "updated" to now,
    )

    private fun payment(id: String, conversationId: String, method: String, cents: Long, description: String, now: Long): Row = row(
        "id" to id, "conversation_id" to conversationId, "provider" to "mercadopago", "method" to method, "module_id" to null, "ref_id" to null,
        "description" to description, "amount_cents" to cents, "currency" to "BRL", "status" to "created", "provider_status" to "pending",
        // Código e endereço fictícios: não pagam nada.
        "pix_code" to if (method == "pix") "00020126580014br.gov.bcb.pix0136demo-${id}5204000053039865802BR5925DEMONSTRACAO" else null,
        "url" to if (method == "link") "https://pagamento.example/demo/$id" else null,
        "trigger" to "agent", "actor" to Ids.ME, "expires_at" to now + 30 * 60_000, "paid_at" to null, "created" to now, "updated" to now,
    )
}
