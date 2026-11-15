package br.com.queven.wabotia.device.core

/**
 * O que o painel fala entre duas leituras do estado. Vem do app QRSenha
 * (`core/panel/PanelCallAnnouncer.kt`), sem Android, para ser testado na JVM.
 *
 * A fala usa só o número público e o rótulo do balcão, que já estão na tela:
 * nenhum nome, identificador técnico ou dado de quem retirou a senha.
 */
class PanelCallAnnouncer(
    private val maxSpokenPerCycle: Int = MAX_SPOKEN_PER_CYCLE,
    private val silentBurstThreshold: Int = SILENT_BURST_THRESHOLD,
) {
    private val announced = LinkedHashSet<String>()

    /** `true` depois da primeira leitura: antes dela, nada se fala. */
    var primed: Boolean = false
        private set

    /**
     * Marca as chamadas atuais como já vistas, sem falar. A primeira leitura
     * passa por aqui: senão o painel recitaria as chamadas antigas cada vez que
     * a tela abre.
     */
    fun prime(calls: List<StationCall>) {
        for (call in calls) remember(key(call))
        primed = true
    }

    /**
     * O que falar agora. `chime` liga sempre que há chamada nova, mesmo quando
     * a fala se cala pela rajada.
     */
    fun announce(calls: List<StationCall>): PanelAnnouncement {
        if (!primed) {
            prime(calls)
            return PanelAnnouncement.SILENT
        }
        val pending = calls.filter { it.status == "calling" && remember(key(it)) }
        if (pending.isEmpty()) return PanelAnnouncement.SILENT
        // A volta da rede depois de uma queda traz a fila inteira de uma vez;
        // falar tudo deixaria o painel recitando senhas por um minuto.
        // A fala vai na ordem da chamada (rechamada inclusive) e, no limite,
        // fica com as mais recentes: a mesma ordem do destaque, ao contrário.
        val chronological = pending.sortedWith(PanelCalls.MOST_RECENT_FIRST.reversed())
        if (pending.size >= silentBurstThreshold) return PanelAnnouncement(chime = true, spoken = emptyList(), latest = chronological.last())
        return PanelAnnouncement(
            chime = true,
            spoken = chronological.takeLast(maxSpokenPerCycle).map(::announcementText),
            latest = chronological.last(),
        )
    }

    /**
     * A mesma senha chamada de novo volta a ser falada. No V2 a rechamada
     * mudava `calledAt`; no `vinki-core` ela soma `rechamadas` e mantém a hora.
     */
    private fun key(call: StationCall): String = "${call.ticketId}@${call.calledAt}#${call.recalls}"

    /** `true` quando a chave ainda não tinha sido anunciada. */
    private fun remember(key: String): Boolean {
        if (!announced.add(key)) return false
        if (announced.size > ANNOUNCED_HISTORY_LIMIT) {
            announced.iterator().let { iterator ->
                iterator.next()
                iterator.remove()
            }
        }
        return true
    }

    companion object {
        private const val MAX_SPOKEN_PER_CYCLE = 3
        private const val SILENT_BURST_THRESHOLD = 8
        private const val ANNOUNCED_HISTORY_LIMIT = 64
        private val DISPLAY_NUMBER = Regex("^([A-Z]{1,4})(\\d{1,6})$")

        /**
         * `A024` vira `A 24`, para o sintetizador ler "senha A vinte e quatro",
         * que é como a senha se fala no balcão.
         */
        fun spokenTicketNumber(publicNumber: String): String {
            val value = publicNumber.trim().uppercase()
            val match = DISPLAY_NUMBER.matchEntire(value) ?: return value
            val (prefix, digits) = match.destructured
            return "${prefix.toCharArray().joinToString(" ")} ${digits.trimStart('0').ifEmpty { "0" }}"
        }

        fun announcementText(call: StationCall): String {
            val number = spokenTicketNumber(call.publicNumber)
            val desk = call.stationLabel?.trim().orEmpty()
            return if (desk.isEmpty()) "Senha $number." else "Senha $number. $desk."
        }
    }
}

data class PanelAnnouncement(
    val chime: Boolean,
    val spoken: List<String>,
    /** A senha chamada ou rechamada por último neste anúncio: a que o destaque mostra. */
    val latest: StationCall? = null,
) {
    companion object {
        val SILENT = PanelAnnouncement(chime = false, spoken = emptyList())
    }
}

/** O som do painel: o gongo e a voz. Quem decide o que falar é o `PanelCallAnnouncer`. */
interface PanelCallAudio {
    /** Gongo curto: sinaliza a chamada mesmo sem voz instalada. */
    fun chime()

    /** Fala o texto já montado. */
    fun speak(text: String)

    /** Corta a fala pendente (som desligado, tela fechada). */
    fun stop()

    /** Solta o sintetizador; o painel fechou de vez. */
    fun shutdown() = stop()

    /** Muda o volume do painel, de 0 a 1, no canal em que ele toca. Só o controle da engrenagem chama. */
    fun setVolume(level: Float) = Unit

    /** Sem áudio: nos testes e onde o aparelho não tem som. */
    object None : PanelCallAudio {
        override fun chime() = Unit

        override fun speak(text: String) = Unit

        override fun stop() = Unit
    }
}

/**
 * O som das chamadas ligado ou desligado, por aparelho, guardado só neste
 * celular: silenciar a sala não passa pelo servidor.
 */
interface PanelSoundStore {
    fun enabled(deviceId: String): Boolean

    fun setEnabled(deviceId: String, enabled: Boolean)

    /** O último volume do painel, de 0 a 1; `null` se nunca foi guardado. */
    fun volume(deviceId: String): Float? = null

    fun setVolume(deviceId: String, level: Float) = Unit
}

/**
 * A tela acesa presa ao ciclo de vida da tela do aparelho. Vem do QRSenha
 * (`core/panel/PanelScreenWakePolicy.kt`): à frente, acende; em segundo plano
 * ou ao sair, devolve o valor que a `View` tinha antes.
 */
class PanelScreenWakePolicy(
    private val originalValue: Boolean,
    private val applyValue: (Boolean) -> Unit,
) : AutoCloseable {
    private var closed = false

    fun onForeground() {
        if (!closed) applyValue(true)
    }

    fun onBackground() {
        if (!closed) applyValue(originalValue)
    }

    override fun close() {
        if (!closed) {
            closed = true
            applyValue(originalValue)
        }
    }
}
