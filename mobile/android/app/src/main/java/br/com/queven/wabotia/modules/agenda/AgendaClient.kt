package br.com.queven.wabotia.modules.agenda

import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.DataList
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Agenda (módulo `agenda`, docs/AGENDA.md e docs/API.md "Agenda"). Horários em ms Unix; `date` e `time` dos
 * agendamentos já vêm em Brasília. Os cadastros (serviços, profissionais, regras, bloqueios) ficam no painel web nesta
 * versão: o app lê o catálogo e opera os agendamentos.
 */

@Serializable
data class AgendaService(
    val id: String,
    val name: String? = null,
    val description: String? = null,
    @SerialName("duration_minutes") val durationMinutes: Int? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    val active: Boolean? = null,
    val position: Int? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Serviço"
    val isActive: Boolean get() = active ?: true
}

@Serializable
data class AgendaHours(val weekday: Int, val start: String, val end: String)

@Serializable
data class AgendaProfessional(
    val id: String,
    val name: String? = null,
    @SerialName("user_id") val userId: String? = null,
    val active: Boolean? = null,
    val position: Int? = null,
    @SerialName("service_ids") val serviceIds: List<String>? = null,
    val hours: List<AgendaHours>? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Profissional"
    val isActive: Boolean get() = active ?: true
}

/** `GET /agenda`: a configuração fica de fora (é do painel); o app usa serviços e profissionais. */
@Serializable
data class AgendaCatalog(val services: List<AgendaService> = emptyList(), val professionals: List<AgendaProfessional> = emptyList())

@Serializable
data class Appointment(
    val id: String,
    @SerialName("service_id") val serviceId: String? = null,
    @SerialName("service_name") val serviceName: String? = null,
    @SerialName("professional_id") val professionalId: String? = null,
    @SerialName("professional_name") val professionalName: String? = null,
    val starts: Long = 0,
    val ends: Long? = null,
    /** "AAAA-MM-DD" e "HH:MM" de Brasília: mostrar sem converter fuso. */
    val date: String? = null,
    val time: String? = null,
    /** `booked`, `confirmed`, `cancelled` ou `no_show`. */
    val status: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("customer_name") val customerName: String? = null,
    @SerialName("customer_phone") val customerPhone: String? = null,
    val notes: String? = null,
    val source: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    @SerialName("booked_at") val bookedAt: Long? = null,
    @SerialName("confirmed_at") val confirmedAt: Long? = null,
    @SerialName("cancelled_at") val cancelledAt: Long? = null,
    @SerialName("cancel_reason") val cancelReason: String? = null,
    @SerialName("no_show_at") val noShowAt: Long? = null,
    val moves: Int? = null,
) {
    val state: String get() = status ?: "booked"
    val day: String get() = date ?: BrasiliaTime.day(starts)
    val clock: String get() = time ?: BrasiliaTime.clock(starts)
    val customer: String get() = customerName?.takeIf { it.isNotBlank() } ?: customerPhone?.takeIf { it.isNotBlank() } ?: "Cliente"
}

@Serializable
data class AgendaSlot(
    val starts: Long,
    val ends: Long? = null,
    val time: String? = null,
    @SerialName("professional_ids") val professionalIds: List<String>? = null,
) {
    val clock: String get() = time ?: BrasiliaTime.clock(starts)
}

@Serializable
data class AgendaDay(val date: String, val slots: List<AgendaSlot> = emptyList())

@Serializable
data class AgendaAvailability(
    @SerialName("service_id") val serviceId: String? = null,
    @SerialName("professional_id") val professionalId: String? = null,
    val days: List<AgendaDay> = emptyList(),
)

/** O cliente das rotas da Agenda de uma área. */
class AgendaClient(val api: ProfileApi) {
    suspend fun catalog(): AgendaCatalog = api.get("agenda", AgendaCatalog.serializer())

    /** Agendamentos que cruzam `[from, to)` (até 62 dias). */
    suspend fun appointments(from: Long, to: Long, conversationId: String? = null): List<Appointment> =
        api.get(
            "agenda/appointments",
            DataList.serializer(Appointment.serializer()),
            mapOf("from" to from.toString(), "to" to to.toString(), "conversation_id" to conversationId),
        ).data

    suspend fun appointment(id: String): Appointment = api.get("agenda/appointments/$id", Appointment.serializer())

    /** Horários livres do dia para a equipe (`staff=1` ignora a antecedência mínima e máxima). */
    suspend fun availability(serviceId: String, professionalId: String?, date: String): AgendaAvailability =
        api.get(
            "agenda/availability",
            AgendaAvailability.serializer(),
            mapOf("service_id" to serviceId, "professional_id" to professionalId, "date" to date, "staff" to "1"),
        )

