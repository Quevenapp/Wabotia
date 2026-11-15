import CoreImage
import SwiftUI
import UIKit

/// O estilo e a medida-base do painel, para os quadros não receberem os dois em todo construtor.
private struct PanelStyleKey: EnvironmentKey { static let defaultValue = PanelTemplate.default.style }
private struct PanelBaseKey: EnvironmentKey { static let defaultValue: CGFloat = 16 }

extension EnvironmentValues {
    var panelStyle: PanelStyle {
        get { self[PanelStyleKey.self] }
        set { self[PanelStyleKey.self] = newValue }
    }

    /// A unidade de medida do painel: 2,3% do menor lado da tela, entre 11 e 30 pontos.
    var panelBase: CGFloat {
        get { self[PanelBaseKey.self] }
        set { self[PanelBaseKey.self] = newValue }
    }
}

/// Cabeçalho do painel: nome do aparelho, título e, à direita, estado da conexão e engrenagem.
struct PanelHeaderBar<Trailing: View>: View {
    let name: String
    let role: String
    let title: String
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        HStack(spacing: base * 0.8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(s.label(role)).font(s.text(base * 0.7, .semibold)).foregroundStyle(s.headerFg.opacity(0.7)).lineLimit(1)
                Text(name).font(s.text(base * 1.05, .bold)).foregroundStyle(s.headerFg).lineLimit(1)
            }
            Spacer(minLength: base)
            Text(title).font(s.display(base * 1.4)).foregroundStyle(s.headerFg).lineLimit(1).minimumScaleFactor(0.6)
            Spacer(minLength: base)
            trailing()
        }
        .padding(.horizontal, base)
        .padding(.vertical, base * 0.6)
        .background(s.headerBg)
        .overlay(alignment: .bottom) { s.headerLine.frame(height: s.headerLineWidth) }
    }
}

// MARK: - Totem

/// As filas do totem em botões grandes: nome, quantos aguardam e a espera. Tocar abre Normal ou Preferencial.
struct TotemBoard: View {
    let queues: [QueueInfo]
    let blocked: Bool
    let onChoose: (String) -> Void
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        GeometryReader { geo in
            let columns = queues.count <= 1 ? 1 : (geo.size.width > geo.size.height * 1.2 ? min(queues.count, 3) : (queues.count > 3 ? 2 : 1))
            let rows = max(1, Int((Double(queues.count) / Double(columns)).rounded(.up)))
            // Os botões crescem para ocupar a tela (alvo grande, de longe), entre 6,5 e 14 unidades de altura.
            let fill = (geo.size.height - base * 2.5 - CGFloat(rows) * base * 0.7) / CGFloat(rows)
            let height = min(max(fill, base * 6.5), base * 14)
            ScrollView {
                VStack(alignment: .leading, spacing: base * 0.7) {
                    Text(s.label("Toque na fila para retirar sua senha")).font(s.text(base * 0.95, .semibold)).foregroundStyle(s.muted)
                    if queues.isEmpty {
                        Text("Nenhuma fila recebe senhas pelo totem agora. Dirija-se ao balcão.")
                            .font(s.text(base * 1.1)).foregroundStyle(s.fg)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(base)
                            .background(RoundedRectangle(cornerRadius: s.radius).fill(s.surface))
                    }
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: base * 0.7), count: columns), spacing: base * 0.7) {
                        ForEach(queues) { queue in
                            Button { onChoose(queue.id) } label: { QueueButtonLabel(queue: queue, height: height) }
                                .buttonStyle(PressScaleStyle())
                                .disabled(blocked)
                                .opacity(blocked ? 0.5 : 1)
                                .accessibilityIdentifier("totem.queue.\(queue.id)")
                        }
                    }
                }
                .padding(.bottom, base)
            }
        }
    }
}

