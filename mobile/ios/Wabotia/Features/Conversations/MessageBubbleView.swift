import SwiftUI
import UIKit

/// Contorno da bolha: cantos de 12 e "rabinho" no canto de cima da primeira bolha de cada grupo.
/// O corpo sempre recua `tailWidth` do lado do rabinho, para as bolhas do grupo ficarem alinhadas.
struct BubbleShape: Shape {
    enum Tail { case leading, trailing, noneLeading, noneTrailing }
    static let tailWidth: CGFloat = 7

    var tail: Tail
    var radius: CGFloat = Theme.bubbleRadius

    func path(in rect: CGRect) -> Path {
        let t = Self.tailWidth
        let leadingSide = tail == .leading || tail == .noneLeading
        let body = CGRect(x: rect.minX + (leadingSide ? t : 0), y: rect.minY, width: max(0, rect.width - t), height: rect.height)
        let r = min(radius, body.height / 2, body.width / 2)
        var path = Path()
        switch tail {
        case .noneLeading, .noneTrailing:
            path.addRoundedRect(in: body, cornerSize: CGSize(width: r, height: r), style: .continuous)
        case .trailing:
            path.move(to: CGPoint(x: body.minX + r, y: body.minY))
            path.addLine(to: CGPoint(x: rect.maxX - 2, y: body.minY))
            path.addQuadCurve(to: CGPoint(x: rect.maxX - 1, y: body.minY + 2.5), control: CGPoint(x: rect.maxX + 0.5, y: body.minY))
            path.addLine(to: CGPoint(x: body.maxX, y: body.minY + 10))
            path.addLine(to: CGPoint(x: body.maxX, y: body.maxY - r))
            path.addArc(center: CGPoint(x: body.maxX - r, y: body.maxY - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
            path.addLine(to: CGPoint(x: body.minX + r, y: body.maxY))
            path.addArc(center: CGPoint(x: body.minX + r, y: body.maxY - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
            path.addLine(to: CGPoint(x: body.minX, y: body.minY + r))
            path.addArc(center: CGPoint(x: body.minX + r, y: body.minY + r), radius: r, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
            path.closeSubpath()
        case .leading:
            path.move(to: CGPoint(x: body.maxX - r, y: body.minY))
            path.addLine(to: CGPoint(x: rect.minX + 2, y: body.minY))
            path.addQuadCurve(to: CGPoint(x: rect.minX + 1, y: body.minY + 2.5), control: CGPoint(x: rect.minX - 0.5, y: body.minY))
            path.addLine(to: CGPoint(x: body.minX, y: body.minY + 10))
            path.addLine(to: CGPoint(x: body.minX, y: body.maxY - r))
            path.addArc(center: CGPoint(x: body.minX + r, y: body.maxY - r), radius: r, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
            path.addLine(to: CGPoint(x: body.maxX - r, y: body.maxY))
            path.addArc(center: CGPoint(x: body.maxX - r, y: body.maxY - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(0), clockwise: true)
            path.addLine(to: CGPoint(x: body.maxX, y: body.minY + r))
            path.addArc(center: CGPoint(x: body.maxX - r, y: body.minY + r), radius: r, startAngle: .degrees(0), endAngle: .degrees(-90), clockwise: true)
            path.closeSubpath()
        }
        return path
    }
}

/// Bolha de mensagem: quem enviou, citação, mídia, texto, reações, horário e ticks dentro da bolha.
/// É `Equatable` (só os dados entram na comparação) para que digitar no composer não redesenhe a lista.
struct MessageBubbleView: View, Equatable {
    let item: ChatMessage
    let profileId: String
    let maxWidth: CGFloat
    let isGroup: Bool
    let actionable: Bool
    let canReply: Bool
    var onLongPress: () -> Void
    var onReply: () -> Void
    var onQuoteTap: (String) -> Void
    var onFailedTap: () -> Void

    static func == (a: MessageBubbleView, b: MessageBubbleView) -> Bool {
        a.item == b.item && a.profileId == b.profileId && a.maxWidth == b.maxWidth && a.isGroup == b.isGroup && a.actionable == b.actionable && a.canReply == b.canReply
    }

    @Environment(\.openURL) private var openURL
    @State private var drag: CGFloat = 0

    private var message: Message { item.message }
    private var incoming: Bool { item.side == .incoming }
    private var isNote: Bool { item.side == .note }
    private var contentWidth: CGFloat { maxWidth - BubbleShape.tailWidth - 18 }
    /// Largura comum de mídia, mapa e cartões dentro da bolha.
    private var mediaWidth: CGFloat { min(contentWidth, 252) }

    var body: some View {
        HStack(spacing: 0) {
            if !incoming { Spacer(minLength: 0) }
            bubble.frame(maxWidth: maxWidth, alignment: incoming ? .leading : .trailing)
            if incoming { Spacer(minLength: 0) }
        }
        .padding(.bottom, item.reactions.isEmpty ? 0 : 15)
        .offset(x: drag)
        .background(alignment: .leading) {
            if drag > 4 {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Theme.bubbleSystem))
                    .opacity(Double(min(1, drag / 48)))
                    .scaleEffect(drag >= 48 ? 1.1 : 0.9)
                    .padding(.leading, 6)
            }
        }
        .simultaneousGesture(swipe, including: canReply ? .all : .subviews)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Ações da mensagem") { onLongPress() }
    }

    /// Deslizar para a direita = Responder.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                guard value.translation.width > 0, abs(value.translation.width) > abs(value.translation.height) * 1.6 else { return }
                drag = min(64, value.translation.width * 0.6)
            }
            .onEnded { _ in
                if drag >= 48 { onReply() }
                withAnimation(.quick) { drag = 0 }
            }
    }

    // MARK: Bolha

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isNote {
                HStack(spacing: 4) {
                    Image(systemName: "lock.fill").font(.system(size: 10, weight: .semibold))
                    Text(noteTitle).font(Theme.font(12, .semibold)).lineLimit(1)
                }
                .foregroundStyle(Theme.noteText)
            } else if item.firstInGroup {
                senderLabel
            }
            if let quoted = item.quotedText { quoteBlock(quoted) }
            content
        }
        .padding(.top, 6)
        .padding(.bottom, 6)
        .padding(.leading, 9 + (incoming ? BubbleShape.tailWidth : 0))
        .padding(.trailing, 9 + (incoming ? 0 : BubbleShape.tailWidth))
        .background(BubbleShape(tail: tail).fill(color).shadow(color: Theme.shadow, radius: 0.5, y: 0.8))
        .overlay(alignment: .bottomLeading) {
            // Sempre do lado esquerdo da bolha, para não cobrir o horário e os ticks.
            if !item.reactions.isEmpty {
                reactionsPill.offset(x: incoming ? 14 : 8, y: 14)
            }
        }
        .contentShape(Rectangle())
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in onLongPress() })
    }

    private var tail: BubbleShape.Tail {
        if incoming { return item.firstInGroup ? .leading : .noneLeading }
        return item.firstInGroup ? .trailing : .noneTrailing
    }

    private var color: Color {
        if isNote { return Theme.bubbleNote }
        return incoming ? Theme.bubbleIn : Theme.bubbleOut
    }

    private var noteTitle: String {
        switch item.sender {
        case .me: return "Nota interna · Você"
        case .agent(let name), .bot(let name): return "Nota interna · \(name)"
        default: return "Nota interna"
        }
    }

    @ViewBuilder private var senderLabel: some View {
        switch item.sender {
        case .participant(let name):
            Text(name).font(Theme.font(13, .semibold)).foregroundStyle(Theme.avatarColor(item.content["participant"]?.stringValue ?? name)).lineLimit(1)
        case .bot(let name):
            HStack(spacing: 4) {
                RobotIcon(size: 12)
                Text(name).font(Theme.font(12, .semibold)).foregroundStyle(Theme.bot).lineLimit(1)
            }
        case .agent(let name):
            Text(name).font(Theme.font(12, .semibold)).foregroundStyle(Theme.brand).lineLimit(1)
        case .automatic:
            Text("Mensagem automática").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).lineLimit(1)
        case .me, .none:
            EmptyView()
        }
    }

    private func quoteBlock(_ text: String) -> some View {
        Button { if let id = item.quotedId { onQuoteTap(id) } } label: {
            HStack(spacing: 0) {
                Theme.brand.frame(width: 4)
                VStack(alignment: .leading, spacing: 1) {
                    if let author = item.quotedAuthor {
                        Text(author).font(Theme.font(12, .semibold)).foregroundStyle(Theme.brand).lineLimit(1)
                    }
                    Text(text).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(2).multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                Spacer(minLength: 0)
            }
            .frame(minWidth: 150, alignment: .leading)
            .background(Color.black.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Conteúdo

    @ViewBuilder private var content: some View {
        if item.isDeleted {
            HStack(alignment: .bottom, spacing: 8) {
                HStack(spacing: 5) {
                    Image(systemName: "nosign").font(.system(size: 13))
                    Text("Mensagem apagada").italic().font(Theme.font(15))
                }
                .foregroundStyle(Theme.textSecondary)
                meta
            }
        } else {
            let location = item.content["location"]
            let contacts = item.content["contacts"]?.arrayValue ?? []
            let hasExtras = !item.media.isEmpty || location != nil || !contacts.isEmpty
            // Mídia sozinha: o horário vai sobre a foto/vídeo (em cápsula escura) ou no canto do áudio.
            let alone = message.text.isEmpty && item.media.count == 1 && location == nil && contacts.isEmpty
            let visualOnly = alone && (item.media[0].isImage || item.media[0].isVideo)
            let audioOnly = alone && item.media[0].isAudio
            ForEach(item.media) { file in
                AttachmentView(file: file, profileId: profileId, isVoiceMessage: item.isVoice, outgoing: !incoming, width: mediaWidth)
                    .padding(.bottom, audioOnly ? 9 : 0)
                    .overlay(alignment: .bottomTrailing) {
                        if visualOnly {
                            metaRow(onMedia: true)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(Capsule().fill(Color.black.opacity(0.45)))
                                .padding(5)
                        } else if audioOnly {
                            metaRow(onMedia: false)
                        }
                    }
            }
            if let location, let lat = location["latitude"]?.doubleValue, let lon = location["longitude"]?.doubleValue {
                LocationCard(latitude: lat, longitude: lon, name: location["name"]?.stringValue, address: location["address"]?.stringValue, width: mediaWidth)
            }
            ForEach(Array(contacts.enumerated()), id: \.offset) { _, contact in
                ContactCard(name: contact["name"]?.stringValue ?? "", phone: contact["phone"]?.stringValue ?? "", width: mediaWidth)
            }
            if !message.text.isEmpty {
                ZStack(alignment: .bottomTrailing) {
                    (Text(message.text).font(Theme.font(16)).foregroundColor(Theme.textPrimary)
                     + Text(metaSpacer).font(Theme.font(11)).foregroundColor(.clear))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minWidth: hasExtras ? mediaWidth : nil, alignment: .leading)
                        .accessibilityLabel(message.text)
                    meta
                }
            } else if visualOnly || audioOnly {
                EmptyView()
            } else if hasExtras {
                HStack { Spacer(minLength: 0); meta }.frame(width: mediaWidth)
            } else {
                meta
            }
            if let receipts = item.content["receipts"]?.objectValue, !receipts.isEmpty, !incoming {
                let read = receipts.values.filter { ["read", "played"].contains($0["status"]?.stringValue ?? "") }.count
                Text("\(read) de \(receipts.count) leram").font(Theme.font(11)).foregroundStyle(Theme.textSecondary)
            }
        }
    }

    /// Reserva invisível no fim do texto (uma "palavra" de dígitos transparentes) para o horário e os ticks
    /// caberem na última linha; quando não cabem, ela quebra sozinha e o horário desce uma linha.
    private var metaSpacer: String {
        var width: CGFloat = 40 // horário + folga
        if item.isEdited { width += 46 }
        if item.side == .outgoing { width += 22 }
        return " " + String(repeating: "0", count: Int((width / 6.3).rounded(.up)))
    }

    private var meta: some View { metaRow(onMedia: false) }

    private func metaRow(onMedia: Bool) -> some View {
        let color = onMedia ? Color.white : Theme.textSecondary
        return HStack(spacing: 3) {
            if item.isEdited { Text("Editada").font(Theme.font(11)).foregroundStyle(color) }
            Text(ConversationFormatting.time(message.created)).font(Theme.font(11)).foregroundStyle(color)
            if item.side == .outgoing {
                if message.delivery_status == "failed" {
                    Button(action: onFailedTap) { TickView(status: "failed") }.buttonStyle(.plain)
                } else {
                    TickView(status: message.delivery_status?.isEmpty == false ? message.delivery_status : "sent", color: color)
                }
            }
        }
        .fixedSize()
        .offset(y: onMedia ? 0 : 2)
    }

    private var reactionsPill: some View {
        HStack(spacing: 2) {
            Text(item.reactions.prefix(3).joined()).font(.system(size: 13))
            if item.reactions.count > 1 { Text("\(item.reactions.count)").font(Theme.font(11, .semibold)).foregroundStyle(Theme.textSecondary) }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(Theme.bubbleIn))
        .overlay(Capsule().stroke(Theme.chatWallpaper, lineWidth: 1.5))
    }
}

// MARK: - Localização e contato

/// Cartão de mapa: abre o endereço no app Mapas.
struct LocationCard: View {
    let latitude: Double
    let longitude: Double
    let name: String?
    let address: String?
    let width: CGFloat
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            var components = URLComponents(string: "https://maps.apple.com/")!
            var items = [URLQueryItem(name: "ll", value: "\(latitude),\(longitude)")]
            if let name, !name.isEmpty { items.append(URLQueryItem(name: "q", value: name)) }
            components.queryItems = items
            if let url = components.url { openURL(url) }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                ZStack {
                    MapPattern()
                    Image(systemName: "mappin.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(Color.white, Theme.danger)
                        .shadow(color: Color.black.opacity(0.25), radius: 2, y: 1)
                }
                .frame(height: 92)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name?.isEmpty == false ? name! : "Localização").font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Text(address?.isEmpty == false ? address! : String(format: "%.5f, %.5f", latitude, longitude))
                        .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(2).multilineTextAlignment(.leading)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.05))
            }
            .frame(width: width)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Localização: \(name ?? address ?? "ver no mapa")")
    }
}

