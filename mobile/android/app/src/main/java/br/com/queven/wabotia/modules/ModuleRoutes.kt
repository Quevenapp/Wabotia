package br.com.queven.wabotia.modules

import android.net.Uri
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.Hotel
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.agenda.AgendaScreen
import br.com.queven.wabotia.modules.agenda.AppointmentScreen
import br.com.queven.wabotia.modules.agenda.BookingScreen
import br.com.queven.wabotia.modules.os.NewServiceOrderScreen
import br.com.queven.wabotia.modules.os.ServiceOrderScreen
import br.com.queven.wabotia.modules.os.ServiceOrdersScreen
import br.com.queven.wabotia.modules.reserva.ReservaBookingScreen
import br.com.queven.wabotia.modules.reserva.ReservaFormScreen
import br.com.queven.wabotia.modules.reserva.ReservaScreen
import br.com.queven.wabotia.modules.reserva.ReservaViewModel

/** Rotas das telas das verticais. Cada uma só tem entrada quando o módulo está ligado ([ModuleFeature]). */
object ModuleRoutes {
    const val AGENDA = "agenda"
    const val APPOINTMENT = "agenda/appointment/{id}"
    const val BOOKING = "agenda/book?conversationId={conversationId}&customer={customer}&move={move}"

    const val SERVICE_ORDERS = "os"
    const val SERVICE_ORDER = "os/order/{id}"
    const val NEW_SERVICE_ORDER = "os/new?conversationId={conversationId}&customer={customer}"

    /** Entrada da Reserva (ocupação); `reserva?mode=list` abre a lista. */
    const val RESERVA = "reserva"
    const val RESERVA_HOME = "reserva?mode={mode}"
    const val RESERVA_BOOKING = "reserva/booking/{id}"
    const val RESERVA_NEW = "reserva/new?conversationId={conversationId}&customer={customer}&unitId={unitId}&date={date}"
    const val RESERVA_EDIT = "reserva/edit/{id}"

    fun reservaBooking(id: String) = "reserva/booking/${Uri.encode(id)}"

    fun reservaEdit(id: String) = "reserva/edit/${Uri.encode(id)}"

    fun newReserva(conversationId: String? = null, customer: String? = null, unitId: String? = null, date: String? = null): String {
        val query = listOfNotNull(
            conversationId?.let { "conversationId=${Uri.encode(it)}" },
            customer?.let { "customer=${Uri.encode(it)}" },
            unitId?.let { "unitId=${Uri.encode(it)}" },
            date?.let { "date=${Uri.encode(it)}" },
        ).joinToString("&")
        return "reserva/new" + if (query.isEmpty()) "" else "?$query"
    }

    fun serviceOrder(id: String) = "os/order/${Uri.encode(id)}"

    fun newServiceOrder(conversationId: String? = null, customer: String? = null): String {
        val query = listOfNotNull(conversationId?.let { "conversationId=${Uri.encode(it)}" }, customer?.let { "customer=${Uri.encode(it)}" }).joinToString("&")
        return "os/new" + if (query.isEmpty()) "" else "?$query"
    }

    fun appointment(id: String) = "agenda/appointment/${Uri.encode(id)}"

    fun booking(conversationId: String? = null, customer: String? = null, move: String? = null): String {
        val query = listOfNotNull(
            conversationId?.let { "conversationId=${Uri.encode(it)}" },
            customer?.let { "customer=${Uri.encode(it)}" },
            move?.let { "move=${Uri.encode(it)}" },
        ).joinToString("&")
        return "agenda/book" + if (query.isEmpty()) "" else "?$query"
    }

    /** Atalhos do menu da conversa, conforme os módulos ligados (nunca em grupos). */
    fun conversationShortcuts(modules: Set<String>, conversationId: String, customer: String): List<ModuleShortcut> = buildList {
        if (ModuleIds.AGENDA in modules) add(ModuleShortcut("Agendar para este cliente", Icons.Filled.EventAvailable, booking(conversationId, customer)))
        if (ModuleIds.SERVICE_ORDERS in modules) add(ModuleShortcut("Abrir ordem de serviço", Icons.Filled.Build, newServiceOrder(conversationId, customer)))
        if (ModuleIds.RESERVA in modules) add(ModuleShortcut("Reservar para este cliente", Icons.Filled.Hotel, newReserva(conversationId, customer)))
    }
}

/** Um atalho de módulo no menu da conversa. */
data class ModuleShortcut(val label: String, val icon: ImageVector, val route: String)

