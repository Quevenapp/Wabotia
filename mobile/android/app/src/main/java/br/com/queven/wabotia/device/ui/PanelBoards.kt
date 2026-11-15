package br.com.queven.wabotia.device.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import br.com.queven.wabotia.device.core.CampaignCache
import br.com.queven.wabotia.device.core.CampaignRules
import br.com.queven.wabotia.device.core.CampaignShown
import br.com.queven.wabotia.device.core.OrderBoard
import br.com.queven.wabotia.device.core.PanelCalls
import br.com.queven.wabotia.device.core.PanelClock
import br.com.queven.wabotia.device.core.PanelDestination
import br.com.queven.wabotia.device.core.PanelQueueLetter
import br.com.queven.wabotia.device.core.PanelTemplate
import br.com.queven.wabotia.device.core.StationCall
import br.com.queven.wabotia.device.core.StationOption
import br.com.queven.wabotia.device.core.StationRuntime
import br.com.queven.wabotia.device.core.Tracking
import br.com.queven.wabotia.device.core.Campaign
import br.com.queven.wabotia.device.ui.LocalPanelStyle
import br.com.queven.wabotia.device.ui.PanelStyle
import br.com.queven.wabotia.device.ui.PanelStyles
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/*
 * Os quadros dos painéis redesenhados (decisão 17). Cada quadro ocupa a área
 * que recebe e mede tudo por ela: o número cresce até o limite da própria
 * caixa e nada rola. As proporções vêm do protótipo
 * `Vinki_v3/docs/design/telas-v2-2026-10-31/index.html`.
 */

/** O tamanho de texto de base da tela: 2,3 % do menor lado, entre 11 e 30 dp. */
internal val LocalPanelBase = staticCompositionLocalOf { 14.dp }

@Composable
private fun Dp.sp(): TextUnit = with(LocalDensity.current) { this@sp.toSp() }

private fun PanelStyle.label(text: String) = if (upperLabels) text.uppercase() else text

private fun PanelStyle.name(text: String) = if (upperNames) text.uppercase() else text

/** Cartão do template: sombra dura (Vitrine), fundo, borda e raio. */
internal fun Modifier.panelCard(s: PanelStyle, fill: Color = s.surface, radius: Dp = s.radiusSmall, line: Color = s.line): Modifier {
    val shape = RoundedCornerShape(radius)
    val shadow =
        if (s.hardShadow) {
            Modifier.drawBehind {
                val o = 4.dp.toPx()
                drawRoundRect(color = s.line, topLeft = Offset(o, o), size = size, cornerRadius = CornerRadius(radius.toPx()))
            }
        } else {
            Modifier
        }
    val border = if (s.border > 0.dp) Modifier.border(s.border, line, shape) else Modifier
    return this.then(shadow).clip(shape).background(fill).then(border)
}

/** A hora do aparelho, "HH:mm", relida a cada 20 s. */
@Composable
internal fun rememberPanelClock(): String {
    val format = remember { DateTimeFormatter.ofPattern("HH:mm") }
    var now by remember { mutableStateOf(LocalTime.now().format(format)) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(20_000)
            now = LocalTime.now().format(format)
        }
    }
    return now
}

/**
 * A cor da fila vem só da letra: a mesma fila tem a mesma cor no totem, no
 * painel e no híbrido, mesmo quando o painel não recebe a lista de filas.
 */
@Suppress("UNUSED_PARAMETER")
internal fun queueIndex(letter: Char?, options: List<StationOption> = emptyList()): Int = PanelQueueLetter.colorIndex(letter)

/** A letra da fila no quadrado (ou círculo, na Clínica) da cor dela: letra e cor juntas, nunca só cor. */
@Composable
internal fun QueueChip(letter: Char?, index: Int, size: Dp) {
    val s = LocalPanelStyle.current
    val shape = if (s.roundChips) CircleShape else RoundedCornerShape(s.radiusSmall)
    Box(
        Modifier.size(size).clip(shape).background(if (letter == null) s.accent else s.queueColor(index)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            (letter ?: '#').toString(),
            fontFamily = s.display,
            fontWeight = s.displayWeight,
            fontStyle = if (s.template == PanelTemplate.SINAL || s.template == PanelTemplate.SOL) FontStyle.Italic else FontStyle.Normal,
            fontSize = (size * 0.62f).sp(),
            lineHeight = (size * 0.62f).sp(),
            color = if (letter == null) s.accentFg else s.chipFg,
        )
    }
}

/* ---------------- cabeçalho ---------------- */

/**
 * O Ponto no alto: nome, unidade ou papel do aparelho, o que a tela é, a hora
 * e os estados (impressora, conexão, som, engrenagem) em [trailing].
 */
