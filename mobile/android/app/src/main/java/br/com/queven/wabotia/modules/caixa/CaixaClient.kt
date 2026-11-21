package br.com.queven.wabotia.modules.caixa

import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * Caixa simples do app: o controle de caixa do Financeiro do servidor (`erp/v1/financeiro/controle-caixa` e as ações
 * `session_*`, o mesmo do painel e da frente de caixa). Abrir com o troco, lançar entradas (suprimento) e saídas
 * (sangria) com a forma de pagamento e a descrição na observação, e fechar informando o que foi conferido por forma.
 * Mesmo desenho do iOS (`Modules/Caixa/CaixaClient.swift`).
 */

@Serializable
data class CashAccount(val id: String, val name: String = "", val kind: String? = null, val active: Boolean = true)

@Serializable
data class CashAccountList(val items: List<CashAccount> = emptyList())

@Serializable
data class CashMethod(val id: String, val description: String = "", @SerialName("payment_type") val paymentType: String? = null)

@Serializable
data class CashMethodList(val methods: List<CashMethod> = emptyList())

@Serializable
data class CashMove(
    val id: String,
    val kind: String,
    @SerialName("posted_on") val postedOn: String = "",
    val note: String? = null,
    @SerialName("amount_cents") val amountCents: String = "0",
    @SerialName("created_at") val createdAt: String = "",
) {
    val isEntry: Boolean get() = kind == "supply"
    val cents: Long get() = amountCents.toLongOrNull() ?: 0
}

@Serializable
data class CashSession(
    val id: String,
    @SerialName("account_id") val accountId: String,
    @SerialName("account_name") val accountName: String = "",
    @SerialName("operator_name") val operatorName: String = "",
    @SerialName("opened_at") val openedAt: String = "",
    @SerialName("opened_on") val openedOn: String = "",
    @SerialName("change_cents") val changeCents: String = "0",
    val state: String = "open",
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("supply_cents") val supplyCents: String = "0",
    @SerialName("withdrawal_cents") val withdrawalCents: String = "0",
    @SerialName("expected_cash_cents") val expectedCashCents: String = "0",
    @SerialName("informed_cents") val informedCents: String = "0",
    val version: Int = 1,
    val moves: List<CashMove> = emptyList(),
) {
    val isOpen: Boolean get() = state == "open"
    val change: Long get() = changeCents.toLongOrNull() ?: 0
    val entries: Long get() = supplyCents.toLongOrNull() ?: 0
    val exits: Long get() = withdrawalCents.toLongOrNull() ?: 0
}

@Serializable
data class CashSessionPage(val items: List<CashSession> = emptyList(), val total: Int = 0)

@Serializable
data class CashSessionEnvelope(val record: CashSession)

/** Regras do caixa simples, sem rede: textos, somas por forma e o que vai no fechamento. */
object CashRules {
    /** Formas usadas quando o servidor não lista as dele (parte Vendas desligada): só para a observação. */
    val FALLBACK_METHODS = listOf("Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito")
    const val NOTE_LIMIT = 240
    private const val SEPARATOR = " · "

    /** O ERP pede `command_id` UUID: o mesmo vale de `Idempotency-Key`, e repetir com ele não lança duas vezes. */
    fun newKey(): String = java.util.UUID.randomUUID().toString()

    /** Observação do lançamento: "Pix · Corte e barba" (o servidor guarda até 240 caracteres). */
    fun note(method: String, description: String): String {
        val m = method.trim()
        val d = description.trim().replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")
        return (if (d.isEmpty()) m else m + SEPARATOR + d).take(NOTE_LIMIT)
    }

    /** A forma de pagamento de um lançamento (o começo da observação, se for uma forma conhecida). */
    fun methodOf(note: String?, known: List<String>): String? {
        val head = note?.substringBefore(SEPARATOR)?.trim() ?: return null
        return known.firstOrNull { it.equals(head, ignoreCase = true) }
    }

    fun descriptionOf(note: String?, known: List<String>): String {
        val text = note.orEmpty()
        return if (methodOf(text, known) != null) text.substringAfter(SEPARATOR, "").trim() else text.trim()
    }

    /** A forma que é dinheiro: tipo 01 (NFC-e) ou o nome. */
    fun isCash(method: CashMethod): Boolean = method.paymentType == "01" || method.description.trim().equals("Dinheiro", ignoreCase = true)

    /** Entradas menos saídas por forma, na ordem das formas. Lançamento sem forma conhecida conta como dinheiro. */
    fun totalsByMethod(moves: List<CashMove>, known: List<String>): List<Pair<String, Long>> {
        val cash = known.firstOrNull { it.equals("Dinheiro", ignoreCase = true) } ?: "Dinheiro"
        val sums = LinkedHashMap<String, Long>()
        known.forEach { sums[it] = 0 }
        for (move in moves) {
            val method = methodOf(move.note, known) ?: cash
            sums[method] = (sums[method] ?: 0) + if (move.isEntry) move.cents else -move.cents
        }
        return sums.filterValues { it != 0L }.toList()
    }

    /**
     * Dinheiro esperado na gaveta: troco + entradas em dinheiro − saídas em dinheiro (as outras formas não passam pela
     * gaveta).
     */
    fun expectedDrawer(session: CashSession, known: List<String>): Long {
        val cash = known.firstOrNull { it.equals("Dinheiro", ignoreCase = true) } ?: "Dinheiro"
        return session.change + session.moves.filter { (methodOf(it.note, known) ?: cash) == cash }.sumOf { if (it.isEntry) it.cents else -it.cents }
    }

