import SwiftUI
import UIKit

/// Tokens visuais do Wabotia (mobile/DESIGN.md, seção 1). Nenhuma tela usa cor literal: tudo sai daqui.
/// Cada cor é dinâmica (claro/escuro) e acompanha a aparência escolhida em Ajustes.
enum Theme {
    static let brand = Color(light: 0x008069, dark: 0x00A884)
    static let brandStrong = Color(light: 0x075E54, dark: 0x005C4B)
    static let accent = Color(light: 0x25D366, dark: 0x25D366)
    static let background = Color(light: 0xFFFFFF, dark: 0x111B21)
    static let surface = Color(light: 0xF7F8FA, dark: 0x1F2C34)
    static let chatWallpaper = Color(light: 0xEFEAE2, dark: 0x0B141A)
    static let bubbleOut = Color(light: 0xD9FDD3, dark: 0x005C4B)
    static let bubbleIn = Color(light: 0xFFFFFF, dark: 0x202C33)
    static let bubbleNote = Color(light: 0xFFF3C4, dark: 0x3A3320)
    static let bubbleSystem = Color(light: 0xFFFFFF, dark: 0x182229, lightAlpha: 0.9)
    static let textPrimary = Color(light: 0x111B21, dark: 0xE9EDEF)
    static let textSecondary = Color(light: 0x667781, dark: 0x8696A0)
    static let divider = Color(light: 0xE9EDEF, dark: 0x222D34)
    /// Divisor entre linhas dentro de um cartão `surface` (no escuro, `divider` some sobre `surface`).
    static let cardDivider = Color(light: 0xE9EDEF, dark: 0x2E3B43)
    static let tickRead = Color(light: 0x53BDEB, dark: 0x53BDEB)
    static let ok = Color(light: 0x1FA855, dark: 0x25D366)
    static let warn = Color(light: 0xF59E0B, dark: 0xFFB02E)
    static let danger = Color(light: 0xE53935, dark: 0xF15C6D)
    static let muted = Color(light: 0x8696A0, dark: 0x8696A0)
    static let bot = Color(light: 0x7C4DFF, dark: 0xA78BFA)
    static let ticket = Color(light: 0x0277BD, dark: 0x4FC3F7)

    /// Texto e ícones sobre preenchimentos de marca e de estado (`brand`, `accent`, `ticket`, `bot`…):
    /// branco no claro; no escuro esses tons são claros e pedem texto escuro, como no WhatsApp.
    static let onBrand = Color(light: 0xFFFFFF, dark: 0x0B141A)
    /// Texto da nota interna (âmbar escuro no claro, âmbar claro no escuro).
    static let noteText = Color(light: 0x8A6100, dark: 0xF5D98B)
    /// Campo de texto dentro de barras `surface` (composer, busca).
    static let field = Color(light: 0xFFFFFF, dark: 0x2A3942)
    /// Barras fixas (topo da conversa, composer, abas).
    static let bar = Color(light: 0xF7F8FA, dark: 0x1F2C34)
    /// Sombra discreta das bolhas e cartões.
    static let shadow = Color(light: 0x0B141A, dark: 0x000000, lightAlpha: 0.13, darkAlpha: 0.3)

    /// Paleta fixa de 8 cores para avatares (derivada do id).
    static let avatarPalette: [Color] = [
        Color(light: 0x00A884, dark: 0x00A884), Color(light: 0x5B8DEF, dark: 0x5B8DEF),
        Color(light: 0xE5749E, dark: 0xE5749E), Color(light: 0xF2994A, dark: 0xF2994A),
        Color(light: 0x9B6DD6, dark: 0x9B6DD6), Color(light: 0x3FB6C6, dark: 0x3FB6C6),
        Color(light: 0xD9645A, dark: 0xD9645A), Color(light: 0x6FA35E, dark: 0x6FA35E),
    ]

    static func avatarColor(_ seed: String) -> Color {
        // Hash estável (o hashValue do Swift muda a cada execução).
        var hash: UInt32 = 2166136261
        for byte in seed.utf8 { hash = (hash ^ UInt32(byte)) &* 16777619 }
        return avatarPalette[Int(hash % UInt32(avatarPalette.count))]
    }

    // MARK: Medidas

    static let cardRadius: CGFloat = 16
    static let bubbleRadius: CGFloat = 12
    static let sheetRadius: CGFloat = 24
    static let touch: CGFloat = 44

    // MARK: Tipografia

    /// Fonte do sistema em tamanho fixo de desenho que acompanha a fonte grande do sistema (até 1,5x,
    /// para que as linhas de lista e as bolhas não quebrem o layout).
    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        let scaled = UIFontMetrics.default.scaledValue(for: size)
        return .system(size: min(scaled, size * 1.5), weight: weight, design: design)
    }

    /// Aplica a identidade aos controles do UIKit que o SwiftUI usa por baixo (barras, listas, campos).
    static func applyAppearance() {
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = UIColor(Theme.bar)
        nav.shadowColor = UIColor(Theme.divider)
        nav.titleTextAttributes = [.foregroundColor: UIColor(Theme.textPrimary)]
        nav.largeTitleTextAttributes = [.foregroundColor: UIColor(Theme.textPrimary)]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav
        UINavigationBar.appearance().tintColor = UIColor(Theme.brand)
        UITableView.appearance().backgroundColor = .clear
        UITextView.appearance().backgroundColor = .clear
        UISegmentedControl.appearance().selectedSegmentTintColor = UIColor(Theme.brand)
        UISegmentedControl.appearance().setTitleTextAttributes([.foregroundColor: UIColor.white], for: .selected)
        UISegmentedControl.appearance().setTitleTextAttributes([.foregroundColor: UIColor(Theme.textPrimary)], for: .normal)
        UISwitch.appearance().onTintColor = UIColor(Theme.accent)
    }
}

extension Color {
    /// Cor dinâmica a partir de dois hexadecimais RGB.
    init(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) {
        self.init(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkAlpha) : UIColor(hex: light, alpha: lightAlpha)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

/// Aparência escolhida em Ajustes (Sistema / Claro / Escuro), aplicada às janelas do app.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: return "Sistema"
        case .light: return "Claro"
        case .dark: return "Escuro"
        }
    }
    var style: UIUserInterfaceStyle {
        switch self {
        case .system: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }

    private static let key = "appearance"
    /// Aparência forçada só nesta execução (modo de demonstração); não é gravada.
    static var override: AppAppearance?

    static var current: AppAppearance {
        get { override ?? AppAppearance(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .system }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: key)
            apply()
        }
    }

    /// `overrideUserInterfaceStyle` nas janelas vale também para folhas e alertas (e volta a "Sistema"
    /// de forma confiável no iOS 15, ao contrário de `preferredColorScheme(nil)`).
    static func apply() {
        let style = current.style
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows { window.overrideUserInterfaceStyle = style }
        }
    }
}

/// Vibração leve nas ações principais (assumir, enviar, gravar, transferir).
enum Haptics {
    static func light() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func medium() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

/// Animação curta padrão (150–250 ms), desligada quando a pessoa pede "reduzir movimento".
extension Animation {
    static var quick: Animation? { UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.2) }
}
