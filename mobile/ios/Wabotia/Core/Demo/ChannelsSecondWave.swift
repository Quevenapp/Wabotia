import Foundation

/// Demonstração em memória, sem transporte. Formato do plano; a conferir com a conta real.
/// Opt-in no Xcode: WABOTIA_DEMO_CHANNELS_SECOND_WAVE=1, ou `?canais=2` numa requisição da demo.
final class ChannelsSecondWave {
    typealias Row = [String: Any]
    static var environmentEnabled: Bool { ProcessInfo.processInfo.environment["WABOTIA_DEMO_CHANNELS_SECOND_WAVE"] == "1" }
    private let hour: Int64 = 3_600_000
    private let t0: Int64
    private var rows: [String: Row] = [:]
    private var messages: [String: [Row]] = [:]
    private var metadata: [String: Row] = [:]
    private var receipts: [String: (Data, DemoServer.Reply)] = [:]
    private var eventIds = Set<String>()
    private var remoteIds = Set<String>()
    private var slots: [String: Set<String>] = [:]
    private var sequence = 0
    private(set) var reservations = 0
    let channels = ["instagram", "facebook", "telegram", "email", "tiktok"]
    var lines: [Row] {
        channels.map { channel in
            ["id": "c2_line_\(channel)", "name": "Conta de exemplo · \(channel)", "kind": kind(channel),
             "channel": channel, "account_label": "Conta de exemplo", "mode": "direct", "status": "active",
             "number_policy": ["human": true, "bots": false, "menu": false, "service": true, "templates": false],
             "service": ["mode": "human", "menu_mode": "off"]] as Row
        }
    }

    init(t0: Int64) {
        self.t0 = t0
        for (id, channel, author, post, state, age) in [
            ("c2_comment_available", "instagram", "Lia Exemplo", "post-a", "available", 2),
            ("c2_comment_other_author", "instagram", "Davi Exemplo", "post-a", "available", 3),
            ("c2_comment_other_post", "instagram", "Lia Exemplo", "post-b", "available", 4),
            ("c2_comment_sent", "facebook", "Ari Exemplo", "post-a", "sent", 5),
            ("c2_comment_failed", "facebook", "Nina Exemplo", "post-a", "failed", 6),
            ("c2_comment_expired", "instagram", "Bia Exemplo", "post-b", "available", 169)
        ] {
            let comment: Row = ["id": "comment-\(id)", "postId": post, "text": "Tem esta opção em azul?",
                                "postText": "Novidades da coleção de verão.", "permalink": "https://loja.example/publicacao/\(post)",
                                "hidden": id == "c2_comment_failed", "version": 1, "privateState": state,
                                "privateExpiresAt": t0 + Int64(168 - age) * hour,
                                "privateLinkPending": state == "sent"]
            add(id, channel: channel, title: author, context: "comment", text: "Tem esta opção em azul?",
                metadata: ["comment": comment, "commentId": "comment-\(id)", "postId": post], age: age)
        }
        add("c2_email", channel: "email", title: "Remetente não confirmado", text: "Olá! Preciso de atenção ao pedido #123. Conteúdo remoto removido.",
            metadata: ["subject": "Pedido #123 · confirmação", "identityTrust": "unverified_sender", "email": [
                "subject": "Pedido #123 · confirmação", "sender": "remetente@cliente.example", "from": "outro@cliente.example",
                "replyTo": "terceiro@cliente.example", "identityTrust": "unverified_sender",
                "authentication": [["method": "dmarc", "result": "pass"]],
                "attachmentWarnings": ["Arquivo executável recusado; HTML convertido em texto sem carregar recursos remotos."]
            ] as Row])
        add("c2_email_unknown", channel: "email", title: "Envio indeterminado", text: "A confirmação de envio não chegou.",
            metadata: ["subject": "Confirmação", "state": "unknown", "email": ["subject": "Confirmação", "sender": "incerto@cliente.example", "identityTrust": "unverified_sender"]])
        add("c2_telegram", channel: "telegram", title: "Telegram · atendimento", text: "Compartilhei meu telefone para conferência pela equipe.",
            metadata: ["telegram": ["username": "loja_exemplo_bot", "botUrl": "https://t.me/loja_exemplo_bot", "blocked": false,
                "webhookConfigured": true, "phoneSuggestion": ["masked": "+55 •• •••••-1234", "confirmedByHuman": false]]])
        add("c2_telegram_blocked", channel: "telegram", title: "Telegram · bloqueado", text: "O cliente bloqueou o bot.",
            metadata: ["telegram": ["blocked": true, "webhookConfigured": true]])
        add("c2_telegram_large", channel: "telegram", title: "Telegram · arquivo grande", text: "Anexo indisponível: excede o limite de recebimento de 20.000.000 bytes.", metadata: ["telegram": ["blocked": false, "webhookConfigured": true]])
        add("c2_telegram_rate", channel: "telegram", title: "Telegram · aguarde", text: "Aguardando o intervalo permitido para o próximo envio.", metadata: ["state": "rate_limited", "telegram": ["blocked": false, "webhookConfigured": true]])
        for (id, used, age) in [("c2_tiktok_nine", 9, 1), ("c2_tiktok_full", 10, 2), ("c2_tiktok_expired", 2, 49)] {
            add(id, channel: "tiktok", title: "TikTok · \(used) usadas", text: "Olá, ainda preciso de ajuda.", metadata: [:], age: age)
            slots[id] = Set((0..<used).map { "external-fixture-\($0)" })
        }
        add("c2_unknown", channel: "future_channel", title: "Canal desconhecido", text: "Histórico disponível; envio indisponível.", metadata: [:])
    }

