package br.com.queven.wabotia.device.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import br.com.queven.wabotia.device.core.QrMatrix

/**
 * O QR de um endereço do Vinki, desenhado módulo a módulo: preto sobre branco,
 * com zona quieta, sem marca no meio (manual de identidade §4).
 */
@Composable
fun QrMatrixImage(
    content: String,
    description: String,
    modifier: Modifier = Modifier,
    size: Dp = 220.dp,
) {
    val matrix = remember(content) { QrMatrix.encode(content) }
    Canvas(
        modifier =
            modifier
                .background(Color.White)
                .padding(16.dp)
                .size(size)
                .semantics { contentDescription = description },
    ) {
        val cell = this.size.width / matrix.size
        matrix.forEachIndexed { y, row ->
            row.forEachIndexed { x, dark ->
                if (dark) {
                    drawRect(
                        color = Color.Black,
                        topLeft = Offset(x * cell, y * cell),
                        size = Size(cell + 0.5f, cell + 0.5f),
                    )
                }
            }
        }
    }
}
