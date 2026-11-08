package br.com.queven.wabotia.core.model

import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import br.com.queven.wabotia.core.net.ApiException

class ServiceModelsTest {
    @Test fun releasesRejectedWritesButPreservesAmbiguousRequests() {
        assertTrue(ApiException(422, "invalid", "Inválido").isDefinitiveWriteRejection)
        assertTrue(ApiException(403, "forbidden", "Sem acesso").isDefinitiveWriteRejection)
        assertFalse(ApiException(409, "operation_unknown", "Sem confirmação").isDefinitiveWriteRejection)
        assertFalse(ApiException(409, "idempotency_conflict", "Conflito").isDefinitiveWriteRejection)
        assertFalse(ApiException(429, "rate_limited", "Aguarde").isDefinitiveWriteRejection)
    }
    @Test fun readsInternalHistoryWithUnavailablePeer() {
        val response = """{"id":"chat1","peer":{"id":"bot:b1","kind":"bot","name":"Contato indisponível","online":false},"messages":[{"id":"m1","author":"u1","text":"Consulta interna","created":1794146400000,"status":"sent","run_id":null}]}"""
        val chat = WabotiaJson.decodeFromString<InternalChat>(response)
        assertEquals("chat1", chat.id)
        assertFalse(chat.peer!!.online)
        assertEquals("Consulta interna", chat.messages.single().text)
    }

    @Test fun distinguishesUnrestrictedBotFromInternalOnlyBot() {
        val unrestricted = WabotiaJson.decodeFromString<Bot>("""{"id":"b1","line_ids":null}""")
        val internal = WabotiaJson.decodeFromString<Bot>("""{"id":"b2","line_ids":"[]"}""")
        assertNull(unrestricted.line_ids)
        assertNotNull(internal.line_ids)
        assertTrue(internal.line_ids.parseJsonStringList().isEmpty())
    }

    @Test fun decodesIndependentLinePolicyAndMenuMode() {
        val line = WabotiaJson.decodeFromString<ServiceLine>("""{"id":"n1","name":"Recepção","kind":"meta","mode":"direct","status":"active","number":"5511999999999","number_policy":{"pool":false,"human":true,"bots":false},"service":{"mode":"human","bot_id":null,"menu_mode":"manual"}}""")
        assertFalse(line.number_policy.bool("pool")!!)
        assertEquals("manual", line.service.menu_mode)
        assertNull(line.service.bot_id)
        val request = WabotiaJson.encodeToString(ActionRequest(action = "menu", menu_id = "submenu1")).parseJsonObject()
        assertEquals("submenu1", request.string("menu_id"))
    }
}
