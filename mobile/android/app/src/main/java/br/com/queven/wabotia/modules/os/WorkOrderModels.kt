@file:OptIn(ExperimentalSerializationApi::class)

package br.com.queven.wabotia.modules.os

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Ordem de serviço por modelo (src/modules/os/contracts.ts): o catálogo de modelos (`GET service-orders/types`), a
 * ordem com etapa, campos próprios, objeto do serviço e checklist, e os corpos das escritas novas. Na leitura tudo é
 * opcional (o servidor pode mandar a mais ou a menos; a ordem nunca é descartada por um campo faltando). Nas escritas,
 * WabotiaJson não manda campo igual ao padrão: o que o servidor exige e tem padrão aqui leva @EncodeDefault
 * (RequestEncodingTest).
 */

/** O id do modelo embutido (a ordem de serviço antiga, com estados fixos). */
const val BUILTIN_WORK_TYPE = "service_order"

private val EMPTY = JsonObject(emptyMap())

@Serializable
data class WorkFieldOption(val id: String = "", val label: String = "")

/**
 * Um campo próprio do modelo ou do tipo de objeto. `min`/`max` são números em `integer`/`decimal` e "AAAA-MM-DD" em
 * `date`; `sensitive` nunca aparece nem é enviado pelo app.
 */
@Serializable
data class WorkField(
    val id: String = "",
    val label: String = "",
    val help: String = "",
    val kind: String = "text",
    val required: Boolean = false,
    val sensitive: Boolean = false,
    val multiline: Boolean = false,
    @SerialName("max_length") val maxLength: Int? = null,
    val min: JsonPrimitive? = null,
    val max: JsonPrimitive? = null,
    val scale: Int? = null,
    val options: List<WorkFieldOption> = emptyList(),
)

@Serializable
data class WorkChecklistItem(
    val id: String = "",
    val label: String = "",
    val required: Boolean = false,
    @SerialName("photo_required") val photoRequired: Boolean = false,
)

@Serializable
data class WorkStage(
    val id: String = "",
    val label: String = "",
    @SerialName("base_status") val baseStatus: String = "received",
    val message: String = "",
    val checklist: List<WorkChecklistItem> = emptyList(),
)

@Serializable
data class WorkTransition(
    val id: String = "",
    val from: String = "",
    val to: String = "",
    val label: String = "",
    val kind: String = "manual",
)

@Serializable
data class StageFieldRule(
    @SerialName("field_id") val fieldId: String = "",
    @SerialName("required_from_stage") val requiredFromStage: String? = null,
    @SerialName("required_on_exit") val requiredOnExit: List<String> = emptyList(),
)

@Serializable
data class WorkLabels(
    val singular: String = "",
    val plural: String = "",
    val item: String = "",
    val problem: String = "",
    @SerialName("customer_singular") val customerSingular: String = "",
    @SerialName("customer_plural") val customerPlural: String = "",
)

@Serializable
data class WorkQuotePolicy(
    @SerialName("sent_stage") val sentStage: String? = null,
    @SerialName("approved_stage") val approvedStage: String? = null,
    @SerialName("default_valid_days") val defaultValidDays: Int? = null,
)

@Serializable
data class WorkFeatures(
    val quote: WorkQuotePolicy? = null,
    val documents: Boolean? = null,
)

/** Um modelo do catálogo. `kind: "builtin"` (id `service_order`) é a ordem antiga. */
@Serializable
data class WorkType(
    val kind: String = "custom",
    val id: String = "",
    val revision: Int? = null,
    val archived: Boolean = false,
    val labels: WorkLabels = WorkLabels(),
    val fields: List<WorkField> = emptyList(),
    val stages: List<WorkStage> = emptyList(),
    @SerialName("initial_stage") val initialStage: String = "",
    val transitions: List<WorkTransition> = emptyList(),
    val features: WorkFeatures? = null,
    @SerialName("object_type_id") val objectTypeId: String? = null,
    @SerialName("stage_field_rules") val stageFieldRules: List<StageFieldRule> = emptyList(),
) {
    val isBuiltin: Boolean get() = kind == "builtin" || id == BUILTIN_WORK_TYPE

    /** O nome do modelo na tela ("Oficina"); o embutido é a ordem de serviço simples. */
    val title: String
        get() = if (isBuiltin) "Ordem de serviço (simples)" else labels.plural.ifBlank { labels.singular }.ifBlank { id }

    fun stage(id: String?): WorkStage? = stages.firstOrNull { it.id == id }
}

