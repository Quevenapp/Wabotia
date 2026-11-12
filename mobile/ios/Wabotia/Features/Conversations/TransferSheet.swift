import SwiftUI

/// Folha "Encaminhar atendimento" (mobile/DESIGN.md, seção 6): um só lugar para tirar a conversa de mim.
/// Cinco abas (Pessoas, Bots, Setores, Menu, Protocolo); cada item pede uma confirmação curta na própria
/// folha; erros do servidor aparecem aqui, sem fechá-la.
struct TransferSheet: View {
    enum Tab: String, CaseIterable, Identifiable {
        case people, bots, departments, menu, ticket
        var id: String { rawValue }
        var title: String {
            switch self {
            case .people: return "Pessoas"
            case .bots: return "Bots"
            case .departments: return "Setores"
            case .menu: return "Menu"
            case .ticket: return "Protocolo"
            }
        }
        var icon: String {
            switch self {
            case .people: return "person.2.fill"
            case .bots: return "cpu"
            case .departments: return "building.2.fill"
            case .menu: return "list.bullet"
            case .ticket: return "doc.text.fill"
            }
        }
    }

    private enum Choice: Equatable {
        case person(TeamContact)
        case bot(TeamContact)
        case automation
        case department(Department)
        case menu(id: String?, label: String)
        case protocols
    }

    @ObservedObject var vm: ConversationViewModel
    var initialTab: Tab = .people
    var onOpenTicket: ((String) -> Void)? = nil

    @ObservedObject private var workspace = Workspace.shared
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var tab: Tab = .people
    @State private var didSetTab = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @State private var choice: Choice?
    @State private var busy = false
    @State private var menus: [JSONValue]?
    @State private var menusError: String?
    @State private var loadingMenus = false
    @State private var ticketTitle = ""
    @State private var ticketKey = APIClient.newIdempotencyKey()
    @State private var creatingTicket = false

    #if DEBUG
    static var demoConfirm = false
    #endif

