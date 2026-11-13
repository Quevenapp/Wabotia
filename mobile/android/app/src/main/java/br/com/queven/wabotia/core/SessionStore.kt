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
 * O token fica em EncryptedSharedPreferences; o restante em SharedPreferences comum. O token nunca é gravado sem
 * criptografia: se o Keystore falhar, ele vive só na memória e a pessoa entra de novo na próxima abertura.
 */
class SessionStore(context: Context) {
    /** Null quando o Keystore não está disponível neste aparelho. */
    private val secure: SharedPreferences? = try {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "wabotia.secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        null
    }

    /** Token da sessão atual quando não há como gravá-lo cifrado. */
    @Volatile private var memoryToken: String? = null

    /** True quando a última gravação cifrada falhou: o que estiver no disco não vale mais. */
    @Volatile private var diskTokenStale = false

    init {
        // Versões antigas gravavam o token em texto puro neste arquivo quando o Keystore falhava.
        runCatching { context.deleteSharedPreferences("wabotia.secure.fallback") }
    }
    private val prefs: SharedPreferences = context.getSharedPreferences("wabotia.prefs", Context.MODE_PRIVATE)

    /** Endereço normalizado, sem barra final, ex.: https://wabotia.queven.com.br */
    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER, null)
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    var token: String?
        get() = memoryToken ?: if (diskTokenStale) null else runCatching { secure?.getString(KEY_TOKEN, null) }.getOrNull()
        set(value) {
            val store = secure
            val stored = store != null && runCatching {
                store.edit().apply { if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value) }.commit()
            }.getOrDefault(false)
            // Gravado cifrado: a memória não precisa guardar. Falhou: fica só na memória até o app fechar.
            memoryToken = if (stored) null else value
            diskTokenStale = !stored
        }

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

    /** True depois que o app já pediu a permissão de notificações do Android (pede uma vez, após o primeiro login). */
    var notificationPermissionAsked: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATION_ASKED, false)
        set(value) = prefs.edit().putBoolean(KEY_NOTIFICATION_ASKED, value).apply()

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATIONS, true)
        set(value) = prefs.edit().putBoolean(KEY_NOTIFICATIONS, value).apply()

    /** Aparência escolhida em Ajustes: system | light | dark. */
    var themeMode: String
        get() = prefs.getString(KEY_THEME, "system") ?: "system"
        set(value) = prefs.edit().putString(KEY_THEME, value).apply()

    /** Último cursor de eventos consultado por perfil. */
    fun eventCursor(profileId: String): Long = prefs.getLong("$KEY_EVENT_CURSOR.$profileId", 0L)
    fun setEventCursor(profileId: String, cursor: Long) = prefs.edit().putLong("$KEY_EVENT_CURSOR.$profileId", cursor).apply()

    /**
     * Apaga tudo o que é da conta: token, servidor, usuário, perfil, registro de push e cursores de eventos.
     * Ficam só as preferências do aparelho (identificador da instalação, token FCM, notificações e aparência).
     */
    fun clearSession() {
        token = null
        val editor = prefs.edit()
            .remove(KEY_SERVER)
            .remove(KEY_TOKEN_EXPIRES)
            .remove(KEY_USER)
            .remove(KEY_PROFILE)
            .remove(KEY_PUSH_REGISTERED)
        prefs.all.keys.filter { it.startsWith("$KEY_EVENT_CURSOR.") }.forEach { editor.remove(it) }
        editor.apply()
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
        private const val KEY_NOTIFICATION_ASKED = "notification_permission_asked"
        private const val KEY_EVENT_CURSOR = "event_cursor"
        private const val KEY_THEME = "theme_mode"

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
