package br.com.queven.wabotia.device

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.MainActivity
import br.com.queven.wabotia.WabotiaApp
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.device.core.MemoryPanelPinAttemptStore
import br.com.queven.wabotia.device.core.PanelPinStore
import br.com.queven.wabotia.device.ui.AndroidPanelCallAudio
import br.com.queven.wabotia.device.ui.DeviceApp
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelPinAttemptStore
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelPinStore
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelSoundStore
import br.com.queven.wabotia.device.ui.SharedPreferencesPanelTemplateStore
import br.com.queven.wabotia.printing.SenhaPrinter
import br.com.queven.wabotia.queue.DebugNetwork
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
        // A demonstração recomeça a fila de exemplo a cada entrada (o ViewModel guarda o aparelho fictício na memória).
        if (demo && savedInstanceState == null) DemoMode.startDevice()
        val server = if (demo) DemoMode.SERVER else intent.getStringExtra(EXTRA_SERVER) ?: container.session.serverUrl
        val services = DeviceServices(
            store = if (demo) MemoryDeviceConfigStore(demoPreset(intent.getStringExtra(EXTRA_DEMO_ROLE))) else container.deviceStore,
            pairing = QueuePairing(),
            printer = SenhaPrinter(container.thermalPrinter, ready = { container.printerReady() }),
            sound = SharedPreferencesPanelSoundStore(this),
            // Na demonstração o PIN vive só na memória, como o aparelho fictício: quem sai pelo botão Início e volta
            // não encontra um PIN esquecido de outra vez (sem ele não se sai da tela).
            pins = if (demo) MemoryPanelPinStore() else SharedPreferencesPanelPinStore(this),
            // Os erros do PIN ficam no disco: matar o app e reabrir não zera a contagem (na demonstração, na memória).
            pinAttempts = if (demo) MemoryPanelPinAttemptStore() else SharedPreferencesPanelPinAttemptStore(this),
            templates = SharedPreferencesPanelTemplateStore(this),
            audio = { AndroidPanelCallAudio(applicationContext) },
            serverUrl = server,
            demo = demo,
        )
        val vm = ViewModelProvider(this, DeviceViewModel.factory(services))[DeviceViewModel::class.java]
        this.vm = vm
        if (savedInstanceState == null) runDebugCommand(intent)
        setContent {
            WabotiaTheme {
                DeviceApp(container, vm, onFinish = ::backToApp)
            }
        }
    }

    private var vm: DeviceViewModel? = null

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        runDebugCommand(intent)
    }

    /** `--es debug offline:20` (só no build de depuração): tira a rede da fila e derruba o WebSocket, como uma queda. */
    private fun runDebugCommand(intent: Intent?) {
        if (!BuildConfig.DEBUG) return
        val seconds = DebugNetwork.parse(intent?.getStringExtra(EXTRA_DEBUG)) ?: return
        DebugNetwork.goOffline(seconds)
        vm?.debugDropConnection()
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
        private const val EXTRA_DEBUG = "debug"

        /** Parear com o servidor escolhido na tela Servidor (ou retomar o aparelho já pareado). */
        fun intent(context: Context, serverUrl: String? = null): Intent =
            Intent(context, DeviceActivity::class.java).apply { serverUrl?.let { putExtra(EXTRA_SERVER, it) } }

        /**
         * A demonstração do modo aparelho: pareamento aprovado sozinho contra o servidor em memória. Com [role], já
         * entra pareado nesse papel (atalhos do build de depuração `--es demo device-totem|device-panel|device-hybrid`).
         */
        fun demoIntent(context: Context, role: DeviceRole? = null): Intent =
            Intent(context, DeviceActivity::class.java).putExtra(EXTRA_DEMO, true).apply { role?.let { putExtra(EXTRA_DEMO_ROLE, it.name) } }

        /** Há um aparelho pareado neste celular: o app abre direto no modo aparelho. */
        fun isPaired(store: DeviceConfigStore): Boolean = store.load() != null

        private fun demoPreset(role: String?): DeviceConfig? {
            val chosen = DeviceRole.entries.firstOrNull { it.name == role } ?: return null
            return DemoMode.deviceConfig(chosen)
        }
    }
}

/** Repassa ao modo aparelho o comando de depuração (`--es debug …`) que chegou ao ícone do app; no release, nada. */
fun Intent.withDebugCommand(from: Intent?): Intent = apply {
    if (BuildConfig.DEBUG) from?.getStringExtra("debug")?.let { putExtra("debug", it) }
}

/** O PIN de saída da demonstração: some com o aparelho fictício. */
class MemoryPanelPinStore : PanelPinStore {
    private val pins = mutableMapOf<String, String>()

    override fun sealed(deviceId: String): String? = pins[deviceId]

    override fun save(deviceId: String, sealed: String?) {
        if (sealed == null) pins.remove(deviceId) else pins[deviceId] = sealed
    }
}
