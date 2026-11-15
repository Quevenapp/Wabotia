package br.com.queven.wabotia.queue

import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.demo.DemoMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Recusa do Wabotia na fila, com o código do contrato (`queue_empty`, `kiosk_rate`, `invalid_transition`…). */
class QueueException(val status: Int, val code: String, message: String) : Exception(message) {
    /** Falha de rede ou servidor fora do ar: repetir com a mesma `Idempotency-Key` é seguro. */
    val retryable: Boolean get() = status == 0 || status == 408 || status >= 500 || code == "operation_unknown"

    /** A credencial não vale mais (aparelho revogado ou sessão da pessoa encerrada). */
    val unauthorized: Boolean get() = status == 401

    companion object {
        const val NETWORK = "network"
    }
}

private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

/**
 * O HTTP da fila: tempos curtos (o totem não pode travar), ping no WebSocket e o interceptor da demonstração, para o
 * guichê e o modo aparelho abrirem sem servidor real (`demo.wabotia.localhost` nunca sai do aparelho).
 */
fun queueHttp(): OkHttpClient =
    OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .addInterceptor(DemoMode.interceptor)
        .build()

/** O endereço da instalação sem barra no fim; aceita "wabotia.minhaempresa.com.br" sem https. */
fun normalizeBaseUrl(value: String): String {
    val trimmed = value.trim().trimEnd('/')
    return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "https://$trimmed"
}

/**
 * O cliente da fila de uma área (`/api/v1/profiles/{p}/queue`). O token vem de quem usa: o do aparelho pareado
 * (`wab_…`) ou o da pessoa logada (`wabu_…`). Toda escrita leva `Idempotency-Key`; quem repete depois de uma queda de
 * rede passa a mesma chave e o Wabotia devolve a mesma resposta (nunca duas senhas, nunca duas chamadas).
 */
class QueueClient(
    baseUrl: String,
    val profileId: String,
    private val token: () -> String?,
    private val http: OkHttpClient = queueHttp(),
) {
    private val root = normalizeBaseUrl(baseUrl) + "/api/v1/profiles/$profileId"

    suspend fun overview(): QueueOverview = get("/queue", QueueOverview.serializer())

    suspend fun ticket(ticketId: String): QueueTicket = get("/queue/tickets/$ticketId", QueueTicket.serializer())

    /** Emite uma senha (totem: `source` omitido vira `kiosk` no servidor pareado; equipe manda `staff`). */
    suspend fun issue(queueId: String, preferential: Boolean, key: String = newKey(), source: String? = null): QueueTicket =
        post(
            "/queue/tickets",
            body("queue_id" to queueId, "preferential" to preferential, "source" to source),
            key,
            QueueTicket.serializer(),
        )

    /** `open`, `paused` ou `closed`. */
    suspend fun counterState(counterId: String, status: String, key: String = newKey()): JsonObject =
        post("/queue/counters/$counterId/state", body("status" to status), key, JsonObject.serializer())

    /** A próxima senha deste guichê; `404 queue_empty` quando não há ninguém. */
    suspend fun callNext(counterId: String, key: String = newKey()): QueueTicket =
        post("/queue/counters/$counterId/call-next", body(), key, QueueTicket.serializer())

    /** `recall`, `start`, `finish`, `no-show` ou `cancel`. */
    suspend fun ticketAction(ticketId: String, action: String, key: String = newKey()): QueueTicket {
        require(action in TICKET_ACTIONS) { "Ação desconhecida: $action" }
        return post("/queue/tickets/$ticketId/$action", body(), key, QueueTicket.serializer())
    }

    /** Para outra fila (`queue_id`) ou outro guichê (`counter_id`), mantendo a ordem de emissão. */
    suspend fun transfer(ticketId: String, queueId: String? = null, counterId: String? = null, key: String = newKey()): QueueTicket {
        require((queueId == null) != (counterId == null)) { "Escolha uma fila ou um guichê." }
        return post("/queue/tickets/$ticketId/transfer", body("queue_id" to queueId, "counter_id" to counterId), key, QueueTicket.serializer())
    }

    /** O WebSocket da fila (`snapshot`, `call`, `pong`); quem chama reconecta. */
    fun socket(listener: WebSocketListener): WebSocket =
        http.newWebSocket(
            Request.Builder()
                .url(root.replaceFirst("http", "ws") + "/queue/ws")
                .withAuth(token())
                .build(),
            listener,
        )

    private suspend fun <T> get(path: String, serializer: kotlinx.serialization.KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            execute(http, Request.Builder().url(root + path).withAuth(token()).get().build()) {
                WabotiaJson.decodeFromString(serializer, it)
            }
        }

    private suspend fun <T> post(path: String, json: JsonObject, key: String, serializer: kotlinx.serialization.KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(root + path)
                .withAuth(token())
                .header("Idempotency-Key", key)
                .post(json.toString().toRequestBody(JSON_TYPE))
                .build()
            execute(http, request) { WabotiaJson.decodeFromString(serializer, it) }
        }

    companion object {
        val TICKET_ACTIONS = setOf("recall", "start", "finish", "no-show", "cancel")

        /** Chave nova por intenção (toque); repetir a mesma intenção reutiliza a chave. */
        fun newKey(): String = "wabotia-" + UUID.randomUUID()
    }
}

