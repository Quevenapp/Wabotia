package br.com.queven.wabotia.device.ui

import br.com.queven.wabotia.device.core.PanelTemplate
import br.com.queven.wabotia.device.core.PanelTemplateStore
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.ToneGenerator
import android.media.audiofx.LoudnessEnhancer
import android.os.Bundle
import android.speech.tts.TextToSpeech
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.queven.wabotia.device.core.PanelCallAudio
import br.com.queven.wabotia.device.core.PanelScreenWakePolicy
import br.com.queven.wabotia.device.core.PanelPinStore
import br.com.queven.wabotia.device.core.PanelSoundStore
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * O som do painel no Android: gongo no `ToneGenerator` e voz no
 * `TextToSpeech` em pt-BR. Vem do QRSenha (`ui/panel/AndroidPanelCallAudio.kt`).
 *
 * O painel é aparelho dedicado na tomada: o áudio vai pelo canal de alarme,
 * para a chamada se ouvir no salão com a mídia baixa. Sem sintetizador, sem
 * voz em português ou sem som, nada cai: o gongo sozinho sinaliza, ou nada
 * toca.
 */
class AndroidPanelCallAudio(
    context: Context,
    private val locale: Locale = Locale.forLanguageTag("pt-BR"),
) : PanelCallAudio {
    private val ready = AtomicBoolean(false)
    private var toneGenerator: ToneGenerator? = null

    /**
     * O painel toca no canal do alarme, que soa com o celular no silencioso.
     * O volume do painel é o do alarme: os botões do aparelho e o controle da
     * engrenagem mexem nele, e nada mais o muda (Bruno, 30/10: abaixava e
     * voltava ao máximo, porque o app reaplicava o volume ao abrir).
     */
    private val audioManager = context.applicationContext.getSystemService(AudioManager::class.java)

    /** A sessão de áudio da voz, para o reforço de ganho valer só nela. */
    private val speechSession: Int? =
        audioManager?.let { manager -> runCatching { manager.generateAudioSessionId() }.getOrNull() }
            ?.takeIf { it != AudioManager.ERROR }

    /** Reforço de ganho da voz: o volume máximo do tablet ainda era baixo para a sala. */
    private val loudness: LoudnessEnhancer? =
        speechSession?.let { session ->
            runCatching {
                LoudnessEnhancer(session).apply {
                    setTargetGain(SPEECH_GAIN_MB)
                    enabled = true
                }
            }.getOrNull()
        }

    /** O que chegou antes de o motor ligar: sai assim que ele fica pronto. */
    private val pending = mutableListOf<String>()

    /**
     * A mesma voz em todo painel: o motor do Google quando está instalado, e o
     * padrão do aparelho só sem ele. Na bancada (25/09) o A10s falava com o
     * motor da Samsung, rápido e com outro timbre, e o tablet com o do Google;
     * dois painéis na mesma sala soavam como duas pessoas.
     */
    private val speech: TextToSpeech? = createSpeech(context.applicationContext)

    private fun createSpeech(context: Context): TextToSpeech? {
        val google = GOOGLE_TTS.takeIf { installed(context, it) }
        return runCatching {
            TextToSpeech(context, { status -> if (status == TextToSpeech.SUCCESS) onSpeechReady() }, google)
        }.getOrNull()
    }

    private fun installed(context: Context, packageName: String): Boolean =
        runCatching { context.packageManager.getPackageInfo(packageName, 0) }.isSuccess

    init {
        speech?.let { engine ->
            runCatching {
                engine.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
            }
        }
    }

    /** O idioma vai depois da inicialização: antes dela o motor recusa. */
    private fun onSpeechReady() {
        val engine = speech ?: return
        val result = runCatching { engine.setLanguage(locale) }.getOrNull()
        // Sem a voz em português, falar em outra língua confunde a sala: só o gongo.
        // Um pouco mais devagar que a fala comum: a senha é ouvida de longe.
        runCatching { engine.setSpeechRate(SPEECH_RATE) }
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            synchronized(pending) { pending.clear() }
            return
        }
        val waiting =
            synchronized(pending) {
                ready.set(true)
                pending.toList().also { pending.clear() }
            }
        waiting.forEach(::say)
    }

    @Synchronized
    override fun chime() {
        val generator =
            toneGenerator
                ?: runCatching { ToneGenerator(AudioManager.STREAM_ALARM, CHIME_VOLUME) }
                    .getOrNull()
                    ?.also { toneGenerator = it }
                ?: return
        runCatching { generator.startTone(ToneGenerator.TONE_PROP_BEEP2, CHIME_DURATION_MS) }
    }

    override fun speak(text: String) {
        synchronized(pending) {
            // Antes de o motor ligar, a frase espera; no máximo três, como o
            // anúncio de uma leitura.
            if (!ready.get()) {
                if (speech != null && pending.size < 3) pending += text
                return
            }
        }
        say(text)
    }

    private fun say(text: String) {
        // QUEUE_ADD mantém a ordem: duas senhas chamadas juntas saem uma depois
        // da outra, nunca sobrepostas. A sessão leva o reforço de ganho.
        val params = Bundle().apply { speechSession?.let { putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, it) } }
        runCatching { speech?.speak(text, TextToSpeech.QUEUE_ADD, params, text.hashCode().toString()) }
    }

    override fun setVolume(level: Float) {
        val manager = audioManager ?: return
        runCatching {
            val max = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            // O alarme não desce a zero em muitos aparelhos; o Mudo é que cala.
            val target = (level.coerceIn(0f, 1f) * max).roundToInt().coerceIn(1, max)
            manager.setStreamVolume(AudioManager.STREAM_ALARM, target, 0)
        }
    }

    @Synchronized
    override fun stop() {
        synchronized(pending) { pending.clear() }
        runCatching { speech?.stop() }
        toneGenerator?.let { runCatching { it.release() } }
        toneGenerator = null
    }

    override fun shutdown() {
        stop()
        runCatching { speech?.shutdown() }
        runCatching { loudness?.release() }
        ready.set(false)
    }

    private companion object {
        const val GOOGLE_TTS = "com.google.android.tts"
        const val SPEECH_RATE = 0.85f
        const val CHIME_VOLUME = 90
        const val CHIME_DURATION_MS = 420

        /** +8 dB na voz; mais que isso distorce no alto-falante do celular. */
        const val SPEECH_GAIN_MB = 800
    }
}

