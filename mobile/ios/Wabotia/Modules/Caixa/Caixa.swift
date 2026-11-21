import SwiftUI

/*
 * Caixa simples do app: o controle de caixa do Financeiro do servidor (`erp/v1/financeiro/controle-caixa` e as ações
 * `session_*`, o mesmo do painel e da frente de caixa). Abrir com o troco, lançar entradas (suprimento) e saídas
 * (sangria) com a forma de pagamento e a descrição na observação, e fechar informando o que foi conferido por forma.
 * Mesmo desenho do Android (`modules/caixa/CaixaClient.kt`).
 */

struct CashAccount: Decodable, Equatable, Identifiable {
    let id: String
    var name: String = ""
    var kind: String? = nil
    var active: Bool? = true
}

struct CashMethod: Decodable, Equatable {
    let id: String
    var description: String = ""
    var paymentType: String? = nil
}

struct CashMove: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    var postedOn: String? = nil
    var note: String? = nil
    var amountCents: String = "0"

    var isEntry: Bool { kind == "supply" }
    var cents: Int { Int(amountCents) ?? 0 }
}

struct CashSession: Decodable, Equatable {
    let id: String
    let accountId: String
    var accountName: String = ""
    var operatorName: String = ""
    var changeCents: String = "0"
    var state: String = "open"
    var supplyCents: String = "0"
    var withdrawalCents: String = "0"
    var informedCents: String = "0"
    var version: Int = 1
    var moves: [CashMove]? = nil

    var isOpen: Bool { state == "open" }
    var change: Int { Int(changeCents) ?? 0 }
    var entries: Int { Int(supplyCents) ?? 0 }
    var exits: Int { Int(withdrawalCents) ?? 0 }
    var moveList: [CashMove] { moves ?? [] }
}

private struct CashAccountList: Decodable { var items: [CashAccount]? }
private struct CashMethodList: Decodable { var methods: [CashMethod]? }
private struct CashSessionPage: Decodable { var items: [CashSession]? }
private struct CashSessionEnvelope: Decodable { let record: CashSession }

/// Regras do caixa simples, sem rede: textos, somas por forma e o que vai no fechamento.
enum CashRules {
    /// Formas usadas quando o servidor não lista as dele (parte Vendas desligada): só para a observação.
    static let fallbackMethods = ["Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito"]
    static let noteLimit = 240
    private static let separator = " · "

    /// O ERP pede `command_id` UUID: o mesmo vale de `Idempotency-Key`.
    static func newKey() -> String { UUID().uuidString.lowercased() }

