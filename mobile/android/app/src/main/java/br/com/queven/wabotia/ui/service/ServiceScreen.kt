package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AlarmOn
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Hotel
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.RestaurantMenu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AccessIds
import br.com.queven.wabotia.core.AccessRules
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.ui.components.ConnectionStrip
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PresenceViewModel
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.TabTopBar
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.rememberPresence
import br.com.queven.wabotia.ui.settings.BusySwitch
import br.com.queven.wabotia.ui.theme.Wb
import br.com.queven.wabotia.ui.tickets.TicketFilter

/**
 * Aba Atendimento (no lugar da antiga aba Protocolos): tudo o que é do trabalho de atender, que antes ficava espalhado
 * em Ajustes. Disponível/ausente no topo, os protocolos por situação (cada linha abre a lista já filtrada), a fila e os
 * módulos ligados neste perfil e a configuração das linhas. A impressora do cupom continua em Ajustes → Dispositivo.
 */
@Composable
fun ServiceScreen(
    container: AppContainer,
    modifier: Modifier = Modifier,
    /** Contadores dos protocolos ativos (Ativos, Recebidos, Atrasados…), da mesma consulta da barra inferior. */
    ticketCounts: Map<TicketFilter, Int>,
    /** O que a pessoa acessa ([AccessRules]); null = tudo. */
    access: Set<String>? = null,
    openTickets: (TicketFilter) -> Unit,
    openCounter: () -> Unit,
    openLines: () -> Unit,
    openMenus: () -> Unit,
    openBotLines: () -> Unit,
    /** Telas dos módulos (Agenda, Ordens de serviço, Reservas, Mensalidades, Pedidos), por [ModuleRoutes]. */
    openRoute: (String) -> Unit,
) {
    val c = Wb.colors
    val presence = rememberPresence(container)
    val snackbar = remember { SnackbarHostState() }
    val enabledModules by container.modules.enabled.collectAsState()
    val modules = enabledModules[container.session.profileId].orEmpty()
    val isAdmin = container.session.user?.isAdmin == true
    LaunchedEffect(container.session.profileId) { container.modules.refresh() }
    LaunchedEffect(presence.message) {
        val msg = presence.message ?: return@LaunchedEffect
        presence.consumeMessage()
        snackbar.showSnackbar(msg)
    }

    Scaffold(
        modifier = modifier,
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TabTopBar("Atendimento")
                ConnectionStrip(container)
            }
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            // Online/offline decide se chegam conversas: só para quem atende conversas.
            if (AccessRules.allows(access, AccessIds.CONVERSATIONS)) {
                item("presence") { PresenceCard(presence, Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp)) }
            }
            // Papéis da lista que o app ainda não tem tela (ex.: caixa): aviso em vez de aba vazia.
            AccessRules.unavailable(access).forEach { role ->
                item("role-$role") {
                    InlineNotice(
                        "${AccessRules.label(role)}: esta tela ainda não está no app. Use o painel no navegador.",
                        Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
                        color = c.warn,
                    )
                }
            }

            // --- Protocolos ---
            if (AccessRules.allows(access, AccessIds.TICKETS)) item("tickets-label") { SectionLabel("Protocolos") }
            if (AccessRules.allows(access, AccessIds.TICKETS)) item("tickets") {
                val overdue = ticketCounts[TicketFilter.Overdue] ?: 0
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(
                        Icons.Filled.ConfirmationNumber,
                        "Protocolos ativos",
                        subtitle = ServiceTexts.activeSummary(ticketCounts),
                        tint = c.ticket,
                        onClick = { openTickets(TicketFilter.Active) },
                        trailing = { CountPill(ticketCounts[TicketFilter.Active], c.ticket) },
                    )
                    RowDivider()
                    SettingsRow(
                        Icons.Filled.AlarmOn,
                        "Atrasados",
                        subtitle = "Sem primeira resposta e com o prazo vencido",
                        tint = if (overdue > 0) c.danger else c.muted,
                        onClick = { openTickets(TicketFilter.Overdue) },
                        trailing = { CountPill(overdue, c.danger, filled = overdue > 0) },
                    )
                    RowDivider()
                    SettingsRow(
                        Icons.Filled.Inbox,
                        "Recebidos",
                        subtitle = "Abertos e ainda sem análise",
                        tint = c.accent,
                        onClick = { openTickets(TicketFilter.Open) },
                        trailing = { CountPill(ticketCounts[TicketFilter.Open], c.accent) },
                    )
                    RowDivider()
                    SettingsRow(
                        Icons.Filled.Search,
                        "Todos os protocolos",
                        subtitle = "Buscar por número WA-… ou telefone, inclusive os resolvidos",
                        tint = c.textSecondary,
                        onClick = { openTickets(TicketFilter.All) },
                    )
                }
            }

            // --- Fila e módulos ligados neste perfil ---
            val tools = ServiceTexts.tools(AccessRules.modules(access, modules))
            if (tools.isNotEmpty()) {
                item("modules-label") { SectionLabel("Fila e módulos") }
                item("modules") {
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        tools.forEachIndexed { index, tool ->
                            if (index > 0) RowDivider()
                            val tint = when (tool.id) {
                                ModuleIds.QUEUE, ModuleIds.SERVICE_ORDERS -> c.warn
                                ModuleIds.AGENDA, ModuleIds.MENSALIDADE -> c.ok
                                ModuleIds.PEDIDO -> c.ticket
                                else -> c.brand
                            }
                            SettingsRow(
                                toolIcon(tool.id),
                                tool.title,
                                subtitle = tool.subtitle,
                                tint = tint,
                                onClick = { if (tool.id == ModuleIds.QUEUE) openCounter() else tool.route?.let(openRoute) },
                            )
                        }
                    }
                }
            }

            // --- Configuração do atendimento (linhas e menus decidem quem recebe as conversas) ---
            if (AccessRules.allows(access, AccessIds.CONVERSATIONS)) item("setup-label") { SectionLabel("Linhas e menus") }
            if (AccessRules.allows(access, AccessIds.CONVERSATIONS)) item("setup") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    SettingsRow(Icons.Filled.SupportAgent, "Linhas de atendimento", subtitle = "Quem atende cada número e quando os menus aparecem", onClick = openLines)
                    if (isAdmin) {
                        RowDivider()
                        SettingsRow(Icons.Filled.AccountTree, "Menus e submenus", subtitle = "Opções, destinos e linhas permitidas", tint = c.ticket, onClick = openMenus)
                        RowDivider()
                        SettingsRow(Icons.Filled.SmartToy, "Linhas dos bots", subtitle = "Em quais linhas cada bot pode atender", tint = c.bot, onClick = openBotLines)
                    }
                }
            }
        }
    }
}

