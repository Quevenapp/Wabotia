package br.com.queven.wabotia.core.media

import br.com.queven.wabotia.core.AppContainer
import coil.ImageLoader
import coil.decode.VideoFrameDecoder

/**
 * Acesso a anexos privados. Toda URL de mídia exige `Authorization: Bearer`, por isso o Coil e o
 * ExoPlayer recebem o mesmo OkHttpClient do [AppContainer], que já acrescenta o cabeçalho.
 */
object AuthenticatedMedia {
    @Volatile private var loader: ImageLoader? = null
    @Volatile private var loaderServer: String? = null

    /** ImageLoader do Coil com o cliente autenticado; recriado quando o servidor muda. */
    fun imageLoader(container: AppContainer): ImageLoader {
        val server = container.session.serverUrl ?: ""
        val current = loader
        if (current != null && loaderServer == server) return current
        synchronized(this) {
            val again = loader
            if (again != null && loaderServer == server) return again
            val built = ImageLoader.Builder(container.appContext)
                .okHttpClient(container.okHttp)
                .components { add(VideoFrameDecoder.Factory()) }
                // O servidor responde `Cache-Control: private, no-store`; o cache local em disco do app é privado e evita baixar a mesma miniatura a cada rolagem.
                .respectCacheHeaders(false)
                .crossfade(true)
                .build()
            loader = built
            loaderServer = server
            return built
        }
    }

    /** URL absoluta do conteúdo de um anexo (use sempre com o cliente autenticado). */
    fun url(container: AppContainer, profileId: String, mediaId: String, inline: Boolean = true): String {
        val server = container.session.serverUrl ?: error("Servidor não configurado")
        return container.clientFor(server).mediaUrl(profileId, mediaId, inline)
    }
}
