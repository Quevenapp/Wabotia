package br.com.queven.wabotia.ui.queue

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.queue.CounterInfo
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.QueueFrame
import br.com.queven.wabotia.queue.QueueOverview
import br.com.queven.wabotia.queue.QueueTicket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

data class CounterUiState(
    val overview: QueueOverview? = null,
    val loading: Boolean = true,
    /** Erro do primeiro carregamento (tela inteira). */
    val error: String? = null,
    /** Guichê escolhido neste aparelho (por perfil). */
    val counterId: String? = null,
    /** A ação em andamento (assinatura), para o botão mostrar progresso e os demais esperarem. */
    val busy: String? = null,
    /** Erro de uma ação; fica até a pessoa fechar ou agir de novo. */
    val notice: String? = null,
    /** Confirmação curta (snackbar). */
    val message: String? = null,
    val live: Boolean = false,
) {
    val counter: CounterInfo? get() = overview?.counters?.firstOrNull { it.id == counterId }
    val current: QueueTicket? get() = counter?.current
}

/**
 * O guichê dentro do app logado, com o token da pessoa (`Bearer wabu_…`, aceito em todas as rotas `/queue`): escolher o
 * guichê, abrir, pausar, fechar, chamar a próxima, rechamar, iniciar, concluir, ausente e transferir. A fila é decidida
 * no servidor; aqui só se pede.
 *
 * Idempotência (mobile/README.md): cada intenção ganha uma `Idempotency-Key`; se a resposta não chegar (rede, 5xx), a
 * chave fica guardada e tocar de novo na mesma ação repete com ela — o Wabotia devolve a mesma resposta em vez de chamar
 * outra senha. Erro definitivo ou sucesso liberam a chave.
 */
class CounterViewModel(private val container: AppContainer) : ViewModel() {
    private val profileId = container.session.profileId.orEmpty()
    private val demo = container.isDemo
    private val prefs = container.appContext.getSharedPreferences("wabotia.queue", Context.MODE_PRIVATE)
    private val client = QueueClient(container.session.serverUrl.orEmpty(), profileId, { container.session.token })

    private val mutable = MutableStateFlow(CounterUiState(counterId = prefs.getString(counterKey(), null)))
    val state: StateFlow<CounterUiState> = mutable.asStateFlow()

    /** Escrita sem resposta: a mesma intenção repete com esta chave até o servidor confirmar. */
    private data class PendingWrite(val signature: String, val key: String, val fingerprint: String)

