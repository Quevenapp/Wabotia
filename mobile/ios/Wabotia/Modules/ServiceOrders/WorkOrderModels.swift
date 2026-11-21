import Foundation

/*
 Ordem de serviço por modelo (OS2 em diante, `src/modules/os/contracts.ts`). O servidor manda o catálogo de modelos
 (`GET service-orders/types`), cada ordem com a etapa do modelo, os campos próprios (`fields` + `extra`), o objeto do
 serviço (veículo, aparelho…), o checklist por etapa e o orçamento. A ordem antiga (`service_order`) continua com as
 telas e os tipos de `ServiceOrderClient.swift`.

 Tudo é opcional na decodificação: um campo novo ou faltando no servidor nunca descarta a ordem.
 */

/// Valor de um campo próprio: texto, número, Sim/Não ou vazio (`FieldValue` do contrato).
enum WorkValue: Codable, Equatable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n):
            if n.rounded() == n, abs(n) < 9_007_199_254_740_992 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }

    /// Para `JSONSerialization` (corpo das escritas): inteiros saem sem casas decimais.
    var json: Any {
        switch self {
        case .string(let s): return s
        case .number(let n):
            if n.rounded() == n, abs(n) < 9_007_199_254_740_992 { return Int64(n) }
            return n
        case .bool(let b): return b
        case .null: return NSNull()
        }
    }

    var isEmpty: Bool {
        switch self {
        case .null: return true
        case .string(let s): return s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default: return false
        }
    }

    var number: Double? { if case .number(let n) = self { return n }; return nil }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
}

/// O decodificador das rotas novas: converte snake_case para camelCase, menos as chaves dos mapas de valores
/// (`extra`, `values`, `counts`), que são ids de campo e de estado e precisam chegar exatamente como o servidor mandou.
/// O mesmo decodificador lê o cache (já em camelCase: sem `_`, a chave fica como está).
enum WorkJSON {
    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int?
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.intValue = intValue; stringValue = String(intValue) }
    }

    static let rawMaps: Set<String> = ["extra", "values", "counts"]

    static func camel(_ key: String) -> String {
        guard key.contains("_") else { return key }
        let parts = key.split(separator: "_", omittingEmptySubsequences: true)
        guard let first = parts.first else { return key }
        return String(first) + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .custom { path in
            let last = path.last!
            if path.count >= 2, rawMaps.contains(path[path.count - 2].stringValue) { return Key(last.stringValue) }
            return Key(camel(last.stringValue))
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try decoder.decode(T.self, from: data) }
        catch { throw QueueError(status: 200, code: "invalid_response", message: "Resposta inesperada do Vinki.") }
    }
}

struct WorkFieldOption: Codable, Equatable, Hashable {
    var id: String
    var label: String?
}

/// Campo próprio de um modelo ou de um tipo de objeto. `min`/`max` são números (inteiro, decimal) ou "AAAA-MM-DD" (data).
struct WorkField: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var label: String?
    var help: String?
    var required: Bool?
    var sensitive: Bool?
    var clientVisible: Bool?
    var multiline: Bool?
    var maxLength: Int?
    var min: WorkValue?
    var max: WorkValue?
    var scale: Int?
    var options: [WorkFieldOption]?

    var title: String { label?.isEmpty == false ? label! : id }
    var isSensitive: Bool { sensitive == true }
    var isRequired: Bool { required == true }
    var type: String { kind ?? "text" }
}

struct WorkLabels: Codable, Equatable {
    var singular: String?
    var plural: String?
    var item: String?
    var problem: String?
    var customerSingular: String?
    var customerPlural: String?
}

struct WorkChecklistItemDef: Codable, Equatable, Identifiable {
    var id: String
    var label: String?
    var required: Bool?
    var photoRequired: Bool?
}

struct WorkStage: Codable, Equatable, Identifiable {
    var id: String
    var label: String?
    var baseStatus: String?
    var message: String?
    var checklist: [WorkChecklistItemDef]?

    var title: String { label?.isEmpty == false ? label! : id }
}

struct StageFieldRule: Codable, Equatable {
    var fieldId: String
    var requiredFromStage: String?
    var requiredOnExit: [String]?
}

struct WorkQuotePolicy: Codable, Equatable {
    var defaultValidDays: Int?
    var sentStage: String?
}

struct WorkFeatures: Codable, Equatable {
    var quote: WorkQuotePolicy?
    var documents: Bool?
    var tasks: Bool?
}

