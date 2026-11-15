import Foundation
import Combine

/// As rotas de uma área (`/api/v1/profiles/{p}/…`) para os módulos (agenda, ordem de serviço), com o token da pessoa.
/// Erros do contrato chegam como `QueueError` (status, código e mensagem do servidor); `module_disabled` esconde a tela.
final class ProfileAPI {
    let base: String
    let profileId: String
    private let token: () -> String?
    private let session: URLSession

    init(baseURL: String, profileId: String, session: URLSession = QueueHTTP.shared, token: @escaping () -> String?) {
        self.base = QueueHTTP.normalize(baseURL)
        self.profileId = profileId
        self.token = token
        self.session = session
    }

    /// Com a sessão de pessoa do app.
    @MainActor
    static func current(_ container: AppContainer = .shared) -> ProfileAPI {
        let session = container.session
        return ProfileAPI(baseURL: session.serverURL?.absoluteString ?? "", profileId: container.profileId ?? "") { session.token }
    }

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        try QueueHTTP.decode(T.self, try await getData(path, query: query))
    }

    /// A resposta crua, para quem precisa ler um mapa com as chaves exatas (o decodificador converte snake_case).
    func getData(_ path: String, query: [String: String?] = [:]) async throws -> Data {
        try await QueueHTTP.send(session, QueueHTTP.request(try url(path, query), method: "GET", token: token()))
    }

    /// Dados do estabelecimento da área (`GET /establishment`): cabeçalho e rodapé dos cupons.
    func establishment() async throws -> Establishment { try await get("establishment") }

    /// Pessoas da área (`GET /people`), para escolher o responsável de um registro de módulo.
    func people() async throws -> [AreaPerson] { (try await get("people") as DataList<AreaPerson>).data ?? [] }

    /// Escrita com `Idempotency-Key`; `body` é um objeto JSON (chaves nulas omitidas).
    func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any?] = [:], key: String) async throws -> T {
        let clean = body.compactMapValues { $0 }
        let data = (try? JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys])) ?? Data("{}".utf8)
        let request = QueueHTTP.request(try url(path, [:]), method: method, token: token(), key: key, body: data)
        return try QueueHTTP.decode(T.self, try await QueueHTTP.send(session, request))
    }

    private func url(_ path: String, _ query: [String: String?]) throws -> URL {
        let p = profileId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profileId
        guard var components = URLComponents(string: base + "/api/v1/profiles/\(p)/" + path) else {
            throw QueueError(status: 0, code: "invalid_url", message: "Endereço do Wabotia inválido.")
        }
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }.sorted { $0.name < $1.name }
        if !items.isEmpty { components.queryItems = items }
        guard let url = components.url else { throw QueueError(status: 0, code: "invalid_url", message: "Endereço do Wabotia inválido.") }
        return url
    }
}

/// `{data: [...]}`.
struct DataList<T: Decodable>: Decodable {
    var data: [T]?
}

/// Nome fantasia, documento, endereço, telefone e rodapé da área (Gestão → Estabelecimento). Sem cadastro,
/// `configured` é falso e `name` é o nome da área.
struct Establishment: Codable, Equatable {
    var name: String?
    var document: String?
    var documentType: String?
    var documentDisplay: String?
    var address: String?
    var phone: String?
    var footer: String?
    var configured: Bool?

    /// As linhas do cabeçalho do cupom, depois do nome: documento, endereço (pode ter quebras) e telefone. O cupom do
    /// totem vai para desconhecidos: CPF (MEI ou autônomo que cadastrou o próprio) sai mascarado, `***.456.789-**`;
    /// CNPJ sai inteiro.
    var headerLines: [String] {
        var out: [String] = []
        if documentType == "cpf" {
            if let masked = Self.maskedCPF(documentDisplay ?? document) { out.append("CPF " + masked) }
        } else if let doc = documentDisplay?.trimmingCharacters(in: .whitespaces), !doc.isEmpty {
            out.append("CNPJ " + doc)
        }
        for line in (address ?? "").split(whereSeparator: \.isNewline) {
            let text = line.trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { out.append(text) }
        }
        if let phone = phone?.trimmingCharacters(in: .whitespaces), !phone.isEmpty { out.append(phone) }
        return out
    }