@Composable
internal fun PanelHeaderBar(
    name: String,
    role: String,
    title: String,
    onBack: (() -> Unit)?,
    compact: Boolean,
    trailing: @Composable RowScope.() -> Unit,
) {
    val s = LocalPanelStyle.current
    val base = LocalPanelBase.current
    CompositionLocalProvider(LocalContentColor provides s.headerFg) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(s.headerBg)
                .drawBehind {
                    val w = s.headerLineWidth.toPx()
                    if (w > 0f) drawRect(s.headerLine, topLeft = Offset(0f, size.height - w), size = size.copy(height = w))
                }
                .padding(start = 4.dp, end = 12.dp, top = 4.dp, bottom = 4.dp + s.headerLineWidth)
                .testTag("panel.header"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (onBack != null) {
                IconButton(onClick = onBack, modifier = Modifier.testTag("panelTotem.back")) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Voltar")
                }
            } else {
                Spacer(Modifier.width(8.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    s.name(name),
                    fontFamily = s.display,
                    fontWeight = s.displayWeight,
                    fontSize = (base * 1.3f).sp(),
                    lineHeight = (base * 1.45f).sp(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    role,
                    fontFamily = s.text,
                    fontSize = (base * 0.78f).sp(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.alpha(0.75f),
                )
            }
            if (!compact) {
                Text(
                    s.label(title),
                    fontFamily = s.text,
                    fontWeight = s.boldWeight,
                    fontSize = (base * 0.8f).sp(),
                    letterSpacing = s.labelTracking.em,
                    maxLines = 1,
                    modifier = Modifier.alpha(0.8f),
                )
            }
            Text(
                rememberPanelClock(),
                fontFamily = s.display,
                fontWeight = s.displayWeight,
                fontSize = (base * 1.55f).sp(),
                lineHeight = (base * 1.6f).sp(),
                modifier = Modifier.testTag("panel.clock"),
            )
            trailing()
        }
    }
}

/* ---------------- chamada ---------------- */

/**
 * A tela de chamada inteira. Em pé: senha em cima, três anteriores lado a
 * lado, pedidos e campanha embaixo. Deitado: senha à esquerda, anteriores (ou
 * pedidos) e campanha na coluna direita. A campanha nunca cobre número ou
 * destino; o destaque da chamada cobre a campanha.
 */
@Composable
internal fun CallBoard(
    calls: List<StationCall>,
    campaign: (@Composable (Modifier) -> Unit)?,
    orders: (@Composable (Modifier) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val gap = LocalPanelBase.current * 0.7f
    val onScreen = PanelCalls.onScreen(calls)
    val previous = onScreen.drop(1).take(3)
    BoxWithConstraints(modifier.testTag("panel.current")) {
        val boardWidth = maxWidth
        val boardHeight = maxHeight
        if (boardWidth > boardHeight) {
            Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(gap)) {
                    CallHero(onScreen.firstOrNull(), emptyList(), Modifier.fillMaxWidth().weight(1f))
                    // Com pedidos na coluna da direita, as anteriores descem para baixo da senha.
                    if (orders != null) PreviousCalls(previous, emptyList(), landscape = false, Modifier.fillMaxWidth())
                }
                Column(
                    Modifier.width(boardWidth * if (orders != null) 0.34f else 0.31f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(gap),
                ) {
                    if (orders != null) {
                        orders(Modifier.fillMaxWidth().weight(1f))
                    } else {
                        PreviousCalls(previous, emptyList(), landscape = true, Modifier.fillMaxWidth())
                    }
                    if (campaign != null) {
                        campaign(
                            if (orders != null) {
                                Modifier.fillMaxWidth().height(boardHeight * 0.3f)
                            } else {
                                Modifier.fillMaxWidth().weight(1f)
                            },
                        )
                    }
                }
            }
        } else {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
                CallHero(onScreen.firstOrNull(), emptyList(), Modifier.fillMaxWidth().weight(1f))
                PreviousCalls(previous, emptyList(), landscape = false, Modifier.fillMaxWidth())
                orders?.invoke(Modifier.fillMaxWidth().height(boardHeight * 0.24f))
                campaign?.invoke(Modifier.fillMaxWidth().height(boardHeight * 0.15f))
            }
        }
    }
}

/** O número de "B042" medido pela caixa: largura dividida pela régua da fonte, até uma fração da altura. */
private fun numberSize(s: PanelStyle, text: String, w: Dp, h: Dp, heightFraction: Float): Dp {
    val em = s.numEm * maxOf(text.length, 3) / 4f
    return minOf(w / em, h * heightFraction)
}

