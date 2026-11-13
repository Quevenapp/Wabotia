package br.com.queven.wabotia.ui.team

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.IntrinsicSize
import br.com.queven.wabotia.ui.components.RoundIconButton
import br.com.queven.wabotia.ui.components.TailWidth
import br.com.queven.wabotia.ui.components.bubbleBackground
import br.com.queven.wabotia.ui.theme.Wb

// Peças de conversa compartilhadas pelo chat interno (equipe) e pelo chat com bot: barra superior com avatar,
// bolhas, chip de data e campo de mensagem. Sem ticks de WhatsApp nem janela de 24 h.

/** Barra superior de conversa: voltar, avatar, nome e subtítulo. */
@Composable
internal fun ChatTopBar(
    name: String,
    subtitle: String?,
    onBack: () -> Unit,
    avatar: @Composable () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = Wb.colors
    Column(Modifier.fillMaxWidth().background(c.background)) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 60.dp).padding(start = 4.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar", tint = c.textPrimary) }
            avatar()
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    name,
                    style = MaterialTheme.typography.titleMedium,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() },
                )
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, style = MaterialTheme.typography.labelMedium, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            actions()
        }
        HorizontalDivider(color = c.hairline)
    }
}

/** Chip central de data ("Hoje", "Ontem", "12 de novembro") ou de aviso. */
@Composable
internal fun ChatChip(text: String, modifier: Modifier = Modifier) {
    val c = Wb.colors
    Box(modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = c.textSecondary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .shadow(0.5.dp, RoundedCornerShape(8.dp))
                .clip(RoundedCornerShape(8.dp))
                .background(c.bubbleSystem)
                .padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

/**
 * Bolha de conversa: enviada à direita (`bubbleOut`), recebida à esquerda (`bubbleIn`), cantos 12, largura máxima de 80%.
 * [first] marca a primeira bolha do grupo (canto do lado do autor fica reto, como o rabinho).
 */
@Composable
internal fun ChatBubble(outgoing: Boolean, modifier: Modifier = Modifier, first: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val c = Wb.colors
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val max = maxWidth * 0.8f
        // Mesma bolha da conversa do WhatsApp: cantos 12 e rabinho na primeira do grupo.
        Column(
            Modifier
                .align(if (outgoing) Alignment.CenterEnd else Alignment.CenterStart)
                .widthIn(min = 84.dp, max = max)
                .width(IntrinsicSize.Max)
                .bubbleBackground(if (outgoing) c.bubbleOut else c.bubbleIn, outgoing, first)
                .padding(start = if (outgoing) 0.dp else TailWidth, end = if (outgoing) TailWidth else 0.dp)
                .padding(start = 9.dp, end = 9.dp, top = 6.dp, bottom = 5.dp),
            content = content,
        )
    }
}

/** Horário dentro da bolha, no canto inferior direito. */
@Composable
internal fun ColumnScope.BubbleTime(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = Wb.colors.textSecondary,
        maxLines = 1,
        modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
    )
}

/**
 * Campo de mensagem arredondado multilinha com botão redondo `brand` de enviar. Fica sobre o papel de parede e já
 * aplica o respiro da barra de navegação e do teclado. [above] recebe avisos (erro, envio pendente).
 */
@Composable
internal fun ChatComposer(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    onSend: () -> Unit,
    canSend: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    sending: Boolean = false,
    sendDescription: String = "Enviar",
    counter: String? = null,
    counterError: Boolean = false,
    above: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val c = Wb.colors
    Column(modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 8.dp, vertical = 6.dp)) {
        if (above != null) above()
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(
                Modifier
                    .weight(1f)
                    .shadow(0.5.dp, RoundedCornerShape(24.dp))
                    .clip(RoundedCornerShape(24.dp))
                    .background(if (c.isDark) c.field else c.background)
                    .heightIn(min = 48.dp)
                    .padding(horizontal = 18.dp, vertical = 13.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    BasicTextField(
                        value = value,
                        onValueChange = onValueChange,
                        enabled = enabled,
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = if (enabled) c.textPrimary else c.textSecondary),
                        cursorBrush = SolidColor(c.brand),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (counter != null) {
                    Text(
                        counter,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (counterError) c.danger else c.textSecondary,
                        modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    )
                }
            }
            if (sending) {
                Box(Modifier.size(48.dp).clip(CircleShape).background(c.brand), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.onBrand)
                }
            } else {
                RoundIconButton(Icons.AutoMirrored.Filled.Send, sendDescription, onSend, size = 48.dp, color = c.brand, contentColor = c.onBrand, enabled = canSend)
            }
        }
    }
}
