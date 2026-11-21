import Foundation

/// O que fazer com uma recusa que vale para o app inteiro: 401 volta ao login, 409 `module_disabled` esconde o módulo.
enum ModuleFailure {
    @MainActor
    static func handler(_ module: String, container: AppContainer = .shared) -> (QueueError) -> Void {
        let profile = container.profileId ?? ""
        return { error in
            if error.unauthorized { container.handleUnauthorized() }
            if error.moduleDisabled { ModuleFeature.shared.markDisabled(module, profile: profile) }
        }
    }

    static let disabledMessage = "Este módulo está desligado neste Vinki. Um administrador liga em Gestão → Módulos."

    static func message(_ error: Error) -> String {
        if let e = error as? QueueError, e.moduleDisabled { return disabledMessage }
        return QueueError.describe(error)
    }
}

/// Agenda do dia (uma coluna por profissional) ou da semana, com filtro por profissional.
@MainActor
final class AgendaViewModel: ObservableObject {
    enum Mode: String, CaseIterable, Identifiable {
        case day, week
        var id: String { rawValue }
        var label: String { self == .day ? "Dia" : "Semana" }
    }

    @Published var mode: Mode = .day
    @Published var day: String
    /// `nil`: todos.
    @Published var professionalId: String?
    @Published var showCancelled = false
    @Published private(set) var catalog: AgendaCatalog?
    @Published private(set) var appointments: [Appointment] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?

    private let client: AgendaClient
    private let onFailure: (QueueError) -> Void
    private var events: ModuleEvents?
    private var generation = 0

    init(client: AgendaClient, today: String = BrasiliaTime.today(), onFailure: @escaping (QueueError) -> Void) {
        self.client = client
        self.day = today
        self.onFailure = onFailure
    }

    convenience init() {
        self.init(client: AgendaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.agenda))
    }

    /// Recarrega sozinha com os eventos `agenda.*` enquanto a tela está aberta.
    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "agenda.") { [weak self] in await self?.load() }
    }

    var professionals: [AgendaProfessional] { AgendaRules.professionals(for: nil, in: catalog?.professionals ?? []) }

    /// Primeiro dia mostrado (o próprio dia, ou a segunda-feira da semana).
    var rangeStart: String { mode == .day ? day : BrasiliaTime.weekStart(day) }

    var visible: [Appointment] {
        appointments.filter { (showCancelled || $0.state != "cancelled") && (professionalId == nil || $0.professionalId == professionalId) }
    }

    var columns: [(professional: AgendaProfessional, items: [Appointment])] {
        let list = AgendaRules.columns(visible.filter { $0.day == day }, professionals: catalog?.professionals ?? [])
        return professionalId == nil ? list : list.filter { $0.professional.id == professionalId }
    }

    var week: [(day: String, items: [Appointment])] { AgendaRules.week(visible, start: rangeStart) }

    func load() async {
        generation += 1
        let mine = generation
        if appointments.isEmpty { loading = true }
        do {
            if catalog == nil { catalog = try await client.catalog() }
            guard let range = BrasiliaTime.range(from: rangeStart, days: mode == .day ? 1 : 7) else { return }
            let list = try await client.appointments(from: range.from, to: range.to)
            guard mine == generation else { return }
            appointments = list
            error = nil
        } catch {
            guard mine == generation else { return }
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
        loading = false
    }

    func shift(_ direction: Int) {
        day = BrasiliaTime.addDays(day, direction * (mode == .day ? 1 : 7))
        Task { await load() }
    }

    func goToday() {
        day = BrasiliaTime.today()
        Task { await load() }
    }

    func setMode(_ mode: Mode) {
        guard self.mode != mode else { return }
        self.mode = mode
        appointments = []
        Task { await load() }
    }
}

/// Detalhe de um agendamento: confirmar, cancelar e marcar ausência (remarcar abre o `BookingViewModel`).
@MainActor
final class AppointmentViewModel: ObservableObject {
    @Published private(set) var appointment: Appointment?
    @Published private(set) var loading = false
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var done: String?

    let id: String
    private let client: AgendaClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var events: ModuleEvents?

    init(id: String, appointment: Appointment? = nil, client: AgendaClient, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.appointment = appointment
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: AgendaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.agenda))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "agenda.") { [weak self] in await self?.load() }
    }

    func load() async {
        if appointment == nil { loading = true }
        do {
            appointment = try await client.appointment(id)
            if busy == nil { notice = nil }
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            if appointment == nil { notice = ModuleFailure.message(error) }
        }
        loading = false
    }

    func confirm() { run("confirm", success: "Agendamento confirmado") { [client, id] key in try await client.confirm(id, key: key) } }
    func noShow() { run("no-show", success: "Ausência registrada") { [client, id] key in try await client.noShow(id, key: key) } }
    func cancel(reason: String) {
        let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        run("cancel", success: "Agendamento cancelado") { [client, id] key in try await client.cancel(id, reason: text.isEmpty ? nil : text, key: key) }
    }

    /// Depois de remarcar (o `BookingViewModel` devolve o agendamento novo).
    func replace(_ appointment: Appointment) {
        self.appointment = appointment
        done = "Agendamento remarcado"
    }

    private func run(_ action: String, success: String, _ block: @escaping (String) async throws -> Appointment) {
        guard busy == nil else { return }
        let key = keys.key(for: "\(action):\(id)")
        busy = action
        notice = nil
        Task {
            do {
                appointment = try await block(key)
                keys.settle(nil)
                done = success
            } catch {
                keys.settle(error)
                if let e = error as? QueueError { onFailure(e) }
                let retry = (error as? QueueError)?.retryable == true
                notice = ModuleFailure.message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
                if !retry { await load() }
            }
            busy = nil
        }
    }

    var pendingKey: String? { keys.pendingKey }
}

