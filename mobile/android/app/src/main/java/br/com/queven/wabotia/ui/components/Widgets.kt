@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.wabotia.ui.components

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SheetState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.R
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.ui.theme.Wb

// ---------------------------------------------------------------------------------------------------------------
// Marca
// ---------------------------------------------------------------------------------------------------------------

/** Símbolo do ícone do app (balão com o W) sobre o degradê da marca. Usado em Servidor, Login e Perfil. */
@Composable
fun BrandMark(modifier: Modifier = Modifier, size: Dp = 88.dp) {
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.28f))
            .background(Brush.linearGradient(listOf(Wb.colors.brandGradientStart, Wb.colors.brandGradientEnd))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painterResource(R.drawable.ic_brand_mark),
            contentDescription = "Wabotia",
            tint = Color.Unspecified,
            modifier = Modifier.size(size * 0.66f),
        )
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Barras superiores
// ---------------------------------------------------------------------------------------------------------------

/** Barra das abas principais: título em `brand`, subtítulo opcional (tocável) e ações à direita. */
@Composable
fun TabTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onSubtitleClick: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .background(Wb.colors.background)
            .statusBarsPadding()
            .heightIn(min = 60.dp)
            .padding(start = 16.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier
                .weight(1f)
                .then(if (onSubtitleClick != null) Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onSubtitleClick) else Modifier),
        ) {
            Text(
                title,
                color = Wb.colors.brand,
                fontSize = 23.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                modifier = Modifier.semantics { heading() },
            )
            if (subtitle != null) {
                Text(subtitle, color = Wb.colors.textSecondary, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        actions()
    }
}

/** Barra das telas internas: voltar, título (e subtítulo) e ações. */
@Composable
fun DetailTopBar(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    backEnabled: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Column(modifier.fillMaxWidth().background(Wb.colors.background)) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .heightIn(min = 56.dp)
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, enabled = backEnabled) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar", tint = Wb.colors.textPrimary)
            }
            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleLarge,
                    color = Wb.colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() },
                )
                if (subtitle != null) {
                    Text(subtitle, style = MaterialTheme.typography.labelMedium, color = Wb.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            actions()
        }
        HorizontalDivider(color = Wb.colors.hairline)
    }
}

