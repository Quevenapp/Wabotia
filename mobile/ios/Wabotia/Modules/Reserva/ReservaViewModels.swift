import Foundation

/// Ocupação (unidades × dias, 14 dias por vez) e lista de reservas com filtro e busca.
@MainActor
final class ReservaViewModel: ObservableObject {
    enum Mode: String, CaseIterable, Identifiable {
        case occupancy, list
        var id: String { rawValue }
        var label: String { self == .occupancy ? "Ocupação" : "Reservas" }
    }

    static let span = 14

    @Published var mode: Mode = .occupancy
    @Published var from: String
    @Published private(set) var calendar: ReservaCalendar?
    @Published private(set) var overview: ReservaOverview?
    @Published private(set) var filter = "upcoming"
    @Published var query = ""
    @Published private(set) var bookings: [Booking] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?

    private let client: ReservaClient
    private let onFailure: (QueueError) -> Void
    private var events: ModuleEvents?
    private var generation = 0
    private var searchTask: Task<Void, Never>?

    init(client: ReservaClient, today: String = BrasiliaTime.today(), onFailure: @escaping (QueueError) -> Void) {
        self.client = client
        self.from = today
        self.onFailure = onFailure
    }

    convenience init() {
        self.init(client: ReservaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.reserva))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "reserva.") { [weak self] in await self?.load() }
    }

    var to: String { BrasiliaTime.addDays(from, Self.span - 1) }
    var days: [String] { calendar?.days ?? (0..<Self.span).map { BrasiliaTime.addDays(from, $0) } }

    func booking(_ id: String?) -> Booking? { id.flatMap { id in calendar?.bookings?.first { $0.id == id } } }

    func load() async {
        generation += 1
        let mine = generation
        if calendar == nil && bookings.isEmpty { loading = true }
        do {
            if overview == nil { overview = try await client.overview() }
            switch mode {
            case .occupancy:
                let found = try await client.calendar(from: from, to: to)
                guard mine == generation else { return }
                calendar = found
            case .list:
                let statuses = ReservaRules.filters.first { $0.id == filter }?.statuses ?? []
                let found = try await client.bookings(statuses: statuses, query: query)
                guard mine == generation else { return }
                bookings = found
            }
            error = nil
        } catch {
            guard mine == generation else { return }
            if let e = error as? QueueError { onFailure(e) }
            self.error = ModuleFailure.message(error)
        }
        loading = false
    }

    func setMode(_ mode: Mode) {
        guard self.mode != mode else { return }
        self.mode = mode
        Task { await load() }
    }

    func shift(_ direction: Int) {
        from = BrasiliaTime.addDays(from, direction * Self.span)
        Task { await load() }
    }

    func goToday() {
        from = BrasiliaTime.today()
        Task { await load() }
    }

    func setFilter(_ id: String) {
        guard filter != id else { return }
        filter = id
        bookings = []
        Task { await load() }
    }

    func search(_ text: String) {
        query = text
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await load()
        }
    }
}

/// Detalhe da reserva: confirmar sem sinal, cobrar o sinal de novo, enviar o check-in e cancelar.
@MainActor
final class BookingDetailViewModel: ObservableObject {
    @Published private(set) var booking: Booking?
    @Published private(set) var loading = false
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var done: String?

    let id: String
    private let client: ReservaClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var events: ModuleEvents?

    init(id: String, client: ReservaClient, onFailure: @escaping (QueueError) -> Void) {
        self.id = id
        self.client = client
        self.onFailure = onFailure
    }

