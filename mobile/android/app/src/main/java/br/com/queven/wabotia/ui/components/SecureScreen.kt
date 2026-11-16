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
import br.com.queven.wabotia.core.AppContainer
import java.util.WeakHashMap

/**
 * Telas com dados de clientes (conversas, Mensalidade com CPF/CNPJ do pagador): com "Proteger telas com dados de
 * clientes" ligado em Ajustes (o padrão), a janela leva `FLAG_SECURE` enquanto a tela está aberta. O Android não deixa
 * capturar nem gravar a tela, e a miniatura dos Recentes sai em branco. Diálogos e folhas herdam da janela.
 */
@Composable
fun SecureScreenEffect(container: AppContainer) {
    val enabled by container.protectScreens.collectAsState()
    val window = LocalView.current.context.activity()?.window ?: return
    DisposableEffect(window, enabled) {
        if (enabled) SecureWindows.acquire(window)
        onDispose { if (enabled) SecureWindows.release(window) }
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/**
 * Conta as telas protegidas abertas em cada janela: ao trocar de uma conversa para os dados dela, a tela nova entra
 * antes de a antiga sair, e a saída da antiga não pode tirar a proteção da nova.
 */
private object SecureWindows {
    private val counts = WeakHashMap<Window, Int>()

    fun acquire(window: Window) {
        val n = (counts[window] ?: 0) + 1
        counts[window] = n
        if (n == 1) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    fun release(window: Window) {
        val n = ((counts[window] ?: 1) - 1).coerceAtLeast(0)
        if (n == 0) {
            counts.remove(window)
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            counts[window] = n
        }
    }
}
