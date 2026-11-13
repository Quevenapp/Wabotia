package br.com.queven.wabotia.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.ui.theme.Wb

// Peças das bolhas de conversa, compartilhadas pela conversa do WhatsApp, pelo chat interno e pelo chat com bot.

/** Largura reservada ao "rabinho" do lado de fora da bolha. */
val TailWidth = 8.dp
private val BubbleRadius = 12.dp

/**
 * Fundo da bolha: retângulo de cantos 12 com o "rabinho" no canto superior externo da primeira bolha de cada grupo.
 * O rabinho ocupa [TailWidth] do lado de fora; as demais bolhas do grupo reservam o mesmo espaço para ficarem alinhadas.
 */
fun Modifier.bubbleBackground(color: Color, outgoing: Boolean, tail: Boolean, highlight: Color? = null): Modifier = drawBehind {
    val t = TailWidth.toPx()
    val r = BubbleRadius.toPx()
    val w = size.width
    val h = size.height
    val path = Path()
    if (outgoing) {
        val right = w - t
        if (tail) {
            path.moveTo(r, 0f)
            path.lineTo(w - 1.5f, 0f)
            path.quadraticBezierTo(w + 0.5f, 0.5f, w - 1.5f, 3f)
            path.lineTo(right, t + 2f)
            path.lineTo(right, h - r)
            path.arcTo(Rect(right - 2 * r, h - 2 * r, right, h), 0f, 90f, false)
            path.lineTo(r, h)
            path.arcTo(Rect(0f, h - 2 * r, 2 * r, h), 90f, 90f, false)
            path.lineTo(0f, r)
            path.arcTo(Rect(0f, 0f, 2 * r, 2 * r), 180f, 90f, false)
            path.close()
        } else {
            path.addRoundRect(RoundRect(0f, 0f, right, h, CornerRadius(r, r)))
        }
    } else {
        if (tail) {
            path.moveTo(w - r, 0f)
            path.lineTo(1.5f, 0f)
            path.quadraticBezierTo(-0.5f, 0.5f, 1.5f, 3f)
            path.lineTo(t, t + 2f)
            path.lineTo(t, h - r)
            path.arcTo(Rect(t, h - 2 * r, t + 2 * r, h), 180f, -90f, false)
            path.lineTo(w - r, h)
            path.arcTo(Rect(w - 2 * r, h - 2 * r, w, h), 90f, -90f, false)
            path.lineTo(w, r)
            path.arcTo(Rect(w - 2 * r, 0f, w, 2 * r), 0f, -90f, false)
            path.close()
        } else {
            path.addRoundRect(RoundRect(t, 0f, w, h, CornerRadius(r, r)))
        }
    }
    // Sombra discreta, como no WhatsApp (a forma com rabinho não é convexa, então a elevação nativa não serve).
    translate(top = 1.dp.toPx()) { drawPath(path, Color.Black.copy(alpha = 0.13f)) }
    drawPath(path, color)
    if (highlight != null) drawPath(path, highlight)
}

/**
 * Texto da bolha (16sp) com o horário dentro dela, no canto inferior direito: quando cabe, o horário fica na mesma linha
 * do fim do texto; quando não cabe, desce para uma linha própria (como no WhatsApp).
 */
@Composable
fun BubbleText(text: String, time: String, modifier: Modifier = Modifier, color: Color = Wb.colors.textPrimary, timeColor: Color = Wb.colors.textSecondary) {
    // Largura reservada ao horário: ~6,2sp por caractere em 11sp, mais um respiro.
    val reserve = (time.length * 6.2f + 8f)
    val inline = remember(reserve) { mapOf("meta" to InlineTextContent(Placeholder(reserve.sp, 15.sp, PlaceholderVerticalAlign.TextBottom)) {}) }
    Box(modifier.fillMaxWidth()) {
        Text(
            buildAnnotatedString {
                append(text)
                append(" ")
                appendInlineContent("meta", " ")
            },
            inlineContent = inline,
            color = color,
            fontSize = 16.sp,
            lineHeight = 21.sp,
        )
        Text(time, color = timeColor, fontSize = 11.sp, lineHeight = 14.sp, maxLines = 1, modifier = Modifier.align(Alignment.BottomEnd))
    }
}