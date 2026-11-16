package br.com.queven.wabotia.modules.reserva

import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.DataList
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.PhoneText
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.jsonBody
import br.com.queven.wabotia.queue.QueueException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/*
 * Reserva e check-in (módulo `reserva`, docs/RESERVA.md e docs/API.md "Reserva e check-in"). Unidades por diária
 * (pousada, temporada) ou por hora (quadra, salão). Datas em ms Unix; `*_date` e `*_time` já vêm em Brasília. Numa
 * reserva por diária, `starts`/`ends` são a ocupação (meia-noite da entrada à meia-noite da saída) e `arrival_at`/
 * `departure_at` os horários de entrada e saída. Cadastros e regras ficam no painel web: o app mostra a ocupação e
 * opera as reservas. Mesmo desenho do iOS (`Modules/Reserva`).
 */

@Serializable
data class ReservaUnit(
    val id: String,
    val name: String? = null,
    /** `daily` ou `hourly`. */
    val mode: String? = null,
    val kind: String? = null,
    val capacity: Int? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    val description: String? = null,
    val active: Boolean? = null,
    val position: Int? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Unidade"
    val isHourly: Boolean get() = mode == "hourly"
    val isActive: Boolean get() = active ?: true
}

/** Se a Cobrança está pronta para o sinal (`reason`: `payments_disabled` ou `payments_not_configured`). */
@Serializable
data class ReservaDeposit(val available: Boolean? = null, val reason: String? = null, val message: String? = null)

/** As regras que o app usa para montar a tela (o resto fica com o painel). */
@Serializable
data class ReservaConfig(
    @SerialName("checkin_time") val checkinTime: String? = null,
    @SerialName("checkout_time") val checkoutTime: String? = null,
    @SerialName("hourly_open") val hourlyOpen: String? = null,
    @SerialName("hourly_close") val hourlyClose: String? = null,
    @SerialName("min_hours") val minHours: Int? = null,
    @SerialName("deposit_type") val depositType: String? = null,
)

/** `GET /reserva`: regras, unidades e o estado do sinal. */
@Serializable
data class ReservaOverview(
    val config: ReservaConfig? = null,
    val units: List<ReservaUnit> = emptyList(),
    val deposit: ReservaDeposit? = null,
)

@Serializable
data class ReservaBooking(
    val id: String,
    val number: Int? = null,
    @SerialName("unit_id") val unitId: String? = null,
    @SerialName("unit_name") val unitName: String? = null,
    val mode: String? = null,
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("end_date") val endDate: String? = null,
    val starts: Long = 0,
    val ends: Long? = null,
    @SerialName("arrival_at") val arrivalAt: Long? = null,
    @SerialName("departure_at") val departureAt: Long? = null,
    @SerialName("arrival_time") val arrivalTime: String? = null,
    @SerialName("departure_time") val departureTime: String? = null,
    val nights: Int? = null,
    @SerialName("duration_minutes") val durationMinutes: Int? = null,
    val guests: Int? = null,
    /** `pending_payment`, `confirmed`, `cancelled`, `expired` ou `completed`. */
    val status: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("customer_name") val customerName: String? = null,
    @SerialName("customer_phone") val customerPhone: String? = null,
    val notes: String? = null,
    val source: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    @SerialName("deposit_cents") val depositCents: Long? = null,
    @SerialName("payment_id") val paymentId: String? = null,
    @SerialName("payment_status") val paymentStatus: String? = null,
    @SerialName("payment_error") val paymentError: String? = null,
    @SerialName("payment_due_at") val paymentDueAt: Long? = null,
    @SerialName("paid_at") val paidAt: Long? = null,
    @SerialName("confirmed_at") val confirmedAt: Long? = null,
    @SerialName("confirmed_by") val confirmedBy: String? = null,
    /** `none`, `invited`, `sent` ou `completed`. */
    @SerialName("checkin_status") val checkinStatus: String? = null,
    @SerialName("checkin_sent_at") val checkinSentAt: Long? = null,
    @SerialName("checkin_at") val checkinAt: Long? = null,
    @SerialName("checkin_answers") val checkinAnswers: Map<String, JsonElement>? = null,
    @SerialName("cancelled_at") val cancelledAt: Long? = null,
    @SerialName("cancel_reason") val cancelReason: String? = null,
    val changes: Int? = null,
    val created: Long? = null,
    val updated: Long? = null,
) {
    val state: String get() = status ?: "confirmed"
    val isHourly: Boolean get() = mode == "hourly"
    val numberText: String get() = number?.let { "nº $it" } ?: "—"
    val customer: String get() = customerName?.takeIf { it.isNotBlank() } ?: PhoneText.display(customerPhone) ?: "Cliente"
    val firstDay: String get() = startDate ?: BrasiliaTime.day(starts)

    /** "22/11 a 25/11 · 3 diárias" ou "22/11 · 14:00 às 16:00". */
    val periodText: String
        get() {
            if (isHourly) {
                val end = ends?.let { " às ${BrasiliaTime.clock(it)}" }.orEmpty()
                return "${ReservaRules.shortDay(firstDay)} · ${BrasiliaTime.clock(starts)}$end"
            }
            val from = startDate?.let(ReservaRules::shortDay) ?: "—"
            val to = endDate?.let(ReservaRules::shortDay) ?: "—"
            return "$from a $to" + (nights?.let { " · ${ReservaRules.nightsText(it)}" } ?: "")
        }
}