/// Desenho simples de mapa (ruas claras sobre fundo suave), sem carregar mapas de verdade na lista.
private struct MapPattern: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                Color(light: 0xDDE8D5, dark: 0x24332E)
                Path { p in
                    p.addRect(CGRect(x: w * 0.62, y: 0, width: w * 0.38, height: h * 0.42))
                }.fill(Color(light: 0xC9DDF0, dark: 0x1D3140))
                Path { p in
                    p.move(to: CGPoint(x: 0, y: h * 0.62)); p.addLine(to: CGPoint(x: w, y: h * 0.38))
                    p.move(to: CGPoint(x: w * 0.3, y: 0)); p.addLine(to: CGPoint(x: w * 0.42, y: h))
                    p.move(to: CGPoint(x: 0, y: h * 0.2)); p.addLine(to: CGPoint(x: w * 0.62, y: h * 0.1))
                    p.move(to: CGPoint(x: w * 0.72, y: h * 0.42)); p.addLine(to: CGPoint(x: w * 0.8, y: h))
                }.stroke(Color(light: 0xFFFFFF, dark: 0x3A4A45), style: StrokeStyle(lineWidth: 5, lineCap: .round))
            }
        }
    }
}

/// Contato compartilhado: avatar, nome, telefone e "Salvar" (abre a ficha de novo contato do sistema).
struct ContactCard: View {
    let name: String
    let phone: String
    let width: CGFloat
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                AvatarView(name: name.isEmpty ? "?" : name, seed: phone, size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name.isEmpty ? "Contato" : name).font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if !phone.isEmpty { Text(ConversationFormatting.phone(phone)).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            Theme.divider.frame(height: 1)
            Button { saving = true } label: {
                Text("Salvar").font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand).frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.plain)
        }
        .frame(width: width)
        .background(Color.black.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .sheet(isPresented: $saving) { NewContactSheet(name: name, phone: phone).ignoresSafeArea() }
    }
}

