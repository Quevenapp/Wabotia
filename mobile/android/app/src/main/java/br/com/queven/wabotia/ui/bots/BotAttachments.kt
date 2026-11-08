package br.com.queven.wabotia.ui.bots

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import br.com.queven.wabotia.core.AppContainer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.net.URLDecoder

/**
 * Anexos de execuções de bot: são mídias privadas (`GET /media/{id}/content` exige Authorization),
 * por isso o download usa o OkHttp autenticado do container e o arquivo é aberto via FileProvider
 * "${applicationId}.files" (cache-path declarado em res/xml/file_paths.xml).
 */
object BotAttachments {
    data class Info(val name: String, val type: String, val size: Long?)

    private fun url(container: AppContainer, profileId: String, mediaId: String, inline: Boolean): String {
        val server = container.session.serverUrl ?: throw IOException("Servidor não configurado.")
        return container.clientFor(server).mediaUrl(profileId, mediaId, inline)
    }

    private fun cacheDir(context: Context, mediaId: String): File =
        File(File(context.cacheDir, "bot-attachments"), mediaId.replace(Regex("[^A-Za-z0-9_-]"), "_")).apply { mkdirs() }

    /** Nome, tipo e tamanho sem baixar o conteúdo (pede apenas o primeiro byte via Range). */
    suspend fun probe(container: AppContainer, profileId: String, mediaId: String): Info = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url(container, profileId, mediaId, inline = false)).header("Range", "bytes=0-0").build()
        container.okHttp.newCall(request).execute().use { response ->
            val name = fileName(response.header("Content-Disposition")) ?: "anexo-${mediaId.take(8)}"
            val type = response.header("Content-Type")?.substringBefore(';')?.trim()?.ifBlank { null } ?: "application/octet-stream"
            val size = response.header("Content-Range")?.substringAfter('/', "")?.trim()?.toLongOrNull()
                ?: response.header("Content-Length")?.toLongOrNull()?.takeIf { response.code != 206 }
            Info(name, type, size)
        }
    }

    /** Baixa para o cache do app (reutiliza se já existir) e devolve o arquivo e seu tipo. */
    suspend fun download(context: Context, container: AppContainer, profileId: String, mediaId: String): Pair<File, String> = withContext(Dispatchers.IO) {
        val dir = cacheDir(context, mediaId)
        val existing = dir.listFiles()?.firstOrNull { it.isFile && it.length() > 0 }
        val typeFile = File(dir, ".type")
        if (existing != null && typeFile.exists()) {
            return@withContext existing to typeFile.readText().ifBlank { "application/octet-stream" }
        }
        val request = Request.Builder().url(url(container, profileId, mediaId, inline = false)).build()
        container.okHttp.newCall(request).execute().use { response ->
            val body = response.body ?: throw IOException("Resposta vazia do servidor.")
            val name = sanitize(fileName(response.header("Content-Disposition")) ?: "anexo-${mediaId.take(8)}")
            val type = response.header("Content-Type")?.substringBefore(';')?.trim()?.ifBlank { null } ?: "application/octet-stream"
            val target = File(dir, name)
            val tmp = File(dir, "$name.part")
            body.byteStream().use { input -> tmp.outputStream().use { output -> input.copyTo(output) } }
            if (target.exists()) target.delete()
            if (!tmp.renameTo(target)) throw IOException("Não foi possível gravar o arquivo.")
            typeFile.writeText(type)
            target to type
        }
    }

    /** Abre o arquivo com um app do sistema. Sem app compatível, cai no compartilhamento. */
    fun open(context: Context, file: File, type: String) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(Intent.createChooser(intent, "Abrir com").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            share(context, file, type)
        }
    }

    fun share(context: Context, file: File, type: String) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val intent = Intent(Intent.ACTION_SEND)
            .setType(type)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            context.startActivity(Intent.createChooser(intent, "Compartilhar").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            // Nenhum app para compartilhar; nada a fazer.
        }
    }

    /**
     * "Baixar": grava na pasta Downloads do aparelho (Android 10+ via MediaStore, sem permissão).
     * Em versões anteriores abre o compartilhamento para a pessoa escolher onde salvar.
     * Retorna true quando o arquivo foi gravado em Downloads.
     */
    suspend fun saveToDownloads(context: Context, file: File, type: String): Boolean = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(context, file, type)
        } else {
            withContext(Dispatchers.Main) { share(context, file, type) }
            false
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun saveViaMediaStore(context: Context, file: File, type: String): Boolean {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, file.name)
            put(MediaStore.Downloads.MIME_TYPE, type)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            resolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: return false
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            true
        } catch (e: IOException) {
            resolver.delete(uri, null, null)
            false
        }
    }

    /** Lê `filename*=UTF-8''nome` ou `filename="nome"` do Content-Disposition (src/media.ts). */
    internal fun fileName(disposition: String?): String? {
        if (disposition.isNullOrBlank()) return null
        Regex("filename\\*=(?:UTF-8|utf-8)''([^;]+)").find(disposition)?.groupValues?.getOrNull(1)?.let { encoded ->
            return runCatching { URLDecoder.decode(encoded.trim(), "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }
        }
        Regex("filename=\"?([^\";]+)\"?").find(disposition)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotBlank() }?.let { return it }
        return null
    }

    private fun sanitize(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trimStart('.')
        return (if (cleaned.isBlank()) "anexo" else cleaned).take(120)
    }
}
