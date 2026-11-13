package br.com.queven.wabotia.core.push

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Ação de notificação que não abre o app: registrar que a pessoa descartou uma notificação
 * (para zerar o histórico agrupado daquela conversa/protocolo).
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_DISMISSED -> {
                val tag = intent.getStringExtra(EXTRA_TAG) ?: return
                val group = intent.getStringExtra(EXTRA_GROUP) ?: Notifications.GROUP_OTHER
                Notifications.onDismissed(context, tag, group)
            }
        }
    }

    companion object {
        const val ACTION_DISMISSED = "br.com.queven.wabotia.NOTIFICATION_DISMISSED"
        private const val EXTRA_TAG = "tag"
        private const val EXTRA_GROUP = "group"

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
