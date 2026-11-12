package br.com.queven.wabotia.ui.components

import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Textos e datas compartilhados por todas as telas (pt-BR, fuso do aparelho).

private val ptBR = Locale("pt", "BR")
private val timeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", ptBR)
private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM", ptBR)
private val dayYearFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yy", ptBR)
private val longDayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d 'de' MMMM", ptBR)
private val longDayYearFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d 'de' MMMM 'de' yyyy", ptBR)

/** "14:32". */
fun formatTime(ms: Long?): String {
    if (ms == null || ms <= 0) return ""
    return Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(timeFormat)
}

/** Horário da lista, como no WhatsApp: "14:32" hoje, "Ontem", "08/11" ou "08/11/25". */
fun formatListTime(ms: Long?): String {
    if (ms == null || ms <= 0) return ""
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(ms).atZone(zone)
    val today = LocalDate.now(zone)
    val date = moment.toLocalDate()
    return when {
        date == today -> moment.format(timeFormat)
        date == today.minusDays(1) -> "Ontem"
        date.year == today.year -> moment.format(dayFormat)
        else -> moment.format(dayYearFormat)
    }
}

/** "Hoje 14:32", "Ontem 09:10", "08/11 14:32" ou "08/11/25 14:32". */
fun formatWhen(ms: Long?): String {
    if (ms == null || ms <= 0) return ""
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(ms).atZone(zone)
    val today = LocalDate.now(zone)
    val date = moment.toLocalDate()
    val time = moment.format(timeFormat)
    val day = when {
        date == today -> "Hoje"
        date == today.minusDays(1) -> "Ontem"
        date.year == today.year -> moment.format(dayFormat)
        else -> moment.format(dayYearFormat)
    }
    return "$day $time"
}

/** Chip de data da conversa: "Hoje", "Ontem", "12 de novembro" (com ano quando não é o atual). */
fun formatDayLabel(ms: Long): String {
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(ms).atZone(zone)
    val today = LocalDate.now(zone)
    val date = moment.toLocalDate()
    return when {
        date == today -> "Hoje"
        date == today.minusDays(1) -> "Ontem"
        date.year == today.year -> moment.format(longDayFormat)
        else -> moment.format(longDayYearFormat)
    }
}

/** Dia local (para agrupar mensagens por data). */
fun localDayOf(ms: Long): LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()

/** Duração "m:ss" para players e gravação. */
fun formatClock(ms: Long): String {
    val totalSeconds = ms.coerceAtLeast(0) / 1000
    return String.format(Locale.US, "%d:%02d", totalSeconds / 60, totalSeconds % 60)
}

/** Intervalo curto para "há …": "agora", "4 min", "2h", "3 d". */
fun formatSpan(ms: Long): String {
    val minutes = ms.coerceAtLeast(0) / 60_000
    return when {
        minutes < 1 -> "agora"
        minutes < 60 -> "$minutes min"
        minutes < 48 * 60 -> "${minutes / 60}h"
        else -> "${minutes / (60 * 24)} d"
    }
}

/** Iniciais para o avatar: primeira letra do primeiro e do último nome (até 2). */
fun initialsOf(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { w -> w.any { it.isLetterOrDigit() } }
    if (words.isEmpty()) return "?"
    val first = words.first().first { it.isLetterOrDigit() }.uppercaseChar()
    if (words.size == 1 || !first.isLetter()) return first.toString()
    val last = words.last().first { it.isLetterOrDigit() }.uppercaseChar()
    return "$first$last"
}

/** Telefone só com dígitos (busca de protocolos por conversa). */
fun digitsOf(phone: String?): String = phone.orEmpty().filter { it.isDigit() }

/** Telefone brasileiro legível: +55 11 99999-0000. Outros formatos voltam como vieram. */
fun formatPhone(phone: String?): String {
    val d = digitsOf(phone)
    return when {
        d.length == 13 && d.startsWith("55") -> "+55 ${d.substring(2, 4)} ${d.substring(4, 9)}-${d.substring(9)}"
        d.length == 12 && d.startsWith("55") -> "+55 ${d.substring(2, 4)} ${d.substring(4, 8)}-${d.substring(8)}"
        d.isNotEmpty() && phone?.trim()?.startsWith("+") != true && d.length > 10 -> "+$d"
        else -> phone.orEmpty()
    }
}

/** Traduz a exceção e, em 401, encerra a sessão mantendo o servidor (regra do contrato). Use em todo `catch` de tela. */
fun AppContainer.handleError(e: Throwable): String {
    if (e is ApiException && e.isUnauthorized) onLoggedOut(keepServer = true)
    return ApiClient.describe(e)
}