    /**
     * Os valores informados no fechamento: o contado na gaveta na forma dinheiro e, nas outras formas, a soma dos
     * lançamentos. Sem formas do servidor, vai vazio (o servidor aceita) e a conferência fica no painel.
     */
    fun closingValues(methods: List<CashMethod>, session: CashSession, counted: Long): List<Pair<String, Long>> {
        if (methods.isEmpty()) return emptyList()
        val names = methods.map { it.description }
        val totals = totalsByMethod(session.moves, names).toMap()
        return methods.mapNotNull { m ->
            val value = if (isCash(m)) counted else (totals[m.description] ?: 0)
            if (value > 0) m.id to value else null
        }.distinctBy { it.first }.take(50)
    }

    /** "Sobrou R$ 2,00", "Faltou R$ 5,00", "Confere". */
    fun difference(expected: Long, counted: Long): String = when {
        counted == expected -> "Confere com o esperado"
        counted > expected -> "Sobrou ${Money.format(counted - expected)}"
        else -> "Faltou ${Money.format(expected - counted)}"
    }

    /** Mensagens das recusas do controle de caixa, ditas para quem está no balcão. */
    fun message(error: Throwable): String {
        val e = error as? QueueException ?: return error.message ?: "Algo deu errado."
        return when {
            e.status == 409 && e.code == "module_disabled" ->
                "O caixa usa a parte Financeiro do ERP, que está desligada. Um administrador liga em Gestão → Módulos, no painel."
            e.code.contains("cash_session_open", ignoreCase = true) -> "Você já tem um caixa aberto nesta conta. Feche o caixa aberto antes de abrir outro."
            e.code.contains("cash_session_state", ignoreCase = true) -> "Este caixa já foi fechado. Puxe para atualizar."
            e.code.contains("version_conflict", ignoreCase = true) || e.code == "ERP_CONFLICT" -> "O caixa mudou em outro aparelho. Puxe para atualizar e lance de novo."
            e.status == 403 || e.code == "ERP_FORBIDDEN" -> "Seu papel não mexe no caixa. Peça ao administrador o papel Financeiro em Gestão → Pessoas e acessos."
            e.code.contains("invalid_account", ignoreCase = true) -> "Escolha uma conta do tipo Caixa."
            e.status == 0 -> "Sem conexão com o Vinki. O caixa não foi alterado; tente de novo quando a conexão voltar."
            else -> e.message ?: "O Vinki recusou."
        }
    }
}

class CaixaClient(private val api: ProfileApi) {
    suspend fun accounts(): List<CashAccount> =
        api.get("erp/v1/financeiro/accounts", CashAccountList.serializer(), mapOf("limit" to "100")).items.filter { it.active && it.kind == "cash" }

    /** Formas de pagamento cadastradas; vazio quando a rota não responde (parte Vendas desligada, servidor antigo). */
    suspend fun methods(): List<CashMethod> =
        runCatching { api.get("erp/v1/documentos/sales_orders/pagamento", CashMethodList.serializer()).methods }
            .getOrElse { if (it is QueueException && it.unauthorized) throw it else emptyList() }

    /** O meu caixa aberto (o servidor só devolve os da pessoa sem `all=true`). */
    suspend fun openSession(): CashSession? {
        val page = api.get("erp/v1/financeiro/controle-caixa", CashSessionPage.serializer(), mapOf("state" to "open", "limit" to "10"))
        val first = page.items.firstOrNull() ?: return null
        return session(first.id)
    }

    suspend fun session(id: String): CashSession =
        api.get("erp/v1/financeiro/controle-caixa/$id", CashSessionEnvelope.serializer()).record

    private suspend fun action(name: String, data: JsonObject, key: String): CashSession =
        api.send(
            "POST", "erp/v1/financeiro/actions/$name",
            buildJsonObject { put("command_id", key); put("data", data) },
            key, CashSessionEnvelope.serializer(),
        ).record

    suspend fun open(accountId: String, changeCents: Long, key: String = CashRules.newKey()): CashSession =
        action("session_open", buildJsonObject { put("account_id", accountId); put("change_cents", changeCents.toString()) }, key)

    /** Entrada (`supply`) ou saída (`withdrawal`) no caixa aberto. */
    suspend fun move(session: CashSession, entry: Boolean, cents: Long, note: String, day: String, key: String = CashRules.newKey()): CashSession =
        action(
            "session_move",
            buildJsonObject {
                put("id", session.id); put("expected_version", session.version); put("kind", if (entry) "supply" else "withdrawal")
                put("posted_on", day); put("amount_cents", cents.toString()); if (note.isNotBlank()) put("note", note)
            },
            key,
        )

    suspend fun close(session: CashSession, values: List<Pair<String, Long>>, key: String = CashRules.newKey()): CashSession =
        action(
            "session_close",
            buildJsonObject {
                put("id", session.id); put("expected_version", session.version)
                put("values", JsonArray(values.map { (id, cents) -> JsonObject(mapOf("payment_method_id" to JsonPrimitive(id), "amount_cents" to JsonPrimitive(cents.toString()))) }))
            },
            key,
        )
}
