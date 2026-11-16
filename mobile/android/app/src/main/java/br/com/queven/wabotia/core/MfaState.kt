package br.com.queven.wabotia.core

import br.com.queven.wabotia.core.model.SessionMfa
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** O que a tela global do segundo fator mostra. */
enum class MfaPrompt {
    /** "Confirme que é você": a pessoa tem fator; o código sobe a sessão para aal2 por 7 dias. */
    CHALLENGE,
    /** A instalação exige (ou a ação pede) o segundo fator e a pessoa ainda não cadastrou: vai para o cadastro. */
    ENROLL,
}

/**
 * O segundo fator da sessão de pessoa (docs/API.md, "Login e segundo fator", feat/login-mfa 4f4be1e). Qualquer chamada
 * pode responder `403 mfa_required` (ação que exige aal2, ou a política `all` com a sessão em aal1): a tela global abre
 * o desafio, ou o cadastro quando a pessoa não tem fator. Nunca desloga. O prazo de 7 dias e a renovação ficam com o
 * servidor; o app só guarda o que ele disse por último.
 */
class MfaState(private val container: AppContainer) {
    private val _prompt = MutableStateFlow<MfaPrompt?>(null)
    val prompt: StateFlow<MfaPrompt?> = _prompt.asStateFlow()

    private val _confirmed = MutableStateFlow(0)
    /** Sobe a cada confirmação: as telas que quiserem repetem a última leitura. */
    val confirmed: StateFlow<Int> = _confirmed.asStateFlow()

    /** `true`/`false` pelo que o servidor disse (login ou `/me`); `null` = não se sabe (servidor sem o recurso). */
    @Volatile var hasFactor: Boolean? = null
        private set
    @Volatile var aal: Int? = null
        private set
    @Volatile var policy: String? = null
        private set

    /** Resposta do login ou de `/me`. `next: enroll` abre o cadastro logo depois de entrar. */
    fun update(aal: Int?, mfa: SessionMfa?) {
        aal?.let { this.aal = it }
        mfa?.factor?.let { hasFactor = it }
        mfa?.policy?.let { policy = it }
        if (mfa?.next == "enroll") _prompt.value = MfaPrompt.ENROLL
    }

    /** Um `403 mfa_required` em qualquer tela. Sem saber se a pessoa tem fator, lê `/me` antes de escolher. */
    fun required() {
        if (hasFactor != null) return open()
        container.scope.launch {
            refresh()
            open()
        }
    }

    private fun open() {
        _prompt.update { it ?: if (hasFactor == false) MfaPrompt.ENROLL else MfaPrompt.CHALLENGE }
    }

    /** Se a pessoa tem fator, lendo `/me` quando ainda não se sabe. */
    suspend fun factorKnown(): Boolean? {
        if (hasFactor == null) refresh()
        return hasFactor
    }

    /** O desafio respondeu `mfa_not_enrolled`: não há fator; o cadastro abre. */
    fun notEnrolled() {
        hasFactor = false
        _prompt.value = MfaPrompt.ENROLL
    }

    /** `/me`: o nível efetivo (já com o prazo) e se a pessoa tem fator. Sem rede ou servidor antigo, fica o que se sabia. */
    suspend fun refresh() {
        try {
            container.api.me().let { update(it.aal, it.mfa) }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    fun dismiss() {
        _prompt.value = null
    }

    /** O código do autenticador (ou de recuperação) sobe a sessão para aal2. Erro sobe para quem chamou mostrar. */
    suspend fun challenge(code: String) {
        try {
            container.api.mfaChallenge(body(code))
        } catch (e: br.com.queven.wabotia.core.net.ApiException) {
            if (e.code == "mfa_not_enrolled") notEnrolled()
            throw e
        }
        onRaised()
    }

    /** Fator cadastrado e ativo nesta sessão (o `verify` já sobe para aal2). */
    fun onEnrolled() {
        hasFactor = true
        onRaised()
    }

    fun onRemoved() {
        hasFactor = false
        aal = 1
    }

    private fun onRaised() {
        aal = 2
        _prompt.value = null
        _confirmed.update { it + 1 }
    }

    fun clear() {
        _prompt.value = null
        hasFactor = null
        aal = null
        policy = null
    }

    companion object {
        /** `{code}` com os 6 dígitos do autenticador; o resto vai como `{recovery_code}`. */
        fun body(code: String): JsonObject {
            val clean = code.trim().replace(" ", "")
            return buildJsonObject { if (clean.length == 6 && clean.all(Char::isDigit)) put("code", clean) else put("recovery_code", code.trim()) }
        }
    }
}