@Serializable
data class WorkTypeCatalog(
    val data: List<WorkType> = emptyList(),
    @SerialName("settings_revision") val settingsRevision: String? = null,
)

@Serializable
data class ObjectLabels(val singular: String = "", val plural: String = "")

/** A definição de um tipo de objeto (ex.: Veículo), ou o retrato dela guardado na ordem. */
@Serializable
data class ServiceObjectType(
    val id: String = "",
    val archived: Boolean = false,
    val labels: ObjectLabels = ObjectLabels(),
    @SerialName("identifier_field_id") val identifierFieldId: String? = null,
    val fields: List<WorkField> = emptyList(),
)

@Serializable
data class ServiceObjectView(
    val id: String = "",
    @SerialName("type_id") val typeId: String? = null,
    val type: ServiceObjectType? = null,
    val values: JsonObject = EMPTY,
    val archived: Boolean = false,
    val version: Int = 0,
    val identifier: String = "",
)

/** O objeto como ficou na ordem na abertura (definição e valores já filtrados para quem vê). */
@Serializable
data class OrderObjectSnapshot(
    @SerialName("object_id") val objectId: String = "",
    @SerialName("object_version") val objectVersion: Int? = null,
    val type: ServiceObjectType = ServiceObjectType(),
    val values: JsonObject = EMPTY,
    val identifier: String = "",
)

/** Um próximo passo da ordem: um botão. `customer_approval` pede a aprovação do cliente. */
@Serializable
data class NextStage(
    @SerialName("transition_id") val transitionId: String = "",
    val stage: String = "",
    @SerialName("stage_label") val stageLabel: String = "",
    @SerialName("base_status") val baseStatus: String = "",
    val kind: String = "manual",
)

@Serializable
data class StageApproval(
    val state: String = "",
    @SerialName("transition_id") val transitionId: String? = null,
    @SerialName("to_stage") val toStage: String? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
)

@Serializable
data class WorkQuoteItem(
    val description: String = "",
    val quantity: Double = 1.0,
    @SerialName("unit_cents") val unitCents: Long = 0,
    @SerialName("discount_cents") val discountCents: Long? = null,
    val unit: String? = null,
) {
    /** Valor da linha: quantidade × unitário, menos o desconto da linha. */
    val lineCents: Long get() = Math.round(quantity * unitCents) - (discountCents ?: 0)
}

@Serializable
data class WorkQuote(
    val items: List<WorkQuoteItem> = emptyList(),
    @SerialName("total_cents") val totalCents: Long? = null,
    @SerialName("subtotal_cents") val subtotalCents: Long? = null,
    @SerialName("items_discount_cents") val itemsDiscountCents: Long? = null,
    @SerialName("discount_cents") val discountCents: Long? = null,
    val note: String? = null,
    @SerialName("valid_until") val validUntil: Long? = null,
    @SerialName("sent_at") val sentAt: Long? = null,
    val version: Int? = null,
    val expired: Boolean = false,
    val locked: Boolean = false,
) {
    val total: Long get() = totalCents ?: items.sumOf { it.lineCents }
}

@Serializable
data class WorkDecision(val decision: String? = null, val at: Long? = null, val by: String? = null, val via: String? = null)

@Serializable
data class ChecklistEntry(
    val id: String = "",
    val label: String = "",
    val required: Boolean = false,
    @SerialName("photo_required") val photoRequired: Boolean = false,
    val done: Boolean = false,
    @SerialName("photo_document_id") val photoDocumentId: String? = null,
    val by: String? = null,
    val at: Long? = null,
)

