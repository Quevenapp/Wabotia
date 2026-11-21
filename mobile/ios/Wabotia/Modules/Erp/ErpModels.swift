import Foundation

/*
 Gestão (ERP) no aplicativo: clientes, produtos e estoque, pedido rápido e contas. As rotas são as do painel
 (`/api/v1/profiles/{p}/erp/v1/…`, a erp-api do motor) e as do envio pelo WhatsApp (`/erp-conversa/…`). Os campos
 seguem a resposta do servidor (src/erp/fagoo/workers/erp-api/src), lidos com `QueueJSON.decoder` (snake_case → camelCase);
 o que não vier fica com o padrão. Mesmo desenho do Android (`modules/erp/ErpModels.kt` e `ErpRules.kt`).
 */

// MARK: - Clientes

struct ErpContactItem: Codable, Equatable, Identifiable {
    var id: String
    var name: String = ""
    var code: String?
    var tradeName: String?
    var document: String?
    var email: String?
    var phone: String?
    var mobile: String?
    var city: String?
    var state: String?
    var situation: String?

    var subtitle: String {
        let place = [city.clean, state.clean].compactMap { $0 }.joined(separator: "/")
        return [code.clean.map { "Cód. \($0)" }, document.clean, place.isEmpty ? nil : place].compactMap { $0 }.joined(separator: " · ")
    }

    init(id: String, name: String = "", code: String? = nil, tradeName: String? = nil, document: String? = nil, email: String? = nil,
         phone: String? = nil, mobile: String? = nil, city: String? = nil, state: String? = nil, situation: String? = nil) {
        self.id = id; self.name = name; self.code = code; self.tradeName = tradeName; self.document = document; self.email = email
        self.phone = phone; self.mobile = mobile; self.city = city; self.state = state; self.situation = situation
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        code = try? c.decodeIfPresent(String.self, forKey: .code)
        tradeName = try? c.decodeIfPresent(String.self, forKey: .tradeName)
        document = try? c.decodeIfPresent(String.self, forKey: .document)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        mobile = try? c.decodeIfPresent(String.self, forKey: .mobile)
        city = try? c.decodeIfPresent(String.self, forKey: .city)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        situation = try? c.decodeIfPresent(String.self, forKey: .situation)
    }
}

struct ErpContactPage: Codable, Equatable {
    var items: [ErpContactItem] = []
    var page: Int = 1
    var total: Int = 0

    init(items: [ErpContactItem] = [], page: Int = 1, total: Int = 0) { self.items = items; self.page = page; self.total = total }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent([ErpContactItem].self, forKey: .items)) ?? []
        page = (try? c.decodeIfPresent(Int.self, forKey: .page)) ?? 1
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? items.count
    }
}

struct ErpContactRecord: Codable, Equatable, Identifiable {
    var id: String
    var version: Int?
    var name: String
    var code: String?
    var tradeName: String?
    var personType: String?
    var document: String?
    var email: String?
    var phone: String?
    var mobile: String?
    var postalCode: String?
    var street: String?
    var number: String?
    var complement: String?
    var district: String?
    var city: String?
    var state: String?
    var situation: String?

    /// "Rua Exemplo, 100 — Apto 2 · Centro · Cidade/UF · CEP 00000-000", sem as partes vazias.
    var addressText: String? {
        let first = [street.clean, number.clean].compactMap { $0 }.joined(separator: ", ")
        let line = [first.isEmpty ? nil : first, complement.clean].compactMap { $0 }.joined(separator: " — ")
        let place = [city.clean, state.clean].compactMap { $0 }.joined(separator: "/")
        let text = [line.isEmpty ? nil : line, district.clean, place.isEmpty ? nil : place, postalCode.clean.map { "CEP \($0)" }].compactMap { $0 }.joined(separator: " · ")
        return text.isEmpty ? nil : text
    }

    /// O número para ligar e para o WhatsApp: celular primeiro, depois o telefone.
    var bestPhone: String? { mobile.clean ?? phone.clean }
}

struct ErpContactEnvelope: Codable, Equatable { var record: ErpContactRecord }

