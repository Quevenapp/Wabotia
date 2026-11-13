import SwiftUI
import UIKit

// MARK: - Marca

/// Símbolo do ícone do app: balão de conversa com um "W". Desenhado em um quadrado de 1024.
struct BrandBubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 1024
        let ox = rect.midX - 512 * s, oy = rect.midY - 512 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        path.addEllipse(in: CGRect(x: ox + 192 * s, y: oy + 192 * s, width: 640 * s, height: 560 * s))
        path.move(to: p(292, 664))
        path.addLine(to: p(250, 860))
        path.addLine(to: p(450, 738))
        path.closeSubpath()
        return path
    }
}

struct BrandWShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 1024
        let ox = rect.midX - 512 * s, oy = rect.midY - 512 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        path.move(to: p(340, 358))
        path.addLine(to: p(408, 602))
        path.addLine(to: p(512, 424))
        path.addLine(to: p(616, 602))
        path.addLine(to: p(684, 358))
        return path
    }
}

/// O símbolo do app em um quadrado arredondado `brand` (telas de servidor, login e perfil).
struct BrandTile: View {
    var size: CGFloat = 84

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.225, style: .continuous).fill(Theme.brand)
            BrandBubbleShape().fill(Color.white)
            BrandWShape().stroke(Theme.brand, style: StrokeStyle(lineWidth: size * 0.052, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .shadow(color: Theme.shadow, radius: 10, y: 4)
        .accessibilityHidden(true)
    }
}

/// Robozinho usado em tudo que é bot/IA (o SF Symbols não tem um).
struct RobotGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        func r(_ x: CGFloat, _ y: CGFloat, _ rw: CGFloat, _ rh: CGFloat) -> CGRect {
            CGRect(x: rect.minX + x * w, y: rect.minY + y * h, width: rw * w, height: rh * h)
        }
        // Cada retângulo arredondado é um subcaminho único, traçado à mão: com o preenchimento par-ímpar,
        // um contorno repetido se anularia.
        func round(_ path: inout Path, _ rect: CGRect, _ radius: CGFloat) {
            let c = min(radius, rect.width / 2, rect.height / 2)
            path.move(to: CGPoint(x: rect.minX + c, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX - c, y: rect.minY))
            path.addArc(center: CGPoint(x: rect.maxX - c, y: rect.minY + c), radius: c, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - c))
            path.addArc(center: CGPoint(x: rect.maxX - c, y: rect.maxY - c), radius: c, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
            path.addLine(to: CGPoint(x: rect.minX + c, y: rect.maxY))
            path.addArc(center: CGPoint(x: rect.minX + c, y: rect.maxY - c), radius: c, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
            path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + c))
            path.addArc(center: CGPoint(x: rect.minX + c, y: rect.minY + c), radius: c, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
            path.closeSubpath()
        }
        var path = Path()
        // Antena
        path.addEllipse(in: r(0.42, 0.0, 0.16, 0.16))
        path.addRect(r(0.465, 0.14, 0.07, 0.12))
        // Cabeça
        round(&path, r(0.13, 0.25, 0.74, 0.6), 0.18 * w)
        // Orelhas
        round(&path, r(0.0, 0.44, 0.09, 0.24), 0.04 * w)
        round(&path, r(0.91, 0.44, 0.09, 0.24), 0.04 * w)
        // Olhos e boca (vazados pelo preenchimento par-ímpar)
        path.addEllipse(in: r(0.27, 0.4, 0.16, 0.16))
        path.addEllipse(in: r(0.57, 0.4, 0.16, 0.16))
        round(&path, r(0.36, 0.67, 0.28, 0.07), 0.035 * w)
        return path
    }
}

struct RobotIcon: View {
    var size: CGFloat = 16
    var color: Color = Theme.bot
    var body: some View {
        RobotGlyph().fill(color, style: FillStyle(eoFill: true)).frame(width: size, height: size).accessibilityHidden(true)
    }
}

// MARK: - Avatar

/// Estado da conversa do ponto de vista de quem está usando o app.
enum ConversationRole: Equatable {
    case waiting, bot, mine, other, closed

    var color: Color {
        switch self {
        case .waiting: return Theme.warn
        case .bot: return Theme.bot
        case .mine: return Theme.brand
        case .other, .closed: return Theme.muted
        }
    }
    var icon: String {
        switch self {
        case .waiting: return "hourglass"
        case .bot: return ""
        case .mine, .other: return "person.fill"
        case .closed: return "checkmark"
        }
    }
}

