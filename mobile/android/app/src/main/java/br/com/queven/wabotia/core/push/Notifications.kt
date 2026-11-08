package br.com.queven.wabotia.core.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import br.com.queven.wabotia.MainActivity
import br.com.queven.wabotia.R
import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

/**
 * Canais e montagem das notificações. O payload `data` do push segue docs/MOBILE.md:
 * type (message|queue|transfer|ticket|ticket_due|call|test), profile_id, conversation_id, ticket_id, call_id, server.
 *
 * Agrupamento: uma notificação por conversa (tag `conversation:{id}`) que acumula as últimas mensagens em
 * estilo caixa de entrada; uma por protocolo (`ticket:{id}`); um resumo por grupo (conversas / protocolos)
 * com a contagem total (badge). A tela de conversa chama [cancelConversation] ao abrir e mantém
 * [visibleConversationId] enquanto estiver visível para que novos avisos dela não apareçam.
 */
object Notifications {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_QUEUE = "queue"
    const val CHANNEL_TICKETS = "tickets"
    const val CHANNEL_CALLS = "calls"
    const val CHANNEL_CALL_SERVICE = "call_service"
    const val INCOMING_CALL_ID = 9001

    /** Id usado por todas as notificações individuais (a distinção é feita pela tag). */
    const val ITEM_ID = 1
    /** Id dos resumos de grupo (tag = nome do grupo). */
    const val SUMMARY_ID = 2

    const val GROUP_CONVERSATIONS = "conversations"
    const val GROUP_TICKETS = "tickets"
    const val GROUP_OTHER = "other"

    private const val PREFS = "wabotia.notifications"
    private const val MAX_LINES = 6
    private const val MAX_STORED_LINES = 12

