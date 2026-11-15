package br.com.queven.wabotia.device.ui

/** O texto de espera do botão da fila (porta de `Vinki_v4/.../PanelTotemScreens.kt`). */
internal object QueueMetricsCopy {
    fun option(waitingCount: Int, estimatedWaitMinutes: Int?): String =
        when {
            // Fila vazia: "0 aguardando · cerca de 0 min" não se fala no balcão.
            waitingCount == 0 -> "Sem fila agora"
            estimatedWaitMinutes == null -> "$waitingCount aguardando"
            else -> "$waitingCount aguardando · cerca de $estimatedWaitMinutes min"
        }
}
