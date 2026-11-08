package br.com.queven.wabotia.core.push

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import br.com.queven.wabotia.WabotiaApp
import br.com.queven.wabotia.core.net.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Ações das notificações que não abrem o app: recusar ligação recebida e registrar que a pessoa
 * descartou uma notificação (para zerar o histórico agrupado daquela conversa/protocolo).
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_DECLINE_CALL -> {
                val profile = intent.getStringExtra(EXTRA_PROFILE_ID) ?: return
                val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
                Notifications.cancelIncomingCall(context, callId)
                val container = WabotiaApp.instance.container
                if (!container.auth.value.isLoggedIn) return
                val result = goAsync()
                container.scope.launch(Dispatchers.IO) {
                    try {
                        val api = container.api
                        // Recusar exige assumir a ligação antes (mesma sequência do painel web).
                        runCatching { api.claimCall(profile, callId, ApiClient.newIdempotencyKey(), JsonObject(emptyMap())) }
                        api.rejectCall(profile, callId, ApiClient.newIdempotencyKey(), JsonObject(emptyMap()))
                    } catch (_: Exception) {
                    } finally {
                        result.finish()
                    }
                }
            }
            ACTION_DISMISSED -> {
                val tag = intent.getStringExtra(EXTRA_TAG) ?: return
                val group = intent.getStringExtra(EXTRA_GROUP) ?: Notifications.GROUP_OTHER
                Notifications.onDismissed(context, tag, group)
            }
        }
    }

    companion object {
        const val ACTION_DECLINE_CALL = "br.com.queven.wabotia.DECLINE_CALL"
        const val ACTION_DISMISSED = "br.com.queven.wabotia.NOTIFICATION_DISMISSED"
        private const val EXTRA_PROFILE_ID = "profile_id"
        private const val EXTRA_CALL_ID = "call_id"
        private const val EXTRA_TAG = "tag"
        private const val EXTRA_GROUP = "group"

        fun declineIntent(context: Context, data: Map<String, String>): PendingIntent {
            val intent = Intent(context, NotificationActionReceiver::class.java)
                .setAction(ACTION_DECLINE_CALL)
                .putExtra(EXTRA_PROFILE_ID, data["profile_id"])
                .putExtra(EXTRA_CALL_ID, data["call_id"])
            return PendingIntent.getBroadcast(
                context, (data["call_id"] ?: "call").hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        /** Intent de descarte (deleteIntent) de uma notificação agrupada. */
        fun dismissedIntent(context: Context, tag: String, group: String): PendingIntent {
            val intent = Intent(context, NotificationActionReceiver::class.java)
                .setAction(ACTION_DISMISSED)
                .putExtra(EXTRA_TAG, tag)
                .putExtra(EXTRA_GROUP, group)
            return PendingIntent.getBroadcast(
                context, ("dismiss:$tag").hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
