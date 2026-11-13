@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.conversations

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Shortcut
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.SubdirectoryArrowRight
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.model.nameOf
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.AvatarKind
import br.com.queven.wabotia.ui.components.IconBubble
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.rememberHaptics
import br.com.queven.wabotia.ui.components.rememberNow
import br.com.queven.wabotia.ui.theme.Wb
import br.com.queven.wabotia.ui.tickets.CategoryChips
import br.com.queven.wabotia.ui.tickets.TicketCard

internal enum class TransferTab(val label: String, val key: String) {
    People("Pessoas", "people"),
    Bots("Bots", "bots"),
    Sectors("Setores", "sectors"),
    Menu("Menu", "menu"),
    Ticket("Protocolo", "ticket"),
}

/** Item escolhido, aguardando a confirmação curta na própria folha. */
private data class TransferChoice(
    val key: String,
    val question: String,
    val confirm: String,
    val warning: String? = null,
    val run: (onDone: () -> Unit) -> Unit,
)

/**
 * Folha "Encaminhar atendimento" (DESIGN.md §6): um só lugar para tirar a conversa de mim. Abas Pessoas, Bots, Setores,
 * Menu e Protocolo; cada item pede uma confirmação curta na própria folha; erros do servidor aparecem aqui, sem fechá-la.
 */
