package br.com.queven.wabotia.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * O que a pessoa logada acessa em cada área (docs/API.md, "Acesso por pessoa"; recurso `person_access`). Cada item de
 * `profiles` em `/capabilities` traz `access`, já expandido e só com módulos ligados: áreas do atendimento
 * (`conversations`, `tickets`, `contacts`, `calls`, `team`, `reports`), módulos (`os`, `pedido`…) e papéis de módulo
 * (`os:technician`, `mesas:waiter`, `entrega:courier`, `caixa:cashier`). `null` (aparelho, aplicação, servidor antigo):
 * vale `modules`, como antes. `["*"]` é o atendente completo: tudo, menos os papéis.
 */
object AccessIds {
    const val ALL = "*"
    const val CONVERSATIONS = "conversations"
    const val TICKETS = "tickets"
    const val CONTACTS = "contacts"
    const val CALLS = "calls"
    const val TEAM = "team"
    const val REPORTS = "reports"

    val CORE = setOf(CONVERSATIONS, TICKETS, CONTACTS, CALLS, TEAM, REPORTS)
}

/** O que a barra inferior mostra; Ajustes sempre (é por onde a pessoa sai da conta). */
enum class AccessTab { CONVERSATIONS, SERVICE, TEAM, CALLS, SETTINGS }

object AccessRules {
    /** Módulos que já têm tela no app (o resto aparece como aviso na aba Atendimento). */
    private val APP_MODULES = setOf(
        ModuleIds.QUEUE, ModuleIds.AGENDA, ModuleIds.SERVICE_ORDERS, ModuleIds.RESERVA, ModuleIds.MENSALIDADE, ModuleIds.PEDIDO,
    )

    /** O nome do papel na tela. */
    private val ROLE_LABELS = mapOf(
        "entrega:courier" to "Entregador",
        "mesas:waiter" to "Garçom",
        "os:technician" to "Técnico",
        "caixa:cashier" to "Caixa",
    )

    /** `profiles[].access` da área pedida; ausente ou `null` = sem lista (vale `modules`). */
    fun parse(json: JsonElement, profileId: String? = null): Set<String>? {
        val root = json as? JsonObject ?: return null
        val profiles = (root["profiles"] as? JsonArray) ?: ((root["data"] as? JsonObject)?.get("profiles") as? JsonArray) ?: return null
        val profile = profiles.firstOrNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull == profileId } as? JsonObject
            ?: return null
        val list = profile["access"] as? JsonArray ?: return null
        return list.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }.toSet()
    }

    private fun full(access: Set<String>?) = access == null || AccessIds.ALL in access

    /** A pessoa acessa este item (área do atendimento ou módulo)? Sem lista ou com `*`, sim. */
    fun allows(access: Set<String>?, id: String): Boolean = full(access) || id in access.orEmpty()

    /** Módulos que a pessoa pode abrir, entre os ligados na área (um papel `os:technician` também abre o módulo). */
    fun modules(access: Set<String>?, enabled: Set<String>): Set<String> {
        if (full(access)) return enabled
        val wanted = access.orEmpty().map { it.substringBefore(':') }.toSet()
        return enabled.filterTo(mutableSetOf()) { it in wanted }
    }

    /** As abas, na ordem da barra. Atendimento aparece com protocolos, conversas (linhas e menus), módulos ou papéis. */
    fun tabs(access: Set<String>?, enabledModules: Set<String>): List<AccessTab> = buildList {
        if (allows(access, AccessIds.CONVERSATIONS)) add(AccessTab.CONVERSATIONS)
        val service = full(access) || allows(access, AccessIds.TICKETS) || allows(access, AccessIds.CONVERSATIONS) ||
            modules(access, enabledModules).any { it in APP_MODULES } || unavailable(access).isNotEmpty()
        if (service) add(AccessTab.SERVICE)
        if (allows(access, AccessIds.TEAM)) add(AccessTab.TEAM)
        if (allows(access, AccessIds.CALLS)) add(AccessTab.CALLS)
        add(AccessTab.SETTINGS)
    }

    /**
     * Papéis e módulos da lista que o app ainda não tem tela (garçom, caixa, entregador com login): a aba Atendimento
     * avisa em vez de ficar vazia. O técnico usa a tela da Ordem de serviço, que já existe.
     */
    fun unavailable(access: Set<String>?): List<String> =
        access.orEmpty().filter { ':' in it && it.substringBefore(':') !in APP_MODULES }.sorted()

    fun label(id: String) = ROLE_LABELS[id] ?: id.substringBefore(':').replaceFirstChar { it.uppercase() }
}