struct ErpSaleHistoryItem: Codable, Equatable, Identifiable {
    var id: String
    var number: String = ""
    var date: String?
    var status: String = ""
    var total: String = "0.00"
}

struct ErpSaleHistory: Codable, Equatable {
    var visible: Bool?
    var items: [ErpSaleHistoryItem]?
}

// MARK: - Produtos e estoque

struct ErpProduct: Codable, Equatable, Identifiable {
    var id: String
    var name: String = ""
    var code: String?
    var unit: String?
    var price: String?
    var gtin: String?
    var active: Bool?
    var description: String?
    var brand: String?

    init(id: String, name: String = "", code: String? = nil, unit: String? = nil, price: String? = nil, gtin: String? = nil, active: Bool? = true, description: String? = nil, brand: String? = nil) {
        self.id = id; self.name = name; self.code = code; self.unit = unit; self.price = price; self.gtin = gtin; self.active = active; self.description = description; self.brand = brand
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        code = try? c.decodeIfPresent(String.self, forKey: .code)
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
        price = try? c.decodeIfPresent(String.self, forKey: .price)
        gtin = try? c.decodeIfPresent(String.self, forKey: .gtin)
        active = try? c.decodeIfPresent(Bool.self, forKey: .active)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        brand = try? c.decodeIfPresent(String.self, forKey: .brand)
    }

    var unitText: String { unit.clean ?? "UN" }
    var subtitle: String { [code.clean.map { "Cód. \($0)" }, gtin.clean.map { "GTIN \($0)" }].compactMap { $0 }.joined(separator: " · ") }
}

struct ErpProductList: Codable, Equatable {
    var items: [ErpProduct]?
    var hasMore: Bool?
    var nextCursor: String?
}

struct ErpProductEnvelope: Codable, Equatable { var record: ErpProduct }

struct ErpStockBalance: Codable, Equatable, Identifiable {
    var warehouseId: String
    var warehouseName: String?
    var warehouseActive: Bool?
    var quantity: String?
    var version: Int?
    var unit: String?
    var warehouseDefault: Bool?
    var reservedQuantity: String?
    var virtual: Bool?

    var id: String { warehouseId }
    var name: String { warehouseName.clean ?? "Depósito" }
    var isDefault: Bool { warehouseDefault == true }
    var isActive: Bool { warehouseActive != false }
    var isVirtual: Bool { virtual == true }
}

struct ErpStockBalances: Codable, Equatable {
    var productId: String?
    var items: [ErpStockBalance]?
}

struct ErpProductImage: Codable, Equatable {
    var id: String
    var status: String?
    var position: Int?
}

struct ErpProductImages: Codable, Equatable { var items: [ErpProductImage]? }

/// Entrada (`receipt`) ou saída (`issue`) do ajuste de estoque.
enum ErpStockDirection: String, CaseIterable, Identifiable {
    case entrada = "receipt", saida = "issue"
    var id: String { rawValue }
    var label: String { self == .entrada ? "Entrada" : "Saída" }
}

// MARK: - Pedido rápido

struct ErpPaymentMethod: Codable, Equatable, Identifiable {
    var id: String
    var description: String?
    var paymentType: String?
    var isDefault: Bool?
    var title: String { description.clean ?? "Forma" }
}

struct ErpPaymentOptions: Codable, Equatable { var methods: [ErpPaymentMethod]? }

struct ErpSavedDocument: Codable, Equatable {
    var id: String
    var number: String?
    var status: String?
    var version: Int?
}

struct ErpOrderSaved: Codable, Equatable {
    var document: ErpSavedDocument
    var replayed: Bool?
}

/// Um item do pedido em montagem.
struct ErpCartLine: Equatable, Identifiable {
    var product: ErpProduct
    var quantity: String
    var id: String { product.id }
}

// MARK: - Enviar pelo WhatsApp

struct ErpSendPhone: Codable, Equatable { var digitos: String; var numero: String? }

struct ErpSendLine: Codable, Equatable { var id: String; var nome: String? }

