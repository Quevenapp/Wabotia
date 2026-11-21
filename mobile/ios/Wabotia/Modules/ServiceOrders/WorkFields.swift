import Foundation

/// Erro de preenchimento de um campo próprio, com a mesma frase do painel (`parseExtra`).
struct WorkFieldError: Error, Equatable {
    let fieldId: String
    let message: String
}

/// Campos próprios dos modelos e dos tipos de objeto, sem tela, para testar: o que aparece (nunca os sensíveis), o
/// rascunho que os editores mexem (texto por campo), a validação igual à do painel e o valor para mostrar.
///
/// Rascunho: texto e números como digitados; Sim/Não como "true"/"false"; data como "AAAA-MM-DD"; escolha pelo `id`
/// da opção; "" é vazio.
enum WorkFields {
    /// Campos que aparecem e vão no corpo: os sensíveis têm fluxo próprio no painel e nunca passam pelo app.
    static func visible(_ fields: [WorkField]?) -> [WorkField] { (fields ?? []).filter { !$0.isSensitive } }

    /// O rascunho a partir dos valores atuais (só campos visíveis).
    static func draft(_ fields: [WorkField]?, values: [String: WorkValue]?) -> [String: String] {
        var out: [String: String] = [:]
        for field in visible(fields) {
            guard let value = values?[field.id] else { continue }
            switch value {
            case .null: out[field.id] = ""
            case .string(let s): out[field.id] = s
            case .bool(let b): out[field.id] = b ? "true" : "false"
            case .number(let n): out[field.id] = numberText(n, decimal: field.type == "decimal")
            }
        }
        return out
    }

    /// Número para editar, com vírgula: 1.5 → "1,5"; 85000 → "85000".
    static func numberText(_ n: Double, decimal: Bool = true) -> String {
        if n.rounded() == n, abs(n) < 1e15 { return String(Int64(n)) }
        var text = String(n)
        if text.contains("e") { text = String(format: "%.6f", n) }
        while text.contains("."), text.hasSuffix("0") { text.removeLast() }
        return text.replacingOccurrences(of: ".", with: ",")
    }

