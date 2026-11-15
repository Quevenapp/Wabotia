package br.com.queven.wabotia.core

import br.com.queven.wabotia.queue.QueueAvailability
import br.com.queven.wabotia.queue.QueueAvailabilityProbe
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Se a fila de senhas existe no servidor para o perfil aberto (módulo ligado). As telas só mostram guichê e impressora
 * quando sim; servidor antigo, módulo desligado ou sem permissão escondem. Consulta no máximo a cada minuto por perfil.
 */
class QueueFeature(private val container: AppContainer) {
    private val _available = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val available: StateFlow<Map<String, Boolean>> = _available.asStateFlow()
    private val checkedAt = mutableMapOf<String, Long>()

    fun isAvailable(profileId: String?): Boolean = profileId != null && _available.value[profileId] == true

    suspend fun refresh(force: Boolean = false) {
        val server = container.session.serverUrl ?: return
        val profile = container.session.profileId ?: return
        val now = System.currentTimeMillis()
        if (!force && now - (checkedAt[profile] ?: 0L) < 60_000) return
        checkedAt[profile] = now
        when (QueueAvailabilityProbe(server, profile, { container.session.token }).check()) {
            QueueAvailability.AVAILABLE -> _available.update { it + (profile to true) }
            QueueAvailability.UNAVAILABLE -> _available.update { it + (profile to false) }
            // Sem rede: fica o que já se sabia, e a próxima consulta tenta de novo.
            QueueAvailability.UNKNOWN -> checkedAt.remove(profile)
        }
    }

    fun clear() {
        checkedAt.clear()
        _available.value = emptyMap()
    }
}
