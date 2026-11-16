package br.com.queven.wabotia.courier.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.MainActivity
import br.com.queven.wabotia.courier.CourierLinks
import br.com.queven.wabotia.courier.CourierViewModel
import br.com.queven.wabotia.courier.DemoCourierBackend
import br.com.queven.wabotia.courier.HttpCourierBackend
import br.com.queven.wabotia.courier.MemoryCourierSessionStore
import br.com.queven.wabotia.courier.SecureCourierSessionStore
import br.com.queven.wabotia.ui.theme.WabotiaTheme

/**
 * Modo entregador, fora do login de pessoa (como o modo aparelho): escanear o pedido, entregar, e o acesso some no
 * fim. Com uma entrega em andamento guardada, o app reabre direto aqui ([MainActivity] redireciona).
 */
class CourierActivity : ComponentActivity() {
    private var vm: CourierViewModel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val demo = intent.getBooleanExtra(EXTRA_DEMO, false)
        if (demo && savedInstanceState == null) demoBackend = DemoCourierBackend()
        val backend = if (demo) demoBackend ?: DemoCourierBackend().also { demoBackend = it } else HttpCourierBackend()
        val store = if (demo) MemoryCourierSessionStore() else SecureCourierSessionStore(this)
        val vm = ViewModelProvider(this, CourierViewModel.factory(backend, store, device = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} (Android ${android.os.Build.VERSION.RELEASE})"))[CourierViewModel::class.java]
        this.vm = vm
        if (savedInstanceState == null) {
            vm.restore()
            handle(intent)
        }
        setContent {
            WabotiaTheme {
                CourierApp(vm, demo = demo, onExit = ::backToApp)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    /** Link do pedido (`https://<servidor>/c/<código>`) e, no build de depuração, `--es courier revoke|claim:0`. */
    private fun handle(intent: Intent?) {
        intent?.getStringExtra(EXTRA_LINK)?.let { vm?.scanned(it) }
        if (BuildConfig.DEBUG && intent?.getStringExtra(EXTRA_DEBUG) == "revoke") demoBackend?.revokeAll()
        if (BuildConfig.DEBUG) intent?.getStringExtra(EXTRA_DEBUG)?.removePrefix("claim:")?.toIntOrNull()?.let { index ->
            if (index in DemoCourierBackend.CODES.indices) vm?.claim(DemoCourierBackend.demoLink(index))
        }
    }

    private fun backToApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    companion object {
        private const val EXTRA_DEMO = "courier_demo"
        private const val EXTRA_LINK = "courier_link"
        private const val EXTRA_DEBUG = "courier"

        /** O servidor da demonstração vive enquanto a demonstração estiver aberta. */
        private var demoBackend: DemoCourierBackend? = null

        fun intent(context: Context, link: String? = null): Intent =
            Intent(context, CourierActivity::class.java).apply { link?.let { putExtra(EXTRA_LINK, it) } }

        fun demoIntent(context: Context): Intent = Intent(context, CourierActivity::class.java).putExtra(EXTRA_DEMO, true)

        /** Há entrega em andamento guardada: o app abre direto no modo entregador. */
        fun hasDeliveries(context: Context): Boolean = SecureCourierSessionStore(context).load().isNotEmpty()

        /** Repassa `--es courier …` (depuração) do ícone do app para cá. */
        fun withDebug(target: Intent, from: Intent?): Intent = target.apply {
            if (BuildConfig.DEBUG) from?.getStringExtra(EXTRA_DEBUG)?.let { putExtra(EXTRA_DEBUG, it) }
        }
    }
}
