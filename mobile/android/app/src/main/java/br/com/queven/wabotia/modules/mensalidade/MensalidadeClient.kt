package br.com.queven.wabotia.modules.mensalidade

import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.DataList
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Mensalidade (módulo `mensalidade`, docs/MENSALIDADE.md e docs/API.md "Mensalidade"). Valores em centavos,
 * vencimentos "AAAA-MM-DD" em Brasília (mostrar sem converter), competência "AAAA-MM". Cada assinatura pertence a um
 * pagador (CPF ou CNPJ e vários telefones autorizados): a tela mostra o pagador e os telefones dele, sem supor um
 * telefone por assinatura. Planos, pagadores e importação ficam no painel web; o app acompanha o mês e opera as
 * parcelas e as assinaturas. Mesmo desenho do iOS (`Modules/Mensalidade`).
 */

@Serializable
data class MensalidadeCustomer(
    val name: String? = null,
    val phone: String? = null,
    @SerialName("contact_id") val contactId: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: PhoneText.display(phone) ?: "Cliente"
}

/** O pagador resumido na assinatura. */
@Serializable
data class PayerRef(
    val id: String,
    val name: String? = null,
    @SerialName("document_display") val documentDisplay: String? = null,
)

@Serializable
data class PayerPhone(val phone: String, val label: String? = null, val created: Long? = null)

/** `em_dia`, `em_atraso` ou `sem_assinatura`; a carência conta dias depois do vencimento. */
@Serializable
data class PayerSituation(
    val status: String? = null,
    @SerialName("open_installment") val openInstallment: Installment? = null,
    @SerialName("grace_days") val graceDays: Int? = null,
)

/** `GET /mensalidade/payers/{id}`: documento, telefones autorizados, assinaturas e situação. */
@Serializable
data class Payer(
    val id: String,
    val name: String? = null,
    val document: String? = null,
    @SerialName("document_type") val documentType: String? = null,
    @SerialName("document_display") val documentDisplay: String? = null,
    val email: String? = null,
    val notes: String? = null,
    val phones: List<PayerPhone> = emptyList(),
    val subscriptions: List<Subscription>? = null,
    val situation: PayerSituation? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Pagador"

    /** "CPF 123…" / "CNPJ …"; `null` sem documento. */
    val documentText: String?
        get() = documentDisplay?.takeIf { it.isNotBlank() }?.let { (if (documentType == "cpf") "CPF " else if (documentType == "cnpj") "CNPJ " else "") + it }
}

@Serializable
data class MensalidadePayment(
    val id: String? = null,
    val status: String? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("pix_code") val pixCode: String? = null,
    val url: String? = null,
    @SerialName("charged_at") val chargedAt: Long? = null,
)

@Serializable
data class MensalidadeNotices(
    @SerialName("before_at") val beforeAt: Long? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    val overdue: Int? = null,
    @SerialName("overdue_at") val overdueAt: Long? = null,
    val error: String? = null,
)

@Serializable
data class Installment(
    val id: String,
    @SerialName("subscription_id") val subscriptionId: String? = null,
    @SerialName("period_key") val periodKey: String? = null,
    @SerialName("period_label") val periodLabel: String? = null,
    @SerialName("due_date") val dueDate: String? = null,
    val upfront: Boolean? = null,
    @SerialName("amount_cents") val amountCents: Long? = null,
    /** `open`, `paid`, `overdue`, `cancelled` ou `waived`. */
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    val customer: MensalidadeCustomer? = null,
    @SerialName("plan_name") val planName: String? = null,
    val payment: MensalidadePayment? = null,
    val notices: MensalidadeNotices? = null,
    @SerialName("paid_at") val paidAt: Long? = null,
    @SerialName("paid_via") val paidVia: String? = null,
    @SerialName("paid_by") val paidBy: String? = null,
    @SerialName("paid_note") val paidNote: String? = null,
    @SerialName("waived_at") val waivedAt: Long? = null,
    @SerialName("waived_by") val waivedBy: String? = null,
    @SerialName("cancelled_at") val cancelledAt: Long? = null,
) {
    val state: String get() = status ?: "open"
    val label: String get() = statusLabel?.takeIf { it.isNotBlank() } ?: MensalidadeRules.statusLabel(state)
    val customerName: String get() = customer?.displayName ?: "Cliente"
}

