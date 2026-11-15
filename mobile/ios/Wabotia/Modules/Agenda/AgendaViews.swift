import SwiftUI

/// Botão de ação das telas dos módulos (agenda, ordem de serviço).
struct ActionButton: Identifiable {
    let title: String
    let action: String
    let icon: String
    let color: Color
    var id: String { action }
}

extension Appointment {
    var statusColor: Color {
        switch state {
        case "confirmed": return Theme.ok
        case "cancelled": return Theme.muted
        case "no_show": return Theme.danger
        default: return Theme.ticket
        }
    }
}

/// Agenda (Ajustes → Atendimento → Agenda): dia, com uma coluna por profissional quando há largura (iPad), ou semana.
struct AgendaView: View {
    @StateObject private var vm: AgendaViewModel
    @Environment(\.pushRoute) private var push
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(vm: AgendaViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? AgendaViewModel())
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Group {
                if vm.loading && vm.appointments.isEmpty && vm.catalog == nil {
                    SkeletonList(rows: 6, avatar: false)
                } else if let error = vm.error, vm.catalog == nil {
                    VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
                } else if vm.mode == .day {
                    dayBody
                } else {
                    weekBody
                }
            }
            .frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Agenda")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { push(.newAppointment(conversationId: nil, customer: nil)) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Novo agendamento")
                    .accessibilityIdentifier("agenda.new")
            }
        }
        .task { vm.observeEvents(); await vm.load() }
        .refreshable { await vm.load() }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Picker("Visão", selection: Binding(get: { vm.mode }, set: { vm.setMode($0) })) {
                ForEach(AgendaViewModel.Mode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 4) {
                IconButton(systemName: "chevron.left", label: vm.mode == .day ? "Dia anterior" : "Semana anterior") { vm.shift(-1) }
                VStack(spacing: 0) {
                    Text(vm.mode == .day ? BrasiliaTime.title(vm.day) : "Semana de \(BrasiliaTime.compact(vm.rangeStart))")
                        .font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1).minimumScaleFactor(0.8)
                    if vm.day != BrasiliaTime.today() {
                        Button("Ir para hoje", action: vm.goToday).font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand)
                    }
                }
                .frame(maxWidth: .infinity)
                IconButton(systemName: "chevron.right", label: vm.mode == .day ? "Próximo dia" : "Próxima semana") { vm.shift(1) }
            }
            if vm.professionals.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        FilterChip(title: "Todos", selected: vm.professionalId == nil) { vm.professionalId = nil }
                        ForEach(vm.professionals) { p in
                            FilterChip(title: p.displayName, selected: vm.professionalId == p.id) { vm.professionalId = p.id }
                        }
                        FilterChip(title: "Cancelados", selected: vm.showCancelled, attention: vm.showCancelled ? Theme.muted : nil) { vm.showCancelled.toggle() }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.bar)
        .overlay(alignment: .bottom) { ThinDivider() }
    }

    @ViewBuilder
    private var dayBody: some View {
        let columns = vm.columns
        if columns.allSatisfy({ $0.items.isEmpty }) {
            EmptyStateView(title: "Nenhum agendamento", systemImage: "calendar",
                           message: "Toque em + para agendar um cliente.")
        } else if sizeClass == .regular && columns.count > 1 {
            // iPad: uma coluna por profissional, como no painel.
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(columns, id: \.professional.id) { column in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(column.professional.displayName).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                            ScrollView {
                                VStack(spacing: 8) {
                                    if column.items.isEmpty { Text("Livre").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).frame(maxWidth: .infinity, alignment: .leading) }
                                    ForEach(column.items) { a in appointmentCard(a, showProfessional: false) }
                                }
                            }
                        }
                        .frame(width: 280)
                    }
                }
                .padding(16)
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(columns, id: \.professional.id) { column in
                        if !column.items.isEmpty || vm.professionalId != nil {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(column.professional.displayName.uppercased()).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
                                ForEach(column.items) { a in appointmentCard(a, showProfessional: false) }
                                if column.items.isEmpty { Text("Nenhum agendamento").font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                            }
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var weekBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(vm.week, id: \.day) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        Button { vm.day = entry.day; vm.setMode(.day) } label: {
                            HStack {
                                Text(BrasiliaTime.title(entry.day)).font(Theme.font(14, .semibold)).foregroundStyle(entry.day == BrasiliaTime.today() ? Theme.brand : Theme.textPrimary)
                                Spacer()
                                Text(entry.items.isEmpty ? "livre" : "\(entry.items.count)").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .buttonStyle(.plain)
                        ForEach(entry.items) { a in appointmentCard(a, showProfessional: true) }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
    }

    private func appointmentCard(_ a: Appointment, showProfessional: Bool) -> some View {
        Button { push(.appointment(id: a.id)) } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 2) {
                    Text(a.clock).font(Theme.font(16, .bold)).foregroundStyle(Theme.textPrimary)
                    if let ends = a.ends { Text(BrasiliaTime.clock(ends)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                }
                .frame(width: 52)
                a.statusColor.frame(width: 3).clipShape(Capsule())
                VStack(alignment: .leading, spacing: 3) {
                    Text(a.customer).font(Theme.font(15, .semibold)).strikethrough(a.state == "cancelled")
                        .foregroundStyle(a.state == "cancelled" ? Theme.textSecondary : Theme.textPrimary).lineLimit(1)
                    Text([a.serviceName, showProfessional ? a.professionalName : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Pill(text: AgendaRules.statusLabel(a.state), color: a.statusColor)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("agenda.appointment.\(a.id)")
    }
}

/// Detalhe do agendamento, com confirmar, remarcar, marcar ausência e cancelar.
struct AppointmentDetailView: View {
    @StateObject private var vm: AppointmentViewModel
    @Environment(\.pushRoute) private var push
    @State private var moving = false
    @State private var cancelling = false
    @State private var confirmNoShow = false
    @State private var reason = ""

    init(id: String, vm: AppointmentViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? AppointmentViewModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                if let a = vm.appointment {
                    summary(a)
                    actions(a)
                    details(a)
                } else if vm.loading {
                    SkeletonList(rows: 3, avatar: false)
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Agendamento")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { vm.observeEvents(); await vm.load() }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .sheet(isPresented: $moving) {
            if let a = vm.appointment {
                NavigationView {
                    BookingView(purpose: .move(a)) { updated in
                        moving = false
                        vm.replace(updated)
                    }
                }
                .navigationViewStyle(.stack)
            }
        }
        .confirmationDialog("Marcar ausência?", isPresented: $confirmNoShow, titleVisibility: .visible) {
            Button("Cliente não veio", role: .destructive, action: vm.noShow)
            Button("Voltar", role: .cancel) {}
        }
        .sheet(isPresented: $cancelling) {
            VStack(alignment: .leading, spacing: 14) {
                SheetHeader(title: "Cancelar agendamento") { cancelling = false }
                Text("O cliente ligado a uma conversa recebe o aviso do cancelamento.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                AuthField(label: "Motivo (opcional)") { TextField("Ex.: cliente pediu", text: $reason) }
                PrimaryButton(title: "Cancelar agendamento", color: Theme.danger) {
                    cancelling = false
                    vm.cancel(reason: reason)
                }
                .accessibilityIdentifier("appointment.cancel.confirm")
                Spacer()
            }
            .padding(.horizontal, 20)
            .background(Theme.background.ignoresSafeArea())
        }
    }

    private func summary(_ a: Appointment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(a.customer).font(Theme.font(22, .bold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Pill(text: AgendaRules.statusLabel(a.state), color: a.statusColor, filled: true)
            }
            Text(BrasiliaTime.title(a.day)).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
            Text(AgendaRules.duration(a) ?? a.clock).font(Theme.font(15)).foregroundStyle(Theme.textSecondary)
            Text([a.serviceName, a.professionalName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " com "))
                .font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
            if let price = a.priceCents { Text(Money.format(price)).font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
        }
        .card(padding: 16)
    }

    @ViewBuilder
    private func actions(_ a: Appointment) -> some View {
        let buttons = [
            AgendaRules.canConfirm(a) ? ActionButton(title: "Confirmar", action: "confirm", icon: "checkmark.circle.fill", color: Theme.ok) : nil,
            AgendaRules.canMove(a) ? ActionButton(title: "Remarcar", action: "move", icon: "calendar.badge.clock", color: Theme.ticket) : nil,
            AgendaRules.canMarkNoShow(a) ? ActionButton(title: "Ausente", action: "no-show", icon: "person.fill.xmark", color: Theme.warn) : nil,
            AgendaRules.canCancel(a) ? ActionButton(title: "Cancelar", action: "cancel", icon: "xmark.circle.fill", color: Theme.danger) : nil,
        ].compactMap { $0 }
        if !buttons.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(buttons) { button in
                    let title = button.title, action = button.action, icon = button.icon, color = button.color
                    Button {
                        switch action {
                        case "confirm": vm.confirm()
                        case "move": moving = true
                        case "no-show": confirmNoShow = true
                        default: reason = ""; cancelling = true
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busy == action { ProgressView().scaleEffect(0.7) } else { Image(systemName: icon).font(.system(size: 13, weight: .semibold)) }
                            Text(title).font(Theme.font(15, .semibold))
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(color)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.12)))
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(vm.busy != nil)
                    .accessibilityIdentifier("appointment.\(action)")
                }
            }
        }
    }

    private func details(_ a: Appointment) -> some View {
        SectionCard(title: "Detalhes") {
            if let phone = a.customerPhone, !phone.isEmpty { CardRow(icon: "phone.fill", iconColor: Theme.brand, title: "Telefone", value: phone) }
            if let conversation = a.conversationId {
                Button { push(.conversation(id: conversation)) } label: {
                    CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true)
                }
                .buttonStyle(.plain)
            }
            if let notes = a.notes, !notes.isEmpty { CardRow(icon: "note.text", iconColor: Theme.muted, title: "Observação", subtitle: notes) }
            CardRow(icon: "arrow.triangle.branch", iconColor: Theme.muted, title: "Origem", value: sourceLabel(a.source))
            if let moves = a.moves, moves > 0 { CardRow(icon: "calendar.badge.clock", iconColor: Theme.muted, title: "Remarcações", value: "\(moves)") }
            if let reason = a.cancelReason, !reason.isEmpty { CardRow(icon: "xmark.circle", iconColor: Theme.muted, title: "Motivo do cancelamento", subtitle: reason) }
            CardRow(icon: "clock", iconColor: Theme.muted, title: "Agendado em", value: a.bookedAt.map(BrasiliaTime.shortWithTime) ?? "—", divider: false)
        }
    }

    private func sourceLabel(_ source: String?) -> String {
        switch source {
        case "whatsapp": return "WhatsApp"
        case "panel": return "Equipe"
        case "api": return "Integração"
        default: return "—"
        }
    }
}

/// Novo agendamento e remarcação: serviço, profissional, dia e os horários livres.
struct BookingView: View {
    @StateObject private var vm: BookingViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.pushRoute) private var push
    let onDone: ((Appointment) -> Void)?

    init(purpose: BookingViewModel.Purpose, vm: BookingViewModel? = nil, onDone: ((Appointment) -> Void)? = nil) {
        _vm = StateObject(wrappedValue: vm ?? BookingViewModel(purpose: purpose))
        self.onDone = onDone
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if case let .new(conversation, customer) = vm.purpose, conversation != nil {
                    DeviceNotice(text: "Para \(customer ?? "o cliente desta conversa"): ele recebe a confirmação e o lembrete pelo WhatsApp.", color: Theme.ok)
                }
                if case let .move(a) = vm.purpose {
                    DeviceNotice(text: "Remarcar \(a.customer): hoje em \(BrasiliaTime.title(a.day)) às \(a.clock).", color: Theme.ticket)
                }
                if !vm.isMove { serviceSection }
                professionalSection
                daySection
                slotsSection
                if !vm.isMove && vm.conversationId == nil { customerSection }
                if let notice = vm.notice { InlineError(text: notice).accessibilityIdentifier("booking.notice") }
                PrimaryButton(title: vm.isMove ? "Remarcar" : "Agendar", icon: "calendar.badge.plus", busy: vm.busy, disabled: !vm.canSubmit) {
                    Task { await vm.submit() }
                }
                .accessibilityIdentifier("booking.submit")
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.isMove ? "Remarcar" : "Novo agendamento")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { await vm.load() }
        .onChange(of: vm.result) { result in
            guard let result else { return }
            Workspace.shared.show(vm.isMove ? "Agendamento remarcado" : "Agendado para \(BrasiliaTime.title(result.day)) às \(result.clock)", style: .success)
            if let onDone { onDone(result) } else { dismiss() }
        }
    }

    private var serviceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Serviço")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vm.services) { s in
                        FilterChip(title: s.displayName + (s.durationMinutes.map { " · \($0) min" } ?? ""), selected: vm.serviceId == s.id) { vm.choose(service: s.id) }
                    }
                }
            }
            if let price = vm.service?.priceCents { Text(Money.format(price)).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
        }
    }

    private var professionalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Profissional")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    FilterChip(title: "Qualquer um", selected: vm.professionalId == nil) { vm.choose(professional: nil) }
                    ForEach(vm.professionals) { p in
                        FilterChip(title: p.displayName, selected: vm.professionalId == p.id) { vm.choose(professional: p.id) }
                    }
                }
            }
        }
    }

    private var daySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Dia")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(0..<21, id: \.self) { offset in
                        let day = BrasiliaTime.addDays(BrasiliaTime.today(), offset)
                        FilterChip(title: offset == 0 ? "Hoje" : (offset == 1 ? "Amanhã" : BrasiliaTime.compact(day)), selected: vm.day == day) { vm.choose(day: day) }
                    }
                }
            }
        }
    }

    private var slotsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                label("Horários livres")
                if vm.loadingSlots { ProgressView().scaleEffect(0.7) }
            }
            if vm.slots.isEmpty && !vm.loadingSlots {
                Text("Nenhum horário livre neste dia. Escolha outro dia ou outro profissional.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                ForEach(vm.slots, id: \.starts) { slot in
                    Button { vm.slot = slot } label: {
                        Text(slot.clock).font(Theme.font(15, .semibold))
                            .frame(maxWidth: .infinity, minHeight: 42)
                            .foregroundStyle(vm.slot == slot ? Theme.onBrand : Theme.brand)
                            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(vm.slot == slot ? Theme.brand : Theme.brand.opacity(0.1)))
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityIdentifier("booking.slot.\(slot.clock)")
                }
            }
            if let slot = vm.slot, let name = vm.professionalName(for: slot) {
                Text("Com \(name), às \(slot.clock).").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private var customerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            label("Cliente")
            AuthField(label: "Nome") { TextField("Nome do cliente", text: $vm.customerName).accessibilityIdentifier("booking.name") }
            AuthField(label: "Telefone (opcional)") { TextField("(11) 90000-0000", text: $vm.customerPhone).keyboardType(.phonePad) }
            AuthField(label: "Observação (opcional)") { TextField("Ex.: prefere máquina 2", text: $vm.notes) }
            Text("Sem conversa ligada, o cliente não recebe confirmação nem lembrete. Para avisar pelo WhatsApp, agende a partir da conversa.")
                .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased()).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
    }
}
