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
import androidx.compose.runtime.collectAsState
import br.com.queven.wabotia.modules.caixa.CaixaScreen
import br.com.queven.wabotia.modules.clientes.ClientesScreen
import br.com.queven.wabotia.modules.clientes.ContactFormScreen
import br.com.queven.wabotia.modules.entrega.EntregaScreen
import br.com.queven.wabotia.modules.mesas.MesasScreen
import br.com.queven.wabotia.ui.nav.Routes
import br.com.queven.wabotia.ui.service.AssistantScreen
import br.com.queven.wabotia.ui.service.EquipmentScreen
import br.com.queven.wabotia.modules.mensalidade.InstallmentScreen
import br.com.queven.wabotia.modules.mensalidade.MensalidadeScreen
import br.com.queven.wabotia.modules.mensalidade.MensalidadeViewModel
import br.com.queven.wabotia.modules.mensalidade.SubscriptionScreen
import br.com.queven.wabotia.modules.os.NewWorkOrderScreen
import br.com.queven.wabotia.modules.os.WorkOrderScreen
import br.com.queven.wabotia.modules.os.WorkOrdersEntry
import br.com.queven.wabotia.modules.pedido.PedidoOrderScreen
import br.com.queven.wabotia.modules.pedido.PedidoScreen
import br.com.queven.wabotia.modules.pedido.PedidoViewModel
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

    /** Entrada da Mensalidade (o mês); `mensalidade?mode=subscriptions|delinquents` abre as outras abas. */
    const val MENSALIDADE = "mensalidade"
    const val MENSALIDADE_HOME = "mensalidade?mode={mode}"
    const val MENSALIDADE_INSTALLMENT = "mensalidade/installment/{id}"
    const val MENSALIDADE_SUBSCRIPTION = "mensalidade/subscription/{id}"

    /** Entrada do Pedido (o quadro da cozinha); `pedido?mode=list|menu` abre a lista ou o cardápio. */
    const val PEDIDO = "pedido"
    const val PEDIDO_HOME = "pedido?mode={mode}"
    const val PEDIDO_ORDER = "pedido/order/{id}"

    fun pedidoOrder(id: String) = "pedido/order/${Uri.encode(id)}"

    fun installment(id: String) = "mensalidade/installment/${Uri.encode(id)}"

    fun subscription(id: String) = "mensalidade/subscription/${Uri.encode(id)}"

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

/**
 * Rotas do básico do atendimento na aba Atendimento: caixa simples, clientes, mesas, entregas, equipamentos e o
 * assistente (a conversa interna com o bot, onde se consulta o ERP).
 */
object BasicRoutes {
    const val CAIXA = "caixa"
    const val CLIENTES = "clientes"
    const val CLIENTE = "clientes/form?id={id}"
    const val MESAS = "mesas"
    const val ENTREGA = "entrega"
    const val EQUIPAMENTOS = "equipamentos"
    const val ASSISTENTE = "assistente"

    fun cliente(id: String?): String = "clientes/form" + (id?.let { "?id=${Uri.encode(it)}" } ?: "")
}

/** Um atalho de módulo no menu da conversa. */
data class ModuleShortcut(val label: String, val icon: ImageVector, val route: String)

private fun optional(name: String) = navArgument(name) { type = NavType.StringType; nullable = true; defaultValue = null }

