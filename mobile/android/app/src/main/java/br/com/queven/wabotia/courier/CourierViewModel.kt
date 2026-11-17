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
    /** As entregas, na ordem em que foram escaneadas. */
    val deliveries: List<CourierDelivery> = emptyList(),
    /** A entrega aberta na tela; null mostra a lista. */
    val open: String? = null,
    val restoring: Boolean = true,
    val claiming: Boolean = false,
    /** QR lido, esperando o entregador conferir a loja e o servidor (Continuar/Cancelar). */
    val confirm: CourierConfirm? = null,
    /** QR confirmado esperando o nome do entregador (o servidor exige; o cliente vê). */
    val pendingLink: CourierLink? = null,
    val pendingStore: String? = null,
    val name: String? = null,
    /** Aviso transitório (snackbar). */
    val notice: String? = null,
    /** A conversa de cada entrega, dos dois canais, em ordem de `seq`. */
    val messages: Map<String, List<CourierMessage>> = emptyMap(),
    /** O cliente pode receber mensagem pelo WhatsApp agora (janela de 24 h), por entrega. */
    val customerOpen: Map<String, Boolean> = emptyMap(),
    val sending: Boolean = false,
    /** Entrega com uma ação em curso (iniciar, entregar, cancelar). */
    val busy: String? = null,
    /** Hora da última posição lida (ms). */
    val lastFixAt: Long? = null,
    /** Sem nenhuma entrega depois de ter tido alguma: o acesso acabou e o app volta à primeira tela. */
    val ended: Boolean = false,
)

/** A confirmação antes de gastar o código: a loja (da leitura pública) e o host do QR. */
data class CourierConfirm(val link: CourierLink, val store: String? = null, val loading: Boolean = true)

/**
 * O modo entregador: as entregas escaneadas (uma credencial por entrega), a fila de posições de cada uma, o envio em
 * lote no ritmo do servidor, a conversa por sondagem e as ações (iniciar rota, entreguei, não consegui). A posição só
 * entra enquanto a tela está em uso: quem lê o GPS é a tela, presa ao ciclo de vida; aqui não há segundo plano.
 */
