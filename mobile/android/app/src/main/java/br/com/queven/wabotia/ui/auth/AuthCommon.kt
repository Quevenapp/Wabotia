package br.com.queven.wabotia.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.ui.components.BrandMark
import br.com.queven.wabotia.ui.theme.Wb

// Estilo comum das telas iniciais (Servidor → Login → Perfil): marca no topo, cartão com o campo, botão principal
// `brand` em largura total e textos de ajuda curtos (DESIGN.md, seção 3).

internal val AuthFieldShape = RoundedCornerShape(14.dp)

@Composable
internal fun authFieldColors(): TextFieldColors {
    val c = Wb.colors
    return OutlinedTextFieldDefaults.colors(
        focusedBorderColor = c.brand,
        focusedLabelColor = c.brand,
        cursorColor = c.brand,
        unfocusedBorderColor = c.muted.copy(alpha = 0.5f),
        unfocusedLabelColor = c.textSecondary,
        focusedContainerColor = c.background,
        unfocusedContainerColor = c.background,
        disabledContainerColor = c.background,
        errorContainerColor = c.background,
        errorBorderColor = c.danger,
        errorLabelColor = c.danger,
    )
}

/** Coluna rolável e centralizada com a marca, o título e o subtítulo; nada é cortado em telas pequenas ou com o teclado aberto. */
@Composable
internal fun AuthScaffold(
    title: String,
    subtitle: String,
    markSize: Dp = 88.dp,
    topSpace: Dp = 48.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Wb.colors
    Column(
        Modifier
            .fillMaxSize()
            .background(c.background)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(topSpace))
        BrandMark(size = markSize)
        Spacer(Modifier.height(18.dp))
        Text(title, color = c.brand, fontSize = 28.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))
        Column(Modifier.fillMaxWidth().widthIn(max = 480.dp), horizontalAlignment = Alignment.CenterHorizontally, content = content)
        Spacer(Modifier.height(32.dp))
    }
}

/** Texto de ajuda curto abaixo do botão. */
@Composable
internal fun AuthHelp(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary, textAlign = TextAlign.Center, modifier = modifier.fillMaxWidth())
}