    /// Os valores validados para enviar em `extra`. Só os campos visíveis presentes no rascunho entram; um campo
    /// presente e vazio vai como nulo explícito (apaga o valor). `required` acrescenta obrigatórios (regra de etapa).
    static func parse(_ fields: [WorkField]?, draft: [String: String], required: Set<String> = []) -> Result<[String: WorkValue], WorkFieldError> {
        var values: [String: WorkValue] = [:]
        for field in visible(fields) {
            let raw = draft[field.id]
            let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if text.isEmpty {
                if field.isRequired || required.contains(field.id) {
                    return .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): preenchimento obrigatório."))
                }
                if raw != nil { values[field.id] = .null }
                continue
            }
            switch field.type {
            case "integer", "decimal":
                guard let number = parseNumber(text) else {
                    return .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): número inválido."))
                }
                let normalized = text.replacingOccurrences(of: ",", with: ".")
                let decimals = normalized.split(separator: ".", omittingEmptySubsequences: false).dropFirst().first?.count ?? 0
                let tooBig = abs(number) > 9_007_199_254_740_991
                if let min = field.min?.number, number < min { return limitError(field) }
                if let max = field.max?.number, number > max { return limitError(field) }
                if field.type == "integer", decimals > 0 || tooBig { return limitError(field) }
                if field.type == "decimal", decimals > (field.scale ?? 0) { return limitError(field) }
                values[field.id] = .number(number)
            case "date":
                guard isValidDay(text),
                      field.min?.string.map({ $0.isEmpty || text >= $0 }) ?? true,
                      field.max?.string.map({ $0.isEmpty || text <= $0 }) ?? true else {
                    return .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): data inválida."))
                }
                values[field.id] = .string(text)
            case "choice":
                guard (field.options ?? []).contains(where: { $0.id == text }) else {
                    return .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): escolha uma opção válida."))
                }
                values[field.id] = .string(text)
            case "boolean":
                guard text == "true" || text == "false" else {
                    return .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): escolha Sim ou Não."))
                }
                values[field.id] = .bool(text == "true")
            default:
                if let max = field.maxLength, max > 0, text.count > max {
                    return .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): texto fora do limite."))
                }
                values[field.id] = .string(raw ?? text)
            }
        }
        return .success(values)
    }

    private static func limitError(_ field: WorkField) -> Result<[String: WorkValue], WorkFieldError> {
        .failure(WorkFieldError(fieldId: field.id, message: "\(field.title): confira limites e casas decimais."))
    }

    /// "1.234" não é aceito (como no painel): só dígitos com um separador decimal, ponto ou vírgula.
    static func parseNumber(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard t.range(of: #"^-?\d+(?:\.\d+)?$"#, options: .regularExpression) != nil, let n = Double(t), n.isFinite else { return nil }
        return n
    }

    private static let utcDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func isValidDay(_ text: String) -> Bool {
        guard text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil, let date = utcDay.date(from: text) else { return false }
        return utcDay.string(from: date) == text
    }

    /// O dia escolhido no DatePicker, em Brasília ("AAAA-MM-DD").
    static func day(from date: Date) -> String { BrasiliaTime.day(date) }

    /// O dia "AAAA-MM-DD" como data do DatePicker (meio-dia de Brasília, para não escorregar de dia em outro fuso).
    static func date(from day: String) -> Date? {
        BrasiliaTime.start(of: day).map { $0.addingTimeInterval(12 * 3600) }
    }

    /// Valor para mostrar: Sim/Não, rótulo da opção, data dd/MM/aaaa, número com vírgula; vazio "—". Sensível nunca.
    static func display(_ field: WorkField, _ value: WorkValue?) -> String {
        guard !field.isSensitive, let value, !value.isEmpty else { return "—" }
        switch value {
        case .bool(let b): return b ? "Sim" : "Não"
        case .number(let n): return numberText(n)
        case .string(let s):
            if field.type == "choice" { return field.options?.first { $0.id == s }?.label ?? s }
            if field.type == "date", isValidDay(s) {
                let p = s.split(separator: "-")
                return "\(p[2])/\(p[1])/\(p[0])"
            }
            return s
        case .null: return "—"
        }
    }

    /// Obrigatórios na abertura: `required` do campo ou regra de etapa que começa na etapa inicial do modelo.
    static func requiredAtOpening(_ type: WorkTypeView) -> Set<String> {
        var out = Set(visible(type.fields).filter(\.isRequired).map(\.id))
        for rule in type.stageFieldRules ?? [] where rule.requiredFromStage != nil && rule.requiredFromStage == type.initialStage {
            out.insert(rule.fieldId)
        }
        return out
    }

    /// Obrigatórios já na etapa atual (regra cuja etapa vem antes ou é a atual, na ordem das etapas do modelo).
    static func requiredNow(_ type: WorkTypeView?, stage: String?, fields: [WorkField]?) -> Set<String> {
        var out = Set(visible(fields).filter(\.isRequired).map(\.id))
        guard let type, let stages = type.stages, let current = stages.firstIndex(where: { $0.id == stage }) else { return out }
        for rule in type.stageFieldRules ?? [] {
            guard let from = rule.requiredFromStage, let index = stages.firstIndex(where: { $0.id == from }) else { continue }
            if index <= current { out.insert(rule.fieldId) }
        }
        return out
    }

    /// Campos pedidos na próxima mudança de etapa: regra que começa numa das próximas etapas (menos o cancelamento) ou
    /// que é exigida para sair da etapa atual. Sem o modelo, nada é marcado.
    static func askedNext(_ type: WorkTypeView?, order: WorkOrder) -> Set<String> {
        guard let type else { return [] }
        let next = Set((order.nextStages ?? []).filter { $0.baseStatus != "cancelled" }.compactMap(\.stage))
        var out: Set<String> = []
        for rule in type.stageFieldRules ?? [] {
            if let from = rule.requiredFromStage, next.contains(from) { out.insert(rule.fieldId) }
            if let stage = order.stage, (rule.requiredOnExit ?? []).contains(stage) { out.insert(rule.fieldId) }
        }
        return out
    }

    /// `extra` para o PATCH: os valores comuns atuais da ordem com os editados por cima.
    static func merged(current: [String: WorkValue]?, fields: [WorkField]?, edited: [String: WorkValue]) -> [String: WorkValue] {
        var out: [String: WorkValue] = [:]
        for field in visible(fields) { if let v = current?[field.id] { out[field.id] = v } }
        for (k, v) in edited { out[k] = v }
        return out
    }

    static func json(_ values: [String: WorkValue]) -> [String: Any] { values.mapValues(\.json) }
}
