package br.com.queven.wabotia.core.net

import br.com.queven.wabotia.core.model.*
import kotlinx.serialization.json.JsonObject
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

/**
 * Contrato REST do Wabotia consumido pelo aplicativo (docs/API.md + docs/MOBILE.md).
 * Escritas exigem Idempotency-Key: gere uma chave por intenção e reutilize a mesma ao repetir após falha de rede.
 */
interface WabotiaApi {
    // --- descoberta e autenticação ---
    @GET("api/health") suspend fun health(): HealthInfo
    @GET("api/auth/status") suspend fun authStatus(): AuthStatus
    @POST("api/auth/mobile/login") suspend fun mobileLogin(@Body body: MobileLoginRequest): MobileSession
    @POST("api/v1/auth/mobile/refresh") suspend fun refresh(@Header("Idempotency-Key") key: String): MobileSession
    @POST("api/v1/logout") suspend fun logout(@Header("Idempotency-Key") key: String): Ok
    @GET("api/v1/me") suspend fun me(): Me
    @GET("api/v1/profiles") suspend fun profiles(): List<Profile>

    // --- dispositivos / push ---
    @PUT("api/v1/devices/{id}") suspend fun registerDevice(@Path("id") id: String, @Body body: DeviceRegistration): Device
    @GET("api/v1/devices") suspend fun devices(): Page<Device>
    @DELETE("api/v1/devices/{id}") suspend fun deleteDevice(@Path("id") id: String): Ok
    @POST("api/v1/devices/{id}/test") suspend fun testDevice(@Path("id") id: String, @Header("Idempotency-Key") key: String): JsonObject

    // --- perfil ---
    @GET("api/v1/profiles/{p}/status") suspend fun profileStatus(@Path("p") p: String): ProfileStatus
    @GET("api/v1/profiles/{p}/presence") suspend fun presence(@Path("p") p: String): List<PresenceEntry>
    @PUT("api/v1/profiles/{p}/presence") suspend fun setPresence(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: PresenceRequest): PresenceResult
    @GET("api/v1/profiles/{p}/events") suspend fun events(@Path("p") p: String, @Query("after") after: Long): Events

    // --- conversas ---
    @GET("api/v1/profiles/{p}/conversations") suspend fun conversations(
        @Path("p") p: String,
        @Query("state") state: String? = null,
        @Query("q") q: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int = 50,
    ): Page<Conversation>
    @GET("api/v1/profiles/{p}/conversations/{id}") suspend fun conversation(@Path("p") p: String, @Path("id") id: String): ConversationDetail
    @POST("api/v1/profiles/{p}/conversations/{id}/actions") suspend fun act(
        @Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: ActionRequest,
    ): JsonObject
    @POST("api/v1/profiles/{p}/conversations/{id}/message-actions") suspend fun messageAction(
        @Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: MessageActionRequest,
    ): JsonObject
    @PUT("api/v1/profiles/{p}/groups/{id}/policy") suspend fun groupPolicy(
        @Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: GroupPolicyRequest,
    ): JsonObject
    @GET("api/v1/profiles/{p}/contacts/{id}") suspend fun contact(@Path("p") p: String, @Path("id") id: String): JsonObject

    // --- mídia (upload em partes de 5 MiB; GET content é feito via OkHttp direto com Authorization) ---
    @POST("api/v1/profiles/{p}/media/uploads") suspend fun uploadCreate(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: UploadInit): UploadCreated
    @PUT("api/v1/profiles/{p}/media/uploads/{id}/parts/{part}") suspend fun uploadPart(
        @Path("p") p: String, @Path("id") id: String, @Path("part") part: Int, @Header("Idempotency-Key") key: String, @Body body: RequestBody,
    ): JsonObject
    @POST("api/v1/profiles/{p}/media/uploads/{id}/complete") suspend fun uploadComplete(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): UploadDone
    @POST("api/v1/profiles/{p}/media/uploads/{id}/abort") suspend fun uploadAbort(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): UploadDone

    // --- protocolos ---
    @GET("api/v1/profiles/{p}/tickets") suspend fun tickets(
        @Path("p") p: String,
        @Query("status") status: String? = null,
        @Query("overdue") overdue: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int = 100,
        /** Número do protocolo ou dígitos do telefone. */
        @Query("q") q: String? = null,
        /** Servidor 0.14+: `1` = só protocolos ativos (nem `resolved` nem `closed`). Servidores antigos ignoram. */
        @Query("active") active: String? = null,
        /** Servidor 0.14+: `id` da categoria. */
        @Query("category") category: String? = null,
    ): Page<Ticket>
    @GET("api/v1/profiles/{p}/tickets/{id}") suspend fun ticket(@Path("p") p: String, @Path("id") id: String): TicketDetail
    @POST("api/v1/profiles/{p}/tickets") suspend fun createTicket(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: TicketCreate): Ticket
    /** Corpo livre porque `response_due_at: null` e `category: null` precisam ser enviados explicitamente para limpar o campo. */
    @PATCH("api/v1/profiles/{p}/tickets/{id}") suspend fun updateTicket(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): Ticket

    // --- bots ---
    @GET("api/v1/profiles/{p}/bots") suspend fun bots(@Path("p") p: String, @Query("cursor") cursor: String? = null): Page<Bot>
    @GET("api/v1/profiles/{p}/bot-runs") suspend fun botRuns(@Path("p") p: String, @Query("cursor") cursor: String? = null, @Query("limit") limit: Int = 100): Page<BotRun>
    @POST("api/v1/bot-runs") suspend fun startBotRun(@Header("Idempotency-Key") key: String, @Body body: BotRunRequest): BotRun
    @GET("api/v1/bot-runs/{id}") suspend fun botRun(@Path("id") id: String): BotRun
    @POST("api/v1/profiles/{p}/bot-runs/{id}/cancel") suspend fun cancelBotRun(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): JsonObject

    // --- ligações: somente o histórico (o servidor não aceita mais iniciar/atender) ---
    @GET("api/v1/profiles/{p}/calls") suspend fun calls(@Path("p") p: String, @Query("conversation_id") conversationId: String? = null, @Query("limit") limit: Int = 30, @Query("cursor") cursor: String? = null): Page<Call>

    // --- equipe, linhas e menus ---
    @GET("api/v1/profiles/{p}/team") suspend fun team(@Path("p") p: String): Page<TeamContact>
    @GET("api/v1/profiles/{p}/lines") suspend fun lines(@Path("p") p: String): Page<ServiceLine>
    @PUT("api/v1/profiles/{p}/lines/{id}") suspend fun saveLine(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject
    @GET("api/v1/profiles/{p}/menus") suspend fun menus(@Path("p") p: String, @Query("connection_id") connectionId: String? = null): Page<JsonObject>
    @PUT("api/v1/profiles/{p}/settings") suspend fun saveSettings(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject
    @PATCH("api/v1/profiles/{p}/bots/{id}") suspend fun updateBot(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject
    @POST("api/v1/profiles/{p}/internal-chats") suspend fun openInternalChat(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): InternalChat
    @GET("api/v1/profiles/{p}/internal-chats") suspend fun internalChats(@Path("p") p: String): Page<InternalChat>
    @GET("api/v1/profiles/{p}/internal-chats/{id}") suspend fun internalChat(@Path("p") p: String, @Path("id") id: String): InternalChat
    @POST("api/v1/profiles/{p}/internal-chats/{id}/messages") suspend fun sendInternal(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject

    // --- genérico, para respostas cruas quando necessário ---
    @GET suspend fun raw(@Url url: String): Response<JsonObject>
}
