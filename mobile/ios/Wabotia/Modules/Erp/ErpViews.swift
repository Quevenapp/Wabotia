import SwiftUI
import UIKit

/*
 As telas da Gestão (ERP), no mesmo desenho do Android (`modules/erp/ErpScreens.kt`): a entrada "Gestão" com os itens
 que a pessoa pode usar; clientes (busca, ficha, ligar, WhatsApp e cadastro rápido); produtos e estoque (busca por nome,
 código ou código de barras pela câmera, ficha com preço, foto e saldo por depósito, ajuste com motivo); pedido rápido
 (cliente, itens, quantidade, desconto e forma de pagamento; envio pelo WhatsApp quando o servidor oferece); e contas
 a receber e a pagar do dia e vencidas, com baixa simples. Sem conexão, tudo vira leitura da última cópia, com aviso.
 */

/// O acesso da pessoa à Gestão nesta área (módulos e papéis vindos das capacidades).
@MainActor
private func currentErpAccess(_ feature: ModuleFeature, _ container: AppContainer) -> ErpAccess? {
    feature.erpAccess(container.profileId, isAdmin: container.user?.isAdmin ?? false)
}

private extension View {
    func erpScreen(_ title: String) -> some View {
        self.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .appNavigationBarHidden(false)
    }
}

/// Parte desligada (ou papel sem acesso): a tela diz o que ligar, sem tentar carregar.
private struct ErpPartOff: View {
    let title: String
    let part: String
    var roleNote = false

    var body: some View {
        EmptyStateView(
            title: roleNote ? "Fora do seu papel no ERP" : "\(ErpParts.names[part] ?? part) desligado",
            systemImage: "building.2",
            message: roleNote ? "Seu papel no ERP não inclui esta tela. Peça ao administrador em Pessoas e acessos." : ErpParts.offMessage(part)
        )
        .erpScreen(title)
    }
}

private struct ErpOfflineNotice: View {
    let at: Int64?
    var body: some View {
        if let at { DeviceNotice(text: ErpText.offlineBanner(at), color: Theme.warn).padding(.horizontal, 16).padding(.top, 8) }
    }
}

private struct ErpField: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top) {
            Text(label).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).frame(width: 120, alignment: .leading)
            Text(value).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Entrada "Gestão"

struct ErpHomeView: View {
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared
    @Environment(\.pushRoute) private var push

    var body: some View {
        let access = currentErpAccess(feature, container)
        ScrollView {
            if let access {
                VStack(alignment: .leading, spacing: 16) {
                    SectionCard(title: "Seu papel: \(access.role.label)") {
                        if access.customers {
                            row("Clientes", "person.2.fill", Theme.brand, "Busca, ficha, ligar e WhatsApp" + (access.canCreateCustomer ? "; cadastro rápido" : "")) { push(.erpCustomers) }
                                .accessibilityIdentifier("erp.home.customers")
                        }
                        if access.products {
                            row("Produtos e estoque", "shippingbox.fill", Theme.warn, "Busca por nome, código ou código de barras" + (access.stock ? "; saldo por depósito" : "")) { push(.erpProducts) }
                                .accessibilityIdentifier("erp.home.products")
                        }
                        if access.quickOrder {
                            row("Pedido rápido", "cart.fill", Theme.ok, "Cliente, itens, desconto e pagamento") { push(.erpOrder) }
                                .accessibilityIdentifier("erp.home.order")
                        }
                        if access.bills {
                            row("Contas", "banknote.fill", Theme.ticket, "A receber e a pagar do dia e vencidas", divider: false) { push(.erpBills) }
                                .accessibilityIdentifier("erp.home.bills")
                        }
                    }
                    Text("Notas fiscais, compras, relatórios e configurações ficam no painel, no navegador.")
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 14)
                }
                .padding(16)
            } else {
                EmptyStateView(title: "Gestão indisponível", systemImage: "building.2",
                               message: "A Gestão aparece com o ERP ligado nesta área e um papel do ERP na sua conta. Um administrador liga em Gestão → Módulos e dá o papel em Pessoas e acessos.")
                    .padding(.top, 40)
            }
        }
        .erpScreen("Gestão")
        .task { await feature.refresh(container: container, force: true) }
    }

    private func row(_ title: String, _ icon: String, _ color: Color, _ subtitle: String, divider: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) { CardRow(icon: icon, iconColor: color, title: title, subtitle: subtitle, chevron: true, divider: divider) }
            .buttonStyle(.plain)
    }
}

