package br.com.queven.wabotia.core

import br.com.queven.wabotia.queue.QueueAvailabilityProbe
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

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
    /** ERP (Gestão): a parte Cadastros; as outras partes são `erp-produtos`, `erp-vendas`… (src/erp/parts.ts). */
    const val ERP = "erp"
}

/**
 * Os módulos ligados no servidor para cada área (fila, agenda, ordem de serviço, reserva, mensalidade, pedido). As telas e os
 * atalhos de um módulo só aparecem quando ele está na lista; servidor antigo, módulo desligado ou sem permissão escondem.
 * Consulta no máximo a cada minuto por área; um `409 module_disabled` vindo de qualquer tela esconde o módulo na hora.
 */
class ModuleFeature(private val container: AppContainer) {
    private val _enabled = MutableStateFlow<Map<String, Set<String>>>(emptyMap())
    val enabled: StateFlow<Map<String, Set<String>>> = _enabled.asStateFlow()
    private val checkedAt = mutableMapOf<String, Long>()

    /** Papéis da pessoa nos módulos ligados, por área (`erp:vendas`, `os:technician`…). */
    private val _grants = MutableStateFlow<Map<String, Set<String>>>(emptyMap())
    val grants: StateFlow<Map<String, Set<String>>> = _grants.asStateFlow()

    /**
     * Papel atual da pessoa segundo o servidor (`actor.role` das capacidades), por área. Mais novo que o papel gravado no
     * login: quem virou administrador depois de entrar já vê a Gestão e as opções de administrador.
     */
    private val _roles = MutableStateFlow<Map<String, String>>(emptyMap())
    val roles: StateFlow<Map<String, String>> = _roles.asStateFlow()

    fun has(module: String, profileId: String? = container.session.profileId): Boolean =
        profileId != null && _enabled.value[profileId]?.contains(module) == true

    suspend fun refresh(force: Boolean = false) {
        val server = container.session.serverUrl ?: return
        val profile = container.session.profileId ?: return
        val now = System.currentTimeMillis()
        if (!force && now - (checkedAt[profile] ?: 0L) < 60_000) return
        checkedAt[profile] = now
        val found = QueueAvailabilityProbe(server, profile, { container.session.token }).snapshot()
        // Sem rede: fica o que já se sabia, e a próxima consulta tenta de novo.
        if (found == null) {
            checkedAt.remove(profile)
        } else {
            _enabled.update { it + (profile to found.modules) }
            _grants.update { it + (profile to found.grants) }
            found.role?.let { role -> _roles.update { it + (profile to role) } }
        }
    }

    /** `409 module_disabled`: o administrador desligou o módulo; a entrada some até a próxima consulta dizer outra coisa. */
    fun markDisabled(module: String, profileId: String? = container.session.profileId) {
        val profile = profileId ?: return
        _enabled.update { map -> map + (profile to (map[profile].orEmpty() - module)) }
    }

    /** Evento `module.changed`: relê na próxima oportunidade. */
    fun invalidate() {
        checkedAt.clear()
    }

    fun clear() {
        checkedAt.clear()
        _enabled.value = emptyMap()
        _grants.value = emptyMap()
        _roles.value = emptyMap()
    }
}

/** Quem é administrador: o papel atual que o servidor mandou ([serverRole]) vale mais que o gravado no login. */
object AdminRole {
    fun isAdmin(serverRole: String?, sessionRole: String?): Boolean = (serverRole?.takeIf { it.isNotBlank() } ?: sessionRole) == "admin"
}