// MARK: - Toque longo: reações e ações

/// Painel do toque longo: barra de reações em cima e menu com o que a linha permite.
struct MessageActionsPanel: View {
    let item: ChatMessage
    let vm: ConversationViewModel
    var onDelete: () -> Void
    var onClose: () -> Void

    private static let emojis = ["👍", "❤️", "😂", "😮", "😢", "🙏"]
    private var message: Message { item.message }
    private var actionable: Bool { vm.isActionable(item) }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.4).ignoresSafeArea().onTapGesture(perform: onClose)
            VStack(spacing: 10) {
                if actionable, vm.can("reaction") {
                    HStack(spacing: 4) {
                        ForEach(Self.emojis, id: \.self) { emoji in
                            Button { react(emoji) } label: { Text(emoji).font(.system(size: 28)).frame(width: 44, height: 44) }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Reagir com \(emoji)")
                        }
                        if !item.reactions.isEmpty {
                            Button { react("") } label: {
                                Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.textSecondary)
                                    .frame(width: 36, height: 36).background(Circle().fill(Theme.surface))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remover reação")
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Theme.surface))
                    .shadow(color: Color.black.opacity(0.2), radius: 8, y: 2)
                }
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Theme.brand.frame(width: 3, height: 30).clipShape(Capsule())
                        VStack(alignment: .leading, spacing: 1) {
                            Text(vm.authorLabel(message)).font(Theme.font(12, .semibold)).foregroundStyle(Theme.brand).lineLimit(1)
                            Text(message.text.isEmpty ? (item.media.isEmpty ? "Mensagem" : "Anexo") : message.text).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    ThinDivider(onCard: true)
                    if actionable, vm.can("reply") {
                        row("Responder", "arrowshape.turn.up.left") { vm.beginReply(message) }
                    }
                    if !message.text.isEmpty, !item.isDeleted {
                        row("Copiar", "doc.on.doc") {
                            UIPasteboard.general.string = message.text
                            Workspace.shared.show("Texto copiado")
                        }
                    }
                    if actionable, vm.canEdit(message) {
                        row("Editar", "pencil") { vm.beginEdit(message) }
                    }
                    if actionable, vm.can("read"), message.isIncoming {
                        row("Marcar como lida", "envelope.open") { Task { await vm.messageAction("read", message: message) } }
                    }
                    if actionable, vm.can("delete"), message.direction == "outbound" {
                        row("Apagar", "trash", color: Theme.danger, action: onDelete)
                    }
                    row("Cancelar", "xmark", color: Theme.textSecondary, divider: false) {}
                }
                .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
                .shadow(color: Color.black.opacity(0.2), radius: 10, y: 2)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
            .frame(maxWidth: 480)
        }
        .accessibilityAddTraits(.isModal)
    }

    private func react(_ emoji: String) {
        onClose()
        Task { await vm.messageAction("reaction", message: message, emoji: emoji) }
    }

    private func row(_ title: String, _ icon: String, color: Color = Theme.textPrimary, divider: Bool = true, action: @escaping () -> Void) -> some View {
        Button {
            onClose()
            action()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 17)).foregroundStyle(color == Theme.textPrimary ? Theme.brand : color).frame(width: 24)
                Text(title).font(Theme.font(16)).foregroundStyle(color)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { if divider { ThinDivider(leading: 54, onCard: true) } }
        }
        .buttonStyle(.plain)
    }
}
