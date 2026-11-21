import Foundation

/// As dependências das telas da Gestão (trocáveis nos testes).
struct ErpDeps {
    var client: ErpClient
    /// 401 volta ao login; `module_disabled` esconde a parte na hora.
    var onFailure: (_ part: String, _ error: QueueError) -> Void
    var now: () -> Date = { Date() }

    @MainActor
    static func current(_ container: AppContainer = .shared) -> ErpDeps {
        let profile = container.profileId ?? ""
        return ErpDeps(client: .current(container)) { part, error in
            if error.unauthorized { container.handleUnauthorized() }
            if error.moduleDisabled { ModuleFeature.shared.markDisabled(part, profile: profile) }
        }
    }

    func fail(_ part: String, _ error: Error) -> String {
        if let e = error as? QueueError { onFailure(part, e) }
        return ErpText.message(error, part: part)
    }

    /// Mensagem de uma escrita: sem conexão nada é guardado para depois.
    func failWrite(_ part: String, _ error: Error) -> String {
        if let e = error as? QueueError { onFailure(part, e) }
        if ErpText.isOffline(error) { return ErpText.offlineWrite + ((error as? QueueError)?.retryable == true ? " Toque de novo para repetir com segurança." : "") }
        return ErpText.message(error, part: part)
    }

    var today: String { BrasiliaTime.today(now()) }
}

// MARK: - Clientes

@MainActor
final class ErpCustomersViewModel: ObservableObject {
    @Published private(set) var items: [ErpContactItem] = []
    @Published private(set) var total = 0
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var offlineAt: Int64?
    private(set) var query = ""
    private var page = 1
    private var task: Task<Void, Never>?
    let deps: ErpDeps

    init(deps: ErpDeps) { self.deps = deps }

    func search(_ text: String) {
        query = text
        task?.cancel()
        task = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await load(1)
        }
    }

    func refresh() async { await load(1) }

    func loadMore() async {
        guard !loading, items.count < total, offlineAt == nil else { return }
        await load(page + 1)
    }

    private func load(_ next: Int) async {
        loading = true
        defer { loading = false }
        do {
            let read = try await deps.client.customers(query, page: next)
            page = next
            items = next == 1 ? read.value.items : items + read.value.items.filter { item in !items.contains { $0.id == item.id } }
            total = read.value.total
            offlineAt = read.offlineAt
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = deps.fail(ErpParts.customers, error)
        }
    }
}

@MainActor
final class ErpCustomerViewModel: ObservableObject {
    @Published private(set) var record: ErpContactRecord?
    @Published private(set) var orders: [ErpSaleHistoryItem]?
    @Published private(set) var ordersNote: String?
    @Published private(set) var bills: [ErpTitle]?
    @Published private(set) var billsNote: String?
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var offlineAt: Int64?
    let id: String
    let access: ErpAccess?
    let deps: ErpDeps

    init(id: String, access: ErpAccess?, deps: ErpDeps) { self.id = id; self.access = access; self.deps = deps }

    func refresh() async {
        loading = true
        do {
            let read = try await deps.client.customer(id)
            record = read.value.record
            offlineAt = read.offlineAt
            error = nil
        } catch {
            self.error = deps.fail(ErpParts.customers, error)
        }
        loading = false
        guard let customer = record else { return }
        if access?.customerOrders == true {
            do {
                let read = try await deps.client.customerOrders(id)
                orders = read.value.items ?? []
                ordersNote = read.value.visible == false ? "Os pedidos deste cliente não aparecem para o seu papel no ERP." : nil
                if offlineAt == nil { offlineAt = read.offlineAt }
            } catch { ordersNote = deps.fail(ErpParts.sales, error) }
        }
        if access?.customerBills == true {
            do {
                bills = try await deps.client.customerBills(id, name: customer.name).value
                billsNote = nil
            } catch { billsNote = deps.fail(ErpParts.finance, error) }
        }
    }
}

@MainActor
final class ErpNewCustomerViewModel: ObservableObject {
    @Published var name = ""
    @Published var personType = "F"
    @Published var document = ""
    @Published var mobile = ""
    @Published var email = ""
    @Published private(set) var saving = false
    @Published var error: String?
    @Published private(set) var created: ErpContactRecord?
    private let keys = IntentKeys()
    let deps: ErpDeps

    init(deps: ErpDeps) { self.deps = deps }

