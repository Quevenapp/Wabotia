package br.com.queven.wabotia.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

val Brand = Color(0xFF0B5C4D)
val BrandLight = Color(0xFF25D366)
val IncomingBubble = Color(0xFFFFFFFF)
val OutgoingBubble = Color(0xFFD9FDD3)
val NoteBubble = Color(0xFFFFF4C2)
val IncomingBubbleDark = Color(0xFF202C33)
val OutgoingBubbleDark = Color(0xFF005C4B)
val NoteBubbleDark = Color(0xFF4A4320)
val Overdue = Color(0xFFC62828)
val DueSoon = Color(0xFFEF6C00)

private val Light = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFCDEFE2),
    secondary = Color(0xFF128C7E),
    tertiary = BrandLight,
    background = Color(0xFFF4F6F5),
    surface = Color.White,
)
private val Dark = darkColorScheme(
    primary = Color(0xFF7FD9BE),
    onPrimary = Color(0xFF003828),
    primaryContainer = Color(0xFF0B5C4D),
    secondary = Color(0xFF25D366),
    background = Color(0xFF0B141A),
    surface = Color(0xFF111B21),
)

@Composable
fun WabotiaTheme(darkTheme: Boolean = isSystemInDarkTheme(), dynamicColor: Boolean = false, content: @Composable () -> Unit) {
    val scheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> Dark
        else -> Light
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
