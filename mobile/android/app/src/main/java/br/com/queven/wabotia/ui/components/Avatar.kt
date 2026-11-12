package br.com.queven.wabotia.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.HourglassBottom
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.ui.theme.Wb
import kotlin.math.absoluteValue

enum class AvatarKind { Person, Group, Bot }

/** Selo de estado da conversa no canto do avatar (DESIGN.md, seção 1). */
enum class StateBadge { Waiting, Bot, Mine, Other, Closed }

/** Paleta fixa de 8 cores; a cor de cada avatar é derivada do id. */
private val avatarPalette = listOf(
    Color(0xFF00A884), Color(0xFF5B8DEF), Color(0xFFE26D5C), Color(0xFFE59A2F),
    Color(0xFF9B6BDF), Color(0xFF2BA6B8), Color(0xFFD8619B), Color(0xFF6E8F3D),
)

fun avatarColor(seed: String): Color = avatarPalette[(seed.hashCode().absoluteValue) % avatarPalette.size]

fun conversationBadge(c: Conversation, meId: String?): StateBadge = when (c.state) {
    "waiting" -> StateBadge.Waiting
    "ai" -> StateBadge.Bot
    "human" -> if (c.owner != null && c.owner == meId) StateBadge.Mine else StateBadge.Other
    else -> StateBadge.Closed
}

/**
 * Avatar circular com iniciais (até 2) e cor derivada de [seed]. Grupo usa ícone de pessoas; bot usa robô sobre `bot`.
 * [badge] desenha o selo de estado da conversa; [online] desenha o ponto de presença (pessoas e bots da equipe).
 * [ringColor] é a cor do contorno do selo: passe a cor do fundo onde o avatar está.
 */
@Composable
fun Avatar(
    name: String,
    modifier: Modifier = Modifier,
    seed: String = name,
    size: Dp = 48.dp,
    kind: AvatarKind = AvatarKind.Person,
    badge: StateBadge? = null,
    online: Boolean? = null,
    ringColor: Color = Wb.colors.background,
) {
    val c = Wb.colors
    Box(modifier.size(size)) {
        Box(
            Modifier
                .size(size)
                .clip(CircleShape)
                .background(if (kind == AvatarKind.Bot) c.bot else avatarColor(seed)),
            contentAlignment = Alignment.Center,
        ) {
            when (kind) {
                AvatarKind.Group -> Icon(Icons.Filled.Groups, contentDescription = "Grupo", tint = Color.White, modifier = Modifier.size(size * 0.54f))
                AvatarKind.Bot -> Icon(Icons.Filled.SmartToy, contentDescription = "Bot", tint = Color.White, modifier = Modifier.size(size * 0.54f))
                AvatarKind.Person -> Text(
                    initialsOf(name),
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = (size.value * 0.38f).sp,
                    maxLines = 1,
                )
            }
        }
        if (badge != null) {
            val (icon: ImageVector, color: Color, label: String) = when (badge) {
                StateBadge.Waiting -> Triple(Icons.Filled.HourglassBottom, c.warn, "Na fila")
                StateBadge.Bot -> Triple(Icons.Filled.SmartToy, c.bot, "Com o bot")
                StateBadge.Mine -> Triple(Icons.Filled.Person, c.brand, "Com você")
                StateBadge.Other -> Triple(Icons.Filled.Person, c.muted, "Com outra pessoa")
                StateBadge.Closed -> Triple(Icons.Filled.Check, c.muted, "Concluída")
            }
            val badgeSize = (size.value * 0.4f).coerceIn(16f, 30f).dp
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 2.dp, y = 2.dp)
                    .size(badgeSize)
                    .background(ringColor, CircleShape)
                    .border(2.dp, ringColor, CircleShape)
                    .clip(CircleShape)
                    .semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(badgeSize - 4.dp).background(color, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(badgeSize * 0.5f))
                }
            }
        } else if (online != null) {
            val dot = (size.value * 0.3f).coerceIn(12f, 22f).dp
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 1.dp, y = 1.dp)
                    .size(dot)
                    .background(ringColor, CircleShape)
                    .semantics { contentDescription = if (online) "Online" else "Offline" },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(dot - 4.dp).background(if (online) c.ok else c.muted, CircleShape))
            }
        }
    }
}

/** Ponto de presença avulso (verde `ok` Online, cinza `muted` Offline). */
@Composable
fun PresenceDot(online: Boolean, modifier: Modifier = Modifier, size: Dp = 10.dp) {
    Box(
        modifier
            .size(size)
            .background(if (online) Wb.colors.ok else Wb.colors.muted, CircleShape)
            .semantics { contentDescription = if (online) "Online" else "Offline" },
    )
}