    /// Observação do lançamento: "Pix · Corte e barba".
    static func note(_ method: String, _ description: String) -> String {
        let m = method.trimmingCharacters(in: .whitespaces)
        let d = String(description.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : Character($0) }).trimmingCharacters(in: .whitespaces)
        return String((d.isEmpty ? m : m + separator + d).prefix(noteLimit))
    }

    static func methodOf(_ note: String?, known: [String]) -> String? {
        guard let note, let head = note.components(separatedBy: separator).first?.trimmingCharacters(in: .whitespaces) else { return nil }
        return known.first { $0.caseInsensitiveCompare(head) == .orderedSame }
    }

    static func descriptionOf(_ note: String?, known: [String]) -> String {
        let text = note ?? ""
        guard methodOf(text, known: known) != nil, let range = text.range(of: separator) else { return text.trimmingCharacters(in: .whitespaces) }
        return String(text[range.upperBound...]).trimmingCharacters(in: .whitespaces)
    }

    static func isCash(_ m: CashMethod) -> Bool { m.paymentType == "01" || m.description.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("Dinheiro") == .orderedSame }

    private static func cashName(_ known: [String]) -> String { known.first { $0.caseInsensitiveCompare("Dinheiro") == .orderedSame } ?? "Dinheiro" }

    /// Entradas menos saídas por forma, na ordem das formas; lançamento sem forma conhecida conta como dinheiro.
    static func totalsByMethod(_ moves: [CashMove], known: [String]) -> [(name: String, cents: Int)] {
        let cash = cashName(known)
        var sums: [String: Int] = [:]
        for move in moves {
            let method = methodOf(move.note, known: known) ?? cash
            sums[method, default: 0] += move.isEntry ? move.cents : -move.cents
        }
        let order = known + sums.keys.filter { !known.contains($0) }.sorted()
        return order.compactMap { name in sums[name].flatMap { $0 != 0 ? (name, $0) : nil } }
    }

    /// Dinheiro esperado na gaveta: troco + entradas em dinheiro − saídas em dinheiro.
    static func expectedDrawer(_ session: CashSession, known: [String]) -> Int {
        let cash = cashName(known)
        return session.change + session.moveList.filter { (methodOf($0.note, known: known) ?? cash) == cash }.reduce(0) { $0 + ($1.isEntry ? $1.cents : -$1.cents) }
    }

    /// Valores informados no fechamento: o contado na forma dinheiro e, nas outras, a soma dos lançamentos.
    static func closingValues(_ methods: [CashMethod], session: CashSession, counted: Int) -> [(id: String, cents: Int)] {
        guard !methods.isEmpty else { return [] }
        let totals = Dictionary(totalsByMethod(session.moveList, known: methods.map(\.description)).map { ($0.name, $0.cents) }, uniquingKeysWith: +)
        var seen = Set<String>()
        var out: [(id: String, cents: Int)] = []
        for m in methods {
            let value = isCash(m) ? counted : (totals[m.description] ?? 0)
            if value > 0, seen.insert(m.id).inserted { out.append((m.id, value)) }
        }
        return Array(out.prefix(50))
    }

    static func difference(expected: Int, counted: Int) -> String {
        if counted == expected { return "Confere com o esperado" }
        return counted > expected ? "Sobrou \(Money.format(counted - expected))" : "Faltou \(Money.format(expected - counted))"
    }

    /// Mensagens das recusas do controle de caixa, ditas para quem está no balcão.
    static func message(_ error: Error) -> String {
        guard let e = error as? QueueError else { return QueueError.describe(error) }
        if e.status == 409 && e.code == "module_disabled" { return "O caixa usa a parte Financeiro do ERP, que está desligada. Um administrador liga em Gestão → Módulos, no painel." }
        if e.code.contains("cash_session_open") { return "Você já tem um caixa aberto nesta conta. Feche o caixa aberto antes de abrir outro." }
        if e.code.contains("cash_session_state") { return "Este caixa já foi fechado. Puxe para atualizar." }
        if e.code.contains("version_conflict") || e.code == "ERP_CONFLICT" { return "O caixa mudou em outro aparelho. Puxe para atualizar e lance de novo." }
        if e.status == 403 || e.code == "ERP_FORBIDDEN" { return "Seu papel não mexe no caixa. Peça ao administrador o papel Financeiro em Gestão → Pessoas e acessos." }
        if e.code.contains("invalid_account") { return "Escolha uma conta do tipo Caixa." }
        if e.status == 0 { return "Sem conexão com o Vinki. O caixa não foi alterado; tente de novo quando a conexão voltar." }
        return e.message
    }
}

final class CaixaClient {
    let api: ProfileAPI
    init(api: ProfileAPI) { self.api = api }

    func accounts() async throws -> [CashAccount] {
        let list: CashAccountList = try await api.get("erp/v1/financeiro/accounts", query: ["limit": "100"])
        return (list.items ?? []).filter { $0.active != false && $0.kind == "cash" }
    }

    /// Formas de pagamento cadastradas; vazio quando a rota não responde (parte Vendas desligada, servidor antigo).
    func methods() async throws -> [CashMethod] {
        do {
            let list: CashMethodList = try await api.get("erp/v1/documentos/sales_orders/pagamento")
            return list.methods ?? []
        } catch let e as QueueError where e.unauthorized {
            throw e
        } catch {
            return []
        }
    }

    func openSession() async throws -> CashSession? {
        let page: CashSessionPage = try await api.get("erp/v1/financeiro/controle-caixa", query: ["state": "open", "limit": "10"])
        guard let first = page.items?.first else { return nil }
        return try await session(first.id)
    }

    func session(_ id: String) async throws -> CashSession {
        let envelope: CashSessionEnvelope = try await api.get("erp/v1/financeiro/controle-caixa/\(id)")
        return envelope.record
    }

