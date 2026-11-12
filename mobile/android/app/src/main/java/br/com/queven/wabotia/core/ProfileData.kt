package br.com.queven.wabotia.core

import br.com.queven.wabotia.core.model.ProfileStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * `GET /profiles/{p}/status` com cache curto: contagens por estado (chips da lista), tipo de cada linha
 * (relógio da janela de 24 h só em `meta`/`zernio`) e setores (folha de transferência).
 */
class ProfileData(private val container: AppContainer) {
    private val _status = MutableStateFlow<Map<String, ProfileStatus>>(emptyMap())

    /** Último status conhecido por perfil; as telas observam para recompor quando chega um novo. */
    val status: StateFlow<Map<String, ProfileStatus>> = _status.asStateFlow()

    private val fetchedAt = HashMap<String, Long>()
    private val mutex = Mutex()

    fun cached(profileId: String?): ProfileStatus? = profileId?.let { _status.value[it] }

    /** `connection_id` → `kind`, ou null enquanto o status não foi carregado (aí o relógio aparece por padrão). */
    fun lineKinds(profileId: String?): Map<String, String>? = cached(profileId)?.lineKinds()

    /** Devolve o status (do cache quando recente). Nunca lança: em falha devolve o último valor conhecido. */
    suspend fun load(profileId: String, maxAgeMs: Long = 30_000): ProfileStatus? = mutex.withLock {
        val now = System.currentTimeMillis()
        val current = _status.value[profileId]
        if (current != null && now - (fetchedAt[profileId] ?: 0L) < maxAgeMs) return@withLock current
        try {
            val fresh = container.api.profileStatus(profileId)
            fetchedAt[profileId] = now
            _status.value = _status.value + (profileId to fresh)
            fresh
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            current
        }
    }

    fun clear() {
        fetchedAt.clear()
        _status.value = emptyMap()
    }
}