    /// O corpo enviado, ou a mensagem do que falta.
    func body(key: String) -> Result<[String: Any?], ErpInputError> {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return .failure(.init("Informe o nome do cliente.")) }
        if n.count > 200 { return .failure(.init("O nome pode ter até 200 letras.")) }
        let mail = email.trimmingCharacters(in: .whitespaces)
        if !mail.isEmpty, mail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) == nil { return .failure(.init("Confira o e-mail ou deixe em branco.")) }
        let doc = document.filter { $0.isLetter || $0.isNumber }.uppercased()
        if !doc.isEmpty, personType == "F", doc.count != 11 { return .failure(.init("O CPF tem 11 números. Confira ou deixe em branco.")) }
        if !doc.isEmpty, personType == "J", doc.count != 14 { return .failure(.init("O CNPJ tem 14 caracteres. Confira ou deixe em branco.")) }
        let phone = mobile.trimmingCharacters(in: .whitespaces)
        if !phone.isEmpty, phone.filter(\.isNumber).count < 10 { return .failure(.init("Informe o celular com DDD.")) }
        return .success(ErpBodies.quickContact(key: key, name: n, personType: personType, document: doc.isEmpty ? nil : doc, mobile: phone.isEmpty ? nil : phone, email: mail.isEmpty ? nil : mail))
    }

    func save() async {
        guard !saving else { return }
        let key = keys.key(for: [name, personType, document, mobile, email].joined(separator: "|"))
        switch body(key: key) {
        case .failure(let problem): error = problem.message
        case .success(let request):
            saving = true
            error = nil
            do {
                created = try await deps.client.createCustomer(request, key: key).record
                keys.settle(nil)
            } catch {
                keys.settle(error)
                self.error = deps.failWrite(ErpParts.customers, error)
            }
            saving = false
        }
    }
}

/// O que falta preencher (mensagem para a tela).
struct ErpInputError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

// MARK: - Produtos e estoque

@MainActor
final class ErpProductsViewModel: ObservableObject {
    @Published private(set) var items: [ErpProduct] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published var notice: String?
    @Published private(set) var offlineAt: Int64?
    /// O produto achado pelo código de barras, para a tela abrir a ficha.
    @Published var scanned: ErpProduct?
    @Published private(set) var query = ""
    private var task: Task<Void, Never>?
    let deps: ErpDeps

    init(deps: ErpDeps) { self.deps = deps }

    func search(_ text: String) {
        query = text
        task?.cancel()
        task = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    func refresh() async { await load() }

    /// Código lido pela câmera: busca e, achando exatamente um, abre a ficha.
    func scan(_ code: String?) async {
        guard let value = ErpText.barcode(code) else { notice = "Não achei código de barras. Aproxime o código, com boa luz, e tente de novo."; return }
        task?.cancel()
        query = value
        await load()
        if let exact = ErpText.exactBarcode(items, value) ?? (items.count == 1 ? items.first : nil) { scanned = exact }
        else if error == nil { notice = "Nenhum produto ativo com o código \(value). Confira no painel se o GTIN está cadastrado." }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let read = try await deps.client.products(query)
            items = read.value.items ?? []
            offlineAt = read.offlineAt
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = deps.fail(ErpParts.products, error)
        }
    }
}

@MainActor
final class ErpProductViewModel: ObservableObject {
    @Published private(set) var product: ErpProduct?
    @Published private(set) var balances: [ErpStockBalance]?
    @Published private(set) var stockNote: String?
    @Published private(set) var photo: Data?
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var offlineAt: Int64?
    @Published private(set) var saving = false
    @Published var adjustError: String?
    @Published var done: String?
    private let keys = IntentKeys()
    let id: String
    let access: ErpAccess?
    let deps: ErpDeps

    init(id: String, access: ErpAccess?, deps: ErpDeps) { self.id = id; self.access = access; self.deps = deps }

    func refresh() async {
        loading = true
        do {
            let read = try await deps.client.product(id)
            product = read.value.record
            offlineAt = read.offlineAt
            error = nil
        } catch {
            self.error = deps.fail(ErpParts.products, error)
        }
        loading = false
        guard product != nil else { return }
        if access?.stock == true { await loadStock() }
        if photo == nil, offlineAt == nil { photo = try? await deps.client.productPhoto(id) }
    }

