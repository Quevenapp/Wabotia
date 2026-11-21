package br.com.queven.wabotia.modules.erp

import android.content.Context
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.os.CachedCopy
import br.com.queven.wabotia.modules.os.FileWorkCacheStorage
import br.com.queven.wabotia.modules.os.WorkCacheStorage
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.io.File

@Serializable
data class ErpCacheIndex(val entries: List<CachedCopy> = emptyList())

/**
 * A última resposta de cada leitura da Gestão, por área, para ver sem conexão (listas, fichas, saldos e contas já vistos).
 * Nada é enfileirado: sem conexão a tela mostra a cópia com o aviso e os botões de mudança ficam desligados. Apagada ao
 * sair da conta, como a cópia das ordens de serviço.
 */
class ErpCache(private val storage: WorkCacheStorage, private val maxEntries: Int = 120) {
    private val lock = Any()

    private fun name(profile: String) = "erp-" + profile.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.ifEmpty { "x" } + ".json"

    private fun index(profile: String): ErpCacheIndex =
        storage.read(name(profile))?.let { runCatching { WabotiaJson.decodeFromString(ErpCacheIndex.serializer(), it) }.getOrNull() } ?: ErpCacheIndex()

    fun save(profile: String, key: String, body: String, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        val entries = (listOf(CachedCopy(key, now, body)) + index(profile).entries.filter { it.key != key }).sortedByDescending { it.savedAt }.take(maxEntries)
        storage.write(name(profile), WabotiaJson.encodeToString(ErpCacheIndex.serializer(), ErpCacheIndex(entries)))
    }

    fun get(profile: String, key: String): CachedCopy? = synchronized(lock) { index(profile).entries.firstOrNull { it.key == key } }

    fun wipe() = synchronized(lock) { storage.clear() }

    companion object {
        @Volatile private var shared: ErpCache? = null

        private fun dir(context: Context) = File(context.applicationContext.noBackupFilesDir, "erp-cache")

        fun of(context: Context): ErpCache =
            shared ?: synchronized(this) { shared ?: ErpCache(FileWorkCacheStorage(dir(context))).also { shared = it } }

        /** No logout (AppContainer.wipeLocalData): nenhum dado de cliente fica no aparelho. */
        fun wipe(context: Context) {
            shared?.wipe() ?: FileWorkCacheStorage(dir(context)).clear()
        }
    }
}

/**
 * As rotas da Gestão: a erp-api do painel (`erp/v1/…`) e o envio pelo WhatsApp (`erp-conversa/…`). Leituras passam pela
 * cópia guardada; escritas levam `command_id` (o ERP repete a mesma resposta para o mesmo comando) e `Idempotency-Key`.
 */
