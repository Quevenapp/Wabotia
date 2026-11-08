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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.navigation.compose.rememberNavController
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
        // URI (notificação montada pelo app) ou extras do `data` (notificação exibida pelo Firebase em segundo plano).
        pendingLink = DeepLink.from(intent)
        val container = (application as WabotiaApp).container
        setContent {
            WabotiaTheme {
                val nav = rememberNavController()
                LaunchedEffect(Unit) {
                    requestNotificationPermission()
                    PushRegistrar.registerIfNeeded(container)
                    SessionRefresher.refreshInBackground(container)
                }
                AppNavHost(container, nav, pendingLink) { pendingLink = null }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        DeepLink.from(intent)?.let { pendingLink = it }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