    private var connectionId: String? { vm.conversation?.connection_id }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Encaminhar atendimento", subtitle: vm.displayName) { dismiss() }
            tabBar
            ThinDivider()
            ScrollView {
                VStack(spacing: 0) {
                    if !vm.canTransfer {
                        notice("Assuma a conversa para encaminhar. Só o responsável e administradores podem transferir.", icon: "lock.fill")
                    }
                    if let error = vm.actionError { InlineError(text: error).padding(.horizontal, 16).padding(.top, 12) }
                    content
                }
                .padding(.bottom, 16)
            }
            .appScrollDismissesKeyboard()
            if let choice { confirmBar(choice) }
        }
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents(medium: false)
        .interactiveDismissDisabled(busy)
        .onAppear {
            if !didSetTab { tab = initialTab; didSetTab = true }
            vm.actionError = nil
            if initialTab == .menu { Task { await loadMenus() } }
            #if DEBUG
            if Self.demoConfirm {
                Self.demoConfirm = false
                if let offline = people.first(where: { !$0.online }) { choice = .person(offline) }
            }
            #endif
        }
        .task {
            await workspace.refreshTeam()
            await vm.loadTickets()
        }
        .onChange(of: tab) { now in
            choice = nil
            query = ""
            vm.actionError = nil
            if now == .menu { Task { await loadMenus() } }
        }
        .animation(.quick, value: choice)
    }

    // MARK: Abas

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases) { t in
                Button { tab = t } label: {
                    VStack(spacing: 4) {
                        Image(systemName: t.icon).font(.system(size: 16, weight: .medium)).frame(height: 18)
                        Text(t.title).font(Theme.font(12, tab == t ? .semibold : .medium)).lineLimit(1).minimumScaleFactor(0.85)
                    }
                    .foregroundStyle(tab == t ? Theme.brand : Theme.textSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .overlay(alignment: .bottom) {
                        if tab == t { Theme.brand.frame(height: 3).clipShape(Capsule()).padding(.horizontal, 10) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.title)
                .accessibilityAddTraits(tab == t ? .isSelected : [])
            }
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder private var content: some View {
        switch tab {
        case .people: peopleTab
        case .bots: botsTab
        case .departments: departmentsTab
        case .menu: menuTab
        case .ticket: ticketTab
        }
    }

    // MARK: Pessoas

    /// Pessoas do perfil, menos eu: online primeiro.
    private var people: [TeamContact] {
        workspace.people.filter { $0.id != vm.meId }
            .sorted { $0.online != $1.online ? $0.online : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func filtered(_ list: [TeamContact]) -> [TeamContact] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? list : list.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }

    @ViewBuilder private var peopleTab: some View {
        let list = people
        if list.count > 8 { search }
        if list.isEmpty {
            empty("person.2", workspace.loadedOnce ? "Nenhuma outra pessoa neste perfil" : "Carregando equipe…")
        } else {
            ForEach(filtered(list)) { person in
                row(selected: choice == .person(person)) { choice = .person(person) } label: {
                    AvatarView(name: person.name, seed: person.id, size: 44, badge: .presence(person.online))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(person.name).font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        Text(person.online ? "Online" : "Offline").font(Theme.font(13)).foregroundStyle(person.online ? Theme.ok : Theme.textSecondary)
                    }
                }
            }
        }
    }

    // MARK: Bots

    /// Bots habilitados e autorizados para a linha desta conversa.
    private var bots: [TeamContact] {
        workspace.bots.filter { $0.serves(line: connectionId) }
            .sorted { $0.online != $1.online ? $0.online : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    @ViewBuilder private var botsTab: some View {
        let list = bots
        if list.count > 8 { search }
        row(selected: choice == .automation) { choice = .automation } label: {
            AvatarView(name: "Bot", kind: .bot, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("Bot do atendimento automático").font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1).minimumScaleFactor(0.8)
                Text("Devolve a conversa à IA do perfil").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
        }
        ForEach(filtered(list)) { bot in
            row(selected: choice == .bot(bot)) { choice = .bot(bot) } label: {
                AvatarView(name: bot.name, kind: .bot, size: 44, badge: .presence(bot.online))
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.name).font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Text(bot.online ? "Disponível" : "Indisponível").font(Theme.font(13)).foregroundStyle(bot.online ? Theme.ok : Theme.textSecondary)
                }
            }
        }
        if list.isEmpty {
            Text("Nenhum outro bot autorizado para esta linha.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 12)
        }
    }

    // MARK: Setores

    @ViewBuilder private var departmentsTab: some View {
        let list = workspace.departments
        if list.isEmpty {
            empty("building.2", "Nenhum setor configurado no painel")
        } else {
            ForEach(list) { department in
                let online = department.members.filter { workspace.isOnline($0) }.count
                row(selected: choice == .department(department)) { choice = .department(department) } label: {
                    Image(systemName: "building.2.fill")
                        .font(.system(size: 17)).foregroundStyle(Color.white)
                        .frame(width: 44, height: 44).background(Circle().fill(Theme.avatarColor(department.id)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(department.name).font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        Text("\(department.members.count) \(department.members.count == 1 ? "membro" : "membros") · \(online) online")
                            .font(Theme.font(13)).foregroundStyle(online > 0 ? Theme.ok : Theme.textSecondary)
                    }
                }
            }
        }
    }

    // MARK: Menu

    private var submenus: [JSONValue] {
        (menus ?? []).filter { $0["type"]?.stringValue == "submenu" && $0["enabled"]?.boolValue != false }
    }

    @ViewBuilder private var menuTab: some View {
        notice("Envia o menu ao cliente. A conversa continua com você até ele escolher uma opção.", icon: "info.circle.fill")
        row(selected: choice == .menu(id: nil, label: "Menu principal")) { choice = .menu(id: nil, label: "Menu principal") } label: {
            menuIcon("list.bullet")
            VStack(alignment: .leading, spacing: 2) {
                Text("Menu principal").font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary)
                Text("Todas as opções desta linha").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            }
        }
        if let menusError {
            InlineError(text: menusError) { Task { await loadMenus() } }.padding(.horizontal, 16).padding(.top, 12)
        } else if menus == nil {
            ProgressView().padding(.top, 20)
        } else {
            ForEach(submenus, id: \.serviceId) { menu in
                let label = menu["label"]?.stringValue ?? "Submenu"
                let options = (menus ?? []).filter { $0["parent_id"]?.stringValue == menu.serviceId }.count
                row(selected: choice == .menu(id: menu.serviceId, label: label)) { choice = .menu(id: menu.serviceId, label: label) } label: {
                    menuIcon("list.bullet.indent")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label).font(Theme.font(16, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        Text(options == 1 ? "Submenu · 1 opção" : "Submenu · \(options) opções").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            if submenus.isEmpty {
                Text("Nenhum submenu disponível para esta linha.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 12)
            }
        }
    }

    private func menuIcon(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 17, weight: .medium)).foregroundStyle(Theme.onBrand)
            .frame(width: 44, height: 44).background(Circle().fill(Theme.brand))
    }

    /// Tarefa própria (não a do `.task` da folha): trocar de aba não cancela o pedido pela metade.
    private func loadMenus() async {
        guard let p = container.profileId, menus == nil, !loadingMenus else { return }
        loadingMenus = true
        defer { loadingMenus = false }
        menusError = nil
        do { menus = try await container.api.menus(p, connectionId: connectionId) }
        catch { menusError = container.serviceError(error) }
    }

    // MARK: Protocolo

    @ViewBuilder private var ticketTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Abrir protocolo").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
            AppMultilineField("Resumo da solicitação", text: $ticketTitle, lines: 1...3, font: Theme.font(16))
                .padding(.horizontal, 10)
                .padding(.vertical, ticketFieldPadding)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.field))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.divider, lineWidth: 1))
                .onChange(of: ticketTitle) { value in if value.count > 300 { ticketTitle = String(value.prefix(300)) } }
            PrimaryButton(title: "Abrir protocolo", icon: "doc.text.fill", busy: creatingTicket, color: Theme.ticket, disabled: ticketTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !vm.isOwned) {
                createTicket()
            }
            if !vm.isOwned {
                Text("Assuma a conversa para abrir um protocolo.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
            }
        }
        .card()
        .padding(.horizontal, 16)
        .padding(.top, 14)

        row(selected: choice == .protocols) { choice = .protocols } label: {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .medium)).foregroundStyle(Theme.onBrand)
                .frame(width: 44, height: 44).background(Circle().fill(Theme.ticket))
            VStack(alignment: .leading, spacing: 2) {
                Text("Enviar consulta de protocolos ao cliente").font(Theme.font(15, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                Text("Ele recebe a lista por mensagem").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
        }
        .padding(.top, 6)

        Text("PROTOCOLOS DESTA CONVERSA").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 4)
        if vm.tickets.isEmpty {
            Text("Nenhum protocolo nesta conversa.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 8)
        } else {
            ForEach(vm.tickets) { ticket in
                Button {
                    guard let onOpenTicket else { return }
                    dismiss()
                    onOpenTicket(ticket.id)
                } label: {
                    TicketMiniRow(ticket: ticket, chevron: onOpenTicket != nil)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            }
        }
    }

    private var ticketFieldPadding: CGFloat {
        if #available(iOS 16, *) { return 10 } else { return 2 }
    }

    private func createTicket() {
        let title = ticketTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !creatingTicket else { return }
        creatingTicket = true
        Task {
            if await vm.openTicket(title: title, key: ticketKey) != nil {
                ticketTitle = ""
                ticketKey = APIClient.newIdempotencyKey()
                dismiss()
            } else if vm.actionError != nil {
                // O servidor respondeu: a próxima tentativa é um novo pedido.
                ticketKey = APIClient.newIdempotencyKey()
            }
            creatingTicket = false
        }
    }

    // MARK: Peças comuns

    private var search: some View {
        SearchField(placeholder: "Buscar", text: $query, focused: $searchFocused)
            .padding(.horizontal, 16)
            .padding(.top, 10)
    }

    private func notice(_ text: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.system(size: 13)).foregroundStyle(Theme.textSecondary).padding(.top, 1)
            Text(text).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private func empty(_ icon: String, _ text: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 28)).foregroundStyle(Theme.muted)
                .frame(width: 72, height: 72).background(Circle().fill(Theme.surface))
            Text(text).font(Theme.font(15, .medium)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
        .padding(.horizontal, 32)
    }

    private func row<Label: View>(selected: Bool, action: @escaping () -> Void, @ViewBuilder label: () -> Label) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                label()
                Spacer(minLength: 8)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(selected ? Theme.brand : Theme.muted.opacity(0.45))
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 64)
            .background(selected ? Theme.brand.opacity(0.08) : Color.clear)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { ThinDivider(leading: 72) }
        }
        .buttonStyle(.plain)
        .disabled(!vm.canTransfer || busy)
        .opacity(vm.canTransfer ? 1 : 0.5)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Confirmação

    private func confirmBar(_ choice: Choice) -> some View {
        let info = confirmInfo(choice)
        return VStack(alignment: .leading, spacing: 8) {
            Text(info.question).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            if let detail = info.detail {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: info.warning ? "exclamationmark.triangle.fill" : "info.circle.fill")
                        .font(.system(size: 12)).foregroundStyle(info.warning ? Theme.warn : Theme.textSecondary).padding(.top, 2)
                    Text(detail).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                SecondaryButton(title: "Cancelar", color: Theme.textSecondary, disabled: busy) { self.choice = nil }
                    .frame(maxWidth: 130)
                PrimaryButton(title: info.button, busy: busy) { confirm(choice) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ThinDivider() }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func confirmInfo(_ choice: Choice) -> (question: String, detail: String?, warning: Bool, button: String) {
        switch choice {
        case .person(let p):
            return ("Transferir para \(p.name)?", p.online ? nil : "\(workspace.firstName(p.name)) está offline e pode demorar a responder.", !p.online, "Transferir")
        case .bot(let b):
            return ("Transferir para o bot \(b.name)?", b.online ? nil : "O bot \(b.name) está indisponível no momento.", !b.online, "Transferir")
        case .automation:
            return ("Devolver ao atendimento automático?", "A IA do perfil volta a responder o cliente.", false, "Devolver")
        case .department(let d):
            let online = d.members.filter { workspace.isOnline($0) }.count
            return ("Encaminhar ao setor \(d.name)?", online == 0 ? "Ninguém do setor está online agora; a conversa fica na fila." : "A conversa volta para a fila do setor.", online == 0, "Encaminhar")
        case .menu(let id, let label):
            return (id == nil ? "Enviar o menu principal ao cliente?" : "Enviar o menu \"\(label)\" ao cliente?", vm.window?.isClosed == true ? "A janela de 24h está fechada: o menu só é entregue quando o cliente escrever." : nil, vm.window?.isClosed == true, "Enviar menu")
        case .protocols:
            return ("Enviar a consulta de protocolos ao cliente?", nil, false, "Enviar")
        }
    }

    private func confirm(_ choice: Choice) {
        guard !busy else { return }
        busy = true
        Task {
            let ok: Bool
            switch choice {
            case .person(let p): ok = await vm.transfer(to: p)
            case .bot(let b): ok = await vm.transfer(to: b)
            case .automation: ok = await vm.resumeAutomation()
            case .department(let d): ok = await vm.transfer(toDepartment: d)
            case .menu(let id, let label): ok = await vm.sendMenu(id: id, label: label)
            case .protocols: ok = await vm.sendProtocols()
            }
            busy = false
            if ok { dismiss() } else { self.choice = nil }
        }
    }
}

/// Protocolo em uma linha compacta (folha de transferir e Dados da conversa).
struct TicketMiniRow: View {
    let ticket: Ticket
    var chevron = true

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(ticket.number).font(Theme.font(13, .semibold, design: .monospaced)).foregroundStyle(Theme.ticket)
                    TicketStatusBadge(status: ticket.status)
                }
                Text(ticket.title.isEmpty ? "Sem título" : ticket.title).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
            }
            Spacer(minLength: 4)
            if chevron { Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
        .contentShape(Rectangle())
    }
}
