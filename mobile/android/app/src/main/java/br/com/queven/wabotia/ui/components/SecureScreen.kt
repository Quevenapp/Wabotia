package br.com.queven.wabotia.ui.components

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.Window
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.queven.wabotia.core.AppContainer
import java.util.WeakHashMap

/**
 * Telas com dados de clientes (conversas, Mensalidade com CPF/CNPJ do pagador): com "Proteger telas com dados de
 * clientes" ligado em Ajustes (o padrão), a janela leva `FLAG_SECURE` enquanto a tela está à vista. O Android não deixa
 * capturar nem gravar a tela, e a miniatura dos Recentes sai em branco. Diálogos e folhas herdam da janela.
 *
 * "À vista" é o ciclo de vida do destino de navegação (o `LifecycleOwner` da tela), não o tempo em que ela fica na
 * composição: um link (aviso tocado, atalho) volta à tela inicial na aba Conversas e empilha outra tela por cima no
 * mesmo quadro, e a tela coberta ficava protegendo a de cima. Quando é o app inteiro que vai para segundo plano, a
 * proteção fica, para a miniatura dos Recentes continuar em branco.
 */
@Composable
fun SecureScreenEffect(container: AppContainer) {
    val enabled by container.protectScreens.collectAsState()
    val activity = LocalView.current.context.activity() ?: return
    val window = activity.window ?: return
    val screen = LocalLifecycleOwner.current
    val app = activity as? LifecycleOwner
    DisposableEffect(window, enabled, screen) {
        var held = false
        fun update() {
            val want = SecureScreenRules.shouldProtect(
                enabled = enabled,
                screenVisible = screen.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED),
                appVisible = app?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) ?: true,
            )
            if (want && !held) {
                SecureWindows.acquire(window)
                held = true
            } else if (!want && held) {
                SecureWindows.release(window)
                held = false
            }
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        screen.lifecycle.addObserver(observer)
        update()
        onDispose {
            screen.lifecycle.removeObserver(observer)
            if (held) SecureWindows.release(window)
        }
    }
}

/** A regra, sem Android, para testar. */
object SecureScreenRules {
    /**
     * Protege com a opção ligada quando a tela está à vista. Se a tela saiu de vista porque o app inteiro foi para
     * segundo plano (e não porque outra tela a cobriu), continua protegendo: é a miniatura dos Recentes.
     */
    fun shouldProtect(enabled: Boolean, screenVisible: Boolean, appVisible: Boolean): Boolean =
        enabled && (screenVisible || !appVisible)
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

private object SecureWindows {
    private val counts = SecureCounter<Window>(
        on = { it.addFlags(WindowManager.LayoutParams.FLAG_SECURE) },
        off = { it.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) },
    )

    fun acquire(window: Window) = counts.acquire(window)

    fun release(window: Window) = counts.release(window)
}

/**
 * Conta as telas protegidas à vista em cada janela: ao trocar de uma conversa para os dados dela, a tela nova entra
 * antes de a antiga sair, e a saída da antiga não pode tirar a proteção da nova.
 */
class SecureCounter<K : Any>(private val on: (K) -> Unit, private val off: (K) -> Unit) {
    private val counts = WeakHashMap<K, Int>()

    fun acquire(key: K) {
        val n = (counts[key] ?: 0) + 1
        counts[key] = n
        if (n == 1) on(key)
    }

    fun release(key: K) {
        val current = counts[key] ?: return
        if (current <= 1) {
            counts.remove(key)
            off(key)
        } else {
            counts[key] = current - 1
        }
    }

    fun count(key: K): Int = counts[key] ?: 0
}
