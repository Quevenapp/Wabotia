package br.com.queven.wabotia.calls

import br.com.queven.wabotia.core.model.Call
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Textos e formatações do histórico de ligações (mesmos rótulos do painel web). */
object CallText {
    fun status(status: String): String = when (status) {
        "ringing" -> "Recebendo ligação"
        "dialing" -> "Chamando"
        "connecting" -> "Conectando áudio"
        "preaccepted" -> "Preparando áudio"
        "active" -> "Em ligação"
        "completed" -> "Encerrada"
        "missed" -> "Não atendida"
        "rejected" -> "Recusada"
        "failed" -> "Falhou"
        "unknown" -> "Sem confirmação"
        else -> status.ifBlank { "Desconhecido" }
    }

    fun direction(call: Call): String = if (call.direction == "inbound") "Recebida" else "Realizada"

    /** Estado final (encerrada, não atendida, recusada ou falhou). */
    fun isFinal(status: String): Boolean = status in setOf("completed", "missed", "rejected", "failed")

    /** Duração em segundos → "0:42", "12:05", "1:03:20". */
    fun duration(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, sec) else String.format("%d:%02d", m, sec)
    }

    private val timeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM")
    private val fullFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy")

    /** "Hoje 14:32", "Ontem 09:10", "08/11 18:00", "20/03/2025 10:00". */
    fun date(epochMillis: Long): String {
        if (epochMillis <= 0) return ""
        val zone = ZoneId.systemDefault()
        val dateTime = Instant.ofEpochMilli(epochMillis).atZone(zone)
        val today = LocalDate.now(zone)
        val day = dateTime.toLocalDate()
        val time = dateTime.format(timeFormat)
        return when {
            day == today -> "Hoje $time"
            day == today.minusDays(1) -> "Ontem $time"
            day.year == today.year -> "${dateTime.format(dayFormat)} $time"
            else -> "${dateTime.format(fullFormat)} $time"
        }
    }
}
