package br.com.queven.wabotia.modules.agenda

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
import kotlinx.coroutines.launch

/** As dependências das telas da Agenda (trocáveis nos testes). */
class AgendaDeps(val client: AgendaClient, val onFailure: (Throwable) -> Unit, val today: () -> String = { BrasiliaTime.today() }) {
    companion object {
        fun of(container: AppContainer) =
            AgendaDeps(AgendaClient(ProfileApi.current(container)), { ModuleFailure.handle(container, ModuleIds.AGENDA, it) })
    }
}

/** Agenda do dia (uma coluna por profissional) ou da semana, com filtro por profissional. */
class AgendaViewModel(private val deps: AgendaDeps, container: AppContainer? = null) : ViewModel() {
    enum class Mode(val label: String) { DAY("Dia"), WEEK("Semana") }

    var mode by mutableStateOf(Mode.DAY)
        private set
    var day by mutableStateOf(deps.today())
        private set
    /** `null`: todos. */
    var professionalId by mutableStateOf<String?>(null)
    var showCancelled by mutableStateOf(false)
    var catalog by mutableStateOf<AgendaCatalog?>(null)
        private set
    var appointments by mutableStateOf<List<Appointment>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var job: Job? = null

    init {
        container?.let { observeModuleEvents(it, "agenda.") { load() } }
    }

    val professionals: List<AgendaProfessional> get() = AgendaRules.professionals(null, catalog?.professionals.orEmpty())

    /** Primeiro dia mostrado (o próprio dia, ou a segunda-feira da semana). */
    val rangeStart: String get() = if (mode == Mode.DAY) day else BrasiliaTime.weekStart(day)

    val visible: List<Appointment>
        get() = appointments.filter { (showCancelled || it.state != "cancelled") && (professionalId == null || it.professionalId == professionalId) }

    val columns: List<Pair<AgendaProfessional, List<Appointment>>>
        get() = AgendaRules.columns(visible.filter { it.day == day }, catalog?.professionals.orEmpty())
            .filter { professionalId == null || it.first.id == professionalId }

    val week: List<Pair<String, List<Appointment>>> get() = AgendaRules.week(visible, rangeStart)

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (appointments.isEmpty()) loading = true
        try {
            if (catalog == null) catalog = deps.client.catalog()
            val (from, to) = BrasiliaTime.range(rangeStart, if (mode == Mode.DAY) 1 else 7) ?: return
            appointments = deps.client.appointments(from, to)
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

    fun shift(direction: Int) {
        day = BrasiliaTime.addDays(day, direction * if (mode == Mode.DAY) 1 else 7)
        refresh()
    }

    fun goToday() {
        day = deps.today()
        refresh()
    }

    fun changeMode(mode: Mode) {
        if (this.mode == mode) return
        this.mode = mode
        appointments = emptyList()
        refresh()
    }
}

/** Detalhe de um agendamento: confirmar, cancelar e marcar ausência (remarcar abre a [BookingViewModel]). */
class AppointmentViewModel(val id: String, private val deps: AgendaDeps, container: AppContainer? = null) : ViewModel() {
    var appointment by mutableStateOf<Appointment?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)

    private val keys = IntentKeys()