private struct QueueButtonLabel: View {
    let queue: QueueInfo
    let height: CGFloat
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        let color = s.queueColor(PanelQueueLetter.colorIndex(queue.prefixNormal?.first))
        let waiting = queue.waiting?.total ?? 0
        // O texto acompanha a altura do botão: no iPad em pé, com poucas filas, a letra cresce.
        let scale = min(max(height / (base * 6.5), 1), 1.8)
        VStack(alignment: .leading, spacing: base * 0.35 * scale) {
            HStack(spacing: base * 0.5 * scale) {
                Text(queue.prefixNormal ?? "•")
                    .font(s.display(base * 1.3 * scale)).foregroundStyle(Color.white)
                    .frame(minWidth: base * 2.4 * scale, minHeight: base * 2.4 * scale)
                    .background(RoundedRectangle(cornerRadius: s.radius * 0.7).fill(color))
                Text(queue.displayName).font(s.text(base * 1.5 * scale, .bold)).foregroundStyle(s.fg).lineLimit(2).minimumScaleFactor(0.7)
                Spacer(minLength: 0)
            }
            HStack(spacing: base * 0.8) {
                Label("\(waiting) aguardando", systemImage: "person.2.fill").font(s.text(base * 0.95 * scale)).foregroundStyle(s.muted)
                if let minutes = queue.waitMinutes?.normal {
                    Label("cerca de \(minutes) min", systemImage: "clock").font(s.text(base * 0.95 * scale)).foregroundStyle(s.muted)
                }
            }
            .lineLimit(1).minimumScaleFactor(0.7)
        }
        .padding(base)
        .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: s.radius).fill(s.surface))
        .overlay(RoundedRectangle(cornerRadius: s.radius).stroke(color, lineWidth: max(s.border, 2)))
        .contentShape(Rectangle())
    }
}

/// Normal ou Preferencial, com o aviso legal; some sozinho em 30 s.
struct TypeChoiceOverlay: View {
    let queue: QueueInfo
    let onChoose: (Bool) -> Void
    let onCancel: () -> Void
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea().onTapGesture(perform: onCancel)
            VStack(spacing: base) {
                Text("\(queue.displayName) · qual senha?").font(s.text(base * 1.5, .bold)).foregroundStyle(s.fg).multilineTextAlignment(.center)
                choice("Normal", minutes: queue.waitMinutes?.normal, filled: true) { onChoose(false) }
                    .accessibilityIdentifier("choice.normal")
                choice("Preferencial", minutes: queue.waitMinutes?.preferential, filled: false) { onChoose(true) }
                    .accessibilityIdentifier("choice.preferential")
                if let notice = queue.preferentialNotice, !notice.isEmpty {
                    Text(notice).font(s.text(base * 0.9)).foregroundStyle(s.muted).multilineTextAlignment(.center)
                }
                Button("Voltar", action: onCancel).font(s.text(base * 1.05, .semibold)).foregroundStyle(s.accent == s.surface ? s.fg : s.accent)
                    .frame(minHeight: Theme.touch)
            }
            .padding(base * 1.4)
            .frame(maxWidth: 560)
            .background(RoundedRectangle(cornerRadius: max(s.radius, 12)).fill(s.surface))
            .padding(base)
        }
        .task(id: queue.id) {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            if !Task.isCancelled { onCancel() }
        }
    }

    private func choice(_ title: String, minutes: Int?, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(title).font(s.text(base * 1.7, .bold))
                if let minutes { Text("cerca de \(minutes) min").font(s.text(base * 0.9)) }
            }
            .frame(maxWidth: .infinity, minHeight: base * 5.5)
            .foregroundStyle(filled ? s.accentFg : s.accent)
            .background(RoundedRectangle(cornerRadius: s.radius).fill(filled ? s.accent : s.accent.opacity(0.12)))
            .overlay(RoundedRectangle(cornerRadius: s.radius).stroke(s.accent, lineWidth: filled ? 0 : 2))
        }
        .buttonStyle(PressScaleStyle())
    }
}

/// A senha recém-emitida: número grande, posição, situação do cupom e o QR do WhatsApp.
struct IssuedTicketCard: View {
    let ticket: QueueTicket
    let print: TicketPrint?
    let header: String
    let onReprint: (Bool) -> Void
    let onDone: () -> Void
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base
    @State private var confirmReprint = false