// MARK: - Clientes

struct ErpCustomersView: View {
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        if let access = currentErpAccess(feature, container), access.customers {
            ErpCustomersList(access: access, vm: ErpCustomersViewModel(deps: .current(container)))
        } else {
            ErpPartOff(title: "Clientes", part: ErpParts.customers)
        }
    }
}

private struct ErpCustomersList: View {
    let access: ErpAccess
    @StateObject var vm: ErpCustomersViewModel
    @Environment(\.pushRoute) private var push
    @State private var search = ""
    @FocusState private var searching: Bool

    init(access: ErpAccess, vm: ErpCustomersViewModel) {
        self.access = access
        _vm = StateObject(wrappedValue: vm)
    }

    var body: some View {
        VStack(spacing: 0) {
            SearchField(placeholder: "Nome, CPF/CNPJ, telefone ou código", text: $search, focused: $searching)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .accessibilityIdentifier("erp.customers.search")
            ErpOfflineNotice(at: vm.offlineAt)
            if vm.loading && vm.items.isEmpty {
                SkeletonList(rows: 6, avatar: false)
            } else if let error = vm.error, vm.items.isEmpty {
                InlineError(text: error) { Task { await vm.refresh() } }.padding(16)
                Spacer()
            } else if vm.items.isEmpty {
                EmptyStateView(title: "Nenhum cliente encontrado", systemImage: "person.2", message: search.isEmpty ? "Cadastre o primeiro em +." : "Confira o que foi digitado.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(vm.items) { item in
                            Button { push(.erpCustomer(id: item.id)) } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                    if let trade = item.tradeName.clean { Text(trade).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                                    Text(item.subtitle.isEmpty ? (item.mobile.clean ?? item.phone.clean ?? "Sem dados de contato") : item.subtitle)
                                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .card()
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("erp.customer.row")
                        }
                        if vm.items.count < vm.total, vm.offlineAt == nil {
                            ProgressView().padding().task { await vm.loadMore() }
                        }
                    }
                    .padding(16)
                }
            }
        }
        .erpScreen("Clientes")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if access.canCreateCustomer, vm.offlineAt == nil {
                    Button { push(.erpNewCustomer) } label: { Image(systemName: "person.badge.plus") }
                        .accessibilityLabel("Novo cliente")
                        .accessibilityIdentifier("erp.customers.new")
                }
            }
        }
        .onChange(of: search) { vm.search($0) }
        .task { if vm.items.isEmpty { await vm.refresh() } }
    }
}

struct ErpCustomerView: View {
    let id: String
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        if let access = currentErpAccess(feature, container), access.customers {
            ErpCustomerDetail(vm: ErpCustomerViewModel(id: id, access: access, deps: .current(container)))
        } else {
            ErpPartOff(title: "Cliente", part: ErpParts.customers)
        }
    }
}

private struct ErpCustomerDetail: View {
    @StateObject var vm: ErpCustomerViewModel
    @Environment(\.openURL) private var openURL

    init(vm: ErpCustomerViewModel) { _vm = StateObject(wrappedValue: vm) }

