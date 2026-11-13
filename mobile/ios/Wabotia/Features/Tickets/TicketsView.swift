import SwiftUI

/// Lista de protocolos do perfil com filtros Ativos/Recebidos/Em análise/Aguardando/Atrasados/Resolvidos/Todos,
/// filtro por categoria, busca por número ou telefone (`q`), paginação por cursor e pull-to-refresh
/// (GET /profiles/{p}/tickets).
@MainActor
final class TicketsViewModel: ObservableObject {
    @Published var filter: TicketFilter = .active
    /// Categoria escolhida no filtro (`id`), ou nil para todas.
    @Published var category: String?
    @Published var query = ""
    @Published private(set) var tickets: [Ticket] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    private var moreTask: Task<Void, Never>?
    private var container: AppContainer { AppContainer.shared }
    private var q: String? {
        let value = query.trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    /// Carrega a primeira página do filtro atual. `quiet` não mostra o esqueleto (pull-to-refresh, retorno à tela).
    func load(quiet: Bool = false) async {
        guard let profile = container.profileId else { return }
        moreTask?.cancel()
        if !quiet { loading = true }
        errorMessage = nil
        let filter = self.filter
        do {
            let page = try await fetch(profile, filter: filter, category: category, q: q, cursor: nil)
            if Task.isCancelled { return }
            tickets = Self.sorted(page.data)
            nextCursor = page.next_cursor
            hasLoaded = true
        } catch {
            if Task.isCancelled { return }
            if let message = TicketsSupport.failure(error) { errorMessage = message }
        }
        loading = false
    }

    /// Próxima página (cursor opaco devolvido pelo servidor).
    func loadMore() {
        guard let cursor = nextCursor, !loadingMore, let profile = container.profileId else { return }
        loadingMore = true
        let filter = self.filter
        let category = self.category
        let q = self.q
        moreTask = Task { [weak self] in
            guard let self else { return }
            defer { self.loadingMore = false }
            do {
                let page = try await self.fetch(profile, filter: filter, category: category, q: q, cursor: cursor)
                guard !Task.isCancelled, filter == self.filter, category == self.category else { return }
                var seen = Set(self.tickets.map(\.id))
                let fresh = page.data.filter { seen.insert($0.id).inserted }
                self.tickets = Self.sorted(self.tickets + fresh)
                self.nextCursor = page.next_cursor
            } catch {
                if Task.isCancelled { return }
                if let message = TicketsSupport.failure(error) { self.errorMessage = message }
            }
        }
    }

    /// Uma página do filtro. Filtros com mais de um estado (Aguardando, Resolvidos) fazem uma consulta por estado e
    /// juntam o resultado, sem paginação; um estado que o servidor não conhece (0.13) conta como lista vazia.
    private func fetch(_ profile: String, filter: TicketFilter, category: String?, q: String?, cursor: String?) async throws -> Page<Ticket> {
        let api = container.api
        if filter.statuses.count > 1 {
            var merged: [Ticket] = []
            var answered = false
            var failure: Error?
            for status in filter.statuses {
                do {
                    merged += try await api.tickets(profile, status: status, q: q, category: category).data
                    answered = true
                } catch let error as APIError where !error.isUnauthorized && (error.status == 400 || error.status == 422) {
                    answered = true
                } catch {
                    if (error as? APIError)?.isUnauthorized == true { throw error }
                    failure = error
                }
            }
            if !answered, let failure { throw failure }
            var seen = Set<String>()
            return Page(data: merged.filter { seen.insert($0.id).inserted && filter.matches($0) }, next_cursor: nil)
        }
        var page = try await api.tickets(profile, status: filter.statuses.first, overdue: filter.overdue, q: q, cursor: cursor, active: filter.activeOnly, category: category)
        page.data = page.data.filter { filter.matches($0) }
        return page
    }

    /// O servidor ordena por ID (opaco); a lista mostra os mais recentes primeiro.
    private static func sorted(_ list: [Ticket]) -> [Ticket] {
        list.sorted { $0.created > $1.created }
    }
}

/// Aba Protocolos (mobile/DESIGN.md, seção 8).
struct TicketsView: View {
    let active: Bool
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @StateObject private var model = TicketsViewModel()
    @ObservedObject private var workspace = Workspace.shared
    @State private var searching = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if searching {
                SearchField(placeholder: "Número ou telefone", text: $model.query, focused: $searchFocused) {
                    model.query = ""
                    searching = false
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 56)
                .onAppear { searchFocused = true }
            } else {
                ScreenHeader(title: "Protocolos", subtitle: summary) {
                    IconButton(systemName: "magnifyingglass", label: "Buscar protocolo") { searching = true }
                }
            }
            filters
            categoryFilter
            ThinDivider()
            content
        }
        .background(Theme.background.ignoresSafeArea())
        // Roda ao aparecer (inclusive ao voltar do detalhe) e quando filtro, busca ou perfil mudam.
        .task(id: taskKey) {
            guard active else { return }
            #if DEBUG
            if let wanted = DemoMode.takeSheet("tickets-all", "tickets-waiting", "tickets-resolved", "tickets-overdue"),
               let filter = TicketFilter(rawValue: String(wanted.dropFirst("tickets-".count))), filter != model.filter {
                model.filter = filter
                return
            }
            #endif
            if !model.query.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if Task.isCancelled { return }
            await model.load(quiet: model.hasLoaded)
            await workspace.refreshTicketCounts()
        }
        .onAppear { if active, model.hasLoaded { Task { await model.load(quiet: true) } } }
    }

    private var taskKey: String { "\(model.filter.rawValue)|\(model.category ?? "")|\(container.profileId ?? "")|\(active)|\(model.query)" }

    private var summary: String {
        let counts = workspace.ticketCounts
        if counts.overdue > 0 { return counts.overdue == 1 ? "1 atrasado" : "\(counts.overdue) atrasados" }
        if counts.active > 0 { return counts.active == 1 ? "1 ativo" : "\(counts.active) ativos" }
        return "Tudo em dia"
    }

    /// Filtro por categoria (aplicativo ou assunto): só aparece quando o perfil tem categorias configuradas.
    @ViewBuilder private var categoryFilter: some View {
        let categories = workspace.ticketCategories.filter { $0.enabled || $0.id == model.category }
        if !categories.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Image(systemName: "square.grid.2x2.fill").font(.system(size: 13)).foregroundStyle(Theme.textSecondary).accessibilityLabel("Categoria")
                    categoryChip("Todas", id: nil)
                    ForEach(categories) { category in categoryChip(category.name, id: category.id) }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
    }

    private func categoryChip(_ title: String, id: String?) -> some View {
        let selected = model.category == id
        return Button { model.category = id } label: {
            Text(title)
                .font(Theme.font(13, selected ? .semibold : .medium))
                .lineLimit(1)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .foregroundStyle(selected ? Theme.ticket : Theme.textSecondary)
                .background(Capsule().fill(selected ? Theme.ticket.opacity(0.16) : Theme.surface))
                .overlay(Capsule().stroke(selected ? Color.clear : Theme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TicketFilter.allCases) { filter in
                    FilterChip(title: filter.title, count: count(filter), selected: model.filter == filter, attention: filter == .overdue && workspace.ticketCounts.overdue > 0 ? Theme.danger : nil) {
                        model.filter = filter
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func count(_ filter: TicketFilter) -> Int? {
        let counts = workspace.ticketCounts
        switch filter {
        case .active: return counts.active
        case .open: return counts.open
        case .inProgress: return counts.inProgress
        case .waiting: return counts.waiting
        case .overdue: return counts.overdue
        case .resolved, .all: return nil
        }
    }

    @ViewBuilder private var content: some View {
        if model.tickets.isEmpty {
            if !model.hasLoaded, model.errorMessage == nil {
                SkeletonList(rows: 5, avatar: false)
            } else if let error = model.errorMessage {
                VStack { InlineError(text: error) { Task { await model.load() } }.padding(16); Spacer() }
            } else {
                ScrollView { EmptyStateView(title: emptyTitle, systemImage: "doc.text", message: emptyMessage).padding(.top, 40) }
            }
        } else {
            List {
                if let error = model.errorMessage {
                    InlineError(text: error) { Task { await model.load(quiet: true) } }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 4, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Theme.background)
                }
                ForEach(model.tickets) { ticket in
                    Button { push(.ticket(id: ticket.id)) } label: {
                        TicketCard(ticket: ticket, ownerName: ticket.owner.map { workspace.personName($0) }, categoryName: workspace.categoryName(ticket.category))
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.background)
                }
                if model.nextCursor != nil {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowSeparator(.hidden)
                        .listRowBackground(Theme.background)
                        .onAppear { model.loadMore() }
                }
            }
            .listStyle(.plain)
            .appListBackground(Theme.background)
            .refreshable {
                await model.load(quiet: true)
                await workspace.refreshTicketCounts()
            }
        }
    }

    private var emptyTitle: String {
        if !model.query.trimmingCharacters(in: .whitespaces).isEmpty { return "Nada encontrado" }
        switch model.filter {
        case .active: return "Nenhum protocolo ativo"
        case .open: return "Nenhum protocolo recebido"
        case .inProgress: return "Nenhum protocolo em análise"
        case .waiting: return "Nenhum protocolo aguardando"
        case .overdue: return "Nenhum protocolo atrasado"
        case .resolved: return "Nenhum protocolo resolvido ou encerrado"
        case .all: return "Nenhum protocolo"
        }
    }

    private var emptyMessage: String {
        if !model.query.trimmingCharacters(in: .whitespaces).isEmpty { return "Busque pelo número WA-… ou pelos dígitos do telefone." }
        switch model.filter {
        case .overdue: return "Nenhum prazo estourado. Bom trabalho!"
        case .waiting: return "Aqui ficam os protocolos que dependem do cliente ou de um terceiro."
        case .resolved: return "Protocolos resolvidos e encerrados aparecem aqui."
        default: return "Abra um protocolo a partir de uma conversa assumida."
        }
    }
}

/// Cartão do protocolo: número, título em duas linhas, estado, categoria, responsável e prazo com anel.
struct TicketCard: View {
    let ticket: Ticket
    var ownerName: String?
    /// Nome da categoria (aplicativo ou assunto) já resolvido; nil quando o protocolo não tem categoria.
    var categoryName: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Text(ticket.number).font(Theme.font(14, .semibold, design: .monospaced)).foregroundStyle(Theme.ticket).lineLimit(1)
                Spacer(minLength: 4)
                TicketStatusBadge(status: ticket.status)
            }
            Text(ticket.title.isEmpty ? "Sem título" : ticket.title)
                .font(Theme.font(16, .medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let categoryName, !categoryName.isEmpty { TicketCategoryTag(name: categoryName) }
            HStack(spacing: 6) {
                if let ownerName, !ownerName.isEmpty {
                    AvatarView(name: ownerName == "Você" ? (AppContainer.shared.user?.name ?? "Você") : ownerName, seed: ticket.owner ?? "", size: 22)
                    Text(ownerName).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                } else {
                    Image(systemName: "person.crop.circle.badge.questionmark").font(.system(size: 14)).foregroundStyle(Theme.muted)
                    Text("Sem responsável").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                TicketDueView(due: TicketsSupport.due(for: ticket)).layoutPriority(1)
            }
        }
        .card()
        .accessibilityElement(children: .combine)
    }
}