extension Conversation {
    func role(me: String?) -> ConversationRole {
        switch state {
        case "waiting": return .waiting
        case "ai": return .bot
        case "closed": return .closed
        default: return owner != nil && owner == me ? .mine : .other
        }
    }
}

enum AvatarBadge: Equatable {
    case role(ConversationRole)
    case presence(Bool)
}

/// Círculo com iniciais (até 2 letras) e cor derivada do id. Grupo usa o ícone de pessoas; bot, o robô.
struct AvatarView: View {
    enum Kind { case person, group, bot }

    let name: String
    var seed: String = ""
    var kind: Kind = .person
    var size: CGFloat = 48
    var badge: AvatarBadge? = nil
    /// Cor atrás do avatar, usada no contorno do selo.
    var ring: Color = Theme.background

    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "." }).filter { $0.first?.isLetter == true }
        if words.isEmpty {
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            guard let first = trimmed.first else { return "?" }
            return first.isNumber || first == "+" ? "#" : String(first).uppercased()
        }
        if words.count == 1 { return String(words[0].prefix(1)).uppercased() }
        return (String(words[0].prefix(1)) + String(words[words.count - 1].prefix(1))).uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(kind == .bot ? Theme.bot : Theme.avatarColor(seed.isEmpty ? name : seed))
            switch kind {
            case .group:
                Image(systemName: "person.2.fill").font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(Color.white)
            case .bot:
                RobotGlyph().fill(Theme.onBrand, style: FillStyle(eoFill: true)).frame(width: size * 0.56, height: size * 0.56)
            case .person:
                Text(Self.initials(name)).font(.system(size: size * 0.38, weight: .semibold, design: .rounded)).foregroundStyle(Color.white)
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) { badgeView }
        .accessibilityHidden(true)
    }

    @ViewBuilder private var badgeView: some View {
        if let badge {
            let d = max(14, min(18, size * 0.36))
            switch badge {
            case .presence(let online):
                let dot = max(10, size * 0.27)
                Circle().fill(online ? Theme.ok : Theme.muted)
                    .frame(width: dot, height: dot)
                    .overlay(Circle().stroke(ring, lineWidth: 2))
                    .offset(x: 1, y: 1)
            case .role(let role):
                ZStack {
                    Circle().fill(role.color)
                    if role == .bot {
                        RobotGlyph().fill(Theme.onBrand, style: FillStyle(eoFill: true)).frame(width: d * 0.64, height: d * 0.64)
                    } else {
                        Image(systemName: role.icon).font(.system(size: d * 0.5, weight: .bold)).foregroundStyle(Theme.onBrand)
                    }
                }
                .frame(width: d, height: d)
                .overlay(Circle().stroke(ring, lineWidth: 2))
                .offset(x: 2, y: 2)
            }
        }
    }
}

// MARK: - Relógio da janela

extension WindowClock.Level {
    var color: Color {
        switch self {
        case .ok: return Theme.ok
        case .warn: return Theme.warn
        case .danger: return Theme.danger
        case .closed: return Theme.muted
        }
    }
}

/// Anel de progresso genérico: esvazia no sentido horário conforme `fraction` cai de 1 a 0.
struct ProgressRing<Center: View>: View {
    let fraction: Double
    let color: Color
    var size: CGFloat = 22
    var lineWidth: CGFloat? = nil
    @ViewBuilder var center: () -> Center

    var body: some View {
        let width = lineWidth ?? max(2.5, size * 0.11)
        ZStack {
            Circle().stroke(color.opacity(0.22), lineWidth: width)
            Circle()
                .trim(from: CGFloat(1 - min(1, max(0, fraction))), to: 1)
                .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.quick, value: fraction)
            center()
        }
        .padding(width / 2)
        .frame(width: size, height: size)
    }
}

/// Anel da janela de 24 h: relógio no centro; fechada vira cadeado.
struct WindowRing: View {
    let clock: WindowClock
    var size: CGFloat = 22

    var body: some View {
        ProgressRing(fraction: clock.fraction, color: clock.level.color, size: size) {
            Image(systemName: clock.isClosed ? "lock.fill" : "clock.fill")
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(clock.level.color)
        }
        .accessibilityElement()
        .accessibilityLabel(clock.isClosed ? "Janela de 24 horas fechada" : "Janela de 24 horas: \(clock.label) restantes")
    }
}

// MARK: - Ticks de entrega