@Serializable
data class OrderChecklistStage(
    @SerialName("stage_id") val stageId: String = "",
    @SerialName("stage_label") val stageLabel: String = "",
    val current: Boolean = false,
    val items: List<ChecklistEntry> = emptyList(),
    val missing: List<String> = emptyList(),
)

/** A ordem com modelo (ou a antiga, quando `type_id` é `service_order` ou falta). */
@Serializable
data class WorkOrder(
    val id: String = "",
    val number: Int? = null,
    @SerialName("display_number") val displayNumber: String? = null,
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    @SerialName("type_id") val typeId: String? = null,
    @SerialName("type_label") val typeLabel: String? = null,
    @SerialName("type_plural_label") val typePluralLabel: String? = null,
    val stage: String? = null,
    @SerialName("stage_label") val stageLabel: String? = null,
    val labels: WorkLabels? = null,
    val customer: ServiceOrderCustomer? = null,
    val item: String? = null,
    val problem: String? = null,
    val notes: String? = null,
    val assignee: String? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    val extra: JsonObject = EMPTY,
    val fields: List<WorkField> = emptyList(),
    val version: Int = 0,
    val features: WorkFeatures? = null,
    @SerialName("object") val serviceObject: OrderObjectSnapshot? = null,
    @SerialName("next_stages") val nextStages: List<NextStage> = emptyList(),
    @SerialName("stage_approval") val stageApproval: StageApproval? = null,
    val quote: WorkQuote? = null,
    val decision: WorkDecision? = null,
    @SerialName("next_statuses") val nextStatuses: List<String> = emptyList(),
    val checklist: List<OrderChecklistStage> = emptyList(),
    val created: Long? = null,
    val updated: Long? = null,
) {
    /** Abre a ficha antiga: sem modelo ou com o embutido. */
    val isLegacy: Boolean get() = typeId.isNullOrBlank() || typeId == BUILTIN_WORK_TYPE
    val state: String get() = status ?: "received"
    val closed: Boolean get() = state in ServiceOrderRules.CLOSED
    val numberText: String get() = displayNumber?.takeIf { it.isNotBlank() } ?: number?.let { "nº $it" } ?: "—"
    val stageText: String get() = stageLabel?.takeIf { it.isNotBlank() } ?: statusLabel?.takeIf { it.isNotBlank() } ?: ServiceOrderRules.statusLabel(state)
    val customerName: String get() = customer?.name?.takeIf { it.isNotBlank() } ?: customer?.phone?.takeIf { it.isNotBlank() } ?: "Cliente"
    val itemLabel: String get() = labels?.item?.takeIf { it.isNotBlank() } ?: "Item"
    val problemLabel: String get() = labels?.problem?.takeIf { it.isNotBlank() } ?: "Problema"
}

/** Uma página da lista nova. */
data class WorkOrderPage(val data: List<WorkOrder>, val nextCursor: String?, val counts: Map<String, Int> = emptyMap())

@Serializable
data class RequirementField(@SerialName("field_id") val fieldId: String = "", val label: String = "")

@Serializable
data class OrderRequirements(
    val id: String = "",
    val version: Int = 0,
    @SerialName("transition_id") val transitionId: String? = null,
    val required: List<RequirementField> = emptyList(),
    val missing: List<RequirementField> = emptyList(),
    @SerialName("internal_missing") val internalMissing: Boolean = false,
)

@Serializable
data class WorkHistory(
    val id: String = "",
    val kind: String? = null,
    @SerialName("from_status") val fromStatus: String? = null,
    @SerialName("to_status") val toStatus: String? = null,
    @SerialName("from_stage") val fromStage: String? = null,
    @SerialName("to_stage") val toStage: String? = null,
    val actor: String? = null,
    val note: String? = null,
    val created: Long? = null,
)

@Serializable
data class WorkHistoryPage(
    val data: List<WorkHistory> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
)