    private func loadStock() async {
        do {
            let read = try await deps.client.stock(id)
            balances = (read.value.items ?? []).filter { $0.isActive || ErpNumbers.decimal($0.quantity) != 0 }
            stockNote = nil
            if offlineAt == nil { offlineAt = read.offlineAt }
        } catch {
            stockNote = deps.fail(ErpParts.stock, error)
        }
    }

    /// O corpo do ajuste, ou a mensagem do que falta.
    func adjustBody(key: String, direction: ErpStockDirection, balance: ErpStockBalance, quantity text: String, reason: String) -> Result<[String: Any?], ErpInputError> {
        guard let quantity = ErpNumbers.quantity(text) else { return .failure(.init("Informe a quantidade, maior que zero (até 6 casas decimais).")) }
        let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if why.count < 3 { return .failure(.init("Diga o motivo do ajuste (pelo menos 3 letras), por exemplo \"Contagem\" ou \"Avaria\".")) }
        if why.count > 500 { return .failure(.init("O motivo pode ter até 500 letras.")) }
        if balance.isVirtual { return .failure(.init("Este depósito mostra saldo virtual de composição: ajuste os componentes pelo painel.")) }
        return .success(ErpBodies.stockMovement(key: key, direction: direction, day: deps.today, reason: why, productId: id, warehouseId: balance.warehouseId,
                                                quantity: quantity, version: balance.version ?? 0))
    }

    /// `true` quando o ajuste foi lançado.
    func adjust(_ direction: ErpStockDirection, _ balance: ErpStockBalance, quantity: String, reason: String) async -> Bool {
        guard !saving else { return false }
        if offlineAt != nil { adjustError = ErpText.offlineWrite; return false }
        let key = keys.key(for: [direction.rawValue, balance.warehouseId, String(balance.version ?? 0), quantity, reason].joined(separator: "|"))
        switch adjustBody(key: key, direction: direction, balance: balance, quantity: quantity, reason: reason) {
        case .failure(let problem):
            adjustError = problem.message
            return false
        case .success(let body):
            saving = true
            adjustError = nil
            defer { saving = false }
            do {
                try await deps.client.moveStock(body, key: key)
                keys.settle(nil)
                done = "\(direction.label) lançada em \(balance.name)."
                await loadStock()
                return true
            } catch {
                keys.settle(error)
                adjustError = deps.failWrite(ErpParts.stock, error)
                if (error as? QueueError)?.status == 409 { await loadStock() }
                return false
            }
        }
    }
}

// MARK: - Pedido rápido

@MainActor
final class ErpQuickOrderViewModel: ObservableObject {
    @Published var customer: ErpContactItem?
    @Published private(set) var customerResults: [ErpContactItem] = []
    @Published private(set) var productResults: [ErpProduct] = []
    @Published private(set) var searching = false
    @Published private(set) var lines: [ErpCartLine] = []
    @Published var discountText = ""
    @Published var discountPercent = false
    @Published private(set) var methods: [ErpPaymentMethod] = []
    @Published var methodId: String?
    @Published private(set) var methodsNote: String?
    @Published private(set) var saving = false
    @Published var error: String?
    @Published var notice: String?
    @Published private(set) var saved: ErpSavedDocument?
    @Published private(set) var savedTotal = 0
    @Published private(set) var preview: ErpSendPreview?
    @Published private(set) var sending = false
    @Published private(set) var sent: String?
    private let keys = IntentKeys()
    private let sendKeys = IntentKeys()
    private var customerTask: Task<Void, Never>?
    private var productTask: Task<Void, Never>?
    let deps: ErpDeps

    init(deps: ErpDeps) { self.deps = deps }

    func start() async {
        guard methods.isEmpty else { return }
        do {
            let list = try await deps.client.paymentOptions().value.methods ?? []
            methods = list
            if methodId == nil { methodId = (list.first { $0.isDefault == true } ?? list.first)?.id }
            methodsNote = list.isEmpty ? "Nenhuma forma de pagamento cadastrada. O pedido sai sem parcela; cadastre as formas no painel." : nil
        } catch {
            methodsNote = deps.fail(ErpParts.sales, error)
        }
    }