class ErpClient(
    val api: ProfileApi,
    private val cache: ErpCache?,
    private val profile: String,
) {
    /** Leitura com cópia: a resposta nova é guardada; sem conexão, volta a última cópia (com a hora dela). */
    private suspend fun <T> read(path: String, query: Map<String, String?>, serializer: KSerializer<T>): ErpRead<T> {
        val key = cacheKey(path, query)
        val raw: JsonElement = try {
            api.raw(path, query).also { cache?.save(profile, key, it.toString()) }
        } catch (e: Throwable) {
            val copy = (if (ErpText.isOffline(e)) cache?.get(profile, key) else null) ?: throw e
            return ErpRead(WabotiaJson.decodeFromString(serializer, copy.body), copy.savedAt)
        }
        return ErpRead(WabotiaJson.decodeFromJsonElement(serializer, raw))
    }

    suspend fun customers(query: String, page: Int = 1): ErpRead<ErpContactPage> =
        read(
            "erp/v1/cadastros/contatos", ErpContactPage.serializer(),
            mapOf("page" to page.toString(), "size" to "30", "q" to query.trim().takeIf { it.isNotEmpty() }, "sort" to if (query.isBlank()) null else "name_asc"),
        )

    suspend fun customer(id: String): ErpRead<ErpContactEnvelope> = read("erp/v1/cadastros/contatos/${seg(id)}", emptyMap(), ErpContactEnvelope.serializer())

    suspend fun customerOrders(id: String): ErpRead<ErpSaleHistory> = read("erp/v1/cadastros/contatos/${seg(id)}/historico", emptyMap(), ErpSaleHistory.serializer())

    /** Contas a receber em aberto do cliente: a busca pelo nome e, no aparelho, só as dele. */
    suspend fun customerBills(id: String, name: String): ErpRead<List<ErpTitle>> {
        val page = titles(kind = "receivable", option = "open", query = name.take(120))
        return ErpRead(page.value.items.filter { it.contactId.equals(id, ignoreCase = true) && it.isOpen }, page.offlineAt)
    }

    suspend fun createCustomer(body: ErpQuickContactRequest, key: String): ErpContactEnvelope =
        api.send("POST", "erp/v1/cadastros/contatos", encode(ErpQuickContactRequest.serializer(), body), key, ErpContactEnvelope.serializer())

    /** Busca por nome, código ou GTIN (o mesmo campo do painel), só ativos. */
    suspend fun products(query: String): ErpRead<ErpProductList> =
        read("erp/v1/cadastros/products", ErpProductList.serializer(), mapOf("limit" to "30", "active" to "true", "q" to query.trim().takeIf { it.isNotEmpty() }))

    suspend fun product(id: String): ErpRead<ErpProductEnvelope> = read("erp/v1/cadastros/products/${seg(id)}", emptyMap(), ErpProductEnvelope.serializer())

    suspend fun stock(productId: String): ErpRead<ErpStockBalances> = read("erp/v1/estoque/saldos", ErpStockBalances.serializer(), mapOf("product_id" to productId))

    suspend fun productImages(productId: String): ErpProductImages = api.get("erp/v1/anexos-cadastros/produtos/${seg(productId)}", ErpProductImages.serializer())

    suspend fun productImage(productId: String, imageId: String): ByteArray = api.download("erp/v1/anexos-cadastros/produtos/${seg(productId)}/${seg(imageId)}/download")

    suspend fun moveStock(body: ErpStockMovementRequest, key: String): JsonObject =
        api.send("POST", "erp/v1/estoque/movimentos", encode(ErpStockMovementRequest.serializer(), body), key, JsonObject.serializer())

    suspend fun paymentOptions(): ErpRead<ErpPaymentOptions> = read("erp/v1/documentos/sales_orders/pagamento", emptyMap(), ErpPaymentOptions.serializer())

    suspend fun createOrder(body: ErpOrderRequest, key: String): ErpOrderSaved =
        api.send("POST", "erp/v1/documentos/sales_orders", encode(ErpOrderRequest.serializer(), body), key, ErpOrderSaved.serializer())

    /** O servidor oferece o envio? 404 (servidor antigo) e recusas viram `null`: o botão não aparece. */
    suspend fun sendPreview(orderId: String): ErpSendPreview = api.get("erp-conversa/pedido/${seg(orderId)}", ErpSendPreview.serializer())

    suspend fun sendOrder(orderId: String, body: ErpSendRequest, key: String): JsonObject =
        api.send("POST", "erp-conversa/pedido/${seg(orderId)}/enviar", encode(ErpSendRequest.serializer(), body), key, JsonObject.serializer())

    /** `option`: `open` (em aberto, com período) ou `overdue` (vencidas). */
    suspend fun titles(kind: String, option: String, from: String? = null, to: String? = null, query: String? = null): ErpRead<ErpTitlePage> =
        read(
            "erp/v1/financeiro/titles", ErpTitlePage.serializer(),
            mapOf("page" to "1", "limit" to "100", "kind" to kind, "option" to option, "from" to from, "to" to to, "q" to query?.trim()?.takeIf { it.isNotEmpty() }),
        )

    suspend fun accounts(): ErpRead<ErpAccountList> = read("erp/v1/financeiro/accounts", ErpAccountList.serializer(), mapOf("limit" to "100"))

    suspend fun settle(body: ErpSettleRequest, key: String): JsonObject =
        api.send("POST", "erp/v1/financeiro/actions/settle", encode(ErpSettleRequest.serializer(), body), key, JsonObject.serializer())

    private suspend fun <T> read(path: String, serializer: KSerializer<T>, query: Map<String, String?>): ErpRead<T> = read(path, query, serializer)

    companion object {
        fun <B> encode(serializer: KSerializer<B>, body: B): JsonObject = WabotiaJson.encodeToJsonElement(serializer, body).jsonObject

        fun cacheKey(path: String, query: Map<String, String?>): String =
            path + query.entries.filter { it.value != null }.sortedBy { it.key }.joinToString("&", prefix = "?") { "${it.key}=${it.value}" }

        /** O `command_id` do ERP (um UUID) a partir da `Idempotency-Key` da intenção (`wabotia-<uuid>`). */
        fun commandId(key: String): String = key.removePrefix("wabotia-")

        private fun seg(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    }
}