class CourierViewModel(
    private val backend: CourierBackend,
    private val store: CourierSessionStore,
    private val device: String = "Android",
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val mutable = MutableStateFlow(CourierState(name = store.name))
    val state: StateFlow<CourierState> = mutable.asStateFlow()

    private val sessions = linkedMapOf<String, CourierSession>()
    private val queues = mutableMapOf<String, PositionQueue>()
    private val lastSeq = mutableMapOf<String, Long>()
    private var pace = CourierPace()
    private var near = false

    /** Retoma as entregas guardadas; as que o servidor já encerrou (401) somem. */
    fun restore() {
        viewModelScope.launch {
            val saved = store.load()
            val alive = mutableListOf<CourierDelivery>()
            for (session in saved) {
                try {
                    val delivery = local(session, backend.delivery(session))
                    adopt(session, delivery)
                    alive += delivery
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CourierRevoked) {
                    // Encerrada enquanto o app estava fechado.
                } catch (e: Exception) {
                    // Sem rede: mantém a credencial e mostra o que se sabe até a próxima leitura.
                    adopt(session, null)
                    alive += CourierDelivery(id = keyOf(session), status = "en_route", store = session.storeName ?: session.host)
                }
            }
            persist()
            mutable.update { it.copy(deliveries = alive, restoring = false, ended = saved.isNotEmpty() && alive.isEmpty()) }
            alive.forEach { refreshMessages(it.id) }
        }
    }

    /** O texto lido pela câmera (ou colado): recusa com explicação, ou segue para a confirmação da loja. */
    fun scanned(raw: String) {
        when (val scan = CourierLinks.check(raw)) {
            is CourierScan.Rejected -> mutable.update { it.copy(notice = scan.message) }
            is CourierScan.Ok -> claim(scan.link)
        }
    }

    /**
     * Um QR válido: primeiro a leitura pública (não gasta o código) para mostrar a loja e o servidor; só depois de
     * Continuar o app pede o nome, se ainda não tiver, e troca o código. O servidor é sempre o host do QR: se a leitura
     * apontar para outro, o app não segue.
     */
    fun claim(link: CourierLink) {
        if (mutable.value.confirm != null || mutable.value.claiming) return
        mutable.update { it.copy(confirm = CourierConfirm(link), notice = null) }
        viewModelScope.launch {
            try {
                val preview = backend.preview(link)
                when {
                    !preview.valid -> mutable.update { it.copy(confirm = null, notice = INVALID) }
                    !CourierLinks.sameServer(link, preview.server) ->
                        mutable.update { it.copy(confirm = null, notice = "Este QR indica outro servidor (${preview.server}). Por segurança, a entrega não foi aberta. Fale com a loja.") }
                    else -> mutable.update { it.copy(confirm = CourierConfirm(link, preview.store?.trim()?.takeIf(String::isNotEmpty), loading = false)) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(confirm = null, notice = e.message ?: "Não deu para ler este pedido.") }
            }
        }
    }

    /** "Continuar": pede o nome (se faltar) e troca o código. */
    fun confirmContinue() {
        val c = mutable.value.confirm ?: return
        if (c.loading) return
        mutable.update { it.copy(confirm = null) }
        val name = store.name
        if (name.isNullOrBlank()) mutable.update { it.copy(pendingLink = c.link, pendingStore = c.store) } else claim(c.link, name, c.store)
    }

    fun cancelConfirm() = mutable.update { it.copy(confirm = null) }

    fun claimWithName(name: String) {
        val link = mutable.value.pendingLink ?: return
        val clean = name.trim().take(60)
        if (clean.length < 2) return
        store.name = clean
        val storeName = mutable.value.pendingStore
        mutable.update { it.copy(pendingLink = null, pendingStore = null, name = clean) }
        claim(link, clean, storeName)
    }

    fun dismissName() = mutable.update { it.copy(pendingLink = null, pendingStore = null) }

    private fun claim(link: CourierLink, name: String, storeName: String?) {
        if (mutable.value.claiming) return
        mutable.update { it.copy(claiming = true, notice = null) }
        viewModelScope.launch {
            try {
                val (claimed, raw) = backend.claim(link, name, device)
                val session = claimed.copy(storeName = claimed.storeName ?: storeName)
                val delivery = local(session, raw)
                adopt(session, delivery)
                persist()
                mutable.update { s ->
                    s.copy(claiming = false, deliveries = s.deliveries.filterNot { it.id == delivery.id } + delivery, open = delivery.id, ended = false)
                }
                refreshMessages(delivery.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(claiming = false, notice = e.message ?: "Não deu para abrir este pedido.") }
            }
        }
    }
    fun open(id: String?) {
        mutable.update { it.copy(open = id) }
        if (id != null) refreshMessages(id)
    }

    fun consumeNotice() = mutable.update { it.copy(notice = null) }

    /**
     * Iniciar rota: o destino vem do aparelho ([geocode], gratuito e local) quando o servidor ainda não tem, procurado
     * perto da loja ([CourierDestination]); endereço sem cidade não é procurado. A partir daqui a posição passa a ser
     * enviada.
     */
    fun start(id: String, geocode: suspend (DestinationSearch.Search) -> LatLng?) {
        val session = sessions[id] ?: return
        if (mutable.value.busy != null) return
        mutable.update { it.copy(busy = id) }
        viewModelScope.launch {
            act(id) {
                val plan = delivery(id)?.let(CourierDestination::plan)
                val destination = (plan as? DestinationSearch.Search)?.let { geocode(it) }
                backend.start(session, destination)?.let { pace = it }
                replace(local(session, backend.delivery(session)))
            }
        }
    }

    /** "Entreguei": manda o que falta da posição, conclui e esquece a entrega. */
    fun delivered(id: String, battery: Int?) = finish(id, "${label(id)} entregue. Obrigado!") { session ->
        queues[id]?.let { q -> q.batch(clock()).takeIf { it.isNotEmpty() }?.let { runCatching { backend.positions(session, it, battery) } } }
        backend.delivered(session, null)
    }

    /** "Não consegui entregar", com o motivo (a loja decide o que fazer com o pedido). */
    fun cancel(id: String, reason: String) = finish(id, "${label(id)}: a loja foi avisada.") { session ->
        backend.cancel(session, reason.trim().ifBlank { "Não consegui entregar" })
    }

    private fun finish(id: String, notice: String, block: suspend (CourierSession) -> Unit) {
        val session = sessions[id] ?: return
        if (mutable.value.busy != null) return
        mutable.update { it.copy(busy = id) }
        viewModelScope.launch {
            try {
                block(session)
                end(id, notice)
            } catch (e: CancellationException) {
                throw e
            } catch (e: CourierRevoked) {
                end(id, "${label(id)} já tinha sido encerrado.")
            } catch (e: Exception) {
                mutable.update { it.copy(notice = e.message ?: "Não deu. Tente de novo.") }
            } finally {
                mutable.update { it.copy(busy = null) }
            }
        }
    }

    /** Uma leitura do GPS (só chega com a tela em uso): vai para a fila de cada entrega a caminho. */
    fun onLocation(point: PositionPoint) {
        val enRoute = mutable.value.deliveries.filter { it.enRoute }.map { it.id }.toSet()
        queues.filterKeys { it in enRoute }.values.forEach { it.add(point, clock()) }
        mutable.update { it.copy(lastFixAt = point.t) }
    }

    /** Alguma entrega a caminho: só então o GPS liga. */
    val wantsLocation: Boolean get() = mutable.value.deliveries.any { it.enRoute }

    fun sampleMillis(battery: Int?): Long = CourierPacing.sampleMillis(pace, battery)

    fun uploadMillis(battery: Int?): Long = CourierPacing.uploadMillis(pace, near, battery)

    val isNear: Boolean get() = near

    /** Manda o lote de cada entrega a caminho. Sem rede, os pontos ficam na fila para a próxima vez. */
    suspend fun flush(battery: Int?) {
        var anyNear = false
        for ((id, session) in sessions.toMap()) {
            if (delivery(id)?.enRoute != true) continue
            val queue = queues[id] ?: continue
            val batch = queue.batch(clock())
            if (batch.isEmpty()) continue
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
                    s.copy(deliveries = s.deliveries.map { d -> if (d.id != id) d else d.copy(eta = reply.eta ?: d.eta, arriving = reply.arriving) })
                }
                // Mensagem nova na conversa da entrega: busca.
                val seq = reply.chat?.lastSeq
                if (seq != null && seq > (lastSeq[id] ?: 0)) refreshMessages(id)
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

    /** Busca as mensagens novas (`after` = última lida). A tela da conversa chama a cada 15 s. */
    fun refreshMessages(id: String) {
        val session = sessions[id] ?: return
        viewModelScope.launch {
            try {
                val page = backend.messages(session, lastSeq[id] ?: 0)
                lastSeq[id] = maxOf(lastSeq[id] ?: 0, page.lastSeq)
                mutable.update { s ->
                    val merged = (s.messages[id].orEmpty() + page.data).distinctBy { it.seq }.sortedBy { it.seq }
                    s.copy(
                        messages = s.messages + (id to merged),
                        customerOpen = page.customerOpen?.let { s.customerOpen + (id to it) } ?: s.customerOpen,
                    )
                }
                if (!page.open) end(id, "${label(id)} foi encerrado.")
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
                backend.send(session, party, text.trim().take(1000))
                mutable.update { it.copy(sending = false) }
                refreshMessages(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: CourierRevoked) {
                mutable.update { it.copy(sending = false) }
                end(id, "${label(id)} não está mais com você.")
            } catch (e: CourierFailure) {
                val closed = e.code == "window_closed" || e.code == "no_conversation"
                mutable.update { s ->
                    s.copy(sending = false, notice = e.message, customerOpen = if (closed) s.customerOpen + (id to false) else s.customerOpen)
                }
            } catch (e: Exception) {
                mutable.update { it.copy(sending = false, notice = e.message ?: "A mensagem não foi. Tente de novo.") }
            }
        }
    }

    private suspend fun act(id: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: CourierRevoked) {
            end(id, "${label(id)} não está mais com você.")
        } catch (e: Exception) {
            mutable.update { it.copy(notice = e.message ?: "Não deu. Tente de novo.") }
        } finally {
            mutable.update { it.copy(busy = null) }
        }
    }

    private fun adopt(session: CourierSession, delivery: CourierDelivery?) {
        val key = keyOf(session)
        sessions[key] = session
        queues.getOrPut(key) { PositionQueue() }
        delivery?.app?.let { pace = it }
        delivery?.chat?.customerOpen?.let { open -> mutable.update { it.copy(customerOpen = it.customerOpen + (key to open)) } }
    }

    /**
     * Lojas diferentes podem repetir o id de uma entrega: no app, cada uma é `host/id` e leva o nome da loja. As
     * chamadas usam o id do servidor, que fica na credencial.
     */
    private fun keyOf(session: CourierSession) = "${session.host}/${session.deliveryId}"

    private fun local(session: CourierSession, delivery: CourierDelivery) =
        delivery.copy(id = keyOf(session), store = session.storeName ?: session.host)

    private fun replace(delivery: CourierDelivery) = mutable.update { s -> s.copy(deliveries = s.deliveries.map { if (it.id == delivery.id) delivery else it }) }

    /** O acesso a esta entrega acabou: apaga credencial e fila; sem nenhuma entrega, o app volta à primeira tela. */
    private fun end(id: String, notice: String) {
        sessions.remove(id)
        queues.remove(id)?.clear()
        lastSeq.remove(id)
        persist()
        mutable.update { s ->
            val rest = s.deliveries.filterNot { it.id == id }
            s.copy(
                deliveries = rest,
                open = if (s.open == id) null else s.open,
                messages = s.messages - id,
                customerOpen = s.customerOpen - id,
                notice = notice,
                ended = rest.isEmpty(),
            )
        }
    }

    private fun delivery(id: String) = mutable.value.deliveries.firstOrNull { it.id == id }

    private fun label(id: String) = delivery(id)?.label ?: "A entrega"

    private fun persist() = store.save(sessions.values.toList())

    companion object {
        const val INVALID = "Este QR não vale mais; peça outro à loja."

        fun factory(backend: CourierBackend, store: CourierSessionStore, device: String) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CourierViewModel(backend, store, device) as T
        }
    }
}
