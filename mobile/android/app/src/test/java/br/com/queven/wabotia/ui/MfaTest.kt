package br.com.queven.wabotia.ui

import br.com.queven.wabotia.core.MfaState
import br.com.queven.wabotia.core.model.Me
import br.com.queven.wabotia.core.model.MobileLoginRequest
import br.com.queven.wabotia.core.model.DeviceInfo
import br.com.queven.wabotia.core.model.MobileSession
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.demo.DemoAccount
import br.com.queven.wabotia.demo.j
import br.com.queven.wabotia.queue.ModuleCapabilities
import br.com.queven.wabotia.ui.auth.LoginTexts
import br.com.queven.wabotia.ui.settings.MfaTexts
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Login em duas etapas, elevação sob demanda e cadastro do segundo fator (feat/login-mfa 4f4be1e). */
class MfaTest {
    @Test fun loginMandaOCodigoSoNaSegundaEtapa() {
        val device = DeviceInfo(name = "Teste", app_version = "1")
        val first = WabotiaJson.encodeToString(MobileLoginRequest.serializer(), MobileLoginRequest("a@b.c", "s", device))
        assertFalse(first.contains("totp") || first.contains("recovery_code"))
        val second = WabotiaJson.encodeToString(MobileLoginRequest.serializer(), MobileLoginRequest("a@b.c", "s", device, totp = "123456"))
        assertTrue(second.contains("\"totp\":\"123456\""))
    }

    @Test fun respostaDoLoginEDoMe() {
        val session = WabotiaJson.decodeFromString(
            MobileSession.serializer(),
            """{"token":"wabu_x","expires":1,"user":{"id":"u"},"aal":1,"mfa":{"policy":"all","factor":false,"next":"enroll"}}""",
        )
        assertEquals(1, session.aal)
        assertEquals("enroll", session.mfa?.next)
        val me = WabotiaJson.decodeFromString(Me.serializer(), """{"id":"u","aal":2,"sessionId":"s","mfa":{"factor":true,"policy":"financial"}}""")
        assertEquals(2, me.aal)
        assertEquals(true, me.mfa?.factor)
        // Servidor antigo: sem aal nem mfa.
        assertNull(WabotiaJson.decodeFromString(Me.serializer(), """{"id":"u"}""").mfa)
    }

    @Test fun erros() {
        assertTrue(ApiException(403, "mfa_required", "x").isMfaRequired)
        // Código errado e login que pede código não derrubam a sessão.
        assertFalse(ApiException(401, "invalid_code", "x").isUnauthorized)
        assertFalse(ApiException(401, "mfa_required", "x").isUnauthorized)
        assertTrue(ApiException(401, "invalid_token", "x").isUnauthorized)
        assertTrue(LoginTexts.error(401, "invalid_code")!!.contains("Código errado"))
        assertTrue(LoginTexts.error(429, "mfa_locked")!!.contains("15 minutos"))
        assertTrue(LoginTexts.error(403, "outside_schedule")!!.contains("horário"))
        assertNull(LoginTexts.error(401, "invalid_credentials"))
    }

    @Test fun textosEDesafio() {
        assertEquals("""{"code":"123456"}""", MfaState.body("123 456").toString())
        assertEquals("""{"recovery_code":"demo-1000-2000"}""", MfaState.body(" demo-1000-2000 ").toString())
        assertEquals("JBSW Y3DP EHPK 3PXP", MfaTexts.groupedSecret("JBSWY3DPEHPK3PXP"))
        assertTrue(MfaTexts.policy("all").contains("todas"))
        assertTrue(MfaTexts.challengeError(ApiException(401, "invalid_code", "x")).contains("Código errado"))
        assertEquals(setOf("mfa", "modules"), ModuleCapabilities.features(WabotiaJson.parseToJsonElement("""{"features":["mfa","modules"]}""")))
        assertEquals(emptySet<String>(), ModuleCapabilities.features(WabotiaJson.parseToJsonElement("""{"profiles":[]}""")))
    }

    private fun json(reply: br.com.queven.wabotia.demo.Reply) = WabotiaJson.parseToJsonElement(String(reply.body)) as JsonObject

    @Test fun demonstracaoCadastraEntraComCodigoEUsaRecuperacao() {
        val account = DemoAccount()
        val now = 1_000_000L
        // Sem fator: entrar não pede código; o desafio responde que não há fator.
        assertNull(account.login(j("email" to "x"), now))
        assertEquals(400, account.challenge(j("code" to "123456"), now).code)
        val enroll = json(account.route("POST", listOf("mfa", "enroll"), j("password" to "senha"), now))
        assertTrue((enroll["otpauth_url"] as JsonPrimitive).content.startsWith("otpauth://totp/"))
        val verified = json(account.route("POST", listOf("mfa", "verify"), j("factor_id" to "fct-demo", "code" to DemoAccount.CODE), now))
        val codes = (verified["recovery_codes"] as kotlinx.serialization.json.JsonArray).map { (it as JsonPrimitive).content }
        assertEquals(10, codes.size)
        assertEquals(2, account.aal(now))
        // Com fator: entrar pede o código; errado é invalid_code; certo passa.
        assertEquals(401, account.login(j("email" to "x"), now)!!.code)
        assertTrue(String(account.login(j("totp" to "000000"), now)!!.body).contains("invalid_code"))
        assertNull(account.login(j("totp" to DemoAccount.CODE), now))
        // A confirmação vale 7 dias; depois, a sessão volta a aal1 e o código de recuperação vale uma vez.
        val later = now + 8L * 24 * 60 * 60 * 1000
        assertEquals(1, account.aal(later))
        assertEquals(403, account.route("POST", listOf("mfa", "recovery-codes"), j(), later).code)
        assertEquals(200, account.challenge(j("recovery_code" to codes[0]), later).code)
        assertEquals(401, account.challenge(j("recovery_code" to codes[0]), later).code)
    }
}