    private func action(_ name: String, _ data: [String: Any?], key: String) async throws -> CashSession {
        let envelope: CashSessionEnvelope = try await api.send("POST", "erp/v1/financeiro/actions/\(name)", ["command_id": key, "data": data.compactMapValues { $0 }], key: key)
        return envelope.record
    }

    func open(accountId: String, changeCents: Int, key: String = CashRules.newKey()) async throws -> CashSession {
        try await action("session_open", ["account_id": accountId, "change_cents": String(changeCents)], key: key)
    }

    func move(_ session: CashSession, entry: Bool, cents: Int, note: String, day: String, key: String = CashRules.newKey()) async throws -> CashSession {
        try await action("session_move", [
            "id": session.id, "expected_version": session.version, "kind": entry ? "supply" : "withdrawal",
            "posted_on": day, "amount_cents": String(cents), "note": note.isEmpty ? nil : note,
        ], key: key)
    }

    func close(_ session: CashSession, values: [(id: String, cents: Int)], key: String = CashRules.newKey()) async throws -> CashSession {
        try await action("session_close", [
            "id": session.id, "expected_version": session.version,
            "values": values.map { ["payment_method_id": $0.id, "amount_cents": String($0.cents)] },
        ], key: key)
    }
}

@MainActor
final class CaixaViewModel: ObservableObject {
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var accounts: [CashAccount] = []
    @Published private(set) var methods: [CashMethod] = []
    @Published private(set) var session: CashSession?
    @Published private(set) var closed: CashSession?
    @Published private(set) var busy = false
    @Published var notice: String?

    private let client: CaixaClient
    private let onFailure: (QueueError) -> Void
    private var pending: (signature: String, key: String)?

    init(client: CaixaClient, onFailure: @escaping (QueueError) -> Void = { _ in }) {
        self.client = client
        self.onFailure = onFailure
    }

    convenience init() { self.init(client: CaixaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.erpFinance)) }

    var methodNames: [String] {
        let names = methods.map(\.description).filter { !$0.isEmpty }
        return names.isEmpty ? CashRules.fallbackMethods : names
    }

    func load() async {
        loading = session == nil && closed == nil
        do {
            accounts = try await client.accounts()
            methods = try await client.methods()
            session = try await client.openSession()
            error = nil
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            self.error = CashRules.message(error)
        }
        loading = false
    }

    private func key(_ signature: String) -> String {
        if let pending, pending.signature == signature { return pending.key }
        let k = CashRules.newKey()
        pending = (signature, k)
        return k
    }

    private func run(_ signature: String, _ block: (String) async throws -> CashSession) async -> CashSession? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        let k = key(signature)
        do {
            let result = try await block(k)
            pending = nil
            notice = nil
            return result
        } catch {
            let retry = (error as? QueueError)?.retryable == true
            if !retry { pending = nil }
            if let e = error as? QueueError { onFailure(e) }
            notice = CashRules.message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
            return nil
        }
    }

    func open(accountId: String, change: Int) async {
        if let s = await run("open:\(accountId):\(change)", { try await client.open(accountId: accountId, changeCents: change, key: $0) }) {
            session = s
            closed = nil
        }
    }

    @discardableResult
    func move(entry: Bool, cents: Int, method: String, description: String) async -> Bool {
        guard let current = session else { return false }
        let note = CashRules.note(method, description)
        guard let s = await run("move:\(current.id):\(current.version):\(entry):\(cents):\(note)", { try await client.move(current, entry: entry, cents: cents, note: note, day: BrasiliaTime.today(), key: $0) }) else { return false }
        session = s
        return true
    }

    @discardableResult
    func close(counted: Int) async -> Bool {
        guard let current = session else { return false }
        let values = CashRules.closingValues(methods, session: current, counted: counted)
        guard let s = await run("close:\(current.id):\(current.version):\(counted)", { try await client.close(current, values: values, key: $0) }) else { return false }
        closed = s
        session = nil
        return true
    }
}

/// Caixa simples: abrir com troco, lançar entradas e saídas, fechar com conferência.
struct CaixaView: View {
    @StateObject private var vm: CaixaViewModel
    @State private var moveKind: Bool?
    @State private var closing = false

