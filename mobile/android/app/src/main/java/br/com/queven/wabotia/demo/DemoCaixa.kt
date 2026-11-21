package br.com.queven.wabotia.demo

import br.com.queven.wabotia.modules.BrasiliaTime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.util.UUID

/**
 * O caixa da demonstração, mesmo desenho do iOS (`Core/Demo/DemoCaixa.swift`): as rotas do controle de caixa do
 * Financeiro (`erp/v1/financeiro/accounts`, `…/controle-caixa`, `…/actions/session_*`) e as formas de pagamento
 * (`erp/v1/documentos/sales_orders/pagamento`), no formato do servidor. Começa com o caixa fechado.
 */
internal class DemoCaixa {
    private val accounts = listOf(
        j("id" to id("conta-caixa"), "name" to "Caixa do salão", "kind" to "cash", "active" to true),
        j("id" to id("conta-banco"), "name" to "Banco Exemplo", "kind" to "bank", "active" to true),
    )
    private val methods = listOf(
        j("id" to id("forma-dinheiro"), "description" to "Dinheiro", "payment_type" to "01", "is_default" to true),
        j("id" to id("forma-pix"), "description" to "Pix", "payment_type" to "17", "is_default" to false),
        j("id" to id("forma-debito"), "description" to "Cartão de débito", "payment_type" to "04", "is_default" to false),
        j("id" to id("forma-credito"), "description" to "Cartão de crédito", "payment_type" to "03", "is_default" to false),
    )

    private class Session(val id: String, val accountId: String, val change: Long, val openedAt: String) {
        var state = "open"
        var version = 1
        var closedAt: String? = null
        val moves = mutableListOf<JsonObject>()
        var values = listOf<Pair<String, Long>>()
    }

    private val sessions = mutableListOf<Session>()
    private val replays = HashMap<String, Reply>()

    fun handle(method: String, r: List<String>, body: JsonObject): Reply? {
        val p = r.drop(1).let { if (it.firstOrNull() == "v1") it.drop(1) else return null }
        return when {
            p == listOf("financeiro", "accounts") -> ok(j("entity" to "accounts", "items" to accounts, "limit" to 100, "has_more" to false, "data_mode" to "erp_native"))
            p == listOf("documentos", "sales_orders", "pagamento") -> ok(j("kind" to "sales_orders", "methods" to methods, "data_mode" to "erp_native"))
            p == listOf("financeiro", "controle-caixa") -> {
                val open = sessions.filter { it.state == "open" }
                ok(j("entity" to "cash_sessions", "state" to "open", "items" to open.map { view(it, false) }, "total" to open.size, "data_mode" to "erp_native"))
            }
            p.size == 3 && p[0] == "financeiro" && p[1] == "controle-caixa" ->
                sessions.firstOrNull { it.id == p[2] }?.let { ok(j("entity" to "cash_sessions", "record" to view(it, true), "data_mode" to "erp_native")) }
                    ?: Reply.error(404, "ERP_NOT_FOUND", "Caixa não encontrado.")
            p.size == 3 && p[0] == "financeiro" && p[1] == "actions" && method == "POST" -> {
                val command = body.str("command_id").orEmpty()
                replays[command] ?: action(p[2], body["data"] as? JsonObject ?: JsonObject(emptyMap())).also { if (it.code < 300) replays[command] = it }
            }
            else -> null
        }
    }

    private fun action(name: String, data: JsonObject): Reply {
        if (name == "session_open") {
            val account = data.str("account_id")
            if (accounts.none { it.str("id") == account && it.str("kind") == "cash" }) return Reply.error(400, "erp_finance_invalid_account", "Conta inválida.")
            if (sessions.any { it.state == "open" && it.accountId == account }) return Reply.error(409, "erp_finance_cash_session_open", "Caixa já aberto.")
            val s = Session(UUID.randomUUID().toString(), account!!, data.str("change_cents")?.toLongOrNull() ?: 0, now())
            sessions += s
            return result(name, s)
        }
        val s = sessions.firstOrNull { it.id == data.str("id") } ?: return Reply.error(404, "ERP_NOT_FOUND", "Caixa não encontrado.")
        if ((data["expected_version"] as? JsonPrimitive)?.intOrNull != s.version) return Reply.error(409, "erp_finance_version_conflict", "O caixa mudou.")
        if (s.state != "open") return Reply.error(409, "erp_finance_cash_session_state", "Caixa fechado.")
        when (name) {
            "session_move" -> s.moves += j(
                "id" to UUID.randomUUID().toString(), "kind" to data.str("kind"), "posted_on" to (data.str("posted_on") ?: BrasiliaTime.today()),
                "note" to data.str("note"), "amount_cents" to data.str("amount_cents"), "created_at" to now(),
            )
            "session_close" -> {
                s.values = (data["values"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map { it.str("payment_method_id").orEmpty() to (it.str("amount_cents")?.toLongOrNull() ?: 0) }
                s.state = "closed"
                s.closedAt = now()
            }
            else -> return Reply.error(400, "ERP_INVALID_QUERY", "Ação não disponível na demonstração.")
        }
        s.version++
        return result(name, s)
    }

    private fun result(action: String, s: Session) = ok(j("action" to action, "replayed" to false, "entity" to "cash_sessions", "record" to view(s, true), "data_mode" to "erp_native"))

    private fun view(s: Session, lines: Boolean): JsonObject {
        val supply = s.moves.filter { it.str("kind") == "supply" }.sumOf { it.str("amount_cents")?.toLongOrNull() ?: 0 }
        val withdrawal = s.moves.filter { it.str("kind") == "withdrawal" }.sumOf { it.str("amount_cents")?.toLongOrNull() ?: 0 }
        val base = mapOf(
            "id" to s.id, "account_id" to s.accountId, "account_name" to accounts.first { it.str("id") == s.accountId }.str("name"),
            "operator_id" to Ids.ME, "operator_name" to "Você", "opened_at" to s.openedAt, "opened_on" to BrasiliaTime.today(),
            "previous_change_cents" to "0", "change_cents" to s.change.toString(), "state" to s.state, "closed_by_name" to if (s.closedAt != null) "Você" else null,
            "closed_at" to s.closedAt, "checked" to false, "supply_cents" to supply.toString(), "withdrawal_cents" to withdrawal.toString(),
            "expected_cash_cents" to (s.change + supply - withdrawal).toString(), "informed_cents" to s.values.sumOf { it.second }.toString(),
            "version" to s.version, "created_at" to s.openedAt,
        )
        if (!lines) return j(*base.toList().toTypedArray())
        return j(
            *base.toList().toTypedArray(),
            "values" to s.values.map { (m, v) -> j("payment_method_id" to m, "payment_method_name" to methods.first { it.str("id") == m }.str("description"), "amount_cents" to v.toString()) },
            "methods" to emptyList<Any>(),
            "moves" to s.moves,
        )
    }

    private fun ok(body: JsonObject) = Reply.json(body)
    private fun now() = java.time.Instant.now().toString()

    companion object {
        /** Ids fixos (UUID) a partir de uma chave, como no servidor. */
        fun id(key: String): String = UUID.nameUUIDFromBytes("wabotia-demo-caixa:$key".toByteArray()).toString()
    }
}
