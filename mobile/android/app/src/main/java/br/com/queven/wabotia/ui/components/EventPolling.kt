package br.com.queven.wabotia.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Event

/**
 * Liga a tela aos eventos do perfil enquanto ela está visível (STARTED). [onStart] roda sempre que a tela volta ao
 * primeiro plano (recarga completa) e [onEvents] recebe cada lote novo. A consulta em si é única para o app todo
 * ([br.com.queven.wabotia.core.events.EventHub]); aqui só se escuta.
 */
@Composable
fun EventPolling(
    container: AppContainer,
    profileId: String,
    onStart: suspend () -> Unit = {},
    onEvents: suspend (List<Event>) -> Unit,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentStart by rememberUpdatedState(onStart)
    val currentEvents by rememberUpdatedState(onEvents)
    LaunchedEffect(profileId, lifecycle) {
        if (profileId.isBlank()) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            currentStart()
            container.events.events.collect { batch -> if (batch.isNotEmpty()) currentEvents(batch) }
        }
    }
}
