import SwiftUI

/*
 * Mesas do garçom (`GET mesas`, `POST mesas/tabs`, `POST mesas/tabs/{id}/bill`): o mapa das mesas, abrir uma mesa livre
 * e pedir a conta. Lançar itens, pagamentos, transferir e juntar ficam no painel. Mesmo desenho do Android
 * (`modules/mesas/MesasScreen.kt`).
 */

struct TabBill: Decodable, Equatable {
    var totalCents: Int? = 0
    var dueCents: Int? = 0
}

struct TableTab: Decodable, Equatable {
    let id: String
    var number: Int? = 0
    var status: String? = "open"
    var statusLabel: String? = nil
    var guests: Int? = 0
    var customerName: String? = nil
    var bill: TabBill? = nil
    var minutesOpen: Int? = 0
    var readyCount: Int? = nil
}

struct DiningTable: Decodable, Equatable, Identifiable {
    let id: String
    var name: String = ""
    var section: String? = nil
    var seats: Int? = 0
    var state: String? = "free"
    var stateLabel: String? = nil
    var tab: TableTab? = nil
}

struct MesasOverview: Decodable, Equatable {
    var canOperate: Bool? = false
    var tables: [DiningTable]? = []
}

enum MesasText {
    /// "Ocupada · 3 pessoas · 25 min · R$ 120,00".
    static func subtitle(_ table: DiningTable) -> String {
        guard let tab = table.tab else { return "Livre · \(table.seats ?? 0) lugares" }
        var parts: [String] = [table.stateLabel?.isEmpty == false ? table.stateLabel! : (table.state == "closing" ? "Fechando" : "Ocupada")]
        if let g = tab.guests, g > 0 { parts.append("\(g) pessoas") }
        parts.append("\(tab.minutesOpen ?? 0) min")
        parts.append(Money.format(tab.bill?.totalCents ?? 0))
        if let ready = tab.readyCount, ready > 0 { parts.append("\(ready) pronto(s) para servir") }
        return parts.joined(separator: " · ")
    }
}

@MainActor
final class MesasViewModel: ObservableObject {
    @Published private(set) var overview: MesasOverview?
    @Published private(set) var error: String?
    @Published private(set) var busy = false
    @Published var notice: String?
    private let api = ProfileAPI.current()
    private let keys = IntentKeys()
    private let onFailure = ModuleFailure.handler(ModuleId.mesas)
    private var events: ModuleEvents?

    func observe() { if events == nil { events = ModuleEvents(prefix: "mesas.") { [weak self] in await self?.load() } } }

    func load() async {
        do {
            overview = try await api.get("mesas")
            error = nil
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
    }

    private func write(_ signature: String, _ path: String, _ body: [String: Any?]) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        let key = keys.key(for: signature)
        do {
            let _: EmptyReply = try await api.send("POST", path, body, key: key)
            keys.settle(nil)
            await load()
            return true
        } catch {
            keys.settle(error)
            if let e = error as? QueueError { onFailure(e) }
            notice = ModuleFailure.message(error) + ((error as? QueueError)?.retryable == true ? " Toque de novo para repetir com segurança." : "")
            return false
        }
    }

    func open(_ table: DiningTable, guests: Int, customer: String) async -> Bool {
        let name = customer.trimmingCharacters(in: .whitespaces)
        return await write("open:\(table.id):\(guests):\(name)", "mesas/tabs", ["table_id": table.id, "guests": guests, "customer_name": name.isEmpty ? nil : name])
    }

    func requestBill(_ tab: TableTab) async { _ = await write("bill:\(tab.id)", "mesas/tabs/\(tab.id)/bill", [:]) }
}

/// Resposta de escrita que a tela não lê (ela relê a lista).
struct EmptyReply: Decodable {}

struct MesasView: View {
    @StateObject private var vm = MesasViewModel()
    @State private var opening: DiningTable?
    @State private var selected: DiningTable?
    @State private var guests = ""
    @State private var customer = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let overview = vm.overview {
                    if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                    let tables = overview.tables ?? []
                    if tables.isEmpty {
                        EmptyStateView(title: "Nenhuma mesa cadastrada", systemImage: "fork.knife", message: "As mesas são cadastradas no painel, em Gestão → Mesas.")
                    }
                    if overview.canOperate != true {
                        Text("Você vê as mesas, mas abrir e pedir a conta é do papel Garçom. Peça ao administrador em Gestão → Pessoas e acessos.")
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    }
                    let sections = Dictionary(grouping: tables) { ($0.section ?? "").isEmpty ? "Salão" : $0.section! }
                    ForEach(sections.keys.sorted(), id: \.self) { section in
                        let list = sections[section] ?? []
                        SectionCard(title: section) {
                            ForEach(Array(list.enumerated()), id: \.element.id) { index, table in
                                let color = table.tab == nil ? Theme.ok : (table.state == "closing" ? Theme.warn : Theme.brand)
                                Button {
                                    if table.tab == nil { guests = ""; customer = ""; opening = table } else { selected = table }
                                } label: {
                                    CardRow(icon: "fork.knife", iconColor: color, title: table.name, subtitle: MesasText.subtitle(table), divider: index < list.count - 1) {
                                        Pill(text: table.tab == nil ? "Livre" : (table.stateLabel ?? "Ocupada"), color: color)
                                    }
                                }
                                .buttonStyle(.plain)
                                .disabled(overview.canOperate != true)
                                .accessibilityIdentifier("mesa.\(table.id)")
                            }
                        }
                    }
                    OpenInBrowserRow(path: WebPanel.mesas, subtitle: "Lançar itens, receber pagamentos, transferir e juntar mesas")
                } else if let error = vm.error {
                    InlineError(text: error) { Task { await vm.load() } }
                } else {
                    SkeletonList(rows: 6)
                }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Mesas")
        .navigationBarTitleDisplayMode(.inline)
        .task { vm.observe(); await vm.load() }
        .refreshable { await vm.load() }
        .alert("Abrir \(opening?.name ?? "mesa")", isPresented: Binding(get: { opening != nil }, set: { if !$0 { opening = nil } })) {
            TextField("Pessoas (opcional)", text: $guests).keyboardType(.numberPad)
            TextField("Nome do cliente (opcional)", text: $customer)
            Button("Abrir mesa") {
                guard let table = opening else { return }
                Task { _ = await vm.open(table, guests: Int(guests.filter(\.isNumber)) ?? 0, customer: String(customer.prefix(80))) }
            }
            Button("Voltar", role: .cancel) {}
        }
        .alert(selected.map { "\($0.name) · comanda \($0.tab?.number ?? 0)" } ?? "", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
            if let tab = selected?.tab, tab.status == "open" {
                Button("Pedir a conta") { Task { await vm.requestBill(tab) } }
            }
            Button("Fechar", role: .cancel) {}
        } message: {
            if let table = selected {
                Text(MesasText.subtitle(table) + (table.tab?.customerName.map { "\nCliente: \($0)" } ?? "") + "\nFalta pagar: \(Money.format(table.tab?.bill?.dueCents ?? 0))")
            }
        }
    }
}
