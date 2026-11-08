package br.com.queven.wabotia.calls

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import br.com.queven.wabotia.core.model.CallSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Falha de WebRTC/áudio com mensagem pronta para a interface (pt-BR). */
class CallEngineException(message: String) : Exception(message)

/**
 * Motor WebRTC de uma única ligação de voz (só áudio, sem vídeo nem data channel).
 *
 * Ciclo: [start] → [createOffer] ou [createAnswer] (ambos aguardam a coleta ICE completa, até 12 s,
 * antes de devolver o SDP) → [applyAnswer] quando for o originador → [close].
 * O [PeerConnectionFactory] é inicializado uma única vez por processo.
 */
class CallEngine(context: Context) {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var peer: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var localTrack: AudioTrack? = null
    private var remoteTrack: AudioTrack? = null
    private var focusRequest: AudioFocusRequest? = null
    private var audioModeConfigured = false

    private val iceComplete = CompletableDeferred<Unit>()

    private val _connectionState = MutableStateFlow(PeerConnection.PeerConnectionState.NEW)
    /** Estado da conexão de mídia; FAILED indica que a rede não conectou o áudio. */
    val connectionState: StateFlow<PeerConnection.PeerConnectionState> = _connectionState.asStateFlow()

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()

    private val _speaker = MutableStateFlow(false)
    val speaker: StateFlow<Boolean> = _speaker.asStateFlow()

    @Volatile var closed = false
        private set

    val isStarted: Boolean get() = peer != null

    /** Cria a conexão, captura o microfone e coloca o aparelho em modo de comunicação. */
    fun start() {
        check(peer == null) { "Ligação já iniciada." }
        closed = false
        val factory = factory(appContext)
        // Sem servidores ICE, como no painel web: a infraestrutura da Meta é pública e os candidatos
        // locais bastam para a verificação de conectividade.
        val config = PeerConnection.RTCConfiguration(emptyList<PeerConnection.IceServer>()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = factory.createPeerConnection(config, observer)
            ?: throw CallEngineException("Não foi possível preparar o áudio neste aparelho.")
        peer = pc

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }
        val source = factory.createAudioSource(constraints)
        audioSource = source
        val track = factory.createAudioTrack("wabotia-audio-0", source)
        track.setEnabled(!_muted.value)
        localTrack = track
        pc.addTrack(track, listOf("wabotia-stream"))

        configureAudioMode()
    }

    /** Gera a oferta SDP com todos os candidatos ICE (até 12 s). */
    suspend fun createOffer(): CallSession {
        val pc = peer ?: throw CallEngineException("Ligação não iniciada.")
        val offer = createSdp(pc, isOffer = true)
        setLocal(pc, offer)
        awaitIceGathering(pc)
        val local = pc.localDescription ?: throw CallEngineException("Não foi possível gerar a oferta de áudio.")
        return CallSession(sdp_type = "offer", sdp = local.description)
    }

    /** Aplica a oferta recebida e gera a resposta SDP com todos os candidatos ICE (até 12 s). */
    suspend fun createAnswer(offerSdp: String): CallSession {
        val pc = peer ?: throw CallEngineException("Ligação não iniciada.")
        setRemote(pc, SessionDescription(SessionDescription.Type.OFFER, offerSdp))
        val answer = createSdp(pc, isOffer = false)
        setLocal(pc, answer)
        awaitIceGathering(pc)
        val local = pc.localDescription ?: throw CallEngineException("Não foi possível gerar a resposta de áudio.")
        return CallSession(sdp_type = "answer", sdp = local.description)
    }