/// ✓ e ✓✓ desenhados (o SF Symbols não tem o duplo).
struct CheckShape: Shape {
    var double = false
    func path(in rect: CGRect) -> Path {
        let w = rect.width / (double ? 16 : 11), h = rect.height / 10
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * w, y: rect.minY + y * h) }
        var path = Path()
        path.move(to: p(0.8, 5.6)); path.addLine(to: p(3.9, 8.8)); path.addLine(to: p(10.2, 1.2))
        if double {
            path.move(to: p(7.4, 7.6)); path.addLine(to: p(8.7, 8.8)); path.addLine(to: p(15.2, 1.2))
        }
        return path
    }
}

/// Recibo de uma mensagem enviada: relógio (na fila), ✓, ✓✓, ✓✓ azul, ! vermelho.
struct TickView: View {
    let status: String?
    var color: Color = Theme.textSecondary
    var size: CGFloat = 11

    var body: some View {
        switch status ?? "" {
        case "pending", "sending", "queued":
            Image(systemName: "clock").font(.system(size: size, weight: .semibold)).foregroundStyle(color).accessibilityLabel("Na fila de envio")
        case "sent":
            check(double: false, color).accessibilityLabel("Enviada")
        case "delivered":
            check(double: true, color).accessibilityLabel("Entregue")
        case "read", "played":
            check(double: true, Theme.tickRead).accessibilityLabel(status == "played" ? "Ouvida" : "Lida")
        case "failed":
            Image(systemName: "exclamationmark.circle.fill").font(.system(size: size + 2)).foregroundStyle(Theme.danger).accessibilityLabel("Falhou")
        case "unknown":
            Image(systemName: "questionmark.circle").font(.system(size: size + 1)).foregroundStyle(Theme.warn).accessibilityLabel("Sem confirmação")
        default:
            EmptyView()
        }
    }

    private func check(double: Bool, _ c: Color) -> some View {
        CheckShape(double: double)
            .stroke(c, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            .frame(width: double ? size * 1.5 : size, height: size * 0.82)
            .accessibilityElement()
    }
}

// MARK: - Pílulas e chips

/// Pílula pequena (etiquetas, estados).
struct Pill: View {
    let text: String
    var color: Color = Theme.textSecondary
    var icon: String? = nil
    var filled = false

    var body: some View {
        HStack(spacing: 3) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .bold)) }
            Text(text).font(Theme.font(11, .semibold)).lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .foregroundStyle(filled ? Theme.onBrand : color)
        .background(Capsule().fill(filled ? color : color.opacity(0.14)))
    }
}

/// Chip de filtro com contador.
struct FilterChip: View {
    let title: String
    var count: Int? = nil
    let selected: Bool
    /// Cor de destaque quando há algo pedindo atenção (fila, atrasados).
    var attention: Color? = nil
    let action: () -> Void

    var body: some View {
        let tint = attention ?? Theme.brand
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title).font(Theme.font(14, selected ? .semibold : .medium))
                if let count, count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(Theme.font(12, .bold))
                        .foregroundStyle(selected ? tint : (attention != nil ? Theme.onBrand : Theme.textSecondary))
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Capsule().fill(selected ? Theme.onBrand : (attention ?? Theme.textSecondary.opacity(0.16))))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .foregroundStyle(selected ? Theme.onBrand : (attention ?? Theme.textPrimary))
            .background(Capsule().fill(selected ? tint : (attention?.opacity(0.14) ?? Theme.surface)))
            .overlay(Capsule().stroke(selected || attention != nil ? Color.clear : Theme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count.map { $0 > 0 ? "\(title), \($0)" : title } ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Contador em bolinha (não lidas).
struct CountBadge: View {
    let count: Int
    var color: Color = Theme.accent

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(Theme.font(12, .bold))
            .foregroundStyle(Theme.onBrand)
            .padding(.horizontal, 5)
            .frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(color))
    }
}

/// Pílula de presença: "● Online" / "○ Offline".
struct PresencePill: View {
    let online: Bool
    var busy = false

