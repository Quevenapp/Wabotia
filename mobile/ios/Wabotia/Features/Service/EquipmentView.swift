import SwiftUI

/// Um painel de TV da fila (`GET queue/displays`): abre pelo link com a chave dele, num navegador da TV.
struct QueueDisplay: Decodable, Equatable, Identifiable {
    let id: String
    var name: String? = nil
    var revoked: Bool? = false
}

private struct QueueDisplayList: Decodable { var data: [QueueDisplay]? }
private struct CreatedDisplay: Decodable { var path: String? }

/// Um aparelho pareado pelo código (painel ou totem com o app em modo aparelho, `GET /api/v1/pairings`). Lido pelo
/// `APIClient`, que não converte snake_case: os nomes seguem o servidor.
struct PairedDevice: Codable, Equatable, Identifiable {
    let id: String
    var client: String? = nil
    var instance_name: String? = nil
    var status: String? = nil
    var profile_id: String? = nil
    var updated: Int64? = nil
    var allowed_scopes: [String]? = nil
    var requested_scopes: [String]? = nil
}

private struct PairedDeviceList: Decodable { var data: [PairedDevice]? }
private struct PairingLookupBody: Encodable { let user_code: String }
private struct PairingApproveBody: Encodable { let profile_id: String; let scopes: [String] }
private struct LooseReply: Decodable {}

/// Regras de Equipamentos, sem rede (iguais às do Android, `ui/service/EquipmentScreen.kt`).
enum EquipmentRules {
    /// O cliente do pareamento dos painéis e totens (src/pairing.ts).
    static let panelClient = "senhapp"

    /// "abcd-2345" → "ABCD2345".
    static func normalizeCode(_ text: String) -> String { String(text.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(8)) }

    static func validCode(_ code: String) -> Bool { code.range(of: "^[A-HJ-NP-Z2-9]{8}$", options: .regularExpression) != nil }

    static func panels(_ list: [PairedDevice], profileId: String?) -> [PairedDevice] {
        list.filter { $0.client == panelClient && ($0.profile_id == nil || $0.profile_id == profileId) }
    }

    static func situation(_ d: PairedDevice) -> String {
        switch d.status {
        case "revoked": return "Desligado"
        case "denied": return "Recusado"
        case "pending": return "Aguardando liberação"
        default: return "Pareado"
        }
    }

    /// Liberar com o que o aparelho pediu (ler a fila, emitir senhas, operar) nesta área.
    static func scopes(_ d: PairedDevice) -> [String] { d.requested_scopes ?? d.allowed_scopes ?? [] }
}

@MainActor
final class EquipmentViewModel: ObservableObject {
    @Published private(set) var displays: [QueueDisplay] = []
    @Published private(set) var devices: [PairedDevice] = []
    @Published private(set) var busy = false
    @Published var notice: String?
    @Published var createdLink: String?
    private let container: AppContainer
    private let api: ProfileAPI

    init(container: AppContainer = .shared) {
        self.container = container
        api = ProfileAPI.current(container)
    }

    func load(queue: Bool, admin: Bool) async {
        guard admin else { return }
        do {
            if queue { displays = (try await api.get("queue/displays") as QueueDisplayList).data ?? [] }
            let list: PairedDeviceList = try await container.api.request(.get, "api/v1/pairings")
            devices = EquipmentRules.panels(list.data ?? [], profileId: container.profileId)
        } catch {
            notice = message(error)
        }
    }

