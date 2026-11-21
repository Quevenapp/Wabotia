package br.com.queven.wabotia.modules.os

import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.queue.QueueException
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException

/** Regras das telas da ordem por modelo, sem tela, para testar (mesmo desenho do iOS). */
object WorkOrderRules {
    /** Ordem dos estados de base, a mesma do servidor e do painel (WorkQuoteCommercial.tsx, `RANK`). */
    val RANK: Map<String, Int> = mapOf(
        "received" to 0, "analyzing" to 1, "quoted" to 2, "approved" to 3, "declined" to 3,
        "in_progress" to 4, "ready" to 5, "delivered" to 6, "cancelled" to 7,
    )

    /** Cancelar e voltar etapa (estado de base anterior) pedem motivo, como no servidor. */
    fun needsReason(from: String, to: String): Boolean =
        (to == "cancelled" && from != "cancelled") || (to != "cancelled" && (RANK[to] ?: 99) < (RANK[from] ?: -1))

    fun reasonTitle(from: String, to: String): String = when {
        to == "cancelled" -> "Motivo do cancelamento"
        from == "ready" && to == "in_progress" -> "Motivo do retrabalho"
        to == "analyzing" -> "Motivo para voltar à análise"
        else -> "Motivo para voltar a etapa"
    }

    const val REASON_REQUIRED = "Informe o motivo. Ele fica no histórico da ordem."

    /** O texto do botão de cada próximo passo; o cancelamento fica por último. */
    fun stageButtons(order: WorkOrder): List<Pair<NextStage, String>> {
        val list = order.nextStages.map { next ->
            next to when {
                next.kind == "customer_approval" -> "Pedir aprovação do cliente: ${next.stageLabel.ifBlank { next.stage }}"
                next.baseStatus == "cancelled" -> "Cancelar: ${next.stageLabel.ifBlank { "cancelada" }}"
                needsReason(order.state, next.baseStatus) -> "Voltar para ${next.stageLabel.ifBlank { next.stage }}"
                else -> "Avançar para ${next.stageLabel.ifBlank { next.stage }}"
            }
        }
        return list.filter { it.first.baseStatus != "cancelled" } + list.filter { it.first.baseStatus == "cancelled" }
    }

    /** O texto de um registro do histórico; um código desconhecido nunca aparece cru. */
    fun historyText(h: WorkHistory, stages: List<WorkStage> = emptyList()): String {
        val kind = h.kind.orEmpty()
        return when {
            kind == "opened" -> "Ordem aberta"
            kind == "os.checklist_marked" -> h.note?.takeIf { it.isNotBlank() } ?: "Checklist alterado"
            kind == "quote" -> if (h.toStatus == "quoted") "Orçamento enviado" else "Orçamento salvo"
            kind == "edit" || kind == "os.updated" -> "Dados alterados"
            !h.toStage.isNullOrBlank() || kind.contains("stage") -> {
                val label = stages.firstOrNull { it.id == h.toStage }?.label?.takeIf { it.isNotBlank() }
                    ?: h.toStatus?.let(ServiceOrderRules::statusLabel)?.takeIf { it != h.toStatus }
                if (label != null) "Etapa: $label" else "Etapa alterada"
            }
            kind == "status" && h.toStatus != null -> ServiceOrderRules.statusLabel(h.toStatus).takeIf { it != h.toStatus } ?: "Alteração"
            else -> "Alteração"
        }
    }

    /** O motivo mostrado embaixo (o checklist já usa a nota como texto principal). */
    fun historyNote(h: WorkHistory): String? = h.note?.takeIf { it.isNotBlank() && h.kind != "os.checklist_marked" }

    /** O botão "Enviar ao cliente pelo WhatsApp" só aparece quando o servidor oferece e há conversa ligada. */
    fun canSendQuote(order: WorkOrder): Boolean =
        !order.closed && order.quote != null && "quoted" in order.nextStatuses && !order.customer?.conversationId.isNullOrBlank()