    /// Só os seis números do meio; sem 11 dígitos, nada (melhor sem documento do que com ele inteiro).
    static func maskedCPF(_ text: String?) -> String? {
        let digits = Array((text ?? "").filter { $0.isASCII && $0.isNumber })
        guard digits.count == 11 else { return nil }
        return "***.\(String(digits[3..<6])).\(String(digits[6..<9]))-**"
    }

    var footerLines: [String] {
        (footer ?? "").split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    var displayName: String? { name?.trimmingCharacters(in: .whitespaces).isEmpty == false ? name : nil }
}

/// Pessoa da área (`GET /people`): `id` é o valor de `assignee`.
struct AreaPerson: Codable, Equatable, Identifiable {
    var id: String
    var name: String?
    var role: String?
    var displayName: String { name?.isEmpty == false ? name! : "Pessoa" }
}

/// Uma `Idempotency-Key` por intenção (mobile/README.md): sem resposta (rede, 5xx), a mesma intenção repete com a mesma
/// chave até o servidor confirmar; sucesso ou recusa definitiva liberam a chave, e a próxima intenção ganha outra.
final class IntentKeys {
    private var pending: (signature: String, key: String)?

    func key(for signature: String) -> String {
        if let pending, pending.signature == signature { return pending.key }
        let key = QueueClient.newKey()
        pending = (signature, key)
        return key
    }

    /// Depois da resposta: só uma falha repetível guarda a chave.
    func settle(_ error: Error?) {
        if let error = error as? QueueError, error.retryable { return }
        if error != nil, !(error is QueueError) { return }
        pending = nil
    }

    var pendingKey: String? { pending?.key }
}

/// Dia e hora de Brasília: a agenda e a ordem de serviço guardam ms Unix e mostram o horário de Brasília, qualquer que
/// seja o fuso do aparelho.
enum BrasiliaTime {
    static let zone = TimeZone(identifier: "America/Sao_Paulo")!

    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        c.locale = Locale(identifier: "pt_BR")
        c.firstWeekday = 2
        return c
    }()

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = zone
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = format
        return f
    }

    private static let dayFormatter = formatter("yyyy-MM-dd")
    private static let clockFormatter = formatter("HH:mm")
    private static let shortFormatter = formatter("dd/MM/yyyy")
    private static let shortTimeFormatter = formatter("dd/MM/yyyy HH:mm")
    private static let longFormatter = formatter("EEEE, d 'de' MMMM")
    private static let compactFormatter = formatter("EEE d/MM")

    static func date(_ millis: Int64) -> Date { Date(timeIntervalSince1970: TimeInterval(millis) / 1000) }
    static func millis(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

    /// "2026-11-22" do instante, em Brasília.
    static func day(_ date: Date) -> String { dayFormatter.string(from: date) }
    static func day(_ millis: Int64) -> String { day(date(millis)) }
    static func today(_ now: Date = Date()) -> String { day(now) }

    /// Meia-noite de Brasília do dia "AAAA-MM-DD".
    static func start(of day: String) -> Date? { dayFormatter.date(from: day).map { calendar.startOfDay(for: $0) } }

    static func addDays(_ day: String, _ n: Int) -> String {
        guard let d = start(of: day), let next = calendar.date(byAdding: .day, value: n, to: d) else { return day }
        return self.day(next)
    }

    /// `[início, fim)` em ms dos dias `day` a `day + days - 1`.
    static func range(from day: String, days: Int = 1) -> (from: Int64, to: Int64)? {
        guard let s = start(of: day), let e = calendar.date(byAdding: .day, value: days, to: s) else { return nil }
        return (millis(s), millis(e))
    }

    /// A segunda-feira da semana do dia.
    static func weekStart(_ day: String) -> String {
        guard let d = start(of: day) else { return day }
        let weekday = calendar.component(.weekday, from: d) // 1 = domingo
        return addDays(day, -((weekday + 5) % 7))
    }

    static func clock(_ millis: Int64) -> String { clockFormatter.string(from: date(millis)) }
    static func short(_ millis: Int64) -> String { shortFormatter.string(from: date(millis)) }
    static func shortWithTime(_ millis: Int64) -> String { shortTimeFormatter.string(from: date(millis)) }

    /// "Sábado, 22 de novembro" (com "Hoje"/"Amanhã" quando cabe).
    static func title(_ day: String, now: Date = Date()) -> String {
        guard let d = start(of: day) else { return day }
        let text = longFormatter.string(from: d)
        let capitalized = text.prefix(1).uppercased() + text.dropFirst()
        if day == today(now) { return "Hoje · " + capitalized }
        if day == addDays(today(now), 1) { return "Amanhã · " + capitalized }
        return capitalized
    }

    /// "sáb 22/11".
    static func compact(_ day: String) -> String { start(of: day).map { compactFormatter.string(from: $0) } ?? day }
}

