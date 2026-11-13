#if DEBUG
import Foundation
import UIKit

/// Responde a toda requisição para `demo.wabotia.localhost` a partir de `DemoServer` (dados em memória).
final class DemoURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == DemoMode.host }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        let body = Self.body(of: request)
        DemoServer.queue.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self, let url = request.url else { return }
            if DemoServer.shared.simulateOffline, url.path.hasSuffix("/events") {
                self.client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
                return
            }
            let result = DemoServer.shared.handle(method: request.httpMethod ?? "GET", url: url, body: body)
            let response = HTTPURLResponse(url: url, statusCode: result.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": result.type, "Content-Length": String(result.data.count)])!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: result.data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    /// O corpo chega em `httpBodyStream` quando a requisição passa por um URLProtocol.
    private static func body(of request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// Servidor Wabotia de mentira: dados de exemplo mutáveis e as mesmas rotas que o app usa.
/// Todo acesso acontece na fila serial `queue`.
final class DemoServer {
    typealias Row = [String: Any]
    struct Reply { var status = 200; var data = Data(); var type = "application/json" }

    static let shared = DemoServer()
    static let queue = DispatchQueue(label: "br.com.queven.wabotia.demo")

    var extraProfile = false
    var simulateOffline = false

    private let me = DemoMode.meId
    private let start = Int64(Date().timeIntervalSince1970 * 1000)
    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private func ago(_ minutes: Double) -> Int64 { start - Int64(minutes * 60_000) }

    private var presence: [Row] = []
    private var bots: [Row] = []
    private var departments: [Row] = []
    private var menus: [Row] = []
    /// `settings.ticket_categories` (servidor 0.14): aplicativo ou assunto do protocolo.
    private var ticketCategories: [Row] = []
    private let ticketStatuses = ["open", "in_progress", "waiting_customer", "waiting_third", "resolved", "closed"]
    private var lines: [Row] = []
    private var conversations: [Row] = []
    private var messages: [String: [Row]] = [:]
    private var deliveries: [String: [Row]] = [:]
    private var contacts: [String: Row] = [:]
    private var media: [String: Row] = [:]
    private var mediaBytes: [String: Data] = [:]
    private var tickets: [Row] = []
    private var ticketUpdates: [String: [Row]] = [:]
    private var calls: [Row] = []
    private var chats: [Row] = []
    private var chatMessages: [String: [Row]] = [:]
    private var runs: [Row] = []
    private var events: [Row] = []
    private var uploads: [String: (name: String, type: String, parts: [Int: Data])] = [:]
    private var eventId: Int64 = 1000
    private var sequence = 0
    /// Efeitos com hora marcada (recibos avançando, resposta do cliente, resposta do bot).
    private var scheduled: [(due: Int64, run: () -> Void)] = []

    private init() { buildFixtures() }

    private func nextId(_ prefix: String) -> String {
        sequence += 1
        return "\(prefix)\(sequence)"
    }

    // MARK: - Dados de exemplo

    private func buildFixtures() {
        presence = [
            ["actor": me, "name": "Bruno Martins", "present": 1],
            ["actor": "u_ana", "name": "Ana Souza", "present": 1],
            ["actor": "u_marina", "name": "Marina Lima", "present": 1],
            ["actor": "u_carlos", "name": "Carlos Pereira", "present": 0],
        ]
        bots = [
            ["id": "b_vendas", "profile_id": "demo", "connection_id": "hermes", "remote_profile": "vendas", "name": "Vendas", "enabled": 1, "line_ids": NSNull(), "online": true],
            ["id": "b_suporte", "profile_id": "demo", "connection_id": "hermes", "remote_profile": "suporte", "name": "Suporte", "enabled": 1, "line_ids": ["line_zernio"], "online": false],
        ]
        departments = [
            ["id": "dep_fin", "name": "Financeiro", "enabled": true, "members": [me, "u_ana", "u_carlos"]],
            ["id": "dep_sup", "name": "Suporte", "enabled": true, "members": ["u_marina", "u_carlos"]],
        ]
        menus = [
            ["id": "m_vendas", "label": "Falar com Vendas", "type": "bot", "bot_id": "b_vendas", "enabled": true, "trigger": "automatic", "line_ids": [String]()],
            ["id": "m_fin", "label": "Financeiro", "type": "submenu", "enabled": true, "trigger": "automatic", "line_ids": [String]()],
            ["id": "m_fin_boleto", "label": "Segunda via de boleto", "type": "link", "parent_id": "m_fin", "url": "https://exemplo.com.br/boleto", "enabled": true, "trigger": "automatic", "line_ids": [String]()],
            ["id": "m_fin_humano", "label": "Falar com o Financeiro", "type": "human", "parent_id": "m_fin", "department_id": "dep_fin", "enabled": true, "trigger": "automatic", "line_ids": [String]()],
            ["id": "m_sup", "label": "Suporte técnico", "type": "submenu", "enabled": true, "trigger": "manual", "line_ids": [String]()],
            ["id": "m_sup_humano", "label": "Falar com um especialista", "type": "human", "parent_id": "m_sup", "department_id": "dep_sup", "enabled": true, "trigger": "manual", "line_ids": [String]()],
            ["id": "m_prot", "label": "Consultar protocolo", "type": "protocols", "enabled": true, "trigger": "automatic", "line_ids": [String]()],
            ["id": "m_abrir", "label": "Abrir protocolo", "type": "ticket", "category_id": "wabotia", "content": "Descreva em uma mensagem o que você precisa. Se puder, diga o que tentou e o que aconteceu.", "enabled": true, "trigger": "automatic", "line_ids": [String]()],
        ]
        ticketCategories = [
            ["id": "wabotia", "name": "Wabotia", "enabled": true],
            ["id": "printher", "name": "Printher", "enabled": true],
            ["id": "nfse-leve", "name": "NFS-e Leve", "enabled": true],
            ["id": "fagoo-erp", "name": "Fagoo ERP", "enabled": true],
            ["id": "servidor-integracao", "name": "Servidor ou integração", "enabled": true],
            ["id": "outro", "name": "Outro ou não sei", "enabled": true],
            ["id": "vinki", "name": "Vinki", "enabled": false],
        ]
        let policy: Row = ["pool": true, "human": true, "bots": true, "menu": true, "api": true, "service": true, "templates": true]
        lines = [
            ["id": "line_meta", "name": "WhatsApp Principal", "kind": "meta", "mode": "direct", "status": "active", "number": "551140001234", "number_policy": policy, "service": ["mode": "inherit", "bot_id": NSNull(), "menu_mode": "automatic"] as Row],
            ["id": "line_zernio", "name": "WhatsApp Vendas", "kind": "zernio", "mode": "direct", "status": "active", "number": "551140005678", "number_policy": policy, "service": ["mode": "bot", "bot_id": "b_vendas", "menu_mode": "manual"] as Row],
        ]

        func conversation(_ id: String, _ name: String, _ phone: String, state: String, owner: String? = nil, line: String = "line_meta", lastCustomer: Double?, updated: Double, tags: [String] = [], department: String? = nil, bot: String? = nil, group: Bool = false) -> Row {
            contacts[id] = group ? nil : ["id": "ct_\(id)", "name": name, "phone": phone]
            return [
                "id": id, "profile_id": "demo", "connection_id": line, "external_namespace": "channel:\(line)", "external_id": phone,
                "phone": group ? NSNull() : phone as Any, "state": state, "owner": owner ?? NSNull() as Any, "epoch": 1, "topic": NSNull(),
                "tags": json(tags), "last_customer": lastCustomer.map { ago($0) } ?? 0, "created": ago(updated + 600), "updated": ago(updated),
                "chat_type": group ? "group" : "direct", "title": group ? name : "", "bot_policy": "mentions", "recipient_id": NSNull(),
                "contact_name": group ? NSNull() : name as Any, "contact_id": group ? NSNull() : "ct_\(id)" as Any,
                "department_id": department ?? NSNull() as Any, "assigned_bot_id": bot ?? NSNull() as Any,
            ]
        }
        conversations = [
            conversation("c_rich", "Mariana Costa", "5511987654321", state: "human", owner: me, lastCustomer: 46, updated: 44, tags: ["VIP", "Troca"], department: "dep_fin"),
            conversation("c_queue", "Fernanda Rocha", "5521991122334", state: "waiting", lastCustomer: 12, updated: 12, tags: ["Suporte"], department: "dep_sup"),
            conversation("c_queue2", "Lucas Martins", "5531988776655", state: "waiting", line: "line_zernio", lastCustomer: 3, updated: 3),
            conversation("c_5h", "João Pedro Almeida", "5511976543210", state: "human", owner: me, line: "line_zernio", lastCustomer: 19 * 60 - 2, updated: 58, tags: ["Entrega"]),
            conversation("c_40", "Patrícia Nunes", "5541999887766", state: "human", owner: me, lastCustomer: 23 * 60 + 20, updated: 23 * 60 + 15, tags: ["Orçamento"]),
            conversation("c_closedwin", "Roberto Dias", "5551981234567", state: "human", owner: me, lastCustomer: 30 * 60, updated: 29 * 60, tags: ["Cobrança", "Financeiro", "Urgente"], department: "dep_fin"),
            conversation("c_bot", "Camila Ferreira", "5561992223344", state: "ai", line: "line_zernio", lastCustomer: 125, updated: 124, bot: "b_vendas"),
            conversation("c_other", "Eduardo Santos", "5571993334455", state: "human", owner: "u_ana", lastCustomer: 180, updated: 170, tags: ["Suporte"]),
            conversation("c_group", "Equipe Loja Centro", "120363041234567890", state: "ai", lastCustomer: 240, updated: 235, group: true),
            conversation("c_closed", "Aline Barbosa", "5581994445566", state: "closed", lastCustomer: 2 * 24 * 60, updated: 2 * 24 * 60 - 30, tags: ["Garantia"]),
        ]

        // Mídias de exemplo (os bytes são gerados na hora, ao pedir o conteúdo).
        media = [
            "md_foto": ["id": "md_foto", "name": "caixa-amassada.jpg", "type": "image/png", "size": 412_300],
            "md_voz": ["id": "md_voz", "name": "mensagem-de-voz.ogg", "type": "audio/ogg; codecs=opus", "size": 38_400],
            "md_voz2": ["id": "md_voz2", "name": "mensagem-de-voz.ogg", "type": "audio/ogg; codecs=opus", "size": 21_900],
            "md_pdf": ["id": "md_pdf", "name": "Politica-de-troca.pdf", "type": "application/pdf", "size": 184_320],
            "md_video": ["id": "md_video", "name": "vitrine-nova.mp4", "type": "video/mp4", "size": 3_650_000],
        ]

        func message(_ id: String, _ conversation: String, _ direction: String, _ author: String, _ text: String, at minutes: Double, status: String = "", attachments: [String] = [], content: Row = [:]) -> Row {
            ["id": id, "profile_id": "demo", "conversation_id": conversation, "direction": direction, "author": author, "text": text,
             "attachments": json(attachments), "external_id": "wamid.\(id)", "created": ago(minutes), "content": json(content),
             "delivery_status": direction == "outbound" ? status : "", "status_at": ago(minutes)]
        }
        let customer = "customer:channel:line_meta:5511987654321"
        let day: Double = 26 * 60
        messages["c_rich"] = [
            message("m1", "c_rich", "customer", customer, "Oi, boa tarde! Fiz um pedido ontem e queria saber o prazo de entrega.", at: day, content: ["type": "text"]),
            message("m2", "c_rich", "outbound", "bot:attendant", "Olá, Mariana! 👋 Sou a assistente virtual da Queven. Vou encaminhar sua solicitação para nossa equipe.", at: day - 1, status: "read"),
            message("m3", "c_rich", "outbound", me, "Oi, Mariana! Aqui é o Bruno. Seu pedido #48213 saiu hoje para entrega e chega até sexta-feira. 🚚", at: day - 5, status: "read", content: ["type": "text", "reactions": ["customer": ["emoji": "❤️", "timestamp": ago(day - 6)] as Row] as Row]),
            message("m4", "c_rich", "customer", customer, "Que ótimo, obrigada!", at: day - 7, content: ["type": "text"]),
            message("m5", "c_rich", "customer", customer, "O produto chegou assim, a caixa veio amassada 😕", at: 95, attachments: ["md_foto"], content: ["type": "image"]),
            message("m6", "c_rich", "customer", customer, "", at: 94, attachments: ["md_voz"], content: ["type": "voice"]),
            message("m7", "c_rich", "note", me, "Cliente VIP. Autorizar a troca sem custo, conforme a política.", at: 90),
            message("m8", "c_rich", "outbound", me, "Sinto muito por isso, Mariana. Já vamos resolver: estou abrindo um protocolo de troca agora.", at: 88, status: "delivered", content: ["type": "text", "reply_to": "m5", "reply_text": "O produto chegou assim, a caixa veio amassada 😕", "reply_from_me": false]),
            message("m9", "c_rich", "outbound", me, "Segue nossa política de troca.", at: 86, status: "read", attachments: ["md_pdf"], content: ["type": "document"]),
            message("m10", "c_rich", "customer", customer, "", at: 60, content: ["type": "location", "location": ["latitude": -23.561414, "longitude": -46.655881, "name": "Casa", "address": "Av. Paulista, 1000 - Bela Vista, São Paulo"] as Row]),
            message("m11", "c_rich", "customer", customer, "", at: 58, content: ["type": "contacts", "contacts": [["name": "Carlos (portaria)", "phone": "+5511912345678"] as Row]]),
            message("m12", "c_rich", "outbound", me, "Perfeito! A transportadora retira amanhã entre 9h e 12h.", at: 55, status: "sent", content: ["type": "text", "edited": true]),
            message("m13", "c_rich", "outbound", me, "Enviei o código de rastreio por e-mail também.", at: 52, status: "failed"),
            message("m14", "c_rich", "outbound", me, "", at: 49, status: "played", attachments: ["md_voz2"], content: ["type": "voice"]),
            message("m15", "c_rich", "customer", customer, "Combinado! Muito obrigada pela atenção 🙏", at: 46, content: ["type": "text"]),
            message("m16", "c_rich", "outbound", "bot:b_vendas", "Se precisar de algo mais, é só chamar. Temos frete grátis nas trocas até domingo.", at: 44, status: "delivered"),
        ]
        deliveries["c_rich"] = []
        messages["c_queue"] = [
            message("q1", "c_queue", "customer", "customer:q", "Bom dia! Meu sistema parou de emitir nota fiscal desde ontem.", at: 14, content: ["type": "text"]),
            message("q2", "c_queue", "outbound", "system", "Vou encaminhar sua solicitação para o setor Suporte.", at: 13, status: "delivered"),
            message("q3", "c_queue", "customer", "customer:q", "Preciso resolver isso hoje, por favor.", at: 12, content: ["type": "text"]),
        ]
        messages["c_queue2"] = [
            message("r1", "c_queue2", "customer", "customer:r", "Olá, quero falar com um atendente", at: 3, content: ["type": "text"]),
        ]
        messages["c_5h"] = [
            message("j1", "c_5h", "customer", "customer:j", "Consegue alterar o endereço de entrega?", at: 19 * 60 - 2, content: ["type": "text"]),
            message("j2", "c_5h", "outbound", me, "Claro, João! Me passa o novo endereço completo, por favor.", at: 19 * 60 - 6, status: "read"),
            message("j3", "c_5h", "outbound", me, "", at: 58, status: "delivered", attachments: ["md_video"], content: ["type": "video"]),
        ]
        messages["c_40"] = [
            message("p1", "c_40", "outbound", me, "Bom dia, Patrícia! Segue o orçamento atualizado.", at: 23 * 60 + 30, status: "read"),
            message("p2", "c_40", "customer", "customer:p", "Vou analisar e te retorno ainda hoje.", at: 23 * 60 + 20, content: ["type": "text"]),
            message("p3", "c_40", "note", me, "Retornar antes de a janela fechar.", at: 23 * 60 + 15),
        ]
        messages["c_closedwin"] = [
            message("w1", "c_closedwin", "customer", "customer:w", "Recebi duas cobranças na fatura deste mês.", at: 30 * 60, content: ["type": "text"]),
            message("w2", "c_closedwin", "outbound", me, "Roberto, já identifiquei a duplicidade e pedi o estorno. Volto a falar assim que for confirmado.", at: 29 * 60, status: "read"),
        ]
        messages["c_bot"] = [
            message("b1", "c_bot", "customer", "customer:b", "Vocês têm o modelo em azul?", at: 126, content: ["type": "text"]),
            message("b2", "c_bot", "outbound", "bot:b_vendas", "Temos sim, Camila! O modelo azul está disponível nos tamanhos P, M e G. Quer que eu reserve um para você?", at: 125.5, status: "read"),
            message("b3", "c_bot", "customer", "customer:b", "Quero o M, por favor", at: 125, content: ["type": "text"]),
            message("b4", "c_bot", "outbound", "bot:b_vendas", "Reservado! Vou te enviar o link de pagamento.", at: 124, status: "delivered"),
        ]
        messages["c_other"] = [
            message("e1", "c_other", "customer", "customer:e", "O aplicativo não está sincronizando os pedidos.", at: 182, content: ["type": "text"]),
            message("e2", "c_other", "outbound", "u_ana", "Oi, Eduardo! Sou a Ana, do Suporte. Pode me informar a versão instalada?", at: 178, status: "read"),
            message("e3", "c_other", "customer", "customer:e", "Versão 4.2.1", at: 180, content: ["type": "text"]),
        ].sorted { ($0["created"] as? Int64 ?? 0) < ($1["created"] as? Int64 ?? 0) }
        messages["c_group"] = [
            message("g1", "c_group", "customer", "customer:g:1", "Pessoal, chegou a reposição de estoque?", at: 250, content: ["type": "text", "participant": "5511900000001", "participant_name": "Rafael Gomes"]),
            message("g2", "c_group", "customer", "customer:g:2", "Chegou agora há pouco, estou conferindo as caixas.", at: 246, content: ["type": "text", "participant": "5511900000002", "participant_name": "Juliana Prado"]),
            message("g3", "c_group", "outbound", "bot:attendant", "Posso registrar a conferência no sistema quando terminarem. É só me mencionar.", at: 244, status: "delivered", content: ["type": "text", "receipts": ["5511900000001": ["status": "read", "timestamp": ago(243)] as Row, "5511900000002": ["status": "delivered", "timestamp": ago(243)] as Row] as Row]),
            message("g4", "c_group", "customer", "customer:g:3", "Faltaram 2 unidades do item 1042.", at: 240, content: ["type": "text", "participant": "5511900000003", "participant_name": "Thiago Moreira"]),
        ]
        messages["c_closed"] = [
            message("a1", "c_closed", "customer", "customer:a", "A garantia estendida cobre troca de bateria?", at: 2 * 24 * 60 + 20, content: ["type": "text"]),
            message("a2", "c_closed", "outbound", me, "Cobre sim, Aline, por 24 meses a partir da compra.", at: 2 * 24 * 60 + 5, status: "read"),
            message("a3", "c_closed", "customer", "customer:a", "Obrigada!", at: 2 * 24 * 60, content: ["type": "text"]),
        ]

        func ticket(_ id: String, _ number: String, _ title: String, conversation: String, status: String, owner: String?, due: Double?, firstResponse: Double? = nil, created: Double, updated: Double, category: String? = nil) -> Row {
            ["id": id, "number": number, "profile_id": "demo", "conversation_id": conversation, "title": title, "status": status,
             "owner": owner ?? NSNull() as Any, "response_due_at": due.map { ago(-$0) } ?? NSNull() as Any,
             "first_response_at": firstResponse.map { ago($0) } ?? NSNull() as Any, "created": ago(created), "updated": ago(updated),
             "category": category ?? NSNull() as Any]
        }
        // Os seis estados (docs/CENTRAL-ATENDIMENTO.md §2), com categoria: Recebido (atrasado e vencendo), Em análise,
        // Aguardando cliente, Aguardando terceiro, Resolvido e Encerrado (este sem categoria).
        tickets = [
            ticket("t_cobranca", "WA-MF2A-1K9P", "Cobrança em duplicidade na fatura de outubro", conversation: "c_closedwin", status: "open", owner: "u_ana", due: -125, created: 29 * 60, updated: 29 * 60, category: "fagoo-erp"),
            ticket("t_troca", "WA-MF3K-7Q2D", "Troca de produto avariado: pedido #48213", conversation: "c_rich", status: "open", owner: me, due: 40, created: 87, updated: 70, category: "outro"),
            ticket("t_endereco", "WA-MF1C-88XZ", "Atualização do endereço de entrega", conversation: "c_5h", status: "in_progress", owner: me, due: 5 * 60, created: 18 * 60, updated: 17 * 60, category: "wabotia"),
            ticket("t_nota", "WA-MEZ7-3H5T", "Segunda via de nota fiscal", conversation: "c_other", status: "waiting_customer", owner: "u_marina", due: -60, firstResponse: 170, created: 4 * 60, updated: 95, category: "nfse-leve"),
            ticket("t_integracao", "WA-MEY4-5T8R", "Webhook do ERP parou de receber os pedidos", conversation: "c_queue", status: "waiting_third", owner: "u_marina", due: -20 * 60, firstResponse: 25 * 60, created: 26 * 60, updated: 22 * 60, category: "servidor-integracao"),
            ticket("t_etiqueta", "WA-MEX9-2L4C", "Etiquetas saindo cortadas na impressora térmica", conversation: "c_40", status: "resolved", owner: "u_ana", due: -40 * 60, firstResponse: 43 * 60, created: 44 * 60, updated: 38 * 60, category: "printher"),
            ticket("t_garantia", "WA-MEX2-0B6M", "Dúvida sobre garantia estendida", conversation: "c_closed", status: "closed", owner: me, due: nil, firstResponse: 2 * 24 * 60 + 4, created: 2 * 24 * 60 + 18, updated: 2 * 24 * 60 - 30),
        ]
        func update(_ id: String, _ ticket: String, _ actor: String, _ text: String, at minutes: Double, internalNote: Bool = false) -> Row {
            ["id": id, "ticket_id": ticket, "actor": actor, "text": text, "internal": internalNote ? 1 : 0, "created": ago(minutes)]
        }
        ticketUpdates["t_troca"] = [
            update("tu1", "t_troca", me, "Cliente enviou foto da caixa amassada. Aguardando a coleta da transportadora.", at: 70, internalNote: true),
        ]
        ticketUpdates["t_endereco"] = [update("tu2", "t_endereco", me, "Endereço novo conferido com o cliente; falta confirmar com a transportadora.", at: 17 * 60, internalNote: true)]
        ticketUpdates["t_nota"] = [
            update("tu3", "t_nota", "u_marina", "Solicitamos a segunda via ao setor fiscal. Prazo de até 1 dia útil.", at: 170),
            update("tu4", "t_nota", "u_marina", "Nota fiscal reenviada para o e-mail cadastrado.", at: 95),
        ]
        ticketUpdates["t_integracao"] = [
            update("tu8", "t_integracao", "u_marina", "Identificamos que o fornecedor do ERP trocou o certificado. Abrimos um chamado com eles.", at: 25 * 60),
            update("tu9", "t_integracao", "u_marina", "Aguardando o fornecedor liberar o novo certificado.", at: 22 * 60, internalNote: true),
        ]
        ticketUpdates["t_etiqueta"] = [
            update("tu10", "t_etiqueta", "u_ana", "Ajustamos o tamanho da etiqueta no modelo de impressão. Pode testar com um pedido novo?", at: 43 * 60),
            update("tu11", "t_etiqueta", "u_ana", "Cliente confirmou que as etiquetas voltaram a sair inteiras.", at: 38 * 60),
        ]
        ticketUpdates["t_garantia"] = [
            update("tu5", "t_garantia", me, "A garantia estendida cobre a troca de bateria por 24 meses.", at: 2 * 24 * 60 + 4),
            update("tu6", "t_garantia", "system", "Cliente confirmou que a dúvida foi resolvida.", at: 2 * 24 * 60),
            update("tu7", "t_garantia", me, "Protocolo encerrado.", at: 2 * 24 * 60 - 30),
        ]

        func call(_ id: String, _ conversation: String, _ direction: String, _ status: String, at minutes: Double, duration: Int? = nil, actor: String? = nil) -> Row {
            ["id": id, "conversation_id": conversation, "direction": direction, "actor": actor ?? NSNull() as Any, "status": status, "error": NSNull(),
             "started": duration == nil ? NSNull() : ago(minutes) as Any, "ended": duration == nil ? NSNull() : ago(minutes - Double(duration ?? 0) / 60) as Any,
             "duration": duration ?? NSNull() as Any, "created": ago(minutes), "updated": ago(minutes)]
        }
        calls = [
            call("k1", "c_rich", "inbound", "completed", at: 185, duration: 252, actor: me),
            call("k2", "c_other", "inbound", "missed", at: 5 * 60),
            call("k3", "c_5h", "outbound", "completed", at: 20 * 60, duration: 95, actor: me),
            call("k4", "c_40", "outbound", "rejected", at: 2 * 24 * 60, actor: me),
        ]

        chats = [
            ["id": "ic_ana", "profile_id": "demo", "member_a": "u_ana", "member_b": me, "created": ago(3 * 24 * 60), "updated": ago(25), "peer_id": "u_ana"],
            ["id": "ic_vendas", "profile_id": "demo", "member_a": "bot:b_vendas", "member_b": me, "created": ago(2 * 24 * 60), "updated": ago(200), "peer_id": "bot:b_vendas"],
        ]
        func internalMessage(_ id: String, _ author: String, _ text: String, at minutes: Double, status: String = "sent") -> Row {
            ["id": id, "author": author, "text": text, "created": ago(minutes), "status": status, "run_id": NSNull()]
        }
        chatMessages["ic_ana"] = [
            internalMessage("im1", me, "Ana, você consegue assumir o Eduardo? Ele precisa do Suporte.", at: 175),
            internalMessage("im2", "u_ana", "Consigo sim, já transferi para mim.", at: 172),
            internalMessage("im3", me, "Obrigado! Qualquer coisa me chama.", at: 171),
            internalMessage("im4", "u_ana", "Fechado. Depois te conto como ficou a sincronização dele.", at: 25),
        ]
        chatMessages["ic_vendas"] = [
            internalMessage("im5", me, "Qual é o prazo de entrega para a região Sul?", at: 201, status: "completed"),
            internalMessage("im6", "bot:b_vendas", "Para a região Sul o prazo é de 3 a 5 dias úteis após a confirmação do pagamento. Capitais recebem em até 3 dias.", at: 200),
        ]

        func run(_ id: String, _ bot: String, _ status: String, _ input: String, result: String? = nil, error: String? = nil, at minutes: Double) -> Row {
            ["id": id, "profile_id": "demo", "bot_id": bot, "actor": me, "conversation_id": NSNull(), "status": status, "input": input,
             "result": result ?? NSNull() as Any, "error": error ?? NSNull() as Any, "attachments": [String](), "created": ago(minutes), "updated": ago(minutes - 0.5)]
        }
        runs = [
            run("run1", "b_vendas", "completed", "Cliente 5511987654321 perguntou: vocês fazem troca de produto avariado?", result: "Sim. A troca é gratuita em até 30 dias, com coleta pela transportadora no endereço do cliente.", at: 92),
            run("run2", "b_suporte", "failed", "Como reinstalar o módulo fiscal?", error: "O bot Suporte está indisponível no momento.", at: 6 * 60),
            run("run3", "b_vendas", "completed", "Resuma a política de frete grátis.", result: "Frete grátis em compras acima de R$ 199 para Sul e Sudeste, e em todas as trocas até domingo.", at: 26 * 60),
        ]
    }

    /// Inclui uma ligação tocando (para as telas `ringing` e `call-incoming`). Devolve o id.
    @discardableResult
    func addRingingCall() -> String {
        DemoServer.queue.sync { () -> String in
            if let existing = calls.first(where: { $0["status"] as? String == "ringing" }) { return existing["id"] as? String ?? "" }
            let id = "k_ring"
            calls.insert(["id": id, "conversation_id": "c_queue", "direction": "inbound", "actor": NSNull(), "status": "ringing", "error": NSNull(),
                          "started": NSNull(), "ended": NSNull(), "duration": NSNull(), "created": now, "updated": now], at: 0)
            return id
        }
    }

    // MARK: - Utilidades

    private func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func parse(_ text: Any?) -> Any? {
        guard let text = text as? String, let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private func ok(_ value: Row) -> Reply { encode(value) }
    private func ok(_ list: [Row]) -> Reply { encode(list) }
    private func encode(_ value: Any) -> Reply {
        Reply(status: 200, data: (try? JSONSerialization.data(withJSONObject: value)) ?? Data())
    }

    private func fail(_ status: Int, _ code: String, _ message: String) -> Reply {
        Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message, "request_id": "demo"]])) ?? Data())
    }

    private func emit(_ kind: String, resource: String? = nil, _ payload: Row) {
        eventId += 1
        events.append(["id": eventId, "profile_id": "demo", "kind": kind, "resource_id": resource ?? NSNull() as Any, "payload": payload, "created": now])
        if events.count > 400 { events.removeFirst(events.count - 400) }
    }

    private func schedule(after seconds: Double, _ run: @escaping () -> Void) {
        scheduled.append((now + Int64(seconds * 1000), run))
    }

    private func runScheduled() {
        let due = scheduled.filter { $0.due <= now }
        scheduled.removeAll { $0.due <= now }
        due.forEach { $0.run() }
    }

    private func index(ofConversation id: String) -> Int? { conversations.firstIndex { $0["id"] as? String == id } }

    /// Ativo = não é `resolved` nem `closed` (docs/CENTRAL-ATENDIMENTO.md §2).
    private func isActive(_ ticket: Row) -> Bool {
        let status = ticket["status"] as? String ?? ""
        return status != "resolved" && status != "closed"
    }

    private func isEnabledCategory(_ id: String) -> Bool {
        ticketCategories.contains { $0["id"] as? String == id && ($0["enabled"] as? Bool ?? true) }
    }

    /// `last_message` de GET /conversations (§6): a última mensagem da conversa, ou nulo.
    private func lastMessage(_ conversationId: String) -> Any {
        guard let last = messages[conversationId]?.last(where: { $0["direction"] as? String != "system" }) else { return NSNull() }
        let attachments = parse(last["attachments"]) as? [String] ?? []
        let content = parse(last["content"]) as? Row ?? [:]
        let type = content["type"] as? String ?? ""
        let mime = attachments.first.flatMap { media[$0]?["type"] as? String } ?? ""
        let kind: String
        if content["location"] != nil { kind = "location" }
        else if content["contacts"] != nil { kind = "contacts" }
        else if type == "voice" { kind = "audio" }
        else if ["image", "video", "audio", "document", "sticker", "interactive"].contains(type) { kind = type }
        else if mime.hasPrefix("image/") { kind = "image" }
        else if mime.hasPrefix("video/") { kind = "video" }
        else if mime.hasPrefix("audio/") { kind = "audio" }
        else if !attachments.isEmpty { kind = "document" }
        else { kind = "text" }
        return ["text": last["text"] ?? "", "direction": last["direction"] ?? "", "created": last["created"] ?? 0,
                "delivery_status": last["delivery_status"] ?? "", "attachments": attachments.count, "kind": kind] as Row
    }

    private func isOfficial(_ conversation: Row) -> Bool {
        let line = lines.first { $0["id"] as? String == conversation["connection_id"] as? String }
        return ["meta", "zernio"].contains(line?["kind"] as? String ?? "")
    }

    private func windowOpen(_ conversation: Row) -> Bool {
        guard isOfficial(conversation), conversation["chat_type"] as? String != "group" else { return true }
        let last = conversation["last_customer"] as? Int64 ?? 0
        return last > 0 && now - last < 24 * 3600 * 1000
    }

    private func team() -> [Row] {
        let people: [Row] = presence.map { ["id": $0["actor"] ?? "", "kind": "user", "name": $0["name"] ?? "", "online": ($0["present"] as? Int ?? 0) == 1] }
        let robots: [Row] = bots.map {
            ["id": "bot:\($0["id"] ?? "")", "kind": "bot", "bot_id": $0["id"] ?? "", "name": $0["name"] ?? "", "online": $0["online"] ?? false,
             "enabled": ($0["enabled"] as? Int ?? 0) == 1, "last_seen": now, "line_ids": $0["line_ids"] ?? NSNull()]
        }
        return people + robots
    }

    private func botRow(_ bot: Row) -> Row {
        var row = bot
        row["online"] = nil
        if let list = bot["line_ids"] as? [String] { row["line_ids"] = json(list) } else { row["line_ids"] = NSNull() }
        return row
    }

    private func capabilities(_ conversation: Row) -> Row {
        let group = conversation["chat_type"] as? String == "group"
        let meta = conversation["connection_id"] as? String == "line_meta"
        return ["text": true, "document": true, "image": true, "video": true, "audio": true, "voice": true, "sticker": true, "reply": true,
                "reaction": true, "location": !group, "contacts": !group, "edit": true, "delete": true, "read": true, "mentions": group,
                "groups": true, "group_manage": false, "calls": meta && !group, "video_calls": false, "upgrade_required": false]
    }

    // MARK: - Rotas

    func handle(method: String, url: URL, body data: Data) -> Reply {
        runScheduled()
        let parts = url.path.split(separator: "/").map(String.init)
        var query: [String: String] = [:]
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.forEach { query[$0.name] = $0.value ?? "" }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? Row ?? [:]

        func m(_ pattern: String) -> [String]? {
            let wanted = pattern.split(separator: "/").map(String.init)
            guard wanted.count == parts.count else { return nil }
            var captures: [String] = []
            for (a, b) in zip(wanted, parts) {
                if a == "*" { captures.append(b) } else if a != b { return nil }
            }
            return captures
        }
        let get = method == "GET", post = method == "POST", put = method == "PUT", patch = method == "PATCH", delete = method == "DELETE"
        let session: Row = ["token": "wabu_demo", "expires": now + 30 * 86_400_000, "user": ["id": me, "name": "Bruno Martins", "email": "bruno@demo.wabotia", "role": "admin", "profiles": ["demo"]] as Row]

        // Descoberta e conta
        if get, m("api/health") != nil { return ok(["service": "wabotia", "version": "0.14.0", "commit": "demo"]) }
        if get, m("api/auth/status") != nil { return ok(["initialized": true, "configured": true]) }
        if post, m("api/auth/mobile/login") != nil {
            guard (body["password"] as? String)?.isEmpty == false else { return fail(401, "invalid_credentials", "E-mail ou senha incorretos.") }
            return ok(session)
        }
        if post, m("api/v1/auth/mobile/refresh") != nil { return ok(session) }
        if post, m("api/v1/logout") != nil { return ok(["ok": true]) }
        if get, m("api/v1/me") != nil { return ok(["id": me, "kind": "user", "name": "Bruno Martins", "role": "admin", "profiles": ["demo"]]) }
        if get, m("api/v1/profiles") != nil {
            var list: [Row] = [["id": "demo", "name": "Queven Atendimento", "enabled": 1]]
            if extraProfile { list.append(["id": "demo2", "name": "Queven Loja Virtual", "enabled": 0]) }
            return ok(list)
        }
        if get, m("api/v1/devices") != nil { return ok(["data": [Row]()]) }
        if put, let c = m("api/v1/devices/*") { return ok(["id": c[0], "platform": "ios", "enabled": 1, "profiles": [String]()]) }
        if delete, m("api/v1/devices/*") != nil { return ok(["ok": true]) }
        if post, m("api/v1/devices/*/test") != nil { return ok(["results": [["status": "ok"]]]) }

        // Execuções de bot (fora do perfil)
        if post, m("api/v1/bot-runs") != nil {
            let id = nextId("run_n")
            let run: Row = ["id": id, "profile_id": "demo", "bot_id": body["bot_id"] ?? "", "actor": me, "conversation_id": NSNull(), "status": "queued",
                            "input": body["input"] ?? "", "result": NSNull(), "error": NSNull(), "attachments": [String](), "created": now, "updated": now]
            runs.insert(run, at: 0)
            schedule(after: 1.5) { [weak self] in self?.setRun(id, status: "running") }
            schedule(after: 5) { [weak self] in self?.setRun(id, status: "completed", result: "Esta é uma resposta de demonstração do bot. Em um servidor real, o bot consultaria a base de conhecimento do perfil.") }
            return Reply(status: 202, data: ok(run).data)
        }
        if get, let c = m("api/v1/bot-runs/*") {
            guard let run = runs.first(where: { $0["id"] as? String == c[0] }) else { return fail(404, "not_found", "Execução não encontrada.") }
            return ok(run)
        }

        guard parts.count >= 4, parts[0] == "api", parts[1] == "v1", parts[2] == "profiles" else {
            return fail(404, "not_found", "Recurso não encontrado.")
        }
        let base = "api/v1/profiles/*/"

        // Perfil
        if get, m(base + "status") != nil {
            var counts: [String: Int] = [:]
            conversations.forEach { counts[$0["state"] as? String ?? "", default: 0] += 1 }
            return ok([
                "settings": ["departments": departments, "menus": menus, "apps": [Row](), "ticket_categories": ticketCategories] as Row,
                "enabled": 1,
                "conversations": counts.map { ["state": $0.key, "count": $0.value] as Row },
                "deliveries": [Row](),
                "connections": lines.map { ["id": $0["id"] ?? "", "name": $0["name"] ?? "", "kind": $0["kind"] ?? "", "status": $0["status"] ?? "", "last_seen": now] as Row },
            ])
        }
        if get, m(base + "presence") != nil { return ok(presence) }
        if put, m(base + "presence") != nil {
            let present = body["present"] as? Bool ?? false
            if let i = presence.firstIndex(where: { $0["actor"] as? String == me }) { presence[i]["present"] = present ? 1 : 0 }
            return ok(["actor": me, "present": present])
        }
        if get, m(base + "events") != nil {
            let after = Int64(query["after"] ?? "0") ?? 0
            let fresh = events.filter { ($0["id"] as? Int64 ?? 0) > after }
            return ok(["data": Array(fresh.prefix(100)), "cursor": fresh.prefix(100).last?["id"] ?? max(after, eventId)])
        }
        if get, m(base + "team") != nil { return ok(["data": team()]) }
        if get, m(base + "lines") != nil { return ok(["data": lines]) }
        if put, let c = m(base + "lines/*") {
            guard let i = lines.firstIndex(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Linha não encontrada.") }
            if let service = body["service"] as? Row { lines[i]["service"] = service }
            if let policy = body["number_policy"] as? Row { lines[i]["number_policy"] = policy }
            return ok(lines[i])
        }
        if get, m(base + "menus") != nil { return ok(["data": menus]) }
        if put, m(base + "settings") != nil {
            if let list = body["menus"] as? [Row] { menus = list }
            return ok(["ok": true])
        }
        if get, m(base + "bots") != nil { return ok(["data": bots.map(botRow)]) }
        if patch, let c = m(base + "bots/*") {
            guard let i = bots.firstIndex(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Bot não encontrado.") }
            bots[i]["line_ids"] = (body["line_ids"] as? [String]) ?? NSNull() as Any
            return ok(botRow(bots[i]))
        }
        if get, m(base + "bot-runs") != nil { return ok(["data": runs]) }
        if post, let c = m(base + "bot-runs/*/cancel") {
            setRun(c[1], status: "cancelled")
            return ok(["ok": true])
        }

        // Conversas
        if get, m(base + "conversations") != nil {
            var list = conversations
            if let state = query["state"], !state.isEmpty { list = list.filter { $0["state"] as? String == state } }
            if let q = query["q"]?.lowercased(), !q.isEmpty {
                list = list.filter { c in
                    [c["contact_name"], c["title"], c["phone"], c["external_id"]].compactMap { $0 as? String }.contains { $0.lowercased().contains(q) }
                }
            }
            list.sort { ($0["updated"] as? Int64 ?? 0) > ($1["updated"] as? Int64 ?? 0) }
            list = list.map { row in
                var row = row
                row["last_message"] = lastMessage(row["id"] as? String ?? "")
                return row
            }
            return ok(["data": list, "next_cursor": NSNull()])
        }
        if get, let c = m(base + "conversations/*") { return detail(c[1]) }
        if post, let c = m(base + "conversations/*/actions") { return action(c[1], body) }
        if post, let c = m(base + "conversations/*/message-actions") { return messageAction(c[1], body) }
        if get, m(base + "conversations/*/call-permission") != nil {
            return ok(["permission": ["status": "temporary"], "actions": [["action_name": "start_call", "can_perform_action": true] as Row, ["action_name": "send_call_permission_request", "can_perform_action": true] as Row]])
        }
        if put, let c = m(base + "conversations/*/contact") {
            guard let i = index(ofConversation: c[1]) else { return fail(404, "not_found", "Conversa não encontrada.") }
            let name = body["name"] as? String ?? ""
            contacts[c[1]] = ["id": "ct_\(c[1])", "name": name, "phone": body["phone"] ?? conversations[i]["phone"] ?? ""]
            conversations[i]["contact_name"] = name
            return ok(contacts[c[1]] ?? [:])
        }
        if put, let c = m(base + "groups/*/policy") {
            guard let i = index(ofConversation: c[1]) else { return fail(404, "not_found", "Grupo não encontrado.") }
            conversations[i]["bot_policy"] = body["bot_policy"] ?? "mentions"
            return ok(conversations[i])
        }
        if get, let c = m(base + "contacts/*") { return ok(contacts.values.first { $0["id"] as? String == c[1] } ?? [:]) }

        // Mídia
        if post, m(base + "media/uploads") != nil {
            let id = nextId("up_")
            let size = body["size"] as? Int ?? 0
            let partSize = 5 * 1024 * 1024
            uploads[id] = (body["name"] as? String ?? "arquivo", body["type"] as? String ?? "application/octet-stream", [:])
            return ok(["id": id, "part_size": partSize, "parts": max(1, Int((Double(size) / Double(partSize)).rounded(.up)))])
        }
        if put, let c = m(base + "media/uploads/*/parts/*") {
            uploads[c[1]]?.parts[Int(c[2]) ?? 0] = data
            return ok(["ok": true])
        }
        if post, let c = m(base + "media/uploads/*/complete") {
            guard let upload = uploads[c[1]] else { return fail(404, "not_found", "Envio não encontrado.") }
            var bytes = Data()
            upload.parts.keys.sorted().forEach { bytes.append(upload.parts[$0] ?? Data()) }
            let id = "md_\(c[1])"
            media[id] = ["id": id, "name": upload.name, "type": upload.type, "size": bytes.count]
            mediaBytes[id] = bytes
            uploads[c[1]] = nil
            return ok(["id": id, "name": upload.name, "size": bytes.count, "status": "ready"])
        }
        if post, let c = m(base + "media/uploads/*/abort") {
            uploads[c[1]] = nil
            return ok(["id": c[1], "status": "aborted"])
        }
        if get, let c = m(base + "media/*/content") {
            guard let file = media[c[1]] else { return fail(404, "not_found", "Anexo não encontrado.") }
            let type = file["type"] as? String ?? "application/octet-stream"
            let bytes = mediaBytes[c[1]] ?? DemoMedia.bytes(for: type, name: file["name"] as? String ?? "")
            mediaBytes[c[1]] = bytes
            return Reply(status: 200, data: bytes, type: type)
        }

        // Protocolos
        if get, m(base + "tickets") != nil {
            var list = tickets
            if let status = query["status"], !status.isEmpty {
                guard ticketStatuses.contains(status) else { return fail(400, "invalid", "Estado de protocolo inválido.") }
                list = list.filter { $0["status"] as? String == status }
            }
            if query["active"] == "1" { list = list.filter(isActive) }
            if let category = query["category"], !category.isEmpty { list = list.filter { $0["category"] as? String == category } }
            if query["overdue"] == "1" {
                list = list.filter { isActive($0) && $0["first_response_at"] is NSNull && ($0["response_due_at"] as? Int64 ?? Int64.max) < now }
            }
            if let q = query["q"], !q.isEmpty {
                let digits = q.filter(\.isNumber)
                list = list.filter { t in
                    if (t["number"] as? String ?? "").lowercased().contains(q.lowercased()) { return true }
                    guard !digits.isEmpty, let c = conversations.first(where: { $0["id"] as? String == t["conversation_id"] as? String }) else { return false }
                    return (c["phone"] as? String ?? "").contains(digits)
                }
            }
            return ok(["data": list, "next_cursor": NSNull()])
        }
        if post, m(base + "tickets") != nil {
            let title = (body["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return fail(400, "invalid", "Informe o título do protocolo.") }
            let category = (body["category"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            if let category, !isEnabledCategory(category) { return fail(400, "invalid", "Categoria de protocolo desconhecida.") }
            let id = nextId("t_n")
            let number = "WA-MF4\(Int.random(in: 0...9))-\(String(format: "%04d", Int.random(in: 0...9999)))"
            let conversation = body["conversation_id"] as? String ?? ""
            let ticket: Row = ["id": id, "number": number, "profile_id": "demo", "conversation_id": conversation, "title": title, "status": "open", "owner": me,
                               "response_due_at": now + 4 * 3_600_000, "first_response_at": NSNull(), "created": now, "updated": now,
                               "category": category ?? NSNull() as Any]
            tickets.insert(ticket, at: 0)
            emit("ticket.created", resource: id, ["id": id, "number": number, "conversation_id": conversation])
            return ok(ticket)
        }
        if get, let c = m(base + "tickets/*") {
            guard let ticket = tickets.first(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Protocolo não encontrado.") }
            let conversation = conversations.first { $0["id"] as? String == ticket["conversation_id"] as? String } ?? [:]
            return ok(["ticket": ticket, "updates": ticketUpdates[c[1]] ?? [],
                       "conversation": ["id": conversation["id"] ?? "", "phone": conversation["phone"] ?? NSNull(), "external_id": conversation["external_id"] ?? "",
                                        "title": conversation["title"] ?? "", "state": conversation["state"] ?? "", "owner": conversation["owner"] ?? NSNull(),
                                        "contact_name": conversation["contact_name"] ?? NSNull()] as Row])
        }
        if patch, let c = m(base + "tickets/*") {
            guard let i = tickets.firstIndex(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Protocolo não encontrado.") }
            if body.keys.contains("response_due_at") {
                guard tickets[i]["first_response_at"] is NSNull, isActive(tickets[i]) else { return fail(400, "invalid", "O prazo só pode ser alterado antes da primeira resposta.") }
                tickets[i]["response_due_at"] = (body["response_due_at"] as? NSNumber)?.int64Value ?? NSNull() as Any
            }
            if let status = body["status"] as? String {
                guard ticketStatuses.contains(status) else { return fail(400, "invalid", "Estado inválido.") }
                tickets[i]["status"] = status
            }
            if body.keys.contains("category") {
                // `category: null` limpa; valor desconhecido (ou desabilitado) é recusado com 400.
                let category = (body["category"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                if let category, !isEnabledCategory(category) { return fail(400, "invalid", "Categoria de protocolo desconhecida.") }
                tickets[i]["category"] = category ?? NSNull() as Any
            }
            if let owner = body["owner"] as? String { tickets[i]["owner"] = owner }
            if let text = body["text"] as? String, !text.isEmpty {
                ticketUpdates[c[1], default: []].append(["id": nextId("tu_n"), "ticket_id": c[1], "actor": me, "text": text, "internal": 0, "created": now])
                if tickets[i]["first_response_at"] is NSNull { tickets[i]["first_response_at"] = now }
            }
            tickets[i]["updated"] = now
            emit("ticket.updated", resource: c[1], ["status": tickets[i]["status"] ?? "", "number": tickets[i]["number"] ?? ""])
            return ok(tickets[i])
        }

        // Ligações
        if get, m(base + "calls") != nil {
            var list = calls
            if let conversation = query["conversation_id"], !conversation.isEmpty { list = list.filter { $0["conversation_id"] as? String == conversation } }
            return ok(["data": list, "next_cursor": NSNull()])
        }
        if get, let c = m(base + "calls/*") {
            guard let call = calls.first(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Ligação não encontrada.") }
            return ok(call)
        }
        if post, let c = m(base + "calls/*/claim") {
            guard let i = calls.firstIndex(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Ligação não encontrada.") }
            calls[i]["actor"] = me
            return ok(calls[i])
        }
        if post, let c = m(base + "calls/*/reject") {
            if let i = calls.firstIndex(where: { $0["id"] as? String == c[1] }) {
                calls[i]["status"] = "rejected"
                emit("call.updated", resource: c[1], ["conversation_id": calls[i]["conversation_id"] ?? "", "call_id": c[1], "status": "rejected", "direction": "inbound"])
            }
            return ok(["id": c[1], "status": "rejected"])
        }
        if post, parts.count >= 5, parts[4] == "calls" {
            return fail(422, "unsupported_capability", "A demonstração não faz ligações de verdade.")
        }

        // Conversas internas
        if get, m(base + "internal-chats") != nil {
            return ok(["data": chats.sorted { ($0["updated"] as? Int64 ?? 0) > ($1["updated"] as? Int64 ?? 0) }.map(chatRow)])
        }
        if post, m(base + "internal-chats") != nil {
            let peer = body["peer_id"] as? String ?? ""
            if let chat = chats.first(where: { $0["peer_id"] as? String == peer }) { return ok(chatRow(chat)) }
            let chat: Row = ["id": nextId("ic_n"), "profile_id": "demo", "member_a": peer, "member_b": me, "created": now, "updated": now, "peer_id": peer]
            chats.append(chat)
            return ok(chatRow(chat))
        }
        if get, let c = m(base + "internal-chats/*") {
            guard let chat = chats.first(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Conversa não encontrada.") }
            var row = chatRow(chat)
            row["messages"] = chatMessages[c[1]] ?? []
            return ok(row)
        }
        if post, let c = m(base + "internal-chats/*/messages") {
            guard let i = chats.firstIndex(where: { $0["id"] as? String == c[1] }) else { return fail(404, "not_found", "Conversa não encontrada.") }
            let peer = chats[i]["peer_id"] as? String ?? ""
            let toBot = peer.hasPrefix("bot:")
            let id = nextId("im_n")
            let message: Row = ["id": id, "author": me, "text": body["text"] ?? "", "created": now, "status": toBot ? "queued" : "sent", "run_id": NSNull()]
            chatMessages[c[1], default: []].append(message)
            chats[i]["updated"] = now
            if toBot {
                schedule(after: 3) { [weak self] in
                    guard let self else { return }
                    if let j = self.chatMessages[c[1]]?.firstIndex(where: { $0["id"] as? String == id }) { self.chatMessages[c[1]]?[j]["status"] = "completed" }
                    self.chatMessages[c[1], default: []].append(["id": self.nextId("im_n"), "author": peer, "text": "Resposta de demonstração: em um servidor real, o bot responderia com base no conhecimento do perfil.", "created": self.now, "status": "sent", "run_id": NSNull()])
                    self.emit("internal.message", ["chat_id": c[1]])
                }
            }
            return ok(message)
        }

        return fail(404, "not_found", "Recurso não encontrado.")
    }

    private func chatRow(_ chat: Row) -> Row {
        var row = chat
        let peer = chat["peer_id"] as? String ?? ""
        row["peer"] = team().first { $0["id"] as? String == peer } ?? ["id": peer, "kind": peer.hasPrefix("bot:") ? "bot" : "user", "name": "Contato indisponível", "online": false]
        row["peer_id"] = nil
        return row
    }

    private func setRun(_ id: String, status: String, result: String? = nil) {
        guard let i = runs.firstIndex(where: { $0["id"] as? String == id }) else { return }
        let current = runs[i]["status"] as? String ?? ""
        if ["cancelled", "completed", "failed"].contains(current) { return }
        runs[i]["status"] = status
        runs[i]["updated"] = now
        if let result { runs[i]["result"] = result }
    }

    // MARK: Conversa: detalhe e ações

    private func detail(_ id: String) -> Reply {
        guard let i = index(ofConversation: id) else { return fail(404, "not_found", "Conversa não encontrada.") }
        var conversation = conversations[i]
        conversation["contact_name"] = nil
        conversation["contact_id"] = nil
        let list = messages[id] ?? []
        var used: [Row] = []
        for message in list {
            for mediaId in (parse(message["attachments"]) as? [String] ?? []) {
                if let file = media[mediaId], !used.contains(where: { $0["id"] as? String == mediaId }) { used.append(file) }
            }
        }
        let group = conversation["chat_type"] as? String == "group"
        let line = lines.first { $0["id"] as? String == conversation["connection_id"] as? String }
        return ok([
            "conversation": conversation,
            "connection_kind": line?["kind"] ?? NSNull(),
            "server_now": now,
            "media": used,
            "capabilities": capabilities(conversation),
            "group": group ? ["id": id, "participants": ["5511900000001", "5511900000002", "5511900000003", "5511900000004", "5511900000005", "5511900000006"], "announcement": false] as Row : NSNull() as Any,
            "contact": contacts[id] ?? NSNull() as Any,
            "messages": list,
            "deliveries": deliveries[id] ?? [],
        ])
    }

    private func touch(_ i: Int) { conversations[i]["updated"] = now }

    private func appendOutbound(_ conversationId: String, author: String, text: String, attachments: [String] = [], content: Row = [:]) -> String {
        let deliveryId = nextId("d")
        guard let i = index(ofConversation: conversationId) else { return deliveryId }
        if !windowOpen(conversations[i]) {
            // Fora da janela: o servidor guarda a entrega e envia quando o cliente escrever.
            deliveries[conversationId, default: []].append(["id": deliveryId, "status": "pending", "error": NSNull(), "created": now])
            return deliveryId
        }
        let id = "delivery:\(deliveryId)"
        messages[conversationId, default: []].append([
            "id": id, "profile_id": "demo", "conversation_id": conversationId, "direction": "outbound", "author": author, "text": text,
            "attachments": json(attachments), "external_id": "wamid.\(deliveryId)", "created": now, "content": json(content), "delivery_status": "sent", "status_at": now,
        ])
        touch(i)
        emit("message.sent", resource: deliveryId, ["conversation_id": conversationId, "text": text, "attachments": attachments])
        for (delay, status) in [(2.0, "delivered"), (6.0, "read")] {
            schedule(after: delay) { [weak self] in
                guard let self, let j = self.messages[conversationId]?.firstIndex(where: { $0["id"] as? String == id }) else { return }
                self.messages[conversationId]?[j]["delivery_status"] = status
                self.emit("message.updated", ["conversation_id": conversationId, "message_id": id, "action": "status", "status": status])
            }
        }
        return deliveryId
    }

    private func action(_ id: String, _ body: Row) -> Reply {
        guard let i = index(ofConversation: id) else { return fail(404, "not_found", "Conversa não encontrada.") }
        let action = body["action"] as? String ?? ""
        let owner = conversations[i]["owner"] as? String
        let state = conversations[i]["state"] as? String ?? ""
        let mine = owner == me && state == "human"
        switch action {
        case "claim":
            if state == "human", let owner, owner != me { return fail(409, "already_claimed", "Outro atendente assumiu a conversa.") }
            conversations[i]["state"] = "human"
            conversations[i]["owner"] = me
            conversations[i]["assigned_bot_id"] = NSNull()
            touch(i)
            emit("conversation.updated", resource: id, ["action": "claim"])
            return ok(conversations[i])
        case "transfer":
            if let department = body["department_id"] as? String, !department.isEmpty {
                conversations[i]["state"] = "waiting"
                conversations[i]["owner"] = NSNull()
                conversations[i]["assigned_bot_id"] = NSNull()
                conversations[i]["department_id"] = department
                touch(i)
                emit("conversation.updated", resource: id, ["state": "waiting", "department_id": department, "reason": "transfer"])
                return ok(conversations[i])
            }
            guard let target = body["target"] as? String, !target.isEmpty else { return fail(400, "invalid", "Escolha para quem transferir.") }
            if target.hasPrefix("bot:") {
                let bot = String(target.dropFirst(4))
                conversations[i]["state"] = "ai"
                conversations[i]["owner"] = NSNull()
                conversations[i]["assigned_bot_id"] = bot
                emit("conversation.updated", resource: id, ["action": "transfer", "assigned_bot_id": bot, "actor": me])
            } else {
                conversations[i]["state"] = "human"
                conversations[i]["owner"] = target
                conversations[i]["assigned_bot_id"] = NSNull()
                emit("conversation.updated", resource: id, ["action": "transfer", "owner": target, "actor": me])
            }
            touch(i)
            return ok(conversations[i])
        case "resume":
            conversations[i]["state"] = "ai"
            conversations[i]["owner"] = NSNull()
            conversations[i]["assigned_bot_id"] = NSNull()
            touch(i)
            emit("conversation.updated", resource: id, ["action": "resume"])
            return ok(conversations[i])
        case "resolve":
            conversations[i]["state"] = "closed"
            conversations[i]["owner"] = NSNull()
            touch(i)
            emit("conversation.updated", resource: id, ["action": "resolve"])
            return ok(conversations[i])
        case "tags":
            conversations[i]["tags"] = json(body["tags"] as? [String] ?? [])
            emit("conversation.updated", resource: id, ["action": "tags"])
            return ok(conversations[i])
        case "note":
            let text = body["text"] as? String ?? ""
            messages[id, default: []].append(["id": nextId("note"), "profile_id": "demo", "conversation_id": id, "direction": "note", "author": me, "text": text,
                                              "attachments": "[]", "external_id": NSNull(), "created": now, "content": "{}", "delivery_status": "", "status_at": 0])
            return ok(conversations[i])
        case "reply":
            guard mine else { return fail(403, "not_owner", "Assuma a conversa antes desta ação.") }
            let text = body["text"] as? String ?? ""
            let attachments = body["attachments"] as? [String] ?? []
            var content = body["content"] as? Row ?? [:]
            if let replyTo = content["reply_to"] as? String, let quoted = messages[id]?.first(where: { $0["id"] as? String == replyTo }) {
                content["reply_text"] = quoted["text"] as? String ?? ""
            }
            let wasOpen = windowOpen(conversations[i])
            let deliveryId = appendOutbound(id, author: me, text: text, attachments: attachments, content: content)
            if wasOpen, conversations[i]["chat_type"] as? String != "group" {
                // O cliente responde alguns segundos depois, para a demonstração mostrar não lidas e o anel enchendo.
                schedule(after: 9) { [weak self] in self?.customerReplies(id) }
            }
            return ok(["delivery_id": deliveryId, "status": "pending"])
        case "menu":
            let menuId = body["menu_id"] as? String
            let items = menus.filter { ($0["parent_id"] as? String) == menuId && ($0["enabled"] as? Bool ?? true) }
            let title = menuId.flatMap { parent in menus.first { $0["id"] as? String == parent }?["label"] as? String } ?? "Como podemos ajudar?"
            var text = title
            for (n, item) in items.enumerated() { text += "\n\(n + 1). \(item["label"] as? String ?? "")" }
            if menuId != nil { text += "\nEnvie MENU para voltar." }
            let deliveryId = appendOutbound(id, author: me, text: text)
            return ok(["delivery_id": deliveryId, "status": "pending", "menu_id": menuId ?? NSNull() as Any])
        case "protocols":
            let list = tickets.filter { $0["conversation_id"] as? String == id }
            let text = list.isEmpty ? "Você não tem protocolos em aberto." : "Seus protocolos:\n" + list.map { "\($0["number"] as? String ?? ""): \($0["title"] as? String ?? "")" }.joined(separator: "\n")
            let deliveryId = appendOutbound(id, author: me, text: text)
            return ok(["delivery_id": deliveryId, "delivery_ids": [deliveryId], "status": "pending", "data": list])
        case "survey":
            let deliveryId = appendOutbound(id, author: me, text: "Como você avalia este atendimento?\nResponda de 1 a 5 e, se desejar, escreva um comentário. Para sair da avaliação, envie MENU.")
            return ok(["survey_id": nextId("sv"), "delivery_id": deliveryId, "status": "pending"])
        default:
            return fail(400, "invalid", "Ação desconhecida.")
        }
    }

    private func customerReplies(_ id: String) {
        guard let i = index(ofConversation: id) else { return }
        let messageId = nextId("in")
        let text = ["Perfeito, obrigada! 👍", "Entendi, muito obrigado.", "Ótimo, fico no aguardo."].randomElement() ?? "Obrigado!"
        messages[id, default: []].append(["id": messageId, "profile_id": "demo", "conversation_id": id, "direction": "customer", "author": "customer:demo", "text": text,
                                          "attachments": "[]", "external_id": "wamid.\(messageId)", "created": now, "content": json(["type": "text"]), "delivery_status": "", "status_at": 0])
        conversations[i]["last_customer"] = now
        touch(i)
        emit("message.received", resource: messageId, ["conversation_id": id, "message_id": messageId, "text": text, "attachments": [String]()])
        // O cliente respondeu: protocolo que estava "Aguardando cliente" volta sozinho para "Em análise" (§2).
        for t in tickets.indices where tickets[t]["conversation_id"] as? String == id && tickets[t]["status"] as? String == "waiting_customer" {
            tickets[t]["status"] = "in_progress"
            tickets[t]["updated"] = now
            emit("ticket.updated", resource: tickets[t]["id"] as? String, ["status": "in_progress", "number": tickets[t]["number"] ?? ""])
        }
    }

    private func messageAction(_ id: String, _ body: Row) -> Reply {
        let messageId = body["message_id"] as? String ?? ""
        guard let j = messages[id]?.firstIndex(where: { $0["id"] as? String == messageId }) else { return fail(404, "not_found", "Mensagem não encontrada.") }
        var content = parse(messages[id]?[j]["content"]) as? Row ?? [:]
        let action = body["action"] as? String ?? ""
        switch action {
        case "reaction":
            var reactions = content["reactions"] as? Row ?? [:]
            reactions[me] = ["emoji": body["emoji"] as? String ?? "", "timestamp": now] as Row
            content["reactions"] = reactions
        case "edit":
            messages[id]?[j]["text"] = body["text"] as? String ?? ""
            content["edited"] = true
        case "delete":
            messages[id]?[j]["text"] = "Mensagem apagada"
            content["deleted"] = true
        case "read": break
        default: return fail(400, "invalid", "Ação desconhecida.")
        }
        messages[id]?[j]["content"] = json(content)
        emit("message.updated", ["conversation_id": id, "message_id": messageId, "action": action == "reaction" ? "reaction" : action, "status": NSNull()])
        return ok(["ok": true])
    }
}

/// Bytes de mídia de exemplo gerados na hora (imagem, PDF e áudio WAV).
enum DemoMedia {
    static func bytes(for type: String, name: String) -> Data {
        if type.hasPrefix("image/") { return image() }
        if type == "application/pdf" { return pdf(title: name) }
        if type.hasPrefix("audio/") { return wav(seconds: 4) }
        return Data("Arquivo de demonstração do Wabotia.\n".utf8)
    }

    private static func image() -> Data {
        let size = CGSize(width: 900, height: 680)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            let cg = context.cgContext
            let colors = [UIColor(hex: 0xD9C7A8).cgColor, UIColor(hex: 0x9C7B55).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            // Uma caixa de papelão amassada, vista de frente.
            let box = UIBezierPath()
            box.move(to: CGPoint(x: 230, y: 250))
            box.addLine(to: CGPoint(x: 660, y: 225))
            box.addLine(to: CGPoint(x: 690, y: 520))
            box.addLine(to: CGPoint(x: 470, y: 560))
            box.addLine(to: CGPoint(x: 250, y: 530))
            box.close()
            UIColor(hex: 0xB88A55).setFill()
            box.fill()
            let lid = UIBezierPath()
            lid.move(to: CGPoint(x: 230, y: 250))
            lid.addLine(to: CGPoint(x: 330, y: 160))
            lid.addLine(to: CGPoint(x: 730, y: 150))
            lid.addLine(to: CGPoint(x: 660, y: 225))
            lid.close()
            UIColor(hex: 0xCFA26C).setFill()
            lid.fill()
            let dent = UIBezierPath()
            dent.move(to: CGPoint(x: 400, y: 300))
            dent.addLine(to: CGPoint(x: 470, y: 380))
            dent.addLine(to: CGPoint(x: 430, y: 470))
            dent.move(to: CGPoint(x: 470, y: 380))
            dent.addLine(to: CGPoint(x: 560, y: 350))
            UIColor(hex: 0x7A5630).setStroke()
            dent.lineWidth = 7
            dent.lineCapStyle = .round
            dent.stroke()
            UIColor(hex: 0xE9DCC3).setFill()
            UIBezierPath(rect: CGRect(x: 450, y: 236, width: 46, height: 300)).fill(with: .normal, alpha: 0.55)
        }
    }

    private static func pdf(title: String) -> Data {
        let page = CGRect(x: 0, y: 0, width: 595, height: 842)
        return UIGraphicsPDFRenderer(bounds: page).pdfData { context in
            context.beginPage()
            let heading: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 24), .foregroundColor: UIColor(hex: 0x008069)]
            let body: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: UIColor.darkGray]
            ("Política de troca" as NSString).draw(at: CGPoint(x: 56, y: 64), withAttributes: heading)
            ("Documento de demonstração do Wabotia (\(title)).\n\nTrocas gratuitas em até 30 dias após o recebimento,\ncom coleta pela transportadora no endereço do cliente." as NSString)
                .draw(in: CGRect(x: 56, y: 112, width: 480, height: 300), withAttributes: body)
        }
    }

    /// WAV PCM 8 bits, mono, 8 kHz, com um tom suave.
    private static func wav(seconds: Int) -> Data {
        let rate = 8000
        let count = rate * seconds
        var data = Data()
        func append32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func append16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); append32(UInt32(36 + count)); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); append32(16); append16(1); append16(1); append32(UInt32(rate)); append32(UInt32(rate)); append16(1); append16(8)
        data.append(contentsOf: Array("data".utf8)); append32(UInt32(count))
        for n in 0..<count {
            let envelope = 0.35 * (0.6 + 0.4 * sin(Double(n) / Double(rate) * 6))
            data.append(UInt8(128 + 127 * envelope * sin(2 * .pi * 330 * Double(n) / Double(rate))))
        }
        return data
    }
}
#endif
