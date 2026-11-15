package br.com.queven.wabotia

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.navigation.compose.rememberNavController
import br.com.queven.wabotia.core.SessionRefresher
import br.com.queven.wabotia.core.push.PushRegistrar
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.device.DeviceActivity
import br.com.queven.wabotia.device.withDebugCommand
import br.com.queven.wabotia.ui.components.DemoBanner
import br.com.queven.wabotia.ui.nav.AppNavHost
import br.com.queven.wabotia.ui.nav.DeepLink
import br.com.queven.wabotia.ui.theme.Wb
import br.com.queven.wabotia.ui.theme.WabotiaTheme

class MainActivity : ComponentActivity() {
    private var pendingLink by mutableStateOf<DeepLink?>(null)

    // O lint pede Fragment >= 1.3.0 por causa de uma dependência transitiva antiga (Play Services);
    // esta Activity é ComponentActivity e não usa Fragments, então a verificação não se aplica.
    @SuppressLint("InvalidFragmentVersionForActivityResult")
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as WabotiaApp).container
        // Aparelho pareado como totem ou painel: abre direto no modo aparelho (o atalho de demonstração não conta).
        if (savedInstanceState == null && intent?.getStringExtra("demo") == null && DeviceActivity.isPaired(container.deviceStore)) {
            startActivity(DeviceActivity.intent(this).withDebugCommand(intent))
            finish()
            return
        }
        // URI (notificação montada pelo app), extras do `data` (notificação exibida pelo Firebase em segundo plano)
        // ou, só no build de depuração, o atalho `--es demo <tela>`.
        if (savedInstanceState == null) pendingLink = accept(DeepLink.from(intent))
        setContent {
            WabotiaTheme {
                val nav = rememberNavController()
                val auth by container.auth.collectAsState()
                val demo = auth.isLoggedIn && DemoMode.isDemo(auth.serverUrl)
                LaunchedEffect(Unit) {
                    // Na demonstração não há servidor real: nada de registrar o aparelho nem renovar a sessão.
                    if (!container.isDemo) {
                        PushRegistrar.registerIfNeeded(container)
                        SessionRefresher.refreshInBackground(container)
                    }
                }
                // A permissão de notificações só é pedida depois do login, na primeira vez em que a tela inicial
                // aparece (nunca na demonstração). Depois disso a pessoa ajusta em Ajustes > Notificações.
                val home = auth.isLoggedIn && auth.profileId != null && !demo
                LaunchedEffect(home) {
                    if (home && !container.session.notificationPermissionAsked) {
                        container.session.notificationPermissionAsked = true
                        requestNotificationPermission()
                    }
                }
                Column(Modifier.fillMaxSize().background(Wb.colors.background)) {
                    // Acima de toda a navegação: a faixa aparece em todas as telas da demonstração. Ela ocupa a área
                    // da barra de status, então as telas abaixo não somam esse recuo de novo.
                    if (demo) DemoBanner(onExit = { DemoMode.signOut(container) })
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .then(if (demo) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier),
                    ) {
                        AppNavHost(container, nav, pendingLink) { pendingLink = null }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Esta Activity é singleTask: uma intent entregue a ela (ícone aberto por outro caminho, notificação) limpa o
        // modo aparelho que estava por cima. Com um aparelho pareado, volta para ele, como na abertura do app.
        if (intent.getStringExtra("demo") == null && DeviceActivity.isPaired((application as WabotiaApp).container.deviceStore)) {
            startActivity(DeviceActivity.intent(this).withDebugCommand(intent))
            finish()
            return
        }
        accept(DeepLink.from(intent))?.let { pendingLink = it }
    }

    /**
     * Atalho de demonstração (só no build de depuração; [DeepLink.fromDemo] não lê o extra no release): entra na sessão
     * em memória (e recomeça os dados) antes de navegar.
     */
    private fun accept(link: DeepLink?): DeepLink? {
        if (link?.type == DeepLink.DEMO) {
            if (!BuildConfig.DEBUG) return null
            val container = (application as WabotiaApp).container
            // `--es demo device[-totem|-panel|-hybrid]`: a demonstração do modo aparelho, fora da sessão de pessoa.
            DemoMode.deviceRoleFor(link.demoScreen)?.let { role ->
                startActivity(DeviceActivity.demoIntent(this, role.getOrNull()))
                return null
            }
            if (link.demoScreen == "signout") {
                // `--es demo signout`: sai da demonstração e volta à tela inicial normal (Servidor), sem tocar em sessão real.
                DemoMode.signOut(container)
                return null
            }
            DemoMode.signIn(container)
        }
        return link
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
