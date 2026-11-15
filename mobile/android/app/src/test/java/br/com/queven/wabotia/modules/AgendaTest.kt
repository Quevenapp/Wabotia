package br.com.queven.wabotia.modules

import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.demo.DemoServer
import br.com.queven.wabotia.demo.Ids
import br.com.queven.wabotia.modules.agenda.AgendaClient
import br.com.queven.wabotia.modules.agenda.AgendaDeps
import br.com.queven.wabotia.modules.agenda.AgendaProfessional
import br.com.queven.wabotia.modules.agenda.AgendaRules
import br.com.queven.wabotia.modules.agenda.Appointment
import br.com.queven.wabotia.modules.agenda.BookingViewModel
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A Agenda: regras da tela e o cliente contra a demonstração (mesmos códigos de erro do servidor). */
@OptIn(ExperimentalCoroutinesApi::class)
class AgendaTest {
    private val http = OkHttpClient.Builder().addInterceptor(DemoMode.interceptor).build()
    private val client = AgendaClient(ProfileApi(DemoMode.SERVER, Ids.PROFILE, { "wabu_demo" }, http))

    @Before fun fresh() {
        DemoServer.reset()
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun main() = Dispatchers.resetMain()

    @Test fun regrasDosBotoes() {
        val booked = Appointment(id = "a", starts = 1000, status = "booked")
        assertTrue(AgendaRules.canConfirm(booked))
        assertTrue(AgendaRules.canMove(booked))
        assertFalse(AgendaRules.canMarkNoShow(booked, now = 999))
        assertTrue(AgendaRules.canMarkNoShow(booked, now = 1000))
        val cancelled = booked.copy(status = "cancelled")
        assertFalse(AgendaRules.canCancel(cancelled))
        assertFalse(AgendaRules.canConfirm(booked.copy(status = "confirmed")))
        assertTrue(AgendaRules.isSlotConflict(QueueException(409, "slot_taken", "")))
        assertTrue(AgendaRules.isSlotConflict(QueueException(409, "slot_unavailable", "")))
        assertFalse(AgendaRules.isSlotConflict(QueueException(409, "module_disabled", "")))
    }

    @Test fun colunasPorProfissionalComArquivadoNoFim() {
        val pros = listOf(AgendaProfessional("p2", "Bia", position = 1), AgendaProfessional("p1", "Ana", position = 0), AgendaProfessional("p3", "Off", active = false))
        val list = listOf(
            Appointment("a1", professionalId = "p1", starts = 20),
            Appointment("a2", professionalId = "p1", starts = 10),
            Appointment("a3", professionalId = "p3", professionalName = "Off", starts = 5),
        )
        val columns = AgendaRules.columns(list, pros)
        assertEquals(listOf("p1", "p2", "p3"), columns.map { it.first.id })
        assertEquals(listOf("a2", "a1"), columns[0].second.map { it.id })
        assertTrue(columns[1].second.isEmpty())
        assertEquals(listOf("p1"), AgendaRules.professionals("s1", listOf(AgendaProfessional("p1", serviceIds = listOf("s1")), AgendaProfessional("p2", serviceIds = listOf("s2")))).map { it.id })
    }

    @Test fun agendarRemarcarECancelarNaDemonstracao() = runTest {
        val catalog = client.catalog()
        val service = catalog.services.first()
        val tomorrow = BrasiliaTime.addDays(BrasiliaTime.today(), 1)
        val slot = client.availability(service.id, null, tomorrow).days.single().slots.first()
        val booked = client.book(service.id, slot.starts, null, null, "Cliente Exemplo", "5520900000099", null, "k1")
        assertEquals("booked", booked.status)
        assertEquals(booked.id, client.book(service.id, slot.starts, null, null, "Cliente Exemplo", "5520900000099", null, "k1").id)
        assertTrue(client.availability(service.id, booked.professionalId, tomorrow).days.single().slots.none { it.starts == slot.starts })
        val other = client.availability(service.id, booked.professionalId, tomorrow).days.single().slots.first()
        val moved = client.move(booked.id, other.starts, booked.professionalId, "k2")
        assertEquals(1, moved.moves)
        assertEquals("confirmed", client.confirm(booked.id, "k3").status)
        assertEquals("cancelled", client.cancel(booked.id, "Cliente pediu", "k4").status)
        val (from, to) = BrasiliaTime.range(tomorrow)!!
        assertTrue(client.appointments(from, to).any { it.id == booked.id && it.cancelReason == "Cliente pediu" })
    }

    @Test fun horarioOcupadoRecarregaOsHorarios() = runTest {
        val service = client.catalog().services.first()
        val tomorrow = BrasiliaTime.addDays(BrasiliaTime.today(), 1)
        val vm = BookingViewModel(null, null, null, AgendaDeps(client, {}, { tomorrow }))
        vm.load()
        vm.chooseProfessional("p-leo")
        vm.loadSlots()
        val slot = vm.slots.first()
        vm.slot = slot
        vm.customerName = "Primeiro"
        // Outra pessoa pega o mesmo horário antes.
        client.book(service.id, slot.starts, "p-leo", null, "Concorrente", null, null, "outra-chave")
        vm.book()
        assertNull(vm.result)
        assertEquals(BookingViewModel.CONFLICT_MESSAGE, vm.notice)
        assertNull(vm.slot)
        assertTrue(vm.slots.none { it.starts == slot.starts })
        // Escolher outro horário agenda com outra chave.
        val before = vm.pendingKey
        vm.slot = vm.slots.first()
        vm.book()
        assertNotEquals(null, vm.result)
        assertNotEquals(before, vm.result?.id)
    }

    @Test fun dadosDaAgendaSaoFicticios() = runTest {
        val (from, to) = BrasiliaTime.range(BrasiliaTime.addDays(BrasiliaTime.today(), -1), 7)!!
        client.appointments(from, to).mapNotNull { it.customerPhone }.forEach { assertTrue(it, it.matches(Regex("""552090\d{7}"""))) }
    }
}
