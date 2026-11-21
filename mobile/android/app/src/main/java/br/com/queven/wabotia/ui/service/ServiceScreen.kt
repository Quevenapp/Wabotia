package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.DeliveryDining
import androidx.compose.material.icons.filled.Hotel
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.RestaurantMenu
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.TableRestaurant
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AdminRole
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.Links
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb

/**
 * Aba Atendimento (DESIGN.md, seção 10): os módulos básicos ligados na área (fila, agenda, mensalidades, reservas,
 * mesas, entregas, pedidos, ordens de serviço), o caixa, os clientes e os equipamentos, o assistente (consulta do ERP
 * pelo bot) e as linhas e menus. O que entra vem de [ServiceHub]; o avançado abre no navegador.
 */
@Composable
fun ServiceScreen(container: AppContainer, modifier: Modifier = Modifier, openRoute: (String) -> Unit) {
    val c = Wb.colors
    val context = LocalContext.current
    val enabledModules by container.modules.enabled.collectAsState()
    val grants by container.modules.grants.collectAsState()
    val roles by container.modules.roles.collectAsState()
    val profile = container.session.profileId
    val modules = enabledModules[profile].orEmpty()
    // Administrador pelo papel atual do servidor (capacidades), não só pelo gravado no login.
    val isAdmin = AdminRole.isAdmin(roles[profile], container.session.user?.role)
    // Toda vez que a aba abre: módulos e papel podem ter mudado no painel.
    LaunchedEffect(profile) { container.modules.refresh(force = true) }
    val server = container.session.serverUrl
    // Sem servidor (demonstração) não há painel para abrir: a entrada do navegador some.
    val entries = ServiceHub.entries(modules, grants[profile].orEmpty(), isAdmin).filter { !it.opensBrowser || WebPanel.url(server, it.webPath!!) != null }
    val sections = ServiceHub.sections(entries)

    Scaffold(
        modifier = modifier,
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            Column {
                TabTopBar("Atendimento")
                ConnectionStrip(container)
            }
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            if (sections.none { it.first == ServiceSection.MODULES }) item("no-modules") {
                Text(
                    "Nenhum módulo de atendimento está ligado nesta área. Um administrador liga fila de senhas, agenda, " +
                        "mensalidades e os outros em Gestão → Módulos, no painel.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp),
                )
            }
            sections.forEach { (section, list) ->
                item("label-${section.name}") { SectionLabel(section.label) }
                item("card-${section.name}") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        list.forEachIndexed { index, entry ->
                            if (index > 0) RowDivider()
                            val (icon, tint) = look(entry.id)
                            val web = entry.webPath?.let { WebPanel.url(server, it) }
                            SettingsRow(
                                icon,
                                entry.title,
                                subtitle = entry.subtitle,
                                tint = tint,
                                onClick = { if (web != null) Links.open(context, web) else openRoute(entry.route) },
                                modifier = Modifier.testTag("service.${entry.id}"),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Ícone e cor de cada entrada. */
@Composable
private fun look(id: String): Pair<ImageVector, Color> {
    val c = Wb.colors
    return when (id) {
        "counter" -> Icons.Filled.ConfirmationNumber to c.warn
        "agenda" -> Icons.Filled.CalendarMonth to c.ok
        "os" -> Icons.Filled.Build to c.warn
        "reserva" -> Icons.Filled.Hotel to c.brand
        "mensalidade" -> Icons.Filled.Payments to c.ok
        "pedido" -> Icons.Filled.RestaurantMenu to c.ticket
        "mesas" -> Icons.Filled.TableRestaurant to c.ticket
        "entrega" -> Icons.Filled.DeliveryDining to c.brand
        "caixa" -> Icons.Filled.PointOfSale to c.ok
        "clientes" -> Icons.Filled.People to c.brand
        "equipamentos" -> Icons.Filled.Print to c.textSecondary
        "assistente" -> Icons.Filled.SmartToy to c.bot
        "web" -> Icons.Filled.OpenInBrowser to c.textSecondary
        "menus" -> Icons.Filled.AccountTree to c.ticket
        "bot-lines" -> Icons.Filled.SmartToy to c.bot
        else -> Icons.Filled.SupportAgent to c.brand
    }
}
