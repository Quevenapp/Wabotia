package br.com.queven.wabotia.core

import br.com.queven.wabotia.core.net.ApiClient
import br.com.queven.wabotia.core.net.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/**
 * Renova o token móvel (POST /api/v1/auth/mobile/refresh) quando faltam menos de 7 dias para expirar
 * (docs/MOBILE.md, seção 2). O servidor revoga o token antigo e devolve um novo com 30 dias.
 *
 * Chame [refreshIfNeeded] ao abrir o app ou a aba Mais; [refreshInBackground] é a versão fire-and-forget.
 * Um 401 na renovação significa sessão inválida: a pessoa volta ao login mantendo o servidor.
 */
object SessionRefresher {
    /** Renova quando faltar menos que isto para expirar. */
    const val THRESHOLD_MS: Long = 7L * 24 * 60 * 60 * 1000

    /** Intervalo mínimo entre tentativas automáticas (evita martelar o servidor sem rede). */
    private const val RETRY_INTERVAL_MS: Long = 60_000

    private val mutex = Mutex()

    @Volatile
    private var lastAttempt = 0L

    /** True quando o token expira em menos de [THRESHOLD_MS]. Sessões sem data conhecida (0) não são renovadas. */
    fun shouldRefresh(session: SessionStore, now: Long = System.currentTimeMillis()): Boolean {
        val expires = session.tokenExpires
        return expires > 0L && expires - now < THRESHOLD_MS
    }

    /** Milissegundos até a expiração, ou null quando desconhecida. */
    fun remainingMs(session: SessionStore, now: Long = System.currentTimeMillis()): Long? {
        val expires = session.tokenExpires
        return if (expires > 0L) expires - now else null
    }

    /**
     * Renova se necessário (ou sempre, com [force]). Devolve true quando um token novo foi gravado.
     * Nunca lança: falhas de rede são ignoradas e tentadas de novo na próxima abertura; 401 encerra a sessão.
     */
    suspend fun refreshIfNeeded(container: AppContainer, force: Boolean = false): Boolean = mutex.withLock {
        val session = container.session
        if (!container.auth.value.isLoggedIn) return@withLock false
        val now = System.currentTimeMillis()
        if (!force && !shouldRefresh(session, now)) return@withLock false
        if (!force && now - lastAttempt < RETRY_INTERVAL_MS) return@withLock false
        lastAttempt = now
        try {
            // Chave nova a cada tentativa: a anterior, se chegou ao servidor, já revogou o token antigo
            // e a resposta perdida não pode ser reaproveitada (o Bearer enviado seria outro).
            val result = container.api.refresh(ApiClient.newIdempotencyKey())
            if (result.token.isBlank()) return@withLock false
            session.token = result.token
            session.tokenExpires = result.expires
            session.user = result.user
            container.refreshAuthState()
            true
        } catch (e: ApiException) {
            if (e.isUnauthorized) container.onLoggedOut(keepServer = true)
            false
        } catch (_: IOException) {
            false
        } catch (_: IllegalStateException) {
            // Servidor não configurado: nada a renovar.
            false
        } catch (_: Exception) {
            // Resposta inesperada do servidor; mantém o token atual.
            false
        }
    }

    /** Dispara a renovação no escopo do app, sem bloquear a interface. */
    fun refreshInBackground(container: AppContainer) {
        container.scope.launch(Dispatchers.IO) { refreshIfNeeded(container) }
    }
}