struct WorkTransition: Codable, Equatable {
    var id: String
    var from: String?
    var to: String?
    var label: String?
    var kind: String?
}

/// Modelo do catálogo (`kind: "custom"`) ou a ordem antiga (`kind: "builtin"`, id `service_order`).
struct WorkTypeView: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var revision: Int?
    var archived: Bool?
    var labels: WorkLabels?
    var fields: [WorkField]?
    var stages: [WorkStage]?
    var initialStage: String?
    var transitions: [WorkTransition]?
    var features: WorkFeatures?
    var objectTypeId: String?
    var stageFieldRules: [StageFieldRule]?

    static let builtinId = "service_order"

    var isBuiltin: Bool { kind == "builtin" || id == Self.builtinId }
    var isActive: Bool { archived != true }
    /// Nome do modelo nas listas: o plural ("Oficina", "Assistência de celulares").
    var name: String {
        if let p = labels?.plural, !p.isEmpty { return p }
        if let s = labels?.singular, !s.isEmpty { return s }
        return isBuiltin ? "Ordens de serviço" : id
    }
    var singular: String { labels?.singular?.isEmpty == false ? labels!.singular! : "Ordem" }
    var itemLabel: String { labels?.item?.isEmpty == false ? labels!.item! : "Item" }
    var problemLabel: String { labels?.problem?.isEmpty == false ? labels!.problem! : "Problema" }
    func stage(_ id: String?) -> WorkStage? { stages?.first { $0.id == id } }
}

struct WorkTypeCatalog: Codable, Equatable {
    var data: [WorkTypeView]?
    var settingsRevision: String?

    var active: [WorkTypeView] { (data ?? []).filter(\.isActive) }
    var activeCustom: [WorkTypeView] { active.filter { !$0.isBuiltin } }
    func type(_ id: String?) -> WorkTypeView? { data?.first { $0.id == id } }
}

struct ObjectTypeLabels: Codable, Equatable {
    var singular: String?
    var plural: String?
}

/// Tipo de objeto do serviço (veículo, aparelho, imóvel…).
struct ServiceObjectType: Codable, Equatable, Identifiable {
    var id: String
    var archived: Bool?
    var labels: ObjectTypeLabels?
    var identifierFieldId: String?
    var fields: [WorkField]?

    var singular: String { labels?.singular?.isEmpty == false ? labels!.singular! : "Objeto" }
}

/// Objeto já cadastrado para o cliente (`GET service-orders/objects`).
struct ServiceObjectView: Codable, Equatable, Identifiable {
    var id: String
    var contactId: String?
    var typeId: String?
    var type: ServiceObjectType?
    var values: [String: WorkValue]?
    var archived: Bool?
    var version: Int?
    var identifier: String?
}

struct WorkOrderCustomer: Codable, Equatable {
    var name: String?
    var phone: String?
    var contactId: String?
    var conversationId: String?
}

struct WorkNextStage: Codable, Equatable, Identifiable {
    var transitionId: String
    var stage: String?
    var stageLabel: String?
    var baseStatus: String?
    var kind: String?

    var id: String { transitionId }
    var isApproval: Bool { kind == "customer_approval" }
}

struct WorkStageApproval: Codable, Equatable {
    var version: Int?
    var transitionId: String?
    var fromStage: String?
    var toStage: String?
    var state: String?
    var requestedAt: Int64?
    var expiresAt: Int64?
}

struct WorkQuoteItem: Codable, Equatable {
    var description: String?
    var quantity: Double?
    var unitCents: Int?
    var discountCents: Int?
    var unit: String?

    /// quantidade × valor − desconto da linha.
    var lineCents: Int { Int(((quantity ?? 1) * Double(unitCents ?? 0)).rounded()) - (discountCents ?? 0) }
}

struct WorkQuote: Codable, Equatable {
    var items: [WorkQuoteItem]?
    var totalCents: Int?
    var subtotalCents: Int?
    var discountCents: Int?
    var note: String?
    var validUntil: Int64?
    var sentAt: Int64?
    var version: Int?
    var expired: Bool?
    var locked: Bool?
}

struct WorkDecision: Codable, Equatable {
    var decision: String?
    var at: Int64?
    var by: String?
    var via: String?
}

struct WorkChecklistItem: Codable, Equatable, Identifiable {
    var id: String
    var label: String?
    var required: Bool?
    var photoRequired: Bool?
    var done: Bool?
    var photoDocumentId: String?
    var by: String?
    var at: Int64?

    var title: String { label?.isEmpty == false ? label! : id }
}

