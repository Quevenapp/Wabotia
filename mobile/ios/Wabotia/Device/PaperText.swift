import Foundation

/// Texto que vai para o papel térmico. A impressora imprime ASCII e, na página de código do perfil (CP850 na de
/// balcão), os acentos do português, ç, ª e º; o resto o kit troca por "?" — foi o que saiu no cupom no lugar do ponto
/// médio de "2 pessoas à sua frente · cerca de 8 min". Nome da empresa, rodapé e comanda vêm livres do servidor, então
/// todo texto do papel passa por aqui antes de quebrar em linhas: o que tem equivalente vira ASCII (aspas curvas,
/// travessão, reticências, ponto médio, letras de outras línguas sem o acento) e o resto (emoji, símbolos) sai.
/// Nunca sobra "?" que não estava no texto.
enum PaperText {
    /// Fora do ASCII, só o que a página de código imprime: os acentos do português, ç, ª e º.
    static let kept: Set<Character> = Set("áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇªº")

    static let replacements: [Character: String] = [
        "\u{201C}": "\"", "\u{201D}": "\"", "\u{201E}": "\"", "\u{201F}": "\"", "\u{00AB}": "\"", "\u{00BB}": "\"", "\u{2033}": "\"",
        "\u{2018}": "'", "\u{2019}": "'", "\u{201A}": "'", "\u{201B}": "'", "\u{2032}": "'", "\u{00B4}": "'",
        "\u{2010}": "-", "\u{2011}": "-", "\u{2012}": "-", "\u{2013}": "-", "\u{2014}": "-", "\u{2015}": "-", "\u{2212}": "-",
        "\u{2026}": "...",
        "\u{00B7}": "-", "\u{2022}": "-", "\u{2219}": "-", "\u{25CF}": "-", "\u{25AA}": "-", "\u{2023}": "-",
        "\u{00B0}": "o", "\u{20AC}": "EUR", "\u{00D7}": "x", "\u{00F7}": "/",
        "\u{00BD}": "1/2", "\u{00BC}": "1/4", "\u{00BE}": "3/4", "\u{00B9}": "1", "\u{00B2}": "2", "\u{00B3}": "3",
        "\u{2122}": "TM", "\u{00A9}": "(c)", "\u{00AE}": "(R)", "\u{2192}": "->", "\u{2190}": "<-",
    ]

    /// Limpa o texto inteiro, linha a linha (as quebras ficam).
    static func clean(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { cleanLine(String($0)) }.joined(separator: "\n")
    }

    private static func cleanLine(_ line: String) -> String {
        var out = ""
        var dropped = false
        for c in line {
            if c == "\r" { continue }
            if let ascii = c.asciiValue, ascii >= 0x20, ascii < 0x7F {
                // Um espaço logo depois de um caractere tirado, encostado em outro espaço, também sai ("a 😊 b" → "a b").
                if c == " ", dropped, out.last == " " { dropped = false; continue }
                out.append(c)
            } else if c == "\t" || c.unicodeScalars.allSatisfy({ $0.properties.isWhitespace }) {
                if !(dropped && out.last == " ") { out.append(" ") }
            } else if kept.contains(c) {
                out.append(c)
            } else if let swap = replacements[c] {
                out += swap
            } else if let folded = String(c).applyingTransform(.stripDiacritics, reverse: false),
                      !folded.isEmpty, folded.allSatisfy({ ($0.asciiValue ?? 0) >= 0x20 && ($0.asciiValue ?? 0x7F) < 0x7F }) {
                out += folded
            } else {
                dropped = true
                continue
            }
            if c != " " { dropped = false }
        }
        // Só o fim da linha: o começo pode ser recuo de coluna (comanda).
        while out.last == " " { out.removeLast() }
        return out
    }
}
