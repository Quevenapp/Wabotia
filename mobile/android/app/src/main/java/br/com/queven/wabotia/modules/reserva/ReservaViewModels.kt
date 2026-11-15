package br.com.queven.wabotia.modules.reserva

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** As dependências das telas da Reserva (trocáveis nos testes). */
class ReservaDeps(val client: ReservaClient, val onFailure: (Throwable) -> Unit, val today: () -> String = { BrasiliaTime.today() }) {
    companion object {
        fun of(container: AppContainer) =
            ReservaDeps(ReservaClient(ProfileApi.current(container)), { ModuleFailure.handle(container, ModuleIds.RESERVA, it) })
    }
}

/** Ocupação (unidades × dias, 14 dias por vez) e lista de reservas com filtro e busca. */
class ReservaViewModel(private val deps: ReservaDeps, container: AppContainer? = null, initialMode: Mode = Mode.OCCUPANCY) : ViewModel() {
    enum class Mode(val label: String) { OCCUPANCY("Ocupação"), LIST("Reservas") }

    var mode by mutableStateOf(initialMode)
        private set
    var from by mutableStateOf(deps.today())
        private set
    var calendar by mutableStateOf<ReservaCalendar?>(null)
        private set
    var overview by mutableStateOf<ReservaOverview?>(null)
        private set
    var filter by mutableStateOf("upcoming")
        private set
    var query by mutableStateOf("")
        private set
    var bookings by mutableStateOf<List<ReservaBooking>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var job: Job? = null

    init {
        container?.let { observeModuleEvents(it, "reserva.") { load() } }
    }

    val to: String get() = BrasiliaTime.addDays(from, SPAN - 1)
    val days: List<String> get() = calendar?.days?.takeIf { it.isNotEmpty() } ?: (0 until SPAN).map { BrasiliaTime.addDays(from, it) }
    val upcoming: List<ReservaBooking> get() = ReservaRules.upcoming(calendar)

    /** Aviso do sinal (Cobrança desligada ou sem conta), para a equipe saber antes de reservar com sinal. */
    val depositWarning: String? get() = overview?.deposit?.takeIf { it.available == false }?.message?.takeIf { it.isNotBlank() }

    /** O `Job` devolvido serve aos testes para esperar a leitura. */
    fun refresh(): Job {
        job?.cancel()
        return viewModelScope.launch { load() }.also { job = it }
    }

