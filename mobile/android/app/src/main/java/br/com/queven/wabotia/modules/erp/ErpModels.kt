@file:OptIn(ExperimentalSerializationApi::class)

package br.com.queven.wabotia.modules.erp

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * Gestão (ERP) no aplicativo: clientes, produtos e estoque, pedido rápido e contas. As rotas são as do painel
 * (`/api/v1/profiles/{p}/erp/v1/…`, a erp-api do motor) e as do envio pelo WhatsApp (`/erp-conversa/…`). Os campos
 * seguem a resposta do servidor (src/erp/fagoo/workers/erp-api/src); o que não vier fica com o padrão. Mesmo desenho
 * do iOS (`Modules/Erp/ErpModels.swift`).
 */

// ---------------------------------------------------------------------------------------------------------------
// Clientes (`/v1/cadastros/contatos`)
// ---------------------------------------------------------------------------------------------------------------

@Serializable
data class ErpContactItem(
    val id: String,
    val name: String = "",
    val code: String? = null,
    @SerialName("trade_name") val tradeName: String? = null,
    val document: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val mobile: String? = null,
    val city: String? = null,
    val state: String? = null,
    val situation: String? = null,
) {
    val subtitle: String
        get() = listOfNotNull(
            code?.takeIf { it.isNotBlank() }?.let { "Cód. $it" },
            document?.takeIf { it.isNotBlank() },
            listOfNotNull(city?.takeIf { it.isNotBlank() }, state?.takeIf { it.isNotBlank() }).joinToString("/").takeIf { it.isNotBlank() },
        ).joinToString(" · ")
}

@Serializable
data class ErpContactPage(
    val items: List<ErpContactItem> = emptyList(),
    val page: Int = 1,
    val size: Int = 0,
    val total: Int = 0,
)

@Serializable
data class ErpContactRecord(
    val id: String,
    val version: Int = 0,
    val name: String = "",
    val code: String? = null,
    @SerialName("trade_name") val tradeName: String? = null,
    @SerialName("person_type") val personType: String? = null,
    val document: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val mobile: String? = null,
    @SerialName("postal_code") val postalCode: String? = null,
    val street: String? = null,
    val number: String? = null,
    val complement: String? = null,
    val district: String? = null,
    val city: String? = null,
    val state: String? = null,
    val situation: String? = null,
    val notes: String? = null,
) {
    /** "Rua Exemplo, 100 — Apto 2 · Centro · Cidade/UF · CEP 00000-000", sem as partes vazias. */
    val addressText: String?
        get() {
            val first = listOfNotNull(street.clean(), number.clean()).joinToString(", ").takeIf { it.isNotBlank() }
            val line = listOfNotNull(first, complement.clean()).joinToString(" — ").takeIf { it.isNotBlank() }
            val place = listOfNotNull(city.clean(), state.clean()).joinToString("/").takeIf { it.isNotBlank() }
            return listOfNotNull(line, district.clean(), place, postalCode.clean()?.let { "CEP $it" }).joinToString(" · ").takeIf { it.isNotBlank() }
        }

    /** O número para ligar e para o WhatsApp: celular primeiro, depois o telefone. */
    val bestPhone: String? get() = mobile.clean() ?: phone.clean()
}

@Serializable
data class ErpContactEnvelope(val record: ErpContactRecord)

@Serializable
data class ErpSaleHistoryItem(
    val id: String,
    val number: String = "",
    val date: String? = null,
    val status: String = "",
    val total: String = "0.00",
)

@Serializable
data class ErpSaleHistory(val visible: Boolean = true, val items: List<ErpSaleHistoryItem> = emptyList())

// ---------------------------------------------------------------------------------------------------------------
// Produtos e estoque (`/v1/cadastros/products`, `/v1/estoque/saldos`, `/v1/estoque/movimentos`)
// ---------------------------------------------------------------------------------------------------------------

@Serializable
data class ErpProduct(
    val id: String,
    val name: String = "",
    val code: String? = null,
    val unit: String? = null,
    val price: String? = null,
    val gtin: String? = null,
    val active: Boolean = true,
    val version: Int = 0,
    val description: String? = null,
    val brand: String? = null,
) {
    val unitText: String get() = unit.clean() ?: "UN"

    val subtitle: String
        get() = listOfNotNull(code.clean()?.let { "Cód. $it" }, gtin.clean()?.let { "GTIN $it" }).joinToString(" · ")
}

