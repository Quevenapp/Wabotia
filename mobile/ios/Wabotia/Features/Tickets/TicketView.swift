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

    func name(for actor: String?) -> String {
        if let actor, actor == container.user?.id { return "Você" }
        return TicketsSupport.actorName(actor, presence: presence)
    }

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
        _ = await perform(pending)
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
            await Workspace.shared.refreshTicketCounts()
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
    case owner, due
    var id: String { rawValue }
}

/// Um ponto da linha do tempo.
private struct TimelineEntry: Identifiable {
    var id: String
    var title: String
    var when: Int64
    var text: String?
    var color: Color
    var icon: String
    var locked = false
}

/// Detalhe do protocolo (mobile/DESIGN.md, seção 8): cabeçalho com número, seletor de estado em pílulas,
/// responsável e prazo; "Abrir conversa"; linha do tempo vertical; campo fixo "Registrar andamento".
struct TicketView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @StateObject private var model: TicketViewModel
    @State private var sheet: TicketSheet?
    @State private var progress = ""
    @State private var progressError: String?
    @FocusState private var focused: Bool
    let ticketId: String

    init(ticketId: String) {
        self.ticketId = ticketId
        _model = StateObject(wrappedValue: TicketViewModel(ticketId: ticketId))
    }

    var body: some View {
        Group {
            if let ticket = model.ticket {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                Group {
                                    header(ticket)
                                    details(ticket)
                                    SecondaryButton(title: "Abrir conversa com \(TicketsSupport.conversationName(model.detail?.conversation))", icon: "bubble.left.and.bubble.right.fill") {
                                        push(.conversation(id: ticket.conversation_id))
                                    }
                                    if let pending = model.pending { pendingCard(pending) }
                                }
                                .padding(.horizontal, 16)
                                timeline(ticket).padding(.horizontal, 16).id("timeline")
                            }
                            .padding(.vertical, 16)
                        }
                        .appScrollDismissesKeyboard()
                        #if DEBUG
                        .onAppear {
                            if let anchor = DemoMode.anchor {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { proxy.scrollTo(anchor, anchor: .top) }
                            }
                        }
                        #endif
                    }
                    progressBar(ticket)
                }
            } else if let error = model.loadError {
                VStack { InlineError(text: error) { Task { await model.load() } }.padding(16); Spacer() }
            } else {
                VStack { Spacer(); ProgressView(); Spacer() }.frame(maxWidth: .infinity)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Protocolo")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task {
            await model.load(quiet: model.ticket != nil)
            #if DEBUG
            if DemoMode.takeSheet("do-progress") != nil {
                _ = await model.update(["text": .string("Coleta agendada com a transportadora para amanhã, das 9h às 12h.")], summary: "andamento")
            }
            #endif
        }
        .sheet(item: $sheet) { item in
            switch item {
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

    // MARK: Cabeçalho

    private func header(_ ticket: Ticket) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text.fill").font(.system(size: 14)).foregroundStyle(Theme.ticket)
                Text(ticket.number).font(Theme.font(16, .bold, design: .monospaced)).foregroundStyle(Theme.ticket)
                Spacer()
                if model.busy { ProgressView() }
            }
            Text(ticket.title.isEmpty ? "Sem título" : ticket.title)
                .font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                ForEach(TicketsSupport.statuses, id: \.self) { status in
                    let selected = ticket.status == status
                    let color = TicketsSupport.statusColor(status)
                    Button {
                        guard !selected else { return }
                        Task { await model.update(["status": .string(status)], summary: "estado \(TicketsSupport.statusTitle(status))") }
                    } label: {
                        Text(TicketsSupport.statusTitle(status))
                            .font(Theme.font(13, .semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, minHeight: 36)
                            .foregroundStyle(selected ? Theme.onBrand : Theme.textSecondary)
                            .background(Capsule().fill(selected ? color : Theme.surface))
                            .overlay(Capsule().stroke(selected ? Color.clear : Theme.divider, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .disabled(model.busy)
        }
    }

    private func details(_ ticket: Ticket) -> some View {
        let due = TicketsSupport.due(for: ticket)
        return SectionCard {
            Button { sheet = .owner } label: {
                CardRow(title: "Responsável", chevron: true) {
                    HStack(spacing: 6) {
                        if let owner = ticket.owner, !owner.isEmpty {
                            AvatarView(name: TicketsSupport.actorName(owner, presence: model.presence), seed: owner, size: 24)
                        }
                        Text(model.name(for: ticket.owner)).font(Theme.font(15)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            if model.canEditDue {
                Button { sheet = .due } label: {
                    CardRow(title: "Prazo", subtitle: ticket.response_due_at != nil ? TicketsSupport.shortDate(ticket.response_due_at) : nil, chevron: true) { TicketDueView(due: due) }
                }
                .buttonStyle(.plain)
                .disabled(model.busy)
            } else {
                // Depois da primeira resposta (ou concluído) o prazo não muda mais.
                CardRow(title: "Prazo") { TicketDueView(due: due) }
            }
            CardRow(title: "Aberto em", value: TicketsSupport.shortDate(ticket.created), divider: ticket.first_response_at != nil)
            if let first = ticket.first_response_at {
                CardRow(title: "Primeira resposta", value: TicketsSupport.shortDate(first), divider: false)
            }
        }
    }

    private func pendingCard(_ pending: TicketViewModel.PendingUpdate) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Pedido sem confirmação: \(pending.summary)", systemImage: "exclamationmark.arrow.circlepath")
                .font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary)
            HStack(spacing: 16) {
                Button("Tentar novamente") { Task { await model.retry() } }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                Button("Abandonar pedido") { model.discardPending() }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.danger)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.warn.opacity(0.14)))
    }

    // MARK: Linha do tempo

    private func entries(_ ticket: Ticket) -> [TimelineEntry] {
        var list = [TimelineEntry(id: "opened", title: "Protocolo aberto", when: ticket.created, text: nil, color: Theme.ticket, icon: "plus")]
        for update in model.updates {
            let isInternal = (update.internal ?? 0) == 1
            list.append(TimelineEntry(id: update.id, title: model.name(for: update.actor), when: update.created, text: update.text, color: isInternal ? Theme.warn : Theme.brand, icon: isInternal ? "lock.fill" : "text.bubble.fill", locked: isInternal))
        }
        if let first = ticket.first_response_at {
            list.append(TimelineEntry(id: "first", title: "Primeira resposta registrada", when: first, text: nil, color: Theme.ok, icon: "checkmark"))
        }
        if ticket.status == "closed" {
            list.append(TimelineEntry(id: "closed", title: "Concluído", when: ticket.updated, text: nil, color: Theme.ok, icon: "checkmark.circle.fill"))
        }
        return list.enumerated().sorted { a, b in a.element.when != b.element.when ? a.element.when < b.element.when : a.offset < b.offset }.map(\.element)
    }

    private func timeline(_ ticket: Ticket) -> some View {
        let list = entries(ticket)
        return VStack(alignment: .leading, spacing: 8) {
            Text("LINHA DO TEMPO").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 2)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(list.enumerated()), id: \.element.id) { index, entry in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(spacing: 0) {
                            Image(systemName: entry.icon)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(Theme.onBrand)
                                .frame(width: 24, height: 24)
                                .background(Circle().fill(entry.color))
                            if index < list.count - 1 { Theme.divider.frame(width: 2).frame(maxHeight: .infinity) }
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(entry.title).font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                if entry.locked { Pill(text: "Interno", color: Theme.noteText, icon: "lock.fill") }
                                Spacer(minLength: 4)
                                Text(TicketsSupport.shortDate(entry.when)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                            }
                            if let text = entry.text, !text.isEmpty {
                                Text(text)
                                    .font(Theme.font(15))
                                    .foregroundStyle(Theme.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(10)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(entry.locked ? Theme.bubbleNote : Theme.surface))
                            }
                        }
                        .padding(.top, 3)
                        .padding(.bottom, index < list.count - 1 ? 16 : 0)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Registrar andamento

    private func progressBar(_ ticket: Ticket) -> some View {
        let trimmed = progress.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: 5) {
            if let progressError { InlineError(text: progressError) }
            HStack(alignment: .bottom, spacing: 8) {
                progressField
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.field))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.divider, lineWidth: 1))
                Button {
                    focused = false
                    progressError = nil
                    Task {
                        if await model.update(["text": .string(trimmed)], summary: "andamento") {
                            progress = ""
                            Haptics.light()
                            Workspace.shared.show("Andamento registrado", style: .success)
                        } else if let message = model.takeFailureMessage() {
                            progressError = message
                        }
                    }
                } label: {
                    Group { if model.busy { ProgressView().progressViewStyle(CircularProgressViewStyle(tint: Theme.onBrand)) } else { Image(systemName: "paperplane.fill").font(.system(size: 16, weight: .semibold)) } }
                        .foregroundStyle(Theme.onBrand)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Theme.ticket))
                        .opacity(trimmed.isEmpty ? 0.4 : 1)
                }
                .buttonStyle(.plain)
                .disabled(trimmed.isEmpty || model.busy)
                .accessibilityLabel("Registrar andamento")
            }
            Text(model.isResponsible ? "O cliente recebe: \"Protocolo \(ticket.number): texto\"." : "Somente o responsável ou um administrador pode alterar o protocolo.")
                .font(Theme.font(11)).foregroundStyle(Theme.textSecondary).lineLimit(1).minimumScaleFactor(0.85).padding(.horizontal, 4)
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ThinDivider() }
    }

    @ViewBuilder private var progressField: some View {
        if #available(iOS 16, *) {
            AppMultilineField("Registrar andamento", text: $progress, lines: 1...4, font: Theme.font(16))
                .focused($focused).padding(.horizontal, 14).padding(.vertical, 9).frame(minHeight: 40)
        } else {
            AppMultilineField("Registrar andamento", text: $progress, lines: 1...4, font: Theme.font(16))
                .focused($focused).padding(.horizontal, 9).padding(.vertical, 1).frame(minHeight: 40)
        }
    }
}