    suspend fun load() {
        if (calendar == null && bookings.isEmpty()) loading = true
        try {
            if (overview == null) overview = deps.client.overview()
            when (mode) {
                Mode.OCCUPANCY -> calendar = deps.client.calendar(from, to)
                Mode.LIST -> {
                    val statuses = ReservaRules.FILTERS.firstOrNull { it.first == filter }?.third.orEmpty()
                    bookings = deps.client.bookings(statuses, query = query)
                }
            }
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            error = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    fun changeMode(mode: Mode): Job? {
        if (this.mode == mode) return null
        this.mode = mode
        return refresh()
    }

    fun shift(direction: Int) {
        from = BrasiliaTime.addDays(from, direction * SPAN)
        calendar = null
        refresh()
    }

    fun goToday() {
        from = deps.today()
        calendar = null
        refresh()
    }

    fun changeFilter(id: String) {
        if (filter == id) return
        filter = id
        bookings = emptyList()
        refresh()
    }

    /** Busca com uma pausa curta, para não consultar a cada letra. */
    fun search(text: String) {
        query = text
        job?.cancel()
        job = viewModelScope.launch {
            delay(350)
            load()
        }
    }

    companion object {
        const val SPAN = 14
    }
}

/** Detalhe da reserva: confirmar sem sinal, cobrar o sinal de novo, enviar o check-in e cancelar. */
class ReservaBookingViewModel(val id: String, private val deps: ReservaDeps, container: AppContainer? = null) : ViewModel() {
    var booking by mutableStateOf<ReservaBooking?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)

    private val keys = IntentKeys()

    init {
        container?.let { observeModuleEvents(it, "reserva.") { load() } }
    }

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (booking == null) loading = true
        try {
            booking = deps.client.booking(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            if (booking == null) notice = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    fun confirm() = run("confirm", "Reserva confirmada") { deps.client.confirm(id, it) }
    fun chargeDeposit() = run("deposit", "Cobrança do sinal enviada") { deps.client.deposit(id, it) }
    fun sendCheckin() = run("checkin", "Link do check-in enviado") { deps.client.checkin(id, it) }
    fun cancel(reason: String) = run("cancel", "Reserva cancelada") { deps.client.cancel(id, reason.trim().ifEmpty { null }, it) }

    private fun run(action: String, success: String, block: suspend (String) -> ReservaBooking) {
        if (busy != null) return
        viewModelScope.launch { perform(action, success, block) }
    }

    /** A ação com a chave da intenção; uma recusa definitiva relê a reserva. */
    suspend fun perform(action: String, success: String, block: suspend (String) -> ReservaBooking) {
        if (busy != null) return
        val key = keys.key("$action:$id")
        busy = action
        notice = null
        try {
            booking = block(key)
            keys.settle(null)
            done = success
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            keys.settle(e)
            deps.onFailure(e)
            val retry = (e as? QueueException)?.retryable == true
            notice = ReservaRules.explain(e) + if (retry) ModuleFailure.RETRY_HINT else ""
            if (!retry) load()
        } finally {
            busy = null
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}

/**
 * Nova reserva (no balcão ou para a conversa aberta) e alteração: unidade, período (diárias: entrada e número de
 * diárias; por hora: dia, duração e um horário livre), pessoas e cliente. Diante de `unit_unavailable`, `unit_blocked`
 * ou `outside_rules`, recarrega a disponibilidade e pede para escolher de novo.
 */
class ReservaFormViewModel(
    /** Alterar esta reserva (lida em [load]); `null` para uma nova. */
    private val editingId: String?,
    private val newConversationId: String?,
    val customerLabel: String?,
    initialUnitId: String?,
    initialDate: String?,
    private val deps: ReservaDeps,
) : ViewModel() {
    var editing by mutableStateOf<ReservaBooking?>(null)
        private set
    var units by mutableStateOf<List<ReservaUnit>>(emptyList())
        private set
    var deposit by mutableStateOf<ReservaDeposit?>(null)
        private set
    var unitId by mutableStateOf(initialUnitId)
        private set
    var startDate by mutableStateOf(maxOf(initialDate ?: deps.today(), deps.today()))
        private set
    var nights by mutableStateOf(1)
        private set
    var guests by mutableStateOf(2)
        private set
    var minutes by mutableStateOf(60)
        private set
    var daily by mutableStateOf<List<ReservaDailyOption>>(emptyList())
        private set
    var slots by mutableStateOf<List<ReservaSlot>>(emptyList())
        private set
    var slot by mutableStateOf<ReservaSlot?>(null)
    var loadingAvailability by mutableStateOf(false)
        private set
    var customerName by mutableStateOf("")
    var customerPhone by mutableStateOf("")
    var notes by mutableStateOf("")
    var chargeDeposit by mutableStateOf(true)
    var busy by mutableStateOf(false)
        private set
    var notice by mutableStateOf<String?>(null)
    var result by mutableStateOf<ReservaBooking?>(null)
        private set
    var loaded by mutableStateOf(false)
        private set

    private val keys = IntentKeys()
    private var availabilityJob: Job? = null

    val isEdit: Boolean get() = editingId != null
    val conversationId: String? get() = if (isEdit) editing?.conversationId else newConversationId
    val unit: ReservaUnit? get() = units.firstOrNull { it.id == unitId }
    val isHourly: Boolean get() = unit?.isHourly ?: false
    val endDate: String get() = BrasiliaTime.addDays(startDate, nights)
    val chosenDaily: ReservaDailyOption? get() = daily.firstOrNull { it.unitId == unitId }

    /** Na alteração, a disponibilidade conta a própria reserva como ocupada: a unidade dela não fica travada por isso. */
    val ownBooking: Boolean
        get() = isEdit && unitId == editing?.unitId && chosenDaily?.reason == "booked"

    /** Cobrar o sinal só faz sentido com conversa e Cobrança pronta. */
    val canChargeDeposit: Boolean get() = !isEdit && conversationId != null && deposit?.available == true

    /**
     * Dias que dá para escolher: hoje e os próximos 60, mais o dia escolhido quando fica fora deles (entrada de uma
     * estadia em curso, ou um dia tocado na ocupação de um período adiante).
     */
    val dayChoices: List<String>
        get() {
            val today = deps.today()
            val list = (0 until 60).map { BrasiliaTime.addDays(today, it) }
            return if (startDate in list) list else (list + startDate).sorted()
        }

    val durationChoices: List<Int> get() = (DURATIONS + minutes).distinct().sorted()

    val hasChanges: Boolean
        get() {
            val b = editing ?: return true
            return changedFields(b).isNotEmpty()
        }

    val canSubmit: Boolean
        get() {
            if (unitId == null || busy || !loaded) return false
            if (isHourly) {
                if (slot == null) return false
            } else if (chosenDaily?.available == false && !ownBooking) {
                return false
            }
            if (isEdit) return hasChanges
            if (conversationId == null) return customerName.isNotBlank()
            return true
        }

    suspend fun load() {
        try {
            if (editingId != null && editing == null) {
                val b = deps.client.booking(editingId)
                editing = b
                unitId = b.unitId
                startDate = b.firstDay
                nights = maxOf(b.nights ?: 1, 1)
                guests = b.guests ?: 1
                minutes = b.durationMinutes ?: 60
                customerName = b.customerName.orEmpty()
                customerPhone = b.customerPhone.orEmpty()
            }
            val overview = deps.client.overview()
            units = overview.units
                .filter { it.isActive || it.id == editing?.unitId }
                .sortedWith(compareBy({ it.position ?: 0 }, { it.displayName }))
            deposit = overview.deposit
            if (unitId == null || units.none { it.id == unitId }) unitId = units.firstOrNull()?.id
            loaded = true
            loadAvailability()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            notice = ModuleFailure.message(e)
        }
    }

    /* Cada escolha relê a disponibilidade; o `Job` devolvido serve aos testes para esperar a leitura. */

    fun chooseUnit(id: String): Job? {
        if (unitId == id) return null
        unitId = id
        slot = null
        return reloadAvailability()
    }

    fun chooseStart(day: String): Job {
        startDate = day
        slot = null
        return reloadAvailability()
    }

    fun changeNights(n: Int): Job {
        nights = n.coerceIn(1, MAX_NIGHTS)
        return reloadAvailability()
    }

    fun changeGuests(n: Int): Job {
        guests = n.coerceIn(1, MAX_GUESTS)
        return reloadAvailability()
    }

    fun changeMinutes(m: Int): Job {
        minutes = m
        slot = null
        return reloadAvailability()
    }

    private fun reloadAvailability(): Job {
        availabilityJob?.cancel()
        return viewModelScope.launch { loadAvailability() }.also { availabilityJob = it }
    }

    suspend fun loadAvailability() {
        val unitId = unitId ?: return
        loadingAvailability = true
        try {
            if (isHourly) {
                val found = deps.client.hourlyAvailability(startDate, minutes, unitId)
                var list = found.units.firstOrNull { it.unitId == unitId }?.slots.orEmpty()
                // Alterar sem mudar o horário: o horário atual aparece, embora a própria reserva o ocupe.
                val b = editing
                if (b != null && b.unitId == unitId && b.firstDay == startDate && b.durationMinutes == minutes && list.none { it.starts == b.starts }) {
                    list = (list + ReservaSlot(b.starts, b.ends, BrasiliaTime.clock(b.starts), b.priceCents)).sortedBy { it.starts }
                }
                slots = list
                if (slot != null && list.none { it.starts == slot?.starts }) slot = null
                if (slot == null && b != null && b.unitId == unitId && b.firstDay == startDate) slot = list.firstOrNull { it.starts == b.starts }
            } else {
                daily = deps.client.dailyAvailability(startDate, nights, guests).units
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            notice = ReservaRules.explain(e)
        } finally {
            loadingAvailability = false
        }
    }

    /** O pedido: para criar, tudo; para alterar, só o que mudou (o servidor avisa o cliente quando o período muda). */
    fun request(): ReservaRequest {
        val b = editing
        if (b != null) {
            val changed = changedFields(b)
            val period = "period" in changed || "unit" in changed
            return ReservaRequest(
                unitId = unitId.takeIf { "unit" in changed },
                guests = guests.takeIf { "guests" in changed },
                startDate = startDate.takeIf { period && !isHourly },
                nights = nights.takeIf { period && !isHourly },
                starts = slot?.starts?.takeIf { period && isHourly },
                durationMinutes = minutes.takeIf { period && isHourly },
                customerName = customerName.trim().takeIf { "name" in changed },
                customerPhone = customerPhone.filter(Char::isDigit).takeIf { "phone" in changed },
            )
        }
        val conversation = conversationId
        val phone = customerPhone.filter(Char::isDigit)
        return ReservaRequest(
            unitId = unitId,
            guests = guests,
            startDate = startDate.takeIf { !isHourly },
            nights = nights.takeIf { !isHourly },
            starts = slot?.starts?.takeIf { isHourly },
            durationMinutes = minutes.takeIf { isHourly },
            conversationId = conversation,
            customerName = customerName.trim().takeIf { conversation == null && it.isNotEmpty() },
            customerPhone = phone.takeIf { conversation == null && it.isNotEmpty() },
            notes = notes.trim().ifEmpty { null },
            deposit = chargeDeposit.takeIf { canChargeDeposit },
        )
    }

    private fun changedFields(b: ReservaBooking): Set<String> = buildSet {
        if (unitId != b.unitId) add("unit")
        if (guests != (b.guests ?: 1)) add("guests")
        if (isHourly) {
            if (slot?.starts != b.starts || minutes != b.durationMinutes) add("period")
        } else if (startDate != b.firstDay || nights != (b.nights ?: 1)) {
            add("period")
        }
        if (b.conversationId == null) {
            if (customerName.trim() != b.customerName.orEmpty() && customerName.isNotBlank()) add("name")
            if (customerPhone.filter(Char::isDigit) != b.customerPhone.orEmpty()) add("phone")
        }
    }

    fun submit() {
        if (canSubmit) viewModelScope.launch { save() }
    }

    /** Cria ou altera; diante de unidade ocupada, bloqueada ou fora das regras, recarrega a disponibilidade. */
    suspend fun save() {
        if (!canSubmit) return
        busy = true
        notice = null
        val request = request()
        val key = keys.key((editingId?.let { "edit:$it:" } ?: "new:") + request.signature)
        try {
            result = if (editingId != null) deps.client.update(editingId, request, key) else deps.client.create(request, key)
            keys.settle(null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            keys.settle(e)
            deps.onFailure(e)
            if (ReservaRules.isConflict(e)) {
                slot = null
                loadAvailability()
            }
            val retry = (e as? QueueException)?.retryable == true
            notice = ReservaRules.explain(e) + if (retry) ModuleFailure.RETRY_HINT else ""
        } finally {
            busy = false
        }
    }

    val pendingKey: String? get() = keys.pendingKey

    companion object {
        val DURATIONS = listOf(60, 90, 120, 180, 240)
        const val MAX_NIGHTS = 60
        const val MAX_GUESTS = 60
    }
}
