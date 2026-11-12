package br.com.queven.wabotia

import android.app.Application
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.DebugHooks
import br.com.queven.wabotia.ui.theme.ThemeController
import br.com.queven.wabotia.core.push.Notifications

class WabotiaApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        // O modo de demonstração (somente depuração) precisa estar instalado antes do primeiro cliente HTTP.
        container = AppContainer(this)
        DebugHooks.install(container)
        ThemeController.init(container.session)
        container.events.start()
        Notifications.ensureChannels(this)
    }

    companion object {
        lateinit var instance: WabotiaApp
            private set
    }
}