    init {
        container?.let { observeModuleEvents(it, "agenda.") { load() } }
    }

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        if (appointment == null) loading = true
        try {
            appointment = deps.client.appointment(id)
            if (busy == null) notice = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            if (appointment == null) notice = ModuleFailure.message(e)
        } finally {
            loading = false
        }
    }

    fun confirm() = run("confirm", "Agendamento confirmado") { deps.client.confirm(id, it) }
    fun noShow() = run("no-show", "Ausência registrada") { deps.client.noShow(id, it) }
    fun cancel(reason: String) = run("cancel", "Agendamento cancelado") { deps.client.cancel(id, reason.trim().ifEmpty { null }, it) }

    /** Depois de remarcar (a [BookingViewModel] devolve o agendamento novo). */
    fun replace(updated: Appointment) {
        appointment = updated
        done = "Agendamento remarcado"
    }

    private fun run(action: String, success: String, block: suspend (String) -> Appointment) {
        if (busy != null) return
        val key = keys.key("$action:$id")
        busy = action
        notice = null
        viewModelScope.launch {
            try {
                appointment = block(key)
                keys.settle(null)
                done = success
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                deps.onFailure(e)
                notice = ModuleFailure.actionMessage(e)
                if ((e as? QueueException)?.retryable != true) load()
            } finally {
                busy = null
            }
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}

/**
 * Novo agendamento (para um cliente, ou para a conversa aberta) e remarcação: serviço, profissional, dia e um dos
 * horários livres. Diante de `slot_taken`/`slot_unavailable`, recarrega os horários.
 */
class BookingViewModel(
    /** Remarcar este agendamento (lido em [load]); `null` para um novo. */
    private val movingId: String?,
    val conversationId: String?,
    val customerLabel: String?,
    private val deps: AgendaDeps,
) : ViewModel() {
    var moving by mutableStateOf<Appointment?>(null)
        private set
    var catalog by mutableStateOf<AgendaCatalog?>(null)
        private set
    var serviceId by mutableStateOf<String?>(null)
        private set
    /** `null`: qualquer profissional livre. */
    var professionalId by mutableStateOf<String?>(null)
        private set
    var day by mutableStateOf(deps.today())
        private set
    var slots by mutableStateOf<List<AgendaSlot>>(emptyList())
        private set
    var slot by mutableStateOf<AgendaSlot?>(null)
    var loadingSlots by mutableStateOf(false)
        private set
    var customerName by mutableStateOf("")
    var customerPhone by mutableStateOf("")
    var notes by mutableStateOf("")
    var busy by mutableStateOf(false)
        private set
    var notice by mutableStateOf<String?>(null)
    var result by mutableStateOf<Appointment?>(null)
        private set

    private val keys = IntentKeys()
    private var slotsJob: Job? = null

    val isMove: Boolean get() = movingId != null
    val services: List<AgendaService> get() = AgendaRules.activeServices(catalog?.services.orEmpty())
    val professionals: List<AgendaProfessional> get() = AgendaRules.professionals(serviceId, catalog?.professionals.orEmpty())
    val service: AgendaService? get() = services.firstOrNull { it.id == serviceId }

    val canSubmit: Boolean
        get() {
            if (serviceId == null || slot == null || busy) return false
            if (!isMove && conversationId == null) return customerName.isNotBlank()
            return true
        }

    suspend fun load() {
        try {
            if (movingId != null && moving == null) {
                val a = deps.client.appointment(movingId)
                moving = a
                serviceId = a.serviceId
                professionalId = a.professionalId
                day = maxOf(a.day, deps.today())
            }
            if (catalog == null) catalog = deps.client.catalog()
            if (serviceId == null) serviceId = services.firstOrNull()?.id
            loadSlots()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            notice = ModuleFailure.message(e)
        }
    }

    /* Cada escolha relê os horários; o `Job` devolvido serve aos testes para esperar a leitura. */

    fun chooseDay(day: String): Job {
        this.day = day
        return reloadSlots()
    }

    fun chooseProfessional(id: String?): Job {
        professionalId = id
        return reloadSlots()
    }

    fun chooseService(id: String): Job {
        serviceId = id
        if (professionalId != null && professionals.none { it.id == professionalId }) professionalId = null
        return reloadSlots()
    }

    private fun reloadSlots(): Job {
        slotsJob?.cancel()
        return viewModelScope.launch { loadSlots() }.also { slotsJob = it }
    }

    suspend fun loadSlots() {
        val service = serviceId ?: run { slots = emptyList(); return }
        loadingSlots = true
        try {
            val found = deps.client.availability(service, professionalId, day)
            slots = found.days.firstOrNull { it.date == day }?.slots.orEmpty()
            if (slot != null && slots.none { it.starts == slot?.starts }) slot = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            slots = emptyList()
            deps.onFailure(e)
            notice = ModuleFailure.message(e)
        } finally {
            loadingSlots = false
        }
    }

    /** Quem atende no horário escolhido: o profissional pedido, ou o primeiro livre. */
    fun professionalName(slot: AgendaSlot): String? {
        val id = professionalId ?: slot.professionalIds?.firstOrNull()
        return catalog?.professionals?.firstOrNull { it.id == id }?.displayName
    }

    fun submit() {
        if (!canSubmit) return
        viewModelScope.launch { book() }
    }

    /** Agenda ou remarca; diante de horário ocupado, recarrega os horários livres. */
    suspend fun book() {
        val service = serviceId ?: return
        val chosen = slot ?: return
        if (!canSubmit) return
        busy = true
        notice = null
        val signature = movingId?.let { "move:$it:${chosen.starts}:${professionalId.orEmpty()}" }
            ?: "book:$service:${chosen.starts}:${professionalId.orEmpty()}:${conversationId ?: customerName}"
        val key = keys.key(signature)
        run {
            try {
                result = if (movingId != null) {
                    deps.client.move(movingId, chosen.starts, professionalId, key)
                } else {
                    val phone = customerPhone.filter(Char::isDigit)
                    deps.client.book(
                        service, chosen.starts, professionalId, conversationId,
                        customerName = if (conversationId == null) customerName.trim() else null,
                        customerPhone = if (conversationId == null && phone.isNotEmpty()) phone else null,
                        notes = notes.trim().ifEmpty { null },
                        key = key,
                    )
                }
                keys.settle(null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                deps.onFailure(e)
                if (AgendaRules.isSlotConflict(e)) {
                    slot = null
                    loadSlots()
                    notice = CONFLICT_MESSAGE
                } else {
                    notice = ModuleFailure.actionMessage(e)
                }
            } finally {
                busy = false
            }
        }
    }

    val pendingKey: String? get() = keys.pendingKey

    companion object {
        const val CONFLICT_MESSAGE = "Esse horário acabou de ser ocupado ou deixou de valer. Escolha outro entre os horários livres."
    }
}