/** O volume do alarme do sistema, de 0 a 1 (o canal em que o painel fala). */
fun alarmVolume(context: Context): Float? =
    context.applicationContext.getSystemService(AudioManager::class.java)?.let { manager ->
        runCatching {
            val max = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            if (max <= 0) null else manager.getStreamVolume(AudioManager.STREAM_ALARM).toFloat() / max
        }.getOrNull()
    }

/**
 * Enquanto o painel está aberto, os botões de volume do aparelho mexem no
 * canal em que ele fala (o do alarme), e não no da mídia; cada mudança do
 * alarme chega em [onChange], para a engrenagem e o guardado acompanharem.
 */
@Composable
fun PanelVolumeKeysEffect(onChange: (Float) -> Unit = {}) {
    val activity = LocalContext.current as? Activity ?: return
    val latest by rememberUpdatedState(onChange)
    DisposableEffect(activity) {
        val before = activity.volumeControlStream
        activity.volumeControlStream = AudioManager.STREAM_ALARM
        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    if (intent.getIntExtra(EXTRA_VOLUME_STREAM_TYPE, -1) != AudioManager.STREAM_ALARM) return
                    alarmVolume(context)?.let(latest)
                }
            }
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(VOLUME_CHANGED_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
        alarmVolume(activity)?.let(latest)
        onDispose {
            activity.volumeControlStream = before
            runCatching { activity.unregisterReceiver(receiver) }
        }
    }
}