    var body: some View {
        let data = CouponData.of(ticket, header: header)
        VStack(spacing: base * 0.5) {
            Text("Sua senha · \(CouponText.type(data))").font(s.text(base * 1.1)).foregroundStyle(s.muted)
            Text(ticket.displayCode).font(s.display(base * 5)).foregroundStyle(s.fg).lineLimit(1).minimumScaleFactor(0.5)
                .accessibilityIdentifier("device.issued.code")
            Text(ticket.queueName ?? "").font(s.text(base * 1.1)).foregroundStyle(s.fg)
            Text(CouponText.position(data)).font(s.text(base * 1.05)).foregroundStyle(s.fg)
            Text(printText).font(s.text(base * 0.95)).foregroundStyle(print?.isFailure == true ? Color.red : s.muted)
                .multilineTextAlignment(.center)
            if let link = data.whatsappLink, let image = QRCode.image(link) {
                Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                    .frame(width: base * 9, height: base * 9)
                    .padding(base * 0.4).background(Color.white)
                    .accessibilityLabel("QR para acompanhar a senha no WhatsApp")
                Text(CouponText.whatsapp).font(s.text(base * 0.85)).foregroundStyle(s.muted).multilineTextAlignment(.center)
            }
            HStack(spacing: base * 0.6) {
                if case let .failed(_, needsConfirmation)? = print {
                    Button("Imprimir de novo") { if needsConfirmation { confirmReprint = true } else { onReprint(false) } }
                        .font(s.text(base * 1, .semibold)).foregroundStyle(s.accent)
                        .padding(.horizontal, base).frame(minHeight: base * 2.6)
                        .background(Capsule().stroke(s.accent, lineWidth: 2))
                }
                Button(action: onDone) {
                    Text("Pronto").font(s.text(base * 1.1, .bold)).foregroundStyle(s.accentFg)
                        .padding(.horizontal, base * 1.6).frame(minHeight: base * 2.6)
                        .background(Capsule().fill(s.accent))
                }
                .accessibilityIdentifier("device.issued.done")
            }
            .padding(.top, base * 0.3)
        }
        .padding(base)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: s.radius).fill(s.surface))
        .confirmationDialog("O cupom saiu?", isPresented: $confirmReprint, titleVisibility: .visible) {
            Button("Nada saiu, imprimir") { onReprint(true) }
            Button("Saiu, cancelar", role: .cancel) {}
        } message: {
            Text("A impressora pode ter impresso sem confirmar. Imprima de novo só se nada saiu, para não haver dois papéis com a mesma senha.")
        }
    }

    private var printText: String {
        switch print {
        case .printing?: return "Imprimindo o cupom…"
        case .printed?: return "Retire o cupom na impressora."
        case .noPrinter?: return "Sem impressora: anote ou fotografe a senha."
        case let .failed(message, _)?: return "O cupom não saiu: \(message)"
        case nil: return ""
        }
    }
}

// MARK: - Painel de chamadas

