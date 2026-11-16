package br.com.queven.wabotia.courier

import br.com.queven.wabotia.modules.Money
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.net.URI

/*
 * Modo entregador, fora do login: a pessoa escaneia o QR do pedido, o app mostra destino, rota e previsão, manda a
 * posição só enquanto está em uso, conversa com a loja e com o cliente, e o acesso some quando a entrega termina.
 *
 * Contrato: docs/ENTREGA.md, "Contrato do app do entregador", e docs/API.md, "Entrega" (feat/modulo-entrega,
 * c8d65f2). As rotas ficam só em [HttpCourierBackend]; os campos, nos `@SerialName` deste arquivo.
 */

/** O que o QR do pedido traz: `https://<servidor>/c/<código>`. O servidor é o da loja; o app não pergunta nenhum. */
data class CourierLink(val server: String, val code: String) {
    /** O host, para mostrar ("loja.exemplo.com.br"). */
    val host: String get() = server.removePrefix("https://")
}

/** O resultado da leitura do QR: o pedido, ou o motivo da recusa em texto para o entregador. */
sealed interface CourierScan {
    data class Ok(val link: CourierLink) : CourierScan
    data class Rejected(val message: String) : CourierScan
}

/**
 * A leitura do QR do entregador, isolada aqui (formato de fix/credencial-qr): `https://<endereço público>/api/public/c/<código>`,
 * ou `/c/<código>` de um QR já impresso,
 * com o código de 32 caracteres do alfabeto `[2-9A-HJ-NP-Za-km-np-z]` (sem 0, 1, I, O, l e o). Só https e só endereço
 * público: um QR com http, IP ou nome de rede local é recusado com explicação.
 */
object CourierLinks {
    private val CODE = Regex("^[2-9A-HJ-NP-Za-km-np-z]{32}$")
    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

    const val NOT_ORDER = "Este QR não é de um pedido."
    const val NOT_HTTPS = "Este QR não usa endereço seguro (https). Peça à loja o QR do pedido gerado pelo Wabotia."
    const val LOCAL = "Este QR aponta para um endereço de rede local, que só funciona dentro da loja. Peça à loja o QR do endereço público."

