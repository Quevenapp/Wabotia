package br.com.queven.wabotia

import android.app.Application
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.ui.theme.ThemeController
import br.com.queven.wabotia.core.push.Notifications

class WabotiaApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        container = AppContainer(this)
        // Demonstração aberta na última vez: os dados de exemplo recomeçam, e o estado local também (antes da 1ª tela).
        DemoMode.restoreOnLaunch(container)
        ThemeController.init(container.session)
        container.events.start()
        Notifications.ensureChannels(this)
    }

    companion object {
        lateinit var instance: WabotiaApp
            private set
    }
}
