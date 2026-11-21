import SwiftUI

/*
 * Clientes do atendimento (o cadastro de contatos da área, `GET/POST/PATCH /contacts`), só o básico: nome, telefone,
 * e-mail e observação. Ficha completa, importação, mesclagem e ERP ficam no painel. Mesmo desenho do Android
 * (`modules/clientes/ClientesScreens.kt`).
 */

struct BasicContact: Decodable, Equatable, Identifiable {
    let id: String
    var name: String? = nil
    var phone: String? = nil
    var email: String? = nil
    var notes: String? = nil
    var version: Int? = nil

    var title: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return PhoneText.display(phone) ?? "Sem nome"
    }
}

private struct BasicContactPage: Decodable { var data: [BasicContact]? }

/// Regras do formulário, sem rede (as mesmas mensagens do servidor).
enum ContactForm {
    static func problem(name: String, phone: String, email: String, notes: String) -> String? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return "Informe o nome do cliente." }
        if n.count > 200 { return "Nome: use até 200 caracteres." }
        let digits = phone.filter(\.isNumber).count
        if !phone.trimmingCharacters(in: .whitespaces).isEmpty, !(8...15).contains(digits) { return "Telefone: informe de 8 a 15 dígitos, com DDD." }
        let e = email.trimmingCharacters(in: .whitespaces)
        if !e.isEmpty, e.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) == nil { return "E-mail inválido." }
        if notes.count > 2000 { return "Observação: use até 2000 caracteres." }
        return nil
    }

    /// Corpo do cadastro (`phone_mode: human_br`: aceita "(11) 99999-0000"). Na edição, vai a versão esperada.
    static func body(name: String, phone: String, email: String, notes: String, version: Int? = nil) -> [String: Any?] {
        [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "phone": phone.trimmingCharacters(in: .whitespaces),
            "email": email.trimmingCharacters(in: .whitespaces),
            "notes": notes.trimmingCharacters(in: .whitespacesAndNewlines),
            "phone_mode": "human_br",
            "expected_version": version,
        ]
    }

    static func message(_ error: Error) -> String {
        if let e = error as? QueueError, e.status == 403 { return "Seu acesso não inclui o cadastro de clientes. Peça ao administrador em Gestão → Pessoas e acessos." }
        if let e = error as? QueueError, e.status == 409, !e.moduleDisabled { return "O cadastro mudou em outro aparelho. Volte e abra o cliente de novo." }
        return ModuleFailure.message(error)
    }
}

final class ClientesClient {
    let api: ProfileAPI
    init(api: ProfileAPI) { self.api = api }

    func list(_ query: String) async throws -> [BasicContact] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let page: BasicContactPage = try await api.get("contacts", query: ["limit": "50", "q": q.isEmpty ? nil : q])
        return page.data ?? []
    }

    func get(_ id: String) async throws -> BasicContact { try await api.get("contacts/\(id)") }

    func create(_ body: [String: Any?], key: String) async throws -> BasicContact { try await api.send("POST", "contacts", body, key: key) }

    func update(_ id: String, _ body: [String: Any?], key: String) async throws -> BasicContact { try await api.send("PATCH", "contacts/\(id)", body, key: key) }
}

@MainActor
final class ClientesViewModel: ObservableObject {
    @Published var query = ""
    @Published private(set) var items: [BasicContact] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    private let client = ClientesClient(api: .current())

    func load() async {
        do {
            items = try await client.list(query)
            error = nil
        } catch {
            if let e = error as? QueueError, e.unauthorized { AppContainer.shared.handleUnauthorized() }
            self.error = ContactForm.message(error)
        }
        loading = false
    }
}

struct ClientesView: View {
    @StateObject private var vm = ClientesViewModel()
    @FocusState private var focused: Bool
    @Environment(\.pushRoute) private var push

