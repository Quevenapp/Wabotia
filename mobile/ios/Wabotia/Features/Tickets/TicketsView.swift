import SwiftUI

/// Lista de protocolos do perfil com filtros Abertos/Em andamento/Atrasados/Concluídos/Todos, busca por
/// número ou telefone (`q`), paginação por cursor e pull-to-refresh (GET /profiles/{p}/tickets).
@MainActor
final class TicketsViewModel: ObservableObject {
    @Published var filter: TicketFilter = .open
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
            let page = try await container.api.tickets(profile, status: filter.status, overdue: filter.overdue, q: q)
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
        let q = self.q
        moreTask = Task { [weak self] in
            guard let self else { return }
            defer { self.loadingMore = false }
            do {
                let page = try await self.container.api.tickets(profile, status: filter.status, overdue: filter.overdue, q: q, cursor: cursor)
                guard !Task.isCancelled, filter == self.filter else { return }
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
            ThinDivider()
            content
        }
        .background(Theme.background.ignoresSafeArea())
        // Roda ao aparecer (inclusive ao voltar do detalhe) e quando filtro, busca ou perfil mudam.
        .task(id: taskKey) {
            guard active else { return }
            if !model.query.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if Task.isCancelled { return }
            await model.load(quiet: model.hasLoaded)
            await workspace.refreshTicketCounts()
        }
        .onAppear { if active, model.hasLoaded { Task { await model.load(quiet: true) } } }
    }

    private var taskKey: String { "\(model.filter.rawValue)|\(container.profileId ?? "")|\(active)|\(model.query)" }

    private var summary: String {
        let counts = workspace.ticketCounts
        if counts.overdue > 0 { return counts.overdue == 1 ? "1 atrasado" : "\(counts.overdue) atrasados" }
        if counts.open + counts.inProgress > 0 { return "\(counts.open + counts.inProgress) em aberto" }
        return "Tudo em dia"
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
        case .open: return counts.open
        case .inProgress: return counts.inProgress
        case .overdue: return counts.overdue
        case .closed, .all: return nil
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
                        TicketCard(ticket: ticket, ownerName: ticket.owner.map { workspace.personName($0) })
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
        case .open: return "Nenhum protocolo aberto"
        case .inProgress: return "Nenhum protocolo em andamento"
        case .overdue: return "Nenhum protocolo atrasado"
        case .closed: return "Nenhum protocolo concluído"
        case .all: return "Nenhum protocolo"
        }
    }

    private var emptyMessage: String {
        if !model.query.trimmingCharacters(in: .whitespaces).isEmpty { return "Busque pelo número WA-… ou pelos dígitos do telefone." }
        return model.filter == .overdue ? "Nenhum prazo estourado. Bom trabalho!" : "Abra um protocolo a partir de uma conversa assumida."
    }
}

/// Cartão do protocolo: número, título em duas linhas, estado, responsável e prazo com anel.
struct TicketCard: View {
    let ticket: Ticket
    var ownerName: String?

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