@Serializable
data class ObjectTypeCatalog(val data: List<ServiceObjectType> = emptyList())

@Serializable
data class ServiceObjectPage(
    val data: List<ServiceObjectView> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
)

/** Um contato do cadastro (`GET contacts`). */
@Serializable
data class WorkContact(
    val id: String = "",
    val name: String? = null,
    val phone: String? = null,
    val namespace: String? = null,
    @SerialName("identity_state") val identityState: String? = null,
    @SerialName("merged_into") val mergedInto: String? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: phone?.takeIf { it.isNotBlank() } ?: "Cliente"
}

@Serializable
data class ContactPage(val data: List<WorkContact> = emptyList())

@Serializable
data class DocumentReservation(
    val id: String = "",
    @SerialName("order_id") val orderId: String? = null,
    val version: Int = 0,
    @SerialName("upload_url") val uploadUrl: String = "",
    @SerialName("expires_at") val expiresAt: Long? = null,
)

@Serializable
data class DocumentUploadResult(
    val id: String = "",
    val version: Int = 0,
    @SerialName("upload_attempt") val uploadAttempt: String = "",
    @SerialName("byte_length") val byteLength: Long? = null,
    val sha256: String? = null,
)

// ---------------------------------------------------------------------------------------------------------------
// Corpos das escritas
// ---------------------------------------------------------------------------------------------------------------

/** `POST service-orders/{id}/stage` e `/stage-approval`. */
@Serializable
data class StageRequest(
    @SerialName("transition_id") val transitionId: String,
    @EncodeDefault val version: Int = 0,
    val note: String? = null,
)

/** `POST service-orders/{id}/checklist`. */
@Serializable
data class ChecklistMarkRequest(
    @EncodeDefault val version: Int = 0,
    @SerialName("item_id") val itemId: String,
    @EncodeDefault val done: Boolean = false,
    @SerialName("photo_document_id") val photoDocumentId: String? = null,
)

/** `POST service-orders/{id}/documents`: reserva o envio de um arquivo. */
@Serializable
data class DocumentReserveRequest(
    val name: String,
    @SerialName("mime_type") val mimeType: String,
    @SerialName("expected_bytes") val expectedBytes: Long,
    @EncodeDefault @SerialName("client_visible") val clientVisible: Boolean = false,
    @EncodeDefault val sensitive: Boolean = false,
)

/** `POST service-orders/{id}/documents/{doc}/complete`. */
@Serializable
data class CompleteDocumentRequest(
    @EncodeDefault val version: Int = 0,
    @SerialName("upload_attempt") val uploadAttempt: String,
)

/** O objeto do serviço na abertura: um já cadastrado (`existing`) ou um novo (`new`). */
@Serializable
data class ObjectOpening(
    @EncodeDefault val mode: String = "existing",
    val id: String? = null,
    val version: Int? = null,
    @SerialName("type_id") val typeId: String? = null,
    val values: JsonObject? = null,
) {
    companion object {
        fun existing(id: String, version: Int) = ObjectOpening(mode = "existing", id = id, version = version)
        fun new(typeId: String, values: JsonObject) = ObjectOpening(mode = "new", typeId = typeId, values = values)
    }
}

/** `POST service-orders` com modelo. */
@Serializable
data class CreateWorkOrderRequest(
    @SerialName("type_id") val typeId: String,
    val item: String,
    val problem: String,
    val extra: JsonObject? = null,
    val notes: String? = null,
    @SerialName("contact_id") val contactId: String? = null,
    @SerialName("object") val serviceObject: ObjectOpening? = null,
    @SerialName("customer_name") val customerName: String? = null,
    val phone: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
)

/** `PATCH service-orders/{id}` só com os campos próprios. */
@Serializable
data class UpdateExtraRequest(
    @EncodeDefault val version: Int = 0,
    val extra: JsonObject,
)

/** `POST service-orders/{id}/quote/send`. */
@Serializable
data class QuoteSendRequest(@EncodeDefault val notify: Boolean = true)
