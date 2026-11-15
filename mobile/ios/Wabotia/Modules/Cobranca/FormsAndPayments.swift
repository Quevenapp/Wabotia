import Foundation

/*
 Formulários (módulo `forms`, passo web) e Cobrança (módulo `payments`, Pix e link) na conversa: docs/API.md "Passo web e
 formulários" e "Cobrança", docs/COBRANCA.md. A equipe envia pela ação da conversa (`form` com `form_id`; `charge` com
 `method`, `amount_cents` e `description`), com a conversa assumida ou como administrador. O detalhe da conversa traz os
 últimos `web_steps` e `payments`; os eventos `web_step.*`, `form.*` e `payment.*` atualizam a tela. `paid` só vem do
 provedor (webhook assinado): nada no app marca uma cobrança como paga.
 */

/// Um link de passo web enviado na conversa (`sent`, `opened`, `completed`, `expired`, `cancelled`).
struct WebStep: Codable, Equatable, Identifiable {
    var id: String
    var module_id: String?
    var kind: String?
    var title: String?
    var status: String?
    var expires_at: Int64?
    var opened_at: Int64?
    var completed_at: Int64?
    var created: Int64?
}

/// Uma cobrança da conversa (`created`, `paid`, `expired`, `cancelled`, `refunded`).
struct ConversationPayment: Codable, Equatable, Identifiable {
    var id: String
    var method: String?
    var module_id: String?
    var description: String?
    var amount_cents: Int?
    var status: String?
    var pix_code: String?
    var url: String?
    var expires_at: Int64?
    var paid_at: Int64?
    var created: Int64?
}

/// `GET /forms`: os formulários ativos da área.
struct FormSummary: Codable, Equatable, Identifiable {
    struct Field: Codable, Equatable { var id: String?; var type: String?; var label: String?; var required: Bool? }
    var id: String
    var name: String?
    var title: String?
    var fields: [Field]?

    var displayName: String { [title, name].compactMap { $0 }.first { !$0.isEmpty } ?? "Formulário" }
}

final class FormsClient {
    let api: ProfileAPI
    init(api: ProfileAPI) { self.api = api }

    func forms() async throws -> [FormSummary] { (try await api.get("forms") as DataList<FormSummary>).data ?? [] }
}

/// Textos e regras de links e cobranças, sem tela, para testar.
enum ConversationItemsRules {
    static func webStepLabel(_ status: String?) -> String {
        switch status {
        case "sent": return "Enviado"
        case "opened": return "Aberto"
        case "completed": return "Concluído"
        case "expired": return "Expirado"
        case "cancelled": return "Cancelado"
        default: return status ?? "—"
        }
    }

    static func paymentLabel(_ status: String?) -> String {
        switch status {
        case "created": return "Aguardando pagamento"
        case "paid": return "Pago"
        case "expired": return "Vencida"
        case "cancelled": return "Cancelada"
        case "refunded": return "Estornada"
        default: return status ?? "—"
        }
    }

    static func methodLabel(_ method: String?) -> String { method == "link" ? "Link de pagamento" : "Pix" }

    /// Em andamento (vale mostrar na faixa da conversa): link enviado ou aberto, cobrança aguardando.
    static func isActive(_ step: WebStep) -> Bool { ["sent", "opened"].contains(step.status ?? "") }
    static func isActive(_ payment: ConversationPayment) -> Bool { payment.status == "created" }

    /// Título do link: o do passo, ou o tipo ("Formulário", "Check-in", "Pedido").
    static func stepTitle(_ step: WebStep) -> String {
        if let t = step.title?.trimmingCharacters(in: .whitespaces), !t.isEmpty { return t }
        switch step.kind {
        case "form": return "Formulário"
        case "checkin": return "Check-in"
        case "cart": return "Carrinho do pedido"
        default: return "Link"
        }
    }

    /// Valor digitado em reais; `nil` fora de R$ 0,01 a R$ 100.000,00 (o limite do servidor).
    static func amount(_ text: String) -> Int? {
        guard let cents = Money.parse(text), cents >= 1, cents <= 10_000_000 else { return nil }
        return cents
    }

    /// Recusas da Cobrança e do formulário em texto para o atendente.
    static func explain(_ error: Error) -> String {
        switch (error as? QueueError)?.code ?? (error as? APIError)?.code {
        case "payments_not_configured":
            return "A Cobrança não está configurada nesta área: um administrador precisa ligar o Mercado Pago em Gestão → Cobrança."
        case "module_disabled": return ModuleFailure.disabledMessage
        default: return (error as? APIError).map(APIError.describe) ?? ModuleFailure.message(error)
        }
    }
}