    private func message(_ error: Error) -> String {
        if let e = error as? QueueError { return ModuleFailure.message(e) }
        if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized() }
        return APIError.describe(error)
    }

    private func act(_ block: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await block(); notice = nil } catch { notice = message(error) }
    }

    func createDisplay(name: String, queue: Bool) async {
        await act {
            let created: CreatedDisplay = try await api.send("POST", "queue/displays", ["name": String(name.trimmingCharacters(in: .whitespaces).prefix(60)), "queue_ids": [String]()], key: QueueClient.newKey())
            if let path = created.path { createdLink = WebPanel.url(server: container.session.serverURL?.absoluteString, path: path)?.absoluteString ?? path }
            await load(queue: queue, admin: true)
        }
    }

    func revokeDisplay(_ d: QueueDisplay, queue: Bool) async {
        await act {
            let _: EmptyReply = try await api.send("DELETE", "queue/displays/\(d.id)", [:], key: QueueClient.newKey())
            await load(queue: queue, admin: true)
        }
    }

    func pair(code: String, queue: Bool) async -> Bool {
        var ok = false
        await act {
            guard let profile = container.profileId else { return }
            let found: PairedDevice = try await container.api.request(.post, "api/v1/pairings/lookup", body: PairingLookupBody(user_code: code))
            guard found.client == EquipmentRules.panelClient else {
                notice = "Este código é de outro sistema, não de um painel ou totem. Libere em Sistemas conectados, no painel."
                return
            }
            let _: LooseReply = try await container.api.request(.post, "api/v1/pairings/\(found.id)/approve", body: PairingApproveBody(profile_id: profile, scopes: EquipmentRules.scopes(found)))
            ok = true
            await load(queue: queue, admin: true)
        }
        return ok
    }

    func revokeDevice(_ d: PairedDevice, queue: Bool) async {
        await act {
            let _: LooseReply = try await container.api.request(.delete, "api/v1/pairings/\(d.id)")
            await load(queue: queue, admin: true)
        }
    }
}

/// Equipamentos: painéis de senha (TV pelo link e aparelhos pareados pelo código) e a impressora térmica. Parear e
/// desligar é do administrador; a impressora é deste aparelho.
struct EquipmentView: View {
    @StateObject private var vm = EquipmentViewModel()
    @EnvironmentObject private var container: AppContainer
    @ObservedObject private var feature = ModuleFeature.shared
    @State private var showPrinter = false
    @State private var newDisplay = false
    @State private var displayName = "Painel da recepção"
    @State private var pairing = false
    @State private var code = ""

