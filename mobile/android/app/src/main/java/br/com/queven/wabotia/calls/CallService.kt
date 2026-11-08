package br.com.queven.wabotia.calls

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import br.com.queven.wabotia.MainActivity
import br.com.queven.wabotia.R
import br.com.queven.wabotia.core.push.Notifications

/**
 * Serviço em primeiro plano que mantém a ligação de voz viva com a tela desligada
 * (tipo phoneCall|microphone). A lógica WebRTC fica em [CallEngine]; este serviço só
 * garante a notificação persistente e o ciclo de vida do processo durante a chamada.
 */
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                val label = intent?.getStringExtra(EXTRA_LABEL) ?: getString(R.string.channel_call_service)
                val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                else 0
                ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(label), type)
                return START_NOT_STICKY
            }
        }
    }

    private fun buildNotification(label: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, Notifications.CHANNEL_CALL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.channel_call_service))
            .setContentText(label)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .build()
    }

    companion object {
        const val NOTIFICATION_ID = 9002
        const val ACTION_STOP = "br.com.queven.wabotia.CALL_STOP"
        const val EXTRA_LABEL = "label"

        fun start(context: Context, label: String) {
            val intent = Intent(context, CallService::class.java).putExtra(EXTRA_LABEL, label)
            context.startForegroundService(intent)
        }

        /** Para o serviço e remove a notificação; funciona também com o app em segundo plano. */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, CallService::class.java))
            } catch (_: Exception) {
                // Último recurso: pede ao serviço que se encerre.
                runCatching { context.startService(Intent(context, CallService::class.java).setAction(ACTION_STOP)) }
            }
        }
    }
}