    init() { _vm = StateObject(wrappedValue: CaixaViewModel()) }
    init(viewModel: CaixaViewModel) { _vm = StateObject(wrappedValue: viewModel) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if vm.loading {
                    SkeletonList(rows: 4, avatar: false)
                } else if let error = vm.error, vm.session == nil {
                    InlineError(text: error) { Task { await vm.load() } }
                } else {
                    if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                    if let session = vm.session {
                        summary(session)
                        PrimaryButton(title: "Lançar entrada", icon: "plus.circle.fill", disabled: vm.busy) { moveKind = true }
                            .accessibilityIdentifier("caixa.entry")
                        SecondaryButton(title: "Lançar saída", icon: "minus.circle.fill", disabled: vm.busy) { moveKind = false }
                            .accessibilityIdentifier("caixa.exit")
                        SecondaryButton(title: "Fechar caixa", icon: "lock.fill", color: Theme.danger, disabled: vm.busy) { closing = true }
                            .accessibilityIdentifier("caixa.close")
                        moves(session)
                    } else {
                        if let last = vm.closed { closedSummary(last) }
                        CaixaOpenCard(vm: vm)
                    }
                    OpenInBrowserRow(path: WebPanel.cash, subtitle: "Sangria, reabrir, conferido e outros caixas ficam no controle de caixa do painel")
                }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Caixa")
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .sheet(isPresented: Binding(get: { moveKind != nil }, set: { if !$0 { moveKind = nil } })) {
            CaixaMoveSheet(vm: vm, entry: moveKind ?? true) { moveKind = nil }
        }
        .sheet(isPresented: $closing) {
            if let session = vm.session { CaixaCloseSheet(vm: vm, session: session) { closing = false } }
        }
    }

    private func line(_ label: String, _ value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label).font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
            Spacer()
            Text(value).font(Theme.font(14, bold ? .semibold : .regular)).foregroundStyle(Theme.textPrimary)
        }
    }

    private func summary(_ s: CashSession) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Aberto · \(s.accountName)").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
            line("Troco inicial", Money.format(s.change))
            line("Entradas", "+ " + Money.format(s.entries))
            line("Saídas", "− " + Money.format(s.exits))
            line("Dinheiro esperado na gaveta", Money.format(CashRules.expectedDrawer(s, known: vm.methodNames)), bold: true)
            let byMethod = CashRules.totalsByMethod(s.moveList, known: vm.methodNames)
            if !byMethod.isEmpty {
                Text("Por forma de pagamento").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).padding(.top, 4)
                ForEach(byMethod, id: \.name) { item in line(item.name, Money.format(item.cents)) }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
    }

    private func closedSummary(_ s: CashSession) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Caixa fechado").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
            line("Troco inicial", Money.format(s.change))
            line("Entradas", "+ " + Money.format(s.entries))
            line("Saídas", "− " + Money.format(s.exits))
            line("Informado no fechamento", Money.format(Int(s.informedCents) ?? 0), bold: true)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.ok.opacity(0.12)))
    }

    private func moves(_ s: CashSession) -> some View {
        SectionCard(title: "Lançamentos de hoje") {
            if s.moveList.isEmpty {
                CardRow(title: "Nenhum lançamento ainda.", divider: false)
            } else {
                ForEach(Array(s.moveList.reversed().enumerated()), id: \.element.id) { index, move in
                    let desc = CashRules.descriptionOf(move.note, known: vm.methodNames)
                    CardRow(
                        title: desc.isEmpty ? (move.isEntry ? "Entrada" : "Saída") : desc,
                        subtitle: CashRules.methodOf(move.note, known: vm.methodNames) ?? "Dinheiro",
                        value: (move.isEntry ? "+ " : "− ") + Money.format(move.cents),
                        divider: index < s.moveList.count - 1
                    )
                }
            }
        }
    }
}