@Serializable
data class ErpProductList(
    val items: List<ErpProduct> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
    @SerialName("next_cursor") val nextCursor: String? = null,
)

@Serializable
data class ErpProductEnvelope(val record: ErpProduct)

@Serializable
data class ErpStockBalance(
    @SerialName("warehouse_id") val warehouseId: String,
    @SerialName("warehouse_name") val warehouseName: String = "Depósito",
    @SerialName("warehouse_active") val warehouseActive: Boolean = true,
    val quantity: String = "0",
    val version: Int = 0,
    val unit: String? = null,
    @SerialName("warehouse_default") val warehouseDefault: Boolean = false,
    @SerialName("reserved_quantity") val reservedQuantity: String? = null,
    val virtual: Boolean = false,
)

@Serializable
data class ErpStockBalances(
    @SerialName("product_id") val productId: String = "",
    val items: List<ErpStockBalance> = emptyList(),
)

@Serializable
data class ErpProductImage(
    val id: String,
    @SerialName("mime_type") val mimeType: String = "image/jpeg",
    val status: String = "ready",
    val position: Int? = null,
)

@Serializable
data class ErpProductImages(val items: List<ErpProductImage> = emptyList())

/** Entrada (`receipt`) ou saída (`issue`) do ajuste de estoque. */
enum class ErpStockDirection(val kind: String, val label: String) {
    IN("receipt", "Entrada"),
    OUT("issue", "Saída"),
}

@Serializable
data class ErpStockLine(
    @SerialName("product_id") val productId: String,
    @SerialName("warehouse_id") val warehouseId: String,
    val quantity: String,
    /** O servidor exige a versão do saldo, inclusive 0 (depósito sem lançamento). */
    @EncodeDefault @SerialName("expected_version") val expectedVersion: Int = 0,
)

@Serializable
data class ErpStockMovementRequest(
    @SerialName("command_id") val commandId: String,
    val kind: String,
    @SerialName("occurred_on") val occurredOn: String,
    val reason: String,
    val items: List<ErpStockLine>,
)

// ---------------------------------------------------------------------------------------------------------------
// Pedido rápido (`/v1/documentos/sales_orders`)
// ---------------------------------------------------------------------------------------------------------------

@Serializable
data class ErpPaymentMethod(
    val id: String,
    val description: String = "",
    @SerialName("payment_type") val paymentType: String? = null,
    @SerialName("is_default") val isDefault: Boolean = false,
)

@Serializable
data class ErpPaymentOptions(val methods: List<ErpPaymentMethod> = emptyList())

@Serializable
data class ErpOrderItemBody(
    @SerialName("product_id") val productId: String,
    val description: String,
    val code: String? = null,
    val unit: String,
    val quantity: String,
    @SerialName("unit_price") val unitPrice: String,
)

@Serializable
data class ErpInstallmentBody(
    @SerialName("due_date") val dueDate: String,
    val amount: String,
    val method: String? = null,
    @SerialName("payment_method_id") val paymentMethodId: String? = null,
)

@Serializable
data class ErpOrderData(
    val date: String,
    @SerialName("contact_id") val contactId: String,
    val items: List<ErpOrderItemBody>,
    /** `amount` (R$) ou `percent`: vai sempre, para o total do aplicativo bater com o do servidor. */
    @EncodeDefault @SerialName("discount_mode") val discountMode: String = "amount",
    @EncodeDefault @SerialName("discount_value") val discountValue: String = "0.00",
    val installments: List<ErpInstallmentBody> = emptyList(),
    val notes: String? = null,
)

@Serializable
data class ErpOrderRequest(
    @SerialName("command_id") val commandId: String,
    val data: ErpOrderData,
)

@Serializable
data class ErpSavedDocument(
    val id: String,
    val number: String? = null,
    val status: String? = null,
    val version: Int = 0,
)

@Serializable
data class ErpOrderSaved(val document: ErpSavedDocument, val replayed: Boolean = false)

// ---------------------------------------------------------------------------------------------------------------
// Enviar pelo WhatsApp (`/erp-conversa/pedido/{id}`)
// ---------------------------------------------------------------------------------------------------------------

@Serializable
data class ErpSendPhone(val digitos: String, val numero: String = "")