    convenience init(id: String) {
        self.init(id: id, client: ReservaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.reserva))
    }

    func observeEvents() {
        guard events == nil else { return }
        events = ModuleEvents(prefix: "reserva.") { [weak self] in await self?.load() }
    }

    func load() async {
        if booking == nil { loading = true }
        do { booking = try await client.booking(id) } catch {
            if let e = error as? QueueError { onFailure(e) }
            if booking == nil { notice = ModuleFailure.message(error) }
        }
        loading = false
    }

    func confirm() { run("confirm", "Reserva confirmada") { [client, id] in try await client.confirm(id, key: $0) } }
    func chargeDeposit() { run("deposit", "Cobrança do sinal enviada") { [client, id] in try await client.deposit(id, key: $0) } }
    func sendCheckin() { run("checkin", "Link do check-in enviado") { [client, id] in try await client.checkin(id, key: $0) } }
    func cancel(reason: String) {
        let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        run("cancel", "Reserva cancelada") { [client, id] in try await client.cancel(id, reason: text.isEmpty ? nil : text, key: $0) }
    }

    func replace(_ booking: Booking) {
        self.booking = booking
        done = "Reserva alterada"
    }

    private func run(_ action: String, _ success: String, _ block: @escaping (String) async throws -> Booking) {
        guard busy == nil else { return }
        let key = keys.key(for: "\(action):\(id)")
        busy = action
        notice = nil
        Task {
            do {
                booking = try await block(key)
                keys.settle(nil)
                done = success
            } catch {
                keys.settle(error)
                if let e = error as? QueueError { onFailure(e) }
                let retry = (error as? QueueError)?.retryable == true
                notice = ReservaRules.explain(error) + (retry ? " Toque de novo para repetir com segurança." : "")
                if !retry { await load() }
            }
            busy = nil
        }
    }
}

/// Criar ou alterar uma reserva: unidade, período (diárias: entrada e número de diárias; por hora: dia, duração e um
/// horário livre), pessoas e cliente. Diante de `unit_unavailable`, `unit_blocked`, `outside_rules` ou `booking_closed`,
/// recarrega a disponibilidade e explica.
@MainActor
final class BookingFormViewModel: ObservableObject {
    enum Purpose: Equatable {
        case new(conversationId: String?, customer: String?, unitId: String?, date: String?)
        case edit(Booking)
    }

    let purpose: Purpose
    @Published private(set) var units: [ReservaUnit] = []
    @Published private(set) var deposit: ReservaDeposit?
    @Published var unitId: String?
    @Published var startDate: String
    @Published var nights = 1
    @Published var guests = 2
    @Published var minutes = 60
    @Published private(set) var daily: [ReservaDailyOption] = []
    @Published private(set) var slots: [ReservaSlot] = []
    @Published var slot: ReservaSlot?
    @Published private(set) var loadingAvailability = false
    @Published var customerName = ""
    @Published var customerPhone = ""
    @Published var notes = ""
    @Published var chargeDeposit = true
    @Published private(set) var busy = false
    @Published var notice: String?
    @Published private(set) var result: Booking?

    private let client: ReservaClient
    private let onFailure: (QueueError) -> Void
    private let keys = IntentKeys()
    private var generation = 0

    init(purpose: Purpose, client: ReservaClient, today: String = BrasiliaTime.today(), onFailure: @escaping (QueueError) -> Void) {
        self.purpose = purpose
        self.client = client
        self.onFailure = onFailure
        switch purpose {
        case let .new(_, _, unit, date):
            unitId = unit
            startDate = max(date ?? today, today)
        case .edit(let b):
            unitId = b.unitId
            startDate = b.startDate ?? (b.starts.map(BrasiliaTime.day) ?? today)
            nights = max(b.nights ?? 1, 1)
            guests = b.guests ?? 1
            minutes = b.durationMinutes ?? 60
            customerName = b.customerName ?? ""
            customerPhone = b.customerPhone ?? ""
        }
    }

    convenience init(purpose: Purpose) {
        self.init(purpose: purpose, client: ReservaClient(api: .current()), onFailure: ModuleFailure.handler(ModuleId.reserva))
    }

    var isEdit: Bool { if case .edit = purpose { return true } else { return false } }
    var conversationId: String? {
        switch purpose {
        case let .new(conversation, _, _, _): return conversation
        case .edit(let b): return b.conversationId
        }
    }
    var unit: ReservaUnit? { units.first { $0.id == unitId } }
    var isHourly: Bool { unit?.isHourly ?? false }
    var endDate: String { BrasiliaTime.addDays(startDate, nights) }
    var chosenDaily: ReservaDailyOption? { daily.first { $0.unitId == unitId } }