@Serializable
data class Subscription(
    val id: String,
    @SerialName("plan_id") val planId: String? = null,
    @SerialName("plan_name") val planName: String? = null,
    val customer: MensalidadeCustomer? = null,
    val payer: PayerRef? = null,
    val period: String? = null,
    @SerialName("period_label") val periodLabel: String? = null,
    @SerialName("amount_cents") val amountCents: Long? = null,
    @SerialName("discount_cents") val discountCents: Long? = null,
    @SerialName("charge_cents") val chargeCents: Long? = null,
    @SerialName("due_day") val dueDay: Int? = null,
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("end_date") val endDate: String? = null,
    /** `active`, `paused` ou `ended`. */
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    val notes: String? = null,
    @SerialName("paused_at") val pausedAt: Long? = null,
    @SerialName("ended_at") val endedAt: Long? = null,
    @SerialName("open_count") val openCount: Int? = null,
    @SerialName("overdue_count") val overdueCount: Int? = null,
    @SerialName("overdue_cents") val overdueCents: Long? = null,
    val installments: List<Installment>? = null,
) {
    val state: String get() = status ?: "active"
    val label: String get() = statusLabel?.takeIf { it.isNotBlank() } ?: MensalidadeRules.subscriptionLabel(state)
    val customerName: String get() = customer?.displayName ?: "Cliente"
    val charge: Long? get() = chargeCents ?: amountCents?.let { it - (discountCents ?: 0) }
}

@Serializable
data class Delinquent(
    @SerialName("subscription_id") val subscriptionId: String,
    val customer: MensalidadeCustomer? = null,
    @SerialName("plan_name") val planName: String? = null,
    @SerialName("subscription_status") val subscriptionStatus: String? = null,
    @SerialName("overdue_count") val overdueCount: Int? = null,
    @SerialName("overdue_cents") val overdueCents: Long? = null,
    @SerialName("oldest_due_date") val oldestDueDate: String? = null,
    @SerialName("notices_sent") val noticesSent: Int? = null,
)

@Serializable
data class MensalidadeAmount(val count: Int? = null, val cents: Long? = null, val subscriptions: Int? = null)

@Serializable
data class MensalidadeSummary(
    val month: String? = null,
    @SerialName("expected_cents") val expectedCents: Long? = null,
    @SerialName("received_cents") val receivedCents: Long? = null,
    @SerialName("overdue_cents") val overdueCents: Long? = null,
    @SerialName("open_cents") val openCents: Long? = null,
    @SerialName("waived_cents") val waivedCents: Long? = null,
    val counts: Map<String, Int> = emptyMap(),
    @SerialName("received_in_month") val receivedInMonth: MensalidadeAmount? = null,
    @SerialName("overdue_total") val overdueTotal: MensalidadeAmount? = null,
    @SerialName("payments_ready") val paymentsReady: Boolean? = null,
)

/** Parcelas do mês: `counts` é do mês inteiro (sem o filtro de estado nem a busca), chave ausente vale 0. */
@Serializable
data class InstallmentPage(
    val month: String? = null,
    val data: List<Installment> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
    val counts: Map<String, Int> = emptyMap(),
)

@Serializable
data class SubscriptionPage(
    val data: List<Subscription> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
    val counts: Map<String, Int> = emptyMap(),
)

/** O cliente das rotas da Mensalidade de uma área. */
class MensalidadeClient(val api: ProfileApi) {
    suspend fun summary(month: String): MensalidadeSummary = api.get("mensalidade/summary", MensalidadeSummary.serializer(), mapOf("month" to month))

    suspend fun installments(month: String?, statuses: List<String> = emptyList(), query: String? = null, subscriptionId: String? = null, cursor: String? = null): InstallmentPage =
        api.get(
            "mensalidade/installments",
            InstallmentPage.serializer(),
            mapOf(
                "month" to month,
                "status" to statuses.takeIf { it.isNotEmpty() }?.joinToString(","),
                "q" to query?.trim()?.takeIf { it.isNotEmpty() },
                "subscription_id" to subscriptionId,
                "cursor" to cursor,
            ),
        )

