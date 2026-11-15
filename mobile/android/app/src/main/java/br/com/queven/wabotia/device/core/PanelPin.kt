package br.com.queven.wabotia.device.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * O PIN do painel e do totem (pedido do Bruno na bancada, 25/09/2026): quem
 * passa na frente da tela não pode tirar o painel do ar nem calá-lo. Voltar,
 * Voz, Mudo e o atalho da impressora pedem o PIN.
 *
 * O PIN é deste celular, e não do servidor: ele protege os botões da tela, não
 * a credencial do aparelho. Quatro números, porque é digitado em pé na frente
 * da TV. Guarda-se só o resumo com sal; esquecer o PIN se resolve em
 * Dispositivos, fora do painel.
 */
object PanelPin {
    const val LENGTH = 4

    /** O que está errado com o PIN escolhido, ou `null` quando serve. */
    fun problem(pin: String): String? {
        if (pin.length != LENGTH || !pin.all(Char::isDigit)) return "O PIN tem $LENGTH números."
        val digits = pin.map { it - '0' }
        val repeated = digits.distinct().size == 1
        val steps = digits.zipWithNext { a, b -> b - a }.distinct()
        val sequence = steps == listOf(1) || steps == listOf(-1)
        return if (repeated || sequence) "Escolha um PIN menos óbvio." else null
    }

    /** `sal:resumo`, os dois em Base64; o PIN nunca é guardado. */
    fun seal(pin: String): String {
        val salt = ByteArray(16).also(SecureRandom()::nextBytes)
        return "${encode(salt)}:${encode(digest(salt, pin))}"
    }

    fun matches(pin: String, sealed: String): Boolean {
        val parts = sealed.split(':')
        if (parts.size != 2) return false
        val salt = runCatching { Base64.getDecoder().decode(parts[0]) }.getOrNull() ?: return false
        val expected = runCatching { Base64.getDecoder().decode(parts[1]) }.getOrNull() ?: return false
        return MessageDigest.isEqual(expected, digest(salt, pin))
    }

    private fun digest(salt: ByteArray, pin: String): ByteArray {
        // Muitas voltas: quatro números são 10 mil tentativas, e o resumo
        // barato cairia em um instante para quem copiasse o arquivo.
        val sha = MessageDigest.getInstance("SHA-256")
        var value = salt + pin.toByteArray()
        repeat(20_000) { value = sha.digest(salt + value) }
        return value
    }

    private fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
}

/** Cinco erros seguidos travam o PIN por 30 segundos; um acerto zera. */
class PanelPinAttempts(private val clock: () -> Long = System::currentTimeMillis) {
    private var failures = 0
    private var lockedUntil = 0L

    fun locked(): Boolean = clock() < lockedUntil

    /** Conta um erro; devolve até quando fica travado, quando trava. */
    fun fail(): Long? {
        failures += 1
        if (failures < MAX_FAILURES) return null
        failures = 0
        lockedUntil = clock() + LOCK_MILLIS
        return lockedUntil
    }

    fun succeed() {
        failures = 0
    }

    companion object {
        const val MAX_FAILURES = 5
        const val LOCK_MILLIS = 30_000L
    }
}

/** O PIN selado de cada aparelho, guardado só neste celular. */
interface PanelPinStore {
    fun sealed(deviceId: String): String?

    /** `null` apaga: é o "Esqueci o PIN" de Dispositivos. */
    fun save(deviceId: String, sealed: String?)
}