/** As telas dos módulos no grafo de navegação do app logado. */
fun NavGraphBuilder.moduleScreens(container: AppContainer, nav: NavHostController, openConversation: (String) -> Unit, openPrinter: () -> Unit) {
    // O básico do atendimento (aba Atendimento). O ERP fica no navegador; no app, pelo assistente.
    composable(BasicRoutes.CAIXA) { CaixaScreen(container, onBack = { nav.popBackStack() }) }
    composable(BasicRoutes.CLIENTES) { entry ->
        val saved = entry.savedStateHandle.getStateFlow("clientes.saved", 0).collectAsState()
        ClientesScreen(container, onBack = { nav.popBackStack() }, openForm = { nav.navigate(BasicRoutes.cliente(it)) }, refreshKey = saved.value)
    }
    composable(BasicRoutes.CLIENTE, arguments = listOf(optional("id"))) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode)
        ContactFormScreen(container, id, onBack = { nav.popBackStack() }, onSaved = {
            nav.previousBackStackEntry?.savedStateHandle?.let { it["clientes.saved"] = (it.get<Int>("clientes.saved") ?: 0) + 1 }
            nav.popBackStack()
        })
    }
    composable(BasicRoutes.MESAS) { MesasScreen(container, onBack = { nav.popBackStack() }) }
    composable(BasicRoutes.ENTREGA) { EntregaScreen(container, onBack = { nav.popBackStack() }) }
    composable(BasicRoutes.EQUIPAMENTOS) { EquipmentScreen(container, onBack = { nav.popBackStack() }, openPrinter = openPrinter) }
    composable(BasicRoutes.ASSISTENTE) {
        // Um bot só: a conversa toma o lugar desta tela (voltar não reabre a escolha).
        AssistantScreen(container, onBack = { nav.popBackStack() }, openChat = { peer ->
            nav.navigate(Routes.internalChat(peer)) { popUpTo(BasicRoutes.ASSISTENTE) { inclusive = true } }
        })
    }
    // Ordem de serviço por modelo. Servidor sem modelos, catálogo só com o modelo simples e ordem do modelo simples
    // caem nas telas antigas dentro das próprias telas novas (WorkOrdersEntry, WorkOrderScreen, NewWorkOrderScreen).
    composable(ModuleRoutes.SERVICE_ORDERS) {
        WorkOrdersEntry(
            container,
            onBack = { nav.popBackStack() },
            openOrder = { nav.navigate(ModuleRoutes.serviceOrder(it.id)) },
            openLegacyOrder = { nav.navigate(ModuleRoutes.serviceOrder(it)) },
            newOrder = { nav.navigate(ModuleRoutes.newServiceOrder()) },
            newLegacyOrder = { nav.navigate(ModuleRoutes.newServiceOrder()) },
        )
    }
    composable(ModuleRoutes.SERVICE_ORDER, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        WorkOrderScreen(container, id, onBack = { nav.popBackStack() }, openConversation = openConversation, openPrinter = openPrinter)
    }
    composable(ModuleRoutes.NEW_SERVICE_ORDER, arguments = listOf(optional("conversationId"), optional("customer"))) { entry ->
        NewWorkOrderScreen(
            container,
            conversationId = entry.arguments?.getString("conversationId")?.let(Uri::decode),
            customer = entry.arguments?.getString("customer")?.let(Uri::decode),
            onBack = { nav.popBackStack() },
            onCreated = { order -> nav.popBackStack(); nav.navigate(ModuleRoutes.serviceOrder(order.id)) },
            onCreatedLegacy = { order -> nav.popBackStack(); nav.navigate(ModuleRoutes.serviceOrder(order.id)) },
        )
    }
    composable(ModuleRoutes.PEDIDO_HOME, arguments = listOf(optional("mode"))) { entry ->
        PedidoScreen(
            container,
            onBack = { nav.popBackStack() },
            openOrder = { nav.navigate(ModuleRoutes.pedidoOrder(it)) },
            initialMode = when (entry.arguments?.getString("mode")) {
                "list" -> PedidoViewModel.Mode.LIST
                "menu" -> PedidoViewModel.Mode.MENU
                else -> PedidoViewModel.Mode.BOARD
            },
        )
    }
    composable(ModuleRoutes.PEDIDO_ORDER, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        PedidoOrderScreen(container, id, onBack = { nav.popBackStack() }, openConversation = openConversation, openPrinter = openPrinter)
    }
    composable(ModuleRoutes.MENSALIDADE_HOME, arguments = listOf(optional("mode"))) { entry ->
        MensalidadeScreen(
            container,
            onBack = { nav.popBackStack() },
            openInstallment = { nav.navigate(ModuleRoutes.installment(it)) },
            openSubscription = { nav.navigate(ModuleRoutes.subscription(it)) },
            initialMode = when (entry.arguments?.getString("mode")) {
                "subscriptions" -> MensalidadeViewModel.Mode.SUBSCRIPTIONS
                "delinquents" -> MensalidadeViewModel.Mode.DELINQUENTS
                else -> MensalidadeViewModel.Mode.MONTH
            },
        )
    }
    composable(ModuleRoutes.MENSALIDADE_INSTALLMENT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        InstallmentScreen(container, id, onBack = { nav.popBackStack() }, openSubscription = { nav.navigate(ModuleRoutes.subscription(it)) }, openConversation = openConversation)
    }
    composable(ModuleRoutes.MENSALIDADE_SUBSCRIPTION, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        SubscriptionScreen(container, id, onBack = { nav.popBackStack() }, openInstallment = { nav.navigate(ModuleRoutes.installment(it)) }, openConversation = openConversation)
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