    var body: some View {
        VStack(spacing: 0) {
            SearchField(placeholder: "Buscar por nome, telefone ou e-mail", text: $vm.query, focused: $focused).padding(12)
            if vm.loading {
                SkeletonList(rows: 6)
            } else if let error = vm.error {
                InlineError(text: error) { Task { await vm.load() } }.padding(16)
                Spacer()
            } else if vm.items.isEmpty {
                EmptyStateView(title: vm.query.isEmpty ? "Nenhum cliente cadastrado" : "Nenhum cliente encontrado", systemImage: "person.2",
                               message: "Toque em + para cadastrar com nome e telefone.")
            } else {
                ScrollView {
                    SectionCard {
                        ForEach(Array(vm.items.enumerated()), id: \.element.id) { index, contact in
                            Button { push(.cliente(id: contact.id)) } label: {
                                let detail = [PhoneText.display(contact.phone), contact.email?.isEmpty == false ? contact.email : nil].compactMap { $0 }.joined(separator: " · ")
                                CardRow(icon: "person.fill", title: contact.title, subtitle: detail.isEmpty ? nil : detail, chevron: true, divider: index < vm.items.count - 1)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
                .accessibilityIdentifier("clientes.list")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Clientes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { push(.cliente(id: nil)) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Novo cliente")
                    .accessibilityIdentifier("clientes.new")
            }
        }
        // Ao voltar do cadastro, a lista relê (a busca também relê, com uma pausa curta).
        .onAppear { Task { await vm.load() } }
        .task(id: vm.query) {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await vm.load()
        }
        .refreshable { await vm.load() }
    }
}

@MainActor
final class ClienteFormViewModel: ObservableObject {
    let id: String?
    @Published var name = ""
    @Published var phone = ""
    @Published var email = ""
    @Published var notes = ""
    @Published private(set) var loading: Bool
    @Published private(set) var saving = false
    @Published var notice: String?
    private var version = 1
    private let keys = IntentKeys()
    private let client = ClientesClient(api: .current())

    init(id: String?) {
        self.id = id
        loading = id != nil
    }

    var problem: String? { ContactForm.problem(name: name, phone: phone, email: email, notes: notes) }

    func load() async {
        guard let id, loading else { return }
        do {
            let c = try await client.get(id)
            name = c.name ?? ""; phone = c.phone ?? ""; email = c.email ?? ""; notes = c.notes ?? ""; version = c.version ?? 1
        } catch {
            notice = ContactForm.message(error)
        }
        loading = false
    }

    func save() async -> Bool {
        guard !saving, problem == nil else { return false }
        let body = ContactForm.body(name: name, phone: phone, email: email, notes: notes, version: id == nil ? nil : version)
        let signature = "\(id ?? "new")|\(name)|\(phone)|\(email)|\(notes)|\(version)"
        let key = keys.key(for: signature)
        saving = true
        defer { saving = false }
        do {
            if let id { _ = try await client.update(id, body, key: key) } else { _ = try await client.create(body, key: key) }
            keys.settle(nil)
            return true
        } catch {
            keys.settle(error)
            if let e = error as? QueueError, e.unauthorized { AppContainer.shared.handleUnauthorized() }
            notice = ContactForm.message(error) + ((error as? QueueError)?.retryable == true ? " Toque de novo para repetir com segurança." : "")
            return false
        }
    }
}

struct ClienteFormView: View {
    @StateObject private var vm: ClienteFormViewModel
    @Environment(\.dismiss) private var dismiss

    init(id: String?) { _vm = StateObject(wrappedValue: ClienteFormViewModel(id: id)) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if vm.loading {
                    SkeletonList(rows: 4, avatar: false)
                } else {
                    AuthField(label: "Nome") { TextField("Nome do cliente", text: $vm.name).accessibilityIdentifier("cliente.name") }
                    AuthField(label: "Telefone com DDD (opcional)") { TextField("(11) 90000-0000", text: $vm.phone).keyboardType(.phonePad).accessibilityIdentifier("cliente.phone") }
                    AuthField(label: "E-mail (opcional)") {
                        TextField("cliente@exemplo.com", text: $vm.email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("cliente.email")
                    }
                    AuthField(label: "Observação (opcional)") { TextField("Ex.: prefere sábado de manhã", text: $vm.notes).accessibilityIdentifier("cliente.notes") }
                    if let problem = vm.problem, !(vm.name.isEmpty && vm.phone.isEmpty && vm.email.isEmpty) {
                        Text(problem).font(Theme.font(13)).foregroundStyle(Theme.danger)
                    }
                    if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                    PrimaryButton(title: "Salvar", busy: vm.saving, disabled: vm.problem != nil) {
                        Task { if await vm.save() { dismiss() } }
                    }
                    .accessibilityIdentifier("cliente.save")
                    Text("Documento, endereço, histórico e o cadastro do ERP ficam no painel, em Contatos.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.id == nil ? "Novo cliente" : "Cliente")
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load() }
    }
}