    /**
     * Conversa aberta em primeiro plano (definida pela tela de conversa em onResume/onPause).
     * Pushes dessa conversa não viram notificação enquanto ela estiver visível.
     */
    @Volatile
    var visibleConversationId: String? = null

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        fun channel(id: String, name: Int, desc: Int, importance: Int, sound: Uri? = null, vibrate: Boolean = true, badge: Boolean = true) =
            NotificationChannel(id, context.getString(name), importance).apply {
                description = context.getString(desc)
                enableVibration(vibrate)
                setShowBadge(badge)
                if (sound != null) setSound(
                    sound,
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                )
            }
        manager.createNotificationChannels(
            listOf(
                channel(CHANNEL_MESSAGES, R.string.channel_messages, R.string.channel_messages_desc, NotificationManager.IMPORTANCE_HIGH),
                channel(CHANNEL_QUEUE, R.string.channel_queue, R.string.channel_queue_desc, NotificationManager.IMPORTANCE_HIGH),
                channel(CHANNEL_TICKETS, R.string.channel_tickets, R.string.channel_tickets_desc, NotificationManager.IMPORTANCE_DEFAULT),
                channel(
                    CHANNEL_CALLS, R.string.channel_calls, R.string.channel_calls_desc, NotificationManager.IMPORTANCE_HIGH,
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                ),
                channel(CHANNEL_CALL_SERVICE, R.string.channel_call_service, R.string.channel_call_service, NotificationManager.IMPORTANCE_LOW, vibrate = false, badge = false),
            ),
        )
    }

    /** Intent que abre a tela certa (também usada pelo deep link wabotia://open). */
    fun openIntent(context: Context, data: Map<String, String>): Intent {
        val uri = Uri.Builder().scheme("wabotia").authority("open").appendPath(data["type"] ?: "message").apply {
            data["profile_id"]?.let { appendQueryParameter("profile", it) }
            data["conversation_id"]?.let { appendQueryParameter("conversation", it) }
            data["ticket_id"]?.let { appendQueryParameter("ticket", it) }
            data["call_id"]?.let { appendQueryParameter("call", it) }
        }.build()
        return Intent(Intent.ACTION_VIEW, uri, context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }

    fun conversationTag(conversationId: String) = "conversation:$conversationId"
    fun ticketTag(ticketId: String) = "ticket:$ticketId"

    fun channelFor(type: String): String = when (type) {
        "queue", "transfer" -> CHANNEL_QUEUE
        "ticket", "ticket_due" -> CHANNEL_TICKETS
        "call" -> CHANNEL_CALLS
        else -> CHANNEL_MESSAGES
    }

    fun groupFor(type: String): String = when (type) {
        "message", "queue", "transfer" -> GROUP_CONVERSATIONS
        "ticket", "ticket_due" -> GROUP_TICKETS
        else -> GROUP_OTHER
    }

    /** Monta e exibe a notificação de um push. Ligações têm tratamento próprio (tela cheia, Atender/Recusar). */
    fun show(context: Context, title: String, body: String, data: Map<String, String>) {
        val type = data["type"] ?: "message"
        if (type == "call") {
            showIncomingCall(context, title, body, data)
            return
        }
        val conversationId = data["conversation_id"]?.takeIf { it.isNotBlank() }
        val ticketId = data["ticket_id"]?.takeIf { it.isNotBlank() }
        if (conversationId != null && conversationId == visibleConversationId) return

        val channel = channelFor(type)
        val group = groupFor(type)
        val tag = when {
            conversationId != null -> conversationTag(conversationId)
            ticketId != null -> ticketTag(ticketId)
            else -> "type:$type"
        }
        val lines = appendLine(context, tag, body)
        val pending = PendingIntent.getActivity(
            context, tag.hashCode(), openIntent(context, data),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setDeleteIntent(NotificationActionReceiver.dismissedIntent(context, tag, group))
            .setCategory(if (type == "ticket" || type == "ticket_due") NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (type == "ticket" || type == "ticket_due") NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .setGroup(group)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setNumber(lines.size)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
        if (lines.size > 1) {
            val style = NotificationCompat.InboxStyle().setBigContentTitle(title).setSummaryText(countLabel(lines.size))
            lines.takeLast(MAX_LINES).forEach { style.addLine(it) }
            builder.setStyle(style)
        } else {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }
        notifySafely(context, tag, ITEM_ID, builder.build())
        updateSummary(context, group)
    }

    private fun showIncomingCall(context: Context, title: String, body: String, data: Map<String, String>) {
        val tag = data["call_id"] ?: "call"
        val pending = PendingIntent.getActivity(
            context, tag.hashCode(), openIntent(context, data),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { context.getString(R.string.notification_call_incoming) })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setFullScreenIntent(pending, true)
            .setOngoing(true)
            .setTimeoutAfter(90_000)
            .addAction(0, context.getString(R.string.action_answer), pending)
            .addAction(0, context.getString(R.string.action_decline), NotificationActionReceiver.declineIntent(context, data))
        notifySafely(context, tag, INCOMING_CALL_ID, builder.build())
    }

    fun cancelIncomingCall(context: Context, callId: String?) {
        NotificationManagerCompat.from(context).cancel(callId ?: "call", INCOMING_CALL_ID)
    }

    /** Chamado pela tela de conversa ao abrir: remove a notificação daquela conversa e atualiza o resumo/badge. */
    fun cancelConversation(context: Context, conversationId: String) {
        val tag = conversationTag(conversationId)
        NotificationManagerCompat.from(context).cancel(tag, ITEM_ID)
        forget(context, tag)
        updateSummary(context, GROUP_CONVERSATIONS, excludeTag = tag)
    }

    /** Chamado pela tela de protocolo ao abrir. */
    fun cancelTicket(context: Context, ticketId: String) {
        val tag = ticketTag(ticketId)
        NotificationManagerCompat.from(context).cancel(tag, ITEM_ID)
        forget(context, tag)
        updateSummary(context, GROUP_TICKETS, excludeTag = tag)
    }

    /** Remove todas as notificações do app (usado ao sair da conta). */
    fun cancelAll(context: Context) {
        NotificationManagerCompat.from(context).cancelAll()
        runCatching { prefs(context).edit().clear().apply() }
    }

    /** Notificação descartada pela pessoa (deslizou): esquece o histórico da tag e refaz o resumo. */
    fun onDismissed(context: Context, tag: String, group: String) {
        forget(context, tag)
        updateSummary(context, group, excludeTag = tag)
    }

    /** Total de notificações individuais ativas (badge simples). */
    fun activeCount(context: Context): Int {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return 0
        return runCatching {
            manager.activeNotifications.filter { it.id == ITEM_ID }.sumOf { maxOf(1, it.notification.number) }
        }.getOrDefault(0)
    }

    // --- internos ---

    private fun updateSummary(context: Context, group: String, excludeTag: String? = null) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val children = runCatching {
            manager.activeNotifications.filter { it.id == ITEM_ID && it.notification.group == group && it.tag != excludeTag }
        }.getOrDefault(emptyList())
        if (children.isEmpty()) {
            manager.cancel(group, SUMMARY_ID)
            return
        }
        val total = children.sumOf { maxOf(1, it.notification.number) }
        val (channel, title, type) = when (group) {
            GROUP_TICKETS -> Triple(CHANNEL_TICKETS, "Protocolos", "ticket")
            GROUP_CONVERSATIONS -> Triple(CHANNEL_MESSAGES, "Conversas", "message")
            else -> Triple(CHANNEL_MESSAGES, "Wabotia", "message")
        }
        val style = NotificationCompat.InboxStyle().setBigContentTitle(title).setSummaryText(countLabel(total))
        children.sortedByDescending { it.postTime }.take(MAX_LINES).forEach { sbn ->
            val extras = sbn.notification.extras
            val t = extras?.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString().orEmpty()
            val b = extras?.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString().orEmpty()
            style.addLine(if (t.isBlank()) b else "$t: $b")
        }
        val pending = PendingIntent.getActivity(
            context, group.hashCode(), openIntent(context, mapOf("type" to type)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val summary = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(countLabel(total))
            .setStyle(style)
            .setGroup(group)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setNumber(total)
            .setContentIntent(pending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        notifySafely(context, group, SUMMARY_ID, summary)
    }

    private fun countLabel(n: Int) = if (n == 1) "1 nova notificação" else "$n novas notificações"

    private fun notifySafely(context: Context, tag: String, id: Int, notification: android.app.Notification) {
        try {
            NotificationManagerCompat.from(context).notify(tag, id, notification)
        } catch (_: SecurityException) {
            // Permissão POST_NOTIFICATIONS negada; o app continua funcionando sem avisos.
        }
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val linesSerializer = ListSerializer(String.serializer())

    /** Acrescenta a linha ao histórico da tag (persistido: o processo pode morrer entre pushes) e devolve a lista. */
    private fun appendLine(context: Context, tag: String, line: String): List<String> {
        val current = readLines(context, tag)
        val updated = (if (line.isBlank()) current else current + line).takeLast(MAX_STORED_LINES)
        runCatching {
            prefs(context).edit().putString(tag, WabotiaJson.encodeToString(linesSerializer, updated)).apply()
        }
        return updated.ifEmpty { listOf(line) }
    }

    private fun readLines(context: Context, tag: String): List<String> {
        val raw = runCatching { prefs(context).getString(tag, null) }.getOrNull() ?: return emptyList()
        return runCatching { WabotiaJson.decodeFromString(linesSerializer, raw) }.getOrDefault(emptyList())
    }

    private fun forget(context: Context, tag: String) {
        runCatching { prefs(context).edit().remove(tag).apply() }
    }
}