/** O bloco da senha chamada: fila, número e destino, cada um com o tamanho que a caixa permite. */
@Composable
internal fun CallHero(current: StationCall?, options: List<StationOption>, modifier: Modifier = Modifier) {
    val s = LocalPanelStyle.current
    BoxWithConstraints(modifier.panelCard(s, s.heroBg, s.radius).testTag("panel.hero")) {
        val w = maxWidth
        val h = maxHeight
        if (current == null) {
            Column(
                Modifier.fillMaxSize().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            ) {
                Text(
                    "Aguardando a próxima chamada",
                    fontFamily = s.display,
                    fontWeight = s.displayWeight,
                    fontSize = minOf(h * 0.08f, w * 0.06f).sp(),
                    color = s.heroFg,
                    textAlign = TextAlign.Center,
                )
                Text(
                    "A próxima senha aparece aqui sozinha.",
                    fontFamily = s.text,
                    fontSize = minOf(h * 0.045f, w * 0.04f).sp(),
                    color = s.heroFg.copy(alpha = 0.75f),
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("panel.empty"),
                )
            }
            return@BoxWithConstraints
        }
        val parts = PanelDestination.split(current.stationLabel)
        val letter = PanelQueueLetter.of(current.publicNumber)
        val portrait = w / h < 0.8f
        val q = minOf(h * 0.065f, w * 0.055f)
        val num = numberSize(s, current.publicNumber, w * 0.88f, h, s.numHeight)
        val dl = when { parts.long -> minOf(h * 0.07f, w * 0.052f); portrait -> minOf(h * 0.09f, w * 0.10f); else -> minOf(h * 0.09f, w * 0.075f) }
        val dv = when { parts.long -> minOf(h * 0.13f, w * 0.095f); portrait -> minOf(h * 0.17f, w * 0.24f); else -> minOf(h * 0.17f, w * 0.15f) }
        val arrow = when { parts.long -> minOf(h * 0.11f, w * 0.08f); portrait -> minOf(h * 0.14f, w * 0.15f); else -> minOf(h * 0.15f, w * 0.13f) }
        val align = if (s.alignStart) Alignment.Start else Alignment.CenterHorizontally
        Column(Modifier.fillMaxSize()) {
            Column(
                Modifier.weight(1f).fillMaxWidth().padding(top = h * 0.04f, start = w * if (s.alignStart) 0.06f else 0.05f, end = w * 0.05f),
                horizontalAlignment = align,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(q * 0.45f)) {
                    if (letter != null) QueueChip(letter, queueIndex(letter, options), q * 1.6f)
                    Text(
                        s.label(if (letter != null) "Senha" else "Pedido pronto"),
                        fontFamily = s.text,
                        fontWeight = s.boldWeight,
                        fontSize = q.sp(),
                        letterSpacing = s.labelTracking.em,
                        color = s.heroFg,
                    )
                    if (s.liveTag) LiveTag(q)
                }
                // O número mede a caixa que sobrou entre o rótulo e o destino: na
                // tela baixa (híbrido, central) a faixa do destino não o cobre.
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = if (s.alignStart) Alignment.CenterStart else Alignment.Center) {
                    // A Anton (Vitrine) desenha a letra mais alta que o corpo: cabe com folga.
                    val tall = if (s.template == PanelTemplate.VITRINE) 0.72f else 0.92f
                    val fit = minOf(num, numberSize(s, current.publicNumber, maxWidth, maxHeight, tall))
                    Text(
                        current.publicNumber,
                        fontFamily = s.display,
                        fontWeight = s.displayWeight,
                        fontSize = fit.sp(),
                        lineHeight = fit.sp(),
                        color = s.heroFg,
                        maxLines = 1,
                        softWrap = false,
                        modifier = Modifier.semantics { contentDescription = "Senha ${current.publicNumber}" }.testTag("panel.current.number"),
                    )
                }
            }
            DestinationBand(parts, dl, dv, arrow, w, h)
        }
    }
}

@Composable
private fun LiveTag(size: Dp) {
    val s = LocalPanelStyle.current
    val pulse = rememberInfiniteTransition(label = "chamando")
    val a by pulse.animateFloat(1f, 0.25f, infiniteRepeatable(tween(600, easing = LinearEasing), RepeatMode.Reverse), label = "alfa")
    Text(
        "● CHAMANDO",
        fontFamily = s.text,
        fontWeight = s.boldWeight,
        fontSize = size.sp(),
        letterSpacing = s.labelTracking.em,
        color = s.ok,
        modifier = Modifier.alpha(a),
    )
}

/** Faixa (Sinal, Terminal, Sol) ou pílula (Clínica, Vitrine) com o destino: rótulo pequeno, número grande. */
@Composable
private fun DestinationBand(parts: PanelDestination.Parts, dlFull: Dp, dvFull: Dp, arrowFull: Dp, w: Dp, h: Dp) {
    val s = LocalPanelStyle.current
    // Destino longo ("Guichê Caixa") encolhe por inteiro em vez de sair cortado:
    // a largura estimada do rótulo, do valor e da seta cabe na faixa.
    val estimated =
        (if (s.arrow) arrowFull + dlFull * 0.3f else 0.dp) + dlFull * (0.56f * parts.label.length + 0.3f) +
            dvFull * (0.62f * parts.value.length)
    val k = minOf(1f, (w * if (s.destPill) 0.8f else 0.88f) / estimated)
    val dl = dlFull * k
    val dv = dvFull * k
    val arrow = arrowFull * k
    val content: @Composable RowScope.() -> Unit = {
        if (s.arrow) ArrowGlyph(arrow, s.destFg)
        Text(
            if (s.upperDest) parts.label.uppercase() else parts.label,
            fontFamily = s.display,
            fontWeight = s.displayWeight,
            fontSize = dl.sp(),
            lineHeight = dl.sp(),
            color = s.destFg,
            maxLines = 1,
            softWrap = false,
        )
        Text(
            parts.value,
            fontFamily = s.display,
            fontWeight = s.displayWeight,
            fontSize = dv.sp(),
            lineHeight = dv.sp(),
            color = s.destFg,
            maxLines = 1,
            softWrap = false,
        )
    }
    if (s.destPill) {
        Box(Modifier.fillMaxWidth().padding(bottom = h * 0.04f), contentAlignment = Alignment.Center) {
            Row(
                Modifier
                    .clip(if (s.template == PanelTemplate.CLINICA) RoundedCornerShape(50) else RoundedCornerShape(s.radiusSmall))
                    .background(s.destBg)
                    .padding(vertical = h * 0.02f, horizontal = w * 0.06f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dl * 0.3f),
                content = content,
            )
        }
    } else {
        Row(
            Modifier
                .fillMaxWidth()
                .background(s.destBg)
                .drawBehind { if (s.alignStart) drawRect(s.line, size = size.copy(height = 1.dp.toPx())) }
                .padding(vertical = h * if (s.template == PanelTemplate.SOL) 0.03f else 0.024f, horizontal = w * if (s.alignStart || s.arrow) 0.06f else 0.04f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dl * 0.3f, if (s.alignStart || s.arrow) Alignment.Start else Alignment.CenterHorizontally),
            content = content,
        )
    }
}

