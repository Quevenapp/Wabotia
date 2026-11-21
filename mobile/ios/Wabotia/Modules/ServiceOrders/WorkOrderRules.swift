import Foundation

/// Regras das telas da ordem por modelo, sem tela, para testar.
enum WorkOrderRules {
    /// A mesma ordem do servidor e do painel (`WorkQuoteCommercial.tsx`).
    static let rank: [String: Int] = ["received": 0, "analyzing": 1, "quoted": 2, "approved": 3, "declined": 3, "in_progress": 4, "ready": 5, "delivered": 6, "cancelled": 7]

    /// Cancelar e voltar etapa (estado anterior) pedem motivo.
    static func needsReason(from: String, to: String) -> Bool {
        (to == "cancelled" && from != "cancelled") || (to != "cancelled" && (rank[to] ?? 99) < (rank[from] ?? -1))
    }

    static func reasonTitle(from: String, to: String) -> String {
        if to == "cancelled" { return "Motivo do cancelamento" }
        if from == "ready" && to == "in_progress" { return "Motivo do retrabalho" }
        if to == "analyzing" { return "Motivo para voltar à análise" }
        return "Motivo para voltar a etapa"
    }

    static let emptyReason = "Informe o motivo. Ele fica no histórico da ordem."

    /// Os botões de etapa: um por `next_stages`, o cancelamento por último.
    static func stageButtons(_ order: WorkOrder) -> [(next: WorkNextStage, title: String, danger: Bool)] {
        let list = order.nextStages ?? []
        let normal = list.filter { $0.baseStatus != "cancelled" }
        let cancel = list.filter { $0.baseStatus == "cancelled" }
        return (normal + cancel).map { next in
            let label = next.stageLabel?.isEmpty == false ? next.stageLabel! : ServiceOrderRules.statusLabel(next.baseStatus ?? "")
            if next.isApproval { return (next, "Pedir aprovação do cliente: \(label)", false) }
            if next.baseStatus == "cancelled" { return (next, "Cancelar ordem", true) }
            let back = (rank[next.baseStatus ?? ""] ?? 99) < (rank[order.state] ?? -1)
            return (next, back ? "Voltar para \(label)" : "Avançar para \(label)", false)
        }
    }

    /// Envio do orçamento pelo WhatsApp: só quando o servidor oferece `quoted` e a ordem tem conversa.
    static func canSendQuote(_ order: WorkOrder) -> Bool {
        (order.nextStatuses ?? []).contains("quoted") && (order.customer?.conversationId?.isEmpty == false) && order.quote != nil
    }

    /// Total do orçamento: o do servidor ou, sem ele, a soma das linhas.
    static func quoteTotal(_ quote: WorkQuote) -> Int {
        quote.totalCents ?? (quote.items ?? []).reduce(0) { $0 + $1.lineCents }
    }

    static func isOverdue(_ order: WorkOrder, now: Date = Date()) -> Bool {
        guard let due = order.dueAt, !order.isClosed else { return false }
        return due < BrasiliaTime.millis(now)
    }

    /// Situação do orçamento, só leitura.
    static func quoteStatus(_ order: WorkOrder) -> String {
        if let d = order.decision?.decision {
            let when = order.decision?.at.map { " em \(BrasiliaTime.shortWithTime($0))" } ?? ""
            if d == "approved" || d == "approve" { return "Aprovado" + when }
            if d == "declined" || d == "decline" { return "Recusado" + when }
        }
        guard let quote = order.quote else { return "Ainda não enviado" }
        if let sent = quote.sentAt {
            var text = "Enviado em \(BrasiliaTime.shortWithTime(sent))"
            if let until = quote.validUntil { text += ", válido até \(BrasiliaTime.short(until))" }
            if quote.expired == true { text += " · Vencido" }
            return text
        }
        return "Ainda não enviado"
    }

    /// Texto de uma linha do histórico: nunca o código cru.
    static func historyText(_ h: WorkHistoryEntry, stages: [WorkStage]? = nil) -> String {
        let kind = h.kind ?? ""
        switch kind {
        case "opened", "os.opened": return "Ordem aberta"
        case "os.checklist_marked":
            if let note = h.note, !note.isEmpty { return note }
            return "Checklist alterado"
        case "quote", "quote_sent", "os.quote_saved", "os.quoted":
            return h.toStatus == "quoted" ? "Orçamento enviado" : "Orçamento salvo"
        case "edit", "os.updated": return "Dados alterados"
        case "decision", "os.approved", "os.declined":
            if h.toStatus == "approved" { return "Orçamento aprovado" }
            if h.toStatus == "declined" { return "Orçamento recusado" }
            return "Resposta do orçamento"
        default: break
        }
        if h.toStage != nil || kind.contains("stage") {
            if kind.contains("approval") { return "Aprovação do cliente pedida" }
            if let to = h.toStage, let stage = stages?.first(where: { $0.id == to }) { return "Etapa: \(stage.title)" }
            if let to = h.toStatus { return "Etapa: \(ServiceOrderRules.statusLabel(to))" }
            return "Mudança de etapa"
        }
        if kind == "status", let to = h.toStatus { return "Etapa: \(ServiceOrderRules.statusLabel(to))" }
        return "Alteração"
    }

