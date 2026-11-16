package br.com.queven.wabotia.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * O que esta pessoa acessa ("só caixa", "só garçom"). Vem de `GET /capabilities` quando o servidor ganhar o acesso por
 * usuário (sessão A); o contrato ainda não fechou, então os nomes de campo e os ids estão só aqui. Sem lista, a pessoa
 * vê tudo, como antes. A barra inferior e as telas se montam a partir de [AccessRules].
 */
object AccessIds {
    const val CONVERSATIONS = "conversations"
    const val TICKETS = "tickets"
    const val TEAM = "team"
    const val CALLS = "calls"
    /** Linhas de atendimento, menus e linhas dos bots. */
    const val LINES = "lines"
    /** Caixa (módulo novo, sessão N): ainda sem tela no app. */
    const val CAIXA = "caixa"
    /** Garçom: mesas e comandas, sobre o Pedido (sessão F). */
    const val GARCOM = "garcom"

    /** Papéis que abrem um módulo existente: o garçom trabalha no Pedido; o guichê é a fila. */
    val MODULE_ALIASES = mapOf(GARCOM to ModuleIds.PEDIDO, "guiche" to ModuleIds.QUEUE, "fila" to ModuleIds.QUEUE)
}

/** O que a barra inferior mostra; Ajustes sempre (é por onde a pessoa sai da conta). */
enum class AccessTab { CONVERSATIONS, SERVICE, TEAM, CALLS, SETTINGS }

object AccessRules {
    /**
     * A lista da pessoa na resposta de capacidades: `access` na área pedida (`profiles[].access`), no topo, em `user` ou
     * dentro de `data`. `null` (campo ausente ou nulo) é acesso a tudo.
     */
    fun parse(json: JsonElement, profileId: String? = null): Set<String>? {
        val root = json as? JsonObject ?: return null
        val profile = (root["profiles"] as? JsonArray)?.firstOrNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull == profileId } as? JsonObject
        val value = profile?.get("access")?.takeUnless { it is JsonNull }
            ?: root["access"]?.takeUnless { it is JsonNull }
            ?: (root["user"] as? JsonObject)?.get("access")?.takeUnless { it is JsonNull }
            ?: ((root["data"] as? JsonObject)?.let { return parse(it, profileId) })
            ?: return null
        val list = value as? JsonArray ?: return null
        return list.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.lowercase()?.takeIf(String::isNotEmpty) }.toSet()
    }

    fun allows(access: Set<String>?, id: String): Boolean = access == null || id in access

    /** Módulos que a pessoa pode abrir, entre os ligados na área. */
    fun modules(access: Set<String>?, enabled: Set<String>): Set<String> {
        if (access == null) return enabled
        val wanted = access.map { AccessIds.MODULE_ALIASES[it] ?: it }.toSet()
        return enabled.filterTo(mutableSetOf()) { it in wanted }
    }

    /** As abas, na ordem da barra. A aba Atendimento aparece quando há protocolos, linhas ou algum módulo para abrir. */
    fun tabs(access: Set<String>?, enabledModules: Set<String>): List<AccessTab> = buildList {
        if (allows(access, AccessIds.CONVERSATIONS)) add(AccessTab.CONVERSATIONS)
        val service = access == null || AccessIds.TICKETS in access || AccessIds.LINES in access ||
            modules(access, enabledModules).isNotEmpty() || unavailable(access).isNotEmpty()
        if (service) add(AccessTab.SERVICE)
        if (allows(access, AccessIds.TEAM)) add(AccessTab.TEAM)
        if (allows(access, AccessIds.CALLS)) add(AccessTab.CALLS)
        add(AccessTab.SETTINGS)
    }

    /** Papéis da lista que o app ainda não tem tela (ex.: caixa): a aba Atendimento avisa em vez de ficar vazia. */
    fun unavailable(access: Set<String>?): List<String> =
        access.orEmpty().filter { it == AccessIds.CAIXA }

    fun label(id: String) = when (id) {
        AccessIds.CAIXA -> "Caixa"
        AccessIds.GARCOM -> "Garçom"
        else -> id.replaceFirstChar { it.uppercase() }
    }
}
