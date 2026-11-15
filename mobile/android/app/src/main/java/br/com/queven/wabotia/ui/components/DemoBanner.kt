package br.com.queven.wabotia.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.ui.theme.Wb

/**
 * Faixa fixa no topo enquanto a demonstração está aberta (em todas as telas depois da entrada): avisa que os dados são
 * fictícios e oferece a volta à tela Servidor, com uma confirmação curta. Ocupa também a área da barra de status.
 */
@Composable
fun DemoBanner(onExit: () -> Unit, modifier: Modifier = Modifier) {
    val c = Wb.colors
    var confirm by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().background(c.soft(c.warn, 0.18f))) {
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.statusBars)
                .heightIn(min = 48.dp)
                .padding(start = 16.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Info, contentDescription = null, tint = c.warn, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                Text("Demonstração", color = c.textPrimary, style = MaterialTheme.typography.labelLarge, maxLines = 1)
                Text(
                    "Dados fictícios · nada é enviado",
                    color = c.textSecondary,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(onClick = { confirm = true }, modifier = Modifier.semantics { contentDescription = "Sair da demonstração" }) {
                Text("Sair", color = c.brand, fontWeight = FontWeight.SemiBold)
            }
        }
        HorizontalDivider(color = c.hairline)
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Sair da demonstração?") },
            text = { Text("Você volta para a tela inicial para informar o servidor da sua empresa. Os dados de exemplo recomeçam na próxima vez.") },
            confirmButton = {
                TextButton(onClick = { confirm = false; onExit() }) { Text("Sair", color = c.danger, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Continuar explorando") } },
        )
    }
}
