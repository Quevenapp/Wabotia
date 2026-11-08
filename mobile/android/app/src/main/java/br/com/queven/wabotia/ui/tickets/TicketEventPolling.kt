package br.com.queven.wabotia.ui.tickets

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.events.EventsPoller
import br.com.queven.wabotia.core.model.Event

/**
 * Consulta de eventos das telas de protocolo (lista e detalhe), em primeiro plano (STARTED), usando o
 * [EventsPoller] público de core/events. [onStart] roda sempre que a tela volta a ficar visível (outra tela pode ter
 * avançado o cursor de eventos enquanto esta estava fora) e [onTicketEvent] recebe cada evento `ticket.*` novo.
 *
 * O cursor é o mesmo das demais telas (persistido por perfil em SessionStore), então não há repetição de eventos.
 */
@Composable
internal fun TicketEventPolling(
    container: AppContainer,
    profileId: String,
    onStart: (() -> Unit)? = null,
    onTicketEvent: (Event) -> Unit,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(profileId, lifecycle) {
        if (profileId.isBlank()) return@LaunchedEffect
        val poller = EventsPoller(container, profileId)
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            onStart?.invoke()
            poller.events().collect { event ->
                if (EventsPoller.isTicketEvent(event)) onTicketEvent(event)
            }
        }
    }
}
