package br.com.queven.wabotia.core.model

import br.com.queven.wabotia.core.MessagePreview
import br.com.queven.wabotia.core.listPreview
import br.com.queven.wabotia.core.toPreview
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Contrato do servidor 0.14 (docs/CENTRAL-ATENDIMENTO.md): seis estados, categoria, `last_message` e destino `ticket`. */
class TicketModelsTest {
    @Test fun activeMeansNeitherResolvedNorClosed() {
        assertTrue(TicketStatus.isActive("open"))
        assertTrue(TicketStatus.isActive("in_progress"))
        assertTrue(TicketStatus.isActive("waiting_customer"))
        assertTrue(TicketStatus.isActive("waiting_third"))
        assertFalse(TicketStatus.isActive("resolved"))
        assertFalse(TicketStatus.isActive("closed"))
        // Estado que este aplicativo ainda não conhece: segue a regra (não é resolved nem closed).
        assertTrue(TicketStatus.isActive("escalated"))
        assertEquals(6, TicketStatus.all.size)
    }

    @Test fun labelsForTheSixStatesAndNeutralTextForUnknown() {
        assertEquals("Recebido", TicketStatus.label("open"))
        assertEquals("Em análise", TicketStatus.label("in_progress"))
        assertEquals("Aguardando cliente", TicketStatus.label("waiting_customer"))
        assertEquals("Aguardando terceiro", TicketStatus.label("waiting_third"))
        assertEquals("Resolvido", TicketStatus.label("resolved"))
        assertEquals("Encerrado", TicketStatus.label("closed"))
        assertEquals("On hold", TicketStatus.label("on_hold"))
        assertEquals("Sem estado", TicketStatus.label(""))
        assertFalse(TicketStatus.isKnown("on_hold"))
    }

    @Test fun overdueOnlyCountsActiveTicketsWithoutFirstResponse() {
        val now = 1_800_000_000_000L
        fun ticket(status: String, firstResponse: Long? = null, due: Long? = now - 1) =
            Ticket(id = "t", status = status, response_due_at = due, first_response_at = firstResponse)
        assertTrue(ticket("open").isOverdueAt(now))
        assertTrue(ticket("waiting_third").isOverdueAt(now))
        assertFalse(ticket("resolved").isOverdueAt(now))
        assertFalse(ticket("closed").isOverdueAt(now))
        assertFalse(ticket("in_progress", firstResponse = now - 10).isOverdueAt(now))
        assertFalse(ticket("open", due = now + 1).isOverdueAt(now))
        assertFalse(ticket("open", due = null).isOverdueAt(now))
    }

    @Test fun decodesTicketFromOlderAndNewerServers() {
        val old = WabotiaJson.decodeFromString<Ticket>("""{"id":"t1","number":"WA-1","status":"in_progress"}""")
        assertNull(old.category)
        assertTrue(old.isActive)
        val new = WabotiaJson.decodeFromString<Ticket>("""{"id":"t2","status":"waiting_customer","category":"printher","sla_minutes":90}""")
        assertEquals("printher", new.category)
        val future = WabotiaJson.decodeFromString<Ticket>("""{"id":"t3","status":"escalated","category":null}""")
        assertEquals("Escalated", TicketStatus.label(future.status))
        assertNull(future.category)
    }

    @Test fun readsCategoriesFromStatusSettingsAndKeepsStoredIdWhenRemoved() {
        val status = WabotiaJson.decodeFromString<ProfileStatus>(
            """{"settings":{"ticket_categories":[{"id":"printher","name":"Printher","enabled":true},{"id":"vinki","name":"Vinki","enabled":false},{"name":"sem id"},"lixo"]}}""",
        )
        val categories = status.ticketCategories()
        assertEquals(listOf("printher", "vinki"), categories.map { it.id })
        assertFalse(categories[1].enabled)
        assertEquals("Printher", categories.nameOf("printher"))
        assertEquals("removida", categories.nameOf("removida"))
        assertNull(categories.nameOf(null))
        assertNull(categories.nameOf(""))
        // Servidor 0.13: sem a chave, sem categorias.
        assertTrue(WabotiaJson.decodeFromString<ProfileStatus>("""{"settings":{}}""").ticketCategories().isEmpty())
        assertTrue(WabotiaJson.decodeFromString<ProfileStatus>("""{}""").ticketCategories().isEmpty())
    }

    @Test fun ticketCreateOmitsCategoryWhenNotChosen() {
        val plain = WabotiaJson.encodeToString(TicketCreate(conversation_id = "c1", title = "Título")).parseJsonObject()
        assertFalse(plain.containsKey("category"))
        val categorized = WabotiaJson.encodeToString(TicketCreate(conversation_id = "c1", title = "Título", category = "printher")).parseJsonObject()
        assertEquals("printher", categorized.string("category"))
    }

