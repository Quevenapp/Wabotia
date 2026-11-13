package br.com.queven.wabotia.core.model

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * WabotiaJson não envia campos iguais ao valor padrão. Estes testes fixam o corpo real das requisições em que
 * o servidor exige um campo que o app preenche por padrão (src/index.ts no servidor).
 */
class RequestEncodingTest {
    @Test fun loginSendsDevicePlatform() {
        val body = WabotiaJson.encodeToString(
            MobileLoginRequest(email = "a@b.test", password = "x", device = DeviceInfo(name = "Galaxy", app_version = "0.14.1")),
        ).parseJsonObject()
        val device = body["device"] as JsonObject
        // O servidor responde "Informe device.platform como android ou ios." sem este campo.
        assertEquals(JsonPrimitive("android"), device["platform"])
        assertEquals(JsonPrimitive("Galaxy"), device["name"])
        assertEquals(JsonPrimitive("0.14.1"), device["app_version"])
    }

    @Test fun deviceRegistrationSendsPlatformAndDefaults() {
        val body = WabotiaJson.encodeToString(
            DeviceRegistration(token = "fcm-token", name = "Galaxy", app_version = "0.14.1"),
        ).parseJsonObject()
        assertEquals(JsonPrimitive("android"), body["platform"])
        assertEquals(JsonPrimitive("fcm"), body["provider"])
        assertEquals(JsonArray(emptyList()), body["profiles"])
        assertEquals(JsonPrimitive(true), body["enabled"])
    }

    @Test fun disabledDeviceStillSendsEnabledFalse() {
        val body = WabotiaJson.encodeToString(
            DeviceRegistration(token = "fcm-token", name = "Galaxy", app_version = "0.14.1", profiles = listOf("p1"), enabled = false),
        ).parseJsonObject()
        assertEquals(JsonPrimitive(false), body["enabled"])
        assertEquals(JsonArray(listOf(JsonPrimitive("p1"))), body["profiles"])
    }

    @Test fun optionalFieldsStayOutOfTheBody() {
        val body = WabotiaJson.encodeToString(ActionRequest(action = "claim")).parseJsonObject()
        assertEquals(setOf("action"), body.keys)
        assertFalse(WabotiaJson.encodeToString(TicketCreate(conversation_id = "c1", title = "T")).parseJsonObject().containsKey("category"))
    }
}