@Composable
internal fun TransferSheet(
    vm: ConversationViewModel,
    conversation: Conversation,
    initialTab: String?,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
    openTicket: (String) -> Unit,
) {
    val c = Wb.colors
    val haptics = rememberHaptics()
    val now by rememberNow()
    var tab by rememberSaveable { mutableStateOf(TransferTab.entries.firstOrNull { it.key == initialTab } ?: TransferTab.People) }
    var choice by remember { mutableStateOf<TransferChoice?>(null) }
    var query by remember { mutableStateOf("") }
    var ticketTitle by rememberSaveable { mutableStateOf("") }
    var ticketCategory by rememberSaveable { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        vm.sheetError = null
        vm.loadTransferData()
    }

    fun finish() {
        haptics.confirm()
        onDone()
    }

    WbBottomSheet(onDismiss = onDismiss, title = "Encaminhar atendimento") {
        // Cinco abas em largura proporcional ao rótulo, para "Protocolo" caber inteiro em telas estreitas.
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
            TransferTab.entries.forEach { t ->
                val selected = tab == t
                Column(
                    Modifier
                        .weight(t.label.length + 3f)
                        .clip(RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp))
                        .clickable(role = Role.Tab) { tab = t; choice = null; query = ""; vm.sheetError = null },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(Modifier.height(44.dp), contentAlignment = Alignment.Center) {
                        Text(
                            t.label,
                            color = if (selected) c.brand else c.textSecondary,
                            fontSize = 13.5.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                            maxLines = 1,
                            softWrap = false,
                        )
                    }
                    Box(Modifier.fillMaxWidth().padding(horizontal = 6.dp).height(3.dp).clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp)).background(if (selected) c.brand else Color.Transparent))
                }
            }
        }
        HorizontalDivider(color = c.hairline)

        Box(Modifier.fillMaxWidth().fillMaxHeight(0.58f)) {
            when (tab) {
                TransferTab.People -> {
                    val people = vm.team.filter { !it.isBot && it.id != vm.meId }
                        .sortedWith(compareByDescending<TeamContact> { it.online }.thenBy { it.name.lowercase() })
                    val visible = people.filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
                    TransferList(
                        count = people.size,
                        query = query,
                        onQuery = { query = it },
                        searchHint = "Buscar pessoa",
                        emptyText = if (people.isEmpty()) "Nenhuma outra pessoa neste perfil." else "Ninguém encontrado para \"${query.trim()}\".",
                        isEmpty = visible.isEmpty(),
                    ) {
                        items(visible, key = { it.id }) { person ->
                            TransferRow(
                                selected = choice?.key == person.id,
                                leading = { Avatar(person.name, seed = person.id, size = 44.dp, online = person.online, ringColor = sheetColor()) },
                                title = person.name,
                                subtitle = if (person.online) "Online" else "Offline",
                                subtitleColor = if (person.online) c.ok else c.textSecondary,
                                onClick = {
                                    val short = firstName(person.name)
                                    choice = TransferChoice(
                                        key = person.id,
                                        question = "Transferir para $short?",
                                        confirm = "Transferir",
                                        warning = if (!person.online) "$short está offline e pode demorar a responder" else null,
                                    ) { done -> vm.transfer(person.id, short, onDone = done) }
                                },
                            )
                        }
                    }
                }

                TransferTab.Bots -> {
                    val bots = vm.team.filter { it.isBot && it.allowedOn(conversation.connection_id) }
                        .sortedWith(compareByDescending<TeamContact> { it.online }.thenBy { it.name.lowercase() })
                    val visible = bots.filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
                    TransferList(
                        count = bots.size + 1,
                        query = query,
                        onQuery = { query = it },
                        searchHint = "Buscar bot",
                        emptyText = "",
                        isEmpty = false,
                    ) {
                        item("auto") {
                            TransferRow(
                                selected = choice?.key == "auto",
                                leading = { IconBubble(Icons.Filled.AutoAwesome, c.bot, size = 44.dp) },
                                title = "Bot do atendimento automático",
                                subtitle = "Devolve a conversa à IA do perfil",
                                onClick = {
                                    choice = TransferChoice("auto", "Devolver ao bot do atendimento?", "Devolver") { done -> vm.resume(inSheet = true, onDone = done) }
                                },
                            )
                        }
                        items(visible, key = { it.id }) { bot ->
                            TransferRow(
                                selected = choice?.key == bot.id,
                                leading = { Avatar(bot.name, seed = bot.id, size = 44.dp, kind = AvatarKind.Bot, online = bot.online, ringColor = sheetColor()) },
                                title = bot.name,
                                subtitle = if (bot.online) "Disponível" else "Indisponível",
                                subtitleColor = if (bot.online) c.ok else c.textSecondary,
                                onClick = {
                                    choice = TransferChoice(
                                        key = bot.id,
                                        question = "Transferir para o bot ${bot.name}?",
                                        confirm = "Transferir",
                                        warning = if (!bot.online) "O bot ${bot.name} está indisponível e pode não responder" else null,
                                    ) { done -> vm.transfer(bot.id, "o bot ${bot.name}", onDone = done) }
                                },
                            )
                        }
                        if (bots.isEmpty()) {
                            item("no-bots") { EmptyLine("Nenhum outro bot autorizado para esta linha.") }
                        }
                    }
                }

                TransferTab.Sectors -> {
                    val sectors = vm.departments
                    val users = vm.team.filter { !it.isBot }.associateBy { it.id }
                    val visible = sectors.orEmpty().filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
                    if (sectors == null) LoadingBox() else TransferList(
                        count = sectors.size,
                        query = query,
                        onQuery = { query = it },
                        searchHint = "Buscar setor",
                        emptyText = if (sectors.isEmpty()) "Nenhum setor configurado no painel" else "Nenhum setor encontrado para \"${query.trim()}\".",
                        isEmpty = visible.isEmpty(),
                    ) {
                        items(visible, key = { it.id }) { sector ->
                            val online = sector.members.count { users[it]?.online == true }
                            val members = sector.members.size
                            TransferRow(
                                selected = choice?.key == sector.id,
                                leading = { IconBubble(Icons.Filled.Groups, c.brand, size = 44.dp) },
                                title = sector.name,
                                subtitle = "${if (members == 1) "1 membro" else "$members membros"} · $online online",
                                subtitleColor = if (online > 0) c.textSecondary else c.warn,
                                onClick = {
                                    choice = TransferChoice(
                                        key = sector.id,
                                        question = "Transferir para o setor ${sector.name}?",
                                        confirm = "Transferir",
                                        warning = if (online == 0) "Ninguém do setor ${sector.name} está online agora" else null,
                                    ) { done -> vm.transferToDepartment(sector.id, sector.name, onDone = done) }
                                },
                            )
                        }
                    }
                }

                TransferTab.Menu -> {
                    val menus = vm.menus
                    if (menus == null) LoadingBox() else {
                        val submenus = menus.filter { it.string("type") == "submenu" }
                        TransferList(count = submenus.size + 1, query = "", onQuery = {}, searchHint = "", emptyText = "", isEmpty = false) {
                            item("hint") {
                                Text(
                                    "Envia o menu ao cliente. A conversa segue com você até ele escolher.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = c.textSecondary,
                                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                                )
                            }
                            item("main") {
                                TransferRow(
                                    selected = choice?.key == "menu:main",
                                    leading = { IconBubble(Icons.AutoMirrored.Filled.ListAlt, c.brand, size = 44.dp) },
                                    title = "Menu principal",
                                    subtitle = "Todas as opções do atendimento",
                                    onClick = {
                                        choice = TransferChoice("menu:main", "Enviar o menu principal ao cliente?", "Enviar menu") { done -> vm.sendMenu(null, onDone = done) }
                                    },
                                )
                            }
                            items(submenus, key = { "menu:" + (it.string("id") ?: "") }) { menu ->
                                val id = menu.string("id")
                                val label = menu.string("label") ?: "Submenu"
                                TransferRow(
                                    selected = choice?.key == "menu:$id",
                                    leading = { IconBubble(Icons.Filled.SubdirectoryArrowRight, c.ticket, size = 44.dp) },
                                    title = label,
                                    subtitle = "Submenu",
                                    onClick = {
                                        choice = TransferChoice("menu:$id", "Enviar o menu \"$label\" ao cliente?", "Enviar menu") { done -> vm.sendMenu(id, onDone = done) }
                                    },
                                )
                            }
                            if (submenus.isEmpty()) item("no-sub") { EmptyLine("Nenhum submenu disponível nesta linha.") }
                        }
                    }
                }

                TransferTab.Ticket -> {
                    val tickets = vm.tickets
                    LazyColumn(Modifier.fillMaxWidth().fillMaxHeight().imePadding()) {
                        item("new") {
                            Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp)) {
                                Text("Abrir protocolo", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                                Spacer(Modifier.height(8.dp))
                                SheetField(ticketTitle, { if (it.length <= 300) ticketTitle = it }, "Título da solicitação", enabled = !vm.creatingTicket)
                                // Categoria (aplicativo ou assunto), só quando o perfil tem categorias configuradas.
                                val offered = vm.ticketCategories.filter { it.enabled }
                                if (offered.isNotEmpty()) {
                                    Spacer(Modifier.height(10.dp))
                                    Text("Categoria (opcional)", style = MaterialTheme.typography.labelMedium, color = c.textSecondary)
                                    Spacer(Modifier.height(6.dp))
                                    CategoryChips(offered, selected = ticketCategory, onSelect = { ticketCategory = it }, enabled = !vm.creatingTicket)
                                }
                                Spacer(Modifier.height(10.dp))
                                PrimaryButton(
                                    "Abrir protocolo",
                                    onClick = {
                                        vm.createTicket(ticketTitle, ticketCategory) { ticket ->
                                            ticketTitle = ""
                                            ticketCategory = null
                                            haptics.confirm()
                                            vm.notice = "Protocolo ${ticket.number} aberto"
                                        }
                                    },
                                    loading = vm.creatingTicket,
                                    enabled = ticketTitle.isNotBlank(),
                                    icon = Icons.Filled.ConfirmationNumber,
                                    color = c.ticket,
                                    contentColor = if (c.isDark) c.onBrand else Color.White,
                                )
                            }
                        }
                        item("lookup") {
                            TransferRow(
                                selected = choice?.key == "protocols",
                                leading = { IconBubble(Icons.AutoMirrored.Filled.Send, c.ticket, size = 44.dp) },
                                title = "Enviar consulta de protocolos ao cliente",
                                subtitle = "O cliente recebe a situação dos protocolos dele",
                                onClick = {
                                    choice = TransferChoice("protocols", "Enviar a consulta de protocolos ao cliente?", "Enviar") { done -> vm.sendProtocols(onDone = done) }
                                },
                            )
                        }
                        item("title") {
                            Text(
                                "Protocolos desta conversa",
                                style = MaterialTheme.typography.titleSmall,
                                color = c.textSecondary,
                                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
                            )
                        }
                        when {
                            tickets == null -> item("loading") { LoadingBox(Modifier.height(80.dp)) }
                            tickets.isEmpty() -> item("none") { EmptyLine("Esta conversa ainda não tem protocolos.") }
                            else -> items(tickets, key = { "t:" + it.id }) { ticket ->
                                TicketCard(
                                    ticket = ticket,
                                    ownerName = null,
                                    now = now,
                                    onClick = { openTicket(ticket.id) },
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 5.dp),
                                    compact = true,
                                    categoryName = vm.ticketCategories.nameOf(ticket.category),
                                )
                            }
                        }
                        item("end") { Spacer(Modifier.height(12.dp)) }
                    }
                }
            }
        }

        vm.sheetError?.let { message ->
            InlineNotice(message, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), onDismiss = { vm.sheetError = null })
        }

        AnimatedVisibility(visible = choice != null) {
            val current = choice
            if (current != null) {
                Column(Modifier.fillMaxWidth()) {
                    HorizontalDivider(color = c.hairline)
                    if (current.warning != null) {
                        Row(Modifier.fillMaxWidth().background(c.soft(c.warn, 0.14f)).padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.WarningAmber, contentDescription = null, tint = c.warn, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(current.warning, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
                        }
                    }
                    Text(
                        current.question,
                        style = MaterialTheme.typography.titleMedium,
                        color = c.textPrimary,
                        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 16.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { choice = null }, enabled = !vm.busy) { Text("Cancelar", color = c.textSecondary, fontSize = 15.sp) }
                        Spacer(Modifier.width(8.dp))
                        PrimaryButton(
                            current.confirm,
                            onClick = { current.run { finish() } },
                            modifier = Modifier.weight(1f),
                            loading = vm.busy,
                            icon = if (current.key.startsWith("menu") || current.key == "protocols") Icons.AutoMirrored.Filled.Send else Icons.AutoMirrored.Filled.Shortcut,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun sheetColor(): Color = if (Wb.colors.isDark) Wb.colors.surface else Wb.colors.background

@Composable
private fun LoadingBox(modifier: Modifier = Modifier.fillMaxHeight()) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp, color = Wb.colors.brand)
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = Wb.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 24.dp),
    )
}

/** Lista de uma aba, com busca quando passar de 8 itens e texto explicando por que está vazia. */
@Composable
private fun TransferList(
    count: Int,
    query: String,
    onQuery: (String) -> Unit,
    searchHint: String,
    emptyText: String,
    isEmpty: Boolean,
    content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit,
) {
    Column(Modifier.fillMaxWidth().fillMaxHeight()) {
        if (count > 8) {
            SearchField(query, onQuery, searchHint, Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        }
        if (isEmpty) {
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) { EmptyLine(emptyText) }
        } else {
            LazyColumn(Modifier.fillMaxWidth().weight(1f), content = content)
        }
    }
}

@Composable
private fun TransferRow(
    selected: Boolean,
    leading: @Composable () -> Unit,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    subtitleColor: Color = Wb.colors.textSecondary,
) {
    val c = Wb.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (selected) c.soft(c.brand, 0.14f) else Color.Transparent)
            .clickable(onClick = onClick)
            .heightIn(min = 62.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = subtitleColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