    suspend fun installment(id: String): Installment = api.get("mensalidade/installments/$id", Installment.serializer())

    suspend fun subscriptions(statuses: List<String> = emptyList(), query: String? = null, cursor: String? = null): SubscriptionPage =
        api.get(
            "mensalidade/subscriptions",
            SubscriptionPage.serializer(),
            mapOf("status" to statuses.takeIf { it.isNotEmpty() }?.joinToString(","), "q" to query?.trim()?.takeIf { it.isNotEmpty() }, "cursor" to cursor, "limit" to "200"),
        )

    suspend fun subscription(id: String): Subscription = api.get("mensalidade/subscriptions/$id", Subscription.serializer())

    suspend fun payer(id: String): Payer = api.get("mensalidade/payers/$id", Payer.serializer())

    suspend fun delinquents(): List<Delinquent> = api.get("mensalidade/delinquents", DataList.serializer(Delinquent.serializer())).data

    /** Reenvia o Pix/link que vale ou cria outra cobrança. */
    suspend fun charge(id: String, key: String): Installment =
        api.send("POST", "mensalidade/installments/$id/charge", jsonBody(), key, Installment.serializer())

    /** Baixa manual (administrador): `paid_at` "AAAA-MM-DD"; `notify` manda o comprovante ao cliente. */
    suspend fun pay(id: String, note: String?, paidAt: String?, notify: Boolean, key: String): Installment =
        api.send("POST", "mensalidade/installments/$id/pay", jsonBody("note" to note, "paid_at" to paidAt, "notify" to notify), key, Installment.serializer())

    /** Isenta (administrador): bolsa, cortesia, acordo. */
    suspend fun waive(id: String, note: String?, key: String): Installment =
        api.send("POST", "mensalidade/installments/$id/waive", jsonBody("note" to note), key, Installment.serializer())

    /** `pause`, `resume` ou `end` (administrador). */
    suspend fun subscriptionAction(id: String, action: String, key: String): Subscription {
        require(action in MensalidadeRules.SUBSCRIPTION_ACTIONS)
        return api.send("POST", "mensalidade/subscriptions/$id/$action", jsonBody(), key, Subscription.serializer())
    }
}

/** Regras das telas da Mensalidade, sem tela, para testar. */
object MensalidadeRules {
    val PAYABLE = setOf("open", "overdue")
    val STATUSES = listOf("open", "overdue", "paid", "waived", "cancelled")
    val SUBSCRIPTION_ACTIONS = setOf("pause", "resume", "end")

    fun statusLabel(status: String): String = when (status) {
        "open" -> "Em aberto"
        "paid" -> "Paga"
        "overdue" -> "Vencida"
        "cancelled" -> "Cancelada"
        "waived" -> "Isenta"
        else -> status
    }

    fun subscriptionLabel(status: String): String = when (status) {
        "active" -> "Ativa"
        "paused" -> "Pausada"
        "ended" -> "Encerrada"
        else -> status
    }

    fun situationLabel(status: String?): String = when (status) {
        "em_dia" -> "Em dia"
        "em_atraso" -> "Em atraso"
        "sem_assinatura" -> "Sem assinatura"
        else -> status ?: "—"
    }

    fun paidVia(via: String?): String = when (via) {
        "pix" -> "Pix"
        "link" -> "Link de pagamento"
        "manual" -> "Baixa manual"
        null -> "—"
        else -> via
    }

    /** Reenviar a cobrança vale para qualquer pessoa da área; baixa e isenção, só administrador. */
    fun canCharge(i: Installment) = i.state in PAYABLE
    fun canPay(i: Installment, admin: Boolean) = admin && i.state in PAYABLE
    fun canWaive(i: Installment, admin: Boolean) = admin && i.state in (PAYABLE + "cancelled")

