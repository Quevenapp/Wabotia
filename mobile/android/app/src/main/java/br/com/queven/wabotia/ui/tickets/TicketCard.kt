package br.com.queven.wabotia.ui.tickets

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.PriorityHigh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.core.model.Ticket
import br.com.queven.wabotia.core.model.TicketCategory
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.ProgressRing
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb

/**
 * Cartão de protocolo (DESIGN.md, seção 8): número `WA-…` em `ticket` monoespaçado, título em duas linhas, pílula de
 * estado, responsável e prazo com o anel do relógio. [compact] tira a linha do responsável e aperta o espaçamento
 * (Dados da conversa e folha de transferência). [onOpenConversation] acrescenta o atalho para a conversa.
 */
@Composable
fun TicketCard(
    ticket: Ticket,
    ownerName: String?,
    now: Long,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    onOpenConversation: (() -> Unit)? = null,
    /** Nome da categoria (aplicativo ou assunto) já resolvido; null quando o protocolo não tem categoria. */
    categoryName: String? = null,
) {
    val c = Wb.colors
    WbCard(modifier = modifier, onClick = onClick) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = if (onOpenConversation != null) 6.dp else 16.dp, top = if (compact) 12.dp else 14.dp, bottom = if (compact) 12.dp else 10.dp)) {
            Row(Modifier.fillMaxWidth().padding(end = if (onOpenConversation != null) 10.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    ticket.number.ifBlank { "Protocolo" },
                    color = c.ticket,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 13.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Pill(ticketStatusLabel(ticket.status), ticketStatusColor(ticket.status))
            }
            Spacer(Modifier.height(6.dp))
            Text(
                ticket.title.ifBlank { "Sem título" },
                color = c.textPrimary,
                fontSize = 16.sp,
                lineHeight = 21.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = if (onOpenConversation != null) 10.dp else 0.dp),
            )
            if (!categoryName.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                CategoryTag(categoryName, Modifier.padding(end = if (onOpenConversation != null) 10.dp else 0.dp))
            }
            Spacer(Modifier.height(if (compact) 8.dp else 6.dp))
            Row(Modifier.fillMaxWidth().heightIn(min = if (onOpenConversation != null) 48.dp else 24.dp), verticalAlignment = Alignment.CenterVertically) {
                if (!compact) {
                    if (ticket.owner != null && !ownerName.isNullOrBlank()) {
                        Avatar(ownerName, seed = ticket.owner, size = 24.dp, ringColor = c.surface)
                        Spacer(Modifier.width(8.dp))
                        Text(ownerName, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    } else {
                        Text("Sem responsável", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    }
                    Spacer(Modifier.width(8.dp))
                    DueIndicator(ticket, now)
                } else {
                    DueIndicator(ticket, now, Modifier.weight(1f))
                }
                if (onOpenConversation != null) {
                    IconButton(onClick = onOpenConversation) {
                        Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = "Abrir conversa do protocolo ${ticket.number}", tint = c.brand, modifier = Modifier.size(22.dp))
                    }
                }
            }
        }
    }
}

/** Categoria do protocolo (aplicativo ou assunto): ícone + nome em texto secundário, sem competir com a pílula de estado. */
@Composable
fun CategoryTag(name: String, modifier: Modifier = Modifier) {
    val c = Wb.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Category, contentDescription = "Categoria", tint = c.textSecondary, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(5.dp))
        Text(name, color = c.textSecondary, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Escolha da categoria ao abrir um protocolo: chips em linha rolável, "Sem categoria" primeiro. Só as habilitadas
 * são oferecidas. [selected] nulo = sem categoria.
 */
@Composable
fun CategoryChips(categories: List<TicketCategory>, selected: String?, onSelect: (String?) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Wb.colors
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WbFilterChip("Sem categoria", selected = selected == null, onClick = { if (enabled) onSelect(null) }, tone = if (selected == null) c.ticket else null)
        categories.filter { it.enabled }.forEach { category ->
            val isSelected = selected == category.id
            WbFilterChip(category.name, selected = isSelected, onClick = { if (enabled) onSelect(category.id) }, tone = if (isSelected) c.ticket else null)
        }
    }
}

/** Prazo com o mesmo anel do relógio: vermelho atrasado, laranja abaixo de 1 h, check quando respondido. */
@Composable
internal fun DueIndicator(ticket: Ticket, now: Long, modifier: Modifier = Modifier, ringSize: Dp = 20.dp) {
    val tone = ticket.dueTone(now)
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        DueRing(ticket, now, ringSize)
        Spacer(Modifier.width(6.dp))
        Text(
            ticket.dueLabel(now),
            color = tone.textColor(),
            fontSize = 12.5.sp,
            fontWeight = if (tone == DueTone.Overdue || tone == DueTone.Soon) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
internal fun DueRing(ticket: Ticket, now: Long, size: Dp = 20.dp) {
    val tone = ticket.dueTone(now)
    val color = tone.color()
    when (tone) {
        DueTone.Responded -> Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = color, modifier = Modifier.size(size))
        DueTone.Closed -> ProgressRing(fraction = 0f, color = color, size = size, strokeWidth = size / 9, icon = Icons.Filled.Check)
        DueTone.None -> ProgressRing(fraction = 0f, color = color, size = size, strokeWidth = size / 9, icon = Icons.Filled.Schedule)
        DueTone.Overdue -> ProgressRing(fraction = 0f, color = color, size = size, strokeWidth = size / 9, icon = Icons.Filled.PriorityHigh)
        DueTone.Soon, DueTone.Scheduled -> ProgressRing(fraction = ticket.dueFraction(now), color = color, size = size, strokeWidth = size / 9, icon = Icons.Filled.Schedule)
    }
}
