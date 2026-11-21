import SwiftUI

/*
 * Entregas no celular (`GET entrega`, `GET entrega/mine`, `GET entrega/deliveries`, `POST …/start` e `…/delivered`):
 * o entregador vê as entregas dele, sai para entregar e confirma (com o código do cliente, quando a loja pede); a equipe
 * vê as abertas e confirma a entrega. Atribuir, mapa e rastreio contínuo ficam no painel. Mesmo desenho do Android
 * (`modules/entrega/EntregaScreen.kt`).
 */

struct CourierDelivery: Decodable, Equatable, Identifiable {
    let id: String
    var label: String? = nil
    var customerName: String? = nil
    var addressText: String? = nil
    var status: String = ""
    var statusLabel: String? = nil

    var title: String {
        let parts = [label, customerName].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return parts.isEmpty ? "Entrega" : parts.joined(separator: " · ")
    }
    var canStart: Bool { status == "assigned" }
    var canFinish: Bool { status == "assigned" || status == "en_route" }
}

private struct DeliveryList: Decodable { var data: [CourierDelivery]? }
private struct EntregaInfo: Decodable { var courier: Bool? }

@MainActor
final class EntregaViewModel: ObservableObject {
    @Published private(set) var courier = false
    @Published private(set) var items: [CourierDelivery]?
    @Published private(set) var error: String?
    @Published private(set) var busy = false
    @Published var notice: String?
    private let api = ProfileAPI.current()
    private let keys = IntentKeys()
    private let onFailure = ModuleFailure.handler(ModuleId.entrega)
    private var events: ModuleEvents?

    func observe() { if events == nil { events = ModuleEvents(prefix: "entrega.") { [weak self] in await self?.load() } } }

    func load() async {
        do {
            let info: EntregaInfo = try await api.get("entrega")
            courier = info.courier == true
            let list: DeliveryList = try await api.get(courier ? "entrega/mine" : "entrega/deliveries")
            items = (list.data ?? []).filter { courier || $0.canFinish }
            error = nil
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
    }

    private func post(_ signature: String, _ path: String, _ body: [String: Any?]) async -> Bool {
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

    func start(_ d: CourierDelivery) async { _ = await post("start:\(d.id)", "entrega/deliveries/\(d.id)/start", [:]) }

    func deliver(_ d: CourierDelivery, code: String) async {
        let c = code.trimmingCharacters(in: .whitespaces)
        _ = await post("deliver:\(d.id):\(c)", "entrega/deliveries/\(d.id)/delivered", ["code": c.isEmpty ? nil : c])
    }
}

struct EntregaView: View {
    @StateObject private var vm = EntregaViewModel()
    @State private var finishing: CourierDelivery?
    @State private var code = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let items = vm.items {
                    if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                    if items.isEmpty {
                        EmptyStateView(title: "Nenhuma entrega agora", systemImage: "bicycle",
                                       message: vm.courier ? "Quando a loja atribuir uma entrega a você, ela aparece aqui." : "As entregas abertas aparecem aqui.")
                    }
                    ForEach(items) { d in
                        SectionCard {
                            CardRow(icon: "bicycle", title: d.title, subtitle: [d.statusLabel, d.addressText].compactMap { $0 }.joined(separator: "\n"), divider: true)
                            HStack {
                                if vm.courier && d.canStart {
                                    Button("Sair para entregar") { Task { await vm.start(d) } }.disabled(vm.busy)
                                        .accessibilityIdentifier("entrega.start.\(d.id)")
                                }
                                Spacer()
                                if d.canFinish {
                                    Button("Confirmar entrega") { code = ""; finishing = d }.disabled(vm.busy)
                                        .accessibilityIdentifier("entrega.done.\(d.id)")
                                }
                            }
                            .font(Theme.font(15, .semibold))
                            .padding(14)
                        }
                    }
                    OpenInBrowserRow(path: WebPanel.deliveries, subtitle: "Atribuir entregadores, mapa e rastreio")
                } else if let error = vm.error {
                    InlineError(text: error) { Task { await vm.load() } }
                } else {
                    SkeletonList(rows: 5)
                }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.courier ? "Minhas entregas" : "Entregas")
        .navigationBarTitleDisplayMode(.inline)
        .task { vm.observe(); await vm.load() }
        .refreshable { await vm.load() }
        .alert("Confirmar entrega", isPresented: Binding(get: { finishing != nil }, set: { if !$0 { finishing = nil } })) {
            if vm.courier { TextField("Código do cliente (se a loja pedir)", text: $code).keyboardType(.numberPad) }
            Button("Entregue") {
                guard let d = finishing else { return }
                Task { await vm.deliver(d, code: String(code.filter(\.isNumber).prefix(8))) }
            }
            Button("Voltar", role: .cancel) {}
        } message: {
            Text(finishing?.title ?? "")
        }
    }
}