/** Campo de busca arredondado (lista de conversas, protocolos, folhas). */
@Composable
fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester? = null,
    onSearch: (() -> Unit)? = null,
) {
    val c = Wb.colors
    Row(
        modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(CircleShape)
            .background(c.field)
            .padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Search, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) Text(placeholder, color = c.textSecondary, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.textPrimary),
                cursorBrush = SolidColor(c.brand),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSearch?.invoke() }),
                modifier = Modifier.fillMaxWidth().then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
            )
        }
        if (value.isNotEmpty()) {
            IconButton(onClick = { onValueChange("") }, modifier = Modifier.size(40.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "Limpar busca", tint = c.textSecondary, modifier = Modifier.size(18.dp))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Chips, pílulas e contadores
// ---------------------------------------------------------------------------------------------------------------

/** Linha rolável de chips de filtro. */
@Composable
fun FilterRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * Chip de filtro com contador. Selecionado: fundo `brand` suave e texto `brand`. [tone] troca a cor de destaque
 * (ex.: `warn` no chip Fila quando há fila, `danger` em Atrasados).
 */
@Composable
fun WbFilterChip(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, count: Int? = null, tone: Color? = null) {
    val c = Wb.colors
    val accent = tone ?: c.brand
    val background = if (selected) c.soft(accent, 0.16f) else c.field
    val content = if (selected || tone != null) accent else c.textSecondary
    Row(
        modifier
            .height(34.dp)
            .clip(CircleShape)
            .background(background)
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = content, fontSize = 14.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1)
        if (count != null && count > 0) {
            Spacer(Modifier.width(6.dp))
            Text(if (count > 999) "999+" else count.toString(), color = content, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        }
    }
}

/** Pílula pequena de estado/etiqueta: texto na cor [color] sobre a mesma cor suave. */
@Composable
fun Pill(text: String, color: Color, modifier: Modifier = Modifier, icon: ImageVector? = null, filled: Boolean = false) {
    val c = Wb.colors
    Row(
        modifier
            .clip(CircleShape)
            .background(if (filled) color else c.soft(color, 0.15f))
            .padding(horizontal = 8.dp, vertical = 2.5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = if (filled) Color.White else color, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(text, color = if (filled) Color.White else color, fontSize = 11.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Contador em bolinha (não lidas, abas). */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier, color: Color = Wb.colors.accent, contentColor: Color = Wb.colors.onAccent) {
    if (count <= 0) return
    Box(
        modifier
            .defaultMinSize(minWidth = 20.dp, minHeight = 20.dp)
            .clip(CircleShape)
            .background(color)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (count > 99) "99+" else count.toString(), color = contentColor, fontSize = 11.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

/** Seletor segmentado (Equipe: Conversas · Pessoas · Bots · Setores; estado do protocolo; aparência). */
@Composable
fun <T> SegmentedTabs(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier, accent: Color = Wb.colors.brand) {
    val c = Wb.colors
    Row(
        modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(CircleShape)
            .background(c.field)
            .padding(3.dp),
    ) {
        options.forEach { (value, label) ->
            val isSelected = value == selected
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .clip(CircleShape)
                    .background(if (isSelected) c.background else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    color = if (isSelected) accent else c.textSecondary,
                    fontSize = 13.5.sp,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Cartões e linhas
// ---------------------------------------------------------------------------------------------------------------

/** Cartão padrão: `surface`, cantos 16, sem sombra. */
@Composable
fun WbCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, color: Color = Wb.colors.surface, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(color)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        content = content,
    )
}

/** Rótulo de grupo acima de um cartão ("Atendimento", "Notificações"). */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = Wb.colors.textSecondary,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 8.dp).semantics { heading() },
    )
}

/** Ícone dentro de um círculo colorido suave (linhas de Ajustes, folhas de ação). */
@Composable
fun IconBubble(icon: ImageVector, tint: Color, modifier: Modifier = Modifier, size: Dp = 40.dp, filled: Boolean = false) {
    Box(
        modifier.size(size).clip(CircleShape).background(if (filled) tint else Wb.colors.soft(tint, 0.15f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = if (filled) Color.White else tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** Linha de lista com ícone, título, subtítulo e complemento à direita (seta por padrão quando é tocável). */
@Composable
fun SettingsRow(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    tint: Color = Wb.colors.brand,
    titleColor: Color = Wb.colors.textPrimary,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier)
            .heightIn(min = 60.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .alpha(if (enabled) 1f else 0.5f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBubble(icon, tint)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = titleColor, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            if (!subtitle.isNullOrBlank()) Text(subtitle, color = Wb.colors.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        } else if (onClick != null) {
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = Wb.colors.muted)
        }
    }
}

/** Divisória de lista recuada até o texto (depois do avatar/ícone). */
@Composable
fun RowDivider(startIndent: Dp = 70.dp) {
    HorizontalDivider(Modifier.padding(start = startIndent), color = Wb.colors.hairline)
}

// ---------------------------------------------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------------------------------------------

/** Botão principal em largura total; mostra progresso no próprio botão enquanto [loading]. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    loading: Boolean = false,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    color: Color = Wb.colors.brand,
    contentColor: Color = Wb.colors.onBrand,
) {
    Button(
        onClick = { if (!loading) onClick() },
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 50.dp),
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = contentColor, disabledContainerColor = Wb.colors.field, disabledContentColor = Wb.colors.muted),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = contentColor)
        } else {
            if (icon != null) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(text, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Botão secundário (contorno) em largura total. */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    loading: Boolean = false,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    color: Color = Wb.colors.brand,
) {
    OutlinedButton(
        onClick = { if (!loading) onClick() },
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 50.dp),
        shape = CircleShape,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (enabled) color.copy(alpha = 0.5f) else Wb.colors.divider),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = color)
        } else {
            if (icon != null) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(text, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Botão redondo com ícone (enviar, gravar áudio). */
@Composable
fun RoundIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    color: Color = Wb.colors.brand,
    contentColor: Color = Color.White,
    enabled: Boolean = true,
) {
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(if (enabled) color else Wb.colors.field)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = contentDescription, tint = if (enabled) contentColor else Wb.colors.muted, modifier = Modifier.size(size * 0.46f))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Estados: vazio, erro, esqueleto, sem conexão
// ---------------------------------------------------------------------------------------------------------------

/** Vazio: ícone grande em círculo `surface`, título e uma linha. */
@Composable
fun EmptyState(icon: ImageVector, title: String, modifier: Modifier = Modifier, subtitle: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 32.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(96.dp).clip(CircleShape).background(Wb.colors.surface), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = Wb.colors.muted, modifier = Modifier.size(44.dp))
        }
        Spacer(Modifier.height(20.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = Wb.colors.textPrimary, textAlign = TextAlign.Center)
        if (subtitle != null) {
            Spacer(Modifier.height(6.dp))
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Wb.colors.textSecondary, textAlign = TextAlign.Center)
        }
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            action()
        }
    }
}

/** Erro de carregamento em tela cheia com "Tentar de novo". */
@Composable
fun ErrorState(message: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    EmptyState(Icons.Filled.ErrorOutline, "Não foi possível carregar", modifier, subtitle = message) {
        PrimaryButton("Tentar de novo", onRetry, Modifier.width(220.dp))
    }
}

/** Aviso em linha (erro do servidor, informação) com ação opcional e fechar. */
@Composable
fun InlineNotice(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Wb.colors.danger,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Wb.colors.soft(color, 0.13f)).padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = if (Wb.colors.isDark) Wb.colors.textPrimary else color, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(vertical = 6.dp))
        if (actionLabel != null && onAction != null) {
            androidx.compose.material3.TextButton(onClick = onAction) { Text(actionLabel, color = color, fontWeight = FontWeight.SemiBold) }
        }
        if (onDismiss != null) {
            IconButton(onClick = onDismiss, modifier = Modifier.size(40.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "Fechar aviso", tint = color, modifier = Modifier.size(18.dp))
            }
        } else {
            Spacer(Modifier.width(8.dp))
        }
    }
}

