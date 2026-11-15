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
 * a credencial do aparelho. Quatro ou seis números: quatro são digitados em pé
 * na frente da TV; seis tornam o chute muito mais lento. Guarda-se só o resumo
 * com sal; esquecer o PIN se resolve em Dispositivos, fora do painel.
 */
object PanelPin {
    /** Os tamanhos aceitos. */
    val LENGTHS = listOf(4, 6)
    const val MAX_LENGTH = 6

    /** O que está errado com o PIN escolhido, ou `null` quando serve. */
    fun problem(pin: String): String? {
        if (pin.length !in LENGTHS || !pin.all(Char::isDigit)) {
            // Diz o tamanho mais perto do que foi digitado; o campo já avisa que são 4 ou 6.
            return "O PIN tem ${if (pin.length <= 4) 4 else 6} números."
        }
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

/**
 * Cinco erros seguidos travam o PIN; cada trava seguida espera mais (30 s, 1 min, 5 min, 15 min e, daí em diante,
 * 1 h). Um acerto zera os erros e as travas. Erros e trava ficam em [store] (no aparelho real, `SharedPreferences`):
 * fechar e reabrir o app não zera a contagem.
 */
class PanelPinAttempts(
    private val store: PanelPinAttemptStore = MemoryPanelPinAttemptStore(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun locked(): Boolean = clock() < store.lockedUntil

    /** Quanto falta para destravar, em ms (0 quando não está travado). */
    fun remainingMillis(): Long = (store.lockedUntil - clock()).coerceAtLeast(0)

    /** Conta um erro; devolve até quando fica travado, quando trava. */
    fun fail(): Long? {
        val failures = store.failures + 1
        if (failures < MAX_FAILURES) {
            store.save(failures = failures)
            return null
        }
        val lockouts = store.lockouts
        val until = clock() + lockMillis(lockouts)
        store.save(failures = 0, lockedUntil = until, lockouts = lockouts + 1)
        return until
    }

    fun succeed() {
        store.save(failures = 0, lockedUntil = 0L, lockouts = 0)
    }

    companion object {
        const val MAX_FAILURES = 5
        const val LOCK_MILLIS = 30_000L
        private val WAITS = listOf(LOCK_MILLIS, 60_000L, 5 * 60_000L, 15 * 60_000L, 60 * 60_000L)

        /** A espera da trava de número [lockouts] (0 = a primeira). */
        fun lockMillis(lockouts: Int): Long = WAITS[lockouts.coerceIn(0, WAITS.lastIndex)]

        /** "Aguarde 30 segundos." / "Aguarde 5 minutos." */
        fun waitText(remainingMillis: Long): String {
            val seconds = ((remainingMillis + 999) / 1000).coerceAtLeast(1)
            if (seconds < 60) return "Aguarde $seconds ${if (seconds == 1L) "segundo" else "segundos"}."
            val minutes = (seconds + 59) / 60
            return "Aguarde $minutes ${if (minutes == 1L) "minuto" else "minutos"}."
        }
    }
}

/** Onde ficam os erros seguidos, a trava e quantas travas seguidas já houve. */
interface PanelPinAttemptStore {
    val failures: Int
    val lockedUntil: Long
    val lockouts: Int

    fun save(failures: Int = this.failures, lockedUntil: Long = this.lockedUntil, lockouts: Int = this.lockouts)
}

/** Na demonstração e nos testes: só na memória. */
class MemoryPanelPinAttemptStore : PanelPinAttemptStore {
    override var failures = 0
        private set
    override var lockedUntil = 0L
        private set
    override var lockouts = 0
        private set

    override fun save(failures: Int, lockedUntil: Long, lockouts: Int) {
        this.failures = failures
        this.lockedUntil = lockedUntil
        this.lockouts = lockouts
    }
}

/** O PIN selado de cada aparelho, guardado só neste celular. */
interface PanelPinStore {
    fun sealed(deviceId: String): String?

    /** `null` apaga: é o "Esqueci o PIN" de Dispositivos. */
    fun save(deviceId: String, sealed: String?)
}