    var body: some View {
        Group {
            if let record = vm.record {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ErpOfflineNotice(at: vm.offlineAt).padding(.horizontal, -16)
                        let dial = ErpText.dialURL(record.bestPhone)
                        let whatsapp = ErpText.whatsappURL(record.bestPhone)
                        if dial != nil || whatsapp != nil {
                            HStack(spacing: 10) {
                                if let dial { SecondaryButton(title: "Ligar", icon: "phone.fill") { openURL(dial) } }
                                if let whatsapp { PrimaryButton(title: "WhatsApp", icon: "message.fill") { openURL(whatsapp) } }
                            }
                        }
                        SectionCard(title: "Dados") {
                            VStack(alignment: .leading, spacing: 8) {
                                if let trade = record.tradeName.clean { ErpField(label: "Nome fantasia", value: trade) }
                                if let doc = record.document.clean { ErpField(label: record.personType == "J" ? "CNPJ" : (record.personType == "F" ? "CPF" : "Documento"), value: doc) }
                                ErpField(label: "Situação", value: ["A": "Ativo", "I": "Inativo", "S": "Sem movimento", "E": "Excluído"][record.situation ?? ""] ?? "—")
                            }
                            .padding(14)
                        }
                        SectionCard(title: "Contato") {
                            VStack(alignment: .leading, spacing: 8) {
                                ErpField(label: "Celular", value: record.mobile.clean ?? "—")
                                ErpField(label: "Telefone", value: record.phone.clean ?? "—")
                                ErpField(label: "E-mail", value: record.email.clean ?? "—")
                                ErpField(label: "Endereço", value: record.addressText ?? "—")
                            }
                            .padding(14)
                        }
                        if vm.access?.customerOrders == true {
                            SectionCard(title: "Últimos pedidos") {
                                VStack(alignment: .leading, spacing: 10) {
                                    if let note = vm.ordersNote {
                                        Text(note).font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                                    } else if let orders = vm.orders {
                                        if orders.isEmpty { Text("Nenhum pedido de venda ainda.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
                                        ForEach(orders) { o in
                                            HStack {
                                                VStack(alignment: .leading, spacing: 2) {
                                                    Text("Pedido \(o.number)").font(Theme.font(15, .medium)).foregroundStyle(Theme.textPrimary)
                                                    Text(ErpTitleLine.day(o.date) + " · " + ErpText.saleStatus(o.status))
                                                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                                                }
                                                Spacer()
                                                Text(ErpNumbers.showPrice(o.total)).font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
                                            }
                                        }
                                    } else {
                                        Text("Carregando…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                                    }
                                }
                                .padding(14)
                            }
                        }
                        if vm.access?.customerBills == true {
                            SectionCard(title: "Contas em aberto") {
                                VStack(alignment: .leading, spacing: 10) {
                                    if let note = vm.billsNote {
                                        Text(note).font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                                    } else if let bills = vm.bills {
                                        if bills.isEmpty { Text("Nada em aberto.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
                                        ForEach(bills) { ErpTitleLine(title: $0) }
                                    } else {
                                        Text("Carregando…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                                    }
                                }
                                .padding(14)
                            }
                        }
                    }
                    .padding(16)
                }
            } else if vm.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack { InlineError(text: vm.error ?? "Cliente não encontrado.") { Task { await vm.refresh() } }.padding(16); Spacer() }
            }
        }
        .erpScreen(vm.record?.name ?? "Cliente")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { Task { await vm.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Atualizar")
            }
        }
        .task { if vm.record == nil { await vm.refresh() } }
    }
}

private struct ErpTitleLine: View {
    let title: ErpTitle
    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title.description.clean ?? title.contactName.clean ?? "Conta").font(Theme.font(15)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text(["Vence \(ErpTitleLine.day(title.dueOn))", title.installmentText].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(Money.format(title.balance)).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                if title.overdue == true { Pill(text: "Vencida", color: Theme.danger) }
            }
        }
    }

    static func day(_ value: String?) -> String {
        guard let value, let date = BrasiliaTime.start(of: value) else { return value ?? "—" }
        return BrasiliaTime.short(BrasiliaTime.millis(date))
    }
}

struct ErpNewCustomerView: View {
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        let access = currentErpAccess(feature, container)
        if access?.canCreateCustomer == true {
            ErpNewCustomerForm(vm: ErpNewCustomerViewModel(deps: .current(container)))
        } else {
            ErpPartOff(title: "Novo cliente", part: ErpParts.customers, roleNote: access?.customers == true)
        }
    }
}

private struct ErpNewCustomerForm: View {
    @StateObject var vm: ErpNewCustomerViewModel
    @Environment(\.pushRoute) private var push
    @Environment(\.presentationMode) private var presentation

    init(vm: ErpNewCustomerViewModel) { _vm = StateObject(wrappedValue: vm) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                field("Nome *", text: $vm.name).accessibilityIdentifier("erp.customer.name")
                HStack(spacing: 8) {
                    FilterChip(title: "Pessoa física", selected: vm.personType == "F") { vm.personType = "F" }
                    FilterChip(title: "Empresa (CNPJ)", selected: vm.personType == "J") { vm.personType = "J" }
                }
                field(vm.personType == "J" ? "CNPJ" : "CPF", text: $vm.document, keyboard: vm.personType == "J" ? .asciiCapable : .numberPad)
                field("Celular com DDD", text: $vm.mobile, keyboard: .phonePad)
                field("E-mail", text: $vm.email, keyboard: .emailAddress)
                Text("Endereço e os outros dados você completa no painel, quando precisar.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                if let error = vm.error { InlineError(text: error) }
                PrimaryButton(title: "Cadastrar cliente", busy: vm.saving) { Task { await vm.save() } }
                    .accessibilityIdentifier("erp.customer.save")
            }
            .padding(16)
        }
        .erpScreen("Novo cliente")
        .onChange(of: vm.created) { created in
            guard let created else { return }
            Workspace.shared.show("Cliente cadastrado.", style: .success)
            presentation.wrappedValue.dismiss()
            push(.erpCustomer(id: created.id))
        }
    }

    private func field(_ title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Theme.font(13, .medium)).foregroundStyle(Theme.textSecondary)
            TextField(title, text: text)
                .font(Theme.font(16))
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .textInputAutocapitalization(keyboard == .default ? .words : .never)
                .padding(.horizontal, 12).frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
        }
    }
}

