import SwiftUI

/// Conversa do entregador com a loja ou com o cliente, pelo Wabotia (o número do entregador não aparece).
struct CourierChatView: View {
    @ObservedObject var vm: CourierViewModel
    let id: String
    let peer: CourierPeer
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    private var messages: [CourierMessage] { vm.chats[vm.chatKey(id, peer)] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        if messages.isEmpty {
                            Text(peer == .store ? "Escreva para a loja: atraso, dúvida no endereço, troco." : "Escreva para o cliente: ele recebe no WhatsApp da loja.")
                                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center).padding(.top, 30)
                        }
                        ForEach(messages) { m in bubble(m).id(m.id) }
                    }
                    .padding(16)
                }
                .onChange(of: messages.count) { _ in if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
            }
            HStack(spacing: 8) {
                TextField("Mensagem", text: $draft)
                    .focused($focused)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.surface))
                    .accessibilityIdentifier("courier.chat.field")
                Button {
                    let text = draft
                    sending = true
                    Task {
                        if await vm.send(id, peer, text) { draft = "" }
                        sending = false
                    }
                } label: {
                    Image(systemName: "paperplane.fill").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.onBrand)
                        .frame(width: 44, height: 44).background(Circle().fill(Theme.brand))
                }
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Enviar")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(peer == .store ? "Loja" : (vm.deliveries[id]?.customerName ?? "Cliente"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Sem WebSocket para o entregador: lê a conversa a cada 4 s enquanto a tela está aberta.
            while !Task.isCancelled {
                await vm.loadChat(id, peer)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func bubble(_ m: CourierMessage) -> some View {
        HStack {
            if m.mine { Spacer(minLength: 40) }
            Text(m.text).font(Theme.font(15)).foregroundStyle(m.mine ? Theme.onBrand : Theme.textPrimary)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(m.mine ? Theme.brand : Theme.surface))
            if !m.mine { Spacer(minLength: 40) }
        }
    }
}
