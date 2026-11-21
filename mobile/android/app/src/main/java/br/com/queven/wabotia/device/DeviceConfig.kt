package br.com.queven.wabotia.device

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.serialization.Serializable
import java.security.KeyStore
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** O que este aparelho faz na fila. O guichê não está aqui: ele fica no app logado, com o token da pessoa. */
enum class DeviceRole(val label: String, val detail: String, val totem: Boolean, val panel: Boolean) {
    TOTEM("Totem", "Retirar senha e imprimir o cupom", totem = true, panel = false),
    PANEL("Painel de chamadas", "TV com as senhas chamadas, voz e gongo", totem = false, panel = true),
    HYBRID("Painel híbrido", "Totem e chamadas na mesma tela", totem = true, panel = true),
}

/**
 * A ligação deste aparelho com o Vinki, separada da sessão de pessoa: o token é `wab_…` do pareamento
 * (`client=senhapp`), nunca o `wabu_…` de quem entra no app. Sair da conta não desfaz o aparelho, e desfazer o aparelho
 * não mexe na conta.
 */
@Serializable
data class DeviceConfig(
    val deviceId: String,
    val baseUrl: String,
    val token: String,
    val profileId: String,
    val name: String,
    val role: DeviceRole? = null,
    /** O que o administrador aprovou; `null` quando o servidor não informou. */
    val scopes: List<String>? = null,
    /** Aparelho da demonstração: vive só na memória e nunca toca a rede. */
    val demo: Boolean = false,
) {
    fun allows(scope: String): Boolean = scopes?.contains(scope) ?: true

    /** O painel some com os botões do totem quando o administrador não aprovou emitir senhas. */
    fun canIssue(): Boolean = allows(br.com.queven.wabotia.queue.DeviceScopes.ISSUE)

    override fun toString(): String = "DeviceConfig(deviceId=$deviceId, profileId=$profileId, role=$role, token=[REDACTED])"
}

interface DeviceConfigStore {
    fun load(): DeviceConfig?

    fun save(config: DeviceConfig?)
}

/** Para a demonstração e para os testes: nada vai para o disco. */
class MemoryDeviceConfigStore(private var config: DeviceConfig? = null) : DeviceConfigStore {
    override fun load(): DeviceConfig? = config

    override fun save(config: DeviceConfig?) {
        this.config = config
    }
}

/**
 * Guarda a configuração cifrada com AES-GCM numa chave do Android Keystore (não exportável), num arquivo próprio,
 * longe de `wabotia.secure` (sessão da pessoa). Desinstalar ou limpar os dados apaga o vínculo; o administrador revoga
 * em Integrações.
 */
class KeystoreDeviceConfigStore(context: Context) : DeviceConfigStore {
    private val preferences = context.applicationContext.getSharedPreferences("wabotia.device", Context.MODE_PRIVATE)

    override fun load(): DeviceConfig? {
        val sealed = preferences.getString(KEY, null) ?: return null
        return runCatching {
            val bytes = Base64.getDecoder().decode(sealed)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            val json = String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            WabotiaJson.decodeFromString(DeviceConfig.serializer(), json)
        }.getOrNull()
    }

    override fun save(config: DeviceConfig?) {
        if (config == null || config.demo) {
            preferences.edit().remove(KEY).commit()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val body = cipher.doFinal(WabotiaJson.encodeToString(DeviceConfig.serializer(), config).toByteArray(Charsets.UTF_8))
        preferences.edit().putString(KEY, Base64.getEncoder().encodeToString(cipher.iv + body)).commit()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val KEY = "config"
        const val ALIAS = "wabotia-device"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}

fun newDeviceId(): String = UUID.randomUUID().toString()
