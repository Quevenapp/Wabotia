import SwiftUI

/// Detalhe do protocolo (GET /profiles/{p}/tickets/{id}) e ações via PATCH com Idempotency-Key.
/// Cada intenção gera uma chave; falha de rede mantém chave e corpo para repetir ("Tentar novamente").
@MainActor
final class TicketViewModel: ObservableObject {
    struct Failure: Identifiable {
        let id = UUID()
        var message: String
        var retryable: Bool
    }

    struct PendingUpdate {
        var fields: [String: JSONValue]
        var key: String
        var summary: String
    }

    let ticketId: String
    @Published private(set) var detail: TicketDetail?
    @Published private(set) var presence: [PresenceEntry] = []
    @Published private(set) var loading = false
    @Published private(set) var busy = false
    @Published var loadError: String?
    @Published var failure: Failure?
    @Published private(set) var pending: PendingUpdate?

    init(ticketId: String) { self.ticketId = ticketId }

    private var container: AppContainer { AppContainer.shared }
    var ticket: Ticket? { detail?.ticket }
    var updates: [TicketUpdate] { (detail?.updates ?? []).sorted { $0.created < $1.created } }

    /// O prazo só pode mudar antes da primeira resposta e enquanto o protocolo não estiver concluído.
    var canEditDue: Bool {
        guard let t = ticket else { return false }
        return t.first_response_at == nil && t.status != "closed"
    }

    /// Dica local; a decisão final é do servidor ("Somente o responsável pode alterar o protocolo").
    var isResponsible: Bool {
        guard let user = container.user else { return false }
        return user.isAdmin || (ticket?.owner != nil && ticket?.owner == user.id)
    }

    func name(for actor: String?) -> String { TicketsSupport.actorName(actor, presence: presence) }

    func load(quiet: Bool = false) async {
        guard let profile = container.profileId else { return }
        if !quiet { loading = true }
        loadError = nil
        let api = container.api
        let id = ticketId
        do {
            async let detailRequest = api.ticket(profile, id: id)
            async let presenceRequest = api.presence(profile)
            let loaded = try await detailRequest
            if Task.isCancelled { return }
            detail = loaded
            if let list = try? await presenceRequest { presence = list }
        } catch {
            if Task.isCancelled { return }
            if let message = TicketsSupport.failure(error) { loadError = message }
        }
        loading = false
    }

    /// Envia o PATCH com uma chave nova para esta intenção.
    @discardableResult
    func update(_ fields: [String: JSONValue], summary: String) async -> Bool {
        await perform(PendingUpdate(fields: fields, key: APIClient.newIdempotencyKey(), summary: summary))
    }

    /// Repete o pedido pendente com a MESMA chave e o mesmo corpo.
    func retry() async {
        guard let pending else { return }
        await perform(pending)
    }

    func discardPending() { pending = nil }

    /// Lê e limpa a falha atual (usada pelas folhas para mostrar o erro no próprio contexto).
    func takeFailureMessage() -> String? {
        let message = failure?.message
        failure = nil
        return message
    }

    private func perform(_ request: PendingUpdate) async -> Bool {
        guard let profile = container.profileId, !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            let updated = try await container.api.updateTicket(profile, id: ticketId, fields: request.fields, key: request.key)
            pending = nil
            if var d = detail { d.ticket = updated; detail = d }
            await load(quiet: true)
            return true
        } catch {
            guard let message = TicketsSupport.failure(error) else { return false }
            if let apiError = error as? APIError {
                // O servidor respondeu: não há o que repetir com a mesma chave.
                pending = nil
                if apiError.isIdempotencyConflict {
                    failure = Failure(message: "Este pedido já foi enviado com outro conteúdo. Confira o protocolo e tente de novo.", retryable: false)
                } else {
                    failure = Failure(message: message, retryable: false)
                }
                await load(quiet: true)
            } else {
                // Falha de rede: o pedido pode ter sido aceito; repetir com a mesma chave é seguro.
                pending = request
                failure = Failure(message: message, retryable: true)
            }
            return false
        }
    }
}

private enum TicketSheet: String, Identifiable {
    case progress, owner, due
    var id: String { rawValue }
}

