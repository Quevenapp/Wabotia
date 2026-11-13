package br.com.queven.wabotia.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import br.com.queven.wabotia.core.model.Conversation
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// Relógio da janela de 24 horas (DESIGN.md, seção 2).

const val WINDOW_MS: Long = 24L * 60 * 60 * 1000
private const val HOUR_MS: Long = 60L * 60 * 1000

enum class WindowTone { Ok, Warn, Danger, Closed }

/** Prazo da janela de uma conversa. [remainingMs] <= 0 significa janela fechada. */
data class WindowInfo(val lastCustomer: Long, val expiresAt: Long, val remainingMs: Long) {
    val closed: Boolean get() = remainingMs <= 0
    val fraction: Float get() = (remainingMs.toFloat() / WINDOW_MS).coerceIn(0f, 1f)
    val tone: WindowTone
        get() = when {
            closed -> WindowTone.Closed
            remainingMs < HOUR_MS -> WindowTone.Danger
            remainingMs <= 6 * HOUR_MS -> WindowTone.Warn
            else -> WindowTone.Ok
        }

    /** `23h 14min`, `5h 02min`, `42 min`, `menos de 1 min`, `Janela fechada`. */
    fun longText(): String {
        if (closed) return "Janela fechada"
        val minutes = remainingMs / 60_000
        return when {
            minutes < 1 -> "menos de 1 min"
            minutes < 60 -> "$minutes min"
            else -> "${minutes / 60}h ${(minutes % 60).toString().padStart(2, '0')}min"
        }
    }

    /** Forma compacta da lista: `23h`, `5h`, `42m`; vazio quando fechada (a lista mostra o cadeado). */
    fun compactText(): String {
        if (closed) return ""
        val minutes = remainingMs / 60_000
        return if (minutes >= 60) "${minutes / 60}h" else "${minutes.coerceAtLeast(1)}m"
    }

    /** "até 14:32" ou "até amanhã 09:10". */
    fun untilText(): String {
        val zone = ZoneId.systemDefault()
        val date = Instant.ofEpochMilli(expiresAt).atZone(zone).toLocalDate()
        val today = LocalDate.now(zone)
        return when (date) {
            today -> "até ${formatTime(expiresAt)}"
            today.plusDays(1) -> "até amanhã ${formatTime(expiresAt)}"
            else -> "até ${formatWhen(expiresAt)}"
        }
    }
}

/**
 * Janela da conversa, ou null quando não se aplica: grupos e linhas que não são WhatsApp oficial
 * (`kind` diferente de `meta`/`zernio`). Quando o tipo da linha não é conhecido, o relógio aparece.
 */
fun windowInfo(c: Conversation, lineKinds: Map<String, String>?, now: Long): WindowInfo? {
    if (c.isGroup) return null
    val kind = c.connection_id?.let { lineKinds?.get(it) }
    if (kind != null && kind != "meta" && kind != "zernio") return null
    if (c.last_customer <= 0) return WindowInfo(lastCustomer = 0, expiresAt = 0, remainingMs = 0)
    val expires = c.last_customer + WINDOW_MS
    // O relógio da tela anda de 30 em 30 s: logo depois de uma mensagem nova o "agora" pode estar atrás dela.
    return WindowInfo(lastCustomer = c.last_customer, expiresAt = expires, remainingMs = (expires - now).coerceAtMost(WINDOW_MS))
}

@Composable
fun WindowTone.color(): Color = when (this) {
    WindowTone.Ok -> Wb.colors.ok
    WindowTone.Warn -> Wb.colors.warn
    WindowTone.Danger -> Wb.colors.danger
    WindowTone.Closed -> Wb.colors.muted
}

/**
 * Relógio único da tela: devolve o "agora" e o atualiza a cada [periodMs] enquanto a tela está visível.
 * Use um por tela (não um timer por linha).
 */
@Composable
fun rememberNow(periodMs: Long = 30_000): State<Long> {
    val now = remember { mutableLongStateOf(System.currentTimeMillis()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, periodMs) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                now.longValue = System.currentTimeMillis()
                delay(periodMs)
            }
        }
    }
    return now
}

/**
 * Anel de progresso genérico: cheio em [fraction] = 1 e esvazia no sentido horário. O conteúdo central é um ícone
 * (padrão) ou o que for passado em [content] (ex.: o tempo no anel grande de Dados da conversa).
 */
@Composable
fun ProgressRing(
    fraction: Float,
    color: Color,
    modifier: Modifier = Modifier,
    size: Dp = 22.dp,
    strokeWidth: Dp = 2.5.dp,
    icon: ImageVector? = null,
    content: (@Composable () -> Unit)? = null,
) {
    val animated by animateFloatAsState(fraction.coerceIn(0f, 1f), animationSpec = tween(450), label = "ring")
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val stroke = strokeWidth.toPx()
            val inset = stroke / 2
            val arcSize = Size(this.size.width - stroke, this.size.height - stroke)
            val topLeft = Offset(inset, inset)
            drawArc(color.copy(alpha = 0.22f), 0f, 360f, false, topLeft, arcSize, style = Stroke(stroke))
            if (animated > 0f) {
                val sweep = 360f * animated
                // A parte vazia cresce a partir do topo, no sentido horário; o arco restante termina no topo.
                drawArc(color, -90f + (360f - sweep), sweep, false, topLeft, arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            }
        }
        if (content != null) content()
        else if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(size * 0.5f))
    }
}

/** Anel da janela de 24 h: relógio no centro; fechado vira cadeado. */
@Composable
fun WindowRing(
    info: WindowInfo,
    modifier: Modifier = Modifier,
    size: Dp = 22.dp,
    strokeWidth: Dp = 2.5.dp,
    content: (@Composable () -> Unit)? = null,
) {
    ProgressRing(
        fraction = info.fraction,
        color = info.tone.color(),
        modifier = modifier,
        size = size,
        strokeWidth = strokeWidth,
        icon = if (info.closed) Icons.Filled.Lock else Icons.Filled.Schedule,
        content = content,
    )
}
