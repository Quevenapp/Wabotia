package br.com.queven.wabotia.device

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.device.core.PanelCallAnnouncer
import br.com.queven.wabotia.device.core.PanelCallAudio
import br.com.queven.wabotia.device.core.PanelPin
import br.com.queven.wabotia.device.core.PanelPinAttempts
import br.com.queven.wabotia.device.core.PanelPinStore
import br.com.queven.wabotia.device.core.PanelSoundStore
import br.com.queven.wabotia.device.core.PanelTemplate
import br.com.queven.wabotia.device.core.PanelTemplateStore
import br.com.queven.wabotia.device.core.StationCall
import br.com.queven.wabotia.printing.CouponData
import br.com.queven.wabotia.printing.SenhaPrinter
import br.com.queven.wabotia.printing.TicketPrint
import br.com.queven.wabotia.queue.CallFrame
import br.com.queven.wabotia.queue.DeviceScopes
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.QueueFrame
import br.com.queven.wabotia.queue.QueueInfo
import br.com.queven.wabotia.queue.QueueOverview
import br.com.queven.wabotia.queue.QueuePairing
import br.com.queven.wabotia.queue.QueueTicket
import br.com.queven.wabotia.queue.normalizeBaseUrl
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** O que o modo aparelho usa do Android; montado em [DeviceActivity], trocável nos testes. */
class DeviceServices(
    val store: DeviceConfigStore,
    val pairing: QueuePairing,
    val printer: SenhaPrinter,
    val sound: PanelSoundStore,
    val pins: PanelPinStore,
    val templates: PanelTemplateStore,
    val audio: () -> PanelCallAudio,
    /** O endereço escolhido na tela Servidor (ou o da demonstração). */
    val serverUrl: String?,
    val demo: Boolean,
)

/** O código mostrado enquanto o administrador aprova o pareamento. */
data class PairingUi(val userCode: String? = null, val error: String? = null, val busy: Boolean = false)

data class DeviceState(
    val config: DeviceConfig? = null,
    val serverUrl: String? = null,
    val demo: Boolean = false,
    val pairing: PairingUi = PairingUi(),
    val overview: QueueOverview? = null,
    /** WebSocket aberto: as chamadas chegam na hora. */
    val live: Boolean = false,
    /** Sem resposta do Wabotia: o totem não emite. */
    val offline: Boolean = false,
    val busy: Boolean = false,
    /** Fila tocada no totem, esperando Normal ou Preferencial. */
    val choosing: QueueInfo? = null,
    val issued: QueueTicket? = null,
    val print: TicketPrint? = null,
    val notice: String? = null,
    val spotlight: StationCall? = null,
    val soundEnabled: Boolean = true,
    val template: PanelTemplate = PanelTemplate.DEFAULT,
    val pinSet: Boolean = false,
    val pinError: String? = null,
    /** O aparelho deixou de valer no servidor (revogado): só resta parear de novo. */
    val revoked: Boolean = false,
    /** O pareamento terminou (desfeito ou saída da demonstração): a Activity fecha. */
    val finished: Boolean = false,
)

/**
 * O aparelho diante do Wabotia (porta do `SenhaViewModel` do Senhapp, sem o guichê): pareamento, a fila ao vivo
 * (WebSocket com volta automática e leitura a cada 5 s sem ele), a emissão com impressão e a voz das chamadas. A fila
 * nunca é decidida aqui: ordem, número e espera vêm do servidor.
 */
class DeviceViewModel(private val services: DeviceServices) : ViewModel() {
    private val mutable = MutableStateFlow(
        DeviceState(config = services.store.load(), serverUrl = services.serverUrl, demo = services.demo),
    )
    val state: StateFlow<DeviceState> = mutable.asStateFlow()

    private var client: QueueClient? = null
    private var socket: WebSocket? = null
    private var loop: Job? = null
    private var spotlightJob: Job? = null
    private var issuedJob: Job? = null
    private var pairingJob: Job? = null
    private var audio: PanelCallAudio = PanelCallAudio.None
    private val announcer = PanelCallAnnouncer()
    private val pinAttempts = PanelPinAttempts()

    init {
        mutable.value.config?.let(::connect)
    }

    // --- pareamento -----------------------------------------------------------