    var canSubmit: Bool {
        guard unitId != nil, !busy else { return false }
        if isHourly { if slot == nil { return false } } else if chosenDaily?.available == false { return false }
        if !isEdit, conversationId == nil { return !customerName.trimmingCharacters(in: .whitespaces).isEmpty }
        return true
    }

    func load() async {
        do {
            let overview = try await client.overview()
            units = (overview.units ?? []).filter(\.isActive).sorted { ($0.position ?? 0, $0.displayName) < ($1.position ?? 0, $1.displayName) }
            deposit = overview.deposit
            if unitId == nil { unitId = units.first?.id }
            await loadAvailability()
        } catch {
            if let e = error as? QueueError { onFailure(e) }
            notice = ModuleFailure.message(error)
        }
    }

    func choose(unit: String) { unitId = unit; slot = nil; Task { await loadAvailability() } }
    func choose(start: String) { startDate = start; slot = nil; Task { await loadAvailability() } }
    func change(nights: Int) { self.nights = min(max(nights, 1), 60); Task { await loadAvailability() } }
    func change(guests: Int) { self.guests = min(max(guests, 1), 50); Task { await loadAvailability() } }
    func change(minutes: Int) { self.minutes = minutes; slot = nil; Task { await loadAvailability() } }

    func loadAvailability() async {
        generation += 1
        let mine = generation
        loadingAvailability = true
        do {
            if isHourly {
                let found = try await client.hourlyAvailability(date: startDate, minutes: minutes, unitId: unitId)
                guard mine == generation else { return }
                slots = found.units?.first { $0.unitId == unitId }?.slots ?? []
                if let slot, !slots.contains(slot) { self.slot = nil }
            } else {
                let found = try await client.dailyAvailability(start: startDate, nights: nights, guests: guests)
                guard mine == generation else { return }
                daily = found.units ?? []
                // Reserva nova sem unidade escolhida de antemão: começa numa unidade livre no período.
                if case let .new(_, _, preset, _) = purpose, preset == nil, chosenDaily?.available == false,
                   let free = daily.first(where: { $0.available != false }) {
                    unitId = free.unitId
                }
            }
        } catch {
            guard mine == generation else { return }
            if let e = error as? QueueError { onFailure(e) }
            notice = ReservaRules.explain(error)
        }
        loadingAvailability = false
    }

    /// O corpo do pedido, igual para criar e alterar (alterar manda só o que pode mudar).
    func body() -> [String: Any?] {
        var out: [String: Any?] = ["unit_id": unitId, "guests": guests]
        if isHourly {
            out["starts"] = slot?.starts
            out["duration_minutes"] = minutes
        } else {
            out["start_date"] = startDate
            out["nights"] = nights
        }
        let name = customerName.trimmingCharacters(in: .whitespaces), phone = customerPhone.filter(\.isNumber)
        if conversationId == nil || isEdit {
            if !name.isEmpty { out["customer_name"] = name }
            if !phone.isEmpty { out["customer_phone"] = phone }
        }
        if !isEdit {
            out["conversation_id"] = conversationId
            let text = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { out["notes"] = text }
            if conversationId != nil, deposit?.available == true { out["deposit"] = chargeDeposit }
        }
        return out
    }

    func submit() async {
        guard canSubmit else { return }
        busy = true
        notice = nil
        let body = self.body()
        let signature = body.keys.sorted().map { "\($0)=\(String(describing: body[$0] ?? nil))" }.joined(separator: "&")
        let key = keys.key(for: signature)
        do {
            switch purpose {
            case .new: result = try await client.create(body, key: key)
            case .edit(let b): result = try await client.update(b.id, body, key: key)
            }
            keys.settle(nil)
        } catch {
            keys.settle(error)
            if let e = error as? QueueError { onFailure(e) }
            if ReservaRules.isConflict(error) {
                slot = nil
                await loadAvailability()
            }
            let retry = (error as? QueueError)?.retryable == true
            notice = ReservaRules.explain(error) + (retry ? " Toque de novo para repetir com segurança." : "")
        }
        busy = false
    }
}
