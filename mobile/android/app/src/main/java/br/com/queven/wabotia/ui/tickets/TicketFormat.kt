package br.com.queven.wabotia.ui.tickets

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.ui.components.formatSpan
import br.com.queven.wabotia.ui.components.formatWhen
import br.com.queven.wabotia.ui.theme.Wb

// Textos, cores e prazos compartilhados pela lista, pelo cartão e pelo detalhe de protocolos (DESIGN.md, seção 8).

fun ticketStatusLabel(status: String): String = when (status) {
    "open" -> "Aberto"
    "in_progress" -> "Em andamento"
    "closed" -> "Concluído"
    else -> status
}

@Composable
fun ticketStatusColor(status: String): Color = when (status) {
    "open" -> Wb.colors.ticket
    "in_progress" -> Wb.colors.warn
    else -> Wb.colors.muted
}

/** Situação do prazo de primeira resposta, usada para cor e texto na lista e no detalhe. */
enum class DueTone { Overdue, Soon, Scheduled, None, Responded, Closed }

fun Ticket.dueTone(now: Long = System.currentTimeMillis()): DueTone {
    val due = response_due_at
    return when {
        status == "closed" -> DueTone.Closed
        first_response_at != null -> DueTone.Responded
        due == null -> DueTone.None
        due < now -> DueTone.Overdue
        due - now < 60L * 60L * 1000L -> DueTone.Soon
        else -> DueTone.Scheduled
    }
}

/** Texto curto do cartão: "atrasado há 2h", "vence em 40 min", "até Hoje 18:00", "Respondido", "Sem prazo", "Concluído". */
fun Ticket.dueLabel(now: Long = System.currentTimeMillis()): String {
    val due = response_due_at
    return when (dueTone(now)) {
        DueTone.Closed -> "Concluído"
        DueTone.Responded -> "Respondido"
        DueTone.None -> "Sem prazo"
        DueTone.Overdue -> {
            val span = formatSpan(now - (due ?: now))
            if (span == "agora") "venceu agora" else "atrasado há $span"
        }
        DueTone.Soon -> "vence em ${(((due ?: now) - now) / 60_000L).coerceAtLeast(1L)} min"
        DueTone.Scheduled -> "até ${formatWhen(due)}"
    }
}

/** Texto completo do detalhe, com a data do prazo. */
fun Ticket.dueDetail(now: Long = System.currentTimeMillis()): String {
    val due = response_due_at
    return when (dueTone(now)) {
        DueTone.Closed -> if (due != null) "Prazo era ${formatWhen(due)}" else "Sem prazo"
        DueTone.Responded -> "Respondido ${formatWhen(first_response_at)}".trim()
        DueTone.None -> "Sem prazo definido"
        DueTone.Overdue -> {
            val span = formatSpan(now - (due ?: now))
            (if (span == "agora") "Venceu agora" else "Atrasado há $span") + " · venceu ${formatWhen(due)}"
        }
        DueTone.Soon -> "Vence em ${(((due ?: now) - now) / 60_000L).coerceAtLeast(1L)} min · ${formatWhen(due)}"
        DueTone.Scheduled -> "Até ${formatWhen(due)}"
    }
}

/** Quanto do prazo ainda resta (1 = recém-aberto, 0 = vencido ou sem prazo), para o anel. */
fun Ticket.dueFraction(now: Long = System.currentTimeMillis()): Float {
    val due = response_due_at ?: return 0f
    val total = (due - created).coerceAtLeast(60_000L)
    return ((due - now).toFloat() / total.toFloat()).coerceIn(0f, 1f)
}

/** Cor do anel e do destaque do prazo. */
@Composable
fun DueTone.color(): Color = when (this) {
    DueTone.Overdue -> Wb.colors.danger
    DueTone.Soon -> Wb.colors.warn
    DueTone.Responded, DueTone.Scheduled -> Wb.colors.ok
    DueTone.None, DueTone.Closed -> Wb.colors.muted
}

/** Cor do texto do prazo: só chama atenção quando há algo a fazer. */
@Composable
fun DueTone.textColor(): Color = when (this) {
    DueTone.Overdue -> Wb.colors.danger
    DueTone.Soon -> Wb.colors.warn
    DueTone.Responded -> Wb.colors.ok
    DueTone.Scheduled, DueTone.None, DueTone.Closed -> Wb.colors.textSecondary
}