/** Esqueleto de lista (linhas cinza pulsando) para o primeiro carregamento; nunca tela em branco. */
@Composable
fun SkeletonList(modifier: Modifier = Modifier, rows: Int = 8, avatar: Boolean = true) {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(0.45f, 1f, infiniteRepeatable(tween(800), RepeatMode.Reverse), label = "skeleton-alpha")
    val block = Wb.colors.field
    Column(modifier.fillMaxWidth().alpha(alpha)) {
        repeat(rows) { index ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
                if (avatar) {
                    Box(Modifier.size(50.dp).clip(CircleShape).background(block))
                    Spacer(Modifier.width(14.dp))
                }
                Column(Modifier.weight(1f)) {
                    Box(Modifier.fillMaxWidth(if (index % 2 == 0) 0.55f else 0.4f).height(14.dp).clip(RoundedCornerShape(7.dp)).background(block))
                    Spacer(Modifier.height(10.dp))
                    Box(Modifier.fillMaxWidth(if (index % 3 == 0) 0.9f else 0.75f).height(12.dp).clip(RoundedCornerShape(6.dp)).background(block))
                }
                Spacer(Modifier.width(16.dp))
                Box(Modifier.width(32.dp).height(12.dp).clip(RoundedCornerShape(6.dp)).background(block))
            }
        }
    }
}

/** Faixa fina "Sem conexão · tentando reconectar"; some sozinha quando a consulta de eventos volta a responder. */
@Composable
fun ConnectionStrip(container: AppContainer, modifier: Modifier = Modifier) {
    val online by container.events.online.collectAsState()
    if (online) return
    Row(
        modifier.fillMaxWidth().background(Wb.colors.soft(Wb.colors.warn, 0.2f)).padding(horizontal = 16.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Filled.CloudOff, contentDescription = null, tint = Wb.colors.warn, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(8.dp))
        Text("Sem conexão · tentando reconectar", color = Wb.colors.textPrimary, style = MaterialTheme.typography.labelMedium)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Folhas
// ---------------------------------------------------------------------------------------------------------------

/** Folha inferior padrão: cantos 24 no topo, alça, título opcional e respiro para a barra de navegação. */
@Composable
fun WbBottomSheet(
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    sheetState: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = modifier,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        containerColor = if (Wb.colors.isDark) Wb.colors.surface else Wb.colors.background,
        dragHandle = {
            Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(width = 36.dp, height = 4.dp).clip(CircleShape).background(Wb.colors.muted.copy(alpha = 0.5f)))
        },
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            if (title != null) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleLarge,
                    color = Wb.colors.textPrimary,
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = if (subtitle == null) 12.dp else 2.dp).semantics { heading() },
                )
            }
            if (subtitle != null) {
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Wb.colors.textSecondary, modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 12.dp))
            }
            content()
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** Item de folha de ações: ícone em círculo colorido + rótulo. */
@Composable
fun SheetAction(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = Wb.colors.brand, subtitle: String? = null, enabled: Boolean = true) {
    Row(
        modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 8.dp).alpha(if (enabled) 1f else 0.5f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBubble(icon, tint)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = if (tint == Wb.colors.danger) tint else Wb.colors.textPrimary)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Wb.colors.textSecondary)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Vibração leve
// ---------------------------------------------------------------------------------------------------------------

class Haptics internal constructor(private val view: android.view.View) {
    /** Toque leve: assumir, enviar, início/fim de gravação. */
    fun tick() {
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }

    /** Confirmação: transferência concluída. */
    fun confirm() {
        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }
}

@Composable
fun rememberHaptics(): Haptics {
    val view = LocalView.current
    return remember(view) { Haptics(view) }
}