    func contains(_ id: String) -> Bool { rows[id] != nil }

    private func kind(_ channel: String) -> String { channel == "email" ? "email" : channel == "telegram" ? "telegram_bot" : "zernio" }
    private func json(_ value: Any) -> String { String(data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "{}" }
    private func reply(_ value: Row, status: Int = 200) -> DemoServer.Reply {
        DemoServer.Reply(status: status, data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data())
    }
    private func fail(_ code: String, _ message: String, status: Int = 422) -> DemoServer.Reply { reply(["error": ["code": code, "message": message]], status: status) }

    private func add(_ id: String, channel: String, title: String, context: String = "direct", text: String, metadata: Row, age: Int = 1) {
        let timestamp = t0 - Int64(age) * hour
        rows[id] = ["id": id, "profile_id": "demo", "connection_id": "c2_line_\(channel)", "external_namespace": "channel:c2_line_\(channel)",
                    "external_id": id, "phone": NSNull(), "channel": channel, "account_label": "Conta de exemplo", "multichannel": true,
                    "state": "human", "owner": DemoMode.meId, "epoch": 1, "tags": "[]", "last_customer": timestamp,
                    "created": timestamp, "updated": timestamp, "chat_type": context, "channel_context": json(["context": context]),
                    "title": title, "contact_name": title, "bot_policy": "mentions"]
        self.metadata[id] = metadata
        var content: Row = ["type": context == "comment" ? "comment" : "text"]
        if let email = metadata["email"] as? Row { content["email"] = email; content["subject"] = email["subject"] }
        if let comment = metadata["comment"] as? Row { content["comment"] = comment }
        messages[id] = [message("initial-\(id)", conversation: id, direction: "customer", text: text, content: content, now: timestamp)]
    }

    private func message(_ id: String, conversation: String, direction: String, text: String, content: Row, now: Int64) -> Row {
        ["id": id, "profile_id": "demo", "conversation_id": conversation, "direction": direction,
         "author": direction == "customer" ? "customer:demo" : DemoMode.meId, "text": text, "attachments": "[]",
         "external_id": id, "created": now, "content": json(content), "delivery_status": direction == "outbound" ? "sent" : "", "status_at": now]
    }

    private func projection(_ id: String, now: Int64) -> Row {
        guard let row = rows[id] else { return [:] }
        let channel = row["channel"] as? String ?? ""
        let context = row["chat_type"] as? String ?? "direct"
        let comment = context == "comment", tiktok = channel == "tiktok", known = channels.contains(channel)
        var meta = metadata[id] ?? [:]
        let last = row["last_customer"] as? Int64 ?? 0
        let remaining = max(0, 10 - (slots[id]?.count ?? 0))
        let closesAt = last + 48 * hour
        let blocked = (meta["telegram"] as? Row)?["blocked"] as? Bool == true
        let canSend = known && !blocked && (!tiktok || (remaining > 0 && now < closesAt))
        if tiktok { meta["tiktok"] = ["remainingMessages": remaining, "closesAt": closesAt, "conservativeQuota": true] }
        let menu: Row = ["buttons": channel == "telegram" ? 8 : 0, "quickReplies": 0, "listItems": 0, "fallback": "numbered_text"]
        let window: Row = ["kind": tiktok ? "customer" : "none", "state": canSend ? "open" : "closed", "serverNow": now,
                           "closesAt": tiktok ? closesAt as Any : NSNull(), "humanTextClosesAt": NSNull(),
                           "remainingMessages": tiktok ? remaining as Any : NSNull(), "canHumanText": canSend,
                           "canAutomation": canSend && !comment && channel != "email",
                           "reason": canSend ? NSNull() as Any : tiktok && remaining == 0 ? "quota_exhausted" : "window_closed"]
        // Literais aninhados de [String: Any] em partes tipadas: num só literal o
        // compilador do Swift desiste de inferir os tipos ("failed to produce diagnostic").
        let email = channel == "email"
        let contextSpec: Row = ["enabled": known, "bot": !comment && !email, "publicReply": comment]
        let contexts: Row = [context: contextSpec]
        let maxChars: Int = email ? 50_000 : (tiktok ? 6000 : 4096)
        let textSpec: Row = ["enabled": known, "maxChars": maxChars]
        let maxSendBytes: Int = tiktok ? 3_000_000 : 10_000_000
        let mimeTypes: [String] = ["image/jpeg", "image/png"]
        let imageSpec: Row = ["send": true, "receive": true, "maxSendBytes": maxSendBytes, "mimeTypes": mimeTypes]
        let mediaSpec: Row = comment ? [:] : ["image": imageSpec]
        let tiktokWindow: Row = ["kind": "customer", "hours": 48, "maxMessages": 10, "after": "blocked"]
        let noWindow: Row = ["kind": "none"]
        let windowSpec: Row = tiktok ? tiktokWindow : noWindow
        let replyTo: Bool = email || channel == "telegram"
        let spec: Row = ["id": channel, "enabled": known, "context": context, "contexts": contexts,
                         "text": textSpec, "media": mediaSpec, "menu": menu, "window": windowSpec,
                         "subject": email, "replyTo": replyTo, "templates": false]
        let extensionView: Row = ["key": "\(channel)/\(context)", "capabilities": spec, "metadata": meta]
        let canImage: Bool = !comment && known
        let capabilities: Row = ["channel": channel, "text": known, "image": canImage, "modules": false,
                                 "reply": channel == "telegram", "reaction": false, "edit": false, "delete": false,
                                 "document": false, "video": false, "audio": false, "voice": false, "sticker": false,
                                 "contacts": false, "location": false, "templates": false, "calls": false, "window": window]
        let result: Row = ["channel": channel, "account_label": "Conta de exemplo", "multichannel": true, "window": window,
                           "modules": false, "subject": email, "public_reply": comment, "templates": false,
                           "menu": menu, "can_initiate": false, "channel_extension": extensionView,
                           "capabilities": capabilities]
        return result
    }

    func conversationRows(now: Int64) -> [Row] {
        rows.keys.sorted().compactMap { id in
            guard var row = rows[id] else { return nil }
            row.merge(projection(id, now: now)) { _, new in new }
            if let last = messages[id]?.last {
                row["last_message"] = ["text": last["text"] ?? "", "direction": last["direction"] ?? "",
                                       "created": last["created"] ?? 0, "attachments": 0, "kind": "text"] as Row
            }
            return row
        }
    }

    func extendStatus(_ status: inout Row, now: Int64) {
        let old = status["conversation_channels"] as? [String] ?? ["whatsapp"]
        let combined = old + channels.filter { !old.contains($0) }
        status["conversation_channels"] = combined
        status["connected_channels"] = combined
        status["multichannel"] = true
        status["channel_extensions"] = ["instagram/comment", "facebook/comment", "telegram/direct", "email/direct", "tiktok/direct"]
        status["connections"] = (status["connections"] as? [Row] ?? []) + lines
        status["future_channels"] = [["channel": "googlebusiness", "enabled": false]]
    }

    func route(method: String, parts: [String], body: Row, key: String?, now: Int64, emit: (String, Row) -> Void) -> DemoServer.Reply? {
        guard parts.count >= 6, Array(parts.prefix(4)) == ["api", "v1", "profiles", "demo"], parts[4] == "conversations", contains(parts[5]) else { return nil }
        let id = parts[5]
        if method == "GET", parts.count == 6 {
            var result = projection(id, now: now)
            result["conversation"] = rows[id]
            result["messages"] = messages[id] ?? []
            result["media"] = [Row]()
            result["deliveries"] = [Row]()
            result["connection_kind"] = kind(rows[id]?["channel"] as? String ?? "")
            result["server_now"] = now
            return reply(result)
        }
        guard method == "POST", parts.count == 7, parts[6] == "message-actions", body["action"] as? String == "channel", let action = body["channel_action"] as? Row else {
            return fail("unsupported_content", "Use uma ação explícita deste canal.")
        }
        guard let key, !key.isEmpty else { return fail("idempotency_required", "A chave da tentativa é obrigatória.", status: 400) }
        let fingerprint = (try? JSONSerialization.data(withJSONObject: ["id": id, "body": body], options: [.sortedKeys])) ?? Data()
        if let old = receipts[key] {
            return old.0 == fingerprint ? old.1 : fail("idempotency_conflict", "Esta tentativa já tem outro assunto, alvo ou conteúdo.", status: 409)
        }
        let result = perform(id, action: action, now: now, emit: emit)
        if (200..<300).contains(result.status) { receipts[key] = (fingerprint, result) }
        return result
    }

    private func perform(_ id: String, action: Row, now: Int64, emit: (String, Row) -> Void) -> DemoServer.Reply {
        let channel = rows[id]?["channel"] as? String ?? ""
        guard channels.contains(channel) else { return fail("provider_unknown", "Canal desconhecido; envio indisponível.") }
        let type = action["type"] as? String ?? "", text = action["text"] as? String ?? ""
        var content: Row = ["type": "text"]
        var status = "sent"
        if rows[id]?["chat_type"] as? String == "comment" {
            guard var comment = metadata[id]?["comment"] as? Row, action["commentId"] as? String == comment["id"] as? String,
                  ["comment.reply", "comment.private", "comment.visibility", "comment.suggest"].contains(type) else {
                return fail("invalid_channel_action", "Escolha o comentário alvo e a ação pública ou privada.")
            }
            if type == "comment.visibility" {
                guard let hidden = action["hidden"] as? Bool else { return fail("invalid_channel_action", "Informe a visibilidade.") }
                comment["hidden"] = hidden
                metadata[id]?["comment"] = comment
                return reply(["status": "sent", "hidden": hidden])
            }
            if type == "comment.suggest" { return reply(["suggestion": "Olá! A equipe pode conferir a disponibilidade para você."]) }
            if type == "comment.private" {
                guard comment["privateState"] as? String == "available" else { return fail("private_reply_used", "A tentativa privada já foi consumida.") }
                guard let expires = comment["privateExpiresAt"] as? Int64, now < expires else { return fail("private_reply_expired", "O prazo da chamada privada terminou.") }
                comment["privateState"] = "sent"
                comment["privateLinkPending"] = true
                metadata[id]?["comment"] = comment
            }
            content["comment"] = comment
            content["channel_action"] = type
        } else if channel == "email" {
            guard type == "email.send", let subject = action["subject"] as? String, subject.utf16.count <= 200,
                  // Por escalar: em Swift "\r\n" é um caractere só, e contains("\r") não o acha.
                  !subject.unicodeScalars.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\0" }) else { return fail("subject_invalid", "Revise o assunto do e-mail.") }
            guard text.utf16.count <= 50_000 else { return fail("unsupported_content", "O texto excede o limite de 50.000 caracteres.") }
            content["subject"] = subject
            content["email"] = ["subject": subject]
            if id == "c2_email_unknown" { status = "unknown" }
        } else if channel == "telegram" {
            guard (metadata[id]?["telegram"] as? Row)?["blocked"] as? Bool != true else { return fail("cannot_initiate", "O cliente bloqueou o bot.") }
            guard ["message.send", "telegram.request-contact"].contains(type) else { return fail("unsupported_content", "Ação não aceita no Telegram.") }
            if id == "c2_telegram_rate" { return reply(["status": "pending", "code": "rate_limited"]) }
        } else if channel == "tiktok" {
            guard type == "message.send", text.utf16.count <= 6000 else { return fail("unsupported_content", "Ação não aceita no TikTok.") }
            let last = rows[id]?["last_customer"] as? Int64 ?? 0
            guard now < last + 48 * hour else { return fail("window_closed", "O prazo de 48 horas terminou.") }
            let attachments = action["attachments"] as? [Row] ?? []
            guard attachments.count <= 1, attachments.allSatisfy({ ($0["kind"] as? String == "image") && ["image/jpeg", "image/png"].contains($0["mimeType"] as? String ?? "") && ($0["bytes"] as? Int ?? 0) > 0 && ($0["bytes"] as? Int ?? 0) <= 3_000_000 }) else {
                return fail("unsupported_content", "Use uma imagem JPG/PNG de até 3.000.000 bytes.")
            }
            let count = (text.isEmpty ? 0 : 1) + attachments.count
            guard count > 0, (slots[id]?.count ?? 0) + count <= 10 else { return fail("quota_exhausted", "Não há vagas para todas as entregas deste pedido.") }
            for index in 0..<count { slots[id, default: []].insert("local-\(sequence + 1)-\(index)") }
        } else { return fail("unsupported_content", "Ação não aceita neste contexto.") }
        sequence += 1
        reservations += 1
        let messageId = "c2-out-\(sequence)"
        if status == "sent" {
            messages[id, default: []].append(message(messageId, conversation: id, direction: "outbound", text: text, content: content, now: now))
            rows[id]?["updated"] = now
            emit("message.sent", ["conversation_id": id, "message_id": messageId])
        }
        return reply(["delivery_id": messageId, "status": status])
    }

    /// Simulação local de evento já autenticado; não pretende provar autenticação do Worker.
    @discardableResult
    func receive(eventId: String, remoteId: String, conversationId: String, text: String, occurredAt: Int64) -> Bool {
        guard contains(conversationId), !eventIds.contains(eventId), !remoteIds.contains("\(conversationId):\(remoteId)") else { return false }
        eventIds.insert(eventId)
        remoteIds.insert("\(conversationId):\(remoteId)")
        messages[conversationId, default: []].append(message(remoteId, conversation: conversationId, direction: "customer", text: text, content: [:], now: occurredAt))
        if occurredAt > 0 && occurredAt <= t0 {
            // Lê antes de gravar: ler e modificar `rows` na mesma expressão viola o acesso exclusivo do Swift.
            let previous = rows[conversationId]?["last_customer"] as? Int64 ?? 0
            rows[conversationId]?["last_customer"] = max(previous, occurredAt)
        }
        return true
    }

    /// O eco confirma a mesma vaga local; uma saída externa usa seu ID remoto como chave.
    func observeTikTokSend(conversationId: String, remoteId: String, localSlot: String? = nil) {
        guard rows[conversationId]?["channel"] as? String == "tiktok" else { return }
        if let localSlot, slots[conversationId]?.remove(localSlot) != nil { slots[conversationId, default: []].insert(remoteId) }
        else { slots[conversationId, default: []].insert(remoteId) }
    }
}