// MARK: - Produtos e estoque

struct ErpProductsView: View {
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        let access = currentErpAccess(feature, container)
        if access?.products == true {
            ErpProductsList(vm: ErpProductsViewModel(deps: .current(container)))
        } else {
            ErpPartOff(title: "Produtos e estoque", part: ErpParts.products, roleNote: access?.parts.contains(ErpParts.products) == true)
        }
    }
}

private struct ErpProductsList: View {
    @StateObject var vm: ErpProductsViewModel
    @Environment(\.pushRoute) private var push
    @State private var search = ""
    @State private var scanning = false
    @FocusState private var searching: Bool

    init(vm: ErpProductsViewModel) { _vm = StateObject(wrappedValue: vm) }

    var body: some View {
        VStack(spacing: 0) {
            SearchField(placeholder: "Nome, código ou código de barras", text: $search, focused: $searching)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .accessibilityIdentifier("erp.products.search")
            ErpOfflineNotice(at: vm.offlineAt)
            if vm.loading && vm.items.isEmpty {
                SkeletonList(rows: 6, avatar: false)
            } else if let error = vm.error, vm.items.isEmpty {
                InlineError(text: error) { Task { await vm.refresh() } }.padding(16)
                Spacer()
            } else if vm.items.isEmpty {
                EmptyStateView(title: "Nenhum produto encontrado", systemImage: "shippingbox", message: "Busque pelo nome, pelo código ou toque no leitor para usar a câmera.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(vm.items) { p in
                            Button { push(.erpProduct(id: p.id)) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(p.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                                        if !p.subtitle.isEmpty { Text(p.subtitle).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                                    }
                                    Spacer()
                                    Text(ErpNumbers.showPrice(p.price)).font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
                                }
                                .card()
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("erp.product.row")
                        }
                    }
                    .padding(16)
                }
            }
        }
        .erpScreen("Produtos e estoque")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { scanning = true } label: { Image(systemName: "barcode.viewfinder") }
                    .accessibilityLabel("Ler código de barras")
                    .accessibilityIdentifier("erp.products.scan")
            }
        }
        .sheet(isPresented: $scanning) {
            ErpBarcodeSheet(onCode: { code in
                scanning = false
                search = code
                Task { await vm.scan(code) }
            }, onClose: { scanning = false })
        }
        .onChange(of: search) { text in if text != vm.query { vm.search(text) } }
        .onChange(of: vm.scanned) { product in
            guard let product else { return }
            vm.scanned = nil
            push(.erpProduct(id: product.id))
        }
        .onChange(of: vm.notice) { notice in
            guard let notice else { return }
            Workspace.shared.show(notice, style: .error)
            vm.notice = nil
        }
        .task { if vm.items.isEmpty { await vm.refresh() } }
    }
}

struct ErpProductView: View {
    let id: String
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        if let access = currentErpAccess(feature, container), access.products {
            ErpProductDetail(vm: ErpProductViewModel(id: id, access: access, deps: .current(container)))
        } else {
            ErpPartOff(title: "Produto", part: ErpParts.products)
        }
    }
}