struct TicketView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: TicketViewModel
    @State private var sheet: TicketSheet?
    let ticketId: String

    init(ticketId: String) {
        self.ticketId = ticketId
        _model = StateObject(wrappedValue: TicketViewModel(ticketId: ticketId))
    }

    var body: some View {
        Group {
            if let ticket = model.ticket {
                content(ticket)
            } else if let error = model.loadError {
                VStack(spacing: 16) {
                    EmptyStateView(title: "Não foi possível carregar", systemImage: "exclamationmark.triangle", message: error)
                    Button("Tentar novamente") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.ticket?.number ?? "Protocolo")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(quiet: model.ticket != nil) }
        .sheet(item: $sheet) { item in
            switch item {
            case .progress: TicketProgressSheet(model: model)
            case .owner: TicketOwnerSheet(model: model)
            case .due: TicketDueSheet(model: model)
            }
        }
        .alert("Não foi possível atualizar", isPresented: failurePresented, presenting: model.failure) { failure in
            if failure.retryable {
                Button("Tentar novamente") { Task { await model.retry() } }
                Button("Descartar", role: .cancel) { model.discardPending() }
            } else {
                Button("OK", role: .cancel) {}
            }
        } message: { failure in
            Text(failure.message)
        }
    }

    private var failurePresented: Binding<Bool> {
        Binding(get: { model.failure != nil }, set: { if !$0 { model.failure = nil } })
    }

    private func content(_ ticket: Ticket) -> some View {
        List {
            summarySection(ticket)
            conversationSection(ticket)
            actionsSection(ticket)
            timelineSection(ticket)
        }
        .refreshable { await model.load(quiet: true) }
        .overlay(alignment: .bottom) {
            if model.busy {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Atualizando…").font(.footnote)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule())
                .padding()
            }
        }
    }

    private func summarySection(_ ticket: Ticket) -> some View {
        let due = TicketsSupport.due(for: ticket)
        return Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(ticket.title.isEmpty ? "Sem título" : ticket.title).font(.headline)
                HStack(spacing: 8) {
                    TicketStatusBadge(status: ticket.status)
                    Spacer()
                    Label(due.text, systemImage: due.icon).font(.footnote).foregroundStyle(due.color)
                }
            }
            .padding(.vertical, 4)
            LabeledContent("Número", value: ticket.number)
            LabeledContent("Aberto em", value: TicketsSupport.shortDate(ticket.created))
            LabeledContent("Atualizado", value: TicketsSupport.shortDate(ticket.updated))
            LabeledContent("Prazo da primeira resposta", value: ticket.response_due_at == nil ? "Sem prazo" : TicketsSupport.shortDate(ticket.response_due_at))
            if let first = ticket.first_response_at {
                LabeledContent("Primeira resposta", value: TicketsSupport.shortDate(first))
            }
        }
    }

    private func conversationSection(_ ticket: Ticket) -> some View {
        Section("Conversa") {
            NavigationLink(value: Route.conversation(id: ticket.conversation_id)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(TicketsSupport.conversationName(model.detail?.conversation))
                    HStack(spacing: 6) {
                        if let phone = model.detail?.conversation?["phone"]?.stringValue, !phone.isEmpty {
                            Text(phone)
                        }
                        let state = TicketsSupport.conversationStateTitle(model.detail?.conversation?["state"]?.stringValue)
                        if !state.isEmpty { Text("· \(state)") }
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func actionsSection(_ ticket: Ticket) -> some View {
        Section {
            Button { sheet = .progress } label: {
                Label("Registrar andamento", systemImage: "text.bubble")
            }
            Picker(selection: statusBinding(ticket)) {
                ForEach(TicketsSupport.statuses, id: \.self) { status in
                    Text(TicketsSupport.statusTitle(status)).tag(status)
                }
            } label: {
                Label("Estado", systemImage: "flag")
            }
            Button { sheet = .owner } label: {
                HStack {
                    Label("Responsável", systemImage: "person.crop.circle")
                    Spacer()
                    Text(model.name(for: ticket.owner)).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
            }
            if model.canEditDue {
                Button { sheet = .due } label: {
                    HStack {
                        Label(ticket.response_due_at == nil ? "Definir prazo" : "Ajustar prazo", systemImage: "clock")
                        Spacer()
                        if let due = ticket.response_due_at {
                            Text(TicketsSupport.shortDate(due)).foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
            if let pending = model.pending {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Pedido pendente: \(pending.summary)", systemImage: "exclamationmark.arrow.circlepath")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    HStack {
                        Button("Tentar novamente") { Task { await model.retry() } }
                        Button("Abandonar pedido", role: .destructive) { model.discardPending() }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        } header: {
            Text("Ações")
        } footer: {
            Text(model.isResponsible
                 ? "O andamento é enviado ao cliente como \"Protocolo \(ticket.number): texto\". O prazo só muda antes da primeira resposta."
                 : "Somente o responsável ou um administrador pode alterar o protocolo.")
        }
        .disabled(model.busy)
    }

    private func statusBinding(_ ticket: Ticket) -> Binding<String> {
        Binding(
            get: { ticket.status },
            set: { newValue in
                guard newValue != ticket.status else { return }
                Task { await model.update(["status": .string(newValue)], summary: "estado \(TicketsSupport.statusTitle(newValue))") }
            }
        )
    }

    private func timelineSection(_ ticket: Ticket) -> some View {
        Section("Linha do tempo") {
            TicketTimelineRow(icon: "plus.circle", color: .blue, title: "Protocolo aberto", when: TicketsSupport.shortDate(ticket.created), text: nil)
            ForEach(model.updates) { update in
                TicketTimelineRow(icon: "text.bubble", color: .accentColor, title: model.name(for: update.actor), when: TicketsSupport.shortDate(update.created), text: update.text)
            }
            if let first = ticket.first_response_at {
                TicketTimelineRow(icon: "checkmark.bubble", color: .green, title: "Primeira resposta registrada", when: TicketsSupport.shortDate(first), text: nil)
            }
            if ticket.status == "closed" {
                TicketTimelineRow(icon: "checkmark.circle", color: .green, title: "Concluído", when: TicketsSupport.shortDate(ticket.updated), text: nil)
            }
        }
    }
}

struct TicketTimelineRow: View {
    let icon: String
    let color: Color
    let title: String
    let when: String
    let text: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(title).font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(when).font(.caption).foregroundStyle(.secondary)
                }
                if let text, !text.isEmpty {
                    Text(text).font(.body).textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Folhas de ação

/// Registrar andamento: `text` vai ao cliente como "Protocolo WA-…: texto" e entra na linha do tempo.
struct TicketProgressSheet: View {
    @ObservedObject var model: TicketViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("O que foi feito ou o que o cliente precisa saber", text: $text, axis: .vertical)
                        .lineLimit(4...10)
                        .focused($focused)
                } footer: {
                    Text("Enviado ao cliente como \"Protocolo \(model.ticket?.number ?? ""): texto\" e registrado como primeira resposta, se ainda não houver.")
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Registrar andamento")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    if sending { ProgressView() } else { Button("Enviar") { send() }.disabled(trimmed.isEmpty) }
                }
            }
            .interactiveDismissDisabled(sending)
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private func send() {
        sending = true
        error = nil
        Task { @MainActor in
            let ok = await model.update(["text": .string(trimmed)], summary: "andamento")
            sending = false
            if ok { dismiss() } else { error = model.takeFailureMessage() }
        }
    }
}

/// Escolha do responsável entre as pessoas do perfil (GET /presence), mostrando presença.
struct TicketOwnerSheet: View {
    @ObservedObject var model: TicketViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var saving: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                Section {
                    if model.presence.isEmpty {
                        Text("Nenhuma pessoa encontrada neste perfil.").foregroundStyle(.secondary)
                    }
                    ForEach(model.presence) { person in
                        Button { choose(person) } label: {
                            HStack(spacing: 12) {
                                Circle()
                                    .fill(person.present == 1 ? Color.green : Color.gray.opacity(0.5))
                                    .frame(width: 10, height: 10)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.name.isEmpty ? person.actor : person.name).foregroundStyle(.primary)
                                    Text(person.present == 1 ? "Presente" : "Ausente").font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if saving == person.actor {
                                    ProgressView()
                                } else if model.ticket?.owner == person.actor {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .disabled(saving != nil)
                    }
                } footer: {
                    Text("O novo responsável recebe as notificações do protocolo.")
                }
            }
            .navigationTitle("Responsável")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() }.disabled(saving != nil) }
            }
            .interactiveDismissDisabled(saving != nil)
        }
        .presentationDetents([.medium, .large])
    }

    private func choose(_ person: PresenceEntry) {
        guard person.actor != model.ticket?.owner else { dismiss(); return }
        saving = person.actor
        error = nil
        Task { @MainActor in
            let ok = await model.update(["owner": .string(person.actor)], summary: "responsável \(person.name)")
            saving = nil
            if ok { dismiss() } else { error = model.takeFailureMessage() }
        }
    }
}

/// Prazo da primeira resposta: DatePicker; "Remover prazo" envia `response_due_at: null`.
struct TicketDueSheet: View {
    @ObservedObject var model: TicketViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var date = Date()
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Prazo", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                        .datePickerStyle(.graphical)
                } footer: {
                    Text("Vale para a primeira resposta ao cliente. Depois dela o prazo não pode ser alterado.")
                }
                Section("Atalhos") {
                    HStack {
                        Button("+1 h") { date = Date().addingTimeInterval(3600) }
                        Spacer()
                        Button("+4 h") { date = Date().addingTimeInterval(4 * 3600) }
                        Spacer()
                        Button("Amanhã 9h") { date = tomorrowAtNine() }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                if model.ticket?.response_due_at != nil {
                    Section {
                        Button("Remover prazo", role: .destructive) { save(nil) }
                    }
                }
            }
            .navigationTitle("Prazo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button("Salvar") { save(date) } }
                }
            }
            .interactiveDismissDisabled(saving)
            .disabled(saving)
            .onAppear {
                if let current = TicketsSupport.date(model.ticket?.response_due_at), current > Date() {
                    date = current
                } else {
                    date = Date().addingTimeInterval(3600)
                }
            }
        }
    }

    private func tomorrowAtNine() -> Date {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    /// `nil` remove o prazo (JSON `null`); uma data envia Unix em milissegundos.
    private func save(_ value: Date?) {
        saving = true
        error = nil
        let field: JSONValue
        if let value { field = JSONValue.number(Double(TicketsSupport.millis(value))) } else { field = JSONValue.null }
        let summary = value == nil ? "remover prazo" : "prazo \(TicketsSupport.shortDate(value ?? Date()))"
        Task { @MainActor in
            let ok = await model.update(["response_due_at": field], summary: summary)
            saving = false
            if ok { dismiss() } else { error = model.takeFailureMessage() }
        }
    }
}