    private var queue: Bool { feature.isAvailable(ModuleId.queue, container.profileId) }
    private var admin: Bool { feature.isAdmin(container.profileId, sessionIsAdmin: container.user?.isAdmin ?? false) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let link = vm.createdLink {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Painel criado. Abra este link no navegador da TV (ele só aparece agora):").font(Theme.font(13))
                        Text(link).font(Theme.font(13, .semibold)).textSelection(.enabled)
                        HStack {
                            if #available(iOS 16, *), let url = URL(string: link) { ShareLink(item: url) { Label("Enviar", systemImage: "square.and.arrow.up") } }
                            Spacer()
                            Button("Fechar") { vm.createdLink = nil }
                        }
                    }
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.ok.opacity(0.12)))
                }
                SectionCard(title: "Impressora") {
                    Button { showPrinter = true } label: {
                        CardRow(icon: "printer.fill", iconColor: Theme.muted, title: "Impressora térmica", subtitle: "Parear, imprimir um teste e ver a situação", chevron: true, divider: false)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("equipment.printer")
                }
                SectionCard(title: "Painéis de senha", footer: panelsFooter) {
                    if queue && admin {
                        Button { code = ""; pairing = true } label: {
                            CardRow(icon: "ipad", title: "Parear painel ou totem pelo código", subtitle: "No aparelho, escolha “Usar este aparelho como painel ou totem” e digite aqui o código que aparece", chevron: true)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("equipment.pair")
                        Button { displayName = "Painel da recepção"; newDisplay = true } label: {
                            CardRow(icon: "plus", title: "Criar painel de TV", subtitle: "Um link para abrir no navegador da TV", chevron: true, divider: !(vm.devices.isEmpty && vm.displays.isEmpty))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("equipment.newDisplay")
                        ForEach(vm.devices) { d in
                            CardRow(icon: "ipad", iconColor: d.status == "revoked" ? Theme.muted : Theme.ok, title: d.instance_name ?? "Painel ou totem",
                                    subtitle: EquipmentRules.situation(d) + (d.updated.map { " · desde \(BrasiliaTime.shortWithTime($0))" } ?? "")) {
                                if d.status != "revoked" { Button("Desligar") { Task { await vm.revokeDevice(d, queue: queue) } }.foregroundStyle(Theme.danger).disabled(vm.busy) }
                            }
                        }
                        ForEach(vm.displays) { d in
                            CardRow(icon: "tv", iconColor: d.revoked == true ? Theme.muted : Theme.ok, title: d.name ?? "Painel de TV", subtitle: d.revoked == true ? "Desligado" : "Ligado pelo link") {
                                if d.revoked != true { Button("Desligar") { Task { await vm.revokeDisplay(d, queue: queue) } }.foregroundStyle(Theme.danger).disabled(vm.busy) }
                            }
                        }
                    } else {
                        CardRow(icon: "tv", iconColor: Theme.muted, title: queue ? "Só o administrador pareia painéis" : "Fila de senhas desligada", divider: false)
                    }
                }
                if queue && admin { OpenInBrowserRow(path: WebPanel.queueSettings, subtitle: "Filas, guichês, aparência do painel e campanhas") }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Equipamentos")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(queue)-\(admin)") { await vm.load(queue: queue, admin: admin) }
        .sheet(isPresented: $showPrinter) { PrinterScreen { showPrinter = false } }
        .alert("Criar painel de TV", isPresented: $newDisplay) {
            TextField("Nome do painel", text: $displayName)
            Button("Criar") { Task { await vm.createDisplay(name: displayName, queue: queue) } }
            Button("Voltar", role: .cancel) {}
        }
        .alert("Parear painel ou totem", isPresented: $pairing) {
            TextField("Código", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
            Button("Parear") {
                let normalized = EquipmentRules.normalizeCode(code)
                guard EquipmentRules.validCode(normalized) else { vm.notice = "O código tem 8 letras e números, como aparece na tela do aparelho."; return }
                Task { _ = await vm.pair(code: normalized, queue: queue) }
            }
            Button("Voltar", role: .cancel) {}
        } message: {
            Text("Digite o código de 8 letras e números que aparece na tela do aparelho.")
        }
    }

    private var panelsFooter: String? {
        if !queue { return "Um administrador liga a fila de senhas em Gestão → Módulos, no painel." }
        if !admin { return "Peça ao administrador, ou entre com uma conta de administrador." }
        return nil
    }
}

/// "Perguntar ao assistente": abre a conversa interna com o bot da área (a mesma de Equipe → Bots), onde a pessoa pergunta
/// em linguagem natural sobre vendas, estoque, contas e clientes; o bot lê o ERP pelas concessões dadas no painel.
enum AssistantRules {
    static func candidates(_ team: [TeamContact]) -> [TeamContact] {
        team.filter { $0.isBot && $0.enabled != false }.sorted { $0.name.lowercased() < $1.name.lowercased() }
    }

    /// Um bot só: abre direto; mais de um: a pessoa escolhe.
    static func direct(_ team: [TeamContact]) -> TeamContact? {
        let list = candidates(team)
        return list.count == 1 ? list[0] : nil
    }
}

struct AssistantView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @State private var bots: [TeamContact]?
    @State private var error: String?
    @State private var openedOnce = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error {
                    InlineError(text: error) { Task { await load() } }
                } else if let bots {
                    if bots.isEmpty {
                        EmptyStateView(title: "Nenhum bot ligado nesta área", systemImage: "sparkles",
                                       message: "Um administrador cria o bot no painel, em Gestão → Bots, e dá a ele as consultas do ERP.")
                    } else {
                        Text("Pergunte, por exemplo: “quanto vendi hoje?”, “tem shampoo em estoque?”, “quais contas vencem esta semana?”.")
                            .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                        SectionCard {
                            ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
                                Button { push(.internalChat(peer: bot, chatId: nil)) } label: {
                                    CardRow(icon: "sparkles", iconColor: Theme.bot, title: bot.name, chevron: true, divider: index < bots.count - 1)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .accessibilityIdentifier("assistant.list")
                    }
                } else {
                    SkeletonList(rows: 3)
                }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Perguntar ao assistente")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let profile = container.profileId else { return }
        do {
            let team = try await container.api.team(profile)
            bots = AssistantRules.candidates(team)
            error = nil
            // Um bot só: a conversa abre direto (uma vez; voltar mostra a escolha com ele).
            if !openedOnce, let only = AssistantRules.direct(team) {
                openedOnce = true
                push(.internalChat(peer: only, chatId: nil))
            }
        } catch {
            if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized() }
            self.error = APIError.describe(error)
        }
    }
}
