package br.com.queven.wabotia.core

import android.content.Context
import br.com.queven.wabotia.core.events.EventHub
import br.com.queven.wabotia.core.media.AuthenticatedMedia
import br.com.queven.wabotia.core.model.User
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.WabotiaApi
import br.com.queven.wabotia.core.push.Notifications
import br.com.queven.wabotia.core.push.PushRegistrar
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.device.DeviceConfigStore
import br.com.queven.wabotia.device.KeystoreDeviceConfigStore
import br.com.queven.wabotia.printing.createWabotiaThermalPrinter
import br.com.thermalprinterkit.ThermalPrinter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
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

    /** Os módulos ligados no servidor para o perfil aberto (capacidades; sem elas, a fila por `GET /queue`). */
    val modules = ModuleFeature(this)

    /** A credencial do modo aparelho (totem/painel), cifrada e separada da sessão de pessoa. */
    val deviceStore: DeviceConfigStore by lazy { KeystoreDeviceConfigStore(appContext) }

    /** A impressora térmica deste aparelho (cupom do totem); criada só quando alguém precisa dela. */
    val thermalPrinter: ThermalPrinter by lazy { createWabotiaThermalPrinter(appContext) }

    /** Readota a impressora escolhida uma vez por abertura do app; falhar aqui não derruba nada. */
    private val printerRestore: Job by lazy {
        scope.launch(start = CoroutineStart.LAZY) {
            try {
                thermalPrinter.restore()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
            }
        }
    }

    /** Espera a impressora escolhida voltar (inicia a readoção na primeira chamada). */
    suspend fun printerReady() {
        printerRestore.join()
    }

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

    /** Sessão atual é a demonstração (servidor fictício em memória, ver [DemoMode]). */
    val isDemo: Boolean get() = DemoMode.isDemo(session.serverUrl)

    fun onLoggedOut(keepServer: Boolean) {
        val server = session.serverUrl
        // Toda saída passa aqui, inclusive as forçadas (401, "Sair mesmo assim"): o token FCM é apagado, para o aparelho
        // parar de receber avisos mesmo que o registro continue no servidor. Várias telas podem receber o mesmo 401:
        // só a primeira saída (ainda com sessão) apaga. A demonstração nunca pediu token.
        if ((_auth.value.isLoggedIn || session.token != null) && !DemoMode.isDemo(server)) PushRegistrar.forgetToken(this)
        session.clearSession()
        // O endereço da demonstração nunca fica guardado: sair dela (ou um 401) volta à tela Servidor.
        if (keepServer && !DemoMode.isDemo(server)) session.serverUrl = server
        client = null
        profileData.clear()
        conversationCache.clear()
        internalChats.clear()
        modules.clear()
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
