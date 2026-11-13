import XCTest
@testable import Wabotia

/// Contrato do servidor 0.14 (docs/CENTRAL-ATENDIMENTO.md): seis estados, categoria, `last_message` e destino `ticket`.
final class TicketModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder.wabotia.decode(type, from: Data(json.utf8))
    }

    /// Linha de conversa como o servidor manda (campos obrigatórios), com campos extras no fim.
    private func conversation(_ extra: String = "") throws -> Conversation {
        try decode(Conversation.self, #"{"id":"c1","profile_id":"p","external_namespace":"n","external_id":"e","state":"human","epoch":1,"last_customer":0,"created":1,"updated":1"# + extra + "}")
    }

    private func ticket(_ extra: String) throws -> Ticket {
        try decode(Ticket.self, #"{"id":"t1","number":"WA-1","profile_id":"p","conversation_id":"c","title":"T","created":1,"updated":1"# + extra + "}")
    }

    private func status(_ extra: String = "") throws -> ProfileStatus {
        try decode(ProfileStatus.self, #"{"enabled":1,"conversations":[],"deliveries":[],"connections":[]"# + extra + "}")
    }

    func testActiveMeansNeitherResolvedNorClosed() {
        XCTAssertTrue(TicketStatus.isActive("open"))
        XCTAssertTrue(TicketStatus.isActive("in_progress"))
        XCTAssertTrue(TicketStatus.isActive("waiting_customer"))
        XCTAssertTrue(TicketStatus.isActive("waiting_third"))
        XCTAssertFalse(TicketStatus.isActive("resolved"))
        XCTAssertFalse(TicketStatus.isActive("closed"))
        // Estado que este aplicativo ainda não conhece: segue a regra (não é resolved nem closed).
        XCTAssertTrue(TicketStatus.isActive("escalated"))
        XCTAssertEqual(TicketStatus.all.count, 6)
        XCTAssertEqual(TicketsSupport.statuses, TicketStatus.all)
    }

    func testLabelsForTheSixStatesAndNeutralTextForUnknown() {
        XCTAssertEqual(TicketStatus.label("open"), "Recebido")
        XCTAssertEqual(TicketStatus.label("in_progress"), "Em análise")
        XCTAssertEqual(TicketStatus.label("waiting_customer"), "Aguardando cliente")
        XCTAssertEqual(TicketStatus.label("waiting_third"), "Aguardando terceiro")
        XCTAssertEqual(TicketStatus.label("resolved"), "Resolvido")
        XCTAssertEqual(TicketStatus.label("closed"), "Encerrado")
        XCTAssertEqual(TicketStatus.label("on_hold"), "On hold")
        XCTAssertEqual(TicketStatus.label(""), "Sem estado")
        XCTAssertFalse(TicketStatus.isKnown("on_hold"))
        XCTAssertEqual(TicketsSupport.statusTitle("waiting_third"), "Aguardando terceiro")
    }

    func testOverdueOnlyCountsActiveTicketsWithoutFirstResponse() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let past: Int64 = 1_800_000_000_000 - 1000
        let future: Int64 = 1_800_000_000_000 + 1000
        func ticket(_ status: String, first: Int64? = nil, due: Int64? = past) -> Ticket {
            Ticket(id: "t", status: status, response_due_at: due, first_response_at: first)
        }
        XCTAssertTrue(ticket("open").isOverdue(at: now))
        XCTAssertTrue(ticket("waiting_third").isOverdue(at: now))
        XCTAssertFalse(ticket("resolved").isOverdue(at: now))
        XCTAssertFalse(ticket("closed").isOverdue(at: now))
        XCTAssertFalse(ticket("in_progress", first: past).isOverdue(at: now))
        XCTAssertFalse(ticket("open", due: future).isOverdue(at: now))
        XCTAssertFalse(ticket("open", due: nil).isOverdue(at: now))
        // O prazo de um protocolo não ativo mostra o estado, não "atrasado".
        XCTAssertEqual(TicketsSupport.due(for: ticket("resolved"), now: now).text, "Resolvido")
        XCTAssertEqual(TicketsSupport.due(for: ticket("closed"), now: now).kind, .closed)
        XCTAssertEqual(TicketsSupport.due(for: ticket("waiting_customer"), now: now).kind, .overdue)
    }

    func testFiltersAndCountsUseTheActiveRule() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let past: Int64 = 1_800_000_000_000 - 1000
        let list = [
            Ticket(id: "1", status: "open", response_due_at: past),
            Ticket(id: "2", status: "in_progress"),
            Ticket(id: "3", status: "waiting_customer"),
            Ticket(id: "4", status: "waiting_third"),
            Ticket(id: "5", status: "resolved", response_due_at: past),
            Ticket(id: "6", status: "closed"),
            Ticket(id: "7", status: "escalated"),
        ]
        func ids(_ filter: TicketFilter) -> [String] { list.filter { filter.matches($0, now: now) }.map(\.id) }
        XCTAssertEqual(ids(.active), ["1", "2", "3", "4", "7"])
        XCTAssertEqual(ids(.open), ["1"])
        XCTAssertEqual(ids(.inProgress), ["2"])
        XCTAssertEqual(ids(.waiting), ["3", "4"])
        XCTAssertEqual(ids(.overdue), ["1"])
        XCTAssertEqual(ids(.resolved), ["5", "6"])
        XCTAssertEqual(ids(.all).count, 7)
        XCTAssertEqual(TicketFilter.allCases.map(\.title), ["Ativos", "Recebidos", "Em análise", "Aguardando", "Atrasados", "Resolvidos", "Todos"])

        let counts = Workspace.TicketCounts(list, now: now)
        XCTAssertEqual(counts.active, 5)
        XCTAssertEqual(counts.open, 1)
        XCTAssertEqual(counts.inProgress, 1)
        XCTAssertEqual(counts.waiting, 2)
        XCTAssertEqual(counts.overdue, 1)
    }

    func testDecodesTicketFromOlderAndNewerServers() throws {
        let old = try ticket(#","status":"in_progress""#)
        XCTAssertNil(old.category)
        XCTAssertTrue(old.isActive)
        let new = try ticket(#","status":"waiting_customer","category":"printher","sla_minutes":90"#)
        XCTAssertEqual(new.category, "printher")
        let future = try ticket(#","status":"escalated","category":null"#)
        XCTAssertEqual(TicketStatus.label(future.status), "Escalated")
        XCTAssertNil(future.category)
    }

    func testReadsCategoriesFromStatusSettingsAndKeepsStoredIdWhenRemoved() throws {
        let categories = try status(#","settings":{"ticket_categories":[{"id":"printher","name":"Printher","enabled":true},{"id":"vinki","name":"Vinki","enabled":false},{"name":"sem id"},"lixo"]}"#).ticketCategories
        XCTAssertEqual(categories.map(\.id), ["printher", "vinki"])
        XCTAssertFalse(categories[1].enabled)
        XCTAssertEqual(categories.name(of: "printher"), "Printher")
        XCTAssertEqual(categories.name(of: "removida"), "removida")
        XCTAssertNil(categories.name(of: nil))
        XCTAssertNil(categories.name(of: ""))
        // Servidor 0.13: sem a chave, sem categorias.
        XCTAssertTrue(try status(#","settings":{}"#).ticketCategories.isEmpty)
        XCTAssertTrue(try status().ticketCategories.isEmpty)
    }

    func testTicketCreateOmitsCategoryWhenNotChosen() throws {
        let plain = try JSONDecoder.wabotia.decode(JSONValue.self, from: JSONEncoder.wabotia.encode(TicketCreate(conversation_id: "c1", title: "Título")))
        XCTAssertNil(plain["category"])
        let categorized = try JSONDecoder.wabotia.decode(JSONValue.self, from: JSONEncoder.wabotia.encode(TicketCreate(conversation_id: "c1", title: "Título", category: "printher")))
        XCTAssertEqual(categorized["category"]?.stringValue, "printher")
    }

    func testLastMessageBecomesTheListPreview() throws {
        let outgoing = try conversation(#","last_message":{"text":"Segue a proposta","direction":"outbound","created":2000,"delivery_status":"read","attachments":1,"kind":"document"}"#)
        let preview = try XCTUnwrap(MessagePreview.forList(outgoing, cached: nil))
        XCTAssertEqual(preview.kind, "document")
        XCTAssertEqual(preview.text, "Segue a proposta")
        XCTAssertTrue(preview.isOutgoing)
        XCTAssertEqual(preview.status, "read")
        XCTAssertEqual(preview.created, 2000)
        XCTAssertEqual(preview.attachmentLabel?.title, "Documento")

        let incoming = try conversation(#","last_message":{"text":"Oi","direction":"customer","created":5,"delivery_status":"delivered"}"#)
        let incomingPreview = try XCTUnwrap(MessagePreview.forList(incoming, cached: nil))
        XCTAssertFalse(incomingPreview.isOutgoing)
        XCTAssertNil(incomingPreview.status)
        XCTAssertEqual(incomingPreview.kind, "text")

        let note = try conversation(#","last_message":{"text":"interno","direction":"note","created":1,"kind":"text"}"#)
        XCTAssertEqual(MessagePreview.forList(note, cached: nil)?.isNote, true)
    }

    func testLocalCacheIsTheFallbackAndWinsOnlyWhenNewer() throws {
        let old = MessagePreview(kind: "text", text: "do cache", direction: "customer", created: 1000, status: nil)
        let newer = MessagePreview(kind: "text", text: "evento novo", direction: "customer", created: 3000, status: nil)
        // Servidor 0.13 (campo ausente), conversa sem mensagens (null) e formato inesperado: fica o cache local.
        XCTAssertEqual(MessagePreview.forList(try conversation(), cached: old), old)
        XCTAssertEqual(MessagePreview.forList(try conversation(#","last_message":null"#), cached: old), old)
        XCTAssertEqual(MessagePreview.forList(try conversation(#","last_message":"texto""#), cached: old), old)
        XCTAssertNil(MessagePreview.forList(try conversation(), cached: nil))

        let server = try conversation(#","last_message":{"text":"do servidor","direction":"customer","created":2000,"kind":"text"}"#)
        XCTAssertEqual(MessagePreview.forList(server, cached: old)?.text, "do servidor")
        XCTAssertEqual(MessagePreview.forList(server, cached: newer)?.text, "evento novo")
        // Mesma mensagem: o cache guarda o que só o detalhe sabe (voz).
        let voice = try conversation(#","last_message":{"text":"","direction":"customer","created":2000,"attachments":1,"kind":"audio"}"#)
        let cachedVoice = MessagePreview(kind: "voice", text: "", direction: "customer", created: 2000, status: nil)
        XCTAssertEqual(MessagePreview.forList(voice, cached: cachedVoice)?.kind, "voice")
    }

    func testMenuTypesHaveReadableNamesIncludingTicketAndUnknown() {
        XCTAssertEqual(MenuItems.typeLabel("ticket"), "Abrir protocolo")
        XCTAssertEqual(MenuItems.typeLabel("human"), "Pessoa")
        XCTAssertEqual(MenuItems.typeLabel("protocols"), "Consultar protocolos")
        XCTAssertEqual(MenuItems.typeLabel("workflow"), "Outro destino (workflow)")
        XCTAssertEqual(MenuItems.choices(original: "human"), ["human", "bot", "submenu", "app", "ticket"])
        XCTAssertEqual(MenuItems.choices(original: "link").last, "link")
    }

    func testEditingAMenuItemKeepsFieldsTheAppDoesNotEdit() throws {
        let ticket = try decode(JSONValue.self, #"{"id":"m1","label":"Abrir protocolo","type":"ticket","parent_id":null,"category_id":"printher","content":"Descreva o que precisa.","enabled":true,"trigger":"automatic","line_ids":[],"future_field":{"a":1}}"#)
        let renamed = MenuItems.edited(ticket, label: " Registrar um problema ", type: "ticket", parentId: "sub1", botId: "", appId: "", categoryId: "printher", trigger: "manual", enabled: false, lineIds: ["l1"])
        XCTAssertEqual(renamed["label"]?.stringValue, "Registrar um problema")
        XCTAssertEqual(renamed["type"]?.stringValue, "ticket")
        XCTAssertEqual(renamed["parent_id"]?.stringValue, "sub1")
        XCTAssertEqual(renamed["category_id"]?.stringValue, "printher")
        XCTAssertEqual(renamed["content"]?.stringValue, "Descreva o que precisa.")
        XCTAssertEqual(renamed["future_field"], ticket["future_field"])
        XCTAssertNil(renamed["bot_id"])
        XCTAssertNil(renamed["app_id"])
        XCTAssertEqual(renamed["enabled"]?.boolValue, false)
        XCTAssertEqual(renamed["trigger"]?.stringValue, "manual")

        // Sem categoria: o campo sai; o restante fica.
        let cleared = MenuItems.edited(ticket, label: "Abrir protocolo", type: "ticket", parentId: "", botId: "", appId: "", categoryId: "", trigger: "automatic", enabled: true, lineIds: [])
        XCTAssertNil(cleared["category_id"])
        XCTAssertEqual(cleared["parent_id"], JSONValue.null)
        XCTAssertEqual(cleared["content"]?.stringValue, "Descreva o que precisa.")

        // Tipo que o aplicativo não monta (link): salvar sem mexer no destino não troca o tipo nem perde a URL.
        let link = try decode(JSONValue.self, #"{"id":"m2","label":"Site","type":"link","url":"https://example.com","content":"Acesse"}"#)
        let saved = MenuItems.edited(link, label: "Nosso site", type: "link", parentId: "", botId: "", appId: "", categoryId: "", trigger: "automatic", enabled: true, lineIds: [])
        XCTAssertEqual(saved["type"]?.stringValue, "link")
        XCTAssertEqual(saved["url"]?.stringValue, "https://example.com")
        XCTAssertEqual(saved["content"]?.stringValue, "Acesse")

        // Destino bot continua gravando o bot escolhido.
        let human = try decode(JSONValue.self, #"{"id":"m3","label":"Vendas","type":"human"}"#)
        let bot = MenuItems.edited(human, label: "Vendas", type: "bot", parentId: "", botId: "b1", appId: "", categoryId: "", trigger: "automatic", enabled: true, lineIds: [])
        XCTAssertEqual(bot["bot_id"]?.stringValue, "b1")
    }
}
