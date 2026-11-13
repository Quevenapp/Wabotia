package br.com.queven.wabotia.ui.service

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.theme.Wb

// Peças das telas de configuração do atendimento (linhas, menus, linhas dos bots).

/** Linha de escolha: rótulo, valor atual e seta; o toque abre uma folha com as opções. */
@Composable
internal fun ServiceChoice(label: String, value: String, options: List<Pair<String, String>>, enabled: Boolean = true, onChange: (String) -> Unit) {
    val c = Wb.colors
    var open by remember { mutableStateOf(false) }
    val current = options.firstOrNull { it.first == value }?.second ?: "Selecione"
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.DropdownList) { open = true }
            .heightIn(min = 60.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .alpha(if (enabled) 1f else 0.5f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            Text(current, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Icon(Icons.Filled.ExpandMore, contentDescription = null, tint = c.muted)
    }
    if (open) {
        WbBottomSheet(onDismiss = { open = false }, title = label) {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                options.forEach { (id, name) ->
                    val selected = id == value
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.RadioButton) { onChange(id); open = false }
                            .heightIn(min = 52.dp)
                            .padding(horizontal = 20.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            name,
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (selected) c.brand else c.textPrimary,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.weight(1f),
                        )
                        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selecionado", tint = c.brand, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}

/** Linha com interruptor. */
@Composable
internal fun ServiceToggle(label: String, checked: Boolean, subtitle: String? = null, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val c = Wb.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Switch) { onChange(!checked) }
            .heightIn(min = 56.dp)
            .padding(start = 16.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, color = c.textPrimary)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.size(width = 56.dp, height = 44.dp), contentAlignment = Alignment.Center) {
            Switch(
                checked = checked,
                onCheckedChange = null,
                enabled = enabled,
                colors = SwitchDefaults.colors(checkedTrackColor = c.brand, checkedThumbColor = Color.White, checkedBorderColor = c.brand),
            )
        }
    }
}

/** Ação "Salvar" da barra superior. */
@Composable
internal fun SaveAction(enabled: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick, enabled = enabled) { Text("Salvar", fontWeight = FontWeight.SemiBold) }
}

/** Texto de ajuda abaixo de um cartão. */
@Composable
internal fun ServiceHint(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary, modifier = modifier.padding(horizontal = 20.dp, vertical = 8.dp))
}

/** Nome legível do tipo da linha. `meta` e `zernio` são WhatsApp oficial (janela de 24 h). */
internal fun lineKindLabel(kind: String): String = when (kind) {
    "meta", "zernio" -> "WhatsApp oficial"
    "qr" -> "WhatsApp QR"
    "hermes" -> "Hermes"
    "" -> "Linha"
    else -> kind.replaceFirstChar { it.uppercase() }
}