private struct ErpProductDetail: View {
    @StateObject var vm: ErpProductViewModel
    @State private var adjusting: ErpStockBalance?

    init(vm: ErpProductViewModel) { _vm = StateObject(wrappedValue: vm) }

    var body: some View {
        Group {
            if let product = vm.product {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ErpOfflineNotice(at: vm.offlineAt).padding(.horizontal, -16)
                        if let data = vm.photo, let image = UIImage(data: data) {
                            Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 260)
                                .accessibilityLabel("Foto de \(product.name)")
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text(ErpNumbers.showPrice(product.price)).font(Theme.font(26, .bold)).foregroundStyle(Theme.textPrimary)
                            ErpField(label: "Unidade", value: product.unitText)
                            if let code = product.code.clean { ErpField(label: "Código", value: code) }
                            if let gtin = product.gtin.clean { ErpField(label: "Código de barras", value: gtin) }
                            if let brand = product.brand.clean { ErpField(label: "Marca", value: brand) }
                            if let text = product.description.clean { Text(text).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card()
                        if vm.access?.stock == true { stock(product) }
                    }
                    .padding(16)
                }
            } else if vm.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack { InlineError(text: vm.error ?? "Produto não encontrado.") { Task { await vm.refresh() } }.padding(16); Spacer() }
            }
        }
        .erpScreen(vm.product?.name ?? "Produto")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { Task { await vm.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Atualizar")
            }
        }
        .sheet(item: $adjusting) { balance in
            ErpStockAdjustSheet(vm: vm, balance: balance, unit: vm.product?.unitText ?? "UN") { adjusting = nil }
        }
        .onChange(of: vm.done) { done in
            guard let done else { return }
            Workspace.shared.show(done, style: .success)
            vm.done = nil
        }
        .task { if vm.product == nil { await vm.refresh() } }
    }

    @ViewBuilder private func stock(_ product: ErpProduct) -> some View {
        SectionCard(title: "Saldo por depósito", footer: vm.access?.canAdjustStock == true ? "Toque em + para lançar entrada ou saída com motivo." : nil) {
            if let note = vm.stockNote {
                Text(note).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            } else if let balances = vm.balances {
                if balances.isEmpty { Text("Nenhum depósito com este produto.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary).padding(14) }
                ForEach(balances) { b in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(b.name + (b.isDefault ? " (padrão)" : "")).font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
                            let reserved = ErpNumbers.showQuantity(b.reservedQuantity)
                            if reserved != "0" { Text("Reservado: \(reserved)").font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                        }
                        Spacer()
                        Text("\(ErpNumbers.showQuantity(b.quantity)) \(b.unit ?? product.unitText)")
                            .font(Theme.font(15, .semibold))
                            .foregroundStyle((ErpNumbers.decimal(b.quantity) ?? 0) < 0 ? Theme.danger : Theme.textPrimary)
                        if vm.access?.canAdjustStock == true, vm.offlineAt == nil, !b.isVirtual, b.isActive {
                            Button { vm.adjustError = nil; adjusting = b } label: { Image(systemName: "plus.circle.fill").font(.system(size: 22)).foregroundStyle(Theme.brand) }
                                .buttonStyle(.plain)
                                .frame(width: Theme.touch, height: Theme.touch)
                                .accessibilityLabel("Ajustar estoque em \(b.name)")
                                .accessibilityIdentifier("erp.stock.adjust")
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                }
            } else {
                Text("Carregando…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary).padding(14)
            }
        }
    }
}

private struct ErpStockAdjustSheet: View {
    @ObservedObject var vm: ErpProductViewModel
    let balance: ErpStockBalance
    let unit: String
    let onClose: () -> Void
    @State private var direction = ErpStockDirection.entrada
    @State private var quantity = ""
    @State private var reason = ""

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Ajustar estoque", subtitle: "\(balance.name) · saldo \(ErpNumbers.showQuantity(balance.quantity)) \(unit)", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        ForEach(ErpStockDirection.allCases) { d in FilterChip(title: d.label, selected: direction == d) { direction = d } }
                    }
                    TextField("Quantidade (\(unit))", text: $quantity)
                        .keyboardType(.decimalPad)
                        .padding(.horizontal, 12).frame(height: 44)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
                        .accessibilityIdentifier("erp.stock.quantity")
                    TextField("Motivo * (contagem, avaria, troca…)", text: $reason)
                        .padding(.horizontal, 12).frame(height: 44)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
                        .accessibilityIdentifier("erp.stock.reason")
                    if let error = vm.adjustError { InlineError(text: error) }
                    PrimaryButton(title: "Lançar \(direction.label.lowercased())", busy: vm.saving) {
                        Task { if await vm.adjust(direction, balance, quantity: quantity, reason: reason) { onClose() } }
                    }
                    .accessibilityIdentifier("erp.stock.save")
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }
}

// MARK: - Pedido rápido

struct ErpQuickOrderView: View {
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        let access = currentErpAccess(feature, container)
        if access?.quickOrder == true {
            ErpQuickOrderForm(vm: ErpQuickOrderViewModel(deps: .current(container)))
        } else {
            ErpPartOff(title: "Pedido rápido", part: ErpParts.sales,
                       roleNote: access.map { $0.parts.contains(ErpParts.sales) && $0.parts.contains(ErpParts.products) } ?? false)
        }
    }
}