    fun startPairing(url: String, name: String) {
        if (url.isBlank() || name.isBlank()) {
            mutable.update { it.copy(pairing = PairingUi(error = "Informe o endereço do Wabotia e um nome para este aparelho.")) }
            return
        }
        val base = normalizeBaseUrl(url)
        mutable.update { it.copy(pairing = PairingUi(busy = true), serverUrl = base) }
        pairingJob?.cancel()
        pairingJob = viewModelScope.launch {
            try {
                val start = services.pairing.start(base, name.trim())
                mutable.update { it.copy(pairing = PairingUi(userCode = start.userCode, busy = true)) }
                val until = System.currentTimeMillis() + start.expiresIn * 1000L
                // RFC 8628: nunca abaixo do intervalo pedido (5 s no Wabotia); a demonstração responde mais rápido.
                var wait = start.interval.coerceAtLeast(if (services.demo) 1 else 5) * 1000L
                while (System.currentTimeMillis() < until) {
                    delay(wait)
                    val result = try {
                        services.pairing.poll(base, start.deviceCode)
                    } catch (e: QueueException) {
                        when {
                            e.code == "slow_down" -> { wait += 5000; continue }
                            e.retryable -> continue
                            else -> throw e
                        }
                    }
                    val token = result.accessToken
                    val profile = result.profileId
                    if (result.status == "connected" && token != null && profile != null) {
                        val config = DeviceConfig(
                            deviceId = newDeviceId(),
                            baseUrl = base,
                            token = token,
                            profileId = profile,
                            name = name.trim(),
                            scopes = result.scopes,
                            demo = services.demo,
                        )
                        if (!config.allows(DeviceScopes.READ)) {
                            mutable.update { it.copy(pairing = PairingUi(error = "O administrador não liberou a leitura da fila. Revogue este acesso no painel e pareie de novo com “Ler a fila” marcado.")) }
                            return@launch
                        }
                        services.store.save(config)
                        mutable.update {
                            it.copy(
                                config = config,
                                pairing = PairingUi(),
                                revoked = false,
                                notice = if (config.scopes?.contains(DeviceScopes.OPERATE) == true) OPERATE_NOTICE else null,
                            )
                        }
                        connect(config)
                        return@launch
                    }
                }
                mutable.update { it.copy(pairing = PairingUi(error = "O código expirou. Toque em Gerar código de novo.")) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: QueueException) {
                mutable.update { it.copy(pairing = PairingUi(error = pairingError(e))) }
            }
        }
    }

    fun cancelPairing() {
        pairingJob?.cancel()
        mutable.update { it.copy(pairing = PairingUi()) }
    }

    fun chooseRole(role: DeviceRole) {
        val config = mutable.value.config?.copy(role = role) ?: return
        if (role.totem && !config.canIssue()) {
            mutable.update { it.copy(notice = "O administrador não liberou “Emitir senhas” para este aparelho: use-o como painel de chamadas.") }
            return
        }
        services.store.save(config)
        audio.shutdown()
        audio = if (role.panel) services.audio() else PanelCallAudio.None
        mutable.update {
            it.copy(
                config = config,
                notice = null,
                pinSet = services.pins.sealed(config.deviceId) != null,
                soundEnabled = services.sound.enabled(config.deviceId),
                template = services.templates.template(config.deviceId),
            )
        }
    }

    fun setTemplate(template: PanelTemplate) {
        val id = mutable.value.config?.deviceId ?: return
        services.templates.setTemplate(id, template)
        mutable.update { it.copy(template = template) }
    }

    /** Desfaz o vínculo: avisa o servidor (sem bloquear se ele não responder) e esquece a credencial. */
    fun unpair() {
        val config = mutable.value.config
        stopLive()
        viewModelScope.launch {
            if (config != null && !config.demo && !mutable.value.revoked) {
                runCatching { services.pairing.disconnect(config.baseUrl, config.token) }
            }
            config?.let { services.pins.save(it.deviceId, null) }
            services.store.save(null)
            mutable.value = DeviceState(serverUrl = config?.baseUrl ?: services.serverUrl, demo = services.demo, finished = true)
        }
    }

    // --- conexão --------------------------------------------------------------

    private fun connect(config: DeviceConfig) {
        client = QueueClient(config.baseUrl, config.profileId, { config.token })
        if (config.role?.panel == true) audio = services.audio()
        mutable.update {
            it.copy(
                soundEnabled = services.sound.enabled(config.deviceId),
                pinSet = services.pins.sealed(config.deviceId) != null,
                template = services.templates.template(config.deviceId),
            )
        }
        loop?.cancel()
        loop = viewModelScope.launch {
            var backoff = 1000L
            while (true) {
                if (mutable.value.revoked) return@launch
                if (!mutable.value.live) {
                    refresh()
                    // A demonstração não tem WebSocket: lê a fila a cada 3 s.
                    if (socket == null && !config.demo) openSocket()
                    delay(
                        when {
                            mutable.value.offline -> backoff.also { backoff = (backoff * 2).coerceAtMost(30_000) }
                            config.demo -> 3000
                            else -> 5000
                        },
                    )
                } else {
                    backoff = 1000L
                    delay(60_000)
                    refresh()
                }
            }
        }
    }

    suspend fun refresh() {
        val c = client ?: return
        try {
            val overview = c.overview()
            mutable.update { it.copy(overview = overview, offline = false, notice = it.notice?.takeUnless { n -> n == REVOKED_NOTICE }) }
            onSnapshot(overview)
        } catch (e: CancellationException) {
            throw e
        } catch (e: QueueException) {
            if (e.status == 401) {
                stopLive()
                mutable.update { it.copy(offline = true, revoked = true, notice = REVOKED_NOTICE) }
            } else {
                mutable.update { it.copy(offline = true) }
            }
        }
    }

    private fun openSocket() {
        val c = client ?: return
        socket = c.socket(
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    mutable.update { it.copy(live = true, offline = false) }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = QueueFrame.parse(text) ?: return
                    // O anúncio (voz, destaque) roda na thread principal, a mesma da leitura por consulta.
                    viewModelScope.launch {
                        when (frame) {
                            is QueueFrame.Snapshot -> {
                                mutable.update { it.copy(overview = frame.overview, offline = false) }
                                onSnapshot(frame.overview)
                            }
                            is QueueFrame.Call -> onCall(frame.call)
                            QueueFrame.Pong -> Unit
                        }
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
            },
        )
    }

    private fun dropped(webSocket: WebSocket) {
        if (socket === webSocket) socket = null
        mutable.update { it.copy(live = false) }
    }

    private fun stopLive() {
        loop?.cancel()
        socket?.cancel()
        socket = null
        audio.shutdown()
        audio = PanelCallAudio.None
    }

    /**
     * Leitura nova da fila (WebSocket ou consulta): as chamadas que o painel ainda não falou são anunciadas. A primeira
     * leitura só marca o que já estava na tela, para o painel não recitar as chamadas antigas ao abrir.
     */
    private fun onSnapshot(overview: QueueOverview) {
        val calls = overview.recentCalls.orEmpty().mapIndexed { i, call -> call.toStationCall(i) }
        announce(calls)
    }

    /** Quadro `call` do WebSocket: a mesma senha na mesma vez não é anunciada duas vezes (o snapshot a traz de novo). */
    private fun onCall(frame: CallFrame) = announce(listOf(frame.toStationCall(0)))

    private fun announce(calls: List<StationCall>) {
        val role = mutable.value.config?.role ?: return
        if (!role.panel) {
            announcer.prime(calls)
            return
        }
        val announcement = announcer.announce(calls)
        val latest = announcement.latest ?: return
        spotlightJob?.cancel()
        spotlightJob = viewModelScope.launch {
            mutable.update { it.copy(spotlight = latest) }
            delay(8000)
            mutable.update { it.copy(spotlight = null) }
        }
        if (mutable.value.soundEnabled && announcement.chime) {
            audio.chime()
            // Uma chamada sozinha é falada duas vezes, como no Senhapp; várias de uma vez, uma vez cada.
            val repeat = if (announcement.spoken.size == 1) 2 else 1
            announcement.spoken.forEach { text -> repeat(repeat) { audio.speak(text) } }
        }
    }

    // --- totem ----------------------------------------------------------------

    fun chooseQueue(queueId: String) {
        if (mutable.value.offline || mutable.value.config?.canIssue() == false) return
        val queue = mutable.value.overview?.queues?.firstOrNull { it.id == queueId } ?: return
        mutable.update { it.copy(choosing = queue) }
    }

    fun cancelChoice() = mutable.update { it.copy(choosing = null) }

    fun issue(preferential: Boolean) {
        val queue = mutable.value.choosing ?: return
        val c = client ?: return
        val key = QueueClient.newKey()
        mutable.update { it.copy(choosing = null, busy = true, notice = null) }
        viewModelScope.launch {
            val ticket = try {
                issueOnce(c, queue.id, preferential, key)
            } catch (e: CancellationException) {
                throw e
            } catch (e: QueueException) {
                mutable.update { it.copy(busy = false, notice = e.message, offline = e.status == 0) }
                return@launch
            }
            mutable.update { it.copy(busy = false, issued = ticket, print = TicketPrint.Printing) }
            printIssued()
            scheduleIssuedDismiss()
        }
    }

    private suspend fun printIssued() {
        val ticket = mutable.value.issued ?: return
        val header = mutable.value.config?.name.orEmpty().ifBlank { "Wabotia" }
        val result = services.printer.print(CouponData.of(ticket, header))
        mutable.update { it.copy(print = result) }
    }

    /** Segunda via: quando a primeira ficou incerta, só com confirmação de quem está no totem. */
    fun reprint(confirmed: Boolean) {
        val print = mutable.value.print
        if (print is TicketPrint.Failed && print.reprintNeedsConfirmation && !confirmed) return
        mutable.update { it.copy(print = TicketPrint.Printing) }
        viewModelScope.launch {
            printIssued()
            scheduleIssuedDismiss()
        }
    }

    /** O cartão da senha some sozinho, menos quando o cupom falhou: aí fica até "Pronto" ou "Imprimir de novo". */
    private fun scheduleIssuedDismiss() {
        issuedJob?.cancel()
        if (mutable.value.print is TicketPrint.Failed) return
        issuedJob = viewModelScope.launch {
            delay(issuedCardMillis(mutable.value.print == TicketPrint.Printed))
            clearIssued()
        }
    }

    fun clearIssued() = mutable.update { it.copy(issued = null, print = null) }

    fun dismissNotice() = mutable.update { it.copy(notice = null) }

    // --- ajustes --------------------------------------------------------------

    fun setSound(enabled: Boolean) {
        val id = mutable.value.config?.deviceId ?: return
        services.sound.setEnabled(id, enabled)
        if (!enabled) audio.stop()
        mutable.update { it.copy(soundEnabled = enabled) }
    }

    fun testSound() {
        audio.chime()
        audio.speak("Senha N 1. Guichê 1.")
    }

    /** `null` quando o PIN foi guardado; senão, o problema dele. */
    fun createPin(pin: String, confirmation: String): String? {
        val id = mutable.value.config?.deviceId ?: return "Aparelho sem configuração."
        PanelPin.problem(pin)?.let { return it }
        if (pin != confirmation) return "Os dois PINs não conferem."
        services.pins.save(id, PanelPin.seal(pin))
        mutable.update { it.copy(pinSet = true) }
        return null
    }

    fun removePin() {
        val id = mutable.value.config?.deviceId ?: return
        services.pins.save(id, null)
        mutable.update { it.copy(pinSet = false) }
    }

    fun unlock(pin: String): Boolean {
        val id = mutable.value.config?.deviceId ?: return true
        val sealed = services.pins.sealed(id) ?: return true
        if (pinAttempts.locked()) {
            mutable.update { it.copy(pinError = "Muitas tentativas. Aguarde 30 segundos.") }
            return false
        }
        return if (PanelPin.matches(pin, sealed)) {
            pinAttempts.succeed()
            mutable.update { it.copy(pinError = null) }
            true
        } else {
            pinAttempts.fail()
            mutable.update { it.copy(pinError = "PIN incorreto.") }
            false
        }
    }

    fun clearPinError() = mutable.update { it.copy(pinError = null) }

    override fun onCleared() {
        stopLive()
    }

    private fun pairingError(e: QueueException): String = when (e.code) {
        "access_denied" -> "O administrador recusou este aparelho. Gere outro código se foi engano."
        "expired_token" -> "O código expirou. Toque em Gerar código de novo."
        QueueException.NETWORK -> "Sem conexão com o Wabotia. Confira a rede e o endereço."
        else -> e.message ?: "Não foi possível parear."
    }

    companion object {
        const val REVOKED_NOTICE = "Este aparelho foi desconectado no Wabotia. Desfaça o pareamento nos ajustes e conecte de novo."
        const val OPERATE_NOTICE = "O administrador liberou também “Chamar e transferir senhas”, que o modo aparelho não usa. Para um totem mais seguro, revogue e aprove de novo só Ler e Emitir."

        fun factory(services: DeviceServices) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = DeviceViewModel(services) as T
        }
    }
}