@Serializable
data class ErpSendLine(val id: String, val nome: String? = null, val name: String? = null, val label: String? = null) {
    val title: String get() = nome.clean() ?: name.clean() ?: label.clean() ?: "WhatsApp"
}

@Serializable
data class ErpSendDestination(
    val telefone: String = "",
    val digitos: String = "",
    val linha: String = "",
    val modo: String = "bloqueado",
    val motivo: String? = null,
)

@Serializable
data class ErpSendPreview(
    val telefones: List<ErpSendPhone> = emptyList(),
    val linhas: List<ErpSendLine> = emptyList(),
    val conectar: String? = null,
    val destino: ErpSendDestination? = null,
) {
    /** O servidor oferece o envio: há linha, telefone e a regra do WhatsApp deixa sair agora. */
    val canSend: Boolean get() = destino != null && destino.modo != "bloqueado" && destino.digitos.isNotBlank() && destino.linha.isNotBlank()
}

@Serializable
data class ErpSendRequest(val telefone: String, val linha: String)

// ---------------------------------------------------------------------------------------------------------------
// Contas a receber e a pagar (`/v1/financeiro/titles`, `/v1/financeiro/actions/settle`)
// ---------------------------------------------------------------------------------------------------------------

@Serializable
data class ErpTitle(
    val id: String,
    val kind: String = "receivable",
    @SerialName("contact_id") val contactId: String? = null,
    @SerialName("contact_name") val contactName: String = "",
    val description: String = "",
    @SerialName("due_on") val dueOn: String = "",
    @SerialName("amount_cents") val amountCents: String = "0",
    @SerialName("balance_cents") val balanceCents: String = "0",
    val status: String = "open",
    val overdue: Boolean = false,
    val version: Int = 0,
    @SerialName("account_id") val accountId: String? = null,
    val installment: Int = 1,
    val installments: Int = 1,
) {
    val balance: Long get() = balanceCents.toLongOrNull() ?: 0L
    val amount: Long get() = amountCents.toLongOrNull() ?: 0L
    val isOpen: Boolean get() = status == "open" || status == "partial"
    val installmentText: String? get() = if (installments > 1) "Parcela $installment de $installments" else null
}

@Serializable
data class ErpTitlePage(
    val items: List<ErpTitle> = emptyList(),
    val total: Int = 0,
)

@Serializable
data class ErpAccount(val id: String, val name: String = "", val kind: String? = null, val active: Boolean = true)

@Serializable
data class ErpAccountList(val items: List<ErpAccount> = emptyList())

@Serializable
data class ErpSettleData(
    val id: String,
    @SerialName("expected_version") val expectedVersion: Int,
    @SerialName("account_id") val accountId: String,
    @SerialName("posted_on") val postedOn: String,
    @SerialName("principal_cents") val principalCents: String,
    val note: String? = null,
)

@Serializable
data class ErpSettleRequest(@SerialName("command_id") val commandId: String, val data: ErpSettleData)

// ---------------------------------------------------------------------------------------------------------------
// Cadastro rápido de cliente (`POST /v1/cadastros/contatos`)
// ---------------------------------------------------------------------------------------------------------------

@Serializable
data class ErpQuickContactData(
    val name: String,
    @SerialName("person_type") val personType: String,
    val document: String? = null,
    val mobile: String? = null,
    val phone: String? = null,
    val email: String? = null,
    /** "A" (ativo) e "9" (não contribuinte), como o contato rápido do painel. */
    @EncodeDefault val situation: String = "A",
    @EncodeDefault val taxpayer: String = "9",
    @EncodeDefault val types: List<String> = listOf("customer"),
)

@Serializable
data class ErpQuickContactRequest(@SerialName("command_id") val commandId: String, val data: ErpQuickContactData)

/** Texto sem espaços nas pontas, ou `null` quando vazio. */
internal fun String?.clean(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

/** Um item do pedido em montagem. */
data class ErpCartLine(val product: ErpProduct, val quantity: String)

/** O que o aplicativo guarda numa leitura: a resposta crua e quando veio (ou a cópia sem conexão). */
data class ErpRead<T>(val value: T, val offlineAt: Long? = null)

/** Corpo cru (para quem só lê partes de uma resposta). */
typealias ErpRaw = JsonObject