private fun optional(name: String) = navArgument(name) { type = NavType.StringType; nullable = true; defaultValue = null }

/** As telas dos módulos no grafo de navegação do app logado. */
fun NavGraphBuilder.moduleScreens(container: AppContainer, nav: NavHostController, openConversation: (String) -> Unit, openPrinter: () -> Unit) {
    composable(ModuleRoutes.SERVICE_ORDERS) {
        ServiceOrdersScreen(
            container,
            onBack = { nav.popBackStack() },
            openOrder = { nav.navigate(ModuleRoutes.serviceOrder(it)) },
            newOrder = { nav.navigate(ModuleRoutes.newServiceOrder()) },
        )
    }
    composable(ModuleRoutes.SERVICE_ORDER, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        ServiceOrderScreen(container, id, onBack = { nav.popBackStack() }, openConversation = openConversation, openPrinter = openPrinter)
    }
    composable(ModuleRoutes.NEW_SERVICE_ORDER, arguments = listOf(optional("conversationId"), optional("customer"))) { entry ->
        NewServiceOrderScreen(
            container,
            conversationId = entry.arguments?.getString("conversationId")?.let(Uri::decode),
            customer = entry.arguments?.getString("customer")?.let(Uri::decode),
            onBack = { nav.popBackStack() },
            onCreated = { order -> nav.popBackStack(); nav.navigate(ModuleRoutes.serviceOrder(order.id)) },
        )
    }
    composable(ModuleRoutes.RESERVA_HOME, arguments = listOf(optional("mode"))) { entry ->
        ReservaScreen(
            container,
            onBack = { nav.popBackStack() },
            openBooking = { nav.navigate(ModuleRoutes.reservaBooking(it)) },
            newBooking = { unitId, date -> nav.navigate(ModuleRoutes.newReserva(unitId = unitId, date = date)) },
            initialMode = if (entry.arguments?.getString("mode") == "list") ReservaViewModel.Mode.LIST else ReservaViewModel.Mode.OCCUPANCY,
        )
    }
    composable(ModuleRoutes.RESERVA_BOOKING, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        ReservaBookingScreen(container, id, onBack = { nav.popBackStack() }, edit = { nav.navigate(ModuleRoutes.reservaEdit(it)) }, openConversation = openConversation)
    }
    composable(ModuleRoutes.RESERVA_NEW, arguments = listOf(optional("conversationId"), optional("customer"), optional("unitId"), optional("date"))) { entry ->
        val args = entry.arguments
        ReservaFormScreen(
            container,
            editingId = null,
            conversationId = args?.getString("conversationId")?.let(Uri::decode),
            customer = args?.getString("customer")?.let(Uri::decode),
            unitId = args?.getString("unitId")?.let(Uri::decode),
            date = args?.getString("date")?.let(Uri::decode),
            onBack = { nav.popBackStack() },
            onDone = { booking -> nav.popBackStack(); nav.navigate(ModuleRoutes.reservaBooking(booking.id)) },
        )
    }
    composable(ModuleRoutes.RESERVA_EDIT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        // Alterar volta ao detalhe, que relê a reserva ao reaparecer.
        ReservaFormScreen(container, editingId = id, conversationId = null, customer = null, unitId = null, date = null, onBack = { nav.popBackStack() }, onDone = { nav.popBackStack() })
    }
    composable(ModuleRoutes.AGENDA) {
        AgendaScreen(
            container,
            onBack = { nav.popBackStack() },
            openAppointment = { nav.navigate(ModuleRoutes.appointment(it)) },
            newBooking = { nav.navigate(ModuleRoutes.booking()) },
        )
    }
    composable(ModuleRoutes.APPOINTMENT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        AppointmentScreen(container, id, onBack = { nav.popBackStack() }, move = { nav.navigate(ModuleRoutes.booking(move = it)) }, openConversation = openConversation)
    }
    composable(ModuleRoutes.BOOKING, arguments = listOf(optional("conversationId"), optional("customer"), optional("move"))) { entry ->
        val args = entry.arguments
        BookingScreen(
            container,
            movingId = args?.getString("move")?.let(Uri::decode),
            conversationId = args?.getString("conversationId")?.let(Uri::decode),
            customer = args?.getString("customer")?.let(Uri::decode),
            onBack = { nav.popBackStack() },
            onDone = { appointment ->
                // Remarcar volta ao detalhe; um agendamento novo abre o próprio detalhe.
                nav.popBackStack()
                if (args?.getString("move") == null) nav.navigate(ModuleRoutes.appointment(appointment.id))
            },
        )
    }
}