/** Disponível/ausente: decide se novos atendimentos e transferências chegam a esta pessoa. */
@Composable
private fun PresenceCard(presence: PresenceViewModel, modifier: Modifier = Modifier) {
    val c = Wb.colors
    val online = presence.present == true
    WbCard(modifier) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    ServiceTexts.presenceTitle(presence.present),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (online) c.ok else c.textPrimary,
                )
                Text(ServiceTexts.presenceSubtitle(online), style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            }
            Spacer(Modifier.width(8.dp))
            BusySwitch(
                checked = online,
                busy = presence.busy,
                enabled = presence.present != null,
                onChange = { presence.set(it) },
                description = if (online) "Ficar offline" else "Ficar online",
                checkedColor = c.ok,
            )
        }
    }
}

@Composable
private fun CountPill(count: Int?, color: Color, filled: Boolean = false) {
    if (count == null) return
    Pill(if (count > 99) "99+" else count.toString(), if (count == 0) Wb.colors.muted else color, filled = filled && count > 0)
}

/** Uma ferramenta da seção "Fila e módulos"; [route] nulo é o guichê, que tem rota própria. */
data class ServiceTool(val id: String, val title: String, val subtitle: String, val route: String?)

private fun toolIcon(id: String): ImageVector = when (id) {
    ModuleIds.QUEUE -> Icons.Filled.Tag
    ModuleIds.AGENDA -> Icons.Filled.CalendarMonth
    ModuleIds.SERVICE_ORDERS -> Icons.Filled.Build
    ModuleIds.RESERVA -> Icons.Filled.Hotel
    ModuleIds.MENSALIDADE -> Icons.Filled.Payments
    else -> Icons.Filled.RestaurantMenu
}

/** Textos e regras da aba, sem Compose, para testar. */
object ServiceTexts {
    fun presenceTitle(present: Boolean?) = when (present) {
        true -> "Você está online"
        false -> "Você está offline"
        null -> "Consultando presença…"
    }

    fun presenceSubtitle(online: Boolean) =
        if (online) "Você recebe novos atendimentos e transferências." else "Novos atendimentos e transferências não são encaminhados a você."

    /** "3 recebidos · 2 em análise · 1 aguardando", só com o que não é zero; vazio quando nada está ativo. */
    fun activeSummary(counts: Map<TicketFilter, Int>): String {
        val parts = listOf(
            TicketFilter.Open to ("recebido" to "recebidos"),
            TicketFilter.InProgress to ("em análise" to "em análise"),
            TicketFilter.Waiting to ("aguardando" to "aguardando"),
        ).mapNotNull { (f, words) ->
            val n = counts[f] ?: 0
            if (n == 0) null else "$n ${if (n == 1) words.first else words.second}"
        }
        return when {
            counts.isEmpty() -> "Recebidos, em análise e aguardando"
            parts.isEmpty() -> "Nenhum protocolo ativo agora"
            else -> parts.joinToString(" · ")
        }
    }

    /** Guichê e telas dos módulos, na ordem da aba, só os ligados no perfil. */
    fun tools(modules: Set<String>): List<ServiceTool> = listOfNotNull(
        ServiceTool(ModuleIds.QUEUE, "Guichê da fila de senhas", "Chamar a próxima senha, rechamar, concluir e transferir", null)
            .takeIf { ModuleIds.QUEUE in modules },
        ServiceTool(ModuleIds.AGENDA, "Agenda", "Agendamentos do dia e da semana por profissional", ModuleRoutes.AGENDA)
            .takeIf { ModuleIds.AGENDA in modules },
        ServiceTool(ModuleIds.SERVICE_ORDERS, "Ordens de serviço", "Recebidas, orçamentos, execução e entrega", ModuleRoutes.SERVICE_ORDERS)
            .takeIf { ModuleIds.SERVICE_ORDERS in modules },
        ServiceTool(ModuleIds.RESERVA, "Reservas", "Ocupação das unidades, sinal e check-in", ModuleRoutes.RESERVA)
            .takeIf { ModuleIds.RESERVA in modules },
        ServiceTool(ModuleIds.MENSALIDADE, "Mensalidades", "Parcelas do mês, assinaturas e inadimplentes", ModuleRoutes.MENSALIDADE)
            .takeIf { ModuleIds.MENSALIDADE in modules },
        ServiceTool(ModuleIds.PEDIDO, "Pedidos", "Quadro da cozinha, comanda, pausa da loja e esgotados", ModuleRoutes.PEDIDO)
            .takeIf { ModuleIds.PEDIDO in modules },
    )
}
