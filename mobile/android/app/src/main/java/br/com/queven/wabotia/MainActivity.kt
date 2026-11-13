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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.navigation.compose.rememberNavController
import br.com.queven.wabotia.core.DebugHooks
import br.com.queven.wabotia.core.SessionRefresher
import br.com.queven.wabotia.core.push.PushRegistrar
import br.com.queven.wabotia.ui.nav.AppNavHost
import br.com.queven.wabotia.ui.nav.DeepLink
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
        // URI (notificação montada pelo app), extras do `data` (notificação exibida pelo Firebase em segundo plano)
        // ou, só no build de depuração, o atalho `--es demo <tela>`.
        if (savedInstanceState == null) pendingLink = accept(DeepLink.from(intent))
        setContent {
            WabotiaTheme {
                val nav = rememberNavController()
                val auth by container.auth.collectAsState()
                LaunchedEffect(Unit) {
                    val demo = container.session.serverUrl == DebugHooks.DEMO_SERVER
                    // Na demonstração não há servidor real: nada de registrar o aparelho.
                    if (!demo) {
                        PushRegistrar.registerIfNeeded(container)
                        SessionRefresher.refreshInBackground(container)
                    }
                }
                // A permissão de notificações só é pedida depois do login, na primeira vez em que a tela inicial
                // aparece (nunca na demonstração). Depois disso a pessoa ajusta em Ajustes > Notificações.
                val home = auth.isLoggedIn && auth.profileId != null && auth.serverUrl != DebugHooks.DEMO_SERVER
                LaunchedEffect(home) {
                    if (home && !container.session.notificationPermissionAsked) {
                        container.session.notificationPermissionAsked = true
                        requestNotificationPermission()
                    }
                }
                AppNavHost(container, nav, pendingLink) { pendingLink = null }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        accept(DeepLink.from(intent))?.let { pendingLink = it }
    }

    /** O atalho de demonstração entra na sessão em memória (e recomeça os dados) antes de navegar. */
    private fun accept(link: DeepLink?): DeepLink? {
        if (link?.type == DeepLink.DEMO) {
            val container = (application as WabotiaApp).container
            if (link.demoScreen == "signout") {
                // `--es demo signout`: sai da demonstração e volta à tela inicial normal (Servidor), sem tocar em sessão real.
                if (container.session.serverUrl == DebugHooks.DEMO_SERVER) container.onLoggedOut(keepServer = false)
                return null
            }
            if (!DebugHooks.signInDemo(container)) return null
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