/// Novo agendamento (para um cliente, ou para a conversa aberta) e remarcação: serviço, profissional, dia e um dos
/// horários livres da rota de disponibilidade. Diante de `slot_taken`/`slot_unavailable`, recarrega os horários.
@MainActor
final class BookingViewModel: ObservableObject {
    enum Purpose: Equatable {
        case new(conversationId: String?, customer: String?)
        case move(Appointment)
    }

    static let conflictMessage = "Esse horário acabou de ser ocupado ou deixou de valer. Escolha outro entre os horários livres."

    let purpose: Purpose
    @Published private(set) var catalog: AgendaCatalog?
    @Published var serviceId: String? { didSet { if oldValue != serviceId { professionalChanged() } } }
    /// `nil`: qualquer profissional livre.
    @Published var professionalId: String?
    @Published var day: String
    @Published private(set) var slots: [AgendaSlot] = []
    @Published var slot: AgendaSlot?
    @Published private(set) var loadingSlots = false
    @Published var customerName = ""
    @Published var customerPhone = ""
    @Published var notes = ""
    @Published private(set) var busy = false
    @Published var notice: String?
    @Published private(set) var result: Appointment?

    private let client: AgendaClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var slotsGeneration = 0

    init(purpose: Purpose, client: AgendaClient, today: String = BrasiliaTime.today(), onFailure: @escaping (QueueError) -> Void) {
        self.purpose = purpose
        self.client = client
        self.onFailure = onFailure
        switch purpose {
        case .new:
            day = today
        case .move(let a):
            day = max(a.day, today)
            serviceId = a.serviceId
            professionalId = a.professionalId
        }
    }

    convenience init(purpose: Purpose) {
        self.init(purpose: purpose, client: AgendaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.agenda))
    }

    var isMove: Bool { if case .move = purpose { return true } else { return false } }
    var conversationId: String? { if case let .new(id, _) = purpose { return id } else { return nil } }
    var services: [AgendaService] { AgendaRules.activeServices(catalog?.services ?? []) }
    var professionals: [AgendaProfessional] { AgendaRules.professionals(for: serviceId, in: catalog?.professionals ?? []) }
    var service: AgendaService? { services.first { $0.id == serviceId } }

    var canSubmit: Bool {
        guard serviceId != nil, slot != nil, !busy else { return false }
        if !isMove, conversationId == nil { return !customerName.trimmingCharacters(in: .whitespaces).isEmpty }
        return true
    }

    func load() async {
        do {
            if catalog == nil { catalog = try await client.catalog() }
            if serviceId == nil { serviceId = services.first?.id }
            await loadSlots()
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            notice = ModuleFailure.message(error)
        }
    }

    private func professionalChanged() {
        if let p = professionalId, !professionals.contains(where: { $0.id == p }) { professionalId = nil }
    }

    func choose(day: String) {
        self.day = day
        Task { await loadSlots() }
    }

    func choose(professional: String?) {
        professionalId = professional
        Task { await loadSlots() }
    }

    func choose(service: String) {
        serviceId = service
        Task { await loadSlots() }
    }

    func loadSlots() async {
        guard let serviceId else { slots = []; return }
        slotsGeneration += 1
        let mine = slotsGeneration
        loadingSlots = true
        do {
            let found = try await client.availability(serviceId: serviceId, professionalId: professionalId, date: day)
            guard mine == slotsGeneration else { return }
            slots = found.days?.first { $0.date == day }?.slots ?? []
            if let slot, !slots.contains(slot) { self.slot = nil }
        } catch {
            guard mine == slotsGeneration else { return }
            slots = []
            if let e = error as? QueueError { onFailure(e) }
            notice = ModuleFailure.message(error)
        }
        loadingSlots = false
    }

    /// Quem atende no horário escolhido: o profissional pedido, ou o primeiro livre.
    func professionalName(for slot: AgendaSlot) -> String? {
        let id = professionalId ?? slot.professionalIds?.first
        return catalog?.professionals?.first { $0.id == id }?.displayName
    }

    func submit() async {
        guard canSubmit, let serviceId, let slot else { return }
        busy = true
        notice = nil
        let signature: String
        switch purpose {
        case .new: signature = "book:\(serviceId):\(slot.starts):\(professionalId ?? ""):\(conversationId ?? customerName)"
        case .move(let a): signature = "move:\(a.id):\(slot.starts):\(professionalId ?? "")"
        }
        let key = keys.key(for: signature)
        do {
            switch purpose {
            case .new:
                let phone = customerPhone.filter(\.isNumber)
                result = try await client.book(
                    serviceId: serviceId, starts: slot.starts, professionalId: professionalId, conversationId: conversationId,
                    customerName: conversationId == nil ? customerName.trimmingCharacters(in: .whitespaces) : nil,
                    customerPhone: conversationId == nil && !phone.isEmpty ? phone : nil,
                    notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes.trimmingCharacters(in: .whitespacesAndNewlines),
                    key: key)
            case .move(let a):
                result = try await client.move(a.id, starts: slot.starts, professionalId: professionalId, key: key)
            }
            keys.settle(nil)
        } catch {
            keys.settle(error)
            if let e = error as? QueueError { onFailure(e) }
            if AgendaRules.isSlotConflict(error) {
                notice = Self.conflictMessage
                self.slot = nil
                await loadSlots()
                notice = Self.conflictMessage
            } else {
                let retry = (error as? QueueError)?.retryable == true
                notice = ModuleFailure.message(error) + (retry ? " Toque de novo para repetir com segurança." : "")
            }
        }
        busy = false
    }

    var pendingKey: String? { keys.pendingKey }
}