struct WorkChecklistStage: Codable, Equatable, Identifiable {
    var stageId: String
    var stageLabel: String?
    var current: Bool?
    var items: [WorkChecklistItem]?
    var missing: [String]?

    var id: String { stageId }
}

/// O objeto como ficou na ordem (cópia tirada na abertura).
struct WorkObjectSnapshot: Codable, Equatable {
    var objectId: String?
    var objectVersion: Int?
    var type: ServiceObjectType?
    var values: [String: WorkValue]?
    var identifier: String?
}

struct WorkOrder: Codable, Equatable, Identifiable {
    var id: String
    var number: Int?
    var displayNumber: String?
    var status: String?
    var statusLabel: String?
    var typeId: String?
    var typeLabel: String?
    var typePluralLabel: String?
    var stage: String?
    var stageLabel: String?
    var labels: WorkLabels?
    var customer: WorkOrderCustomer?
    var item: String?
    var problem: String?
    var notes: String?
    var assignee: String?
    var dueAt: Int64?
    var extra: [String: WorkValue]?
    var fields: [WorkField]?
    var version: Int?
    var features: WorkFeatures?
    var object: WorkObjectSnapshot?
    var nextStages: [WorkNextStage]?
    var stageApproval: WorkStageApproval?
    var quote: WorkQuote?
    var decision: WorkDecision?
    var nextStatuses: [String]?
    var checklist: [WorkChecklistStage]?
    var created: Int64?
    var updated: Int64?

    var state: String { status ?? "received" }
    var isLegacy: Bool { typeId == nil || typeId == WorkTypeView.builtinId }
    var isClosed: Bool { ServiceOrderRules.closed.contains(state) }
    var numberText: String {
        if let d = displayNumber, !d.isEmpty { return d }
        return number.map { "nº \($0)" } ?? "—"
    }
    var stageText: String {
        if let s = stageLabel, !s.isEmpty { return s }
        if let s = statusLabel, !s.isEmpty { return s }
        return ServiceOrderRules.statusLabel(state)
    }
    var customerName: String {
        if let name = customer?.name, !name.isEmpty { return name }
        if let phone = customer?.phone, !phone.isEmpty { return PhoneText.display(phone) ?? phone }
        return "Cliente"
    }
    var itemLabel: String { labels?.item?.isEmpty == false ? labels!.item! : "Item" }
    var problemLabel: String { labels?.problem?.isEmpty == false ? labels!.problem! : "Problema" }
    var title: String { [typeLabel ?? labels?.singular, numberText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ") }
}

struct WorkOrderPage: Codable, Equatable {
    var data: [WorkOrder]?
    var nextCursor: String?
    var counts: [String: Int]?
}

struct WorkHistoryEntry: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var fromStatus: String?
    var toStatus: String?
    var fromStage: String?
    var toStage: String?
    var actor: String?
    var note: String?
    var created: Int64?
}

struct WorkHistoryPage: Codable, Equatable {
    var data: [WorkHistoryEntry]?
    var nextCursor: String?
}

struct FieldRef: Codable, Equatable {
    var fieldId: String
    var label: String?
}

struct OrderRequirements: Codable, Equatable {
    var id: String?
    var version: Int?
    var transitionId: String?
    var required: [FieldRef]?
    var missing: [FieldRef]?
    var internalMissing: Bool?
}

struct DocumentReservation: Codable, Equatable {
    var id: String
    var orderId: String?
    var version: Int?
    var uploadUrl: String?
    var expiresAt: Int64?
}

struct DocumentUploadResult: Codable, Equatable {
    var id: String?
    var version: Int?
    var uploadAttempt: String?
    var byteLength: Int?
    var sha256: String?
}

struct MutationRef: Codable, Equatable {
    var id: String?
    var orderId: String?
    var version: Int?
}

/// Cliente do cadastro (`GET contacts`).
struct WorkContact: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var phone: String?
    var namespace: String?
    var identityState: String?
    var mergedInto: String?

    var displayName: String {
        if let n = name, !n.isEmpty { return n }
        return PhoneText.display(phone) ?? "Cliente"
    }

    /// Só o cadastro da equipe, ativo e não mesclado em outro.
    var selectable: Bool {
        (mergedInto ?? "").isEmpty && ((namespace ?? "").isEmpty || namespace == "team")
            && ((identityState ?? "").isEmpty || identityState == "active")
    }
}

struct WorkPage<T: Codable & Equatable>: Codable, Equatable {
    var data: [T]?
    var nextCursor: String?
}
