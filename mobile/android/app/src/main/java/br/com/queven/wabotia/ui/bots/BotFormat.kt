package br.com.queven.wabotia.ui.bots

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.BotRun
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.ui.theme.DueSoon
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

val BotDone = Color(0xFF2E7D32)

/** Traduz a exceção e encerra a sessão em 401 (mantendo o servidor). */
fun AppContainer.describeError(e: Throwable): String {
    if (e is ApiException && e.isUnauthorized) onLoggedOut(keepServer = true)
    return ApiClient.describe(e)
}

fun botRunStatusLabel(status: String): String = when (status) {
    "queued" -> "Na fila"
    "starting" -> "Iniciando"
    "running" -> "Em execução"
    "cancelling" -> "Cancelando"
    "cancelled" -> "Cancelada"
    "completed" -> "Concluída"
    "failed" -> "Falhou"
    "unknown" -> "Sem confirmação"
    else -> status
}

fun isRunActive(status: String) = status in setOf("queued", "starting", "running", "cancelling")

@Composable
fun botRunStatusColor(status: String): Color = when (status) {
    "completed" -> BotDone
    "failed" -> MaterialTheme.colorScheme.error
    "unknown" -> DueSoon
    "cancelled", "cancelling" -> MaterialTheme.colorScheme.onSurfaceVariant
    "queued", "starting", "running" -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** "Hoje 14:32", "Ontem 09:10", "08/11 14:32" ou "08/11/2025 14:32". */
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

/** Texto e anexos extraídos do `result` de uma execução (texto puro ou JSON do Hermes com text/output/attachments). */
data class BotOutput(val text: String, val attachments: List<String>)

fun BotRun.output(): BotOutput {
    val raw = result?.trim().orEmpty()
    var text = raw
    var files: List<String> = this.attachments
    if (raw.startsWith("{")) {
        val obj = runCatching { WabotiaJson.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        if (obj != null) {
            val candidate = listOf("text", "output", "message", "content", "result", "answer", "response")
                .firstNotNullOfOrNull { k -> obj.string(k)?.takeIf { it.isNotBlank() } }
            if (files.isEmpty()) {
                files = (obj["attachments"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
            }
            text = candidate ?: run {
                // Sem campo textual reconhecido: mostra o JSON sem os anexos, de forma legível.
                val rest = JsonObject(obj.filterKeys { it != "attachments" && it != "files" })
                if (rest.isEmpty()) "" else rest.toString()
            }
        }
    }
    return BotOutput(text = text, attachments = files.distinct())
}