    @Test fun lastMessageBecomesTheListPreview() {
        val row = """{"id":"c1","last_message":{"text":"Segue a proposta","direction":"outbound","created":2000,"delivery_status":"read","attachments":1,"kind":"document"}}"""
        val conversation = WabotiaJson.decodeFromString<Conversation>(row)
        val preview = listPreview(conversation, null)!!
        assertEquals("document", preview.kind)
        assertEquals("Segue a proposta", preview.text)
        assertTrue(preview.outgoing)
        assertEquals("read", preview.status)
        assertEquals(2000L, preview.at)

        val incoming = LastMessage.from(JsonObject(mapOf("text" to JsonPrimitive("Oi"), "direction" to JsonPrimitive("customer"), "created" to JsonPrimitive(5L), "delivery_status" to JsonPrimitive("delivered"))))!!.toPreview()
        assertFalse(incoming.outgoing)
        assertEquals("", incoming.status)
        assertEquals("text", incoming.kind)

        val note = WabotiaJson.decodeFromString<Conversation>("""{"id":"c2","last_message":{"text":"interno","direction":"note","created":1,"kind":"text"}}""")
        assertTrue(listPreview(note, null)!!.note)
    }

    @Test fun localCacheIsTheFallbackAndWinsOnlyWhenNewer() {
        val old = MessagePreview(text = "do cache", at = 1000)
        val newer = MessagePreview(text = "evento novo", at = 3000)
        val absent = WabotiaJson.decodeFromString<Conversation>("""{"id":"c1"}""")
        val nullValue = WabotiaJson.decodeFromString<Conversation>("""{"id":"c1","last_message":null}""")
        val odd = WabotiaJson.decodeFromString<Conversation>("""{"id":"c1","last_message":"texto"}""")
        // Servidor 0.13 (campo ausente), conversa sem mensagens (null) e formato inesperado: fica o cache local.
        assertEquals(old, listPreview(absent, old))
        assertEquals(old, listPreview(nullValue, old))
        assertEquals(old, listPreview(odd, old))
        assertNull(listPreview(absent, null))

        val server = WabotiaJson.decodeFromString<Conversation>("""{"id":"c1","last_message":{"text":"do servidor","direction":"customer","created":2000,"kind":"text"}}""")
        assertEquals("do servidor", listPreview(server, old)!!.text)
        assertEquals("evento novo", listPreview(server, newer)!!.text)
        // Mesma mensagem: o cache guarda o que só o detalhe sabe (voz).
        val voice = WabotiaJson.decodeFromString<Conversation>("""{"id":"c1","last_message":{"text":"","direction":"customer","created":2000,"attachments":1,"kind":"audio"}}""")
        assertEquals("voice", listPreview(voice, MessagePreview(kind = "voice", at = 2000))!!.kind)
    }

    @Test fun menuTypesHaveReadableNamesIncludingTicketAndUnknown() {
        assertEquals("Abrir protocolo", menuTypeLabel("ticket"))
        assertEquals("Pessoa", menuTypeLabel("human"))
        assertEquals("Consultar protocolos", menuTypeLabel("protocols"))
        assertEquals("Outro destino (workflow)", menuTypeLabel("workflow"))
    }

    @Test fun editingAMenuItemKeepsFieldsTheAppDoesNotEdit() {
        val ticket = """{"id":"m1","label":"Abrir protocolo","type":"ticket","parent_id":null,"category_id":"printher","content":"Descreva o que precisa.","enabled":true,"trigger":"automatic","line_ids":[],"future_field":{"a":1}}""".parseJsonObject()
        val renamed = editedMenuItem(ticket, label = " Registrar um problema ", type = "ticket", parentId = "sub1", botId = "", appId = "", categoryId = "printher", trigger = "manual", enabled = false, lineIds = listOf("l1"))
        assertEquals("Registrar um problema", renamed.string("label"))
        assertEquals("ticket", renamed.string("type"))
        assertEquals("sub1", renamed.string("parent_id"))
        assertEquals("printher", renamed.string("category_id"))
        assertEquals("Descreva o que precisa.", renamed.string("content"))
        assertEquals(ticket["future_field"], renamed["future_field"])
        assertFalse(renamed.containsKey("bot_id"))
        assertFalse(renamed.containsKey("app_id"))
        assertEquals(false, renamed.bool("enabled"))
        assertEquals("manual", renamed.string("trigger"))

        // Sem categoria: o campo sai; o restante fica.
        val cleared = editedMenuItem(ticket, "Abrir protocolo", "ticket", "", "", "", "", "automatic", true, emptyList())
        assertFalse(cleared.containsKey("category_id"))
        assertEquals(JsonNull, cleared["parent_id"])
        assertEquals("Descreva o que precisa.", cleared.string("content"))

        // Tipo que o aplicativo não monta (link): salvar sem mexer no destino não troca o tipo nem perde a URL.
        val link = """{"id":"m2","label":"Site","type":"link","url":"https://example.com","content":"Acesse"}""".parseJsonObject()
        val saved = editedMenuItem(link, "Nosso site", "link", "", "", "", "", "automatic", true, emptyList())
        assertEquals("link", saved.string("type"))
        assertEquals("https://example.com", saved.string("url"))
        assertEquals("Acesse", saved.string("content"))

        // Destino bot continua gravando o bot escolhido.
        val bot = editedMenuItem("""{"id":"m3","label":"Vendas","type":"human"}""".parseJsonObject(), "Vendas", "bot", "", "b1", "", "", "automatic", true, emptyList())
        assertEquals("b1", bot.string("bot_id"))
    }
}
