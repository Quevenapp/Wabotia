package br.com.queven.wabotia.core.events

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Event
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.core.push.Notifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Consulta única de `GET /profiles/{p}/events?after=cursor` (a cada 4 s) enquanto o app está em primeiro plano.
 * Todas as telas recebem os mesmos lotes por [events]; assim nenhuma tela "consome" o cursor da outra e o cache de
 * prévias/não lidas ([br.com.queven.wabotia.core.ConversationCache]) vê todas as mensagens. O cursor continua
 * persistido por perfil em SessionStore. [online] alimenta a faixa "Sem conexão · tentando reconectar".
 */
class EventHub(private val container: AppContainer, private val intervalMs: Long = 4_000) {
    private val _events = MutableSharedFlow<List<Event>>(extraBufferCapacity = 16)
    val events: SharedFlow<List<Event>> = _events.asSharedFlow()

    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private var started = false

    fun start() {
        if (started) return
        started = true
        val owner = ProcessLifecycleOwner.get()
        owner.lifecycleScope.launch {
            owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    val auth = container.auth.value
                    val profile = auth.profileId
                    if (auth.isLoggedIn && profile != null) {
                        container.conversationCache.use(profile)
                        val batch = withContext(Dispatchers.IO) { poll(profile) }
                        if (!batch.isNullOrEmpty()) {
                            container.conversationCache.onEvents(batch, Notifications.visibleConversationId)
                            _events.emit(batch)
                        }
                    } else {
                        _online.value = true
                    }
                    delay(intervalMs)
                }
            }
        }
    }

    /**
     * Busca eventos após o cursor salvo. Na primeira consulta de um perfil (cursor 0) apenas avança o cursor, sem
     * repetir o histórico: as telas já carregam tudo ao abrir. Devolve null em falha de rede.
     */
    private suspend fun poll(profileId: String): List<Event>? {
        val session = container.session
        var cursor = session.eventCursor(profileId)
        var skipFirst = cursor == 0L
        val collected = ArrayList<Event>()
        repeat(5) {
            val result = try {
                container.api.events(profileId, cursor)
            } catch (e: ApiException) {
                if (e.isUnauthorized) container.onLoggedOut(keepServer = true)
                // O servidor respondeu: há conexão, mesmo que esta consulta tenha sido recusada.
                _online.value = true
                return null
            } catch (e: IOException) {
                _online.value = false
                return null
            } catch (e: IllegalStateException) {
                // Servidor não configurado (sessão encerrada no meio do ciclo).
                return null
            } catch (e: Exception) {
                return null
            }
            _online.value = true
            if (result.cursor > cursor) {
                cursor = result.cursor
                session.setEventCursor(profileId, cursor)
            }
            if (!skipFirst) collected += result.data
            skipFirst = false
            // O servidor devolve no máximo 100 por chamada; menos que isso significa que alcançamos o fim.
            if (result.data.size < 100) return collected
        }
        return collected
    }
}