struct ErpSendDestination: Codable, Equatable {
    var telefone: String?
    var digitos: String?
    var linha: String?
    var modo: String?
    var motivo: String?
}

struct ErpSendPreview: Codable, Equatable {
    var telefones: [ErpSendPhone]?
    var linhas: [ErpSendLine]?
    var conectar: String?
    var destino: ErpSendDestination?

    /// O servidor oferece o envio: há linha, telefone e a regra do WhatsApp deixa sair agora.
    var canSend: Bool {
        guard let d = destino else { return false }
        return d.modo != nil && d.modo != "bloqueado" && d.digitos.clean != nil && d.linha.clean != nil
    }
}

// MARK: - Contas

struct ErpTitle: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var contactId: String?
    var contactName: String?
    var description: String?
    var dueOn: String?
    var amountCents: String?
    var balanceCents: String?
    var status: String?
    var overdue: Bool?
    var version: Int?
    var accountId: String?
    var installment: Int?
    var installments: Int?

    var balance: Int { Int(balanceCents ?? "") ?? 0 }
    var isOpen: Bool { status == nil || status == "open" || status == "partial" }
    var isPayable: Bool { kind == "payable" }
    var installmentText: String? { (installments ?? 1) > 1 ? "Parcela \(installment ?? 1) de \(installments ?? 1)" : nil }
}

struct ErpTitlePage: Codable, Equatable {
    var items: [ErpTitle]?
    var total: Int?
}

struct ErpAccount: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var active: Bool?
    var title: String { name.clean ?? "Conta" }
}

struct ErpAccountList: Codable, Equatable { var items: [ErpAccount]? }

/// O que o aplicativo mostra numa leitura: o valor e, sem conexão, quando a cópia foi guardada.
struct ErpRead<T> {
    var value: T
    var offlineAt: Int64? = nil
}

extension Optional where Wrapped == String {
    /// Texto sem espaços nas pontas, ou `nil` quando vazio.
    var clean: String? {
        guard let t = self?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
}

// MARK: - Partes, papéis e acesso

/// As partes do ERP que o aplicativo usa (src/erp/parts.ts): cada uma é um módulo da área.
enum ErpParts {
    static let customers = "erp"
    static let products = "erp-produtos"
    static let sales = "erp-vendas"
    static let stock = "erp-estoque"
    static let finance = "erp-financeiro"

    static let names: [String: String] = [customers: "Cadastros", products: "Produtos e serviços", sales: "Vendas", stock: "Estoque", finance: "Financeiro"]

    static func offMessage(_ part: String) -> String {
        "Esta tela faz parte de \(names[part] ?? part), que está desligado. Um administrador liga em Gestão → Módulos, no painel."
    }
}

/// O papel da pessoa no ERP (`erp:<papel>` em Pessoas e acessos; o administrador do Wabotia vale `admin`).
enum ErpRole: String, CaseIterable {
    case admin, consulta, vendas, financeiro, estoque, fiscal

    var label: String {
        switch self {
        case .admin: return "Administração"
        case .consulta: return "Consulta"
        case .vendas: return "Vendas"
        case .financeiro: return "Financeiro"
        case .estoque: return "Estoque"
        case .fiscal: return "Fiscal"
        }
    }
}

/// O que a entrada "Gestão" mostra: só com o ERP ligado na área e um papel `erp:*` (ou administrador). Cada item respeita
/// a parte dele; os botões de escrita seguem o papel (src/erp/role-resources.ts), e o servidor decide no fim.
struct ErpAccess: Equatable {
    let role: ErpRole
    let parts: Set<String>

    private func has(_ part: String) -> Bool { parts.contains(part) }

