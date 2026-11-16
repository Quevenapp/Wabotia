import SwiftUI

extension ReservaRules {
    static func color(_ state: String?) -> Color {
        switch state {
        case "pending_payment": return Theme.warn
        case "confirmed": return Theme.brand
        case "completed": return Theme.ok
        case "partial": return Theme.ticket
        case "blocked": return Theme.muted
        case "cancelled", "expired": return Theme.muted
        default: return Theme.divider
        }
    }
}

/// Reservas (aba Atendimento): ocupação por unidade e dia, e a lista com filtro e busca.
struct ReservaView: View {
    @StateObject private var vm: ReservaViewModel
    @Environment(\.pushRoute) private var push
    @State private var search = ""
    @FocusState private var searching: Bool

    init(vm: ReservaViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? ReservaViewModel())
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Picker("Visão", selection: Binding(get: { vm.mode }, set: { vm.setMode($0) })) {
                    ForEach(ReservaViewModel.Mode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                if vm.mode == .occupancy {
                    HStack {
                        IconButton(systemName: "chevron.left", label: "Período anterior") { vm.shift(-1) }
                        VStack(spacing: 0) {
                            Text("\(ReservaRules.shortDay(vm.from)) a \(ReservaRules.shortDay(vm.to))").font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
                            if vm.from != BrasiliaTime.today() { Button("Ir para hoje", action: vm.goToday).font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand) }
                        }
                        .frame(maxWidth: .infinity)
                        IconButton(systemName: "chevron.right", label: "Próximo período") { vm.shift(1) }
                    }
                } else {
                    SearchField(placeholder: "Cliente, telefone ou número", text: $search, focused: $searching)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(ReservaRules.filters, id: \.id) { f in
                                FilterChip(title: f.title, selected: vm.filter == f.id) { vm.setFilter(f.id) }
                            }
                        }
                    }
                }
                if let deposit = vm.overview?.deposit, deposit.available == false, let message = deposit.message, !message.isEmpty {
                    DeviceNotice(text: message, color: Theme.warn)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.bar)
            .overlay(alignment: .bottom) { ThinDivider() }
            Group {
                if vm.loading && vm.calendar == nil && vm.bookings.isEmpty {
                    SkeletonList(rows: 6, avatar: false)
                } else if let error = vm.error, vm.calendar == nil && vm.bookings.isEmpty {
                    VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
                } else if vm.mode == .occupancy {
                    occupancy
                } else {
                    list
                }
            }
            .frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Reservas")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { push(.bookingForm(conversationId: nil, customer: nil, unitId: nil, date: nil)) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Nova reserva")
                    .accessibilityIdentifier("reserva.new")
            }
        }
        .onChange(of: search) { vm.search($0) }
        .task {
            vm.observeEvents()
            #if DEBUG
            if AppContainer.shared.isDemo, DemoMode.action == "list" { vm.setMode(.list); return }
            #endif
            await vm.load()
        }
        .refreshable { await vm.load() }
    }

    /// Unidades nas linhas, dias nas colunas; tocar numa reserva abre o detalhe, tocar num dia livre abre a reserva nova.
    private var occupancy: some View {
        let units = vm.calendar?.units ?? []
        let days = vm.days
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 4) {
                            Text("").frame(width: 120, alignment: .leading)
                            ForEach(days, id: \.self) { day in
                                VStack(spacing: 0) {
                                    Text(BrasiliaTime.compact(day).split(separator: " ").first.map(String.init) ?? "").font(Theme.font(10)).foregroundStyle(Theme.textSecondary)
                                    Text(ReservaRules.shortDay(day).prefix(2)).font(Theme.font(13, .semibold)).foregroundStyle(day == BrasiliaTime.today() ? Theme.brand : Theme.textPrimary)
                                }
                                .frame(width: 40)
                            }
                        }
                        ForEach(units) { unit in
                            HStack(spacing: 4) {
                                VStack(alignment: .leading, spacing: 0) {
                                    Text(unit.name ?? "Unidade").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                                    Text(unit.mode == "hourly" ? "por hora" : "por diária").font(Theme.font(11)).foregroundStyle(Theme.textSecondary)
                                }
                                .frame(width: 120, alignment: .leading)
                                ForEach(unit.cells ?? [], id: \.date) { cell in
                                    Button {
                                        if let id = cell.bookingIds?.first { push(.booking(id: id)) }
                                        else if cell.state != "blocked" { push(.bookingForm(conversationId: nil, customer: nil, unitId: unit.unitId, date: cell.date)) }
                                    } label: {
                                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                                            .fill(cell.state == "free" || cell.state == nil ? Theme.surface : ReservaRules.color(cell.state).opacity(cell.state == "blocked" ? 0.35 : 0.85))
                                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.divider, lineWidth: cell.state == "free" ? 1 : 0))
                                            .frame(width: 40, height: 40)
                                            .overlay {
                                                if cell.state == "blocked" { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSecondary) }
                                            }
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("\(unit.name ?? "Unidade"), \(ReservaRules.shortDay(cell.date)): \(ReservaRules.cellLabel(cell.state))")
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
                legend.padding(.horizontal, 16)
                let upcoming = (vm.calendar?.bookings ?? []).filter { ReservaRules.active.contains($0.state) }.sorted { ($0.starts ?? 0) < ($1.starts ?? 0) }
                if !upcoming.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("NO PERÍODO").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
                        ForEach(upcoming) { b in bookingRow(b) }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(.vertical, 12)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
    }

    private var legend: some View {
        HStack(spacing: 12) {
            ForEach(["free", "pending_payment", "confirmed", "partial", "blocked"], id: \.self) { state in
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 3).fill(state == "free" ? Theme.surface : ReservaRules.color(state).opacity(0.85))
                        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Theme.divider, lineWidth: 1)).frame(width: 12, height: 12)
                    Text(ReservaRules.cellLabel(state)).font(Theme.font(11)).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }

    @ViewBuilder
    private var list: some View {
        if vm.bookings.isEmpty {
            EmptyStateView(title: "Nenhuma reserva aqui", systemImage: "bed.double", message: "Toque em + para reservar uma unidade para um cliente.")
        } else {
            ScrollView {
                LazyVStack(spacing: 10) { ForEach(vm.bookings) { bookingRow($0) } }
                    .padding(16)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func bookingRow(_ b: Booking) -> some View {
        Button { push(.booking(id: b.id)) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(b.numberText).font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                    Text(b.unitName ?? "").font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Spacer()
                    Pill(text: ReservaRules.statusLabel(b.state), color: ReservaRules.color(b.state))
                }
                Text(b.customer).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                HStack {
                    Text(b.periodText).font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    Spacer()
                    if let price = b.priceCents { Text(Money.format(price)).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary) }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("reserva.booking.\(b.id)")
    }
}

/// Detalhe da reserva: período, cliente, valores, sinal, check-in e ações.
struct BookingDetailView: View {
    @StateObject private var vm: BookingDetailViewModel
    @Environment(\.pushRoute) private var push
    @State private var editing = false
    @State private var cancelling = false
    @State private var reason = ""

    init(id: String, vm: BookingDetailViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? BookingDetailViewModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let b = vm.booking {
                    summary(b)
                    actions(b)
                    payment(b)
                    checkin(b)
                    customer(b)
                } else if vm.loading {
                    SkeletonList(rows: 3, avatar: false)
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.booking.map { "Reserva \($0.numberText)" } ?? "Reserva")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { vm.observeEvents(); await vm.load() }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .sheet(isPresented: $editing) {
            if let b = vm.booking {
                NavigationView {
                    BookingFormView(purpose: .edit(b)) { updated in
                        editing = false
                        vm.replace(updated)
                    }
                }
                .navigationViewStyle(.stack)
            }
        }
        .sheet(isPresented: $cancelling) {
            VStack(alignment: .leading, spacing: 14) {
                SheetHeader(title: "Cancelar reserva") { cancelling = false }
                Text("A unidade fica livre de novo. O cliente ligado a uma conversa recebe o aviso; a devolução do sinal, se houver, é feita no provedor de pagamento.")
                    .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                AuthField(label: "Motivo (opcional)") { TextField("Ex.: cliente desistiu", text: $reason) }
                PrimaryButton(title: "Cancelar reserva", color: Theme.danger) {
                    cancelling = false
                    vm.cancel(reason: reason)
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .background(Theme.background.ignoresSafeArea())
        }
    }

    private func summary(_ b: Booking) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(b.unitName ?? "Unidade").font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Pill(text: ReservaRules.statusLabel(b.state), color: ReservaRules.color(b.state), filled: true)
            }
            Text(b.periodText).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
            if !b.isHourly, let arrival = b.arrivalTime, let departure = b.departureTime {
                Text("Entrada a partir das \(arrival) · saída até \(departure)").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            }
            if let guests = b.guests { Text(guests == 1 ? "1 pessoa" : "\(guests) pessoas").font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
            if let notes = b.notes, !notes.isEmpty {
                Label(notes, systemImage: "lock.fill").font(Theme.font(13)).foregroundStyle(Theme.noteText)
                    .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubbleNote))
            }
        }
        .card(padding: 16)
    }

    @ViewBuilder
    private func actions(_ b: Booking) -> some View {
        let buttons = [
            ReservaRules.canConfirm(b) ? ActionButton(title: "Confirmar sem sinal", action: "confirm", icon: "checkmark.circle.fill", color: Theme.ok) : nil,
            ReservaRules.canChargeDeposit(b) ? ActionButton(title: "Cobrar o sinal de novo", action: "deposit", icon: "creditcard.fill", color: Theme.warn) : nil,
            ReservaRules.canSendCheckin(b) ? ActionButton(title: "Enviar check-in", action: "checkin", icon: "doc.text.fill", color: Theme.ticket) : nil,
            ReservaRules.canEdit(b) ? ActionButton(title: "Alterar", action: "edit", icon: "pencil", color: Theme.brand) : nil,
            ReservaRules.canCancel(b) ? ActionButton(title: "Cancelar", action: "cancel", icon: "xmark.circle.fill", color: Theme.danger) : nil,
        ].compactMap { $0 }
        if !buttons.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(buttons) { button in
                    Button {
                        switch button.action {
                        case "confirm": vm.confirm()
                        case "deposit": vm.chargeDeposit()
                        case "checkin": vm.sendCheckin()
                        case "edit": editing = true
                        default: reason = ""; cancelling = true
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busy == button.action { ProgressView().scaleEffect(0.7) } else { Image(systemName: button.icon).font(.system(size: 13, weight: .semibold)) }
                            Text(button.title).font(Theme.font(14, .semibold)).lineLimit(2).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(button.color)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(button.color.opacity(0.12)))
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(vm.busy != nil)
                    .accessibilityIdentifier("booking.\(button.action)")
                }
            }
        }
    }

    private func payment(_ b: Booking) -> some View {
        SectionCard(title: "Valores") {
            CardRow(title: "Total", value: b.priceCents.map(Money.format) ?? "—")
            CardRow(title: "Sinal", value: b.depositCents.map(Money.format) ?? "Sem sinal")
            if let status = b.paymentStatus {
                CardRow(title: "Pagamento do sinal", value: paymentLabel(status))
            }
            if let error = b.paymentError, !error.isEmpty { CardRow(title: "Cobrança", subtitle: error) }
            CardRow(title: b.state == "pending_payment" ? "Prazo para o sinal" : "Pago em",
                    value: (b.state == "pending_payment" ? b.paymentDueAt : b.paidAt).map(BrasiliaTime.shortWithTime) ?? "—", divider: false)
        }
    }

    private func paymentLabel(_ status: String) -> String {
        switch status {
        case "created": return "Aguardando pagamento"
        case "paid": return "Pago"
        case "expired": return "Venceu"
        case "cancelled": return "Cancelado"
        case "refunded": return "Devolvido"
        default: return status
        }
    }

    private func checkin(_ b: Booking) -> some View {
        SectionCard(title: "Check-in") {
            CardRow(icon: "doc.text.fill", iconColor: b.checkinStatus == "completed" ? Theme.ok : Theme.muted, title: ReservaRules.checkinLabel(b.checkinStatus),
                    value: b.checkinAt.map(BrasiliaTime.shortWithTime), divider: !ReservaRules.answers(b).isEmpty)
            let answers = ReservaRules.answers(b)
            ForEach(Array(answers.enumerated()), id: \.offset) { index, pair in
                CardRow(title: pair.0, value: pair.1, divider: index < answers.count - 1)
            }
        }
    }

    private func customer(_ b: Booking) -> some View {
        SectionCard(title: "Cliente") {
            CardRow(icon: "person.fill", iconColor: Theme.brand, title: b.customer, subtitle: PhoneText.display(b.customerPhone))
            if let conversation = b.conversationId {
                Button { push(.conversation(id: conversation)) } label: {
                    CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true)
                }
                .buttonStyle(.plain)
            }
            CardRow(icon: "clock", iconColor: Theme.muted, title: "Criada em", value: b.created.map(BrasiliaTime.shortWithTime) ?? "—", divider: false)
        }
    }
}

