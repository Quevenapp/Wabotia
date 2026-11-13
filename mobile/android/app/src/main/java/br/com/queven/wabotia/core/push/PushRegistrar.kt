package br.com.queven.wabotia.core.push

import android.os.Build
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.DeviceRegistration
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.SerializationException

/**
 * Registra o token FCM no servidor (PUT /api/v1/devices/{id}) depois do login, quando o token muda e
 * quando a pessoa liga/desliga notificações. `profiles` vazio = recebe de todos os perfis autorizados.
 */
object PushRegistrar {
    /** Nome do aparelho enviado ao servidor e mostrado na aba Mais. */
    fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifBlank { "Android" }.take(80)

    /** Versão fire-and-forget usada no login, na abertura do app e quando o FCM troca o token. */
    fun registerIfNeeded(container: AppContainer, force: Boolean = false) {
        if (!container.auth.value.isLoggedIn) return
        container.scope.launch(Dispatchers.IO) {
            try {
                register(container, force)
            } catch (_: Exception) {
                // Sem rede ou servidor indisponível: tenta de novo no próximo login/abertura.
            }
        }
    }

    /**
     * Registra agora. Devolve false quando não há token FCM (Firebase não configurado neste build ou Play
     * Services ausente) e true quando o servidor aceitou ou o mesmo token já estava registrado.
     * Lança [ApiException]/[java.io.IOException] em falhas de rede/API para a interface mostrar o motivo.
     */
    suspend fun register(container: AppContainer, force: Boolean = false): Boolean {
        val session = container.session
        if (!container.auth.value.isLoggedIn) return false
        val token = session.pushToken ?: runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
        if (token.isNullOrBlank()) return false
        session.pushToken = token
        if (!force && session.registeredPushToken == token) return true
        val body = DeviceRegistration(
            platform = "android",
            provider = "fcm",
            token = token,
            name = deviceName(),
            app_version = BuildConfig.VERSION_NAME,
            profiles = emptyList(),
            enabled = session.notificationsEnabled,
        )
        try {
            container.api.registerDevice(session.deviceId, body)
        } catch (_: SerializationException) {
            // O servidor aceitou (2xx), mas a resposta não pôde ser decodificada. O registro valeu.
        } catch (e: ApiException) {
            if (e.isUnauthorized) container.onLoggedOut(keepServer = true)
            throw e
        }
        session.registeredPushToken = token
        return true
    }

    /** Liga/desliga notificações neste aparelho e atualiza `enabled` no servidor (mesma semântica de [register]). */
    suspend fun setEnabled(container: AppContainer, enabled: Boolean): Boolean {
        container.session.notificationsEnabled = enabled
        return register(container, force = true)
    }

    /** DELETE /api/v1/devices/{id}; chamado antes de sair da conta. Nunca lança. */
    suspend fun unregister(container: AppContainer) {
        try {
            container.api.deleteDevice(container.session.deviceId)
        } catch (_: Exception) {
        } finally {
            container.session.registeredPushToken = null
        }
    }

    fun newKey() = ApiClient.newIdempotencyKey()
}
