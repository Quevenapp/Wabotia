package br.com.queven.wabotia.core.model

import br.com.queven.wabotia.modules.os.ChecklistMarkRequest
import br.com.queven.wabotia.modules.os.CompleteDocumentRequest
import br.com.queven.wabotia.modules.os.CreateWorkOrderRequest
import br.com.queven.wabotia.modules.os.DocumentReserveRequest
import br.com.queven.wabotia.modules.os.ObjectOpening
import br.com.queven.wabotia.modules.os.QuoteSendRequest
import br.com.queven.wabotia.modules.os.StageRequest
import br.com.queven.wabotia.modules.os.UpdateExtraRequest
import br.com.queven.wabotia.modules.os.WorkOrderClient
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
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

    // Ordem de serviço por modelo (src/modules/os): versão, done, client_visible, sensitive, mode e notify são exigidos
    // pelo servidor mesmo quando valem o padrão (0, false, "existing", true).

    @Test fun stageSendsVersionEvenWhenZero() {
        val body = WorkOrderClient.encode(StageRequest.serializer(), StageRequest("t-1", 0))
        assertEquals(setOf("transition_id", "version"), body.keys)
        assertEquals(JsonPrimitive(0), body["version"])
        val withNote = WorkOrderClient.encode(StageRequest.serializer(), StageRequest("t-1", 3, "Cliente desistiu"))
        assertEquals(JsonPrimitive("Cliente desistiu"), withNote["note"])
    }

    @Test fun checklistUncheckSendsDoneFalse() {
        val body = WorkOrderClient.encode(ChecklistMarkRequest.serializer(), ChecklistMarkRequest(0, "item", false))
        // O servidor recusa sem done ("Informe done: true para marcar ou false para desmarcar.").
        assertEquals(JsonPrimitive(false), body["done"])
        assertEquals(JsonPrimitive(0), body["version"])
        assertFalse(body.containsKey("photo_document_id"))
        val photo = WorkOrderClient.encode(ChecklistMarkRequest.serializer(), ChecklistMarkRequest(4, "item", true, "doc-1"))
        assertEquals(JsonPrimitive("doc-1"), photo["photo_document_id"])
    }

    @Test fun documentReservationSendsVisibilityFlags() {
        val body = WorkOrderClient.encode(DocumentReserveRequest.serializer(), DocumentReserveRequest("foto.jpg", "image/jpeg", 1234))
        // validateDocument exige client_visible e sensitive booleanos.
        assertEquals(setOf("name", "mime_type", "expected_bytes", "client_visible", "sensitive"), body.keys)
        assertEquals(JsonPrimitive(false), body["client_visible"])
        assertEquals(JsonPrimitive(false), body["sensitive"])
        val complete = WorkOrderClient.encode(CompleteDocumentRequest.serializer(), CompleteDocumentRequest(0, "att-1"))
        assertEquals(JsonPrimitive(0), complete["version"])
    }

    @Test fun objectOpeningAlwaysSendsMode() {
        val existing = WorkOrderClient.encode(ObjectOpening.serializer(), ObjectOpening.existing("obj-1", 2))
        assertEquals(JsonPrimitive("existing"), existing["mode"])
        assertEquals(setOf("mode", "id", "version"), existing.keys)
        val new = WorkOrderClient.encode(ObjectOpening.serializer(), ObjectOpening.new("veiculo", JsonObject(mapOf("placa" to JsonPrimitive("ABC1D23")))))
        assertEquals(setOf("mode", "type_id", "values"), new.keys)
        val create = WorkOrderClient.encode(
            CreateWorkOrderRequest.serializer(),
            CreateWorkOrderRequest("oficina", "Revisão", "Barulho", contactId = "ct-1", serviceObject = ObjectOpening.existing("obj-1", 2)),
        )
        assertEquals(setOf("type_id", "item", "problem", "contact_id", "object"), create.keys)
    }

    @Test fun patchKeepsExplicitNullsAndQuoteSendNotifies() {
        val body = WorkOrderClient.updateBody(UpdateExtraRequest(0, JsonObject(mapOf("km" to JsonNull, "cor" to JsonPrimitive("az")))))
        assertEquals(JsonPrimitive(0), body["version"])
        assertEquals(JsonNull, (body["extra"] as JsonObject)["km"])
        assertEquals(JsonPrimitive(true), WorkOrderClient.encode(QuoteSendRequest.serializer(), QuoteSendRequest())["notify"])
    }

    @Test fun optionalFieldsStayOutOfTheBody() {
        val body = WabotiaJson.encodeToString(ActionRequest(action = "claim")).parseJsonObject()
        assertEquals(setOf("action"), body.keys)
        assertFalse(WabotiaJson.encodeToString(TicketCreate(conversation_id = "c1", title = "T")).parseJsonObject().containsKey("category"))
    }
}