    /** A situação do orçamento: decisão, envio e validade, ou ainda não enviado. */
    fun quoteStatus(order: WorkOrder): String {
        val quote = order.quote ?: return ""
        val decision = order.decision
        if (decision?.decision == "approved" || decision?.decision == "approve") return "Aprovado em ${decision.at?.let(BrasiliaTime::shortWithTime) ?: "—"}"
        if (decision?.decision == "declined" || decision?.decision == "decline") return "Recusado em ${decision.at?.let(BrasiliaTime::shortWithTime) ?: "—"}"
        val sent = quote.sentAt ?: return "Ainda não enviado"
        val text = "Enviado em ${BrasiliaTime.shortWithTime(sent)}" + (quote.validUntil?.let { ", válido até ${BrasiliaTime.short(it)}" } ?: "")
        return if (quote.expired) "$text · Vencido" else text
    }

    /** Prazo vencido numa ordem ainda aberta. */
    fun overdue(order: WorkOrder, now: Long = System.currentTimeMillis()): Boolean = !order.closed && (order.dueAt?.let { it < now } ?: false)

    /** Situação da lista: abertas, concluídas, canceladas e todas. */
    val SITUATIONS: List<Pair<String, String>> = listOf("open" to "Abertas", "delivered" to "Concluídas", "cancelled" to "Canceladas", "all" to "Todas")

    /** Os modelos que entram no filtro: os ativos (custom não arquivados e o embutido, quando no catálogo). */
    fun activeTypes(catalog: List<WorkType>): List<WorkType> = catalog.filter { it.isBuiltin || !it.archived }

    /**
     * A consulta da lista, igual à do painel: sem modelo escolhido manda `type_ids` com todos os ativos; com modelo,
     * `type_id`. A etapa (só com modelo) substitui a situação.
     */
    fun listQuery(catalog: List<WorkType>, typeId: String?, situation: String, stage: String?, query: String, cursor: String? = null, limit: Int = 50): Map<String, String?> {
        val withStage = typeId != null && !stage.isNullOrBlank()
        return mapOf(
            "type_id" to typeId,
            "type_ids" to if (typeId == null) activeTypes(catalog).map { it.id }.filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.joinToString(",") else null,
            "stage" to if (withStage) stage else null,
            "open" to if (!withStage && situation == "open") "1" else null,
            "status" to if (!withStage && (situation == "delivered" || situation == "cancelled")) situation else null,
            "q" to query.trim().takeIf { it.isNotEmpty() },
            "cursor" to cursor,
            "limit" to limit.toString(),
        )
    }

    /** A chave do cache da lista para a combinação de filtros (sem o cursor). */
    fun listKey(typeId: String?, situation: String, stage: String?, query: String): String =
        listOf(typeId ?: "*", if (typeId != null && !stage.isNullOrBlank()) "stage:$stage" else situation, query.trim().lowercase()).joinToString("|")

    /** Mostra o nome do modelo na linha quando há mais de um modelo ativo. */
    fun showTypeLabel(catalog: List<WorkType>): Boolean = activeTypes(catalog).size > 1

    /** Só contatos vivos da equipe: sem fusão, do espaço da equipe e ativos. */
    fun visibleContact(c: WorkContact): Boolean =
        c.mergedInto.isNullOrBlank() && (c.namespace.isNullOrBlank() || c.namespace == "team") && (c.identityState.isNullOrBlank() || c.identityState == "active")

    /**
     * O endereço completo do envio a partir do `upload_url` devolvido pelo servidor. Só o mesmo servidor (esquema,
     * host e porta) e só rotas `/api/`: um endereço de outro domínio é recusado (`null`).
     */
    fun uploadTarget(serverRoot: String, uploadUrl: String): String? {
        val base = (serverRoot.trimEnd('/') + "/").toHttpUrlOrNull() ?: return null
        val trimmed = uploadUrl.trim()
        if (trimmed.isEmpty()) return null
        val target = base.resolve(trimmed) ?: return null
        if (target.scheme != base.scheme || !target.host.equals(base.host, ignoreCase = true) || target.port != base.port) return null
        if (!target.encodedPath.startsWith("/api/")) return null
        return target.toString()
    }