@Serializable
data class ReservaCell(
    val date: String,
    /** `free`, `pending_payment`, `confirmed`, `completed`, `partial` ou `blocked`. */
    val state: String? = null,
    @SerialName("booking_ids") val bookingIds: List<String> = emptyList(),
    @SerialName("block_ids") val blockIds: List<String> = emptyList(),
)

@Serializable
data class ReservaCalendarUnit(
    @SerialName("unit_id") val unitId: String,
    val name: String? = null,
    val mode: String? = null,
    val active: Boolean? = null,
    val cells: List<ReservaCell> = emptyList(),
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Unidade"
}

@Serializable
data class ReservaCalendar(
    @SerialName("from_date") val fromDate: String? = null,
    @SerialName("to_date") val toDate: String? = null,
    val days: List<String> = emptyList(),
    val units: List<ReservaCalendarUnit> = emptyList(),
    val bookings: List<ReservaBooking> = emptyList(),
)

/** Uma unidade por diária no período pedido: livre ou o motivo (`booked`, `blocked`, `capacity`…) com a mensagem. */
@Serializable
data class ReservaDailyOption(
    @SerialName("unit_id") val unitId: String,
    val name: String? = null,
    val capacity: Int? = null,
    val available: Boolean? = null,
    val reason: String? = null,
    val message: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    @SerialName("deposit_cents") val depositCents: Long? = null,
    val nights: Int? = null,
)

@Serializable
data class ReservaDailyAvailability(
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("end_date") val endDate: String? = null,
    val units: List<ReservaDailyOption> = emptyList(),
)

@Serializable
data class ReservaSlot(
    val starts: Long,
    val ends: Long? = null,
    val time: String? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
) {
    val clock: String get() = time ?: BrasiliaTime.clock(starts)
}

@Serializable
data class ReservaHourlyOption(
    @SerialName("unit_id") val unitId: String,
    val name: String? = null,
    val capacity: Int? = null,
    @SerialName("price_cents") val priceCents: Long? = null,
    val slots: List<ReservaSlot> = emptyList(),
)

@Serializable
data class ReservaHourlyAvailability(
    val date: String? = null,
    @SerialName("duration_minutes") val durationMinutes: Int? = null,
    val units: List<ReservaHourlyOption> = emptyList(),
)

/** O cliente das rotas da Reserva de uma área. */
class ReservaClient(val api: ProfileApi) {
    suspend fun overview(): ReservaOverview = api.get("reserva", ReservaOverview.serializer())

    /** Ocupação por unidade e dia (até 93 dias), com as reservas do período. */
    suspend fun calendar(from: String, to: String, unitId: String? = null): ReservaCalendar =
        api.get("reserva/calendar", ReservaCalendar.serializer(), mapOf("from_date" to from, "to_date" to to, "unit_id" to unitId))

    suspend fun bookings(
        statuses: List<String> = emptyList(),
        query: String? = null,
        conversationId: String? = null,
        unitId: String? = null,
        limit: Int = 200,
    ): List<ReservaBooking> =
        api.get(
            "reserva/bookings",
            DataList.serializer(ReservaBooking.serializer()),
            mapOf(
                "status" to statuses.takeIf { it.isNotEmpty() }?.joinToString(","),
                "q" to query?.trim()?.takeIf { it.isNotEmpty() },
                "conversation_id" to conversationId,
                "unit_id" to unitId,
                "limit" to limit.toString(),
            ),
        ).data

    suspend fun booking(id: String): ReservaBooking = api.get("reserva/bookings/$id", ReservaBooking.serializer())

    /** Diárias: cada unidade com `available`, o motivo e o valor do período, como a equipe (`staff=1`). */
    suspend fun dailyAvailability(start: String, nights: Int, guests: Int?): ReservaDailyAvailability =
        api.get(
            "reserva/availability",
            ReservaDailyAvailability.serializer(),
            mapOf("start_date" to start, "nights" to nights.toString(), "guests" to guests?.toString(), "staff" to "1"),
        )

