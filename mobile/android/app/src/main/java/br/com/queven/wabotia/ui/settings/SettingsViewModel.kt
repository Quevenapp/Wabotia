package br.com.queven.wabotia.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.SessionRefresher
import br.com.queven.wabotia.core.model.HealthInfo
import br.com.queven.wabotia.core.model.Profile
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.core.push.Notifications
import br.com.queven.wabotia.core.push.PushRegistrar
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Estado da aba Ajustes (a presença vem de ui/components/Presence.kt). Tudo que vem da sessão local é recarregado por [SettingsViewModel.syncLocal]. */
data class SettingsUiState(
    // pessoa e perfil
    val userName: String = "",
    val userEmail: String = "",
    val isAdmin: Boolean = false,
    val profileId: String? = null,
    val profiles: List<Profile> = emptyList(),
    val profilesError: String? = null,
    // notificações
    val notificationsEnabled: Boolean = true,
    val notificationsBusy: Boolean = false,
    val testBusy: Boolean = false,
    // dispositivo
    val deviceId: String = "",
    val pushRegistered: Boolean = false,
    val pushTokenAvailable: Boolean = false,
    val registerBusy: Boolean = false,
    val tokenExpires: Long = 0L,
    // servidor
    val serverUrl: String = "",
    val health: HealthInfo? = null,
    val healthLoading: Boolean = false,
    val healthError: String? = null,
    // sair
    val loggingOut: Boolean = false,
    val logoutError: String? = null,
    // aviso transitório (snackbar)
    val message: String? = null,
) {
    val profileName: String get() = profiles.firstOrNull { it.id == profileId }?.name ?: (profileId ?: "")
    val canSwitchProfile: Boolean get() = profiles.size > 1
}

class SettingsViewModel(private val container: AppContainer) : ViewModel() {
    private val session get() = container.session

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    // Chaves de idempotência mantidas enquanto o pedido não for confirmado (repetição reutiliza a mesma).
    private var testKey: String? = null
    private var logoutKey: String? = null

    init {
        syncLocal()
    }

    /** Copia para o estado o que está guardado no aparelho (sessão, preferências, registro de push). */
    fun syncLocal() {
        val user = session.user
        _state.update {
            it.copy(
                userName = user?.name.orEmpty(),
                userEmail = user?.email.orEmpty(),
                isAdmin = user?.isAdmin == true,
                profileId = session.profileId,
                notificationsEnabled = session.notificationsEnabled,
                deviceId = session.deviceId,
                pushRegistered = session.registeredPushToken != null,
                pushTokenAvailable = session.pushToken != null,
                tokenExpires = session.tokenExpires,
                serverUrl = session.serverUrl.orEmpty(),
            )
        }
    }

    /** Chamado quando a aba aparece: renova o token se faltar pouco, e recarrega perfis e versão do servidor. */
    fun refresh() {
        syncLocal()
        viewModelScope.launch {
            if (SessionRefresher.refreshIfNeeded(container)) syncLocal()
            if (!container.auth.value.isLoggedIn) return@launch
            loadProfiles()
            loadHealth()
        }
    }

    fun consumeMessage() {
        _state.update { it.copy(message = null) }
    }

    // --- perfil ---

    fun loadProfiles() {
        viewModelScope.launch {
            try {
                val list = container.api.profiles()
                _state.update { it.copy(profiles = list, profilesError = null) }
            } catch (e: Exception) {
                _state.update { it.copy(profilesError = failure(e)) }
            }
        }
    }

    fun selectProfile(profileId: String) {
        if (profileId == session.profileId) return
        container.onProfileSelected(profileId)
        _state.update { it.copy(profileId = profileId) }
    }

    // --- notificações ---