    /** Lado maior da foto do checklist e o tamanho final, mantendo a proporção. */
    const val PHOTO_MAX_SIDE = 1600
    const val PHOTO_MAX_BYTES = 10L * 1024 * 1024

    fun scaledSize(width: Int, height: Int, maxSide: Int = PHOTO_MAX_SIDE): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return width to height
        val largest = maxOf(width, height)
        if (largest <= maxSide) return width to height
        val ratio = maxSide.toDouble() / largest
        return maxOf(1, Math.round(width * ratio).toInt()) to maxOf(1, Math.round(height * ratio).toInt())
    }

    /** Falha de rede (ou servidor fora do ar): leitura mostra o cache, escrita não é guardada. */
    fun isOffline(e: Throwable): Boolean = (e is QueueException && e.retryable) || e is IOException

    const val OFFLINE_WRITE = "Sem conexão. Esta mudança não foi guardada: tente de novo quando a internet voltar."
    const val VERSION_CONFLICT = "Outra pessoa mudou esta ordem. A ficha foi atualizada; confira e tente de novo."
    const val FORBIDDEN = "Sua conta não tem acesso às ordens de serviço. Peça a um administrador."
    const val ORDER_CLOSED = "A ordem está encerrada: não muda mais."
    const val NO_CONVERSATION = "Esta ordem não está ligada a uma conversa do WhatsApp. Envie pelo painel."
    const val PHOTO_TOO_BIG = "A foto ficou grande demais. Tire de novo, de mais longe ou com menos zoom."
    const val CAMERA_DENIED = "Este item pede foto pela câmera. Libere a câmera para o Vinki nas configurações do aparelho."
    const val CUSTOMER_REQUIRED = "Confirme o cadastro do cliente antes de escolher o objeto."
    const val OBJECT_CHANGED = "O cadastro do objeto mudou. Escolha o objeto de novo."
    const val NO_CONTACTS = "Nenhum cliente com esse nome ou telefone. Cadastre o cliente na conversa ou no painel e busque de novo."

    fun offlineBanner(savedAt: Long): String =
        "Sem conexão. Você está vendo a cópia de ${dayMonthTime(savedAt)}. Para mudar a ordem, conecte-se."

    private fun dayMonthTime(millis: Long): String {
        val full = BrasiliaTime.shortWithTime(millis) // dd/MM/yyyy HH:mm
        return full.substring(0, 5) + full.substring(10)
    }

    /** A mensagem de uma recusa numa escrita ou leitura da ordem por modelo. */
    fun message(e: Throwable): String {
        if (e is IOException) return OFFLINE_WRITE
        val q = e as? QueueException ?: return ModuleFailure.message(e)
        if (q.retryable && q.status == 0) return OFFLINE_WRITE
        return when (q.code) {
            "version_conflict" -> VERSION_CONFLICT
            "order_closed" -> ORDER_CLOSED
            "no_conversation" -> NO_CONVERSATION
            "customer_required" -> CUSTOMER_REQUIRED
            "object_definition_conflict", "object_archived" -> OBJECT_CHANGED
            // Documentos da ordem: 413 `document_too_large` (acima de 10 MB) e 415 `unsupported_media_type`.
            "unsupported_media_type", "payload_too_large", "document_too_large" -> PHOTO_TOO_BIG
            "forbidden" -> FORBIDDEN
            else -> when {
                q.status == 403 -> FORBIDDEN
                q.status == 413 -> PHOTO_TOO_BIG
                else -> ModuleFailure.actionMessage(q)
            }
        }
    }

    /** O catálogo não existe neste servidor (versão antiga): a entrada cai na lista antiga. */
    fun catalogMissing(e: Throwable): Boolean {
        val q = e as? QueueException ?: return false
        return q.status == 404 || q.code == "not_found" || q.code == "not_implemented" || q.status == 501
    }
}
