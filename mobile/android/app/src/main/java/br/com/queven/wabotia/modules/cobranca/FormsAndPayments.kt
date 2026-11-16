package br.com.queven.wabotia.modules.cobranca

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.DataList
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/*
 * Formulários (módulo `forms`, passo web) e Cobrança (módulo `payments`, Pix e link) na conversa: docs/API.md "Passo web
 * e formulários" e "Cobrança", docs/COBRANCA.md. A equipe envia pela ação da conversa (`form` com `form_id`; `charge`
 * com `method`, `amount_cents` e `description`), com a conversa assumida ou como administrador. O detalhe da conversa
 * traz os últimos `web_steps` e `payments`; os eventos `web_step.*`, `form.*` e `payment.*` atualizam a tela. `paid` só
 * vem do provedor (webhook assinado): nada no app marca uma cobrança como paga. Mesmo desenho do iOS
 * (`Modules/Cobranca/FormsAndPayments.swift`).
 */

/** Campo do formulário (rótulo das respostas). */
@Serializable
data class WebStepField(val id: String? = null, val type: String? = null, val label: String? = null)

/** Um link de passo web enviado na conversa (`sent`, `opened`, `completed`, `expired`, `cancelled`). */
@Serializable
data class WebStep(
    val id: String,
    @SerialName("module_id") val moduleId: String? = null,
    val kind: String? = null,
    val title: String? = null,
    val status: String? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("opened_at") val openedAt: Long? = null,
    @SerialName("completed_at") val completedAt: Long? = null,
    /** Respostas do formulário (objeto `campo → valor`); no carrinho, o pedido validado. */
    val answers: JsonElement? = null,
    val fields: List<WebStepField> = emptyList(),
    /** `form` ou `cart`. */
    val page: String? = null,
    val created: Long? = null,
)

/** Uma cobrança da conversa (`created`, `paid`, `expired`, `cancelled`, `refunded`). */
@Serializable
data class ConversationPayment(
    val id: String,
    val method: String? = null,
    @SerialName("module_id") val moduleId: String? = null,
    val description: String? = null,
    @SerialName("amount_cents") val amountCents: Long? = null,
    val status: String? = null,
    @SerialName("pix_code") val pixCode: String? = null,
    val url: String? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("paid_at") val paidAt: Long? = null,
    val created: Long? = null,
)

/** `GET /forms`: os formulários ativos da área. */
@Serializable
data class FormSummary(val id: String, val name: String? = null, val title: String? = null, val fields: List<Field> = emptyList()) {
    @Serializable
    data class Field(val id: String? = null, val type: String? = null, val label: String? = null, val required: Boolean? = null)

    val displayName: String get() = listOf(title, name).firstOrNull { !it.isNullOrBlank() } ?: "Formulário"
}

/** O cliente das rotas de formulários e cobranças de uma área (a ação vai pela conversa, como no painel). */
class FormsPaymentsClient(val api: ProfileApi) {
    suspend fun forms(): List<FormSummary> = api.get("forms", DataList.serializer(FormSummary.serializer())).data

    /** Envia o formulário como link de uso único; responde o passo web criado. */
    suspend fun sendForm(conversationId: String, formId: String, key: String): WebStep =
        api.send("POST", "conversations/$conversationId/actions", jsonBody("action" to "form", "form_id" to formId), key, WebStep.serializer())

    /** Cobra pelo Pix (QR e copia e cola) ou pelo link de pagamento; responde a cobrança criada. */
    suspend fun charge(conversationId: String, method: String, amountCents: Long, description: String, key: String): ConversationPayment =
        api.send(
            "POST", "conversations/$conversationId/actions",
            jsonBody("action" to "charge", "method" to method, "amount_cents" to amountCents, "description" to description),
            key, ConversationPayment.serializer(),
        )
}

/** Textos e regras de links e cobranças, sem tela, para testar. */
object ConversationItemsRules {
    fun webStepLabel(status: String?): String = when (status) {
        "sent" -> "Enviado"
        "opened" -> "Aberto"
        "completed" -> "Concluído"
        "expired" -> "Expirado"
        "cancelled" -> "Cancelado"
        else -> status ?: "—"
    }

    fun paymentLabel(status: String?): String = when (status) {
        "created" -> "Aguardando pagamento"
        "paid" -> "Pago"
        "expired" -> "Vencida"
        "cancelled" -> "Cancelada"
        "refunded" -> "Estornada"
        else -> status ?: "—"
    }

    fun methodLabel(method: String?): String = if (method == "link") "Link de pagamento" else "Pix"

