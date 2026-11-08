package br.com.queven.wabotia.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import br.com.queven.wabotia.core.model.User
import br.com.queven.wabotia.core.model.WabotiaJson
import java.util.UUID

/**
 * Guarda servidor, token de sessão (wabu_...), usuário e preferências locais.
 * O token fica em EncryptedSharedPreferences; o restante em SharedPreferences comum.
 */
class SessionStore(context: Context) {
    private val secure: SharedPreferences = try {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "wabotia.secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        // Keystore indisponível (emuladores antigos): mantém funcionamento com armazenamento comum.
        context.getSharedPreferences("wabotia.secure.fallback", Context.MODE_PRIVATE)
    }
    private val prefs: SharedPreferences = context.getSharedPreferences("wabotia.prefs", Context.MODE_PRIVATE)

    /** Endereço normalizado, sem barra final, ex.: https://wabotia.queven.com.br */
    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER, null)
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    var token: String?
        get() = secure.getString(KEY_TOKEN, null)
        set(value) = secure.edit().putString(KEY_TOKEN, value).apply()

    var tokenExpires: Long
        get() = prefs.getLong(KEY_TOKEN_EXPIRES, 0L)
        set(value) = prefs.edit().putLong(KEY_TOKEN_EXPIRES, value).apply()

    var user: User?
        get() = prefs.getString(KEY_USER, null)?.let { runCatching { WabotiaJson.decodeFromString(User.serializer(), it) }.getOrNull() }
        set(value) = prefs.edit().putString(KEY_USER, value?.let { WabotiaJson.encodeToString(User.serializer(), it) }).apply()

    var profileId: String?
        get() = prefs.getString(KEY_PROFILE, null)
        set(value) = prefs.edit().putString(KEY_PROFILE, value).apply()

    /** Identificador estável desta instalação, usado em PUT /api/v1/devices/{id}. */
    val deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    var pushToken: String?
        get() = prefs.getString(KEY_PUSH_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_PUSH_TOKEN, value).apply()

    /** Token FCM já registrado no servidor (para evitar PUT repetido). */
    var registeredPushToken: String?
        get() = prefs.getString(KEY_PUSH_REGISTERED, null)
        set(value) = prefs.edit().putString(KEY_PUSH_REGISTERED, value).apply()

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATIONS, true)
        set(value) = prefs.edit().putBoolean(KEY_NOTIFICATIONS, value).apply()

    /** Último cursor de eventos consultado por perfil. */
    fun eventCursor(profileId: String): Long = prefs.getLong("$KEY_EVENT_CURSOR.$profileId", 0L)
    fun setEventCursor(profileId: String, cursor: Long) = prefs.edit().putLong("$KEY_EVENT_CURSOR.$profileId", cursor).apply()

    fun clearSession() {
        secure.edit().remove(KEY_TOKEN).apply()
        prefs.edit()
            .remove(KEY_SERVER)
            .remove(KEY_TOKEN_EXPIRES)
            .remove(KEY_USER)
            .remove(KEY_PROFILE)
            .remove(KEY_PUSH_REGISTERED)
            .apply()
    }

    companion object {
        private const val KEY_SERVER = "server"
        private const val KEY_TOKEN = "token"
        private const val KEY_TOKEN_EXPIRES = "token_expires"
        private const val KEY_USER = "user"
        private const val KEY_PROFILE = "profile"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PUSH_TOKEN = "push_token"
        private const val KEY_PUSH_REGISTERED = "push_registered"
        private const val KEY_NOTIFICATIONS = "notifications"
        private const val KEY_EVENT_CURSOR = "event_cursor"

        /** Normaliza o que a pessoa digitou: aceita "wabotia.exemplo.com.br", "https://…/app", etc. */
        fun normalizeServer(input: String): String? {
            var s = input.trim()
            if (s.isEmpty()) return null
            if (!s.contains("://")) s = "https://$s"
            val uri = runCatching { java.net.URI(s) }.getOrNull() ?: return null
            val host = uri.host ?: return null
            val scheme = uri.scheme?.lowercase() ?: "https"
            if (scheme != "https" && scheme != "http") return null
            val port = if (uri.port > 0 && !((scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80))) ":${uri.port}" else ""
            return "$scheme://$host$port"
        }
    }
}
