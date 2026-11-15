package br.com.queven.wabotia.modules

import android.net.Uri
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.EventAvailable
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

/** Rotas das telas das verticais. Cada uma só tem entrada quando o módulo está ligado ([ModuleFeature]). */
object ModuleRoutes {
    const val AGENDA = "agenda"
    const val APPOINTMENT = "agenda/appointment/{id}"
    const val BOOKING = "agenda/book?conversationId={conversationId}&customer={customer}&move={move}"

    const val SERVICE_ORDERS = "os"
    const val SERVICE_ORDER = "os/order/{id}"
    const val NEW_SERVICE_ORDER = "os/new?conversationId={conversationId}&customer={customer}"

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