    /** Em andamento: link enviado ou aberto, cobrança aguardando. */
    fun isActive(step: WebStep): Boolean = step.status == "sent" || step.status == "opened"
    fun isActive(payment: ConversationPayment): Boolean = payment.status == "created"

    /** Título do link: o do passo, ou o tipo ("Formulário", "Check-in", "Carrinho do pedido"). */
    fun stepTitle(step: WebStep): String = step.title?.trim()?.takeIf { it.isNotEmpty() } ?: when (step.kind) {
        "form" -> "Formulário"
        "checkin" -> "Check-in"
        "cart" -> "Carrinho do pedido"
        else -> "Link"
    }

    /** Valor digitado em reais; `null` fora de R$ 0,01 a R$ 100.000,00 (o limite do servidor). */
    fun amount(text: String): Long? = Money.parse(text)?.takeIf { it in 1..10_000_000 }

    /** Descrição da cobrança: obrigatória, até 120 caracteres. */
    fun validDescription(text: String): Boolean = text.trim().let { it.isNotEmpty() && it.codePointCount(0, it.length) <= 120 }

    /**
     * As respostas do formulário em pares rótulo/valor, na ordem dos campos (o que não é campo conhecido vem depois);
     * listas viram "a, b", verdadeiro/falso viram "sim"/"não". O carrinho do pedido não é formulário: fica de fora.
     */
    fun answers(step: WebStep): List<Pair<String, String>> {
        if (step.page == "cart" || step.kind == "cart") return emptyList()
        val obj = step.answers as? JsonObject ?: return emptyList()
        val labels = step.fields.mapNotNull { f -> f.id?.let { it to (f.label?.takeIf(String::isNotBlank) ?: it) } }
        val known = labels.map { it.first }.toSet()
        val ordered = labels.mapNotNull { (id, label) -> obj[id]?.let { label to it } } + obj.filterKeys { it !in known }.map { it.key to it.value }
        return ordered.mapNotNull { (label, value) -> text(value)?.let { label to it } }
    }

    private fun text(value: JsonElement): String? = when (value) {
        is JsonNull -> null
        is JsonPrimitive -> value.booleanOrNull?.let { if (it) "sim" else "não" } ?: value.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        is JsonArray -> value.mapNotNull { text(it) }.joinToString(", ").takeIf { it.isNotEmpty() }
        is JsonObject -> value.toString()
    }

    /** Na faixa da conversa: o que está em andamento e o que mudou nas últimas 24 horas, até quatro (duas cobranças). */
    fun recent(steps: List<WebStep>, payments: List<ConversationPayment>, now: Long): Pair<List<WebStep>, List<ConversationPayment>> {
        val day = 86_400_000L
        val p = payments.filter { isActive(it) || now - maxOf(it.paidAt ?: 0, it.created ?: 0) < day }.take(2)
        val s = steps.filter { isActive(it) || now - maxOf(it.completedAt ?: 0, it.created ?: 0) < day }.take(4 - p.size)
        return s to p
    }

    /** Recusas da Cobrança e do formulário em texto para o atendente. */
    fun explain(error: Throwable): String {
        val e = error as? QueueException ?: return ModuleFailure.message(error)
        return when (e.code) {
            "payments_not_configured" -> "A Cobrança não está configurada nesta área: um administrador precisa ligar o Mercado Pago em Gestão → Cobrança."
            "window_closed" -> "A janela de 24 horas está fechada: o cliente precisa escrever antes de receber o link ou a cobrança."
            "form_disabled" -> e.message ?: "Este formulário está desativado."
            "origin_unknown" -> "O endereço público desta instalação ainda não é conhecido. Um administrador abre o painel pelo endereço usado pelos clientes e tenta de novo."
            "module_disabled" -> ModuleFailure.DISABLED_MESSAGE
            else -> ModuleFailure.actionMessage(e)
        }
    }
}

/** Os `web_steps` e `payments` do detalhe da conversa (crus no modelo da conversa), do mais novo para o mais antigo. */
object ConversationItems {
    fun steps(element: JsonElement?): List<WebStep> = list(element, WebStep.serializer())

    fun payments(element: JsonElement?): List<ConversationPayment> = list(element, ConversationPayment.serializer())

    private fun <T> list(element: JsonElement?, serializer: KSerializer<T>): List<T> =
        (element as? JsonArray)?.mapNotNull { runCatching { WabotiaJson.decodeFromJsonElement(serializer, it) }.getOrNull() }.orEmpty()
}