    fun canPause(s: Subscription, admin: Boolean) = admin && s.state == "active"
    fun canResume(s: Subscription, admin: Boolean) = admin && s.state == "paused"
    fun canEnd(s: Subscription, admin: Boolean) = admin && s.state != "ended"

    /** Filtros das parcelas do mês: id, título e estados pedidos (vazio: todas). */
    val FILTERS: List<Triple<String, String, List<String>>> = listOf(
        Triple("all", "Todas", emptyList()),
        Triple("open", "Em aberto", listOf("open")),
        Triple("overdue", "Vencidas", listOf("overdue")),
        Triple("paid", "Pagas", listOf("paid")),
        Triple("waived", "Isentas", listOf("waived")),
        Triple("cancelled", "Canceladas", listOf("cancelled")),
    )

    val SUBSCRIPTION_FILTERS: List<Pair<String, String>> = listOf("active" to "Ativas", "paused" to "Pausadas", "ended" to "Encerradas", "all" to "Todas")

    /** Contagem de um filtro pelas chaves exatas de `counts` (ausente vale 0; "all" soma tudo). */
    fun count(counts: Map<String, Int>, filter: String): Int =
        if (filter == "all") counts.values.sum() else FILTERS.firstOrNull { it.first == filter }?.third.orEmpty().sumOf { counts[it] ?: 0 }

    /** "2026-11-10" → "10/11/2026". */
    fun dueText(day: String?): String = day?.let(BrasiliaTime::shortDay) ?: "—"

    /**
     * Data da baixa digitada ("15/11/2026", "15/11" do ano corrente ou "2026-11-15") em "AAAA-MM-DD"; `null` quando
     * não é uma data ou é depois de hoje.
     */
    fun paidDate(text: String, today: String): String? {
        val t = text.trim()
        val iso = when {
            Regex("""\d{4}-\d{2}-\d{2}""").matches(t) -> t
            Regex("""\d{1,2}/\d{1,2}/\d{4}""").matches(t) -> t.split("/").let { (d, m, y) -> "$y-${m.padStart(2, '0')}-${d.padStart(2, '0')}" }
            Regex("""\d{1,2}/\d{1,2}""").matches(t) -> t.split("/").let { (d, m) -> "${today.take(4)}-${m.padStart(2, '0')}-${d.padStart(2, '0')}" }
            else -> return null
        }
        if (BrasiliaTime.parse(iso) == null || iso > today) return null
        return iso
    }

    /** Os telefones do pagador (com o rótulo de quem é) ou, sem pagador, o telefone da assinatura; sem repetir. */
    fun phones(payer: Payer?, customer: MensalidadeCustomer?): List<Pair<String, String?>> {
        val seen = mutableSetOf<String>()
        val raw = payer?.phones?.map { it.phone to it.label?.takeIf { l -> l.isNotBlank() } }.orEmpty() + listOfNotNull(customer?.phone?.let { it to null })
        return raw.mapNotNull { (phone, label) ->
            val digits = phone.filter(Char::isDigit)
            if (digits.isEmpty() || !seen.add(digits)) null else (PhoneText.display(digits) ?: digits) to label
        }
    }

    fun explain(error: Throwable): String {
        val e = error as? QueueException ?: return ModuleFailure.message(error)
        if (e.status == 403) return ADMIN_ONLY
        return when (e.code) {
            "no_conversation" -> "Este cliente ainda não tem conversa no WhatsApp: a cobrança não pode ser enviada por aqui. Ele precisa escrever primeiro."
            "payments_not_configured" -> "A Cobrança (Pix e link) não está configurada nesta área. Um administrador configura no painel; enquanto isso, registre o pagamento com a baixa manual."
            "installment_not_payable" -> "Esta parcela não está mais em aberto (já foi paga, isenta ou cancelada). A tela foi atualizada."
            "invalid_transition" -> (e.message ?: "Esta mudança não vale para a assinatura agora.") + " A tela foi atualizada."
            "subscription_conflict" -> "A assinatura mudou enquanto isso. A tela foi atualizada; tente de novo."
            else -> ModuleFailure.message(e)
        }
    }

    const val ADMIN_ONLY = "Só um administrador da área pode fazer isto. Peça a um administrador."
}
