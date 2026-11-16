package br.com.queven.wabotia.printing

import java.text.Normalizer

/**
 * Saneamento de todo texto que vai para o papel. A impressora térmica fala uma página de código de byte único (CP850
 * por padrão no ThermalPrinterKit): ASCII, as letras acentuadas do português, ç, ª e º. O que fica fora disso o kit
 * troca por "?" — foi assim que "2 pessoas à sua frente · cerca de 8 min" saiu com "?" no lugar do ponto médio
 * (cupom N004, 16/11). Nome da empresa, endereço e rodapé chegam livres do servidor, então tudo passa por aqui:
 * pontuação tipográfica vira o equivalente ASCII, espaços especiais viram espaço, e o resto (emoji, símbolos) sai.
 * Nunca sobra caractere que vire "?".
 */
object PaperText {
    /** Equivalentes ASCII da pontuação e dos símbolos que aparecem em texto digitado no celular. */
    private val replacements: Map<Int, String> = buildMap {
        // Separadores e traços.
        listOf(0x00B7, 0x2022, 0x2219, 0x2027, 0x22C5, 0x30FB, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x2043, 0x25CF, 0x25E6)
            .forEach { put(it, "-") }
        // Aspas.
        listOf(0x201C, 0x201D, 0x201E, 0x201F, 0x00AB, 0x00BB, 0x2033, 0x02DD).forEach { put(it, "\"") }
        listOf(0x2018, 0x2019, 0x201A, 0x201B, 0x2032, 0x00B4, 0x02BC, 0x2039, 0x203A).forEach { put(it, "'") }
        put(0x2026, "...")
        // Grau vira o ordinal, que todas as páginas do kit imprimem ("1°" e "1º" se confundem no papel).
        put(0x00B0, "º")
        put(0x00D7, "x")
        put(0x00F7, "/")
        put(0x2044, "/")
        put(0x00BD, "1/2")
        put(0x00BC, "1/4")
        put(0x00BE, "3/4")
        put(0x20AC, "EUR")
        put(0x00A9, "(c)")
        put(0x00AE, "(R)")
        put(0x2122, "TM")
        put(0x2116, "No")
        put(0x2192, "->")
        put(0x2190, "<-")
        put(0x2713, "v")
        put(0x2714, "v")
        put(0x00A7, "S")
        put(0x00B9, "1")
        put(0x00B2, "2")
        put(0x00B3, "3")
    }

    /** O que a página de código imprime além do ASCII: as letras do português e os ordinais. */
    private const val KEEP = "áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇªº"

    /**
     * [tidy] junta espaços dobrados e apara as pontas de cada linha (o que sobra de um emoji removido). Linhas
     * alinhadas em colunas com espaços (comanda do pedido, valores do orçamento) passam `tidy = false`.
     */
    fun clean(text: String, tidy: Boolean = true): String {
        val normalized = Normalizer.normalize(text, Normalizer.Form.NFC)
        val out = StringBuilder(normalized.length)
        var i = 0
        while (i < normalized.length) {
            val cp = normalized.codePointAt(i)
            i += Character.charCount(cp)
            when {
                cp == '\n'.code -> out.append('\n')
                cp in 0x20..0x7E -> out.appendCodePoint(cp)
                cp.toChar().let { cp <= 0xFFFF && it in KEEP } -> out.appendCodePoint(cp)
                cp == '\t'.code || Character.isSpaceChar(cp) -> out.append(' ')
                replacements.containsKey(cp) -> out.append(replacements.getValue(cp))
                else -> out.append(fold(cp))
            }
        }
        // Remoções podem deixar espaços dobrados ou nas pontas ("Volte sempre 😊" → "Volte sempre").
        if (!tidy) return out.toString()
        return out.toString().lines().joinToString("\n") { it.replace(Regex(" {2,}"), " ").trim() }
    }

    /** Letra acentuada fora do português ("ñ", "ë"): só a letra base. Emoji, símbolo ou controle: nada. */
    private fun fold(cp: Int): String {
        if (Character.getType(cp) == Character.NON_SPACING_MARK.toInt()) return ""
        val decomposed = Normalizer.normalize(String(Character.toChars(cp)), Normalizer.Form.NFD)
        val base = decomposed.filter { it.code in 0x20..0x7E }
        val onlyMarks = decomposed.drop(base.length).all { Character.getType(it) == Character.NON_SPACING_MARK.toInt() }
        return if (base.isNotEmpty() && Character.isLetter(cp) && onlyMarks) base else ""
    }
}