    /** Por hora: os horários de início livres de cada unidade no dia. */
    suspend fun hourlyAvailability(date: String, minutes: Int, unitId: String?): ReservaHourlyAvailability =
        api.get(
            "reserva/availability",
            ReservaHourlyAvailability.serializer(),
            mapOf("date" to date, "duration_minutes" to minutes.toString(), "unit_id" to unitId, "staff" to "1"),
        )

    /**
     * `request` já no formato da rota: `{unit_id, start_date, nights}` ou `{unit_id, starts, duration_minutes}`, com
     * `guests`, `conversation_id | customer_name`, `customer_phone`, `notes` e `deposit`.
     */
    suspend fun create(request: ReservaRequest, key: String): ReservaBooking =
        api.send("POST", "reserva/bookings", request.body(), key, ReservaBooking.serializer())

    /** Unidade, datas ou horário, pessoas e cliente. */
    suspend fun update(id: String, request: ReservaRequest, key: String): ReservaBooking =
        api.send("PATCH", "reserva/bookings/$id", request.body(), key, ReservaBooking.serializer())

    suspend fun cancel(id: String, reason: String?, key: String): ReservaBooking =
        api.send("POST", "reserva/bookings/$id/cancel", jsonBody("reason" to reason), key, ReservaBooking.serializer())

    /** Confirma sem sinal (pago por fora, cortesia). */
    suspend fun confirm(id: String, key: String): ReservaBooking =
        api.send("POST", "reserva/bookings/$id/confirm", jsonBody(), key, ReservaBooking.serializer())

    /** Cobra o sinal de novo pela conversa. */
    suspend fun deposit(id: String, key: String): ReservaBooking =
        api.send("POST", "reserva/bookings/$id/deposit", jsonBody(), key, ReservaBooking.serializer())

    /** Envia (de novo) o link do check-in. */
    suspend fun checkin(id: String, key: String): ReservaBooking =
        api.send("POST", "reserva/bookings/$id/checkin", jsonBody(), key, ReservaBooking.serializer())
}

/** O pedido de criar ou alterar uma reserva; campos nulos ficam de fora do corpo. */
data class ReservaRequest(
    val unitId: String?,
    val guests: Int? = null,
    val startDate: String? = null,
    val nights: Int? = null,
    val starts: Long? = null,
    val durationMinutes: Int? = null,
    val conversationId: String? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val notes: String? = null,
    val deposit: Boolean? = null,
) {
    fun body() = jsonBody(
        "unit_id" to unitId, "guests" to guests, "start_date" to startDate, "nights" to nights, "starts" to starts,
        "duration_minutes" to durationMinutes, "conversation_id" to conversationId, "customer_name" to customerName,
        "customer_phone" to customerPhone, "notes" to notes, "deposit" to deposit,
    )

    /** A assinatura da intenção (a mesma chave só para o mesmo pedido). */
    val signature: String get() = body().entries.sortedBy { it.key }.joinToString("&") { "${it.key}=${it.value}" }
}

/** Regras das telas da Reserva, sem tela, para testar. */
object ReservaRules {
    val ACTIVE = setOf("pending_payment", "confirmed")

    /** Recusas que pedem recarregar a disponibilidade e escolher de novo. */
    val CONFLICTS = setOf("unit_unavailable", "unit_blocked", "outside_rules")

    fun statusLabel(status: String): String = when (status) {
        "pending_payment" -> "Aguardando sinal"
        "confirmed" -> "Confirmada"
        "cancelled" -> "Cancelada"
        "expired" -> "Expirada"
        "completed" -> "Concluída"
        else -> status
    }

    fun checkinLabel(status: String?): String = when (status) {
        "invited" -> "Convite enviado"
        "sent" -> "Link enviado"
        "completed" -> "Check-in feito"
        else -> "Não enviado"
    }

    fun cellLabel(state: String?): String = when (state) {
        "pending_payment" -> "Aguardando sinal"
        "confirmed" -> "Reservada"
        "completed" -> "Concluída"
        "partial" -> "Parcial"
        "blocked" -> "Bloqueada"
        else -> "Livre"
    }

    fun paymentLabel(status: String?): String = when (status) {
        "created" -> "Aguardando pagamento"
        "paid" -> "Pago"
        "expired" -> "Venceu"
        "cancelled" -> "Cancelado"
        "refunded" -> "Devolvido"
        null -> "—"
        else -> status
    }

