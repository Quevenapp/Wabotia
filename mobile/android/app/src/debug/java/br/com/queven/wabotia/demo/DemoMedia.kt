package br.com.queven.wabotia.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin

/**
 * Bytes dos anexos da demonstração, gerados no aparelho na primeira vez em que são pedidos
 * (imagem PNG, PDF de uma página, áudio WAV e uma planilha CSV). Nada vem da rede.
 */
internal object DemoMedia {
    /** Os bytes só são gerados quando alguém pede o tamanho ou o conteúdo (fora da thread principal). */
    class Entry(val id: String, val name: String, val type: String, provider: () -> ByteArray) {
        val bytes: ByteArray by lazy(provider)
        val size: Long get() = bytes.size.toLong()
    }

    const val IMAGE_ID = "m-painel"
    const val PDF_ID = "m-proposta"
    const val VOICE_ID = "m-voz"
    const val REPORT_ID = "m-relatorio"

    val dashboardPng: ByteArray by lazy { runCatching { drawDashboard() }.getOrElse { tinyPng() } }
    val proposalPdf: ByteArray by lazy { runCatching { drawProposal() }.getOrElse { minimalPdf() } }
    val voiceWav: ByteArray by lazy { synthesizeVoice() }
    val reportCsv: ByteArray by lazy {
        buildString {
            append("data;pedidos;faturamento;ticket_medio\n")
            append("01/10;4;1.612,00;403,00\n")
            append("08/10;31;12.954,90;417,90\n")
            append("15/10;29;11.890,00;410,00\n")
            append("22/10;34;14.212,00;418,00\n")
            append("29/10;30;12.105,10;403,50\n")
            append("total;128;52.774,00;412,30\n")
        }.toByteArray(Charsets.UTF_8)
    }

    /** Anexos fixos das conversas e das execuções de bot. */
    fun fixtures(): List<Entry> = listOf(
        Entry(IMAGE_ID, "painel-atual.png", "image/png") { dashboardPng },
        Entry(PDF_ID, "Proposta-Queven.pdf", "application/pdf") { proposalPdf },
        Entry(VOICE_ID, "voz-demo.wav", "audio/wav") { voiceWav },
        Entry(REPORT_ID, "relatorio-vendas-outubro.csv", "text/csv") { reportCsv },
    )

    // --- imagem: um "painel" fictício sobre degradê ---

