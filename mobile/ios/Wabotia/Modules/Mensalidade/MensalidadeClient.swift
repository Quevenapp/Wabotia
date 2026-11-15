import Foundation

/*
 Mensalidade (módulo `mensalidade`, docs/MENSALIDADE.md e docs/API.md "Mensalidade"). Valores em centavos, vencimentos
 "AAAA-MM-DD" em Brasília (mostrar sem converter), competência "AAAA-MM". Planos e importação ficam no painel web; o app
 acompanha o mês e opera as parcelas e as assinaturas. O cliente pode ter mais de um telefone (pagador): a tela mostra o
 que vier, sem supor um telefone por assinatura.
 */

struct MensalidadeCustomer: Codable, Equatable {
    var name: String?
    var phone: String?
    /// Pagador com vários telefones (versões novas do módulo).
    var phones: [String]?
    var document: String?
    var contactId: String?
    var conversationId: String?

    var displayName: String { name?.isEmpty == false ? name! : (PhoneText.display(phone ?? phones?.first) ?? "Cliente") }
    /// Todos os telefones conhecidos, formatados e sem repetir.
    var phoneList: [String] {
        var seen = Set<String>()
        return ([phone].compactMap { $0 } + (phones ?? [])).compactMap { raw in
            let digits = raw.filter(\.isNumber)
            guard !digits.isEmpty, seen.insert(digits).inserted else { return nil }
            return PhoneText.display(digits)
        }
    }
}

struct MensalidadePayment: Codable, Equatable {
    var id: String?
    var status: String?
    var expiresAt: Int64?
    var pixCode: String?
    var url: String?
    var chargedAt: Int64?
}

struct MensalidadeNotices: Codable, Equatable {
    var beforeAt: Int64?
    var dueAt: Int64?
    var overdue: Int?
    var overdueAt: Int64?
    var error: String?
}

struct Installment: Codable, Equatable, Identifiable {
    var id: String
    var subscriptionId: String?
    var periodKey: String?
    var periodLabel: String?
    var dueDate: String?
    var amountCents: Int?
    /// `open`, `paid`, `overdue`, `cancelled` ou `waived`.
    var status: String?
    var statusLabel: String?
    var customer: MensalidadeCustomer?
    var planName: String?
    var payment: MensalidadePayment?
    var notices: MensalidadeNotices?
    var paidAt: Int64?
    var paidVia: String?
    var paidBy: String?
    var paidNote: String?
    var waivedAt: Int64?
    var waivedBy: String?
    var cancelledAt: Int64?

    var state: String { status ?? "open" }
    var label: String { statusLabel?.isEmpty == false ? statusLabel! : MensalidadeRules.statusLabel(state) }
}

struct Subscription: Codable, Equatable, Identifiable {
    var id: String
    var planId: String?
    var planName: String?
    var customer: MensalidadeCustomer?
    var period: String?
    var periodLabel: String?
    var amountCents: Int?
    var discountCents: Int?
    var chargeCents: Int?
    var dueDay: Int?
    var startDate: String?
    var endDate: String?
    /// `active`, `paused` ou `ended`.
    var status: String?
    var statusLabel: String?
    var notes: String?
    var pausedAt: Int64?
    var endedAt: Int64?
    var openCount: Int?
    var overdueCount: Int?
    var overdueCents: Int?
    var installments: [Installment]?

    var state: String { status ?? "active" }
    var label: String { statusLabel?.isEmpty == false ? statusLabel! : MensalidadeRules.subscriptionLabel(state) }
}

struct Delinquent: Codable, Equatable, Identifiable {
    var subscriptionId: String
    var customer: MensalidadeCustomer?
    var planName: String?
    var subscriptionStatus: String?
    var overdueCount: Int?
    var overdueCents: Int?
    var oldestDueDate: String?
    var noticesSent: Int?
    var id: String { subscriptionId }
}

struct MensalidadeAmount: Codable, Equatable {
    var count: Int?
    var cents: Int?
    var subscriptions: Int?
}

struct MensalidadeSummary: Decodable, Equatable {
    var month: String?
    var expectedCents: Int?
    var receivedCents: Int?
    var overdueCents: Int?
    var openCents: Int?
    var waivedCents: Int?
    var counts: [String: Int]?
    var receivedInMonth: MensalidadeAmount?
    var overdueTotal: MensalidadeAmount?
    var paymentsReady: Bool?
}

struct InstallmentPage: Decodable, Equatable {
    var month: String?
    var data: [Installment]?
    var nextCursor: String?
    var counts: [String: Int]?
}

struct SubscriptionPage: Decodable, Equatable {
    var data: [Subscription]?
    var nextCursor: String?
    var counts: [String: Int]?
}

/// O cliente das rotas da Mensalidade de uma área.
final class MensalidadeClient {
    let api: ProfileAPI
    init(api: ProfileAPI) { self.api = api }

    func summary(month: String) async throws -> MensalidadeSummary { try await api.get("mensalidade/summary", query: ["month": month]) }

    func installments(month: String, statuses: [String] = [], query: String? = nil, subscriptionId: String? = nil, cursor: String? = nil) async throws -> InstallmentPage {
        try await api.get("mensalidade/installments", query: [
            "month": month, "status": statuses.isEmpty ? nil : statuses.joined(separator: ","), "subscription_id": subscriptionId,
            "q": query?.trimmingCharacters(in: .whitespaces).isEmpty == false ? query : nil, "cursor": cursor,
        ])
    }

