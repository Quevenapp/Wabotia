package br.com.queven.wabotia.ui.settings

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.FontDownload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.theme.Wb

/** Um componente de terceiros que vai dentro do app e o arquivo com o texto da licença (em `assets/`). */
data class OpenSourceNotice(val name: String, val detail: String, val license: String, val asset: String?)

/**
 * O que o app distribui de terceiros, com a licença. As fontes do painel e do totem são OFL 1.1 e cada uma leva o
 * `OFL.txt` oficial da família (google/fonts), com o aviso de copyright; as bibliotecas são Apache 2.0, menos o Google
 * Play services (termos próprios do Google). A pasta `mobile/` é MIT: nada GPL ou AGPL de terceiros entra no app.
 */
object OpenSourceNotices {
    const val APACHE = "licencas/Apache-2.0.txt"

    val fonts = listOf(
        OpenSourceNotice("Anton", "Modelo Vitrine", "SIL Open Font License 1.1", "licencas-fontes/Anton-OFL.txt"),
        OpenSourceNotice("Archivo", "Modelo Vitrine", "SIL Open Font License 1.1", "licencas-fontes/Archivo-OFL.txt"),
        OpenSourceNotice("Atkinson Hyperlegible", "Modelo Clínica", "SIL Open Font License 1.1", "licencas-fontes/AtkinsonHyperlegible-OFL.txt"),
        OpenSourceNotice("B612", "Modelo Terminal", "SIL Open Font License 1.1", "licencas-fontes/B612-OFL.txt"),
        OpenSourceNotice("Lexend", "Modelo Sol", "SIL Open Font License 1.1", "licencas-fontes/Lexend-OFL.txt"),
        OpenSourceNotice("Overpass", "Modelo Sinal", "SIL Open Font License 1.1", "licencas-fontes/Overpass-OFL.txt"),
    )

    val libraries = listOf(
        OpenSourceNotice("Android Jetpack (AndroidX)", "Compose, Material 3, Navigation, Lifecycle, CameraX, Media3, DataStore, Security", "Apache License 2.0", APACHE),
        OpenSourceNotice("Kotlin e kotlinx", "Biblioteca padrão, corrotinas e serialização (JetBrains)", "Apache License 2.0", APACHE),
        OpenSourceNotice("OkHttp, Okio e Retrofit", "Square", "Apache License 2.0", APACHE),
        OpenSourceNotice("Coil", "Imagens", "Apache License 2.0", APACHE),
        OpenSourceNotice("ZXing", "Leitura e desenho de QR", "Apache License 2.0", APACHE),
        OpenSourceNotice("Firebase Cloud Messaging", "Avisos no celular (Google)", "Apache License 2.0", APACHE),
        OpenSourceNotice("Tink, Guava, Gson, Accompanist, JSpecify, javax.inject", "Dependências das bibliotecas acima (Google e outros)", "Apache License 2.0", APACHE),
        OpenSourceNotice("Google Play services", "Localização e serviços do Google", "Termos de serviço das APIs do Google", null),
    )

    fun read(context: Context, asset: String): String =
        runCatching { context.assets.open(asset).bufferedReader(Charsets.UTF_8).use { it.readText() } }.getOrElse { "Não foi possível abrir $asset." }
}

/** Ajustes → Sobre → Licenças de código aberto. */
@Composable
fun LicensesScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    var title by rememberSaveable { mutableStateOf("") }
    val c = Wb.colors
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        DetailTopBar("Licenças", onBack = onBack, subtitle = "Componentes de terceiros no app")
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item("intro") {
                Text(
                    "O app Wabotia é software livre sob a licença MIT. Ele inclui os componentes abaixo, cada um com a própria licença.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
            }
            item("fonts-label") { SectionLabel("Fontes do painel e do totem") }
            item("fonts") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    OpenSourceNotices.fonts.forEachIndexed { i, n ->
                        if (i > 0) RowDivider()
                        SettingsRow(Icons.Filled.FontDownload, n.name, subtitle = "${n.license} · ${n.detail}", tint = c.textSecondary, onClick = { title = n.name; open = n.asset })
                    }
                }
            }
            item("libs-label") { SectionLabel("Bibliotecas") }
            item("libs") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    OpenSourceNotices.libraries.forEachIndexed { i, n ->
                        if (i > 0) RowDivider()
                        SettingsRow(
                            Icons.Filled.Code,
                            n.name,
                            subtitle = "${n.license} · ${n.detail}",
                            tint = c.textSecondary,
                            onClick = n.asset?.let { asset -> { title = n.license; open = asset } },
                        )
                    }
                }
            }
        }
    }
    open?.let { asset ->
        val text = remember(asset) { OpenSourceNotices.read(context, asset) }
        AlertDialog(
            onDismissRequest = { open = null },
            title = { Text(title) },
            text = {
                Text(
                    text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = { TextButton(onClick = { open = null }) { Text("Fechar") } },
        )
    }
}