    func searchCustomer(_ text: String) {
        customerTask?.cancel()
        guard text.trimmingCharacters(in: .whitespaces).count >= 2 else { customerResults = []; return }
        customerTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            do { customerResults = Array(try await deps.client.customers(text).value.items.prefix(20)) }
            catch is CancellationError {}
            catch { self.error = deps.fail(ErpParts.customers, error) }
        }
    }

    func choose(_ item: ErpContactItem) {
        customer = item
        customerResults = []
    }

    func searchProduct(_ text: String) {
        productTask?.cancel()
        guard text.trimmingCharacters(in: .whitespaces).count >= 2 else { productResults = []; return }
        productTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            do { productResults = Array((try await deps.client.products(text).value.items ?? []).prefix(20)) }
            catch is CancellationError {}
            catch { self.error = deps.fail(ErpParts.products, error) }
        }
    }

    /// Código lido pela câmera: o produto exato entra no pedido (ou soma 1 se já estiver).
    func scan(_ code: String?) async {
        guard let value = ErpText.barcode(code) else { notice = "Não achei código de barras. Aproxime o código, com boa luz, e tente de novo."; return }
        searching = true
        defer { searching = false }
        do {
            let found = try await deps.client.products(value).value.items ?? []
            if let exact = ErpText.exactBarcode(found, value) ?? (found.count == 1 ? found.first : nil) { add(exact) }
            else { notice = "Nenhum produto ativo com o código \(value)." }
        } catch {
            self.error = deps.fail(ErpParts.products, error)
        }
    }

    func add(_ product: ErpProduct) {
        guard ErpNumbers.unitPrice(product.price) != nil else {
            notice = "\"\(product.name)\" está sem preço no cadastro. Coloque o preço no painel antes de vender pelo aplicativo."
            return
        }
        if let index = lines.firstIndex(where: { $0.product.id == product.id }) {
            let next = (ErpNumbers.decimal(lines[index].quantity) ?? 0) + 1
            lines[index].quantity = NSDecimalNumber(decimal: next).description(withLocale: Locale(identifier: "en_US_POSIX"))
        } else {
            lines.append(ErpCartLine(product: product, quantity: "1"))
        }
        productResults = []
    }

    /// `false` quando o texto não é quantidade válida (o item fica com a anterior).
    @discardableResult
    func setQuantity(_ productId: String, _ text: String) -> Bool {
        guard let q = ErpNumbers.quantity(text), let index = lines.firstIndex(where: { $0.product.id == productId }) else { return false }
        lines[index].quantity = q
        return true
    }

    func remove(_ productId: String) { lines.removeAll { $0.product.id == productId } }

    var discountValue: String? { ErpNumbers.discountValue(discountText, percent: discountPercent) }

    var totals: ErpOrderTotals? { discountValue.flatMap { ErpOrderTotals.of(lines, discount: $0, percent: discountPercent) } }

    /// O corpo do pedido, ou a mensagem do que falta.
    func body(key: String) -> Result<[String: Any?], ErpInputError> {
        guard let c = customer else { return .failure(.init("Escolha o cliente do pedido.")) }
        if lines.isEmpty { return .failure(.init("Inclua pelo menos um produto.")) }
        guard let discount = discountValue else { return .failure(.init(discountPercent ? "O desconto em % vai de 0 a 100." : "Confira o valor do desconto.")) }
        guard let t = ErpOrderTotals.of(lines, discount: discount, percent: discountPercent) else { return .failure(.init("Algum produto está sem preço no cadastro.")) }
        if !t.valid { return .failure(.init("O desconto é maior que o valor dos produtos.")) }
        return .success(ErpBodies.order(key: key, day: deps.today, contactId: c.id, lines: lines, discountValue: discount, percent: discountPercent, total: t.total,
                                        method: methods.first { $0.id == methodId }))
    }

    func save() async {
        guard !saving, saved == nil else { return }
        let signature = [customer?.id ?? "", lines.map { "\($0.product.id):\($0.quantity)" }.joined(separator: ","), discountText, String(discountPercent), methodId ?? ""].joined(separator: "|")
        let key = keys.key(for: signature)
        switch body(key: key) {
        case .failure(let problem): error = problem.message
        case .success(let request):
            saving = true
            error = nil
            defer { saving = false }
            do {
                let result = try await deps.client.createOrder(request, key: key)
                keys.settle(nil)
                saved = result.document
                savedTotal = totals?.total ?? 0
                // Sem a rota (servidor antigo), sem linha de WhatsApp ou sem conversas no acesso: o botão não aparece.
                preview = try? await deps.client.sendPreview(result.document.id)
            } catch {
                keys.settle(error)
                self.error = deps.failWrite(ErpParts.sales, error)
            }
        }
    }

    func send() async {
        guard let order = saved, let dest = preview?.destino, let phone = dest.digitos.clean, let line = dest.linha.clean, !sending, sent == nil else { return }
        let key = sendKeys.key(for: "\(order.id)|\(phone)|\(line)")
        sending = true
        error = nil
        defer { sending = false }
        do {
            try await deps.client.sendOrder(order.id, phone: phone, line: line, key: key)
            sendKeys.settle(nil)
            sent = "Pedido enviado pelo WhatsApp para \(dest.telefone.clean ?? phone)."
        } catch {
            sendKeys.settle(error)
            self.error = deps.failWrite(ErpParts.sales, error)
        }
    }

    /// Começar outro pedido do zero.
    func reset() {
        customer = nil
        lines = []
        discountText = ""
        discountPercent = false
        saved = nil
        preview = nil
        sent = nil
        error = nil
    }
}

