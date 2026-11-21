package br.com.queven.wabotia.modules.os

import android.content.Context
import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File

/** Onde o cache guarda o texto de cada perfil (arquivo no armazenamento privado; memória nos testes). */
interface WorkCacheStorage {
    fun read(name: String): String?
    fun write(name: String, text: String)
    fun clear()
}

/** Arquivos em `noBackupFiles/os-cache` (fora do backup do aparelho), apagados no logout. */
class FileWorkCacheStorage(private val dir: File) : WorkCacheStorage {
    override fun read(name: String): String? = runCatching { File(dir, name).takeIf { it.exists() }?.readText(Charsets.UTF_8) }.getOrNull()

    override fun write(name: String, text: String) {
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "$name.tmp")
            tmp.writeText(text, Charsets.UTF_8)
            if (!tmp.renameTo(File(dir, name))) {
                File(dir, name).writeText(text, Charsets.UTF_8)
                tmp.delete()
            }
        }
    }

    override fun clear() {
        runCatching { dir.deleteRecursively() }
    }
}

class MemoryWorkCacheStorage : WorkCacheStorage {
    val files = LinkedHashMap<String, String>()
    override fun read(name: String): String? = files[name]
    override fun write(name: String, text: String) { files[name] = text }
    override fun clear() = files.clear()
}

/** Uma cópia guardada: a resposta crua do servidor e quando foi lida. */
@Serializable
data class CachedCopy(
    val key: String,
    @SerialName("saved_at") val savedAt: Long,
    val body: String,
    val history: String? = null,
)

@Serializable
data class WorkCacheIndex(
    val lists: List<CachedCopy> = emptyList(),
    val orders: List<CachedCopy> = emptyList(),
    val catalog: CachedCopy? = null,
)

/**
 * A última cópia lida, por perfil, para ver sem conexão: as últimas [maxLists] combinações de filtro da lista, as
 * [maxOrders] fichas abertas mais recentes (ordem + histórico) e o catálogo de modelos. Nada é enfileirado: sem conexão
 * a tela só mostra a cópia, com os botões de mudança desligados. Apagado no logout com o resto do cache.
 */
class WorkOrderCache(private val storage: WorkCacheStorage, private val maxLists: Int = 5, private val maxOrders: Int = 50) {
    private val lock = Any()

    private fun name(profile: String) = "profile-" + profile.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.ifEmpty { "x" } + ".json"

    private fun index(profile: String): WorkCacheIndex =
        storage.read(name(profile))?.let { runCatching { WabotiaJson.decodeFromString(WorkCacheIndex.serializer(), it) }.getOrNull() } ?: WorkCacheIndex()

    private fun save(profile: String, index: WorkCacheIndex) = storage.write(name(profile), WabotiaJson.encodeToString(WorkCacheIndex.serializer(), index))

    private fun List<CachedCopy>.upsert(copy: CachedCopy, limit: Int) =
        (listOf(copy) + filter { it.key != copy.key }).sortedByDescending { it.savedAt }.take(limit)

    fun saveList(profile: String, key: String, body: String, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        val index = index(profile)
        save(profile, index.copy(lists = index.lists.upsert(CachedCopy(key, now, body), maxLists)))
    }

    fun list(profile: String, key: String): CachedCopy? = synchronized(lock) { index(profile).lists.firstOrNull { it.key == key } }

    fun saveOrder(profile: String, id: String, body: String, history: String?, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        val index = index(profile)
        val keepHistory = history ?: index.orders.firstOrNull { it.key == id }?.history
        save(profile, index.copy(orders = index.orders.upsert(CachedCopy(id, now, body, keepHistory), maxOrders)))
    }

    fun order(profile: String, id: String): CachedCopy? = synchronized(lock) { index(profile).orders.firstOrNull { it.key == id } }

    fun saveCatalog(profile: String, body: String, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        save(profile, index(profile).copy(catalog = CachedCopy("types", now, body)))
    }

    fun catalog(profile: String): CachedCopy? = synchronized(lock) { index(profile).catalog }

    fun wipe() = synchronized(lock) { storage.clear() }

    companion object {
        @Volatile private var shared: WorkOrderCache? = null

        private fun dir(context: Context) = File(context.applicationContext.noBackupFilesDir, "os-cache")

        fun of(context: Context): WorkOrderCache =
            shared ?: synchronized(this) { shared ?: WorkOrderCache(FileWorkCacheStorage(dir(context))).also { shared = it } }

        /** No logout (AppContainer.wipeLocalData): nada de cliente fica no aparelho. */
        fun wipe(context: Context) {
            shared?.wipe() ?: FileWorkCacheStorage(dir(context)).clear()
        }
    }
}
