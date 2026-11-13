package br.com.queven.wabotia.core

import br.com.queven.wabotia.BuildConfig
import okhttp3.Interceptor

/**
 * Pontos de extensão usados somente pelo build de depuração (`src/debug`): modo de demonstração em memória.
 * No build de produção nada é instalado e todos os métodos devolvem "não tratado".
 */
object DebugHooks {
    /** Endereço fictício do servidor de demonstração; as chamadas nunca saem do aparelho. */
    const val DEMO_SERVER = "https://demo.wabotia.localhost"

    /** Interceptor que responde pelas chamadas ao servidor de demonstração. */
    @Volatile var interceptor: Interceptor? = null

    /** Grava a sessão de demonstração no [AppContainer]. */
    @Volatile var demoSignIn: ((AppContainer) -> Boolean)? = null

    /** Traduz o extra `demo` do Intent (e o `arg` opcional) para um destino da navegação. */
    @Volatile var demoDestination: ((screen: String, arg: String?) -> DemoDestination?)? = null

    fun install(container: AppContainer) {
        if (!BuildConfig.DEBUG) return
        runCatching {
            Class.forName("br.com.queven.wabotia.demo.DemoMode")
                .getMethod("install", AppContainer::class.java)
                .invoke(null, container)
        }
    }

    /** True quando a pessoa digitou `demo` como servidor em um build de depuração. */
    fun isDemoAlias(input: String): Boolean = BuildConfig.DEBUG && demoSignIn != null && input.trim().equals("demo", ignoreCase = true)

    fun signInDemo(container: AppContainer): Boolean = BuildConfig.DEBUG && demoSignIn?.invoke(container) == true

    fun destination(screen: String, arg: String?): DemoDestination? = if (BuildConfig.DEBUG) demoDestination?.invoke(screen, arg) else null
}

/**
 * Destino de um atalho de demonstração. [tab]: conversations | tickets | team | calls | settings.
 * [sheet] abre uma folha da conversa (transfer, attach, presence…) e [arg] escolhe a aba/segmento inicial.
 */
data class DemoDestination(
    val tab: String? = null,
    val conversationId: String? = null,
    val ticketId: String? = null,
    val info: Boolean = false,
    val sheet: String? = null,
    val arg: String? = null,
    val route: String? = null,
)
