package br.com.queven.wabotia.device.core

import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Os cinco templates dos painéis (decisão 17, `docs/decisoes.md`; protótipo em
 * `Vinki_v3/docs/design/telas-v2-2026-10-31/`). Cada um tem fonte, paleta e
 * grade próprias, desenhadas para leitura a distância em tela pequena. A
 * escolha é deste aparelho: fica no celular, como o som, e não passa pelo
 * servidor. O identificador é estável, porque fica gravado no aparelho.
 */
enum class PanelTemplate(val id: String, val label: String, val fontLabel: String, val fit: String) {
    SINAL("sinal", "Sinal", "Overpass", "Salão grande, gente andando"),
    CLINICA("clinica", "Clínica", "Atkinson Hyperlegible", "Saúde, idosos, baixa visão"),
    TERMINAL("terminal", "Terminal", "B612", "TV na parede, pouca luz"),
    VITRINE("vitrine", "Vitrine", "Anton e Archivo", "Lanchonete, pedidos"),
    SOL("sol", "Sol", "Lexend", "Ambiente muito claro"),
    ;

    companion object {
        val DEFAULT = SINAL

        /** Identificador desconhecido (inclusive o antigo "balcao") volta ao padrão. */
        fun fromId(id: String?): PanelTemplate = entries.firstOrNull { it.id == id } ?: DEFAULT
    }
}

/** O template escolhido por aparelho, guardado só neste celular. */
interface PanelTemplateStore {
    fun template(deviceId: String): PanelTemplate

    fun setTemplate(deviceId: String, template: PanelTemplate)
}

class InMemoryPanelTemplateStore : PanelTemplateStore {
    private val chosen = mutableMapOf<String, PanelTemplate>()

    override fun template(deviceId: String): PanelTemplate = chosen[deviceId] ?: PanelTemplate.DEFAULT

    override fun setTemplate(deviceId: String, template: PanelTemplate) {
        chosen[deviceId] = template
    }
}

/**
 * O destino da chamada em duas partes: o rótulo pequeno ("Guichê") e o valor
 * grande ("3"). O número curto no fim é o que a pessoa procura na sala; sem
 * ele, o destino inteiro vira o valor e o rótulo diz a direção.
 */
object PanelDestination {
    data class Parts(val label: String, val value: String, val long: Boolean)

    private const val DIRECTION = "Dirija-se ao"
    private const val FALLBACK = "Balcão"

    fun split(stationLabel: String?): Parts {
        val text = stationLabel?.trim().orEmpty()
        if (text.isEmpty()) return Parts(DIRECTION, FALLBACK, long = true)
        val cut = text.lastIndexOf(' ')
        if (cut > 0) {
            val token = text.substring(cut + 1)
            if (token.length in 1..3 && token.any(Char::isDigit)) {
                return Parts(text.substring(0, cut).trim(), token, long = false)
            }
        }
        return Parts(DIRECTION, text, long = text.length > 3)
    }
}

/** A letra da fila é o começo da senha ("B042"); pedido numérico não tem letra. */
object PanelQueueLetter {
    fun of(publicNumber: String): Char? = publicNumber.firstOrNull()?.takeIf(Char::isLetter)?.uppercaseChar()

    /**
     * A cor da fila (0 a 3) vem só da letra, para a mesma fila ter a mesma cor
     * no totem, no painel e no híbrido. As iniciais de fila mais comuns no
     * balcão (Atendimento, Geral, Caixa, Preferencial, Encomendas, Normal,
     * Retirada, Balcão) têm lugar fixo, para Caixa e Geral, ou Geral e
     * Preferencial, nunca dividirem a cor; as outras letras seguem o código.
     */
    fun colorIndex(letter: Char?): Int {
        val upper = letter?.uppercaseChar() ?: return 0
        val fixed = COMMON.indexOf(upper)
        return if (fixed >= 0) fixed % 4 else upper.code % 4
    }

    private const val COMMON = "AGCPENRB"
}

/** A hora de uma chamada, no fuso do aparelho, para o quadro de chamadas anteriores. */
object PanelClock {
    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")

    fun hhmm(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String? =
        iso?.let { runCatching { OffsetDateTime.parse(it).atZoneSameInstant(zone).format(HHMM) }.getOrNull() }
}
