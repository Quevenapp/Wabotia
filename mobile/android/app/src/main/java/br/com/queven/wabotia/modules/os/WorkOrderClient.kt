package br.com.queven.wabotia.modules.os

import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/** As rotas da ordem por modelo (`/api/v1/profiles/{p}/service-orders/…`). Escritas com `Idempotency-Key` por intenção. */
class WorkOrderClient(val api: ProfileApi) {
    /** Os modelos da área. 404/`not_implemented`: servidor antigo, sem modelos. */
    suspend fun types(): WorkTypeCatalog = WabotiaJson.decodeFromJsonElement(WorkTypeCatalog.serializer(), typesRaw())

    /** A resposta crua do catálogo (guardada no cache). */
    suspend fun typesRaw(): JsonElement = api.raw("service-orders/types")

    suspend fun type(id: String): WorkType = api.get("service-orders/types/${seg(id)}", WorkType.serializer())

    /** Uma página da lista; cada linha que não decodifica é pulada (as outras continuam). */
    suspend fun listRaw(query: Map<String, String?>): JsonObject = api.raw("service-orders", query) as? JsonObject ?: JsonObject(emptyMap())

    suspend fun order(id: String): WorkOrder = WabotiaJson.decodeFromJsonElement(WorkOrder.serializer(), orderRaw(id))

    suspend fun orderRaw(id: String): JsonElement = api.raw("service-orders/${seg(id)}", mapOf("history" to "none"))

    suspend fun historyRaw(id: String, cursor: String? = null, limit: Int = 50): JsonElement =
        api.raw("service-orders/${seg(id)}/history", mapOf("limit" to limit.toString(), "cursor" to cursor))

    suspend fun requirements(id: String, transitionId: String?): OrderRequirements =
        api.get("service-orders/${seg(id)}/requirements", OrderRequirements.serializer(), mapOf("transition_id" to transitionId))

    suspend fun objectTypes(): ObjectTypeCatalog = api.get("service-orders/object-types", ObjectTypeCatalog.serializer())

    suspend fun objects(contactId: String, typeId: String): ServiceObjectPage =
        api.get(
            "service-orders/objects", ServiceObjectPage.serializer(),
            mapOf("contact_id" to contactId, "type_id" to typeId, "include_archived" to "0", "limit" to "30"),
        )

    suspend fun contacts(query: String): List<WorkContact> =
        api.get(
            "contacts", ContactPage.serializer(),
            mapOf("q" to query.trim(), "identity" to "all", "namespace" to "team", "limit" to "30"),
        ).data.filter(WorkOrderRules::visibleContact)

    suspend fun create(body: CreateWorkOrderRequest, key: String): WorkOrder =
        send("POST", "service-orders", CreateWorkOrderRequest.serializer(), body, key)

    /** Os valores vão como estão (o nulo explícito apaga o campo). */
    suspend fun updateExtra(id: String, body: UpdateExtraRequest, key: String): WorkOrder =
        api.send("PATCH", "service-orders/${seg(id)}", updateBody(body), key, WorkOrder.serializer())

    suspend fun moveStage(id: String, body: StageRequest, approval: Boolean, key: String): WorkOrder =
        send("POST", "service-orders/${seg(id)}/" + if (approval) "stage-approval" else "stage", StageRequest.serializer(), body, key)

    suspend fun markChecklist(id: String, body: ChecklistMarkRequest, key: String): WorkOrder =
        send("POST", "service-orders/${seg(id)}/checklist", ChecklistMarkRequest.serializer(), body, key)

    suspend fun reserveDocument(id: String, body: DocumentReserveRequest, key: String): DocumentReservation =
        send("POST", "service-orders/${seg(id)}/documents", DocumentReserveRequest.serializer(), body, key, DocumentReservation.serializer())

    /**
     * Envia os bytes ao `upload_url` da reserva, só se for do mesmo servidor: outro domínio é recusado antes de qualquer
     * conexão.
     */
    suspend fun upload(reservation: DocumentReservation, bytes: ByteArray, mimeType: String, key: String = QueueClient.newKey()): DocumentUploadResult {
        val target = WorkOrderRules.uploadTarget(api.serverRoot, reservation.uploadUrl)
            ?: throw QueueException(400, "unsafe_upload_url", "O endereço de envio da foto não é deste Wabotia. Nada foi enviado.")
        return api.putBytes(
            target, bytes, mimeType,
            mapOf("Content-Type" to mimeType, "Idempotency-Key" to key, "Upload-Version" to reservation.version.toString()),
            DocumentUploadResult.serializer(),
        )
    }

    suspend fun completeDocument(id: String, documentId: String, body: CompleteDocumentRequest, key: String): JsonObject =
        send("POST", "service-orders/${seg(id)}/documents/${seg(documentId)}/complete", CompleteDocumentRequest.serializer(), body, key, JsonObject.serializer())

    /** O conteúdo de um documento (a foto de um item do checklist), com o token. */
    suspend fun documentContent(id: String, documentId: String): ByteArray = api.download("service-orders/${seg(id)}/documents/${seg(documentId)}/content")

    suspend fun sendQuote(id: String, key: String): WorkOrder =
        send("POST", "service-orders/${seg(id)}/quote/send", QuoteSendRequest.serializer(), QuoteSendRequest(notify = true), key)

    private suspend fun <B> send(method: String, path: String, serializer: KSerializer<B>, body: B, key: String): WorkOrder =
        send(method, path, serializer, body, key, WorkOrder.serializer())

    private suspend fun <B, T> send(method: String, path: String, serializer: KSerializer<B>, body: B, key: String, result: KSerializer<T>): T =
        api.send(method, path, encode(serializer, body), key, result)

    companion object {
        /** O corpo JSON de um pedido @Serializable (o mesmo que vai na rede). */
        fun <B> encode(serializer: KSerializer<B>, body: B): JsonObject = WabotiaJson.encodeToJsonElement(serializer, body).jsonObject

        /** O corpo do PATCH com `extra` copiado tal qual (nulos explícitos incluídos). */
        fun updateBody(body: UpdateExtraRequest): JsonObject = JsonObject(encode(UpdateExtraRequest.serializer(), body) + ("extra" to body.extra))

        private fun seg(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

        /** A página da lista a partir da resposta crua; linhas que não decodificam ficam de fora. */
        fun page(raw: JsonObject): WorkOrderPage {
            val data = (raw["data"] as? JsonArray)?.mapNotNull {
                runCatching { WabotiaJson.decodeFromJsonElement(WorkOrder.serializer(), it) }.getOrNull()?.takeIf { o -> o.id.isNotBlank() }
            }.orEmpty()
            val counts = (raw["counts"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.intOrNull?.let { k to it } }?.toMap().orEmpty()
            val next = (raw["next_cursor"] as? JsonPrimitive)?.takeIf { it.isString || it.intOrNull != null }?.content
            return WorkOrderPage(data, next, counts)
        }

        fun history(raw: JsonElement): WorkHistoryPage =
            runCatching { WabotiaJson.decodeFromJsonElement(WorkHistoryPage.serializer(), raw) }.getOrDefault(WorkHistoryPage())
    }
}
