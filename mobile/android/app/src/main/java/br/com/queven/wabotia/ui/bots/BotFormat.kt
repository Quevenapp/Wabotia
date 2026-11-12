package br.com.queven.wabotia.ui.bots

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import br.com.queven.wabotia.core.model.BotRun
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

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

/** Cor do estado da execução, sempre dos tokens: concluída `ok`, falhou `danger`, sem confirmação `warn`, em curso `bot`. */
@Composable
fun botRunStatusColor(status: String): Color = when (status) {
    "completed" -> Wb.colors.ok
    "failed" -> Wb.colors.danger
    "unknown" -> Wb.colors.warn
    "cancelled", "cancelling" -> Wb.colors.muted
    "queued", "starting", "running" -> Wb.colors.bot
    else -> Wb.colors.muted
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