/// Nova reserva (ou alteração): unidade, período, pessoas e cliente.
struct BookingFormView: View {
    @StateObject private var vm: BookingFormViewModel
    @Environment(\.dismiss) private var dismiss
    let onDone: ((Booking) -> Void)?

    init(purpose: BookingFormViewModel.Purpose, vm: BookingFormViewModel? = nil, onDone: ((Booking) -> Void)? = nil) {
        _vm = StateObject(wrappedValue: vm ?? BookingFormViewModel(purpose: purpose))
        self.onDone = onDone
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if vm.conversationId != nil, !vm.isEdit {
                    DeviceNotice(text: "Para o cliente desta conversa: ele recebe a confirmação pelo WhatsApp.", color: Theme.ok)
                }
                unitSection
                periodSection
                availabilitySection
                if !vm.isEdit && vm.conversationId == nil || vm.isEdit && vm.conversationId == nil { customerSection }
                if !vm.isEdit {
                    AuthField(label: "Observação interna (opcional)") { TextField("Não vai para o cliente", text: $vm.notes) }
                    if vm.conversationId != nil, vm.deposit?.available == true {
                        Toggle("Cobrar o sinal pela conversa", isOn: $vm.chargeDeposit).font(Theme.font(15))
                    }
                }
                if let notice = vm.notice { InlineError(text: notice).accessibilityIdentifier("reserva.notice") }
                PrimaryButton(title: vm.isEdit ? "Salvar alteração" : "Reservar", icon: "bed.double.fill", busy: vm.busy, disabled: !vm.canSubmit) {
                    Task { await vm.submit() }
                }
                .accessibilityIdentifier("reserva.submit")
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.isEdit ? "Alterar reserva" : "Nova reserva")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { await vm.load() }
        .onChange(of: vm.result) { result in
            guard let result else { return }
            Workspace.shared.show(vm.isEdit ? "Reserva alterada" : "Reserva \(result.numberText) criada", style: .success)
            if let onDone { onDone(result) } else { dismiss() }
        }
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased()).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
    }

    private var unitSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Unidade")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vm.units) { u in
                        FilterChip(title: u.displayName + (u.isHourly ? " · por hora" : ""), selected: vm.unitId == u.id) { vm.choose(unit: u.id) }
                    }
                }
            }
        }
    }

    private var periodSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            label(vm.isHourly ? "Dia" : "Entrada")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(0..<30, id: \.self) { offset in
                        let day = BrasiliaTime.addDays(BrasiliaTime.today(), offset)
                        FilterChip(title: offset == 0 ? "Hoje" : (offset == 1 ? "Amanhã" : BrasiliaTime.compact(day)), selected: vm.startDate == day) { vm.choose(start: day) }
                    }
                }
            }
            if vm.isHourly {
                HStack(spacing: 8) {
                    ForEach([60, 90, 120, 180, 240], id: \.self) { m in
                        FilterChip(title: m % 60 == 0 ? "\(m / 60) h" : "\(m / 60) h \(m % 60)", selected: vm.minutes == m) { vm.change(minutes: m) }
                    }
                }
            } else {
                Stepper("\(vm.nights) \(vm.nights == 1 ? "diária" : "diárias") · saída \(ReservaRules.shortDay(vm.endDate))", value: Binding(get: { vm.nights }, set: { vm.change(nights: $0) }), in: 1...60)
                    .font(Theme.font(15))
            }
            Stepper(vm.guests == 1 ? "1 pessoa" : "\(vm.guests) pessoas", value: Binding(get: { vm.guests }, set: { vm.change(guests: $0) }), in: 1...50)
                .font(Theme.font(15))
        }
    }

    @ViewBuilder
    private var availabilitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { label("Disponibilidade"); if vm.loadingAvailability { ProgressView().scaleEffect(0.7) } }
            if vm.isHourly {
                if vm.slots.isEmpty && !vm.loadingAvailability {
                    Text("Nenhum horário livre neste dia.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                    ForEach(vm.slots, id: \.starts) { slot in
                        Button { vm.slot = slot } label: {
                            Text(slot.clock).font(Theme.font(15, .semibold)).frame(maxWidth: .infinity, minHeight: 42)
                                .foregroundStyle(vm.slot == slot ? Theme.onBrand : Theme.brand)
                                .background(RoundedRectangle(cornerRadius: 10).fill(vm.slot == slot ? Theme.brand : Theme.brand.opacity(0.1)))
                        }
                        .buttonStyle(PressScaleStyle())
                    }
                }
                if let price = vm.slot?.priceCents { Text("Valor: \(Money.format(price))").font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
            } else {
                SectionCard {
                    ForEach(Array(vm.daily.enumerated()), id: \.element.id) { index, option in
                        Button { vm.choose(unit: option.unitId) } label: {
                            CardRow(icon: option.available == false ? "xmark.circle.fill" : "checkmark.circle.fill",
                                    iconColor: option.available == false ? Theme.muted : Theme.ok, title: option.name ?? "Unidade",
                                    subtitle: option.available == false ? (option.message ?? "Indisponível") : depositText(option),
                                    value: option.priceCents.map(Money.format), divider: index < vm.daily.count - 1) {
                                if vm.unitId == option.unitId { Image(systemName: "checkmark").foregroundStyle(Theme.brand) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func depositText(_ option: ReservaDailyOption) -> String? {
        guard let deposit = option.depositCents, deposit > 0 else { return option.capacity.map { "até \($0) pessoas" } }
        return "Sinal de \(Money.format(deposit))"
    }

    private var customerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            label("Cliente")
            AuthField(label: "Nome") { TextField("Nome do cliente", text: $vm.customerName).accessibilityIdentifier("reserva.name") }
            AuthField(label: "Telefone (opcional)") { TextField("(11) 90000-0000", text: $vm.customerPhone).keyboardType(.phonePad) }
            if !vm.isEdit {
                Text("Sem conversa ligada, o cliente não recebe confirmação, cobrança do sinal nem check-in pelo WhatsApp.")
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
