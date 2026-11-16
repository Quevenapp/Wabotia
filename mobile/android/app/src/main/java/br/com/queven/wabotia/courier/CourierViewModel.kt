package br.com.queven.wabotia.courier

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CourierState(
    /** As entregas em andamento, na ordem em que foram escaneadas. */
    val deliveries: List<CourierDelivery> = emptyList(),
    /** A entrega aberta na tela; null mostra a lista. */
    val open: String? = null,
    val restoring: Boolean = true,
    val claiming: Boolean = false,
    /** Aviso transitório (snackbar). */
    val notice: String? = null,
    val messages: Map<String, Map<CourierParty, List<CourierMessage>>> = emptyMap(),
    val sending: Boolean = false,
    val finishing: String? = null,
    /** Hora da última posição lida (ms), para "última posição às 19:20". */
    val lastFixAt: Long? = null,
    /** Sem nenhuma entrega depois de ter tido alguma: o acesso acabou e o app volta à primeira tela. */
    val ended: Boolean = false,
)

/**
 * O modo entregador: as entregas escaneadas, a fila de posições de cada uma, o envio em lote no ritmo do servidor, as
 * conversas com a loja e com o cliente e o "Entreguei". A posição só entra enquanto a tela está em uso (quem lê o GPS
 * é a tela, presa ao ciclo de vida); aqui não há serviço em segundo plano.
 */