/**
 * Dentro de um diálogo (a engrenagem), os botões de volume também vão para o
 * alarme: a janela do diálogo não herda o canal da tela (A07, 30/10).
 */
@Composable
fun DialogAlarmVolumeKeys() {
    val view = LocalView.current
    DisposableEffect(view) {
        val dialog = ((view.parent as? DialogWindowProvider)?.window?.callback as? android.app.Dialog)
        val before = dialog?.volumeControlStream
        dialog?.volumeControlStream = AudioManager.STREAM_ALARM
        onDispose { if (before != null) dialog.volumeControlStream = before }
    }
}

// Sem constante pública no SDK; é o aviso do sistema a cada mudança de volume.
private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
private const val EXTRA_VOLUME_STREAM_TYPE = "android.media.EXTRA_VOLUME_STREAM_TYPE"

/** O som das chamadas por aparelho, num `SharedPreferences` só deste celular. */
class SharedPreferencesPanelSoundStore(context: Context) : PanelSoundStore {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    /** O painel nasce falando: o botão existe para silenciar a sala. */
    override fun enabled(deviceId: String): Boolean = preferences.getBoolean(deviceId, true)

    override fun setEnabled(deviceId: String, enabled: Boolean) {
        preferences.edit().putBoolean(deviceId, enabled).apply()
    }

    override fun volume(deviceId: String): Float? =
        "$deviceId.volume".takeIf(preferences::contains)?.let { preferences.getFloat(it, 1f) }

    override fun setVolume(deviceId: String, level: Float) {
        preferences.edit().putFloat("$deviceId.volume", level).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "vinki_panel_call_sound"
    }
}

/**
 * O template dos painéis por aparelho (decisão 17), num `SharedPreferences`
 * só deste celular, como o som: a escolha não passa pela central.
 */
class SharedPreferencesPanelTemplateStore(context: Context) : PanelTemplateStore {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun template(deviceId: String): PanelTemplate = PanelTemplate.fromId(preferences.getString(deviceId, null))

    override fun setTemplate(deviceId: String, template: PanelTemplate) {
        preferences.edit().putString(deviceId, template.id).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "vinki_panel_template"
    }
}

/** O PIN do painel, selado (sal e resumo), por aparelho, só neste celular. */
class SharedPreferencesPanelPinStore(context: Context) : PanelPinStore {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun sealed(deviceId: String): String? = preferences.getString(deviceId, null)

    override fun save(deviceId: String, sealed: String?) {
        preferences.edit().apply { if (sealed == null) remove(deviceId) else putString(deviceId, sealed) }.apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "vinki_panel_pin"
    }
}

/**
 * Painel, totem e balcão ficam de pé o dia todo: a tela não apaga enquanto a
 * tela do aparelho está à frente. Em segundo plano ou ao sair, a `View` volta
 * ao valor de antes (QRSenha, `PanelKeepScreenOnEffect.kt`).
 */
@Composable
internal fun KeepScreenOnEffect() {
    val view = LocalView.current
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(view, lifecycleOwner) {
        val policy = PanelScreenWakePolicy(originalValue = view.keepScreenOn, applyValue = { view.keepScreenOn = it })
        val observer =
            LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_START, Lifecycle.Event.ON_RESUME -> policy.onForeground()
                    Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> policy.onBackground()
                    else -> Unit
                }
            }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) policy.onForeground()
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            policy.close()
        }
    }
}

/**
 * Tela cheia no painel e no totem: esconde as barras do sistema (o relógio no
 * alto e a barra de apps do tablet embaixo) enquanto a tela está aberta. Um
 * deslize na borda as mostra por alguns segundos; sair da tela as devolve.
 */
@Composable
internal fun ImmersiveEffect() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.context as? android.app.Activity)?.window
        val controller = window?.let { androidx.core.view.WindowCompat.getInsetsController(it, view) }
        controller?.systemBarsBehavior =
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller?.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        onDispose { controller?.show(androidx.core.view.WindowInsetsCompat.Type.systemBars()) }
    }
}