/// Telefone para mostrar: "5520906543210" → "(20) 90654-3210"; fora do Brasil, "+" e os dígitos.
enum PhoneText {
    static func display(_ value: String?) -> String? {
        guard let d = value?.filter(\.isNumber), !d.isEmpty else { return nil }
        guard d.hasPrefix("55"), d.count >= 12 else { return "+" + d }
        let local = d.dropFirst(2), ddd = local.prefix(2), rest = local.dropFirst(2)
        return "(\(ddd)) \(rest.prefix(rest.count - 4))-\(rest.suffix(4))"
    }
}

/// Dinheiro em centavos.
enum Money {
    /// "R$ 1.234,56".
    static func format(_ cents: Int) -> String {
        let negative = cents < 0
        let abs = Swift.abs(cents)
        var reais = String(abs / 100)
        var grouped = ""
        while reais.count > 3 {
            grouped = "." + reais.suffix(3) + grouped
            reais.removeLast(3)
        }
        return "\(negative ? "-" : "")R$ \(reais)\(grouped),\(String(format: "%02d", abs % 100))"
    }

    /// "45", "45,9", "1.234,56", "R$ 12,00" → centavos; `nil` quando não é valor.
    static func parse(_ text: String) -> Int? {
        var t = text.replacingOccurrences(of: "R$", with: "").trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        t = t.replacingOccurrences(of: ".", with: "")
        let parts = t.split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count <= 2, let reais = Int(parts[0].isEmpty ? "0" : String(parts[0])), reais >= 0 else { return nil }
        var cents = 0
        if parts.count == 2 {
            let frac = String(parts[1])
            guard frac.count <= 2, frac.allSatisfy(\.isNumber) else { return nil }
            cents = Int(frac.padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0
        }
        return reais * 100 + cents
    }
}

/// Atualização por eventos (`GET /events`, já consultado pelo Workspace a cada 4 s): a tela recarrega quando chega um
/// evento do módulo (`agenda.*`, `os.*`), com uma pausa curta para juntar uma rajada numa leitura só.
@MainActor
final class ModuleEvents {
    private var subscription: AnyCancellable?
    private var pending: Task<Void, Never>?

    init(prefix: String, publisher: AnyPublisher<[Event], Never> = Workspace.shared.events.eraseToAnyPublisher(), reload: @escaping @MainActor () async -> Void) {
        subscription = publisher.sink { [weak self] list in
            guard list.contains(where: { $0.kind.hasPrefix(prefix) }) else { return }
            Task { @MainActor in
                guard let self else { return }
                self.pending?.cancel()
                self.pending = Task {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                    await reload()
                }
            }
        }
    }
}
