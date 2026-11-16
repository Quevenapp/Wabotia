package br.com.queven.wabotia.core

import br.com.queven.wabotia.queue.QueueAvailabilityProbe
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Ids dos módulos no contrato (`GET /api/v1/capabilities`, docs/MODULOS.md). */
object ModuleIds {
    const val QUEUE = "queue"
    const val AGENDA = "agenda"
    const val SERVICE_ORDERS = "os"
    const val RESERVA = "reserva"
    const val MENSALIDADE = "mensalidade"
    const val PEDIDO = "pedido"
    /** Suporte pago: passagem para humano só depois de conferir o pagamento (depende da Mensalidade). */
    const val SUPORTE = "suporte"
    /** Formulários por link de uso único (passo web), enviados pela conversa. */
    const val FORMS = "forms"
    /** Cobrança: Pix e link de pagamento pelo provedor, enviados pela conversa. */
    const val PAYMENTS = "payments"
}

/**
 * Os módulos ligados no servidor para cada área (fila, agenda, ordem de serviço, reserva, mensalidade, pedido). As telas e os
 * atalhos de um módulo só aparecem quando ele está na lista; servidor antigo, módulo desligado ou sem permissão escondem.
 * Consulta no máximo a cada minuto por área; um `409 module_disabled` vindo de qualquer tela esconde o módulo na hora.
 */
class ModuleFeature(private val container: AppContainer) {
    private val _enabled = MutableStateFlow<Map<String, Set<String>>>(emptyMap())
    val enabled: StateFlow<Map<String, Set<String>>> = _enabled.asStateFlow()

    /** O que a pessoa acessa em cada área ([AccessRules]); ausente ou null = tudo. */
    private val _access = MutableStateFlow<Map<String, Set<String>?>>(emptyMap())
    val access: StateFlow<Map<String, Set<String>?>> = _access.asStateFlow()

    /** Os recursos do servidor (`features` de `/capabilities`): `mfa` liga o segundo fator no app. */
    private val _features = MutableStateFlow<Set<String>>(emptySet())
    val features: StateFlow<Set<String>> = _features.asStateFlow()
    private val checkedAt = mutableMapOf<String, Long>()

    fun has(module: String, profileId: String? = container.session.profileId): Boolean =
        profileId != null && _enabled.value[profileId]?.contains(module) == true

    suspend fun refresh(force: Boolean = false) {
        val server = container.session.serverUrl ?: return
        val profile = container.session.profileId ?: return
        val now = System.currentTimeMillis()
        if (!force && now - (checkedAt[profile] ?: 0L) < 60_000) return
        checkedAt[profile] = now
        val probe = QueueAvailabilityProbe(server, profile, { container.session.token })
        val found = probe.modules()
        // Sem rede: fica o que já se sabia, e a próxima consulta tenta de novo.
        if (found == null) {
            checkedAt.remove(profile)
        } else {
            _enabled.update { it + (profile to found) }
            _access.update { it + (profile to probe.access) }
            _features.value = probe.features
        }
    }

    /** `409 module_disabled`: o administrador desligou o módulo; a entrada some até a próxima consulta dizer outra coisa. */
    fun markDisabled(module: String, profileId: String? = container.session.profileId) {
        val profile = profileId ?: return
        _enabled.update { map -> map + (profile to (map[profile].orEmpty() - module)) }
    }

    /**
     * `403 access_denied`: a pessoa perdeu o acesso a algo (acesso por pessoa). A tela some quando a lista relida não
     * trouxer mais o item; relê já.
     */
    fun accessDenied() {
        invalidate()
        container.scope.launch { runCatching { refresh(force = true) } }
    }

    /** Evento `module.changed`: relê na próxima oportunidade. */
    fun invalidate() {
        checkedAt.clear()
    }

    fun clear() {
        checkedAt.clear()
        _enabled.value = emptyMap()
        _access.value = emptyMap()
        _features.value = emptySet()
    }
}