/** O pareamento por código (RFC 8628, docs/PAREAMENTO.md) com `client=senhapp`, usado pelo modo aparelho. */
class QueuePairing(private val http: OkHttpClient = queueHttp()) {
    /**
     * Pede o código. `scopes` diz ao administrador o que o aparelho precisa (ler e emitir); o servidor de hoje ignora o
     * campo e quem decide as permissões continua sendo quem aprova no painel.
     */
    suspend fun start(baseUrl: String, instanceName: String, scopes: List<String> = DeviceScopes.requested): PairingStart =
        withContext(Dispatchers.IO) {
            val json = JsonObject(
                mapOf(
                    "client" to JsonPrimitive(CLIENT),
                    "instance_name" to JsonPrimitive(instanceName.trim()),
                    "scopes" to kotlinx.serialization.json.JsonArray(scopes.map(::JsonPrimitive)),
                ),
            )
            val request = Request.Builder().url(normalizeBaseUrl(baseUrl) + "/api/pairing/start").withAuth(null)
                .post(json.toString().toRequestBody(JSON_TYPE)).build()
            execute(http, request) { WabotiaJson.decodeFromString(PairingStart.serializer(), it) }
        }

    /** `authorization_pending` enquanto o administrador não aprova; `slow_down` pede mais intervalo. */
    suspend fun poll(baseUrl: String, deviceCode: String): PairingToken =
        withContext(Dispatchers.IO) {
            val json = JsonObject(mapOf("client" to JsonPrimitive(CLIENT), "device_code" to JsonPrimitive(deviceCode)))
            val request = Request.Builder().url(normalizeBaseUrl(baseUrl) + "/api/pairing/token").withAuth(null)
                .post(json.toString().toRequestBody(JSON_TYPE)).build()
            execute(http, request) { WabotiaJson.decodeFromString(PairingToken.serializer(), it) }
        }

    /** Desfaz o vínculo no servidor (`POST /api/v1/pairings/disconnect` com a própria credencial). */
    suspend fun disconnect(baseUrl: String, token: String) {
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(normalizeBaseUrl(baseUrl) + "/api/v1/pairings/disconnect").withAuth(token)
                .header("Idempotency-Key", QueueClient.newKey())
                .post("{}".toRequestBody(JSON_TYPE)).build()
            execute(http, request) { }
        }
    }

    companion object {
        const val CLIENT = "senhapp"
    }
}

private fun Request.Builder.withAuth(token: String?): Request.Builder =
    header("Accept", "application/json")
        .header("User-Agent", "Wabotia-Android/${BuildConfig.VERSION_NAME}")
        .apply { if (!token.isNullOrBlank()) header("Authorization", "Bearer $token") }

private fun body(vararg pairs: Pair<String, Any?>): JsonObject =
    JsonObject(
        pairs.mapNotNull { (k, v) ->
            when (v) {
                null -> null
                is String -> k to JsonPrimitive(v)
                is Boolean -> k to JsonPrimitive(v)
                is Number -> k to JsonPrimitive(v)
                else -> k to JsonPrimitive(v.toString())
            }
        }.toMap(),
    )

/** Executa e traduz o erro do contrato (`{error:{code,message}}`) em [QueueException]. */
internal fun <T> execute(http: OkHttpClient, request: Request, parse: (String) -> T): T {
    val response = try {
        http.newCall(request).execute()
    } catch (e: IOException) {
        throw QueueException(0, QueueException.NETWORK, "Sem conexão com o Wabotia.")
    }
    response.use {
        val text = it.body?.string().orEmpty()
        if (!it.isSuccessful) {
            val error = runCatching { WabotiaJson.parseToJsonElement(text).jsonObject["error"]?.jsonObject }.getOrNull()
            throw QueueException(
                it.code,
                error?.get("code")?.jsonPrimitive?.contentOrNull ?: "http_${it.code}",
                error?.get("message")?.jsonPrimitive?.contentOrNull ?: when (it.code) {
                    401 -> "A credencial não vale mais. Conecte de novo."
                    403 -> "Sem permissão para esta ação na fila."
                    else -> "O Wabotia recusou (${it.code})."
                },
            )
        }
        return try {
            parse(text)
        } catch (e: Exception) {
            throw QueueException(it.code, "invalid_response", "Resposta inesperada do Wabotia.")
        }
    }
}

/** Um quadro do WebSocket: `snapshot`, `call` ou `pong`. */
sealed interface QueueFrame {
    data class Snapshot(val overview: QueueOverview) : QueueFrame

    data class Call(val call: CallFrame) : QueueFrame

    data object Pong : QueueFrame

    companion object {
        fun parse(text: String): QueueFrame? {
            val json = runCatching { WabotiaJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
            val data = json["data"]
            return runCatching {
                when ((json["type"] as? JsonPrimitive)?.contentOrNull) {
                    "snapshot" -> Snapshot(WabotiaJson.decodeFromJsonElement(QueueOverview.serializer(), data!!))
                    "call" -> Call(WabotiaJson.decodeFromJsonElement(CallFrame.serializer(), data!!))
                    "pong" -> Pong
                    else -> null
                }
            }.getOrNull()
        }
    }
}
