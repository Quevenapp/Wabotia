package br.com.queven.wabotia.courier

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.queue.queueHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * Tudo o que o modo entregador pede ao servidor. É a única costura com o contrato: quando a sessão O fechar as rotas,
 * muda só [HttpCourierBackend] (e os `@SerialName` de CourierModels.kt).
 */
interface CourierBackend {
    /** Troca o código do QR pela credencial desta entrega. */
    suspend fun claim(link: CourierLink): Pair<CourierSession, CourierDelivery>

    suspend fun delivery(session: CourierSession): CourierDelivery

    /** Lote de posições (até 200) e a bateria; `active: false` encerra. */
    suspend fun positions(session: CourierSession, points: List<PositionPoint>, battery: Int?): PositionsReply

    suspend fun messages(session: CourierSession, party: CourierParty): List<CourierMessage>

    suspend fun send(session: CourierSession, party: CourierParty, text: String): CourierMessage

    /** "Entreguei". O servidor conclui e revoga o acesso. */
    suspend fun delivered(session: CourierSession)
}

/** Falha que a tela mostra ("sem rede", "código vencido"); [CourierRevoked] é tratada à parte. */
class CourierFailure(message: String, val status: Int = 0) : Exception(message)

/**
 * A ligação HTTP, com nomes **provisórios** (o contrato do entregador sem login ainda não existe). Escolhas para a
 * sessão O confirmar ou trocar:
 * - `POST /api/courier/claim {code}` → `{token, delivery}`; a credencial vai em `Authorization: Bearer`.
 * - `GET /api/courier/deliveries/{id}`, `POST …/positions {points, battery}`, `GET|POST …/messages?party=store|customer`,
 *   `POST …/delivered`.
 * - 401, 403 e 410 = acesso revogado; o app esquece a entrega e, sem nenhuma, volta à primeira tela.
 */
class HttpCourierBackend(private val http: OkHttpClient = queueHttp()) : CourierBackend {
    @Serializable private data class ClaimBody(val code: String)
    @Serializable private data class ClaimReply(val token: String, val delivery: CourierDelivery)
    @Serializable private data class PositionsBody(val points: List<PositionPoint>, val battery: Int? = null)
    @Serializable private data class SendBody(val text: String)

    override suspend fun claim(link: CourierLink): Pair<CourierSession, CourierDelivery> {
        val reply = call(link.server, null, "POST", "/api/courier/claim", WabotiaJson.encodeToString(ClaimBody.serializer(), ClaimBody(link.code)), ClaimReply.serializer())
        return CourierSession(link.server, reply.token, reply.delivery.id) to reply.delivery
    }

    override suspend fun delivery(session: CourierSession): CourierDelivery =
        call(session.server, session.token, "GET", path(session), null, CourierDelivery.serializer())

    override suspend fun positions(session: CourierSession, points: List<PositionPoint>, battery: Int?): PositionsReply =
        call(session.server, session.token, "POST", path(session) + "/positions", WabotiaJson.encodeToString(PositionsBody.serializer(), PositionsBody(points, battery)), PositionsReply.serializer())

    override suspend fun messages(session: CourierSession, party: CourierParty): List<CourierMessage> =
        call(session.server, session.token, "GET", path(session) + "/messages?party=${party.wire}", null, ListSerializer(CourierMessage.serializer()))

    override suspend fun send(session: CourierSession, party: CourierParty, text: String): CourierMessage =
        call(session.server, session.token, "POST", path(session) + "/messages?party=${party.wire}", WabotiaJson.encodeToString(SendBody.serializer(), SendBody(text)), CourierMessage.serializer())

    override suspend fun delivered(session: CourierSession) {
        call(session.server, session.token, "POST", path(session) + "/delivered", "{}", JsonObject.serializer())
    }

    private fun path(session: CourierSession) = "/api/courier/deliveries/${session.deliveryId}"

    private suspend fun <T> call(server: String, token: String?, method: String, path: String, body: String?, serializer: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(server.trimEnd('/') + path)
                .header("Accept", "application/json")
                .apply { token?.let { header("Authorization", "Bearer $it") } }
                .method(method, body?.toRequestBody("application/json".toMediaType()))
                .build()
            val response = try {
                http.newCall(request).execute()
            } catch (e: IOException) {
                throw CourierFailure("Sem conexão com a loja. A posição fica guardada e vai quando a rede voltar.")
            }
            response.use {
                val text = it.body?.string().orEmpty()
                if (it.code == 401 || it.code == 403 || it.code == 410) throw CourierRevoked()
                if (!it.isSuccessful) throw CourierFailure(errorMessage(text) ?: "A loja não respondeu (${it.code}).", it.code)
                // Respostas no envelope `{data: …}` ou cruas.
                val element = WabotiaJson.parseToJsonElement(text.ifBlank { "{}" })
                val payload = (element as? JsonObject)?.get("data") ?: element
                WabotiaJson.decodeFromJsonElement(serializer, payload)
            }
        }

    private fun errorMessage(text: String): String? = runCatching {
        WabotiaJson.parseToJsonElement(text).jsonObject["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
    }.getOrNull()
}