// MARK: - Contas

@MainActor
final class ErpBillsViewModel: ObservableObject {
    enum Filter: String, CaseIterable, Identifiable {
        case today, overdue
        var id: String { rawValue }
        var label: String { self == .today ? "Vencem hoje" : "Vencidas" }
    }

    @Published private(set) var kind = "receivable"
    @Published private(set) var filter = Filter.today
    @Published private(set) var items: [ErpTitle] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var offlineAt: Int64?
    @Published private(set) var accounts: [ErpAccount] = []
    @Published private(set) var saving = false
    @Published var settleError: String?
    @Published var done: String?
    private let keys = IntentKeys()
    let deps: ErpDeps

    init(deps: ErpDeps) { self.deps = deps }

    func select(kind: String? = nil, filter: Filter? = nil) async {
        let k = kind ?? self.kind, f = filter ?? self.filter
        guard k != self.kind || f != self.filter else { return }
        self.kind = k
        self.filter = f
        items = []
        await refresh()
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let today = deps.today
            let read: ErpRead<ErpTitlePage>
            if filter == .today { read = try await deps.client.titles(kind: kind, option: "open", from: today, to: today) }
            else { read = try await deps.client.titles(kind: kind, option: "overdue") }
            items = (read.value.items ?? []).filter(\.isOpen)
            offlineAt = read.offlineAt
            error = nil
        } catch {
            self.error = deps.fail(ErpParts.finance, error)
        }
    }

    func loadAccounts() async {
        guard accounts.isEmpty else { return }
        do { accounts = (try await deps.client.accounts().value.items ?? []).filter { $0.active != false } }
        catch { settleError = deps.fail(ErpParts.finance, error) }
    }

    /// O corpo da baixa do saldo inteiro, hoje, ou a mensagem do que falta.
    func settleBody(key: String, title: ErpTitle, accountId: String?) -> Result<[String: Any?], ErpInputError> {
        guard let accountId, !accountId.isEmpty else { return .failure(.init("Escolha a conta onde o dinheiro entrou ou saiu.")) }
        guard title.balance > 0 else { return .failure(.init("Esta conta não tem saldo em aberto.")) }
        return .success(ErpBodies.settle(key: key, title: title, accountId: accountId, day: deps.today))
    }

    /// `true` quando a baixa foi registrada.
    func settle(_ title: ErpTitle, accountId: String?) async -> Bool {
        guard !saving else { return false }
        if offlineAt != nil { settleError = ErpText.offlineWrite; return false }
        let key = keys.key(for: "\(title.id)|\(title.version ?? 0)|\(accountId ?? "")")
        switch settleBody(key: key, title: title, accountId: accountId) {
        case .failure(let problem):
            settleError = problem.message
            return false
        case .success(let body):
            saving = true
            settleError = nil
            defer { saving = false }
            do {
                try await deps.client.settle(body, key: key)
                keys.settle(nil)
                done = title.isPayable ? "Conta paga: baixa registrada." : "Recebimento registrado: baixa feita."
                await refresh()
                return true
            } catch {
                keys.settle(error)
                settleError = deps.failWrite(ErpParts.finance, error)
                if (error as? QueueError)?.status == 409 { await refresh() }
                return false
            }
        }
    }
}
