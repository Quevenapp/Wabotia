import SwiftUI

/// Conversa do entregador com a loja (`store`, interna) ou com o cliente (`customer`, sai pelo WhatsApp da loja como
/// "Nome - Entregador: …"; só com a janela de 24 h aberta). O número do cliente nunca aparece.
struct CourierChatView: View {
    @ObservedObject var vm: CourierViewModel
    let id: String
    let peer: CourierPeer
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    private var messages: [CourierMessage] { vm.messages(id, peer) }
    /// Com o cliente, só com a janela aberta.
    private var canWrite: Bool { peer == .store || vm.customerOpen(id) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        if messages.isEmpty {
                            Text(peer == .store ? "Escreva para a loja: atraso, dúvida no endereço, troco." : "Escreva para o cliente: ele recebe no WhatsApp da loja, sem ver o seu número.")
                                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center).padding(.top, 30)
                        }
                        ForEach(messages) { m in bubble(m).id(m.seq) }
                    }
                    .padding(16)
                }
                .onChange(of: messages.count) { _ in if let last = messages.last { withAnimation { proxy.scrollTo(last.seq, anchor: .bottom) } } }
            }
            if !canWrite {
                DeviceNotice(text: "O cliente não escreve para a loja há mais de 24 horas: o WhatsApp não deixa mandar mensagem agora. Fale com a loja.")
                    .padding(.horizontal, 12).padding(.top, 8)
            } else if let error = vm.chatError {
                InlineError(text: error).padding(.horizontal, 12).padding(.top, 8)
            }
            HStack(spacing: 8) {
                TextField(canWrite ? "Mensagem" : "Indisponível agora", text: $draft)
                    .focused($focused)
                    .disabled(!canWrite)
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
                .disabled(!canWrite || sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Enviar")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(peer == .store ? "Loja" : (vm.deliveries[id]?.customerName ?? "Cliente"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { vm.chatError = nil; vm.viewChat(id, peer) }
        .onDisappear { vm.viewChat(id, nil) }
        .task {
            // Sem WebSocket nesta versão: a conversa aberta é lida a cada 15 s (3 s na demonstração).
            while !Task.isCancelled {
                await vm.loadChat(id)
                vm.viewChat(id, peer)
                try? await Task.sleep(nanoseconds: UInt64(vm.services.chatPollSeconds * 1_000_000_000))
            }
        }
    }

    private func bubble(_ m: CourierMessage) -> some View {
        HStack {
            if m.mine { Spacer(minLength: 40) }
            VStack(alignment: m.mine ? .trailing : .leading, spacing: 2) {
                if !m.mine, let author = m.authorName, !author.isEmpty {
                    Text(author).font(Theme.font(11, .semibold)).foregroundStyle(Theme.textSecondary)
                }
                Text(m.text).font(Theme.font(15)).foregroundStyle(m.mine ? Theme.onBrand : Theme.textPrimary)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(m.mine ? Theme.brand : Theme.surface))
            }
            if !m.mine { Spacer(minLength: 40) }
        }
    }
}
