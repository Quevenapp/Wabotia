package br.com.queven.wabotia.queue

import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/** O servidor oferece a fila de senhas a esta área? */
enum class QueueAvailability { AVAILABLE, UNAVAILABLE, UNKNOWN }

/**
 * Lê a lista de módulos ativos da rota de capacidades (servidor com registro de módulos, docs/MODULOS.md). Tolerante ao
 * formato enquanto o contrato não fecha: `modules` como lista de objetos (`{id, enabled?, version?}`), lista de ids ou
 * mapa `{id: {...}}`, no topo da resposta ou dentro de `data`. `null` quando a resposta não diz nada sobre módulos.
 */
object ModuleCapabilities {
    /** Ids aceitos para a fila presencial. */
    val QUEUE_IDS = setOf("queue", "fila", "queue_tickets")

    fun hasModule(json: JsonElement, ids: Set<String> = QUEUE_IDS): Boolean? {
        val root = json as? JsonObject ?: return null
        val modules = root["modules"] ?: (root["data"] as? JsonObject)?.get("modules") ?: return null
        return when (modules) {
            is JsonArray -> modules.any { entry ->
                when (entry) {
                    is JsonPrimitive -> entry.contentOrNull in ids
                    is JsonObject -> (entry["id"] as? JsonPrimitive)?.contentOrNull in ids && entry.enabledFlag()
                    else -> false
                }
            }
            is JsonObject -> modules.entries.any { (id, value) -> id in ids && ((value as? JsonObject)?.enabledFlag() ?: (value as? JsonPrimitive)?.booleanOrNull ?: true) }
            else -> null
        }
    }

    /**
     * Os ids dos módulos ligados (docs/MODULOS.md, seção 6): `profiles[].modules` da área pedida ou, sem ela, `modules`
     * no topo (a rota por área) ou dentro de `data`. `null` quando a resposta não fala de módulos.
     */
    fun enabledModules(json: JsonElement, profileId: String? = null): Set<String>? {
        val root = json as? JsonObject ?: return null
        val profiles = root["profiles"] as? JsonArray
        val profile = profiles?.firstOrNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull == profileId } as? JsonObject
        val modules = profile?.get("modules") ?: root["modules"] ?: (root["data"] as? JsonObject)?.get("modules") ?: return null
        val ids = when (modules) {
            is JsonArray -> modules.mapNotNull { entry ->
                when (entry) {
                    is JsonPrimitive -> entry.contentOrNull
                    is JsonObject -> (entry["id"] as? JsonPrimitive)?.contentOrNull?.takeIf { entry.enabledFlag() }
                    else -> null
                }
            }
            is JsonObject -> modules.entries.filter { (_, value) -> (value as? JsonObject)?.enabledFlag() ?: (value as? JsonPrimitive)?.booleanOrNull ?: true }.map { it.key }
            else -> return null
        }
        // A fila já teve outros nomes nas versões de teste do contrato.
        return ids.map { if (it in QUEUE_IDS) "queue" else it }.toSet()
    }

    /**
     * Os papéis da pessoa nos módulos ligados (`profiles[].grants` da área, como `erp:vendas` e `os:technician`). Servidor
     * antigo ou aplicação: vazio.
     */
    fun grants(json: JsonElement, profileId: String? = null): Set<String> {
        val root = json as? JsonObject ?: return emptySet()
        val profiles = root["profiles"] as? JsonArray
        val profile = profiles?.firstOrNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull == profileId } as? JsonObject
            ?: profiles?.singleOrNull() as? JsonObject
        val list = (profile?.get("grants") ?: root["grants"]) as? JsonArray ?: return emptySet()
        return list.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.toSet()
    }

    private fun JsonObject.enabledFlag(): Boolean {
        val flag = (this["enabled"] ?: this["active"]) as? JsonPrimitive ?: return true
        return flag.booleanOrNull ?: (flag.contentOrNull?.toLongOrNull()?.let { it != 0L } ?: true)
    }
}

/**
 * Decide se a fila aparece no app. Primeiro a rota de capacidades que a sessão do núcleo está criando
 * (`GET /api/v1/profiles/{p}/capabilities`, depois `GET /api/v1/capabilities?profile_id=`); enquanto nenhuma delas
 * existir (404/405/501) ou não falar de módulos, `GET /queue` é o sinal: 200 é fila disponível, recusa é indisponível.
 * Falha de rede é [QueueAvailability.UNKNOWN] e quem chama mantém o que sabia.
 */
class QueueAvailabilityProbe(
    baseUrl: String,
    private val profileId: String,
    private val token: () -> String?,
    private val http: OkHttpClient = queueHttp(),
) {
    private val base = normalizeBaseUrl(baseUrl)

    suspend fun check(): QueueAvailability =
        when (val found = modules()) {
            null -> QueueAvailability.UNKNOWN
            else -> if ("queue" in found) QueueAvailability.AVAILABLE else QueueAvailability.UNAVAILABLE
        }

    /**
     * Os módulos ligados nesta área; `null` sem resposta (rede, 5xx: quem chama mantém o que sabia). Servidor sem rota de
     * capacidades: só a fila pode aparecer, se `GET /queue` responder.
     */
    suspend fun modules(): Set<String>? = snapshot()?.modules

    /** Módulos ligados e papéis da pessoa na área ([ModuleCapabilities.grants]); `null` sem resposta. */
    data class Snapshot(val modules: Set<String>, val grants: Set<String>)

    suspend fun snapshot(): Snapshot? = withContext(Dispatchers.IO) {
        for (path in listOf("/api/v1/profiles/$profileId/capabilities", "/api/v1/capabilities?profile_id=$profileId")) {
            when (val answer = get(path)) {
                is Answer.Ok -> ModuleCapabilities.enabledModules(answer.json, profileId)?.let {
                    return@withContext Snapshot(it, ModuleCapabilities.grants(answer.json, profileId))
                }
                is Answer.Failed -> if (answer.status == 0) return@withContext null
                // 401 da pessoa: a sessão caiu; a tela que chamou cuida disso na próxima chamada da API.
            }
        }
        when (val answer = get("/api/v1/profiles/$profileId/queue")) {
            is Answer.Ok -> Snapshot(setOf("queue"), emptySet())
            is Answer.Failed -> when {
                answer.status == 0 || answer.status >= 500 || answer.status == 429 -> null
                else -> Snapshot(emptySet(), emptySet())
            }
        }
    }

    private sealed interface Answer {
        data class Ok(val json: JsonElement) : Answer
        data class Failed(val status: Int) : Answer
    }

    private fun get(path: String): Answer {
        val request = Request.Builder()
            .url(base + path)
            .header("Accept", "application/json")
            .apply { token()?.takeIf { it.isNotBlank() }?.let { header("Authorization", "Bearer $it") } }
            .get()
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return Answer.Failed(response.code)
                val text = response.body?.string().orEmpty()
                Answer.Ok(runCatching { WabotiaJson.parseToJsonElement(text) }.getOrElse { JsonObject(emptyMap()) })
            }
        } catch (e: IOException) {
            Answer.Failed(0)
        }
    }
}