    fun canConfirm(b: ReservaBooking) = b.state == "pending_payment"
    fun canChargeDeposit(b: ReservaBooking) = b.state == "pending_payment" && b.conversationId != null && (b.depositCents ?: 0) > 0
    fun canSendCheckin(b: ReservaBooking, now: Long = System.currentTimeMillis()) =
        b.state == "confirmed" && b.conversationId != null && b.checkinStatus != "completed" && (b.departureAt ?: b.ends ?: Long.MAX_VALUE) > now
    fun canEdit(b: ReservaBooking) = b.state in ACTIVE
    fun canCancel(b: ReservaBooking) = b.state in ACTIVE

    fun isConflict(error: Throwable): Boolean = (error as? QueueException)?.code in CONFLICTS

    /** A explicação de cada recusa; `outside_rules` traz a regra na mensagem do servidor. */
    fun explain(error: Throwable): String {
        val e = error as? QueueException ?: return ModuleFailure.message(error)
        return when (e.code) {
            "unit_unavailable" -> "Essa unidade acabou de ser reservada nesse período. A disponibilidade foi atualizada: escolha outra unidade ou outras datas."
            "unit_blocked" -> "A unidade está bloqueada nesse período (manutenção ou fechamento). A disponibilidade foi atualizada: escolha outras datas ou outra unidade."
            "outside_rules" -> "Fora das regras da reserva: ${e.message.orEmpty()} Escolha de novo."
            "booking_closed" -> "Esta reserva já foi encerrada (cancelada, expirada ou concluída) e não muda mais."
            "checkin_disabled" -> "O check-in online está desligado nas regras da Reserva."
            "checkin_done" -> "O cliente já fez o check-in."
            "booking_not_confirmed" -> "O check-in só é enviado para reservas confirmadas."
            "no_conversation" -> "Esta reserva não está ligada a uma conversa do WhatsApp."
            "payments_not_configured", "payments_disabled" -> "A Cobrança (Pix e link) não está pronta nesta área: o sinal não pode ser cobrado. Confirme sem sinal se o cliente pagou por fora."
            else -> ModuleFailure.message(e)
        }
    }

    /** "2026-11-22" → "22/11". */
    fun shortDay(day: String): String {
        val parts = day.split("-")
        return if (parts.size == 3) "${parts[2]}/${parts[1]}" else day
    }

    fun nightsText(n: Int) = if (n == 1) "1 diária" else "$n diárias"

    fun guestsText(n: Int) = if (n == 1) "1 pessoa" else "$n pessoas"

    fun durationText(minutes: Int): String = if (minutes % 60 == 0) "${minutes / 60} h" else "${minutes / 60} h ${minutes % 60}"

    /** Filtros da lista: id, título e estados pedidos (vazio: todos). */
    val FILTERS: List<Triple<String, String, List<String>>> = listOf(
        Triple("upcoming", "Ativas", listOf("pending_payment", "confirmed")),
        Triple("pending_payment", "Aguardando sinal", listOf("pending_payment")),
        Triple("confirmed", "Confirmadas", listOf("confirmed")),
        Triple("completed", "Concluídas", listOf("completed")),
        Triple("cancelled", "Canceladas", listOf("cancelled", "expired")),
        Triple("all", "Todas", emptyList()),
    )

    /** Respostas do check-in em linhas legíveis ("Documento: …", "Chegada prevista: 15h"). */
    fun answers(b: ReservaBooking): List<Pair<String, String>> =
        b.checkinAnswers.orEmpty().entries.sortedBy { it.key }.map { (key, value) ->
            val label = key.replace('_', ' ').replaceFirstChar { it.uppercase() }
            val primitive = value as? JsonPrimitive
            val text = when {
                primitive == null -> value.toString()
                primitive.isString -> primitive.content
                primitive.booleanOrNull != null -> if (primitive.booleanOrNull == true) "sim" else "não"
                else -> primitive.content
            }
            label to text
        }

    /** As reservas ativas do período mostrado, por entrada. */
    fun upcoming(calendar: ReservaCalendar?): List<ReservaBooking> =
        calendar?.bookings.orEmpty().filter { it.state in ACTIVE }.sortedBy { it.starts }

    /** O que tocar numa célula faz: abrir a reserva, reservar o dia livre ou nada (bloqueio). */
    fun cellAction(cell: ReservaCell): CellAction = when {
        cell.bookingIds.isNotEmpty() -> CellAction.Open(cell.bookingIds.first())
        cell.state == "blocked" -> CellAction.None
        else -> CellAction.Book
    }

    sealed interface CellAction {
        data class Open(val bookingId: String) : CellAction
        data object Book : CellAction
        data object None : CellAction
    }
}