    /** Aplica a resposta do cliente (ligação originada por nós). */
    suspend fun applyAnswer(answerSdp: String) {
        val pc = peer ?: throw CallEngineException("Ligação não iniciada.")
        setRemote(pc, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
    }

    /** Silencia/reativa o microfone (a faixa continua negociada; só deixa de enviar áudio). */
    fun setMuted(muted: Boolean) {
        _muted.value = muted
        runCatching { localTrack?.setEnabled(!muted) }
    }

    /** Viva-voz pelo AudioManager (modo comunicação já configurado em [start]). */
    @Suppress("DEPRECATION")
    fun setSpeaker(on: Boolean) {
        _speaker.value = on
        runCatching {
            if (!audioModeConfigured) configureAudioMode()
            audioManager.isSpeakerphoneOn = on
        }
    }

    /** Encerra a conexão, libera microfone e devolve o áudio do aparelho ao modo normal. Idempotente. */
    fun close() {
        if (closed) return
        closed = true
        if (!iceComplete.isCompleted) iceComplete.cancel()
        val pc = peer
        peer = null
        runCatching { pc?.close() }
        runCatching { remoteTrack?.setEnabled(false) }
        remoteTrack = null
        runCatching { pc?.dispose() }
        runCatching { localTrack?.dispose() }
        localTrack = null
        runCatching { audioSource?.dispose() }
        audioSource = null
        restoreAudioMode()
    }

    // --- áudio do aparelho ---

    @Suppress("DEPRECATION")
    private fun configureAudioMode() {
        runCatching {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener { }
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.isSpeakerphoneOn = _speaker.value
            audioModeConfigured = true
        }
    }

    @Suppress("DEPRECATION")
    private fun restoreAudioMode() {
        runCatching {
            audioManager.isSpeakerphoneOn = false
            audioManager.mode = AudioManager.MODE_NORMAL
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
            audioModeConfigured = false
        }
    }

    // --- SDP ---

    private val sdpConstraints: MediaConstraints
        get() = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }

    private suspend fun createSdp(pc: PeerConnection, isOffer: Boolean): SessionDescription =
        suspendCancellableCoroutine { cont ->
            val observer = object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription?) {
                    if (sdp == null) cont.resumeWithException(CallEngineException("Não foi possível preparar o áudio."))
                    else cont.resume(sdp)
                }
                override fun onCreateFailure(error: String?) {
                    cont.resumeWithException(CallEngineException("Não foi possível preparar o áudio. ${error.orEmpty()}".trim()))
                }
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) {}
            }
            if (isOffer) pc.createOffer(observer, sdpConstraints) else pc.createAnswer(observer, sdpConstraints)
        }

    private suspend fun setLocal(pc: PeerConnection, sdp: SessionDescription) =
        suspendCancellableCoroutine<Unit> { cont ->
            pc.setLocalDescription(object : SdpObserver {
                override fun onCreateSuccess(p0: SessionDescription?) {}
                override fun onCreateFailure(p0: String?) {}
                override fun onSetSuccess() { cont.resume(Unit) }
                override fun onSetFailure(error: String?) {
                    cont.resumeWithException(CallEngineException("Não foi possível aplicar o áudio local. ${error.orEmpty()}".trim()))
                }
            }, sdp)
        }

    private suspend fun setRemote(pc: PeerConnection, sdp: SessionDescription) =
        suspendCancellableCoroutine<Unit> { cont ->
            pc.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(p0: SessionDescription?) {}
                override fun onCreateFailure(p0: String?) {}
                override fun onSetSuccess() { cont.resume(Unit) }
                override fun onSetFailure(error: String?) {
                    cont.resumeWithException(CallEngineException("Não foi possível conectar o áudio. Encerre a ligação e confira a rede."))
                }
            }, sdp)
        }

    /** Espera a coleta ICE terminar; como no painel web, falha após 12 s sem concluir. */
    private suspend fun awaitIceGathering(pc: PeerConnection) {
        if (pc.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) return
        val done = withTimeoutOrNull(ICE_TIMEOUT_MS) {
            runCatching { iceComplete.await() }.isSuccess
        }
        if (done != true) throw CallEngineException("A rede demorou a preparar o áudio. Verifique sua conexão.")
    }

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
            if (state == PeerConnection.IceGatheringState.COMPLETE && !iceComplete.isCompleted) iceComplete.complete(Unit)
        }
        override fun onIceCandidate(candidate: IceCandidate?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
            val track = receiver?.track() as? AudioTrack ?: return
            remoteTrack = track
            runCatching { track.setEnabled(true) }
        }
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            if (newState != null) _connectionState.value = newState
        }
    }

    companion object {
        const val ICE_TIMEOUT_MS = 12_000L

        @Volatile private var sharedFactory: PeerConnectionFactory? = null

        /** Inicializa a biblioteca e cria a fábrica uma única vez por processo. */
        @Synchronized
        fun factory(context: Context): PeerConnectionFactory {
            sharedFactory?.let { return it }
            val app = context.applicationContext
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
            val audioModule = JavaAudioDeviceModule.builder(app)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .createAudioDeviceModule()
            return PeerConnectionFactory.builder()
                .setAudioDeviceModule(audioModule)
                .setOptions(PeerConnectionFactory.Options())
                .createPeerConnectionFactory()
                .also { sharedFactory = it }
        }
    }
}
