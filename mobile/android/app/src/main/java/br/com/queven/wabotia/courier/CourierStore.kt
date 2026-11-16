package br.com.queven.wabotia.courier

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.serialization.builtins.ListSerializer

/** As credenciais das entregas em andamento, para reabrir o app e continuar de onde parou. */
interface CourierSessionStore {
    fun load(): List<CourierSession>
    fun save(sessions: List<CourierSession>)
}

/** Na demonstração (e nos testes): só na memória. */
class MemoryCourierSessionStore : CourierSessionStore {
    private var sessions = emptyList<CourierSession>()
    override fun load() = sessions
    override fun save(sessions: List<CourierSession>) {
        this.sessions = sessions
    }
}

/**
 * Cifradas com o Keystore, como o token da pessoa. Sem Keystore, ficam só na memória: reabrir o app pede para escanear
 * de novo, nunca grava credencial em texto aberto.
 */
class SecureCourierSessionStore(context: Context) : CourierSessionStore {
    private val prefs: SharedPreferences? = try {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "wabotia.courier",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        null
    }
    private val memory = MemoryCourierSessionStore()
    private val serializer = ListSerializer(CourierSession.serializer())

    override fun load(): List<CourierSession> {
        val p = prefs ?: return memory.load()
        val raw = p.getString(KEY, null) ?: return emptyList()
        return runCatching { WabotiaJson.decodeFromString(serializer, raw) }.getOrDefault(emptyList())
    }

    override fun save(sessions: List<CourierSession>) {
        val p = prefs ?: return memory.save(sessions)
        if (sessions.isEmpty()) p.edit().remove(KEY).apply() else p.edit().putString(KEY, WabotiaJson.encodeToString(serializer, sessions)).apply()
    }

    private companion object {
        const val KEY = "sessions"
    }
}