    var body: some View {
        HStack(spacing: 5) {
            if busy {
                ProgressView().scaleEffect(0.6).frame(width: 9, height: 9)
            } else if online {
                Circle().fill(Theme.ok).frame(width: 8, height: 8)
            } else {
                Circle().stroke(Theme.muted, lineWidth: 1.5).frame(width: 8, height: 8)
            }
            Text(online ? "Online" : "Offline").font(Theme.font(13, .semibold))
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .foregroundStyle(online ? Theme.ok : Theme.textSecondary)
        .background(Capsule().fill(online ? Theme.ok.opacity(0.15) : Theme.muted.opacity(0.16)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(online ? "Você está online. Alterar presença" : "Você está offline. Alterar presença")
    }
}

// MARK: - Botões

/// Botão principal `brand` em largura total, com estado de carregando no próprio botão.
struct PrimaryButton: View {
    let title: String
    var icon: String? = nil
    var busy = false
    var color: Color = Theme.brand
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    ProgressView().progressViewStyle(CircularProgressViewStyle(tint: Theme.onBrand))
                } else {
                    if let icon { Image(systemName: icon).font(.system(size: 16, weight: .semibold)) }
                    Text(title).font(Theme.font(16, .semibold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(Theme.onBrand)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(color))
            .opacity(disabled && !busy ? 0.45 : 1)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(disabled || busy)
    }
}

/// Botão secundário (contorno) em largura total.
struct SecondaryButton: View {
    let title: String
    var icon: String? = nil
    var color: Color = Theme.brand
    var busy = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView() } else {
                    if let icon { Image(systemName: icon).font(.system(size: 15, weight: .semibold)) }
                    Text(title).font(Theme.font(16, .semibold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(color)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(color.opacity(0.12)))
            .opacity(disabled ? 0.45 : 1)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(disabled || busy)
    }
}

struct PressScaleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.quick, value: configuration.isPressed)
    }
}

/// Botão de ícone com alvo de toque de 44 pt e rótulo de acessibilidade obrigatório.
struct IconButton: View {
    let systemName: String
    let label: String
    var color: Color = Theme.brand
    var size: CGFloat = 20
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: .medium))
                .foregroundStyle(color)
                .frame(width: Theme.touch, height: Theme.touch)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - Cartões e seções

extension View {
    /// Cartão `surface` com cantos de 16.
    func card(padding: CGFloat = 14) -> some View {
        self.padding(padding)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
    }
}

/// Grupo de linhas em um cartão, com título pequeno acima (Ajustes, Dados da conversa).
struct SectionCard<Content: View>: View {
    var title: String? = nil
    var footer: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title.uppercased())
                    .font(Theme.font(12, .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 14)
            }
            VStack(spacing: 0) { content() }
                .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
                .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            if let footer {
                Text(footer).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 14)
            }
        }
    }
}

/// Linha de um `SectionCard`: ícone colorido, título, valor e seta.
struct CardRow<Trailing: View>: View {
    var icon: String? = nil
    var iconColor: Color = Theme.brand
    let title: String
    var subtitle: String? = nil
    var value: String? = nil
    var titleColor: Color = Theme.textPrimary
    var chevron = false
    var divider = true
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.onBrand)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(iconColor))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Theme.font(16)).foregroundStyle(titleColor).lineLimit(1).minimumScaleFactor(0.85)
                if let subtitle { Text(subtitle).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(2) }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            if let value { Text(value).font(Theme.font(15)).foregroundStyle(Theme.textSecondary).lineLimit(1).truncationMode(.middle) }
            trailing()
            if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted.opacity(0.7)) }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            if divider { Theme.cardDivider.frame(height: 1).padding(.leading, icon == nil ? 14 : 56) }
        }
    }
}

extension CardRow where Trailing == EmptyView {
    init(icon: String? = nil, iconColor: Color = Theme.brand, title: String, subtitle: String? = nil, value: String? = nil, titleColor: Color = Theme.textPrimary, chevron: Bool = false, divider: Bool = true) {
        self.init(icon: icon, iconColor: iconColor, title: title, subtitle: subtitle, value: value, titleColor: titleColor, chevron: chevron, divider: divider) { EmptyView() }
    }
}

// MARK: - Estados (vazio, carregando, erro, aviso)