    var customers: Bool { has(ErpParts.customers) }
    var products: Bool { has(ErpParts.products) && role != .financeiro }
    var stock: Bool { products && has(ErpParts.stock) }
    var quickOrder: Bool { has(ErpParts.sales) && has(ErpParts.products) && [.admin, .vendas].contains(role) }
    var bills: Bool { has(ErpParts.finance) && [.admin, .consulta, .financeiro].contains(role) }
    var customerOrders: Bool { has(ErpParts.sales) && [.admin, .consulta, .vendas, .fiscal].contains(role) }
    var customerBills: Bool { bills }
    var canCreateCustomer: Bool { customers && role != .consulta }
    var canAdjustStock: Bool { stock && [.admin, .estoque].contains(role) }
    var canSettle: Bool { bills && [.admin, .financeiro].contains(role) }
    var anything: Bool { customers || products || quickOrder || bills }

    /// `nil` quando a Gestão não aparece: ERP desligado na área ou pessoa sem papel do ERP.
    static func of(modules: Set<String>, grants: Set<String>, isAdmin: Bool) -> ErpAccess? {
        guard modules.contains(ErpParts.customers) else { return nil }
        let role: ErpRole? = isAdmin ? .admin : grants.lazy.compactMap { g in g.hasPrefix("erp:") ? ErpRole(rawValue: String(g.dropFirst(4))) : nil }.first
        guard let role else { return nil }
        let access = ErpAccess(role: role, parts: modules.filter { $0 == "erp" || $0.hasPrefix("erp-") })
        return access.anything ? access : nil
    }
}

// MARK: - Números

/// Quantidades, preços e totais exatos, com as mesmas regras do servidor (packages/erp-domain: centavos, meio para cima).
enum ErpNumbers {
    private static let posix = Locale(identifier: "en_US_POSIX")

    static func decimal(_ text: String?) -> Decimal? {
        guard let t = text?.trimmingCharacters(in: .whitespaces), !t.isEmpty,
              t.range(of: #"^-?[0-9]+(\.[0-9]+)?$"#, options: .regularExpression) != nil else { return nil }
        return Decimal(string: t, locale: posix)
    }

    private static func round(_ value: Decimal, _ scale: Int) -> Decimal {
        var input = value, output = Decimal()
        NSDecimalRound(&output, &input, scale, .plain)
        return output
    }

    private static func plain(_ value: Decimal) -> String { NSDecimalNumber(decimal: value).description(withLocale: posix) }

    /// "1,5", "2", "0,25" → "1.5" (até 6 casas, maior que zero); `nil` quando não serve.
    static func quantity(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: ".")
        guard t.range(of: #"^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$"#, options: .regularExpression) != nil,
              let value = decimal(t), value > 0 else { return nil }
        return plain(value)
    }

    /// Quantidade do servidor ("12.500000", "-3.000000") para a tela: "12,5", "-3".
    static func showQuantity(_ value: String?) -> String {
        guard let v = decimal(value) else { return "0" }
        let text = plain(v)
        return text == "-0" ? "0" : text.replacingOccurrences(of: ".", with: ",")
    }

    /// Preço do produto em centavos arredondados, para mostrar.
    static func priceCents(_ price: String?) -> Int? {
        guard let v = decimal(price) else { return nil }
        return NSDecimalNumber(decimal: round(v * 100, 0)).intValue
    }

    static func showPrice(_ price: String?) -> String { priceCents(price).map(Money.format) ?? "Sem preço" }

    /// O preço como o servidor aceita no item (até 10 casas).
    static func unitPrice(_ price: String?) -> String? {
        guard let v = decimal(price), v >= 0 else { return nil }
        let text = plain(round(v, 10))
        return text.contains(".") ? text : text + ".00"
    }

    /// Valor do item em centavos: quantidade × preço exato, meio para cima.
    static func lineCents(_ quantity: String, _ unitPrice: String) -> Int {
        guard let q = decimal(quantity), let p = decimal(unitPrice) else { return 0 }
        return NSDecimalNumber(decimal: round(q * p * 100, 0)).intValue
    }

    /// "5,00" (reais) ou "10" (%) → o valor como o servidor espera ("5.00" ou "10.0000").
    static func discountValue(_ text: String, percent: Bool) -> String? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return percent ? "0.0000" : "0.00" }
        if percent {
            let n = t.replacingOccurrences(of: ",", with: ".")
            guard n.range(of: #"^[0-9]{1,3}(\.[0-9]{1,4})?$"#, options: .regularExpression) != nil, let v = decimal(n), v <= 100 else { return nil }
            return String(format: "%.4f", locale: posix, NSDecimalNumber(decimal: v).doubleValue)
        }
        guard let cents = Money.parse(t) else { return nil }
        return centsText(cents)
    }

