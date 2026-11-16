package br.com.queven.wabotia.courier

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder

/*
 * Modo entregador, fora do login: a pessoa escaneia o QR do pedido, o app mostra destino, rota e previsão, manda a
 * posição só enquanto está em uso, conversa com a loja e com o cliente, e o acesso some quando a entrega termina.
 *
 * O contrato do servidor ainda não fechou (sessão O, docs/ENTREGA.md em feat/modulo-entrega descreve a versão com
 * login). Os nomes de campo e de rota estão só em [HttpCourierBackend] e nos `@SerialName` deste arquivo.
 */

/** O que o QR do pedido traz: a instalação e o código de uso único que vira a credencial da entrega. */
data class CourierLink(val server: String, val code: String)

object CourierLinks {
    private val CODE = Regex("^[A-Za-z0-9_-]{6,128}$")

    /**
     * Aceita `https://<instalação>/entrega/<código>` (o endereço que a câmera comum também abre),
     * `https://<instalação>/...?entrega=<código>` e `wabotia://entrega?server=<instalação>&code=<código>`. Só https:
     * a credencial não viaja em texto aberto. Qualquer outra coisa é `null` ("este QR não é de um pedido").
     */
    fun parse(raw: String): CourierLink? {
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        val query = query(uri.rawQuery)
        return when (uri.scheme?.lowercase()) {
            "https" -> {
                val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
                val server = "https://$host" + (if (uri.port > 0 && uri.port != 443) ":${uri.port}" else "")
                val segments = uri.path.orEmpty().split('/').filter { it.isNotEmpty() }
                val index = segments.indexOfFirst { it == "entrega" || it == "e" }
                val code = query["entrega"] ?: segments.getOrNull(index + 1)?.takeIf { index >= 0 }
                code?.takeIf { CODE.matches(it) }?.let { CourierLink(server, it) }
            }
            "wabotia" -> {
                if (uri.host != "entrega") return null
                val host = query["server"]?.removePrefix("https://")?.trimEnd('/')?.takeIf { it.isNotBlank() && !it.contains("://") } ?: return null
                val code = query["code"]?.takeIf { CODE.matches(it) } ?: return null
                CourierLink("https://$host", code)
            }
            else -> null
        }
    }

    private fun query(raw: String?): Map<String, String> =
        raw.orEmpty().split('&').mapNotNull { pair ->
            val i = pair.indexOf('=')
            if (i <= 0) null else URLDecoder.decode(pair.substring(0, i), "UTF-8") to URLDecoder.decode(pair.substring(i + 1), "UTF-8")
        }.toMap()
}

/** Uma entrega na mão do entregador, como o servidor descreve. */
@Serializable
data class CourierDelivery(
    val id: String,
    /** "Pedido nº 12". */
    val label: String = "Entrega",
    @SerialName("store_name") val storeName: String = "",
    @SerialName("customer_name") val customerName: String = "",
    val address: String = "",
    @SerialName("dest_lat") val destLat: Double? = null,
    @SerialName("dest_lng") val destLng: Double? = null,
    val items: List<String> = emptyList(),
    val payment: String? = null,
    /** "Troco para R$ 50,00". */
    val change: String? = null,
    val notes: String? = null,
    @SerialName("eta_minutes") val etaMinutes: Int? = null,
    @SerialName("distance_m") val distanceM: Int? = null,
    val status: String = "en_route",
    val app: CourierPace? = null,
)

/** O ritmo que o servidor pede (docs/ENTREGA.md, "API do app do entregador"). Siga sempre o último recebido. */
@Serializable
data class CourierPace(
    @SerialName("sample_seconds") val sampleSeconds: Int = 15,
    @SerialName("upload_seconds") val uploadSeconds: Int = 60,
    @SerialName("near_upload_seconds") val nearUploadSeconds: Int = 30,
    @SerialName("stale_minutes") val staleMinutes: Int = 5,
)

/** Uma leitura do GPS. `t` em ms Unix do aparelho. */
@Serializable
data class PositionPoint(val t: Long, val lat: Double, val lng: Double, val accuracy: Float? = null, val speed: Float? = null)

/** Resposta do lote: `active: false` encerra (entregue, cancelada, acesso revogado). */
@Serializable
data class PositionsReply(
    val active: Boolean = true,
    @SerialName("last_at") val lastAt: Long? = null,
    val near: Boolean = false,
    @SerialName("eta_minutes") val etaMinutes: Int? = null,
    @SerialName("distance_m") val distanceM: Int? = null,
    val app: CourierPace? = null,
)

/** Com quem o entregador conversa pelo app. */
enum class CourierParty(val wire: String, val label: String) {
    STORE("store", "Loja"),
    CUSTOMER("customer", "Cliente"),
}

@Serializable
data class CourierMessage(
    val id: String,
    /** `me` (o entregador), `store` ou `customer`. */
    val from: String,
    val text: String,
    val at: Long,
) {
    val mine: Boolean get() = from == "me"
}

/** A credencial de uma entrega: vale só para ela e some quando o servidor revoga. */
@Serializable
data class CourierSession(
    val server: String,
    val token: String,
    @SerialName("delivery_id") val deliveryId: String,
)

/** O servidor revogou o acesso a esta entrega (entregue, cancelada, outra pessoa assumiu): o app esquece a entrega. */
class CourierRevoked(message: String = "Esta entrega não está mais com você.") : Exception(message)
