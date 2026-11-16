package br.com.queven.wabotia.courier

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.queue.queueHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.UUID

/** Tudo o que o modo entregador pede ao servidor. É a única costura com o contrato. */
interface CourierBackend {
    /** Troca o QR pela credencial da entrega; [name] é o nome que o cliente vê ("Carlos - Entregador"). */
    suspend fun claim(link: CourierLink, name: String, device: String): Pair<CourierSession, CourierDelivery>

    suspend fun delivery(session: CourierSession): CourierDelivery

    /** Iniciar rota, com o destino geocodificado no aparelho quando houver. Devolve o ritmo. */
    suspend fun start(session: CourierSession, destination: LatLng?): CourierPace?

    /** Lote de posições (até 200) e a bateria, sem Idempotency-Key. */
    suspend fun positions(session: CourierSession, points: List<PositionPoint>, battery: Int?): PositionsReply

    suspend fun messages(session: CourierSession, after: Long): CourierMessagesPage

    suspend fun send(session: CourierSession, party: CourierParty, text: String)

    suspend fun delivered(session: CourierSession, note: String?)

    suspend fun cancel(session: CourierSession, reason: String)
}

/** Falha que a tela mostra ("sem rede", "QR já usado"); [code] é o código do servidor (`window_closed`…). */
class CourierFailure(message: String, val status: Int = 0, val code: String? = null) : Exception(message)

/**
 * A ligação HTTP (docs/API.md, "Entrega"): a troca do QR em `POST /api/credentials/claim`; o resto em
 * `/api/v1/profiles/{área}/entrega/deliveries/{id}/…` com `Authorization: Bearer wabx_…`. Escritas levam
 * `Idempotency-Key`, menos o lote de posições. `401` = revogada.
 */
class HttpCourierBackend(private val http: OkHttpClient = queueHttp()) : CourierBackend {
    @Serializable private data class ClaimBody(val code: String, val name: String, val device: String)
    @Serializable private data class ClaimData(val delivery: CourierDelivery, val app: CourierPace? = null)
    @Serializable private data class ClaimReply(
        val token: String,
        @kotlinx.serialization.SerialName("expires_at") val expiresAt: Long? = null,
        val profile: String,
        val subject: String,
        val data: ClaimData,
    )
    @Serializable private data class StartBody(val destination: LatLng? = null)
    @Serializable private data class StartReply(val app: CourierPace? = null)
    @Serializable private data class PositionsBody(val points: List<PositionPoint>, val battery: Int? = null)
    @Serializable private data class SendBody(val channel: String, val text: String)
    @Serializable private data class NoteBody(val note: String? = null)
    @Serializable private data class ReasonBody(val reason: String)

    override suspend fun claim(link: CourierLink, name: String, device: String): Pair<CourierSession, CourierDelivery> {
        val body = json(ClaimBody.serializer(), ClaimBody(link.code, name, device))
        val reply = call(link.server + "/api/credentials/claim", null, "POST", body, idempotent = false, ClaimReply.serializer(), claim = true)
        val delivery = reply.data.delivery.let { d -> if (d.app == null && reply.data.app != null) d.copy(app = reply.data.app) else d }
        return CourierSession(link.server, reply.token, reply.profile, reply.subject, reply.expiresAt) to delivery
    }

    override suspend fun delivery(session: CourierSession): CourierDelivery =
        call(url(session, "/courier"), session.token, "GET", null, false, CourierDelivery.serializer())

    override suspend fun start(session: CourierSession, destination: LatLng?): CourierPace? =
        call(url(session, "/start"), session.token, "POST", json(StartBody.serializer(), StartBody(destination)), true, StartReply.serializer()).app

    override suspend fun positions(session: CourierSession, points: List<PositionPoint>, battery: Int?): PositionsReply =
        call(url(session, "/positions"), session.token, "POST", json(PositionsBody.serializer(), PositionsBody(points, battery)), false, PositionsReply.serializer())

    override suspend fun messages(session: CourierSession, after: Long): CourierMessagesPage =
        call(url(session, "/messages?after=$after"), session.token, "GET", null, false, CourierMessagesPage.serializer())

    override suspend fun send(session: CourierSession, party: CourierParty, text: String) {
        call(url(session, "/messages"), session.token, "POST", json(SendBody.serializer(), SendBody(party.wire, text)), true, JsonObject.serializer())
    }

    override suspend fun delivered(session: CourierSession, note: String?) {
        call(url(session, "/delivered"), session.token, "POST", json(NoteBody.serializer(), NoteBody(note)), true, JsonObject.serializer())
    }

    override suspend fun cancel(session: CourierSession, reason: String) {
        call(url(session, "/cancel"), session.token, "POST", json(ReasonBody.serializer(), ReasonBody(reason)), true, JsonObject.serializer())
    }

    private fun url(session: CourierSession, suffix: String) =
        session.server.trimEnd('/') + "/api/v1/profiles/${session.profile}/entrega/deliveries/${session.deliveryId}" + suffix

    private fun <T> json(serializer: KSerializer<T>, value: T) = WabotiaJson.encodeToString(serializer, value)

    private suspend fun <T> call(
        url: String,
        token: String?,
        method: String,
        body: String?,
        idempotent: Boolean,
        serializer: KSerializer<T>,
        claim: Boolean = false,
    ): T = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .apply { token?.let { header("Authorization", "Bearer $it") } }
            .apply { if (idempotent) header("Idempotency-Key", "courier-${UUID.randomUUID()}") }
            .method(method, body?.toRequestBody("application/json".toMediaType()))
            .build()
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw CourierFailure("Sem conexão com a loja. A posição fica guardada e vai quando a rede voltar.")
        }
        response.use {
            val text = it.body?.string().orEmpty()
            // Na troca do QR não há credencial: 401 ali seria outra coisa, e os erros têm texto próprio.
            if (it.code == 401 && !claim) throw CourierRevoked()
            if (!it.isSuccessful) {
                val (code, message) = error(text)
                throw CourierFailure(friendly(it.code, code) ?: message ?: "A loja não respondeu (${it.code}).", it.code, code)
            }
            WabotiaJson.decodeFromString(serializer, text.ifBlank { "{}" })
        }
    }

    private fun error(text: String): Pair<String?, String?> = runCatching {
        val e = WabotiaJson.parseToJsonElement(text).jsonObject["error"]?.jsonObject
        e?.get("code")?.jsonPrimitive?.contentOrNull to e?.get("message")?.jsonPrimitive?.contentOrNull
    }.getOrDefault(null to null)

    /** Os erros que o entregador precisa entender sem a mensagem do servidor. */
    private fun friendly(status: Int, code: String?): String? = when (code) {
        "claim_not_found" -> "Este QR não é de um pedido desta loja."
        "claim_used" -> "Este QR já foi lido. Peça à loja um QR novo."
        "claim_expired" -> "Este QR venceu. Peça à loja um QR novo."
        "delivery_closed" -> "Esta entrega já foi encerrada."
        "window_closed" -> "O cliente não falou com a loja nas últimas 24 horas, então a mensagem não pode ir pelo WhatsApp. Fale com a loja."
        "no_conversation" -> "Este pedido não tem conversa com o cliente. Fale com a loja."
        "rate_limited" -> "Muitas tentativas. Espere um pouco e tente de novo."
        else -> if (status == 429) "Muitas tentativas. Espere um pouco e tente de novo." else null
    }
}