/// Vazio: ícone grande em círculo `surface`, título e uma linha.
struct EmptyStateView: View {
    let title: String
    let systemImage: String
    var message: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Theme.brand)
                .frame(width: 88, height: 88)
                .background(Circle().fill(Theme.surface))
            Text(title).font(Theme.font(18, .semibold)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.center)
            if let message {
                Text(message).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(Theme.font(15, .semibold))
                    .foregroundStyle(Theme.brand)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Esqueleto do primeiro carregamento das listas: linhas cinza pulsando.
struct SkeletonList: View {
    var rows = 7
    var avatar = true
    @State private var dim = false

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    if avatar { Circle().fill(Theme.divider).frame(width: 48, height: 48) }
                    VStack(alignment: .leading, spacing: 9) {
                        RoundedRectangle(cornerRadius: 5).fill(Theme.divider).frame(width: index % 2 == 0 ? 150 : 110, height: 13)
                        RoundedRectangle(cornerRadius: 5).fill(Theme.divider).frame(height: 11).padding(.trailing, index % 3 == 0 ? 40 : 90)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .frame(height: 74)
            }
            Spacer(minLength: 0)
        }
        .opacity(dim ? 0.45 : 1)
        .onAppear {
            guard !UIAccessibility.isReduceMotionEnabled else { return }
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityLabel("Carregando")
    }
}

/// Erro legível com "Tentar de novo".
struct InlineError: View {
    let text: String
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger).font(.system(size: 15))
            VStack(alignment: .leading, spacing: 6) {
                Text(text).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                if let retry {
                    Button("Tentar de novo", action: retry).font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.danger.opacity(0.1)))
    }
}

/// Aviso curto no rodapé (snackbar).
struct ToastOverlay: View {
    @ObservedObject var workspace: Workspace
    var bottomPadding: CGFloat = 12

    var body: some View {
        VStack {
            Spacer()
            if let toast = workspace.toast {
                HStack(spacing: 8) {
                    Image(systemName: toast.style == .error ? "exclamationmark.circle.fill" : (toast.style == .success ? "checkmark.circle.fill" : "info.circle.fill"))
                        .foregroundStyle(toast.style == .error ? Theme.danger : Theme.accent)
                    Text(toast.text).font(Theme.font(14, .medium)).foregroundStyle(Color.white).lineLimit(3)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Capsule().fill(Color(light: 0x111B21, dark: 0x2A3942)))
                .shadow(color: Color.black.opacity(0.25), radius: 10, y: 4)
                .padding(.horizontal, 24)
                .padding(.bottom, bottomPadding)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onTapGesture { workspace.toast = nil }
                .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.quick, value: workspace.toast)
        .allowsHitTesting(workspace.toast != nil)
    }
}

// MARK: - Barras e folhas

/// Cabeçalho das abas: título grande com subtítulo e ações à direita.
struct ScreenHeader<Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    var brandTitle = false
    var onSubtitleTap: (() -> Void)? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(Theme.font(26, .bold))
                    .foregroundStyle(brandTitle ? Theme.brand : Theme.textPrimary)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle, !subtitle.isEmpty {
                    if let onSubtitleTap {
                        Button(action: onSubtitleTap) {
                            HStack(spacing: 3) {
                                Text(subtitle).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Troca de perfil")
                    } else {
                        Text(subtitle).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(minHeight: 56)
    }
}

/// Campo de busca arredondado.
struct SearchField: View {
    let placeholder: String
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var onCancel: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                TextField(placeholder, text: $text)
                    .font(Theme.font(16))
                    .focused(focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !text.isEmpty {
                    Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Limpar busca")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 38)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
            if let onCancel {
                Button("Cancelar", action: onCancel).font(Theme.font(16)).foregroundStyle(Theme.brand)
            }
        }
    }
}

/// Topo das folhas: título centralizado e fechar.
struct SheetHeader: View {
    let title: String
    var subtitle: String? = nil
    var onClose: (() -> Void)? = nil

    var body: some View {
        ZStack {
            VStack(spacing: 1) {
                Text(title).font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                if let subtitle { Text(subtitle).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
            }
            .padding(.horizontal, 56)
            if let onClose {
                HStack {
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Theme.textSecondary)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Theme.surface))
                            .frame(width: Theme.touch, height: Theme.touch)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Fechar")
                }
                .padding(.trailing, 8)
            }
        }
        .frame(minHeight: 48)
        .padding(.top, 14)
    }
}

/// Faixa fina "Sem conexão · tentando reconectar".
struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.slash").font(.system(size: 11, weight: .semibold))
            Text("Sem conexão · tentando reconectar").font(Theme.font(12, .medium))
        }
        .foregroundStyle(Color.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .background(Theme.muted.ignoresSafeArea(edges: .top))
    }
}

/// Divisor fino na cor do tema.
struct ThinDivider: View {
    var leading: CGFloat = 0
    /// Dentro de um cartão `surface`.
    var onCard = false
    var body: some View { (onCard ? Theme.cardDivider : Theme.divider).frame(height: 1).padding(.leading, leading) }
}