    /// O motivo de quem fez a mudança, quando houver (aparece embaixo do texto, menos no checklist, em que a nota já é o texto).
    static func historyNote(_ h: WorkHistoryEntry) -> String? {
        guard h.kind != "os.checklist_marked", let note = h.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else { return nil }
        return note
    }

    static func isNetwork(_ error: Error) -> Bool {
        if let e = error as? QueueError { return e.code == QueueError.network }
        return error is URLError
    }

    static let offlineAction = "Sem conexão. Esta mudança não foi guardada: tente de novo quando a internet voltar."
    static let versionConflict = "Outra pessoa mudou esta ordem. A ficha foi atualizada; confira e tente de novo."
    static let forbidden = "Sua conta não tem acesso às ordens de serviço. Peça a um administrador."
    static let noCamera = "Este item pede foto pela câmera. Libere a câmera para o Vinki nos Ajustes do aparelho."
    static let noCustomer = "Nenhum cliente com esse nome ou telefone. Cadastre o cliente na conversa ou no painel e busque de novo."

    static func offlineBanner(_ savedAt: Int64) -> String {
        let p = BrasiliaTime.shortWithTime(savedAt).split(separator: " ")
        let day = p.first.map { String($0.prefix(5)) } ?? ""
        let clock = p.count > 1 ? String(p[1]) : ""
        return "Sem conexão. Você está vendo a cópia de \(day) \(clock). Para mudar a ordem, conecte-se."
    }

    /// Mensagem de uma recusa: o que aconteceu e o que fazer.
    static func message(_ error: Error) -> String {
        if isNetwork(error) { return offlineAction }
        guard let e = error as? QueueError else { return QueueError.describe(error) }
        switch e.code {
        case "module_disabled": return ModuleFailure.disabledMessage
        case "version_conflict": return versionConflict
        case "forbidden": return forbidden
        case "order_closed": return "A ordem está encerrada: não muda mais."
        case "no_conversation": return "Esta ordem não está ligada a uma conversa do WhatsApp. Envie pelo painel."
        case "customer_required": return "Confirme o cadastro do cliente antes de escolher o objeto."
        case "object_definition_conflict", "object_archived": return "O cadastro do objeto mudou. Escolha o objeto de novo."
        case "unsupported_media_type", "payload_too_large", "document_too_large":
            return "A foto não foi aceita: ficou grande demais ou num formato que o Vinki não recebe. Tire a foto de novo."
        case "invalid_transition": return "Esta mudança de etapa não vale para a ordem agora. A ficha foi atualizada."
        case "upload_url_rejected": return e.message
        default: break
        }
        if e.status == 403 { return forbidden }
        if e.status == 413 || e.status == 415 { return "A foto não foi aceita: ficou grande demais ou num formato que o Vinki não recebe. Tire a foto de novo." }
        if e.retryable && e.status != 0 { return e.message + " Toque de novo para repetir com segurança." }
        return e.message.isEmpty ? "O Vinki recusou a mudança. Tente de novo." : e.message
    }

    /// O catálogo de modelos não existe neste servidor (versão anterior aos modelos).
    static func isOldServer(_ error: Error) -> Bool {
        guard let e = error as? QueueError else { return false }
        return e.status == 404 || e.code == "not_found" || e.code == "not_implemented"
    }

    // MARK: Lista

    enum Situation: String, CaseIterable, Identifiable {
        case open, delivered, cancelled, all
        var id: String { rawValue }
        var title: String {
            switch self {
            case .open: return "Abertas"
            case .delivered: return "Concluídas"
            case .cancelled: return "Canceladas"
            case .all: return "Todas"
            }
        }
    }

    /// Os parâmetros da lista, como o painel: sem modelo, `type_ids` com todos os ativos; com modelo, `type_id` e a
    /// etapa (que substitui a situação).
    static func listQuery(catalog: WorkTypeCatalog?, typeId: String?, situation: Situation, stage: String?, query: String) -> [String: String] {
        var out: [String: String] = [:]
        if let typeId, !typeId.isEmpty {
            out["type_id"] = typeId
            if let stage, !stage.isEmpty { out["stage"] = stage }
        } else {
            let ids = catalog?.active.map(\.id) ?? []
            if !ids.isEmpty { out["type_ids"] = ids.joined(separator: ",") }
        }
        if out["stage"] == nil {
            switch situation {
            case .open: out["open"] = "1"
            case .delivered: out["status"] = "delivered"
            case .cancelled: out["status"] = "cancelled"
            case .all: break
            }
        }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty { out["q"] = q }
        return out
    }

    /// Chave do cache da lista: os parâmetros em ordem.
    static func listKey(_ query: [String: String]) -> String {
        query.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
    }

    /// Itens faltando no checklist da etapa atual, pelos rótulos.
    static func missingText(_ stage: WorkChecklistStage) -> String? {
        let names = (stage.missing ?? []).map { id in stage.items?.first { $0.id == id }?.title ?? id }
        guard !names.isEmpty else { return nil }
        return "Para avançar de etapa, falta marcar: " + names.joined(separator: ", ") + "."
    }
}
