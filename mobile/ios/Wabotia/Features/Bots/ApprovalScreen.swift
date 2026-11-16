import SwiftUI

/// Um pedido de aprovação aberto pelo aviso (`data.type: "approval"`, `approval_id`): o mesmo cartão da conversa
/// interna, relido de `GET …/approvals/{id}` (já mostra quem decidiu, se alguém decidiu antes).
struct ApprovalScreen: View {
    let id: String
    @EnvironmentObject private var container: AppContainer
    @Environment(\.pushRoute) private var push
    @State private var approval: BotApproval?
    @State private var error: String?
    @State private var busy = false

    private var api: LiveBotActionsAPI { LiveBotActionsAPI(api: container.api, profile: container.profileId ?? "") }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let approval {
                    ApprovalCardView(approval: approval, busy: busy) { value in
                        decide("approve", value: value)
                    } onDecline: { reason in
                        decide("decline", reason: reason)
                    } onHandoff: {
                        decide("handoff")
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
                if let error { InlineError(text: error) { Task { await load() } } }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Pedido de aprovação")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            approval = try await api.approval(id)
            error = nil
        } catch {
            self.error = container.serviceError(error)
        }
    }

    private func decide(_ decision: String, value: Double? = nil, reason: String? = nil) {
        guard let current = approval else { return }
        busy = true
        Task {
            defer { busy = false }
            switch await BotActions(api: api).decide(current, decision: decision, value: value, reason: reason) {
            case .approval(let fresh):
                approval = fresh
                error = nil
                if decision == "handoff", fresh.status == "handoff", let conversation = fresh.conversation_id,
                   fresh.decided_by?.objectValue?["id"]?.stringValue.map({ $0 == container.user?.id }) ?? true {
                    push(.conversation(id: conversation))
                }
            case .failed(let text), .reload(let text?):
                error = text
                await load()
            default:
                await load()
            }
        }
    }
}