    /// Desconto em centavos sobre o subtotal: valor fixo ou percentual (meio para cima).
    static func discountCents(_ subtotal: Int, _ value: String, percent: Bool) -> Int {
        guard let v = decimal(value) else { return 0 }
        if !percent { return NSDecimalNumber(decimal: round(v * 100, 0)).intValue }
        return NSDecimalNumber(decimal: round(Decimal(subtotal) * v / 100, 0)).intValue
    }

    /// 1234 → "12.34".
    static func centsText(_ cents: Int) -> String { "\(cents / 100).\(String(format: "%02d", cents % 100))" }
}

/// O total do pedido rápido, igual ao que o servidor calcula (para a parcela única bater).
struct ErpOrderTotals: Equatable {
    let subtotal: Int
    let discount: Int
    var total: Int { subtotal - discount }
    var valid: Bool { discount <= subtotal }

    static func of(_ lines: [ErpCartLine], discount: String, percent: Bool) -> ErpOrderTotals? {
        var subtotal = 0
        for line in lines {
            guard let price = ErpNumbers.unitPrice(line.product.price) else { return nil }
            subtotal += ErpNumbers.lineCents(line.quantity, price)
        }
        return ErpOrderTotals(subtotal: subtotal, discount: ErpNumbers.discountCents(subtotal, discount, percent: percent))
    }
}

// MARK: - Textos

/// Textos da Gestão: situação, telefones e as recusas do ERP em palavras.
enum ErpText {
    static let offlineRead = "Sem conexão com o Wabotia e nenhuma cópia guardada neste aparelho. Confira a internet e toque em Tentar de novo."
    static let offlineWrite = "Sem conexão. Nada foi enviado: tente de novo quando a internet voltar."
    static let cameraDenied = "Para ler o código de barras, libere a câmera para o Wabotia em Ajustes do iPhone."
    static let noCamera = "Este aparelho não tem câmera disponível. Digite o código na busca."

    static func offlineBanner(_ savedAt: Int64) -> String {
        "Sem conexão. Você está vendo a cópia de \(BrasiliaTime.shortWithTime(savedAt)). Para mudar alguma coisa, conecte-se."
    }

    static let saleStatus: [String: String] = [
        "draft": "Em digitação", "open": "Em aberto", "verified": "Verificado", "in_progress": "Em andamento",
        "partially_fulfilled": "Atendido parcialmente", "fulfilled": "Atendido", "cancelled": "Cancelado",
        "agency_sale": "Venda agenciada", "partially_invoiced": "Faturado parcialmente", "checkout_partial": "Checkout parcial",
    ]

    static func saleStatus(_ value: String) -> String { saleStatus[value] ?? value.replacingOccurrences(of: "_", with: " ") }

    /// Telefone só com dígitos, com 55 na frente quando é número brasileiro sem DDI.
    static func whatsappDigits(_ phone: String?) -> String? {
        var d = (phone ?? "").filter { $0.isASCII && $0.isNumber }
        while d.hasPrefix("0") { d.removeFirst() }
        guard d.count >= 8 else { return nil }
        return (10...11).contains(d.count) ? "55" + d : d
    }

    static func dialURL(_ phone: String?) -> URL? {
        let t = (phone ?? "").filter { ($0.isASCII && $0.isNumber) || $0 == "+" }
        guard t.filter(\.isNumber).count >= 8 else { return nil }
        return URL(string: "tel:" + t)
    }

    static func whatsappURL(_ phone: String?) -> URL? { whatsappDigits(phone).flatMap { URL(string: "https://wa.me/" + $0) } }

    /// Código de barras lido ou digitado: texto curto sem caractere de controle.
    static func barcode(_ value: String?) -> String? {
        guard let t = value?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, t.count <= 120,
              !t.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return t
    }

