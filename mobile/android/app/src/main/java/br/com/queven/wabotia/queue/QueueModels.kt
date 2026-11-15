package br.com.queven.wabotia.queue

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * A fila de senhas do Wabotia (docs/FILA-SENHAS.md, contrato v1). Os mesmos modelos servem ao modo aparelho (totem,
 * painel e híbrido, com o token `wab_…` do pareamento) e ao guichê do app logado (token `wabu_…` da pessoa).
 * Tudo o que pode faltar tem valor padrão ou é anulável: o servidor evolui e o JSON tolera campos novos.
 */

@Serializable
data class Waiting(val normal: Int = 0, val preferential: Int = 0) {
    val total: Int get() = normal + preferential
}

/** Espera estimada por tipo; `null` quando a fila não mostra estimativa (`wait_mode: off`). */
@Serializable
data class WaitMinutes(val normal: Int? = null, val preferential: Int? = null)

@Serializable
data class QueueInfo(
    val id: String,
    val name: String = "",
    @SerialName("prefix_normal") val prefixNormal: String? = null,
    @SerialName("prefix_preferential") val prefixPreferential: String? = null,
    @SerialName("preferential_notice") val preferentialNotice: String? = null,
    @SerialName("normals_per_preferential") val normalsPerPreferential: Int? = null,
    val priority: Int = 0,
    @SerialName("wait_mode") val waitMode: String? = null,
    val channels: List<String>? = null,
    val enabled: Boolean = true,
    val waiting: Waiting? = null,
    @SerialName("wait_minutes") val waitMinutes: WaitMinutes? = null,
    @SerialName("open_counters") val openCounters: Int = 0,
) {
    /** O totem só oferece filas ativas com o canal `kiosk`. */
    val kiosk: Boolean get() = enabled && channels.orEmpty().contains("kiosk")
}

@Serializable
data class QueueTicket(
    val id: String,
    @SerialName("queue_id") val queueId: String = "",
    @SerialName("queue_name") val queueName: String? = null,
    val code: String = "",
    val preferential: Boolean = false,
    val source: String? = null,
    val status: String = "waiting",
    @SerialName("counter_id") val counterId: String? = null,
    @SerialName("counter_name") val counterName: String? = null,
    @SerialName("call_count") val callCount: Int = 0,
    val ahead: Int? = null,
    @SerialName("wait_minutes") val waitMinutes: Int? = null,
    /** Só para a equipe. */
    val phone: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    /** O cliente pode receber texto livre agora (janela de 24 h aberta). */
    @SerialName("window_open") val windowOpen: Boolean? = null,
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("called_at") val calledAt: Long? = null,
    @SerialName("started_at") val startedAt: Long? = null,
    @SerialName("finished_at") val finishedAt: Long? = null,
    @SerialName("service_day") val serviceDay: String? = null,
    @SerialName("public_token") val publicToken: String? = null,
    @SerialName("whatsapp_link") val whatsappLink: String? = null,
) {
    val typeLabel: String get() = if (preferential) "Preferencial" else "Normal"
}

@Serializable
data class CounterInfo(
    val id: String,
    val name: String = "",
    @SerialName("queue_ids") val queueIds: List<String>? = null,
    /** `open`, `paused` ou `closed`. */
    val status: String = "closed",
    val enabled: Boolean = true,
    @SerialName("user_id") val userId: String? = null,
    @SerialName("user_name") val userName: String? = null,
    val current: QueueTicket? = null,
)

@Serializable
data class CallFrame(
    @SerialName("ticket_id") val ticketId: String,
    val code: String = "",
    val preferential: Boolean = false,
    @SerialName("queue_id") val queueId: String? = null,
    @SerialName("queue_name") val queueName: String? = null,
    @SerialName("counter_id") val counterId: String? = null,
    @SerialName("counter_name") val counterName: String? = null,
    @SerialName("call_count") val callCount: Int = 1,
    val recall: Boolean = false,
    val at: Long = 0,
    val speech: String? = null,
) {
    /** Uma chamada é a mesma senha na mesma vez: rechamar soma `call_count` e conta como chamada nova. */
    val key: String get() = "$ticketId#$callCount"
}

@Serializable
data class QueueSettings(
    @SerialName("front_door") val frontDoor: Boolean? = null,
    @SerialName("notify_ahead") val notifyAhead: Int? = null,
)

@Serializable
data class QueueOverview(
    val day: String? = null,
    val settings: QueueSettings? = null,
    val queues: List<QueueInfo>? = null,
    val counters: List<CounterInfo>? = null,
    @SerialName("recent_calls") val recentCalls: List<CallFrame>? = null,
)

/** Resposta de `POST /api/pairing/start`. */
@Serializable
data class PairingStart(
    @SerialName("device_code") val deviceCode: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String? = null,
    @SerialName("expires_in") val expiresIn: Int = 600,
    val interval: Int = 5,
)

/** Resposta de `POST /api/pairing/token`: `authorization_pending` ou `connected` com a credencial. */
@Serializable
data class PairingToken(
    val status: String,
    @SerialName("access_token") val accessToken: String? = null,
    @SerialName("profile_id") val profileId: String? = null,
    @SerialName("expires_in") val expiresIn: Long? = null,
    val scopes: List<String>? = null,
    val interval: Int? = null,
)

/** As permissões de fila que o modo aparelho pede: ler e emitir, sem operar (o guichê fica no app logado). */
object DeviceScopes {
    const val READ = "queue:read"
    const val ISSUE = "queue:issue"
    const val OPERATE = "queue:operate"
    const val EVENTS = "events:read"
    val requested = listOf(READ, ISSUE)
}
