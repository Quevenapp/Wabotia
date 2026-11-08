import SwiftUI

/// Lista de protocolos do perfil com filtros Abertos/Em andamento/Atrasados/Concluídos/Todos,
/// paginação por cursor e pull-to-refresh (GET /profiles/{p}/tickets).
@MainActor
final class TicketsViewModel: ObservableObject {
    @Published var filter: TicketFilter = .open
    @Published private(set) var tickets: [Ticket] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    private var moreTask: Task<Void, Never>?
    private var container: AppContainer { AppContainer.shared }

    /// Carrega a primeira página do filtro atual. `quiet` não mostra o indicador central (pull-to-refresh, retorno à tela).
    func load(quiet: Bool = false) async {
        guard let profile = container.profileId else { return }
        moreTask?.cancel()
        if !quiet { loading = true }
        errorMessage = nil
        let filter = self.filter
        do {
            let page = try await container.api.tickets(profile, status: filter.status, overdue: filter.overdue)
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
        moreTask = Task { [weak self] in
            guard let self else { return }
            defer { self.loadingMore = false }
            do {
                let page = try await self.container.api.tickets(profile, status: filter.status, overdue: filter.overdue, cursor: cursor)
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

struct TicketsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = TicketsViewModel()

    var body: some View {
        List {
            if let error = model.errorMessage, !model.tickets.isEmpty {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            ForEach(model.tickets) { ticket in
                RouteLink(route: Route.ticket(id: ticket.id)) {
                    TicketRowView(ticket: ticket)
                }
            }
            if model.nextCursor != nil {
                HStack {
                    Spacer()
                    if model.loadingMore {
                        ProgressView()
                    } else {
                        Button("Carregar mais") { model.loadMore() }
                    }
                    Spacer()
                }
                .onAppear { model.loadMore() }
            }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .top, spacing: 0) { filters }
        .overlay { placeholder }
        .refreshable { await model.load(quiet: true) }
        .navigationTitle("Protocolos")
        // Roda ao aparecer (inclusive ao voltar do detalhe) e quando filtro/perfil mudam.
        .task(id: taskKey) { await model.load(quiet: model.hasLoaded) }
    }

    /// Recarrega quando o filtro ou o perfil mudam.
    private var taskKey: String { "\(model.filter.rawValue)|\(container.profileId ?? "")" }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TicketFilter.allCases) { filter in
                    TicketFilterChipView(title: filter.title, selected: model.filter == filter) {
                        if model.filter != filter { model.filter = filter }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    @ViewBuilder private var placeholder: some View {
        if model.tickets.isEmpty {
            if model.loading && !model.hasLoaded {
                ProgressView()
            } else if let error = model.errorMessage {
                EmptyStateView(title: "Não foi possível carregar", systemImage: "exclamationmark.triangle", message: error)
            } else if model.hasLoaded {
                EmptyStateView(title: emptyTitle, systemImage: "doc.text", message: "Protocolos são abertos a partir de uma conversa assumida, pelo menu Abrir protocolo.")
            }
        }
    }

    private var emptyTitle: String {
        switch model.filter {
        case .open: return "Nenhum protocolo aberto"
        case .inProgress: return "Nenhum protocolo em andamento"
        case .overdue: return "Nenhum protocolo atrasado"
        case .closed: return "Nenhum protocolo concluído"
        case .all: return "Nenhum protocolo"
        }
    }
}

/// Linha da lista: número WA-…, título, estado e prazo colorido.
struct TicketRowView: View {
    let ticket: Ticket

    private var due: TicketsSupport.Due { TicketsSupport.due(for: ticket) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(ticket.number).font(.subheadline.weight(.semibold)).monospacedDigit()
                Spacer()
                TicketStatusBadge(status: ticket.status)
            }
            Text(ticket.title.isEmpty ? "Sem título" : ticket.title)
                .font(.body)
                .lineLimit(2)
            HStack(spacing: 6) {
                Image(systemName: due.icon).font(.caption)
                Text(due.text).font(.caption)
                Spacer()
                Text(TicketsSupport.shortDate(ticket.created)).font(.caption).foregroundStyle(.secondary)
            }
            .foregroundStyle(due.color)
        }
        .padding(.vertical, 4)
    }
}