    /// O produto cujo GTIN ou código é exatamente o lido (a busca do servidor também acha parecidos).
    static func exactBarcode(_ products: [ErpProduct], _ code: String) -> ErpProduct? {
        products.first { $0.gtin?.trimmingCharacters(in: .whitespaces) == code } ?? products.first { $0.code?.trimmingCharacters(in: .whitespaces) == code }
    }

    /// A recusa do servidor dita para o dono do negócio: o que aconteceu e o que fazer.
    static func message(_ error: Error, part: String? = nil) -> String {
        guard let e = error as? QueueError else { return error.localizedDescription }
        if e.status == 0 { return offlineRead }
        if e.status == 409 && e.code == "module_disabled" {
            return part.map(ErpParts.offMessage) ?? "Esta parte da Gestão está desligada. Um administrador liga em Gestão → Módulos, no painel."
        }
        switch e.code {
        case "ERP_FORBIDDEN", "ERP_ACCESS_DENIED", "ERP_DOCUMENT_PERMISSION_DENIED", "forbidden", "erp_user_required":
            return "Seu papel no ERP não permite esta ação. Peça ao administrador em Pessoas e acessos."
        case "ERP_ACCESS_OUTSIDE_SCHEDULE": return "Fora do horário liberado para você no ERP. Tente no horário combinado ou fale com o administrador."
        case "ERP_MFA_REQUIRED", "mfa_required": return "Esta ação pede a confirmação em duas etapas. Faça pelo painel, no navegador, com o segundo fator."
        case "ERP_CONFLICT", "ERP_DOCUMENT_VERSION_LOCKED": return "Alguém mudou este registro agora há pouco. A tela foi atualizada: confira e tente de novo."
        case "ERP_NOT_FOUND", "not_found": return "Não achei este registro no ERP. Ele pode ter sido excluído; atualize a lista."
        case "ERP_CONTACT_DUPLICATE_DOCUMENT": return "Já existe um cliente com este CPF/CNPJ. Procure por ele na busca."
        case "ERP_CONTACT_REQUIRED_FIELD": return "O cadastro de clientes desta empresa pede mais dados. Complete pelo painel ou preencha os campos pedidos."
        case "ERP_CONTACT_INVALID_FIELD": return "Algum dado do cliente não confere (CPF/CNPJ, e-mail ou telefone). Revise e tente de novo."
        case "ERP_CONTACT_NOT_VISIBLE": return "Este cliente é de outro vendedor e não aparece para você."
        case "ERP_CUSTOMER_RESTRICTED", "erp_customer_restricted": return "O cadastro deste cliente está restrito pela privacidade. Fale com o administrador."
        case "ERP_DOCUMENT_CREDIT_LIMIT": return "O pedido passa do limite de crédito do cliente. Diminua o valor ou fale com o financeiro."
        case "ERP_DOCUMENT_APPROVAL_REQUIRED": return "O desconto passa do seu limite e precisa de aprovação. Diminua o desconto ou peça a aprovação."
        case "ERP_DOCUMENT_LOT_UNAVAILABLE": return "O produto pede lote e o lote não está disponível. Monte este pedido pelo painel."
        case "ERP_DOCUMENT_QUANTITY_DECIMALS": return "A quantidade tem mais casas decimais do que este produto aceita."
        case "ERP_PAYMENT_METHOD_INACTIVE": return "Esta forma de pagamento foi desativada. Escolha outra."
        case "ERP_INVALID_QUERY", "ERP_INVALID_INPUT", "ERP_VALIDATION_FAILED", "invalid_request":
            return "O ERP não aceitou os dados. Confira quantidade, preço, desconto e datas e tente de novo."
        case "ERP_UPSTREAM_UNAVAILABLE", "ERP_REQUEST_TIMEOUT", "erp_parts_unavailable", "erp_parts_stale":
            return "O ERP não respondeu agora. Espere um pouco e tente de novo."
        case "ERP_RESULT_UNCONFIRMED": return "O ERP não confirmou a gravação. Toque de novo para conferir: não duplica."
        case "erp_conversa_blocked": return e.message.isEmpty ? "Este envio não sai pelo WhatsApp agora." : e.message
        default:
            if !e.message.isEmpty, !e.message.hasPrefix("O Wabotia recusou"), !e.message.hasPrefix("Sem permissão para esta ação na fila") { return e.message }
            switch e.status {
            case 401: return "Sua sessão terminou. Entre de novo."
            case 403: return "Seu papel no ERP não permite esta ação. Peça ao administrador em Pessoas e acessos."
            case 409: return "O ERP recusou por conflito com outra mudança. Atualize e tente de novo."
            case 500...599: return "O ERP teve um problema agora. Tente de novo em instantes."
            default: return "O ERP recusou (\(e.code)). Confira os dados e tente de novo."
            }
        }
    }