class CourierViewModel(
    private val backend: CourierBackend,
    private val store: CourierSessionStore,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val mutable = MutableStateFlow(CourierState())
    val state: StateFlow<CourierState> = mutable.asStateFlow()

    private val sessions = linkedMapOf<String, CourierSession>()
    private val queues = mutableMapOf<String, PositionQueue>()
    private var pace = CourierPace()
    private var near = false

    /** Retoma as entregas guardadas; as que o servidor já encerrou somem. */
    fun restore() {
        viewModelScope.launch {
            val saved = store.load()
            val alive = mutableListOf<CourierDelivery>()
            for (session in saved) {
                try {
                    val delivery = backend.delivery(session)
                    sessions[delivery.id] = session
                    queues[delivery.id] = PositionQueue()
                    delivery.app?.let { pace = it }
                    alive += delivery
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CourierRevoked) {
                    // Encerrada enquanto o app estava fechado.
                } catch (e: Exception) {
                    // Sem rede: mantém a credencial e mostra o que se sabe (só o id) até a próxima leitura.
                    sessions[session.deliveryId] = session
                    queues[session.deliveryId] = PositionQueue()
                    alive += CourierDelivery(id = session.deliveryId)
                }
            }
            persist()
            mutable.update { it.copy(deliveries = alive, restoring = false, ended = saved.isNotEmpty() && alive.isEmpty()) }
        }
    }

    /** O QR escaneado (ou o código digitado): mais uma entrega na lista. */
    fun claim(link: CourierLink) {
        if (mutable.value.claiming) return
        mutable.update { it.copy(claiming = true, notice = null) }
        viewModelScope.launch {
            try {
                val (session, delivery) = backend.claim(link)
                sessions[delivery.id] = session
                queues.getOrPut(delivery.id) { PositionQueue() }
                delivery.app?.let { pace = it }
                persist()
                mutable.update { s ->
                    s.copy(claiming = false, deliveries = s.deliveries.filterNot { it.id == delivery.id } + delivery, open = delivery.id, ended = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(claiming = false, notice = e.message ?: "Não deu para abrir este pedido.") }
            }
        }
    }

    fun open(id: String?) {
        mutable.update { it.copy(open = id) }
        if (id != null) CourierParty.entries.forEach { loadMessages(id, it) }
    }

    fun consumeNotice() = mutable.update { it.copy(notice = null) }

    val hasActive: Boolean get() = sessions.isNotEmpty()

    /** Uma leitura do GPS (só chega com a tela em uso): vai para a fila de cada entrega em andamento. */
    fun onLocation(point: PositionPoint) {
        queues.values.forEach { it.add(point, clock()) }
        mutable.update { it.copy(lastFixAt = point.t) }
    }

    fun sampleMillis(battery: Int?): Long = CourierPacing.sampleMillis(pace, battery)

    fun uploadMillis(battery: Int?): Long = CourierPacing.uploadMillis(pace, near, battery)

    /** Perto do destino de alguma entrega: o GPS passa para alta precisão. */
    val isNear: Boolean get() = near

    /** Manda o lote de cada entrega. Sem rede, os pontos ficam na fila para a próxima vez. */
    suspend fun flush(battery: Int?) {
        var anyNear = false
        for ((id, session) in sessions.toMap()) {
            val queue = queues[id] ?: continue
            val batch = queue.batch(clock())
            try {
                val reply = backend.positions(session, batch, battery)
                queue.ack(reply.lastAt, batch)
                reply.app?.let { pace = it }
                if (!reply.active) {
                    end(id, "${label(id)} foi encerrado pela loja.")
                    continue
                }
                anyNear = anyNear || reply.near
                mutable.update { s ->
                    s.copy(deliveries = s.deliveries.map { d ->
                        if (d.id != id) d else d.copy(etaMinutes = reply.etaMinutes ?: d.etaMinutes, distanceM = reply.distanceM ?: d.distanceM)
                    })
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: CourierRevoked) {
                end(id, "${label(id)} não está mais com você.")
            } catch (e: Exception) {
                // Sem sinal: a fila guarda até 2 horas e manda quando voltar.
            }
        }
        near = anyNear
    }

    fun loadMessages(id: String, party: CourierParty) {
        val session = sessions[id] ?: return
        viewModelScope.launch {
            try {
                val list = backend.messages(session, party)
                setMessages(id, party, list)
            } catch (e: CancellationException) {
                throw e
            } catch (e: CourierRevoked) {
                end(id, "${label(id)} não está mais com você.")
            } catch (e: Exception) {
                // Mantém a conversa que já estava na tela.
            }
        }
    }

    fun send(id: String, party: CourierParty, text: String) {
        val session = sessions[id] ?: return
        if (text.isBlank() || mutable.value.sending) return
        mutable.update { it.copy(sending = true) }
        viewModelScope.launch {
            try {
                backend.send(session, party, text.trim())
                setMessages(id, party, backend.messages(session, party))
                mutable.update { it.copy(sending = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: CourierRevoked) {
                mutable.update { it.copy(sending = false) }
                end(id, "${label(id)} não está mais com você.")
            } catch (e: Exception) {
                mutable.update { it.copy(sending = false, notice = e.message ?: "A mensagem não foi. Tente de novo.") }
            }
        }
    }

    /** "Entreguei": manda o que falta da posição, conclui e esquece a entrega. */
    fun delivered(id: String, battery: Int?) {
        val session = sessions[id] ?: return
        if (mutable.value.finishing != null) return
        mutable.update { it.copy(finishing = id) }
        viewModelScope.launch {
            try {
                queues[id]?.let { q -> q.batch(clock()).takeIf { it.isNotEmpty() }?.let { runCatching { backend.positions(session, it, battery) } } }
                backend.delivered(session)
                end(id, "${label(id)} entregue. Obrigado!")
            } catch (e: CancellationException) {
                throw e
            } catch (e: CourierRevoked) {
                end(id, "${label(id)} já tinha sido encerrado.")
            } catch (e: Exception) {
                mutable.update { it.copy(notice = e.message ?: "Não deu para concluir. Tente de novo.") }
            } finally {
                mutable.update { it.copy(finishing = null) }
            }
        }
    }

    /** O acesso a esta entrega acabou (entregue, revogada): some da lista; sem nenhuma, o app volta à primeira tela. */
    private fun end(id: String, notice: String) {
        sessions.remove(id)
        queues.remove(id)?.clear()
        persist()
        mutable.update { s ->
            val rest = s.deliveries.filterNot { it.id == id }
            s.copy(
                deliveries = rest,
                open = if (s.open == id) null else s.open,
                messages = s.messages - id,
                notice = notice,
                ended = rest.isEmpty(),
            )
        }
    }

    private fun setMessages(id: String, party: CourierParty, list: List<CourierMessage>) =
        mutable.update { s -> s.copy(messages = s.messages + (id to (s.messages[id].orEmpty() + (party to list)))) }

    private fun label(id: String) = mutable.value.deliveries.firstOrNull { it.id == id }?.label ?: "A entrega"

    private fun persist() = store.save(sessions.values.toList())

    companion object {
        fun factory(backend: CourierBackend, store: CourierSessionStore) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CourierViewModel(backend, store) as T
        }
    }
}
