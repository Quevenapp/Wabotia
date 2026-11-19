package br.com.queven.wabotia.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.core.model.Channels
import br.com.queven.wabotia.ui.theme.Wb

/** Selo separado do estado; desconhecido nunca recebe a marca do WhatsApp. */
@Composable
fun ChannelBadge(channel: String?, modifier: Modifier = Modifier, size: Dp = 22.dp, ringColor: Color = Wb.colors.background) {
    val label = Channels.label(channel)
    val mark = when (channel) {
        "whatsapp" -> "W"
        "instagram" -> "I"
        "facebook" -> "f"
        else -> "?"
    }
    val color = when (channel) {
        "whatsapp" -> Color(0xFF00866A)
        "instagram" -> Color(0xFFAE327F)
        "facebook" -> Color(0xFF1664C0)
        else -> Wb.colors.muted
    }
    Box(modifier.size(size).background(color, CircleShape).border(2.dp, ringColor, CircleShape).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Text(mark, color = Color.White, fontSize = (size.value * 0.56f).sp, fontWeight = FontWeight.Bold)
    }
}
