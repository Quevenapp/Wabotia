package br.com.queven.wabotia.device.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** Porta de `Vinki_v4/.../core/devices/PanelTotem.kt`: ordem das chamadas na TV. */
object PanelCalls {
    /** A chamada mais recente primeiro: posição em `recent_calls`, depois a hora. */
    val MOST_RECENT_FIRST: Comparator<StationCall> =
        compareBy<StationCall> { it.recentRank ?: Int.MAX_VALUE }.thenByDescending { it.lastCalledAt ?: it.calledAt ?: "" }

    fun ordered(calls: List<StationCall>): List<StationCall> = calls.sortedWith(MOST_RECENT_FIRST)

    /** O que a TV mostra: quem está sendo chamado. */
    fun onScreen(calls: List<StationCall>): List<StationCall> = ordered(calls.filter { it.status in ON_SCREEN })

    /**
     * A senha do bloco grande ("chamando"): a que a fila de anúncios pôs em destaque ([PanelCallQueue]); sem destaque,
     * a última chamada do `snapshot`.
     */
    fun hero(calls: List<StationCall>, highlight: StationCall?): StationCall? = highlight ?: onScreen(calls).firstOrNull()

    /** As anteriores, do `snapshot` na hora, sem repetir a senha do bloco grande. */
    fun previous(calls: List<StationCall>, highlight: StationCall?, limit: Int): List<StationCall> {
        val hero = hero(calls, highlight)
        return onScreen(calls).filter { it.ticketId != hero?.ticketId }.take(limit)
    }

    const val OTHERS_ON_SCREEN = 6

    private val ON_SCREEN = setOf("calling", "acknowledged")
}

/** A matriz do QR, sem margem: quem desenha põe a zona quieta. */
object QrMatrix {
    fun encode(content: String): List<BooleanArray> {
        val bits =
            QRCodeWriter().encode(
                content,
                BarcodeFormat.QR_CODE,
                0,
                0,
                mapOf(
                    EncodeHintType.MARGIN to 0,
                    EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
                    EncodeHintType.CHARACTER_SET to "UTF-8",
                ),
            )
        return List(bits.height) { y -> BooleanArray(bits.width) { x -> bits[x, y] } }
    }
}
