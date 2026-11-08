package br.com.queven.wabotia.ui.tickets

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.theme.DueSoon
import br.com.queven.wabotia.ui.theme.Overdue
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Cor para "respondido"/"concluído" (verde legível em claro e escuro). */
val TicketDone = Color(0xFF2E7D32)

/**
 * Traduz a exceção em mensagem amigável e encerra a sessão em 401 (mantendo o servidor).
 * Use em todos os catch das telas de protocolo.
 */
fun AppContainer.describeError(e: Throwable): String {
    if (e is ApiException && e.isUnauthorized) onLoggedOut(keepServer = true)
    return ApiClient.describe(e)
}

fun ticketStatusLabel(status: String): String = when (status) {
    "open" -> "Aberto"
    "in_progress" -> "Em andamento"
    "closed" -> "Concluído"
    else -> status
}

/** "Hoje 14:32", "Ontem 09:10", "08/11 14:32" ou "08/11/2025 14:32", no fuso do aparelho. */
fun formatWhen(ms: Long?): String {
    if (ms == null || ms <= 0L) return ""
    val zone = ZoneId.systemDefault()
    val dt = Instant.ofEpochMilli(ms).atZone(zone)
    val today = LocalDate.now(zone)
    val date = dt.toLocalDate()
    val time = dt.format(DateTimeFormatter.ofPattern("HH:mm"))
    return when {
        date == today -> "Hoje $time"
        date == today.minusDays(1) -> "Ontem $time"
        date.year == today.year -> dt.format(DateTimeFormatter.ofPattern("dd/MM")) + " " + time
        else -> dt.format(DateTimeFormatter.ofPattern("dd/MM/yyyy")) + " " + time
    }
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

fun Ticket.dueLabel(now: Long = System.currentTimeMillis()): String {
    val due = response_due_at
    return when (dueTone(now)) {
        DueTone.Closed -> if (due != null) "Prazo ${formatWhen(due)}" else "Sem prazo"
        DueTone.Responded -> "Respondido ${formatWhen(first_response_at)}".trim()
        DueTone.None -> "Sem prazo"
        DueTone.Overdue -> "Atrasado · venceu ${formatWhen(due)}"
        DueTone.Soon -> {
            val minutes = ((due!! - now) / 60_000L).coerceAtLeast(1L)
            "Vence em $minutes min"
        }
        DueTone.Scheduled -> "Prazo ${formatWhen(due)}"
    }
}

@Composable
fun DueTone.color(): Color = when (this) {
    DueTone.Overdue -> Overdue
    DueTone.Soon -> DueSoon
    DueTone.Responded -> TicketDone
    DueTone.Scheduled -> MaterialTheme.colorScheme.onSurface
    DueTone.None, DueTone.Closed -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
fun ticketStatusColor(status: String): Color = when (status) {
    "open" -> MaterialTheme.colorScheme.primary
    "in_progress" -> DueSoon
    "closed" -> MaterialTheme.colorScheme.onSurfaceVariant
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
