package br.com.queven.wabotia.demo

import kotlinx.serialization.json.JsonObject

/**
 * O segundo fator da pessoa na demonstração (contrato de feat/login-mfa): começa sem fator, com a política
 * `financial`. O cadastro mostra um segredo fictício; o código do "autenticador" é sempre 123456. Com o fator ativo, o
 * login da prévia (`--es demo auth-login`) pede o código. A confirmação vale 7 dias, como no `wabu_`.
 */
internal class DemoAccount {
    private var factorActive = false
    private var pending = false
    private var aal2Until = 0L
    private val recovery = mutableListOf<String>()

    val hasFactor: Boolean get() = factorActive

    fun aal(now: Long) = if (now < aal2Until) 2 else 1

    fun mfaJson() = j("factor" to factorActive, "policy" to POLICY)

    /** Login: com fator, sem código → 401 mfa_required; código errado → 401 invalid_code; certo → sessão aal2. */
    fun login(body: JsonObject, now: Long): Reply? {
        if (!factorActive) return null
        val totp = body.str("totp")
        val recoveryCode = body.str("recovery_code")
        if (totp == null && recoveryCode == null) return Reply.error(401, "mfa_required", "Digite o código do autenticador.")
        if (!accept(totp ?: recoveryCode.orEmpty())) return Reply.error(401, "invalid_code", "Código errado ou já usado.")
        aal2Until = now + SEVEN_DAYS
        return null
    }

    fun route(method: String, r: List<String>, body: JsonObject, now: Long): Reply = when {
        r == listOf("mfa") && method == "GET" -> Reply.json(status(now))
        r == listOf("mfa", "enroll") && method == "POST" -> {
            if (body.str("password").isNullOrBlank()) Reply.error(400, "invalid", "Digite a sua senha.")
            else if (factorActive && aal(now) < 2) Reply.error(403, "mfa_required", "Confirme o código atual antes de trocar o fator.")
            else {
                pending = true
                Reply.json(j("factor_id" to FACTOR_ID, "secret" to SECRET, "otpauth_url" to "otpauth://totp/Wabotia:${DemoMode.USER_EMAIL}?secret=$SECRET&issuer=Wabotia"))
            }
        }
        r == listOf("mfa", "verify") && method == "POST" -> {
            if (!pending || body.str("factor_id") != FACTOR_ID) Reply.error(400, "factor_not_found", "Comece o cadastro de novo.")
            else if (body.str("code") != CODE) Reply.error(401, "invalid_code", "Código errado. Na demonstração, use $CODE.")
            else {
                factorActive = true
                pending = false
                aal2Until = now + SEVEN_DAYS
                Reply.json(j("aal" to 2, "recovery_codes" to newCodes()))
            }
        }
        r == listOf("mfa", "challenge") && method == "POST" -> challenge(body, now)
        r == listOf("mfa", "recovery-codes") && method == "POST" ->
            if (aal(now) < 2) Reply.error(403, "mfa_required", "Confirme que é você.") else Reply.json(j("recovery_codes" to newCodes()))
        r.size == 3 && r[0] == "mfa" && r[1] == "factors" && method == "DELETE" -> {
            if (aal(now) < 2) Reply.error(403, "mfa_required", "Confirme que é você.")
            else {
                factorActive = false
                aal2Until = 0
                recovery.clear()
                Reply.json(j("ok" to true))
            }
        }
        r.isEmpty() && method == "GET" -> Reply.json(j("mfa" to status(now)))
        else -> Reply.error(404, "not_found", "Rota não encontrada.")
    }

    /** `POST /account/mfa/challenge`: sem fator, 400 mfa_not_enrolled; código certo, aal2 por 7 dias. */
    fun challenge(body: JsonObject, now: Long): Reply {
        if (!factorActive) return Reply.error(400, "mfa_not_enrolled", "Nenhum segundo fator cadastrado.")
        val code = body.str("code") ?: body.str("recovery_code")
        if (code == null || !accept(code)) return Reply.error(401, "invalid_code", "Código não aceito. Na demonstração, use $CODE.")
        aal2Until = now + SEVEN_DAYS
        return Reply.json(j("aal" to 2))
    }

    private fun accept(code: String): Boolean = code.trim() == CODE || recovery.remove(code.trim())

    private fun status(now: Long) = j(
        "policy" to POLICY,
        "aal" to aal(now),
        "factors" to if (factorActive) listOf(j("id" to FACTOR_ID, "kind" to "totp", "status" to "active", "created" to now, "activated_at" to now)) else emptyList<Any>(),
        "recovery_codes_left" to recovery.size,
    )

    private fun newCodes(): List<String> {
        recovery.clear()
        repeat(10) { i -> recovery += "demo-%04d-%04d".format(1000 + i * 37, 2000 + i * 53) }
        return recovery.toList()
    }

    companion object {
        const val CODE = "123456"
        const val POLICY = "financial"
        private const val FACTOR_ID = "fct-demo"
        /** Segredo fictício (base32 de exemplo), só da demonstração. */
        private const val SECRET = "JBSWY3DPEHPK3PXP"
        private const val SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000L
    }
}