    private fun drawDashboard(): ByteArray {
        val w = 800
        val h = 600
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.shader = LinearGradient(
            0f, 0f, w.toFloat(), h.toFloat(),
            intArrayOf(0xFF0E3B43.toInt(), 0xFF17665F.toInt(), 0xFF35A88A.toInt()), null, Shader.TileMode.CLAMP,
        )
        c.drawRect(0f, 0f, w.toFloat(), h.toFloat(), p)
        p.shader = null

        // barra lateral
        p.color = 0x30FFFFFF
        c.drawRoundRect(RectF(24f, 24f, 176f, 576f), 22f, 22f, p)
        p.color = 0xFFFFFFFF.toInt()
        c.drawCircle(64f, 68f, 18f, p)
        for (i in 0 until 6) {
            p.color = if (i == 1) 0xD9FFFFFF.toInt() else 0x4DFFFFFF
            c.drawRoundRect(RectF(44f, 120f + i * 52f, 156f, 148f + i * 52f), 12f, 12f, p)
        }

        // título
        p.color = 0xFFFFFFFF.toInt()
        p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        p.textSize = 30f
        c.drawText("Painel de atendimento", 204f, 66f, p)
        p.typeface = Typeface.DEFAULT
        p.textSize = 17f
        p.color = 0xCCFFFFFF.toInt()
        c.drawText("Outubro · 12 atendentes", 204f, 92f, p)

        // cartões de indicadores
        val accents = intArrayOf(0xFF25D366.toInt(), 0xFFF59E0B.toInt(), 0xFF53BDEB.toInt())
        val values = arrayOf("1.284", "07:42", "96%")
        val labels = arrayOf("Conversas", "Tempo médio", "Satisfação")
        for (i in 0..2) {
            val left = 204f + i * 192f
            p.color = 0xF5FFFFFF.toInt()
            c.drawRoundRect(RectF(left, 116f, left + 176f, 222f), 18f, 18f, p)
            p.color = accents[i]
            c.drawRoundRect(RectF(left + 16f, 134f, left + 22f, 204f), 3f, 3f, p)
            p.color = 0xFF667781.toInt()
            p.textSize = 16f
            c.drawText(labels[i], left + 36f, 152f, p)
            p.color = 0xFF111B21.toInt()
            p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            p.textSize = 34f
            c.drawText(values[i], left + 36f, 196f, p)
            p.typeface = Typeface.DEFAULT
        }

        // gráfico
        p.color = 0xF5FFFFFF.toInt()
        c.drawRoundRect(RectF(204f, 244f, 776f, 576f), 20f, 20f, p)
        p.color = 0xFF111B21.toInt()
        p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        p.textSize = 19f
        c.drawText("Atendimentos por dia", 228f, 284f, p)
        p.typeface = Typeface.DEFAULT
        p.color = 0xFFE9EDEF.toInt()
        for (i in 0..3) c.drawRect(228f, 320f + i * 56f, 752f, 322f + i * 56f, p)
        val bars = floatArrayOf(0.42f, 0.58f, 0.5f, 0.74f, 0.66f, 0.88f, 0.61f, 0.79f, 0.95f, 0.7f)
        for ((i, v) in bars.withIndex()) {
            val left = 240f + i * 52f
            val top = 544f - v * 220f
            p.color = if (i == 8) 0xFF008069.toInt() else 0xFF8ED7C3.toInt()
            c.drawRoundRect(RectF(left, top, left + 30f, 544f), 8f, 8f, p)
        }
        val line = Path()
        for ((i, v) in bars.withIndex()) {
            val x = 255f + i * 52f
            val y = 520f - v * 150f - 40f
            if (i == 0) line.moveTo(x, y) else line.lineTo(x, y)
        }
        p.style = Paint.Style.STROKE
        p.strokeWidth = 4f
        p.strokeCap = Paint.Cap.ROUND
        p.strokeJoin = Paint.Join.ROUND
        p.color = 0xFFF59E0B.toInt()
        c.drawPath(line, p)
        p.style = Paint.Style.FILL

        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    private fun tinyPng(): ByteArray =
        java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

    // --- PDF: proposta comercial de uma página ---

    private fun drawProposal(): ByteArray {
        val doc = PdfDocument()
        val page = doc.startPage(PdfDocument.PageInfo.Builder(595, 842, 1).create())
        val c = page.canvas
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.shader = LinearGradient(0f, 0f, 595f, 150f, 0xFF00A884.toInt(), 0xFF075E54.toInt(), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, 595f, 150f, p)
        p.shader = null
        p.color = 0xFFFFFFFF.toInt()
        p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        p.textSize = 28f
        c.drawText("Proposta comercial", 48f, 78f, p)
        p.typeface = Typeface.DEFAULT
        p.textSize = 14f
        c.drawText("Queven Atendimento · Plano Empresarial", 48f, 106f, p)

        p.color = 0xFF111B21.toInt()
        p.textSize = 13f
        var y = 200f
        val lines = listOf(
            "Cliente: Costa & Filhos Contabilidade",
            "Contato: Mariana Costa · +55 11 98765-4321",
            "",
            "Plano Empresarial para 20 atendentes",
            "  • WhatsApp oficial (API) com dois números",
            "  • Bots de vendas e de suporte incluídos",
            "  • Protocolos, setores, menus e ligações de voz",
            "  • Migração do histórico e treinamento da equipe",
            "",
            "Investimento mensal: R$ 1.490,00",
            "Implantação: R$ 0,00 (desconto de parceiro Fagoo)",
            "Validade desta proposta: 15 dias",
        )
        for (line in lines) {
            c.drawText(line, 48f, y, p)
            y += 24f
        }
        p.color = 0xFFE9EDEF.toInt()
        c.drawRect(48f, y + 8f, 547f, y + 9f, p)
        p.color = 0xFF667781.toInt()
        p.textSize = 11f
        c.drawText("Documento de demonstração gerado no aparelho. Valores fictícios.", 48f, y + 34f, p)
        doc.finishPage(page)
        val out = ByteArrayOutputStream()
        doc.writeTo(out)
        doc.close()
        return out.toByteArray()
    }

    /** PDF mínimo válido (uma página em branco com um título), usado só se o PdfDocument falhar. */
    private fun minimalPdf(): ByteArray {
        val objects = listOf(
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "STREAM",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        )
        val stream = "BT /F1 24 Tf 60 760 Td (Proposta comercial Queven) Tj ET"
        val sb = StringBuilder("%PDF-1.4\n")
        val offsets = ArrayList<Int>()
        for ((i, body) in objects.withIndex()) {
            offsets += sb.length
            sb.append("${i + 1} 0 obj\n")
            if (body == "STREAM") sb.append("<< /Length ${stream.length} >>\nstream\n$stream\nendstream\n") else sb.append(body).append('\n')
            sb.append("endobj\n")
        }
        val xref = sb.length
        sb.append("xref\n0 ${objects.size + 1}\n0000000000 65535 f \n")
        for (offset in offsets) sb.append(offset.toString().padStart(10, '0')).append(" 00000 n \n")
        sb.append("trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        return sb.toString().toByteArray(Charsets.ISO_8859_1)
    }

    // --- áudio: 6 s de tom suave com cadência de fala, WAV PCM 16 kHz mono ---

    private fun synthesizeVoice(): ByteArray {
        val rate = 16_000
        val seconds = 6
        val samples = rate * seconds
        val data = ByteBuffer.allocate(samples * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until samples) {
            val t = i / rate.toDouble()
            // "sílabas": envelope lento e pausas curtas, para o player ter o que mostrar.
            val syllable = sin(2 * PI * 2.6 * t).let { if (it > 0) it else 0.0 }
            val phrase = 0.55 + 0.45 * sin(2 * PI * 0.35 * t)
            val pitch = 190.0 + 35.0 * sin(2 * PI * 0.7 * t)
            val tone = 0.6 * sin(2 * PI * pitch * t) + 0.25 * sin(2 * PI * pitch * 2 * t) + 0.15 * sin(2 * PI * pitch * 3 * t)
            val fade = minOf(1.0, t / 0.15, (seconds - t) / 0.25)
            data.putShort((tone * syllable * phrase * fade * 0.28 * Short.MAX_VALUE).toInt().toShort())
        }
        val pcm = data.array()
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + pcm.size)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)
        header.putShort(1) // PCM
        header.putShort(1) // mono
        header.putInt(rate)
        header.putInt(rate * 2)
        header.putShort(2)
        header.putShort(16)
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(pcm.size)
        return header.array() + pcm
    }
}
