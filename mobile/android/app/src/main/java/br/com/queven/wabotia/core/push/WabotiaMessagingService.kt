package br.com.queven.wabotia.core.push

import br.com.queven.wabotia.WabotiaApp
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Recebe o token FCM e as notificações. O servidor envia `notification` (título/corpo) + `data`;
 * em primeiro plano o Android entrega aqui e o app decide mostrar (ligações sempre são mostradas).
 */
class WabotiaMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val container = WabotiaApp.instance.container
        if (container.session.pushToken == token) return
        container.session.pushToken = token
        // Token novo invalida o registro anterior no servidor.
        container.session.registeredPushToken = null
        PushRegistrar.registerIfNeeded(container, force = true)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val container = WabotiaApp.instance.container
        val session = container.session
        val data = message.data
        val type = data["type"] ?: "message"
        // Sem sessão não há o que abrir; só avisos de teste e ligações ignoram a preferência local.
        if (!container.auth.value.isLoggedIn) return
        if (!session.notificationsEnabled && type != "call" && type != "test") return
        // Só mostra avisos do servidor em que a pessoa está conectada.
        val server = data["server"]?.trim()?.trimEnd('/')
        val current = session.serverUrl
        if (!server.isNullOrBlank() && current != null && !server.equals(current, ignoreCase = true)) return
        val title = message.notification?.title ?: data["title"] ?: "Wabotia"
        val body = message.notification?.body ?: data["body"] ?: when (type) {
            "queue" -> "Novo atendimento na fila"
            "transfer" -> "Atendimento transferido para você"
            "call" -> getString(br.com.queven.wabotia.R.string.notification_call_incoming)
            "test" -> "Notificação de teste recebida"
            else -> "Nova mensagem"
        }
        if (type == "call" && data["call_id"] != null) {
            IncomingCallBus.announce(data)
        }
        Notifications.show(applicationContext, title, body, data)
    }
}
