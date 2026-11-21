package br.com.queven.wabotia.ui.printing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.theme.Wb
import br.com.thermalprinterkit.printher.ThermalPrinterContent
import br.com.thermalprinterkit.printher.ThermalPrinterTheme

/**
 * A impressora térmica deste aparelho. Busca, teste, confirmação no papel e homologação são a superfície do
 * `ThermalPrinterKit`; o app só dá o tema e o texto. Defeito de impressão se conserta no kit, nunca aqui.
 */
@Composable
fun PrinterScreen(container: AppContainer, onBack: () -> Unit, intro: String = PRINTER_INTRO) {
    val c = Wb.colors
    // Readota a impressora escolhida antes (uma vez por abertura do app), para a tela mostrar o estado real.
    LaunchedEffect(Unit) { container.printerReady() }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Impressora térmica", onBack = onBack) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(intro, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
            ThermalPrinterContent(
                printer = container.thermalPrinter,
                theme = wabotiaThermalPrinterTheme(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

const val PRINTER_INTRO =
    "A impressora fica neste aparelho: o totem imprime nela o cupom de cada senha. " +
        "Escolha a impressora (Bluetooth, USB ou Wi-Fi) e confirme o comprovante de teste no papel."

/** O tema do kit montado a partir dos tokens do Vinki (DESIGN.md, seção 1): só cores, nunca componentes. */
@Composable
fun wabotiaThermalPrinterTheme(): ThermalPrinterTheme {
    val c = Wb.colors
    return ThermalPrinterTheme(
        usesPrintherLayout = false,
        contentPadding = 16.dp,
        sectionSpacing = 16.dp,
        cardContainerColor = c.surface,
        cardContentColor = c.textPrimary,
        outlineColor = c.hairline,
        accentColor = c.brand,
        onAccentColor = c.onBrand,
        infoContainerColor = c.soft(c.ticket, 0.14f),
        onInfoContainerColor = c.textPrimary,
        successContainerColor = c.soft(c.ok, 0.16f),
        onSuccessContainerColor = c.textPrimary,
        warningContainerColor = c.soft(c.warn, 0.18f),
        onWarningContainerColor = c.textPrimary,
        dangerContainerColor = c.soft(c.danger, 0.14f),
        onDangerContainerColor = c.danger,
    )
}
