package br.com.queven.wabotia.modules.erp

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Leitura do código de barras pela câmera, sem dependência nova: a câmera do sistema tira a foto e o zxing (já usado
 * pelo app no QR do pareamento) procura o código nela, em pé e deitada. EAN-13, EAN-8, UPC, Code 128, Code 39 e ITF.
 */
object ErpBarcodeReader {
    private val FORMATS = listOf(
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.QR_CODE,
    )

    fun decode(bitmap: Bitmap): String? {
        val reader = MultiFormatReader().apply {
            setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to FORMATS, DecodeHintType.TRY_HARDER to true))
        }
        for (angle in listOf(0f, 90f)) {
            val image = if (angle == 0f) bitmap else Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(angle) }, true)
            val pixels = IntArray(image.width * image.height)
            image.getPixels(pixels, 0, image.width, 0, 0, image.width, image.height)
            val found = runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(image.width, image.height, pixels)))).text }.getOrNull()
            reader.reset()
            if (!found.isNullOrBlank()) return found.trim()
        }
        return null
    }

    /** A foto reduzida (lado maior até 1600 px), para caber na memória de qualquer aparelho. */
    fun load(file: File): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1600) sample *= 2
        return BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}

/**
 * Devolve a ação "ler código de barras": pede a câmera, tira a foto e entrega o código lido (ou `null` quando não achou).
 * Sem câmera ou com a permissão negada, [onDenied].
 */
@Composable
fun rememberBarcodeScan(onResult: (String?) -> Unit, onDenied: () -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var path by rememberSaveable { mutableStateOf<String?>(null) }
    val take = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val file = path?.let(::File)
        path = null
        if (file == null) return@rememberLauncherForActivityResult
        if (!ok || !file.exists() || file.length() == 0L) {
            file.delete()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            val code = withContext(Dispatchers.Default) { runCatching { ErpBarcodeReader.load(file)?.let(ErpBarcodeReader::decode) }.getOrNull() }
            file.delete()
            onResult(code)
        }
    }
    fun open() {
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            onDenied()
            return
        }
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "barcode-${System.currentTimeMillis()}.jpg")
        path = file.absolutePath
        try {
            take.launch(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
        } catch (e: Exception) {
            path = null
            onDenied()
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) open() else onDenied() }
    return {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) open()
        else permission.launch(Manifest.permission.CAMERA)
    }
}
