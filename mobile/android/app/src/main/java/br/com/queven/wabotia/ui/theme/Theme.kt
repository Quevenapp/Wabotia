package br.com.queven.wabotia.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import br.com.queven.wabotia.core.SessionStore

/**
 * Tokens de cor de mobile/DESIGN.md, seção 1. Nenhuma tela usa cor literal: leia sempre de `Wb.colors`.
 */
@Immutable
data class WabotiaColors(
    val brand: Color,
    val brandStrong: Color,
    val accent: Color,
    val background: Color,
    val surface: Color,
    val chatWallpaper: Color,
    val bubbleOut: Color,
    val bubbleIn: Color,
    val bubbleNote: Color,
    val bubbleSystem: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val divider: Color,
    val tickRead: Color,
    val ok: Color,
    val warn: Color,
    val danger: Color,
    val muted: Color,
    val bot: Color,
    val ticket: Color,
    /** Texto/ícone sobre `brand` (botões principais). */
    val onBrand: Color,
    /** Texto/ícone sobre `accent` (contadores, FAB). */
    val onAccent: Color,
    /** Campo de texto e superfícies um degrau acima de `surface`. */
    val field: Color,
    /** Horário e ticks dentro da bolha enviada. */
    val bubbleOutMeta: Color,
    /** Play, onda e destaques dentro da bolha enviada. */
    val bubbleOutAccent: Color,
    /** Rótulo "Nota interna" sobre `bubbleNote`. */
    val noteLabel: Color,
    /** Cartão de mapa da localização. */
    val mapLand: Color,
    val mapRoad: Color,
    val mapWater: Color,
    /** Degradê do símbolo da marca (igual ao fundo do ícone do app). */
    val brandGradientStart: Color,
    val brandGradientEnd: Color,
    val isDark: Boolean,
) {
    /** Linha divisória que continua visível sobre cartões `surface` no escuro (no claro é o próprio `divider`). */
    val hairline: Color get() = if (isDark) Color.White.copy(alpha = 0.09f) else divider

    /** Fundo suave de uma cor de estado (pílulas, faixas): a cor a [alpha] sobre o fundo da tela. */
    fun soft(color: Color, alpha: Float = 0.14f): Color = color.copy(alpha = alpha).compositeOver(background)
}

val LightWabotiaColors = WabotiaColors(
    brand = Color(0xFF008069),
    brandStrong = Color(0xFF075E54),
    accent = Color(0xFF25D366),
    background = Color(0xFFFFFFFF),
    surface = Color(0xFFF7F8FA),
    chatWallpaper = Color(0xFFEFEAE2),
    bubbleOut = Color(0xFFD9FDD3),
    bubbleIn = Color(0xFFFFFFFF),
    bubbleNote = Color(0xFFFFF3C4),
    bubbleSystem = Color(0xE6FFFFFF),
    textPrimary = Color(0xFF111B21),
    textSecondary = Color(0xFF667781),
    divider = Color(0xFFE9EDEF),
    tickRead = Color(0xFF53BDEB),
    ok = Color(0xFF1FA855),
    warn = Color(0xFFF59E0B),
    danger = Color(0xFFE53935),
    muted = Color(0xFF8696A0),
    bot = Color(0xFF7C4DFF),
    ticket = Color(0xFF0277BD),
    onBrand = Color(0xFFFFFFFF),
    onAccent = Color(0xFFFFFFFF),
    field = Color(0xFFF0F2F5),
    bubbleOutMeta = Color(0xFF667781),
    bubbleOutAccent = Color(0xFF075E54),
    noteLabel = Color(0xFF8A6A00),
    mapLand = Color(0xFFDDEFD9),
    mapRoad = Color(0xFFFFFFFF),
    mapWater = Color(0xFFBFE3F2),
    brandGradientStart = Color(0xFF00A884),
    brandGradientEnd = Color(0xFF075E54),
    isDark = false,
)

val DarkWabotiaColors = WabotiaColors(
    brand = Color(0xFF00A884),
    brandStrong = Color(0xFF005C4B),
    accent = Color(0xFF25D366),
    background = Color(0xFF111B21),
    surface = Color(0xFF1F2C34),
    chatWallpaper = Color(0xFF0B141A),
    bubbleOut = Color(0xFF005C4B),
    bubbleIn = Color(0xFF202C33),
    bubbleNote = Color(0xFF3A3320),
    bubbleSystem = Color(0xFF182229),
    textPrimary = Color(0xFFE9EDEF),
    textSecondary = Color(0xFF8696A0),
    divider = Color(0xFF222D34),
    tickRead = Color(0xFF53BDEB),
    ok = Color(0xFF25D366),
    warn = Color(0xFFFFB02E),
    danger = Color(0xFFF15C6D),
    muted = Color(0xFF8696A0),
    bot = Color(0xFFA78BFA),
    ticket = Color(0xFF4FC3F7),
    onBrand = Color(0xFF0B141A),
    onAccent = Color(0xFF0B141A),
    field = Color(0xFF2A3942),
    bubbleOutMeta = Color(0xFFA7C4BC),
    bubbleOutAccent = Color(0xFFD9FDD3),
    noteLabel = Color(0xFFFFB02E),
    mapLand = Color(0xFF1D3B36),
    mapRoad = Color(0xFF2D4A52),
    mapWater = Color(0xFF16323F),
    brandGradientStart = Color(0xFF00A884),
    brandGradientEnd = Color(0xFF075E54),
    isDark = true,
)