private struct ErpQuickOrderForm: View {
    @StateObject var vm: ErpQuickOrderViewModel
    @State private var customerQuery = ""
    @State private var productQuery = ""
    @State private var scanning = false
    @FocusState private var focusCustomer: Bool
    @FocusState private var focusProduct: Bool

    init(vm: ErpQuickOrderViewModel) { _vm = StateObject(wrappedValue: vm) }

    var body: some View {
        Group {
            if let saved = vm.saved { done(saved) } else { form }
        }
        .erpScreen("Pedido rápido")
        .sheet(isPresented: $scanning) {
            ErpBarcodeSheet(onCode: { code in
                scanning = false
                Task { await vm.scan(code) }
            }, onClose: { scanning = false })
        }
        .onChange(of: customerQuery) { vm.searchCustomer($0) }
        .onChange(of: productQuery) { vm.searchProduct($0) }
        .onChange(of: vm.lines.count) { _ in productQuery = "" }
        .onChange(of: vm.notice) { notice in
            guard let notice else { return }
            Workspace.shared.show(notice, style: .error)
            vm.notice = nil
        }
        .task { await vm.start() }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionCard(title: "Cliente") {
                    VStack(alignment: .leading, spacing: 8) {
                        if let c = vm.customer {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.name).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
                                    if !c.subtitle.isEmpty { Text(c.subtitle).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                                }
                                Spacer()
                                Button { vm.customer = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                                    .buttonStyle(.plain).accessibilityLabel("Trocar cliente")
                            }
                        } else {
                            SearchField(placeholder: "Buscar cliente pelo nome ou CPF/CNPJ", text: $customerQuery, focused: $focusCustomer)
                                .accessibilityIdentifier("erp.order.customer")
                            ForEach(vm.customerResults) { item in
                                Button { vm.choose(item); customerQuery = "" } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.name).font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
                                        if !item.subtitle.isEmpty { Text(item.subtitle).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 6)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(14)
                }
                SectionCard(title: "Itens") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            SearchField(placeholder: "Produto: nome ou código", text: $productQuery, focused: $focusProduct)
                                .accessibilityIdentifier("erp.order.product")
                            Button { scanning = true } label: { Image(systemName: "barcode.viewfinder").font(.system(size: 20)) }
                                .frame(width: Theme.touch, height: Theme.touch)
                                .accessibilityLabel("Ler código de barras")
                        }
                        ForEach(vm.productResults) { p in
                            Button { vm.add(p) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(p.name).font(Theme.font(15)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                        if !p.subtitle.isEmpty { Text(p.subtitle).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                                    }
                                    Spacer()
                                    Text(ErpNumbers.showPrice(p.price)).font(Theme.font(14)).foregroundStyle(Theme.textPrimary)
                                    Image(systemName: "plus.circle.fill").foregroundStyle(Theme.brand)
                                }
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(vm.lines) { line in ErpCartLineRow(vm: vm, line: line) }
                        if vm.lines.isEmpty {
                            Text("Busque o produto ou leia o código de barras para incluir.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .padding(14)
                }
                SectionCard(title: "Desconto e pagamento") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            TextField(vm.discountPercent ? "Desconto (%)" : "Desconto (R$)", text: $vm.discountText)
                                .keyboardType(.decimalPad)
                                .padding(.horizontal, 12).frame(height: 40)
                                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.background))
                            FilterChip(title: "R$", selected: !vm.discountPercent) { vm.discountPercent = false }
                            FilterChip(title: "%", selected: vm.discountPercent) { vm.discountPercent = true }
                        }
                        if !vm.methods.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(vm.methods) { m in FilterChip(title: m.title, selected: vm.methodId == m.id) { vm.methodId = m.id } }
                                }
                            }
                        }
                        if let note = vm.methodsNote { Text(note).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                    }
                    .padding(14)
                }
                totals
                if let error = vm.error { InlineError(text: error) }
                PrimaryButton(title: "Salvar pedido de venda", busy: vm.saving, disabled: vm.customer == nil || vm.lines.isEmpty) { Task { await vm.save() } }
                    .accessibilityIdentifier("erp.order.save")
            }
            .padding(16)
        }
    }

    private var totals: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let t = vm.totals {
                ErpField(label: "Produtos", value: Money.format(t.subtotal))
                if t.discount > 0 { ErpField(label: "Desconto", value: "- " + Money.format(t.discount)) }
                HStack {
                    Text("Total").font(Theme.font(17, .bold)).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Text(Money.format(t.total)).font(Theme.font(17, .bold)).foregroundStyle(Theme.textPrimary)
                }
                if !t.valid { Text("O desconto é maior que o valor dos produtos.").font(Theme.font(12)).foregroundStyle(Theme.danger) }
            } else {
                Text("Confira o desconto.").font(Theme.font(14)).foregroundStyle(Theme.danger)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func done(_ saved: ErpSavedDocument) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Pedido \(saved.number ?? "") salvo").font(Theme.font(22, .bold)).foregroundStyle(Theme.textPrimary)
                    Text("\(vm.customer?.name ?? "") · \(Money.format(vm.savedTotal))").font(Theme.font(15)).foregroundStyle(Theme.textSecondary)
                    if let status = saved.status { Text(ErpText.saleStatus(status)).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
                if let sent = vm.sent {
                    DeviceNotice(text: sent, color: Theme.ok)
                } else if vm.preview?.canSend == true {
                    PrimaryButton(title: "Enviar ao cliente pelo WhatsApp", icon: "paperplane.fill", busy: vm.sending) { Task { await vm.send() } }
                        .accessibilityIdentifier("erp.order.send")
                } else if let reason = vm.preview?.destino?.motivo.clean ?? vm.preview?.conectar.clean {
                    Text(reason).font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                }
                if let error = vm.error { InlineError(text: error) }
                SecondaryButton(title: "Novo pedido") { vm.reset() }
            }
            .padding(16)
        }
    }
}