    fun check(raw: String): CourierScan {
        val text = raw.trim()
        if (text.isEmpty()) return CourierScan.Rejected(NOT_ORDER)
        val uri = runCatching { URI(text) }.getOrNull() ?: return CourierScan.Rejected(NOT_ORDER)
        when (uri.scheme?.lowercase()) {
            "https" -> Unit
            "http" -> return CourierScan.Rejected(NOT_HTTPS)
            else -> return CourierScan.Rejected(NOT_ORDER)
        }
        if (uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return CourierScan.Rejected(NOT_ORDER)
        val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return CourierScan.Rejected(NOT_ORDER)
        if (isLocal(host)) return CourierScan.Rejected(LOCAL)
        val segments = uri.rawPath.orEmpty().split('/').filter { it.isNotEmpty() }
        // `/api/public/c/<código>` (o novo) ou `/c/<código>` (QR já impresso); o caminho lido não é reaproveitado.
        val code = when {
            segments.size == 4 && segments[0] == "api" && segments[1] == "public" && segments[2] == "c" -> segments[3]
            segments.size == 2 && segments[0] == "c" -> segments[1]
            else -> return CourierScan.Rejected(NOT_ORDER)
        }
        if (!CODE.matches(code)) return CourierScan.Rejected(NOT_ORDER)
        val server = "https://$host" + (if (uri.port > 0 && uri.port != 443) ":${uri.port}" else "")
        return CourierScan.Ok(CourierLink(server, code))
    }

    fun parse(raw: String): CourierLink? = (check(raw) as? CourierScan.Ok)?.link

    /** IP (v4 ou v6), `localhost` e nomes de rede local (`.local`, `.lan`, `.internal`, `.localhost`) ou sem ponto. */
    private fun isLocal(host: String): Boolean =
        host.startsWith("[") || ':' in host || IPV4.matches(host) || '.' !in host || host == "localhost" ||
            listOf(".local", ".lan", ".internal", ".localhost", ".home", ".intranet").any { host.endsWith(it) }

    /** O `server` da leitura pública aponta para o mesmo host do QR? Se não, o app não o segue. */
    fun sameServer(link: CourierLink, server: String?): Boolean {
        val other = server?.trim()?.trimEnd('/')?.lowercase() ?: return true
        return other == link.server.lowercase()
    }
}

/**
 * `GET https://<host do QR>/api/public/c/<código>` com `Accept: application/json`: lê sem gastar o código. A URL é
 * sempre montada do host e do código, mesmo quando o QR lido for do formato antigo (`/c/`).
 */
@Serializable
data class CourierPreview(
    val valid: Boolean = false,
    /** O nome da loja (só com `valid`). */
    val store: String? = null,
    val server: String? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
)

/** Ponto no mapa. */
@Serializable
data class LatLng(val lat: Double, val lng: Double)

@Serializable
data class CourierEta(val minutes: Int? = null, val at: Long? = null, @SerialName("distance_m") val distanceM: Int? = null)

@Serializable
data class CourierOrderLine(val name: String = "", val quantity: Int = 1, val options: List<String> = emptyList(), val note: String = "")

@Serializable
data class CourierPayment(
    @SerialName("method_label") val methodLabel: String? = null,
    val status: String? = null,
    @SerialName("status_label") val statusLabel: String? = null,
    val paid: Boolean = false,
    @SerialName("change_for_cents") val changeForCents: Long? = null,
)

@Serializable
data class CourierOrder(
    val number: Int? = null,
    val lines: List<CourierOrderLine> = emptyList(),
    @SerialName("total_cents") val totalCents: Long? = null,
    @SerialName("customer_note") val customerNote: String = "",
    val payment: CourierPayment? = null,
)

@Serializable
data class CourierChat(@SerialName("last_seq") val lastSeq: Long = 0, @SerialName("customer_open") val customerOpen: Boolean? = null)

/** O ritmo que o servidor pede. Siga sempre o último recebido. */
@Serializable
data class CourierPace(
    @SerialName("sample_seconds") val sampleSeconds: Int = 15,
    @SerialName("upload_seconds") val uploadSeconds: Int = 60,
    @SerialName("near_upload_seconds") val nearUploadSeconds: Int = 30,
    @SerialName("stale_minutes") val staleMinutes: Int = 5,
)

/** `GET …/deliveries/{id}/courier`: o que o entregador vê (sem telefone, conversa do WhatsApp nem notas). */
@Serializable
data class CourierDelivery(
    val id: String,
    /** "Pedido nº 12". */
    val label: String = "Entrega",
    /** Só o primeiro nome. */
    @SerialName("customer_name") val customerName: String = "",
    @SerialName("address_text") val address: String = "",
    val destination: LatLng? = null,
    /** `assigned` (falta Iniciar rota), `en_route`, `delivered`, `cancelled`. */
    val status: String = "assigned",
    @SerialName("status_label") val statusLabel: String? = null,
    val eta: CourierEta? = null,
    val arriving: Boolean = false,
    val order: CourierOrder? = null,
    val chat: CourierChat? = null,
    val app: CourierPace? = null,
    /** A loja (da leitura pública do QR), só no app: a lista junta entregas de várias lojas. */
    @kotlinx.serialization.Transient val store: String? = null,
) {
    val enRoute: Boolean get() = status == "en_route"

    /** "2x X-Burger (sem cebola) — bem passado". */
    val items: List<String>
        get() = order?.lines.orEmpty().map { l ->
            buildString {
                append("${l.quantity}x ${l.name}")
                if (l.options.isNotEmpty()) append(" (${l.options.joinToString(", ")})")
                if (l.note.isNotBlank()) append(" — ${l.note}")
            }
        }

    /** "Dinheiro na entrega · R$ 57,00" ou "Pix · pago". */
    val paymentText: String?
        get() {
            val p = order?.payment
            val total = order?.totalCents?.let(Money::format)
            val method = p?.methodLabel?.takeIf { it.isNotBlank() }
            return when {
                p?.paid == true -> listOfNotNull(method, "pago").joinToString(" · ")
                method != null -> listOfNotNull(method, total?.let { "cobrar $it" }).joinToString(" · ")
                total != null -> "Total $total"
                else -> null
            }
        }

    val changeText: String? get() = order?.payment?.changeForCents?.takeIf { it > 0 }?.let { "Troco para ${Money.format(it)}" }
}

/** Uma leitura do GPS. `t` em ms Unix do aparelho. */
@Serializable
data class PositionPoint(val t: Long, val lat: Double, val lng: Double, val accuracy: Float? = null, val speed: Float? = null)

/** Resposta do lote: `active: false` encerra (pare o GPS e descarte a fila). */
@Serializable
data class PositionsReply(
    val active: Boolean = true,
    val status: String? = null,
    @SerialName("last_at") val lastAt: Long? = null,
    val eta: CourierEta? = null,
    val arriving: Boolean = false,
    val app: CourierPace? = null,
    val chat: CourierChat? = null,
) {
    /** Perto do destino: envio mais curto e GPS de alta precisão. */
    val near: Boolean get() = arriving || (eta?.distanceM?.let { it < 1000 } ?: false)
}

/** Com quem o entregador conversa pelo app (`channel`). */
enum class CourierParty(val wire: String, val label: String) {
    STORE("store", "Loja"),
    CUSTOMER("customer", "Cliente"),
}

@Serializable
data class CourierMessage(
    val seq: Long,
    /** `store` ou `customer`. */
    val channel: String,
    /** `courier`, `store` ou `customer`. */
    val sender: String,
    @SerialName("author_name") val authorName: String = "",
    val text: String,
    val created: Long,
) {
    val mine: Boolean get() = sender == "courier"
}

/** `GET …/messages?after=<seq>`. */
@Serializable
data class CourierMessagesPage(
    val data: List<CourierMessage> = emptyList(),
    @SerialName("last_seq") val lastSeq: Long = 0,
    @SerialName("customer_open") val customerOpen: Boolean? = null,
    val open: Boolean = true,
)

/** A credencial de uma entrega (`wabx_…`, uma por entrega): vale só para ela e some quando o servidor revoga. */
@Serializable
data class CourierSession(
    val server: String,
    val token: String,
    val profile: String,
    @SerialName("delivery_id") val deliveryId: String,
    @SerialName("expires_at") val expiresAt: Long? = null,
    /** O nome da loja, da leitura pública do QR: a lista junta entregas de várias lojas e mostra de qual é cada uma. */
    @SerialName("store_name") val storeName: String? = null,
) {
    val host: String get() = server.removePrefix("https://")
}

/** `401`: entrega concluída ou cancelada, QR substituído ou prazo vencido. O app esquece a entrega. */
class CourierRevoked(message: String = "Esta entrega não está mais com você.") : Exception(message)