/** A seta de saída de rodovia, desenhada: não depende de a fonte ter o glifo. */
@Composable
private fun ArrowGlyph(size: Dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val u = this.size.width / 24f
        val stroke = Stroke(width = 3.4f * u, cap = StrokeCap.Square)
        drawLine(color, Offset(3 * u, 12 * u), Offset(19 * u, 12 * u), strokeWidth = 3.4f * u, cap = StrokeCap.Square)
        val head = Path().apply { moveTo(13 * u, 5 * u); lineTo(20 * u, 12 * u); lineTo(13 * u, 19 * u) }
        drawPath(head, color, style = stroke)
    }
}

/** As chamadas anteriores: cartões em pé, linhas deitado, tabela com hora no Terminal. */
@Composable
private fun PreviousCalls(calls: List<StationCall>, options: List<StationOption>, landscape: Boolean, modifier: Modifier = Modifier) {
    if (calls.isEmpty()) return
    val s = LocalPanelStyle.current
    val base = LocalPanelBase.current
    val gap = base * 0.5f
    val numSize = (base * if (s.boardTable) 1.6f else 2f).sp()
    fun place(c: StationCall) = PanelDestination.split(c.stationLabel).let { if (it.label == "Dirija-se ao") it.value else "${it.label} ${it.value}" }
    if (s.boardTable) {
        Column(modifier.panelCard(s, s.surface, s.radius).testTag("panel.previous")) {
            Row(Modifier.fillMaxWidth().padding(horizontal = base * 0.8f, vertical = base * 0.45f)) {
                listOf("Senha", "Destino").forEach {
                    Text(it.uppercase(), Modifier.weight(1f), fontFamily = s.text, fontSize = (base * 0.72f).sp(), letterSpacing = 0.12.em, color = s.muted)
                }
                Text("HORA", fontFamily = s.text, fontSize = (base * 0.72f).sp(), letterSpacing = 0.12.em, color = s.muted)
            }
            calls.forEach { c ->
                Row(
                    Modifier.fillMaxWidth().drawBehind { drawRect(s.line, size = size.copy(height = 1.dp.toPx())) }.padding(horizontal = base * 0.8f, vertical = base * 0.4f),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(c.publicNumber, Modifier.weight(1f), fontFamily = s.display, fontWeight = s.displayWeight, fontSize = numSize, lineHeight = numSize, color = s.fg, maxLines = 1, softWrap = false)
                    Text(place(c).uppercase(), Modifier.weight(1f), fontFamily = s.text, fontWeight = s.boldWeight, fontSize = (base * 0.9f).sp(), color = s.prevDest, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(PanelClock.hhmm(c.calledAt) ?: "", fontFamily = s.text, fontSize = (base * 0.9f).sp(), color = s.muted)
                }
            }
        }
        return
    }
    if (landscape) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(gap)) {
            calls.forEach { c ->
                Row(
                    Modifier.fillMaxWidth().panelCard(s).padding(horizontal = base * 0.8f, vertical = base * 0.45f).testTag("panel.previous"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(base * 0.6f),
                ) {
                    val letter = PanelQueueLetter.of(c.publicNumber)
                    QueueChip(letter, queueIndex(letter, options), base * 1.7f)
                    Text(c.publicNumber, Modifier.weight(1f), fontFamily = s.display, fontWeight = s.displayWeight, fontSize = numSize, lineHeight = numSize, color = s.fg, maxLines = 1, softWrap = false)
                    Text(place(c), fontFamily = s.text, fontWeight = s.boldWeight, fontSize = (base * 0.9f).sp(), color = s.prevDest, maxLines = 1)
                }
            }
        }
    } else {
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(gap)) {
            calls.forEach { c ->
                Column(
                    Modifier.weight(1f).panelCard(s).padding(vertical = base * 0.5f, horizontal = base * 0.4f).testTag("panel.previous"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(c.publicNumber, fontFamily = s.display, fontWeight = s.displayWeight, fontSize = numSize, lineHeight = numSize, color = s.fg, maxLines = 1, softWrap = false)
                    Text(place(c), fontFamily = s.text, fontWeight = s.boldWeight, fontSize = (base * 0.9f).sp(), color = s.prevDest, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/* ---------------- destaque ---------------- */

/**
 * A senha que acabou de ser chamada toma a tela por alguns segundos, no bloco
 * do template, com o destino. Quem está longe vê mesmo sem ouvir.
 */
@Composable
internal fun CallSpotlight(call: StationCall) {
    val s = LocalPanelStyle.current
    BoxWithConstraints(
        Modifier.fillMaxSize().background(s.heroBg).padding(horizontal = 32.dp, vertical = 24.dp).testTag("panel.spotlight"),
        contentAlignment = Alignment.Center,
    ) {
        val w = maxWidth
        val h = maxHeight
        val parts = PanelDestination.split(call.stationLabel)
        val num = numberSize(s, call.publicNumber, w, h, 0.50f)
        // No celular em pé a largura manda: o destino ganha até 22 % dela para não sumir sob o número.
        val dest = minOf(h * if (parts.long) 0.10f else 0.13f, w * if (parts.long) 0.10f else 0.22f)
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(h * 0.03f)) {
            Text(
                s.label("Senha chamada"),
                fontFamily = s.text,
                fontWeight = s.boldWeight,
                fontSize = minOf(h * 0.06f, w * 0.05f).sp(),
                letterSpacing = s.labelTracking.em,
                color = s.heroFg,
            )
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                Text(
                    call.publicNumber,
                    fontFamily = s.display,
                    fontWeight = s.displayWeight,
                    fontSize = num.sp(),
                    lineHeight = num.sp(),
                    color = s.heroFg,
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier.semantics { contentDescription = "Senha ${call.publicNumber}" },
                )
            }
            Row(
                Modifier.clip(RoundedCornerShape(s.radiusSmall)).background(s.destBg).padding(horizontal = dest * 0.55f, vertical = dest * 0.18f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dest * 0.3f),
            ) {
                Text(parts.label, fontFamily = s.display, fontWeight = s.displayWeight, fontSize = (dest * 0.5f).sp(), color = s.destFg, maxLines = 1, softWrap = false)
                Text(parts.value, fontFamily = s.display, fontWeight = s.displayWeight, fontSize = dest.sp(), lineHeight = (dest * 1.2f).sp(), color = s.destFg, maxLines = 1, softWrap = false)
            }
        }
    }
}

/* ---------------- campanha ---------------- */

/**
 * As campanhas vigentes para a tela: o cache baixa e confere a mídia fora da
 * thread da tela; sem cache (testes), só os textos. Relê a cada minuto, para o
 * que vence entre um evento e outro sair sozinho.
 */
@Composable
private fun rememberShownCampaigns(campaigns: List<Campaign>, cache: CampaignCache?): List<CampaignShown> {
    val shown by produceState(initialValue = emptyList<CampaignShown>(), campaigns, cache) {
        while (true) {
            value =
                withContext(Dispatchers.IO) {
                    cache?.current(campaigns)
                        ?: CampaignRules.forPanel(CampaignRules.live(campaigns, java.time.Instant.now()))
                            .mapNotNull { c ->
                                val text = c.titulo ?: c.criativo.takeUnless(CampaignRules::isMedia)
                                text?.let { CampaignShown(c.campaignId, it, null) }
                            }
                }
            delay(CAMPAIGN_RECHECK_MILLIS)
        }
    }
    return shown
}

/**
 * O espaço de campanha do template: lugar fixo na grade, uma campanha de cada
 * vez pelo tempo dela (`duracao_s`) ou 12 s. A imagem aparece inteira, sem
 * corte, sobre o fundo do template; a campanha só de texto usa a fonte e a
 * cor de destaque do template. O destaque da chamada cobre este espaço.
 */
@Composable
internal fun CampaignSlot(campaigns: List<Campaign>, cache: CampaignCache?, modifier: Modifier = Modifier) {
    val s = LocalPanelStyle.current
    val shown = rememberShownCampaigns(campaigns, cache)
    var index by remember(shown) { mutableIntStateOf(0) }
    LaunchedEffect(shown) {
        while (shown.size > 1) {
            delay(shown.getOrNull(index)?.durationMillis ?: CAMPAIGN_ROTATION_MILLIS)
            index = (index + 1) % shown.size
        }
    }
    val current = shown.getOrNull(index)
    Box(modifier.panelCard(s, s.surface, s.radius).testTag("panel.campaign")) {
        Crossfade(targetState = current, label = "campanha") { item ->
            val bitmap =
                remember(item?.image) {
                    item?.image?.let { file -> runCatching { BitmapFactory.decodeFile(file.path)?.asImageBitmap() }.getOrNull() }
                }
            BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                val w = maxWidth
                val h = maxHeight
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap,
                        contentDescription = "Campanha",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    val text = item?.text ?: "Vinki · fila sem papel e sem aperto"
                    val banner = w > h * 2
                    val size = if (banner) minOf(h * 0.3f, w * 0.042f) else minOf(h * 0.13f, w * 0.085f)
                    Box(
                        Modifier.fillMaxSize().background(s.accent).padding(horizontal = w * 0.06f, vertical = h * 0.08f),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text,
                            fontFamily = s.display,
                            fontWeight = s.displayWeight,
                            fontSize = size.sp(),
                            lineHeight = (size * 1.12f).sp(),
                            color = s.accentFg,
                            textAlign = TextAlign.Center,
                            maxLines = if (banner) 2 else 4,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

private const val CAMPAIGN_ROTATION_MILLIS = 12_000L
private const val CAMPAIGN_RECHECK_MILLIS = 60_000L

/* ---------------- pedidos ---------------- */

/**
 * O quadro de retirada (decisão 14): "Prontos" em cima, grande, na cor de
 * pronto do template; "Em preparo" embaixo, menor. Até seis códigos por
 * grupo, em duas colunas, medidos pela caixa: nada rola. Só leitura; quem
 * muda a situação é o balcão.
 */
@Composable
internal fun OrdersPanel(trackings: List<Tracking>?, modifier: Modifier = Modifier) {
    val s = LocalPanelStyle.current
    val base = LocalPanelBase.current
    val board = OrderBoard.of(trackings.orEmpty())
    Column(
        modifier.panelCard(s, s.surface, s.radius).padding(base * 0.8f).testTag("panel.orders"),
        verticalArrangement = Arrangement.spacedBy(base * 0.5f),
    ) {
        Text(
            s.name("Pedidos"),
            fontFamily = s.display,
            fontWeight = s.displayWeight,
            fontSize = (base * 1.3f).sp(),
            lineHeight = (base * 1.4f).sp(),
            color = s.fg,
            maxLines = 1,
        )
        if (trackings == null) {
            Text("Lendo os pedidos…", fontFamily = s.text, fontSize = base.sp(), color = s.muted)
            return@Column
        }
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val ready = board.ready.take(ORDERS_ON_SCREEN)
            val preparing = board.preparing.take(ORDERS_ON_SCREEN)
            // Caixa larga e baixa (faixa no celular em pé): os dois grupos lado a lado.
            if (maxWidth > maxHeight * 1.4f) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(base * 0.8f)) {
                    OrderGroup("Prontos", ready, ready = true, tag = "panel.orders.ready", Modifier.weight(1f).fillMaxHeight())
                    OrderGroup("Em preparo", preparing, ready = false, tag = "panel.orders.preparing", Modifier.weight(1f).fillMaxHeight())
                }
            } else {
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(base * 0.5f)) {
                    OrderGroup("Prontos", ready, ready = true, tag = "panel.orders.ready", Modifier.fillMaxWidth().weight(1.25f))
                    OrderGroup("Em preparo", preparing, ready = false, tag = "panel.orders.preparing", Modifier.fillMaxWidth().weight(1f))
                }
            }
        }
    }
}

@Composable
private fun OrderGroup(title: String, codes: List<String>, ready: Boolean, tag: String, modifier: Modifier) {
    val s = LocalPanelStyle.current
    val base = LocalPanelBase.current
    Column(modifier, verticalArrangement = Arrangement.spacedBy(base * 0.35f)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(base * 0.4f)) {
            if (ready) Box(Modifier.size(base * 0.7f).clip(CircleShape).background(s.ok))
            Text(
                s.label(title),
                fontFamily = s.text,
                fontWeight = s.boldWeight,
                fontSize = (base * 0.95f).sp(),
                letterSpacing = s.labelTracking.em,
                color = if (ready) s.fg else s.muted,
                maxLines = 1,
            )
        }
        if (codes.isEmpty()) {
            Text("Nenhum agora.", fontFamily = s.text, fontSize = (base * 0.9f).sp(), color = s.muted, modifier = Modifier.testTag("$tag.empty"))
            return@Column
        }
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val rows = (codes.size + 1) / 2
            val gap = base * 0.35f
            val cellW = (maxWidth - gap) / 2
            val cellH = (maxHeight - gap * (rows - 1)) / rows
            val longest = codes.maxOf { it.length }
            val size = minOf(cellH * if (ready) 0.62f else 0.5f, cellW / (s.numEm * maxOf(longest, 3) / 4f) * 0.8f)
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
                codes.chunked(2).forEach { pair ->
                    Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(gap)) {
                        pair.forEach { code ->
                            Box(
                                Modifier
                                    .weight(1f)
                                    .fillMaxHeight()
                                    .clip(RoundedCornerShape(s.radiusSmall))
                                    .background(if (ready) s.readyBg else s.bg)
                                    .testTag(tag),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    code,
                                    fontFamily = s.display,
                                    fontWeight = s.displayWeight,
                                    fontSize = size.sp(),
                                    lineHeight = size.sp(),
                                    color = if (ready) s.readyFg else s.fg,
                                    maxLines = 1,
                                    softWrap = false,
                                )
                            }
                        }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

private const val ORDERS_ON_SCREEN = 6

/* ---------------- totem e híbrido ---------------- */

/**
 * O totem sem rolagem: pedido, um botão por fila, como acompanhar e a
 * campanha. Com pedidos no mesmo aparelho, o quadro de retirada fica ao lado
 * (deitado) ou embaixo (em pé).
 */
@Composable
internal fun TotemBoard(
    runtime: StationRuntime,
    busy: Boolean,
    onIssue: (queueId: String, optionId: String) -> Unit,
    campaign: (@Composable (Modifier) -> Unit)?,
    orders: (@Composable (Modifier) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val s = LocalPanelStyle.current
    val base = LocalPanelBase.current
    val gap = base * 0.7f
    val options = runtime.options.filter { it.available }
    val column: @Composable (Modifier) -> Unit = { m ->
        Column(m, verticalArrangement = Arrangement.spacedBy(gap)) {
            Column {
                Text(
                    s.name("Toque para retirar sua senha"),
                    fontFamily = s.display,
                    fontWeight = s.displayWeight,
                    fontSize = (base * 2.1f).sp(),
                    lineHeight = (base * 2.2f).sp(),
                    color = s.fg,
                )
                Text("A senha sai no papel e dá para acompanhar pelo celular.", fontFamily = s.text, fontSize = base.sp(), color = s.muted)
            }
            if (options.isEmpty()) {
                Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    Text(
                        "Nenhum atendimento disponível agora.",
                        fontFamily = s.text,
                        fontSize = (base * 1.2f).sp(),
                        color = s.muted,
                        modifier = Modifier.testTag("totem.empty"),
                    )
                }
            } else {
                QueueButtons(options, busy, onIssue, Modifier.fillMaxWidth().weight(1f))
            }
            Text("Acompanhe pelo QR do papel", fontFamily = s.text, fontSize = (base * 0.9f).sp(), color = s.muted)
        }
    }
    BoxWithConstraints(modifier.testTag("totem.board")) {
        val boardWidth = maxWidth
        val boardHeight = maxHeight
        if (boardWidth > boardHeight) {
            Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                column(Modifier.weight(1f).fillMaxHeight())
                if (orders != null || campaign != null) {
                    Column(Modifier.width(boardWidth * 0.31f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(gap)) {
                        orders?.invoke(Modifier.fillMaxWidth().weight(1f))
                        campaign?.invoke(
                            if (orders != null) Modifier.fillMaxWidth().height(boardHeight * 0.3f) else Modifier.fillMaxWidth().weight(1f),
                        )
                    }
                }
            }
        } else {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
                column(Modifier.fillMaxWidth().weight(1f))
                orders?.invoke(Modifier.fillMaxWidth().height(boardHeight * 0.24f))
                campaign?.invoke(Modifier.fillMaxWidth().height(boardHeight * 0.15f))
            }
        }
    }
}

/**
 * Totem e painel no mesmo aparelho; com pedidos, a central híbrida da decisão
 * 14 em três colunas. Deitado: filas à esquerda, chamada no meio, pedidos à
 * direita, campanha na faixa de baixo. Com senha recém-emitida, a coluna das
 * filas vira o comprovante ([issued]) e só ela pode rolar. Em pé: chamada em
 * cima, pedidos e filas embaixo.
 */
@Composable
internal fun HybridBoard(
    runtime: StationRuntime,
    busy: Boolean,
    onIssue: (queueId: String, optionId: String) -> Unit,
    campaign: (@Composable (Modifier) -> Unit)?,
    orders: (@Composable (Modifier) -> Unit)?,
    issued: (@Composable () -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val s = LocalPanelStyle.current
    val base = LocalPanelBase.current
    val gap = base * 0.7f
    val options = runtime.options.filter { it.available }
    val current = PanelCalls.onScreen(runtime.calls).firstOrNull()
    val heading: @Composable () -> Unit = {
        Text(s.name("Retire sua senha"), fontFamily = s.display, fontWeight = s.displayWeight, fontSize = (base * 1.3f).sp(), color = s.fg)
    }
    BoxWithConstraints(modifier.testTag("hybrid.board")) {
        val landscape = maxWidth > maxHeight
        val boardWidth = maxWidth
        val boardHeight = maxHeight
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
            if (landscape) {
                Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    val side = orders != null || campaign != null
                    Column(
                        Modifier
                            .then(if (side) Modifier.width(boardWidth * 0.3f) else Modifier.weight(1f))
                            .fillMaxHeight()
                            .then(if (issued != null) Modifier.verticalScroll(rememberScrollState()) else Modifier),
                        verticalArrangement = Arrangement.spacedBy(gap),
                    ) {
                        if (issued != null) {
                            issued()
                        } else {
                            heading()
                            QueueButtons(options, busy, onIssue, Modifier.fillMaxWidth().weight(1f), compact = true)
                        }
                    }
                    CallHero(current, emptyList(), Modifier.weight(1f).fillMaxHeight())
                    // Deitado, a campanha fica na coluna da direita, com os pedidos: as
                    // peças são em pé e sumiam numa faixa larga embaixo.
                    if (side) {
                        Column(Modifier.width(boardWidth * 0.26f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(gap)) {
                            orders?.invoke(Modifier.fillMaxWidth().weight(1f))
                            campaign?.invoke(
                                if (orders != null) Modifier.fillMaxWidth().height(boardHeight * 0.38f) else Modifier.fillMaxWidth().weight(1f),
                            )
                        }
                    }
                }
            } else {
                CallHero(current, emptyList(), Modifier.fillMaxWidth().weight(1f))
                orders?.invoke(Modifier.fillMaxWidth().height(boardHeight * 0.2f))
                heading()
                QueueButtons(options, busy, onIssue, Modifier.fillMaxWidth().height(boardHeight * if (orders != null) 0.22f else 0.28f), compact = true)
            }
            if (!landscape) campaign?.invoke(Modifier.fillMaxWidth().height(boardHeight * 0.11f))
        }
    }
}

/** Um botão por fila, dividindo a altura recebida; alvo mínimo de 72 dp na grade do totem. */
@Composable
private fun QueueButtons(
    options: List<StationOption>,
    busy: Boolean,
    onIssue: (queueId: String, optionId: String) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val gap = LocalPanelBase.current * 0.7f
    if (options.isEmpty()) {
        Text("Nenhum atendimento disponível agora.", modifier = Modifier.testTag("totem.empty"))
        return
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(gap)) {
        options.forEachIndexed { i, option ->
            QueueButton(option, i, busy, compact, { onIssue(option.queueId, option.optionId) }, Modifier.fillMaxWidth().weight(1f))
        }
    }
}

@Composable
private fun QueueButton(option: StationOption, index: Int, busy: Boolean, compact: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val s = LocalPanelStyle.current
    val letter = option.name.firstOrNull()?.uppercaseChar()
    BoxWithConstraints(
        modifier
            .panelCard(s, s.surface, s.radius)
            .clickable(enabled = !busy, onClickLabel = "Retirar senha de ${option.name}", onClick = onClick)
            .alpha(if (busy) 0.6f else 1f)
            .semantics { contentDescription = "${option.name}. ${QueueMetricsCopy.option(option.waitingCount, option.estimatedWaitMinutes)}" }
            .testTag("totem.issue"),
    ) {
        val w = maxWidth
        val h = maxHeight
        Row(
            Modifier.fillMaxSize().padding(horizontal = w * 0.04f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(w * 0.04f),
        ) {
            QueueChip(letter, queueIndex(letter), minOf(h * 0.62f, w * 0.17f))
            Column(Modifier.weight(1f)) {
                val nameSize = minOf(h * if (compact) 0.30f else 0.27f, w * if (compact) 0.05f else 0.06f)
                Text(s.name(option.name), fontFamily = s.display, fontWeight = s.displayWeight, fontSize = nameSize.sp(), lineHeight = (nameSize * 1.05f).sp(), color = s.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (!compact) {
                    Text(
                        when {
                            option.waitingCount == 0 -> "Sem fila agora"
                            option.estimatedWaitMinutes == null -> "Sem estimativa de espera"
                            else -> "Cerca de ${option.estimatedWaitMinutes} min de espera"
                        },
                        fontFamily = s.text,
                        fontSize = minOf(h * 0.14f, w * 0.039f).sp(),
                        color = s.muted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                val n = minOf(h * 0.38f, w * 0.10f)
                Text(option.waitingCount.toString(), fontFamily = s.display, fontWeight = s.displayWeight, fontSize = n.sp(), lineHeight = n.sp(), color = s.fg)
                Text(
                    when (option.waitingCount) { 0 -> "sem fila"; 1 -> "pessoa"; else -> "pessoas" },
                    fontFamily = s.text,
                    fontSize = minOf(h * 0.12f, w * 0.034f).sp(),
                    color = s.muted,
                    maxLines = 1,
                )
            }
        }
    }
}

/* ---------------- escolha do template ---------------- */

/** Os cinco templates em cartões; o toque troca a tela na hora. */
@Composable
internal fun TemplatePicker(selected: PanelTemplate, onSelect: (PanelTemplate) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("panel.templates")) {
        PanelTemplate.entries.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { t -> TemplateCard(t, t == selected, onSelect, Modifier.weight(1f)) }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun TemplateCard(template: PanelTemplate, selected: Boolean, onSelect: (PanelTemplate) -> Unit, modifier: Modifier) {
    val style = PanelStyles.of(template)
    val ring = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .border(if (selected) 3.dp else 1.dp, ring, RoundedCornerShape(10.dp))
            .clickable(onClickLabel = "Usar o template ${template.label}") { onSelect(template) }
            .padding(6.dp)
            .testTag("panel.template.${template.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(6.dp)).background(style.heroBg).border(1.dp, Color.Black.copy(alpha = 0.12f), RoundedCornerShape(6.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text("B042", fontFamily = style.display, fontWeight = style.displayWeight, fontSize = (26.dp).sp(), color = style.heroFg, maxLines = 1)
        }
        Text(template.label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        Text(template.fit, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
    }
}
