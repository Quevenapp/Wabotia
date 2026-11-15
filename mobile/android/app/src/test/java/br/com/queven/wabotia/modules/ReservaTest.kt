package br.com.queven.wabotia.modules

import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.reserva.ReservaBooking
import br.com.queven.wabotia.modules.reserva.ReservaBookingViewModel
import br.com.queven.wabotia.modules.reserva.ReservaCell
import br.com.queven.wabotia.modules.reserva.ReservaClient
import br.com.queven.wabotia.modules.reserva.ReservaDeps
import br.com.queven.wabotia.modules.reserva.ReservaFormViewModel
import br.com.queven.wabotia.modules.reserva.ReservaRequest
import br.com.queven.wabotia.modules.reserva.ReservaRules
import br.com.queven.wabotia.modules.reserva.ReservaViewModel
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A Reserva: regras da tela e o cliente contra a demonstração (mesmos códigos de erro do servidor). */
@OptIn(ExperimentalCoroutinesApi::class)
class ReservaTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val client = ReservaClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http))
    private val today get() = BrasiliaTime.today()
    private fun day(n: Int) = BrasiliaTime.addDays(today, n)
    private fun deps() = ReservaDeps(client, {}, { today })

    private suspend fun refusal(block: suspend () -> Unit): QueueException =
        runCatching { block() }.exceptionOrNull() as? QueueException ?: throw AssertionError("esperava uma recusa do servidor")

    @Before fun fresh() {
        DemoServer.reset()
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun main() = Dispatchers.resetMain()

    @Test fun regrasDosBotoes() {
        val pending = ReservaBooking(id = "b", status = "pending_payment", conversationId = "c", depositCents = 100, departureAt = 2_000)
        assertTrue(ReservaRules.canConfirm(pending))
        assertTrue(ReservaRules.canChargeDeposit(pending))
        assertFalse(ReservaRules.canChargeDeposit(pending.copy(conversationId = null)))
        assertFalse(ReservaRules.canChargeDeposit(pending.copy(depositCents = 0)))
        assertFalse(ReservaRules.canSendCheckin(pending, now = 1_000))
        val confirmed = pending.copy(status = "confirmed")
        assertTrue(ReservaRules.canSendCheckin(confirmed, now = 1_000))
        assertFalse(ReservaRules.canSendCheckin(confirmed, now = 3_000))
        assertFalse(ReservaRules.canSendCheckin(confirmed.copy(checkinStatus = "completed"), now = 1_000))
        assertFalse(ReservaRules.canConfirm(confirmed))
        assertTrue(ReservaRules.canEdit(confirmed) && ReservaRules.canCancel(confirmed))
        listOf("cancelled", "expired", "completed").forEach { s ->
            assertFalse(ReservaRules.canEdit(confirmed.copy(status = s)))
            assertFalse(ReservaRules.canCancel(confirmed.copy(status = s)))
        }
        listOf("unit_unavailable", "unit_blocked", "outside_rules").forEach { assertTrue(ReservaRules.isConflict(QueueException(409, it, ""))) }
        assertFalse(ReservaRules.isConflict(QueueException(409, "module_disabled", "")))
        assertEquals(ReservaRules.CellAction.Open("b1"), ReservaRules.cellAction(ReservaCell("2026-11-20", "confirmed", listOf("b1"))))
        assertEquals(ReservaRules.CellAction.Book, ReservaRules.cellAction(ReservaCell("2026-11-20", "free")))
        assertEquals(ReservaRules.CellAction.None, ReservaRules.cellAction(ReservaCell("2026-11-20", "blocked")))
        val stay = ReservaBooking(id = "s", startDate = "2026-11-20", endDate = "2026-11-23", nights = 3)
        assertEquals("20/11 a 23/11 · 3 diárias", stay.periodText)
        val answers = ReservaRules.answers(stay.copy(checkinAnswers = mapOf("veiculo" to JsonPrimitive(false), "chegada_prevista" to JsonPrimitive("15h"))))
        assertEquals(listOf("Chegada prevista" to "15h", "Veiculo" to "não"), answers)
    }

    @Test fun ocupacaoDaDemonstracao() = runTest {
        val calendar = client.calendar(today, day(13))
        assertEquals(14, calendar.days.size)
        assertEquals(listOf("u-mar", "u-jardim", "u-familia", "u-salao"), calendar.units.map { it.unitId })
        val mar = calendar.units.first { it.unitId == "u-mar" }.cells
        assertEquals("confirmed", mar.first { it.date == today }.state)
        val jardim = calendar.units.first { it.unitId == "u-jardim" }.cells
        assertEquals("pending_payment", jardim.first { it.date == day(1) }.state)
        assertEquals("blocked", jardim.first { it.date == day(9) }.state)
        assertEquals("partial", calendar.units.first { it.unitId == "u-salao" }.cells.first { it.date == day(2) }.state)
        // Reserva cancelada não ocupa nem aparece.
        assertTrue(calendar.bookings.none { it.state == "cancelled" })
        val vm = ReservaViewModel(deps())
        vm.load()
        assertEquals(listOf("u-mar", "u-jardim", "u-familia", "u-salao"), vm.calendar?.units?.map { it.unitId })
        assertTrue(vm.upcoming.all { it.state in ReservaRules.ACTIVE })
        vm.changeMode(ReservaViewModel.Mode.LIST)
        vm.load()
        assertTrue(vm.bookings.isNotEmpty() && vm.bookings.all { it.state in ReservaRules.ACTIVE })
    }

    @Test fun reservarAlterarECancelarNaDemonstracao() = runTest {
        val options = client.dailyAvailability(day(20), 2, 2).units
        assertTrue(options.first { it.unitId == "u-familia" }.available == true)
        val request = ReservaRequest("u-familia", guests = 2, startDate = day(20), nights = 2, customerName = "Cliente Exemplo", customerPhone = "5520900000099")
        val booked = client.create(request, "k1")
        assertEquals("confirmed", booked.state)
        assertEquals(2, booked.nights)
        assertEquals(day(22), booked.endDate)
        assertEquals("14:00", booked.arrivalTime)
        // Mesma chave e mesmo pedido: a mesma reserva, sem outra.
        assertEquals(booked.id, client.create(request, "k1").id)
        assertEquals(409, refusal { client.create(request.copy(guests = 3), "k1") }.status)
        assertFalse(client.dailyAvailability(day(20), 2, 2).units.first { it.unitId == "u-familia" }.available == true)
        val changed = client.update(booked.id, ReservaRequest(null, nights = 3), "k2")
        assertEquals(3, changed.nights)
        assertEquals(1, changed.changes)
        assertEquals("cancelled", client.cancel(booked.id, "Cliente pediu", "k3").state)
        assertTrue(client.bookings(listOf("cancelled"), query = "Cliente Exemplo").any { it.id == booked.id && it.cancelReason == "Cliente pediu" })
        assertEquals("booking_closed", refusal { client.confirm(booked.id, "k4") }.code)
    }

    @Test fun recusasDoServidor() = runTest {
        // Ocupada, bloqueada e fora das regras (capacidade e funcionamento do salão).
        assertEquals("unit_unavailable", refusal { client.create(ReservaRequest("u-mar", startDate = today, nights = 1, customerName = "A"), "r1") }.code)
        assertEquals("unit_blocked", refusal { client.create(ReservaRequest("u-jardim", startDate = day(9), nights = 1, customerName = "A"), "r2") }.code)
        assertEquals("outside_rules", refusal { client.create(ReservaRequest("u-mar", guests = 3, startDate = day(30), nights = 1, customerName = "A"), "r3") }.code)
        val late = BrasiliaTime.startOf(day(3))!! + 21 * 3_600_000L
        assertEquals("outside_rules", refusal { client.create(ReservaRequest("u-salao", starts = late, durationMinutes = 120, customerName = "A"), "r4") }.code)
        // Conversa de grupo não recebe reserva.
        assertEquals(400, refusal { client.create(ReservaRequest("u-mar", startDate = day(30), nights = 1, conversationId = Ids.C_GROUP), "r5") }.status)
        val blocked = client.dailyAvailability(day(9), 1, 2).units.first { it.unitId == "u-jardim" }
        assertEquals("blocked", blocked.reason)
        assertNotNull(blocked.message)
    }

    @Test fun reservaPorHora() = runTest {
        val slots = client.hourlyAvailability(day(2), 60, "u-salao").units.single().slots
        val busy = BrasiliaTime.startOf(day(2))!! + 14 * 3_600_000L
        assertTrue(slots.none { it.starts in busy until busy + 4 * 3_600_000L })
        assertEquals("08:00", slots.first().clock)
        val start = BrasiliaTime.startOf(day(3))!! + 10 * 3_600_000L
        val booked = client.create(ReservaRequest("u-salao", guests = 20, starts = start, durationMinutes = 120, conversationId = Ids.C_RICH), "h1")
        assertEquals(120, booked.durationMinutes)
        assertEquals(Ids.C_RICH, booked.conversationId)
        assertEquals(30_000L, booked.priceCents)
        assertEquals("unit_unavailable", refusal { client.create(ReservaRequest("u-salao", starts = start + 3_600_000L, durationMinutes = 60, customerName = "B"), "h2") }.code)
    }

    @Test fun sinalECheckin() = runTest {
        val pending = client.booking("rs-2")
        assertEquals("pending_payment", pending.state)
        assertTrue(ReservaRules.canChargeDeposit(pending))
        assertEquals("created", client.deposit("rs-2", "d1").paymentStatus)
        val vm = ReservaBookingViewModel("rs-2", deps())
        vm.load()
        vm.perform("confirm", "Reserva confirmada") { client.confirm("rs-2", it) }
        assertEquals("confirmed", vm.booking?.state)
        assertEquals("Reserva confirmada", vm.done)
        assertEquals("sent", client.checkin("rs-2", "c1").checkinStatus)
        assertEquals("checkin_done", refusal { client.checkin("rs-1", "c2") }.code)
        // Sem conversa: não há a quem cobrar.
        assertEquals(400, refusal { client.checkin("rs-3", "c3") }.status)
        val closed = ReservaBookingViewModel("rs-5", deps())
        closed.load()
        closed.perform("cancel", "Reserva cancelada") { client.cancel("rs-5", null, it) }
        assertTrue(closed.notice.orEmpty().startsWith("Esta reserva já foi encerrada"))
        assertNull(closed.pendingKey)
    }

    @Test fun unidadeOcupadaRecarregaADisponibilidade() = runTest {
        val vm = ReservaFormViewModel(null, null, null, "u-mar", today, deps())
        vm.load()
        assertEquals("u-mar", vm.unitId)
        assertFalse(vm.chosenDaily?.available == true)
        vm.customerName = "Primeiro"
        assertFalse(vm.canSubmit)
        vm.chooseStart(day(20)).join()
        assertTrue(vm.canSubmit)
        // Outra pessoa reserva a mesma unidade antes.
        client.create(ReservaRequest("u-mar", startDate = day(20), nights = 1, customerName = "Concorrente"), "outra-chave")
        vm.save()
        assertNull(vm.result)
        assertTrue(vm.notice.orEmpty().startsWith("Essa unidade acabou de ser reservada"))
        assertFalse(vm.chosenDaily?.available == true)
        assertFalse(vm.canSubmit)
        // Escolher outra unidade reserva com outra chave.
        vm.chooseUnit("u-familia")?.join()
        assertTrue(vm.canSubmit)
        vm.save()
        assertEquals("u-familia", vm.result?.unitId)
    }

    @Test fun alterarMandaSoOQueMudou() = runTest {
        val vm = ReservaFormViewModel("rs-3", null, null, null, null, deps())
        vm.load()
        assertEquals("u-familia", vm.unitId)
        assertEquals(2, vm.nights)
        assertFalse(vm.hasChanges)
        vm.changeGuests(4).join()
        val request = vm.request()
        assertEquals(4, request.guests)
        assertNull(request.startDate)
        assertNull(request.nights)
        assertNull(request.unitId)
        // A disponibilidade conta a própria reserva: não trava a alteração.
        assertTrue(vm.ownBooking)
        assertTrue(vm.canSubmit)
        vm.save()
        assertEquals(4, vm.result?.guests)
        assertEquals(1, vm.result?.changes)
    }

    @Test fun dadosDaReservaSaoFicticios() = runTest {
        client.bookings().forEach { b -> assertTrue(b.customerPhone.orEmpty(), b.customerPhone.orEmpty().matches(Regex("""552090\d{7}"""))) }
    }
}