private struct CaixaOpenCard: View {
    @ObservedObject var vm: CaixaViewModel
    @State private var change = ""
    @State private var account: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Abrir o caixa").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
            if vm.accounts.isEmpty {
                Text("Nenhuma conta do tipo Caixa cadastrada. Cadastre uma em Financeiro → Contas, no painel, e puxe para atualizar.")
                    .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            } else {
                if vm.accounts.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack { ForEach(vm.accounts) { a in FilterChip(title: a.name, selected: (account ?? vm.accounts.first?.id) == a.id) { account = a.id } } }
                    }
                }
                AuthField(label: "Troco inicial (R$)") {
                    TextField("0,00", text: $change).keyboardType(.decimalPad).accessibilityIdentifier("caixa.change")
                }
                let cents = change.trimmingCharacters(in: .whitespaces).isEmpty ? 0 : Money.parse(change)
                if cents == nil { Text("Digite o valor como 50 ou 50,00.").font(Theme.font(12)).foregroundStyle(Theme.danger) }
                PrimaryButton(title: "Abrir caixa", icon: "banknote.fill", busy: vm.busy, disabled: cents == nil) {
                    guard let id = account ?? vm.accounts.first?.id, let cents else { return }
                    Task { await vm.open(accountId: id, change: cents) }
                }
                .accessibilityIdentifier("caixa.open")
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
    }
}

private struct CaixaMoveSheet: View {
    @ObservedObject var vm: CaixaViewModel
    let entry: Bool
    let dismiss: () -> Void
    @State private var value = ""
    @State private var method = ""
    @State private var description = ""

    var body: some View {
        NavigationView {
            Form {
                TextField("Valor (R$)", text: $value).keyboardType(.decimalPad).accessibilityIdentifier("caixa.value")
                Picker("Forma de pagamento", selection: $method) { ForEach(vm.methodNames, id: \.self) { Text($0).tag($0) } }
                TextField(entry ? "Descrição (ex.: corte e barba)" : "Descrição (ex.: compra de lâminas)", text: $description)
                    .accessibilityIdentifier("caixa.description")
                if let notice = vm.notice { Text(notice).font(Theme.font(13)).foregroundStyle(Theme.danger) }
            }
            .navigationTitle(entry ? "Lançar entrada" : "Lançar saída")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Voltar", action: dismiss) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(vm.busy ? "Lançando…" : "Lançar") {
                        guard let cents = Money.parse(value), cents > 0 else { return }
                        Task { if await vm.move(entry: entry, cents: cents, method: method.isEmpty ? vm.methodNames[0] : method, description: description) { dismiss() } }
                    }
                    .disabled(vm.busy || (Money.parse(value) ?? 0) <= 0)
                }
            }
            .onAppear { if method.isEmpty { method = vm.methodNames.first ?? "Dinheiro" } }
        }
    }
}

private struct CaixaCloseSheet: View {
    @ObservedObject var vm: CaixaViewModel
    let session: CashSession
    let dismiss: () -> Void
    @State private var counted = ""

    var body: some View {
        let expected = CashRules.expectedDrawer(session, known: vm.methodNames)
        let cents = Money.parse(counted)
        NavigationView {
            Form {
                Section(footer: Text("Conte o dinheiro da gaveta. Esperado: \(Money.format(expected)).")) {
                    TextField("Dinheiro contado (R$)", text: $counted).keyboardType(.decimalPad).accessibilityIdentifier("caixa.counted")
                    if let cents { Text(CashRules.difference(expected: expected, counted: cents)).foregroundStyle(cents == expected ? Theme.ok : Theme.warn) }
                }
                let others = CashRules.totalsByMethod(session.moveList, known: vm.methodNames).filter { $0.name.caseInsensitiveCompare("Dinheiro") != .orderedSame }
                if !others.isEmpty {
                    Section(header: Text("Outras formas")) { ForEach(others, id: \.name) { Text("\($0.name): \(Money.format($0.cents))") } }
                }
                if vm.methods.isEmpty { Text("As formas de pagamento não vieram do servidor: a conferência por forma fica no painel.").font(Theme.font(13)) }
                if let notice = vm.notice { Text(notice).font(Theme.font(13)).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("Fechar o caixa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Voltar", action: dismiss) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(vm.busy ? "Fechando…" : "Fechar caixa") {
                        guard let cents else { return }
                        Task { if await vm.close(counted: cents) { dismiss() } }
                    }
                    .disabled(vm.busy || cents == nil)
                }
            }
            .onAppear { if counted.isEmpty { counted = Money.format(max(expected, 0)).replacingOccurrences(of: "R$", with: "").trimmingCharacters(in: .whitespaces) } }
        }
    }
}