private struct ErpCartLineRow: View {
    @ObservedObject var vm: ErpQuickOrderViewModel
    let line: ErpCartLine
    @State private var text = ""
    @State private var invalid = false

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(line.product.name).font(Theme.font(15)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                Text("\(ErpNumbers.showPrice(line.product.price)) / \(line.product.unitText)" + (ErpNumbers.unitPrice(line.product.price).map { " · " + Money.format(ErpNumbers.lineCents(line.quantity, $0)) } ?? ""))
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            TextField("Qtd.", text: $text)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.center)
                .frame(width: 70, height: 38)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(invalid ? Theme.danger : Theme.divider, lineWidth: 1))
                .accessibilityLabel("Quantidade de \(line.product.name)")
            Button { vm.remove(line.product.id) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                .buttonStyle(.plain)
                .accessibilityLabel("Tirar \(line.product.name)")
        }
        .onAppear { text = line.quantity.replacingOccurrences(of: ".", with: ",") }
        .onChange(of: text) { invalid = !vm.setQuantity(line.product.id, $0) }
        .onChange(of: line.quantity) { q in
            if ErpNumbers.quantity(text) != q { text = q.replacingOccurrences(of: ".", with: ",") }
        }
    }
}

// MARK: - Contas

struct ErpBillsView: View {
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared

    var body: some View {
        let access = currentErpAccess(feature, container)
        if let access, access.bills {
            ErpBillsList(access: access, vm: ErpBillsViewModel(deps: .current(container)))
        } else {
            ErpPartOff(title: "Contas", part: ErpParts.finance, roleNote: access?.parts.contains(ErpParts.finance) == true)
        }
    }
}

private struct ErpBillsList: View {
    let access: ErpAccess
    @StateObject var vm: ErpBillsViewModel
    @State private var settling: ErpTitle?

    init(access: ErpAccess, vm: ErpBillsViewModel) {
        self.access = access
        _vm = StateObject(wrappedValue: vm)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    FilterChip(title: "A receber", selected: vm.kind == "receivable") { Task { await vm.select(kind: "receivable") } }
                    FilterChip(title: "A pagar", selected: vm.kind == "payable") { Task { await vm.select(kind: "payable") } }
                }
                HStack(spacing: 8) {
                    ForEach(ErpBillsViewModel.Filter.allCases) { f in FilterChip(title: f.label, selected: vm.filter == f) { Task { await vm.select(filter: f) } } }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            ErpOfflineNotice(at: vm.offlineAt)
            if vm.loading && vm.items.isEmpty {
                SkeletonList(rows: 5, avatar: false)
            } else if let error = vm.error, vm.items.isEmpty {
                InlineError(text: error) { Task { await vm.refresh() } }.padding(16)
                Spacer()
            } else if vm.items.isEmpty {
                EmptyStateView(title: vm.filter == .today ? "Nada vencendo hoje" : "Nada vencido", systemImage: "banknote",
                               message: vm.kind == "receivable" ? "Nenhuma conta a receber aqui." : "Nenhuma conta a pagar aqui.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        Text("\(vm.items.count) conta(s) · \(Money.format(vm.items.reduce(0) { $0 + $1.balance }))")
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 4)
                        ForEach(vm.items) { t in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(t.contactName.clean ?? "Sem contato").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                ErpTitleLine(title: t)
                                if access.canSettle, vm.offlineAt == nil {
                                    SecondaryButton(title: t.isPayable ? "Dar baixa (paguei)" : "Dar baixa (recebi)") {
                                        vm.settleError = nil
                                        settling = t
                                        Task { await vm.loadAccounts() }
                                    }
                                    .accessibilityIdentifier("erp.bill.settle")
                                }
                            }
                            .card()
                            .accessibilityIdentifier("erp.bill.row")
                        }
                    }
                    .padding(16)
                }
            }
        }
        .erpScreen("Contas")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { Task { await vm.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Atualizar")
            }
        }
        .sheet(item: $settling) { title in ErpSettleSheet(vm: vm, title: title) { settling = nil } }
        .onChange(of: vm.done) { done in
            guard let done else { return }
            Workspace.shared.show(done, style: .success)
            vm.done = nil
        }
        .task { if vm.items.isEmpty { await vm.refresh() } }
    }
}

private struct ErpSettleSheet: View {
    @ObservedObject var vm: ErpBillsViewModel
    let title: ErpTitle
    let onClose: () -> Void
    @State private var accountId: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Dar baixa", subtitle: "\(title.contactName ?? "") · \(Money.format(title.balance)) · hoje", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Conta financeira").font(Theme.font(13, .medium)).foregroundStyle(Theme.textSecondary)
                    if vm.accounts.isEmpty, vm.settleError == nil { Text("Carregando as contas…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(vm.accounts) { a in FilterChip(title: a.title, selected: accountId == a.id) { accountId = a.id } }
                        }
                    }
                    Text("A baixa é do saldo inteiro, com a data de hoje. Juros, multa, desconto e baixa parcial ficam no painel.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                    if let error = vm.settleError { InlineError(text: error) }
                    PrimaryButton(title: "Confirmar baixa de \(Money.format(title.balance))", busy: vm.saving, disabled: accountId == nil) {
                        Task { if await vm.settle(title, accountId: accountId) { onClose() } }
                    }
                    .accessibilityIdentifier("erp.bill.confirm")
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .onAppear { accountId = title.accountId }
        .onChange(of: vm.accounts) { list in
            if accountId == nil || !list.contains(where: { $0.id == accountId }) { accountId = list.first?.id }
        }
    }
}