    fun setNotifications(enabled: Boolean) {
        if (_state.value.notificationsBusy) return
        session.notificationsEnabled = enabled
        _state.update { it.copy(notificationsEnabled = enabled, notificationsBusy = true) }
        viewModelScope.launch {
            try {
                val registered = PushRegistrar.register(container, force = true)
                val msg = when {
                    !registered -> "Preferência salva. Este aparelho não tem token de push (Firebase não configurado neste build)."
                    enabled -> "Notificações ativadas neste aparelho."
                    else -> "Notificações desativadas neste aparelho."
                }
                _state.update { it.copy(message = msg) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Preferência salva no aparelho, mas o servidor não foi atualizado: ${failure(e)}") }
            } finally {
                syncLocal()
                _state.update { it.copy(notificationsBusy = false) }
            }
        }
    }

    fun registerPush() {
        if (_state.value.registerBusy) return
        _state.update { it.copy(registerBusy = true) }
        viewModelScope.launch {
            try {
                val ok = PushRegistrar.register(container, force = true)
                _state.update {
                    it.copy(message = if (ok) "Aparelho registrado para notificações." else "Não foi possível obter o token de push. Verifique se o Google Play Services está disponível.")
                }
            } catch (e: Exception) {
                _state.update { it.copy(message = failure(e)) }
            } finally {
                syncLocal()
                _state.update { it.copy(registerBusy = false) }
            }
        }
    }

    fun sendTest() {
        if (_state.value.testBusy) return
        val key = testKey ?: ApiClient.newIdempotencyKey().also { testKey = it }
        _state.update { it.copy(testBusy = true) }
        viewModelScope.launch {
            try {
                val result = container.api.testDevice(session.deviceId, key)
                testKey = null
                _state.update { it.copy(testBusy = false, message = describeTest(result)) }
            } catch (e: Exception) {
                if (e is ApiException && e.isIdempotencyConflict) testKey = null
                val msg = if (e is ApiException && e.status == 404) "Este aparelho não está registrado no servidor. Toque em Registrar agora e tente de novo." else failure(e)
                _state.update { it.copy(testBusy = false, message = msg) }
            }
        }
    }

    private fun describeTest(result: JsonObject): String {
        val results = result["results"] as? JsonArray
        val first = results?.firstOrNull() as? JsonObject
        return when (first?.string("status")) {
            null -> if (results == null) "O servidor respondeu, mas não informou o resultado do envio." else "O servidor não enviou a notificação (push desligado ou aparelho sem registro)."
            "ok" -> "Notificação de teste enviada. Ela deve chegar em instantes."
            "unregistered" -> "O provedor não reconhece este aparelho. Toque em Registrar agora e tente de novo."
            else -> "Falha ao enviar: ${first?.string("error") ?: "erro desconhecido"}"
        }
    }

    // --- servidor ---

    fun loadHealth() {
        viewModelScope.launch {
            _state.update { it.copy(healthLoading = true) }
            try {
                val info = container.api.health()
                _state.update { it.copy(health = info, healthLoading = false, healthError = null) }
            } catch (e: Exception) {
                _state.update { it.copy(healthLoading = false, healthError = ApiClient.describe(e)) }
            }
        }
    }

    // --- sair ---

    /**
     * DELETE /devices/{id} → POST /logout → limpar sessão (mantém o servidor).
     * Se o servidor não puder ser avisado, [SettingsUiState.logoutError] é preenchido e a pessoa decide
     * tentar de novo (mesma chave) ou sair só do aparelho ([force]).
     */
    fun logout(force: Boolean = false) {
        if (_state.value.loggingOut) return
        val key = logoutKey ?: ApiClient.newIdempotencyKey().also { logoutKey = it }
        _state.update { it.copy(loggingOut = true, logoutError = null) }
        viewModelScope.launch {
            PushRegistrar.unregister(container)
            try {
                container.api.logout(key)
            } catch (e: Exception) {
                val unauthorized = e is ApiException && e.isUnauthorized
                if (e is ApiException && e.isIdempotencyConflict) logoutKey = null
                if (!unauthorized && !force) {
                    _state.update { it.copy(loggingOut = false, logoutError = ApiClient.describe(e)) }
                    return@launch
                }
            }
            logoutKey = null
            Notifications.cancelAll(container.appContext)
            container.onLoggedOut(keepServer = true)
        }
    }

    fun clearLogoutError() {
        _state.update { it.copy(logoutError = null) }
    }

    /** Texto amigável para a falha; 401 encerra a sessão mantendo o servidor. */
    private fun failure(e: Throwable): String {
        if (e is ApiException && e.isUnauthorized) container.onLoggedOut(keepServer = true)
        return ApiClient.describe(e)
    }
}