    private var pendingWrite: PendingWrite? = null
    private var loop: Job? = null
    private var socket: WebSocket? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)

    /** Enquanto a tela está visível: WebSocket (com volta) e, sem ele, leitura a cada 5 s. */
    fun start() {
        if (loop?.isActive == true) return
        loop = viewModelScope.launch {
            var backoff = 2_000L
            while (true) {
                if (!mutable.value.live) {
                    val ok = refresh()
                    if (socket == null && !demo) openSocket()
                    delay(if (ok) (if (demo) 3_000L else 5_000L) else backoff.also { backoff = (backoff * 2).coerceAtMost(30_000) })
                } else {
                    backoff = 2_000L
                    // Ao vivo, uma leitura por minuto; se o WebSocket cair, [dropped] acorda o laço na hora.
                    withTimeoutOrNull(60_000) { wake.receive() }
                    refresh()
                }
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
        socket?.cancel()
        socket = null
        mutable.update { it.copy(live = false) }
    }

    /** `true` quando a fila respondeu. */
    suspend fun refresh(): Boolean =
        try {
            val overview = client.overview()
            mutable.update { s ->
                // Guichê guardado que não existe mais (apagado no painel): volta à escolha.
                val keep = s.counterId?.takeIf { id -> overview.counters.orEmpty().any { it.id == id } }
                s.copy(overview = overview, loading = false, error = null, counterId = keep)
            }
            settlePending()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: QueueException) {
            if (e.unauthorized) container.onLoggedOut(keepServer = true)
            mutable.update { it.copy(loading = false, error = if (it.overview == null) e.message else null) }
            false
        }

    fun reload() {
        mutable.update { it.copy(loading = it.overview == null, error = null) }
        viewModelScope.launch { refresh() }
    }

    private fun openSocket() {
        socket = client.socket(
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    mutable.update { it.copy(live = true) }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = QueueFrame.parse(text) as? QueueFrame.Snapshot ?: return
                    mutable.update { it.copy(overview = frame.overview, loading = false, error = null) }
                    settlePending()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
            },
        )
    }

    private fun dropped(webSocket: WebSocket) {
        if (socket !== webSocket) return
        socket = null
        mutable.update { it.copy(live = false) }
        wake.trySend(Unit)
    }

    // --- guichê ---------------------------------------------------------------

    fun chooseCounter(id: String?) {
        prefs.edit().apply { if (id == null) remove(counterKey()) else putString(counterKey(), id) }.apply()
        pendingWrite = null
        mutable.update { it.copy(counterId = id, notice = null) }
    }

    fun setStatus(status: String) {
        val counter = mutable.value.counter ?: return
        if (counter.status == status) return
        write("state:${counter.id}:$status", success = { "Guichê ${statusLabel(status).lowercase()}" }) { key ->
            client.counterState(counter.id, status, key)
        }
    }

    fun callNext() {
        val counter = mutable.value.counter ?: return
        write("call:${counter.id}", success = { (it as? QueueTicket)?.let { t -> "Senha ${t.code} chamada" } ?: "Senha chamada" }) { key ->
            client.callNext(counter.id, key)
        }
    }

    /** `recall`, `start`, `finish` ou `no-show` na senha atual. */
    fun act(action: String) {
        val ticket = mutable.value.current ?: return
        write("$action:${ticket.id}", success = { actionDone(action, ticket.code) }) { key ->
            client.ticketAction(ticket.id, action, key)
        }
    }

    fun transfer(queueId: String?, counterId: String?) {
        val ticket = mutable.value.current ?: return
        write("transfer:${ticket.id}:${queueId ?: ""}:${counterId ?: ""}", success = { "Senha ${ticket.code} transferida" }) { key ->
            client.transfer(ticket.id, queueId, counterId, key)
        }
    }

    fun dismissNotice() = mutable.update { it.copy(notice = null) }

    fun consumeMessage() = mutable.update { it.copy(message = null) }

    private fun write(signature: String, success: (Any) -> String, block: suspend (key: String) -> Any) {
        if (mutable.value.busy != null) return
        val key = pendingWrite?.takeIf { it.signature == signature }?.key
            ?: QueueClient.newKey().also { pendingWrite = PendingWrite(signature, it, fingerprint(mutable.value)) }
        mutable.update { it.copy(busy = signature, notice = null) }
        viewModelScope.launch {
            try {
                val result = block(key)
                pendingWrite = null
                refresh()
                mutable.update { it.copy(busy = null, message = success(result)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: QueueException) {
                if (e.unauthorized) container.onLoggedOut(keepServer = true)
                if (!e.retryable) pendingWrite = null
                val text = if (e.retryable) "${e.message} Toque de novo para repetir com segurança." else e.message
                mutable.update { it.copy(busy = null, notice = text) }
                if (!e.retryable) refresh()
            }
        }
    }

    /**
     * A leitura nova mostra que o guichê mudou desde a intenção sem resposta (a chamada aconteceu, a senha andou): o
     * pedido foi confirmado pelo estado, e o próximo toque é uma intenção nova, com chave nova.
     */
    private fun settlePending() {
        val pending = pendingWrite ?: return
        if (mutable.value.busy == pending.signature) return
        if (fingerprint(mutable.value) != pending.fingerprint) pendingWrite = null
    }

    private fun fingerprint(s: CounterUiState): String =
        listOf(s.counterId, s.counter?.status, s.current?.id, s.current?.status, s.current?.callCount, s.current?.queueId).joinToString("|")

    private fun counterKey() = "counter.$profileId"

    override fun onCleared() = stop()

    companion object {
        fun statusLabel(status: String) = when (status) {
            "open" -> "Aberto"
            "paused" -> "Pausado"
            "closed" -> "Fechado"
            else -> status
        }

        fun ticketStatusLabel(status: String) = when (status) {
            "waiting" -> "Aguardando"
            "called" -> "Chamada"
            "serving" -> "Em atendimento"
            "done" -> "Concluída"
            "no_show" -> "Ausente"
            "cancelled" -> "Cancelada"
            else -> status
        }

        private fun actionDone(action: String, code: String) = when (action) {
            "recall" -> "Senha $code chamada de novo"
            "start" -> "Atendimento de $code iniciado"
            "finish" -> "Atendimento de $code concluído"
            "no-show" -> "$code marcada como ausente"
            else -> "Feito"
        }
    }
}
