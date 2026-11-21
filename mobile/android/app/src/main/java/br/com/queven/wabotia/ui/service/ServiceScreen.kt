package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Hotel
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.RestaurantMenu
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SupportAgent
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.erp.rememberErpAccess
import br.com.queven.wabotia.modules.erp.rememberIsAdmin
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb

/**
 * Aba Atendimento (DESIGN.md, seção 10): os módulos ligados na área (guichê, agenda, ordens de serviço, reservas,
 * mensalidades, pedidos), a Gestão do ERP e as linhas e menus. O que entra vem de [ServiceHub]; os Ajustes ficam na
 * engrenagem do topo.
 */
@Composable
fun ServiceScreen(container: AppContainer, modifier: Modifier = Modifier, openRoute: (String) -> Unit) {
    val c = Wb.colors
    val enabledModules by container.modules.enabled.collectAsState()
    val modules = enabledModules[container.session.profileId].orEmpty()
    val erp = rememberErpAccess(container)
    val isAdmin = rememberIsAdmin(container)
    // Toda vez que a aba abre: módulos e papel podem ter mudado no painel.
    LaunchedEffect(container.session.profileId) { container.modules.refresh(force = true) }
    val sections = ServiceHub.sections(ServiceHub.entries(modules, erp, isAdmin))

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
            if (sections.none { it.first != ServiceSection.LINES }) item("no-modules") {
                Text(
                    "Nenhum módulo de atendimento está ligado nesta área. Um administrador liga agenda, ordens de serviço, " +
                        "pedidos, Gestão e os outros em Módulos, no painel do Wabotia.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp),
                )
            }
            sections.forEach { (section, entries) ->
                item("label-${section.name}") {
                    SectionLabel(
                        if (section == ServiceSection.MANAGEMENT && erp != null) "${section.label} · seu papel: ${erp.role.label}" else section.label,
                    )
                }
                item("card-${section.name}") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        entries.forEachIndexed { index, entry ->
                            if (index > 0) RowDivider()
                            val (icon, tint) = look(entry.id)
                            SettingsRow(
                                icon,
                                entry.title,
                                subtitle = entry.subtitle,
                                tint = tint,
                                onClick = { openRoute(entry.route) },
                                modifier = Modifier.testTag("service.${entry.id}"),
                            )
                        }
                    }
                }
                if (section == ServiceSection.MANAGEMENT) item("management-note") {
                    Text(
                        "Notas fiscais, compras, relatórios e configurações da Gestão ficam no painel, no navegador.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp),
                    )
                }
            }
        }
    }
}

/** Ícone e cor de cada entrada (os mesmos que tinham em Ajustes e na Gestão). */
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
        "erp.customers" -> Icons.Filled.People to c.brand
        "erp.products" -> Icons.Filled.Inventory2 to c.brand
        "erp.order" -> Icons.Filled.ShoppingCart to c.brand
        "erp.bills" -> Icons.Filled.AccountBalanceWallet to c.brand
        "menus" -> Icons.Filled.AccountTree to c.ticket
        "bot-lines" -> Icons.Filled.SmartToy to c.bot
        else -> Icons.Filled.SupportAgent to c.brand
    }
}