    func installment(_ id: String) async throws -> Installment { try await api.get("mensalidade/installments/\(id)") }

    func subscriptions(statuses: [String] = [], query: String? = nil, cursor: String? = nil) async throws -> SubscriptionPage {
        try await api.get("mensalidade/subscriptions", query: [
            "status": statuses.isEmpty ? nil : statuses.joined(separator: ","), "q": query?.trimmingCharacters(in: .whitespaces).isEmpty == false ? query : nil, "cursor": cursor,
        ])
    }

    func subscription(_ id: String) async throws -> Subscription { try await api.get("mensalidade/subscriptions/\(id)") }

    func delinquents() async throws -> [Delinquent] { (try await api.get("mensalidade/delinquents") as DataList<Delinquent>).data ?? [] }

    /// Reenvia o Pix/link que vale ou cria outra cobrança.
    func charge(_ id: String, key: String) async throws -> Installment { try await api.send("POST", "mensalidade/installments/\(id)/charge", [:], key: key) }

    /// Baixa manual: `paid_at` "AAAA-MM-DD"; `notify` manda o comprovante ao cliente.
    func pay(_ id: String, note: String?, paidAt: String?, notify: Bool, key: String) async throws -> Installment {
        try await api.send("POST", "mensalidade/installments/\(id)/pay", ["note": note, "paid_at": paidAt, "notify": notify], key: key)
    }

    func waive(_ id: String, note: String?, key: String) async throws -> Installment {
        try await api.send("POST", "mensalidade/installments/\(id)/waive", ["note": note], key: key)
    }

    /// `pause`, `resume` ou `end`.
    func subscriptionAction(_ id: String, _ action: String, key: String) async throws -> Subscription {
        precondition(["pause", "resume", "end"].contains(action))
        return try await api.send("POST", "mensalidade/subscriptions/\(id)/\(action)", [:], key: key)
    }
}

/// Regras das telas da Mensalidade, sem tela, para testar.
enum MensalidadeRules {
    static func statusLabel(_ status: String) -> String {
        switch status {
        case "open": return "Em aberto"
        case "paid": return "Paga"
        case "overdue": return "Vencida"
        case "cancelled": return "Cancelada"
        case "waived": return "Isenta"
        default: return status
        }
    }

    static func subscriptionLabel(_ status: String) -> String {
        switch status {
        case "active": return "Ativa"
        case "paused": return "Pausada"
        case "ended": return "Encerrada"
        default: return status
        }
    }

    static let payable: Set<String> = ["open", "overdue"]
    static func canCharge(_ i: Installment) -> Bool { payable.contains(i.state) }
    static func canPay(_ i: Installment) -> Bool { payable.contains(i.state) }
    static func canWaive(_ i: Installment) -> Bool { payable.contains(i.state) }

    static func canPause(_ s: Subscription) -> Bool { s.state == "active" }
    static func canResume(_ s: Subscription) -> Bool { s.state == "paused" }
    static func canEnd(_ s: Subscription) -> Bool { s.state != "ended" }

    /// "2026-11" → "novembro de 2026".
    static func monthTitle(_ month: String) -> String {
        let parts = month.split(separator: "-")
        guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return month }
        let names = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
        return "\(names[m - 1]) de \(parts[0])"
    }

    static func currentMonth(_ now: Date = Date()) -> String { String(BrasiliaTime.day(now).prefix(7)) }

    static func shiftMonth(_ month: String, _ n: Int) -> String {
        let parts = month.split(separator: "-")
        guard parts.count == 2, let y = Int(parts[0]), let m = Int(parts[1]) else { return month }
        let total = y * 12 + (m - 1) + n
        return String(format: "%04d-%02d", total / 12, total % 12 + 1)
    }

    /// "2026-11-10" → "10/11/2026".
    static func dueText(_ day: String?) -> String {
        guard let parts = day?.split(separator: "-"), parts.count == 3 else { return day ?? "—" }
        return "\(parts[2])/\(parts[1])/\(parts[0])"
    }

    static let filters: [(id: String, title: String, statuses: [String])] = [
        (id: "all", title: "Todas", statuses: []),
        (id: "open", title: "Em aberto", statuses: ["open"]),
        (id: "overdue", title: "Vencidas", statuses: ["overdue"]),
        (id: "paid", title: "Pagas", statuses: ["paid"]),
        (id: "waived", title: "Isentas", statuses: ["waived"]),
        (id: "cancelled", title: "Canceladas", statuses: ["cancelled"]),
    ]

    static func explain(_ error: Error) -> String {
        switch (error as? QueueError)?.code {
        case "no_conversation": return "Este cliente ainda não tem conversa no WhatsApp: a cobrança não pode ser enviada por aqui."
        case "payments_not_configured": return "A Cobrança (Pix e link) não está configurada nesta área. Um administrador configura no painel."
        case "installment_not_payable": return "Esta parcela não pode mais ser cobrada (já foi paga, isenta ou cancelada)."
        default: return ModuleFailure.message(error)
        }
    }

    static func paidVia(_ via: String?) -> String {
        switch via {
        case "pix": return "Pix"
        case "link": return "Link de pagamento"
        case "manual": return "Baixa manual"
        default: return via ?? "—"
        }
    }
}
