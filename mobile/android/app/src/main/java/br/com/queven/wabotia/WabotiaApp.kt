package br.com.queven.wabotia

import android.app.Application
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.push.Notifications

class WabotiaApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        container = AppContainer(this)
        Notifications.ensureChannels(this)
    }

    companion object {
        lateinit var instance: WabotiaApp
            private set
    }
}
