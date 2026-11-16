package br.com.queven.wabotia.queue

import br.com.queven.wabotia.BuildConfig
import java.io.IOException
import okhttp3.Interceptor

/**
 * Só no build de depuração: tira a rede da fila (HTTP e WebSocket) por alguns segundos, sem mexer no Wi-Fi do aparelho,
 * para conferir a volta automática do totem e do painel contra um servidor real. Acionado por
 * `adb shell am start -n br.com.queven.wabotia.debug/br.com.queven.wabotia.MainActivity --es debug offline:20`.
 */
object DebugNetwork {
    @Volatile
    private var offlineUntil = 0L

    val interceptor = Interceptor { chain ->
        if (BuildConfig.DEBUG && System.currentTimeMillis() < offlineUntil) throw IOException("Rede da fila desligada pela depuração")
        chain.proceed(chain.request())
    }

    fun goOffline(seconds: Int) {
        if (BuildConfig.DEBUG) offlineUntil = System.currentTimeMillis() + seconds.coerceIn(1, 600) * 1000L
    }

    /** `offline:20` → 20 s sem rede; qualquer outro valor é ignorado. */
    fun parse(command: String?): Int? = command?.removePrefix("offline:")?.takeIf { command.startsWith("offline:") }?.toIntOrNull()
}
