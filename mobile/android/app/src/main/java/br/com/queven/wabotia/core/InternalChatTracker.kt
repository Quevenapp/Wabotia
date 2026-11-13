package br.com.queven.wabotia.core

import android.content.Context
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import br.com.queven.wabotia.core.model.InternalChat
import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/**
 * Conversas internas não lidas. O servidor não guarda leitura de conversa interna; o app compara o `updated` de cada
 * conversa com o último valor visto neste aparelho (gravado quando a conversa está aberta na tela).
 */
class InternalChatTracker(private val container: AppContainer) {
    /** `chat id` → `updated` visto por último. */
    val seen: SnapshotStateMap<String, Long> = mutableStateMapOf()

    private var loadedProfile: String? = null
    private var hasBaseline = false
    private val prefs get() = container.appContext.getSharedPreferences("wabotia.cache", Context.MODE_PRIVATE)
    private val serializer = MapSerializer(String.serializer(), Long.serializer())

    @Synchronized
    fun use(profileId: String?) {
        if (profileId == loadedProfile) return
        loadedProfile = profileId
        seen.clear()
        hasBaseline = false
        if (profileId == null) return
        val stored = prefs.getString("internal_seen.$profileId", null)
        if (stored != null) {
            hasBaseline = true
            runCatching { WabotiaJson.decodeFromString(serializer, stored) }.getOrNull()?.let { seen.putAll(it) }
        }
    }

    /** Na primeira lista de um perfil neste aparelho, tudo o que já existe conta como lido. */
    fun baseline(chats: List<InternalChat>) {
        if (hasBaseline || loadedProfile == null) return
        hasBaseline = true
        chats.forEach { seen[it.id] = it.updated }
        persist()
    }

    fun isUnread(chat: InternalChat): Boolean = hasBaseline && chat.updated > (seen[chat.id] ?: 0L)

    fun unreadCount(chats: List<InternalChat>): Int = chats.count { isUnread(it) }

    /** Chame enquanto a conversa interna está aberta (ao abrir e a cada atualização). */
    fun markSeen(chatId: String, updated: Long) {
        val value = maxOf(updated, System.currentTimeMillis())
        if ((seen[chatId] ?: 0L) >= value) return
        seen[chatId] = value
        hasBaseline = true
        persist()
    }

    private fun persist() {
        val profile = loadedProfile ?: return
        prefs.edit().putString("internal_seen.$profile", WabotiaJson.encodeToString(serializer, seen.toMap())).apply()
    }

    fun clear() {
        seen.clear()
        loadedProfile = null
        hasBaseline = false
    }
}
