import SwiftUI

/// Aba Atendimento (no lugar da antiga aba Protocolos): tudo do dia a dia de quem atende num lugar só. Sua presença
/// (online/offline), os protocolos com os contadores, o guichê da fila de senhas e os módulos ligados na área
/// (Agenda, Ordens de serviço, Reservas, Pedidos, Mensalidades), as linhas de atendimento e, para o administrador,
/// menus e linhas dos bots. A impressora do cupom continua em Ajustes, porque é deste aparelho, não do atendimento.
struct AttendanceView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @ObservedObject private var workspace = Workspace.shared
    @ObservedObject private var moduleFeature = ModuleFeature.shared
    @State private var presenceError: String?

    private var isAdmin: Bool { container.user?.isAdmin ?? false }

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Atendimento", subtitle: workspace.profileName.isEmpty ? nil : workspace.profileName) { EmptyView() }
            ScrollView {
                VStack(spacing: 20) {
                    presenceSection
                    ticketsSection
                    modulesSection
                    linesSection
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
            }
            .refreshable {
                await workspace.refreshTicketCounts()
                await ModuleFeature.shared.refresh(container: container)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .task(id: "\(active)-\(container.profileId ?? "")") {
            guard active else { return }
            await workspace.refreshTicketCounts()
            await ModuleFeature.shared.refresh(container: container)
        }
    }

    // MARK: Presença

    private var presenceSection: some View {
        SectionCard(title: "Sua presença", footer: workspace.mePresent
                    ? "Online: novos atendimentos e transferências podem ser encaminhados a você."
                    : "Offline: novos atendimentos não são encaminhados a você.") {
            CardRow(icon: workspace.mePresent ? "checkmark.circle.fill" : "moon.fill", iconColor: workspace.mePresent ? Theme.ok : Theme.muted,
                    title: workspace.mePresent ? "Online" : "Offline", subtitle: teamSummary, divider: presenceError != nil) {
                if workspace.presenceBusy { ProgressView() }
                Toggle("", isOn: Binding(get: { workspace.mePresent }, set: setPresence))
                    .labelsHidden()
                    .disabled(workspace.presenceBusy)
                    .accessibilityLabel("Online para atendimentos")
                    .accessibilityIdentifier("attendance.presence")
            }
            if let presenceError { InlineError(text: presenceError).padding(12) }
        }
    }

    private var teamSummary: String {
        let n = workspace.onlinePeople
        return n == 1 ? "1 pessoa da equipe online" : "\(n) pessoas da equipe online"
    }

    private func setPresence(_ value: Bool) {
        presenceError = nil
        Task {
            if let message = await workspace.setPresence(value) { presenceError = message } else { Haptics.light() }
        }
    }

    // MARK: Protocolos

    private var ticketsSection: some View {
        let counts = workspace.ticketCounts
        return SectionCard(title: "Protocolos") {
            Button { push(.tickets(filter: nil)) } label: {
                CardRow(icon: "doc.text.fill", iconColor: Theme.ticket, title: "Protocolos", subtitle: ticketSummary(counts), chevron: true,
                        divider: counts.overdue > 0 || counts.waiting > 0) {
                    if counts.active > 0 { CountBadge(count: counts.active, color: Theme.accent) }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("attendance.tickets")
            if counts.overdue > 0 {
                Button { push(.tickets(filter: TicketFilter.overdue.rawValue)) } label: {
                    CardRow(icon: "exclamationmark.triangle.fill", iconColor: Theme.danger, title: "Atrasados", chevron: true, divider: counts.waiting > 0) {
                        CountBadge(count: counts.overdue, color: Theme.danger)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("attendance.overdue")
            }
            if counts.waiting > 0 {
                Button { push(.tickets(filter: TicketFilter.waiting.rawValue)) } label: {
                    CardRow(icon: "hourglass", iconColor: Theme.warn, title: "Aguardando cliente ou terceiro", chevron: true, divider: false) {
                        CountBadge(count: counts.waiting, color: Theme.muted)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func ticketSummary(_ counts: Workspace.TicketCounts) -> String {
        if counts.overdue > 0 { return counts.overdue == 1 ? "1 atrasado" : "\(counts.overdue) atrasados" }
        if counts.active > 0 { return counts.active == 1 ? "1 ativo" : "\(counts.active) ativos" }
        return "Tudo em dia"
    }

    // MARK: Fila e módulos

    @ViewBuilder private var modulesSection: some View {
        let p = container.profileId
        let rows: [(id: String, title: String, icon: String, color: Color, route: Route, tag: String)] = [
            (ModuleId.queue, "Guichê da fila de senhas", "ticket", Theme.ticket, .counter, "attendance.counter"),
            (ModuleId.agenda, "Agenda", "calendar", Theme.brand, .agenda, "attendance.agenda"),
            (ModuleId.serviceOrders, "Ordens de serviço", "wrench.and.screwdriver.fill", Theme.warn, .serviceOrders, "attendance.serviceOrders"),
            (ModuleId.reserva, "Reservas", "bed.double.fill", Theme.ticket, .reserva, "attendance.reserva"),
            (ModuleId.pedido, "Pedidos", "takeoutbag.and.cup.and.straw.fill", Theme.warn, .pedido, "attendance.pedido"),
            (ModuleId.mensalidade, "Mensalidades", "creditcard.fill", Theme.bot, .mensalidade, "attendance.mensalidade"),
        ].filter { moduleFeature.isAvailable($0.id, p) }
        if !rows.isEmpty {
            SectionCard(title: "Fila e módulos") {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    navRow(row.title, row.icon, row.color, divider: index < rows.count - 1) { push(row.route) }
                        .accessibilityIdentifier(row.tag)
                }
            }
        }
    }

    // MARK: Linhas e bots

    private var linesSection: some View {
        SectionCard(title: "Linhas e bots", footer: isAdmin ? nil : "Atendentes consultam as linhas; a edição é do administrador.") {
            navRow("Linhas de atendimento", "phone.connection", Theme.ok, divider: isAdmin) { push(.lines) }
                .accessibilityIdentifier("attendance.lines")
            if isAdmin {
                navRow("Menus e submenus", "list.bullet.indent", Theme.brand) { push(.menus) }
                navRow("Linhas dos bots", "cpu", Theme.bot, divider: false) { push(.botLines) }
            }
        }
    }

    private func navRow(_ title: String, _ icon: String, _ color: Color, divider: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) { CardRow(icon: icon, iconColor: color, title: title, chevron: true, divider: divider) }
            .buttonStyle(.plain)
    }
}