val LocalWabotiaColors = staticCompositionLocalOf { LightWabotiaColors }

/** Acesso curto aos tokens: `Wb.colors.brand`. */
object Wb {
    val colors: WabotiaColors
        @Composable @ReadOnlyComposable get() = LocalWabotiaColors.current
}

/** Aparência escolhida em Ajustes (Sistema / Claro / Escuro), guardada em SessionStore. */
enum class ThemeMode(val key: String, val label: String) {
    System("system", "Sistema"),
    Light("light", "Claro"),
    Dark("dark", "Escuro"),
}

object ThemeController {
    var mode by mutableStateOf(ThemeMode.System)
        private set
    private var store: SessionStore? = null

    fun init(session: SessionStore) {
        store = session
        mode = ThemeMode.entries.firstOrNull { it.key == session.themeMode } ?: ThemeMode.System
    }

    fun set(value: ThemeMode) {
        mode = value
        store?.themeMode = value.key
    }
}

private val WabotiaTypography = Typography().let { base ->
    base.copy(
        headlineSmall = base.headlineSmall.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
        titleLarge = base.titleLarge.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontSize = 16.5.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp),
        titleSmall = base.titleSmall.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, letterSpacing = 0.1.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
        bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp, letterSpacing = 0.1.sp),
        labelLarge = base.labelLarge.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
        labelMedium = base.labelMedium.copy(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.2.sp),
        labelSmall = base.labelSmall.copy(fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.2.sp),
    )
}

private val WabotiaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun WabotiaTheme(content: @Composable () -> Unit) {
    val dark = when (ThemeController.mode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    val c = if (dark) DarkWabotiaColors else LightWabotiaColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.brand, onPrimary = c.onBrand,
            primaryContainer = c.soft(c.brand, 0.22f), onPrimaryContainer = c.textPrimary,
            secondary = c.brand, onSecondary = c.onBrand,
            secondaryContainer = c.soft(c.brand, 0.24f), onSecondaryContainer = c.textPrimary,
            tertiary = c.accent, onTertiary = c.onAccent,
            background = c.background, onBackground = c.textPrimary,
            surface = c.background, onSurface = c.textPrimary,
            surfaceVariant = c.surface, onSurfaceVariant = c.textSecondary,
            surfaceTint = c.background,
            surfaceContainerLowest = c.background, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
            surfaceContainerHigh = Color(0xFF233138), surfaceContainerHighest = c.field,
            surfaceBright = c.surface, surfaceDim = c.chatWallpaper,
            outline = Color(0xFF3B4A54), outlineVariant = c.divider,
            error = c.danger, onError = c.onBrand, errorContainer = c.soft(c.danger, 0.2f), onErrorContainer = c.danger,
            inverseSurface = Color(0xFFE9EDEF), inverseOnSurface = Color(0xFF111B21), inversePrimary = Color(0xFF008069),
            scrim = Color.Black,
        )
    } else {
        lightColorScheme(
            primary = c.brand, onPrimary = c.onBrand,
            primaryContainer = c.soft(c.brand, 0.12f), onPrimaryContainer = c.brandStrong,
            secondary = c.brand, onSecondary = c.onBrand,
            secondaryContainer = c.soft(c.brand, 0.14f), onSecondaryContainer = c.brandStrong,
            tertiary = c.accent, onTertiary = c.onAccent,
            background = c.background, onBackground = c.textPrimary,
            surface = c.background, onSurface = c.textPrimary,
            surfaceVariant = c.surface, onSurfaceVariant = c.textSecondary,
            surfaceTint = c.background,
            surfaceContainerLowest = c.background, surfaceContainerLow = c.background, surfaceContainer = c.surface,
            surfaceContainerHigh = c.background, surfaceContainerHighest = c.field,
            surfaceBright = c.background, surfaceDim = c.surface,
            outline = Color(0xFFC5CED3), outlineVariant = c.divider,
            error = c.danger, onError = Color.White, errorContainer = c.soft(c.danger, 0.12f), onErrorContainer = c.danger,
            inverseSurface = Color(0xFF1F2C34), inverseOnSurface = Color(0xFFE9EDEF), inversePrimary = Color(0xFF00A884),
            scrim = Color.Black,
        )
    }

    // Ícones das barras do sistema acompanham o tema do app (que pode diferir do tema do sistema).
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            val controller = WindowCompat.getInsetsController(window, view)
            controller.isAppearanceLightStatusBars = !dark
            controller.isAppearanceLightNavigationBars = !dark
        }
    }

    CompositionLocalProvider(LocalWabotiaColors provides c) {
        MaterialTheme(colorScheme = scheme, typography = WabotiaTypography, shapes = WabotiaShapes, content = content)
    }
}
