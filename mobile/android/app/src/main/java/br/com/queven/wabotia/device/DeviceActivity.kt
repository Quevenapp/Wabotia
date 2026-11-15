package br.com.queven.wabotia.device

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import br.com.queven.wabotia.MainActivity
import br.com.queven.wabotia.WabotiaApp
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.device.ui.AndroidPanelCallAudio
import br.com.queven.wabotia.device.ui.DeviceApp
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelPinStore
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelSoundStore
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelTemplateStore
import br.com.queven.wabotia.printing.SenhaPrinter
import br.com.queven.wabotia.queue.QueuePairing
import br.com.queven.wabotia.ui.theme.WabotiaTheme

/**
 * Modo aparelho: o celular ou tablet vira totem, painel de chamadas ou os dois, fora do login de pessoa. Tela cheia,
 * paisagem (manifesto) e sempre ligada; a saída passa pelo PIN dos ajustes. Com um aparelho pareado, o app abre direto
 * aqui ([MainActivity] redireciona).
 */
class DeviceActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Sempre ligada enquanto esta tela está à frente (os quadros também seguram a tela, como no Senhapp).
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val container = (application as WabotiaApp).container
        val demo = intent.getBooleanExtra(EXTRA_DEMO, false)
        val server = if (demo) DemoMode.SERVER else intent.getStringExtra(EXTRA_SERVER) ?: container.session.serverUrl
        val services = DeviceServices(
            store = if (demo) MemoryDeviceConfigStore(demoPreset(intent.getStringExtra(EXTRA_DEMO_ROLE))) else container.deviceStore,
            pairing = QueuePairing(),
            printer = SenhaPrinter(container.thermalPrinter, ready = { container.printerReady() }),
            sound = SharedPreferencesPanelSoundStore(this),
            pins = SharedPreferencesPanelPinStore(this),
            templates = SharedPreferencesPanelTemplateStore(this),
            audio = { AndroidPanelCallAudio(applicationContext) },
            serverUrl = server,
            demo = demo,
        )
        val vm = ViewModelProvider(this, DeviceViewModel.factory(services))[DeviceViewModel::class.java]
        setContent {
            WabotiaTheme {
                DeviceApp(container, vm, onFinish = ::backToApp)
            }
        }
    }

    /** Desfeito o pareamento (ou saindo da demonstração), volta à tela inicial do app. */
    private fun backToApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    companion object {
        private const val EXTRA_SERVER = "server"
        private const val EXTRA_DEMO = "demo"
        private const val EXTRA_DEMO_ROLE = "demo_role"

        /** Parear com o servidor escolhido na tela Servidor (ou retomar o aparelho já pareado). */
        fun intent(context: Context, serverUrl: String? = null): Intent =
            Intent(context, DeviceActivity::class.java).apply { serverUrl?.let { putExtra(EXTRA_SERVER, it) } }

        /** Há um aparelho pareado neste celular: o app abre direto no modo aparelho. */
        fun isPaired(store: DeviceConfigStore): Boolean = store.load() != null

        @Suppress("UNUSED_PARAMETER")
        private fun demoPreset(role: String?): DeviceConfig? = null
    }
}
