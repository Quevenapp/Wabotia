package br.com.queven.wabotia.core

import android.content.Context
import br.com.queven.wabotia.core.events.EventHub
import br.com.queven.wabotia.core.media.AuthenticatedMedia
import br.com.queven.wabotia.core.model.User
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.WabotiaApi
import br.com.queven.wabotia.core.push.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * Dependências compartilhadas do aplicativo (sem framework de injeção).
 * O servidor é escolhido pela pessoa na primeira tela; por isso o cliente HTTP
 * é reconstruído sempre que o endereço muda.
 */
class AppContainer(context: Context) {
    val appContext: Context = context.applicationContext
    val session = SessionStore(appContext)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _auth = MutableStateFlow(AuthState.from(session))
    val auth: StateFlow<AuthState> = _auth.asStateFlow()

    private var client: ApiClient? = null

    /** Dados do perfil usados por várias telas (contagens, tipos de linha, setores), com cache curto. */
    val profileData = ProfileData(this)

    /** Prévia da última mensagem e não lidas por conversa (cache local por perfil). */
    val conversationCache = ConversationCache(this)

    /** Conversas internas não lidas (comparação local de `updated`). */
    val internalChats = InternalChatTracker(this)

    /** Consulta única de eventos em primeiro plano, compartilhada por todas as telas. */
    val events = EventHub(this)

    /** Cliente para o servidor configurado. Lança [IllegalStateException] se não houver servidor. */
    val api: WabotiaApi
        get() = clientFor(session.serverUrl ?: error("Servidor não configurado")).api

    val okHttp: OkHttpClient
        get() = clientFor(session.serverUrl ?: error("Servidor não configurado")).okHttp

    /** Cliente para um endereço arbitrário (usado antes do login para validar o servidor). */
    fun clientFor(serverUrl: String): ApiClient {
        val current = client
        if (current != null && current.baseUrl == serverUrl) return current
        return ApiClient(serverUrl) { session.token }.also { client = it }
    }

    fun onLoggedIn(serverUrl: String, token: String, expires: Long, user: User) {
        session.serverUrl = serverUrl
        session.token = token
        session.tokenExpires = expires
        session.user = user
        if (user.profiles.size == 1) session.profileId = user.profiles.first()
        client = null
        _auth.value = AuthState.from(session)
    }

    fun onProfileSelected(profileId: String) {
        session.profileId = profileId
        _auth.value = AuthState.from(session)
    }

    fun onLoggedOut(keepServer: Boolean) {
        val server = session.serverUrl
        session.clearSession()
        if (keepServer) session.serverUrl = server
        client = null
        profileData.clear()
        conversationCache.clear()
        internalChats.clear()
        wipeLocalData()
        _auth.value = AuthState.from(session)
    }

    /**
     * Ao sair da conta nada de cliente fica no aparelho: cache de conversas (prévias, não lidas, conversas internas
     * vistas), avisos com trechos de mensagens e todos os arquivos em cache (anexos baixados, miniaturas, fotos e
     * áudios gravados). Ficam só o endereço do servidor (quando pedido) e as preferências do aparelho.
     */
    private fun wipeLocalData() {
        conversationCache.wipe()
        Notifications.cancelAll(appContext)
        scope.launch(Dispatchers.IO) {
            runCatching { AuthenticatedMedia.clear() }
            listOfNotNull(appContext.cacheDir, appContext.externalCacheDir).forEach { dir ->
                dir.listFiles()?.forEach { runCatching { it.deleteRecursively() } }
            }
        }
    }

    fun refreshAuthState() {
        _auth.value = AuthState.from(session)
    }
}

data class AuthState(
    val serverUrl: String?,
    val token: String?,
    val user: User?,
    val profileId: String?,
) {
    val isLoggedIn: Boolean get() = !serverUrl.isNullOrBlank() && !token.isNullOrBlank() && user != null

    companion object {
        fun from(store: SessionStore) = AuthState(
            serverUrl = store.serverUrl,
            token = store.token,
            user = store.user,
            profileId = store.profileId,
        )
    }
}