    /// Falha que permite mostrar a cópia guardada (sem conexão ou servidor fora do ar).
    static func isOffline(_ error: Error) -> Bool {
        guard let e = error as? QueueError else { return error is URLError }
        return e.status == 0 || e.status == 408 || e.status >= 500
    }
}

// MARK: - Corpos das escritas (as chaves que a erp-api aceita)

enum ErpBodies {
    /// O `command_id` do ERP (um UUID) a partir da `Idempotency-Key` da intenção (`wabotia-<uuid>`).
    static func commandId(_ key: String) -> String { key.hasPrefix("wabotia-") ? String(key.dropFirst(8)) : key }

    static func quickContact(key: String, name: String, personType: String, document: String?, mobile: String?, email: String?) -> [String: Any?] {
        var data: [String: Any] = ["name": name, "person_type": personType, "situation": "A", "taxpayer": "9", "types": ["customer"]]
        if let document { data["document"] = document }
        if let mobile { data["mobile"] = mobile }
        if let email { data["email"] = email }
        return ["command_id": commandId(key), "data": data]
    }

    /// O servidor exige a versão do saldo, inclusive 0 (depósito sem lançamento).
    static func stockMovement(key: String, direction: ErpStockDirection, day: String, reason: String, productId: String, warehouseId: String, quantity: String, version: Int) -> [String: Any?] {
        let signed = direction == .saida ? "-" + quantity : quantity
        return ["command_id": commandId(key), "kind": direction.rawValue, "occurred_on": day, "reason": reason,
                "items": [["product_id": productId, "warehouse_id": warehouseId, "quantity": signed, "expected_version": version] as [String: Any]]]
    }

    /// O pedido de venda: desconto sempre (modo e valor), parcela única com a forma escolhida.
    static func order(key: String, day: String, contactId: String, lines: [ErpCartLine], discountValue: String, percent: Bool, total: Int, method: ErpPaymentMethod?) -> [String: Any?] {
        let items: [[String: Any]] = lines.map { line in
            var item: [String: Any] = ["product_id": line.product.id, "description": String(line.product.name.prefix(200)), "unit": String(line.product.unitText.prefix(16)),
                                       "quantity": line.quantity, "unit_price": ErpNumbers.unitPrice(line.product.price) ?? "0.00"]
            if let code = line.product.code.clean { item["code"] = String(code.prefix(100)) }
            return item
        }
        var data: [String: Any] = ["date": day, "contact_id": contactId, "items": items, "discount_mode": percent ? "percent" : "amount", "discount_value": discountValue]
        if let method, total > 0 {
            var row: [String: Any] = ["due_date": day, "amount": ErpNumbers.centsText(total), "payment_method_id": method.id]
            if let text = method.description.clean { row["method"] = String(text.prefix(100)) }
            data["installments"] = [row]
        }
        return ["command_id": commandId(key), "data": data]
    }

    static func settle(key: String, title: ErpTitle, accountId: String, day: String) -> [String: Any?] {
        ["command_id": commandId(key), "data": ["id": title.id, "expected_version": title.version ?? 1, "account_id": accountId, "posted_on": day,
                                                "principal_cents": String(title.balance)] as [String: Any]]
    }
}