    /** `professional_id` nulo: quem estiver livre. Com `conversation_id`, o cliente da conversa recebe a confirmação. */
    suspend fun book(
        serviceId: String,
        starts: Long,
        professionalId: String?,
        conversationId: String?,
        customerName: String?,
        customerPhone: String?,
        notes: String?,
        key: String,
    ): Appointment = api.send(
        "POST", "agenda/appointments",
        jsonBody(
            "service_id" to serviceId, "starts" to starts, "professional_id" to professionalId, "conversation_id" to conversationId,
            "customer_name" to customerName, "customer_phone" to customerPhone, "notes" to notes,
        ),
        key, Appointment.serializer(),
    )

    suspend fun move(id: String, starts: Long, professionalId: String?, key: String): Appointment =
        api.send("POST", "agenda/appointments/$id/move", jsonBody("starts" to starts, "professional_id" to professionalId), key, Appointment.serializer())

    suspend fun cancel(id: String, reason: String?, key: String): Appointment =
        api.send("POST", "agenda/appointments/$id/cancel", jsonBody("reason" to reason), key, Appointment.serializer())

    suspend fun confirm(id: String, key: String): Appointment =
        api.send("POST", "agenda/appointments/$id/confirm", jsonBody(), key, Appointment.serializer())

    suspend fun noShow(id: String, key: String): Appointment =
        api.send("POST", "agenda/appointments/$id/no-show", jsonBody(), key, Appointment.serializer())
}

/** Regras das telas da Agenda, sem tela, para testar. */
object AgendaRules {
    val ACTIVE = setOf("booked", "confirmed")

    fun statusLabel(status: String): String = when (status) {
        "booked" -> "Agendado"
        "confirmed" -> "Confirmado"
        "cancelled" -> "Cancelado"
        "no_show" -> "Ausente"
        else -> status
    }

    fun canConfirm(a: Appointment) = a.state == "booked"
    fun canMove(a: Appointment) = a.state in ACTIVE
    fun canCancel(a: Appointment) = a.state in ACTIVE

    /** Ausência só depois do início (o servidor recusa antes). */
    fun canMarkNoShow(a: Appointment, now: Long = System.currentTimeMillis()) = a.state in ACTIVE && now >= a.starts

    /** Recusa por horário ocupado ou indisponível: a tela recarrega os horários livres. */
    fun isSlotConflict(error: Throwable): Boolean = (error as? QueueException)?.code in setOf("slot_taken", "slot_unavailable")

    /** Profissionais ativos que atendem o serviço (sem lista de serviços: atende todos). */
    fun professionals(serviceId: String?, all: List<AgendaProfessional>): List<AgendaProfessional> =
        all.filter { p -> p.isActive && (serviceId == null || p.serviceIds.isNullOrEmpty() || serviceId in p.serviceIds) }
            .sortedWith(compareBy({ it.position ?: 0 }, { it.displayName }))

    fun activeServices(all: List<AgendaService>): List<AgendaService> =
        all.filter { it.isActive }.sortedWith(compareBy({ it.position ?: 0 }, { it.displayName }))

    /**
     * Colunas do dia: um grupo por profissional (na ordem do cadastro), com os agendamentos por horário. Profissional
     * arquivado que ainda tem agendamento aparece no fim.
     */
    fun columns(appointments: List<Appointment>, professionals: List<AgendaProfessional>): List<Pair<AgendaProfessional, List<Appointment>>> {
        val sorted = appointments.sortedBy { it.starts }
        val out = professionals.filter { it.isActive }.sortedWith(compareBy({ it.position ?: 0 }, { it.displayName }))
            .map { p -> p to sorted.filter { it.professionalId == p.id } }
            .toMutableList()
        val known = out.map { it.first.id }.toSet()
        sorted.filter { it.professionalId.orEmpty() !in known }.groupBy { it.professionalId.orEmpty() }.toSortedMap().forEach { (id, items) ->
            out += AgendaProfessional(id, items.first().professionalName ?: "Sem profissional") to items
        }
        return out
    }

    /** Os sete dias da semana (segunda a domingo) com os agendamentos de cada um. */
    fun week(appointments: List<Appointment>, start: String): List<Pair<String, List<Appointment>>> =
        (0 until 7).map { offset ->
            val day = BrasiliaTime.addDays(start, offset)
            day to appointments.filter { it.day == day }.sortedBy { it.starts }
        }

    fun duration(a: Appointment): String? = a.ends?.takeIf { it > a.starts }?.let { "${BrasiliaTime.clock(a.starts)} às ${BrasiliaTime.clock(it)}" }
}