/// A chamada atual em destaque e as anteriores ao lado (ou embaixo, em pé).
struct CallBoard: View {
    let calls: [StationCall]
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        let ordered = PanelCalls.onScreen(calls)
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            if let current = ordered.first {
                let others = Array(ordered.dropFirst().prefix(PanelCalls.othersOnScreen))
                if landscape {
                    HStack(spacing: base * 0.8) {
                        CallHero(call: current).frame(width: geo.size.width * (others.isEmpty ? 1 : 0.62))
                        if !others.isEmpty { PreviousCalls(calls: others) }
                    }
                } else {
                    VStack(spacing: base * 0.8) {
                        CallHero(call: current).frame(height: geo.size.height * (others.isEmpty ? 1 : 0.55))
                        if !others.isEmpty { PreviousCalls(calls: others) }
                    }
                }
            } else {
                VStack(spacing: base * 0.6) {
                    Image(systemName: "tv").font(.system(size: base * 3)).foregroundStyle(s.muted)
                    Text("Nenhuma senha chamada ainda hoje.").font(s.text(base * 1.3)).foregroundStyle(s.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

private struct CallHero: View {
    let call: StationCall
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        let dest = PanelDestination.split(call.stationLabel)
        GeometryReader { geo in
            VStack(spacing: 0) {
                VStack(spacing: base * 0.2) {
                    Text(s.label("Senha")).font(s.text(base * 1.1, .semibold)).foregroundStyle(s.heroFg.opacity(0.75))
                    Text(call.publicNumber).font(s.display(min(geo.size.width / 2.9, geo.size.height * 0.38)))
                        .foregroundStyle(s.heroFg).lineLimit(1).minimumScaleFactor(0.4)
                    if let queue = call.queueName, !queue.isEmpty {
                        Text(queue).font(s.text(base * 1.1)).foregroundStyle(s.heroFg.opacity(0.8)).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(s.heroBg)
                HStack(alignment: .firstTextBaseline, spacing: base * 0.6) {
                    Text(s.label(dest.label)).font(s.text(base * 1.3, .semibold)).foregroundStyle(s.destFg.opacity(0.85))
                    Text(dest.value).font(s.display(dest.long ? base * 2.4 : base * 3.6)).foregroundStyle(s.destFg).lineLimit(1).minimumScaleFactor(0.5)
                }
                .padding(base * 0.6)
                .frame(maxWidth: .infinity)
                .background(s.destBg)
            }
            .clipShape(RoundedRectangle(cornerRadius: s.radius))
            .overlay(RoundedRectangle(cornerRadius: s.radius).stroke(s.line, lineWidth: s.border))
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("panel.current")
    }
}

private struct PreviousCalls: View {
    let calls: [StationCall]
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        VStack(alignment: .leading, spacing: base * 0.4) {
            Text(s.label("Chamadas anteriores")).font(s.text(base * 0.9, .semibold)).foregroundStyle(s.muted)
            ForEach(calls) { call in
                let color = s.queueColor(PanelQueueLetter.colorIndex(PanelQueueLetter.of(call.publicNumber)))
                HStack(spacing: base * 0.6) {
                    color.frame(width: base * 0.35)
                    Text(call.publicNumber).font(s.display(base * 1.7)).foregroundStyle(s.fg).lineLimit(1).minimumScaleFactor(0.6)
                    Spacer(minLength: base * 0.4)
                    Text(call.stationLabel ?? "Balcão").font(s.text(base * 1.15, .semibold)).foregroundStyle(s.fg.opacity(0.85)).lineLimit(1).minimumScaleFactor(0.6)
                }
                .padding(.trailing, base * 0.6)
                .frame(height: base * 3)
                .background(RoundedRectangle(cornerRadius: s.radius * 0.6).fill(s.surface))
                .clipShape(RoundedRectangle(cornerRadius: s.radius * 0.6))
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// O destaque que cobre a tela por alguns segundos quando chega uma chamada.
struct CallSpotlight: View {
    let call: StationCall
    @Environment(\.panelStyle) private var s
    @Environment(\.panelBase) private var base

    var body: some View {
        let dest = PanelDestination.split(call.stationLabel)
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(spacing: base * 0.6) {
                Text(s.label(call.recalls > 0 ? "Chamando de novo" : "Chamando")).font(s.text(base * 1.4, .bold)).foregroundStyle(s.heroFg.opacity(0.8))
                Text(call.publicNumber).font(s.display(base * 9)).foregroundStyle(s.heroFg).lineLimit(1).minimumScaleFactor(0.4)
                Text("\(dest.label) \(dest.value)").font(s.display(base * 3)).foregroundStyle(s.heroFg).lineLimit(1).minimumScaleFactor(0.5)
            }
            .padding(base * 2)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: s.radius).fill(s.heroBg))
            .padding(base * 2)
        }
        .transition(.opacity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("panel.spotlight")
    }
}

// MARK: - QR

/// O QR do WhatsApp na tela (o cupom tem o dele, rasterizado pelo kit).
enum QRCode {
    private static let context = CIContext()

    static func image(_ text: String) -> UIImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
