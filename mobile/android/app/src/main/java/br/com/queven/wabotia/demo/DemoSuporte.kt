package br.com.queven.wabotia.demo

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * O Suporte pago da demonstração (mesmo desenho do iOS, `DemoSuporte`): a conversa [Ids.C_SUPORTE] chegou à equipe no
 * modo "só telefone vinculado", depois de o cliente informar o documento de um pagador a partir de um número que não
 * está autorizado. O detalhe da conversa traz o `handoff` com o resumo e os marcadores; as ações vinculam o telefone,
 * confirmam e liberam ou dão cortesia, com as recusas do servidor (`nothing_to_link`, `nothing_to_confirm`). Dados
 * fictícios: nenhum documento aparece, nem mascarado.
 */
internal class DemoSuporte(private val t0: Long) {
    private var linked = false
    private var awaitingTeam = true
    private var release: JsonObject? = null
    private val replays = DemoReplays()

    /** `handoff` do detalhe da conversa (o núcleo grava ao passar a conversa à equipe). */
    fun handoff(conversationId: String): JsonElement {
        if (conversationId != Ids.C_SUPORTE) return JsonNull
        val flags = buildList {
            if (!linked) add("telefone não vinculado ao pagador $PAYER")
            if (awaitingTeam) add("aguardando a equipe confirmar quem fala pelo pagador")
            add("suporte avulso pago (até o protocolo fechar)")
        }
        return j(
            "module" to "suporte",
            "summary" to "$PAYER comprou o Suporte avulso de R$ 60,00 pelo Pix. Pediu ajuda com a impressora fiscal que não liga desde a queda de energia.",
            "flags" to flags,
            "at" to t0 - 6 * 60_000,
        )
    }

    fun handle(method: String, r: List<String>, body: JsonObject, key: String?, now: Long, emit: DemoEmit): Reply {
        if (r.size < 2 || r[0] != "conversations") return demoFail(404, "not_found", "Recurso não encontrado.")
        val id = r[1]
        if (id != Ids.C_SUPORTE) {
            return if (method == "GET" && r.size == 2) {
                demoOk(j("conversation_id" to id, "phone" to "", "allowed" to false, "reason" to "payment_required", "release" to null, "session" to null, "awaiting_team" to false, "unlinked_phone" to null, "purchases" to emptyList<String>()))
            } else demoFail(404, "not_found", "Sem atendimento do suporte nesta conversa.")
        }
        if (method == "GET" && r.size == 2) return demoOk(status())
        return replays.run(key, r, body) {
            when (r.getOrNull(2)) {
                "link-phone" -> {
                    if (linked) return@run demoFail(409, "nothing_to_link", "Não há pagador aguardando vínculo nesta conversa.")
                    linked = true
                    emit("suporte.phone_linked", id, j("conversation_id" to id, "payer_id" to PAYER_ID, "actor" to Ids.ME, "module_id" to "suporte"))
                    demoOk(status())
                }
                "confirm" -> {
                    if (!awaitingTeam) return@run demoFail(409, "nothing_to_confirm", "Esta conversa não espera confirmação do suporte pago.")
                    if (body["link"]?.let { (it as? JsonPrimitive)?.content } != "false") linked = true
                    demoOk(release("team", null, null, now, emit))
                }
                "courtesy" -> {
                    val reason = body.str("reason")?.trim().orEmpty()
                    if (reason.isEmpty() || reason.length > 300) return@run demoFail(400, "invalid_request", "Informe o motivo da cortesia (até 300 caracteres).")
                    val hours = (body["hours"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.let { it.intOrNull ?: return@run demoFail(400, "invalid_request", "Horas da cortesia de 1 a 720.") }
                    if (hours != null && hours !in 1..720) return@run demoFail(400, "invalid_request", "Horas da cortesia de 1 a 720.")
                    demoOk(release("courtesy", reason, hours?.let { now + it * 3_600_000L }, now, emit))
                }
                else -> demoFail(404, "not_found", "Recurso não encontrado.")
            }
        }
    }

    private fun release(kind: String, reason: String?, until: Long?, now: Long, emit: DemoEmit): JsonObject {
        awaitingTeam = false
        val row = j(
            "id" to "rel-$kind", "conversation_id" to Ids.C_SUPORTE, "phone" to PHONE, "payer_id" to PAYER_ID, "payer_name" to PAYER,
            "kind" to kind, "kind_label" to LABELS[kind], "ref_id" to null, "phone_linked" to linked, "valid_until" to until, "until_ticket" to (until == null),
            "reason" to reason, "summary" to null, "actor" to Ids.ME, "status" to "active", "ended_at" to null, "ended_by" to null, "created" to now,
        )
        release = row
        emit("suporte.released", Ids.C_SUPORTE, j("conversation_id" to Ids.C_SUPORTE, "kind" to kind, "actor" to Ids.ME, "module_id" to "suporte"))
        return row
    }

    private fun status(): JsonObject {
        val current = release?.let { JsonObject(it + ("phone_linked" to JsonPrimitive(linked))) }
        return j(
            "conversation_id" to Ids.C_SUPORTE, "phone" to PHONE,
            "allowed" to (current != null), "reason" to if (current != null) "released" else "payment_required",
            "release" to current,
            "session" to j("id" to "ss-1", "status" to if (awaitingTeam) "awaiting_team" else "released", "step" to null, "payer_id" to PAYER_ID, "name" to PAYER, "phone_linked" to linked, "matched_by" to "document"),
            "awaiting_team" to awaitingTeam,
            "unlinked_phone" to if (linked) null else j("payer_id" to PAYER_ID, "payer_name" to PAYER),
            "purchases" to listOf(j("id" to "sp-1", "package_name" to "Suporte avulso", "amount_cents" to 6000, "status" to "paid", "created" to t0 - 8 * 60_000)),
        )
    }

    companion object {
        const val PAYER = "Renato Almeida"
        const val PAYER_ID = "py-almeida"
        const val PHONE = "5520906541111"
        private val LABELS = mapOf("package" to "Suporte avulso", "courtesy" to "Cortesia", "team" to "Confirmado pela equipe")
    }
}