// MARK: - Folhas de ação

/// Escolha do responsável entre as pessoas do perfil (GET /presence), mostrando presença.
struct TicketOwnerSheet: View {
    @ObservedObject var model: TicketViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var saving: String?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Responsável") { dismiss() }
            ScrollView {
                VStack(spacing: 0) {
                    if let error { InlineError(text: error).padding(.horizontal, 16).padding(.bottom, 8) }
                    if model.presence.isEmpty {
                        Text("Nenhuma pessoa encontrada neste perfil.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary).padding(24)
                    }
                    ForEach(model.presence) { person in
                        let online = person.present == 1
                        Button { choose(person) } label: {
                            HStack(spacing: 12) {
                                AvatarView(name: person.name.isEmpty ? "?" : person.name, seed: person.actor, size: 44, badge: .presence(online))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.name.isEmpty ? person.actor : person.name).font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                    Text(online ? "Online" : "Offline").font(Theme.font(13)).foregroundStyle(online ? Theme.ok : Theme.textSecondary)
                                }
                                Spacer()
                                if saving == person.actor {
                                    ProgressView()
                                } else if model.ticket?.owner == person.actor {
                                    Image(systemName: "checkmark.circle.fill").font(.system(size: 22)).foregroundStyle(Theme.brand)
                                }
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: 64)
                            .contentShape(Rectangle())
                            .overlay(alignment: .bottom) { ThinDivider(leading: 72) }
                        }
                        .buttonStyle(.plain)
                        .disabled(saving != nil)
                    }
                    Text("O novo responsável recebe as notificações do protocolo.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).frame(maxWidth: .infinity, alignment: .leading).padding(16)
                }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .interactiveDismissDisabled(saving != nil)
        .appSheetDetents()
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
        VStack(spacing: 0) {
            SheetHeader(title: "Prazo da primeira resposta") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        shortcut("+1 h") { date = Date().addingTimeInterval(3600) }
                        shortcut("+4 h") { date = Date().addingTimeInterval(4 * 3600) }
                        shortcut("Amanhã 9h") { date = tomorrowAtNine() }
                    }
                    DatePicker("Prazo", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                        .datePickerStyle(.compact)
                        .font(Theme.font(16))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 52)
                        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                    Text("Vale para a primeira resposta ao cliente. Depois dela o prazo não pode ser alterado.")
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                    if let error { InlineError(text: error) }
                    PrimaryButton(title: "Salvar prazo", busy: saving) { save(date) }
                    if model.ticket?.response_due_at != nil {
                        Button("Remover prazo") { save(nil) }
                            .font(Theme.font(15, .semibold)).foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, minHeight: Theme.touch)
                            .disabled(saving)
                    }
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .interactiveDismissDisabled(saving)
        .appSheetDetents()
        .onAppear {
            if let current = TicketsSupport.date(model.ticket?.response_due_at), current > Date() {
                date = current
            } else {
                date = Date().addingTimeInterval(3600)
            }
        }
    }

    private func shortcut(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Capsule().fill(Theme.brand.opacity(0.12)))
        }
        .buttonStyle(.plain)
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
