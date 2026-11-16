import SwiftUI

/// Os cinco visuais dos painéis (porta do Android, que veio do protótipo do Vinki). Cada um tem paleta e grade
/// próprias, desenhadas para leitura a distância. A escolha é deste aparelho: fica nele, como o som, e não passa pelo
/// servidor. No iOS as fontes são as do sistema (o Android empacota Overpass, Atkinson, B612, Anton e Lexend); o
/// desenho da letra muda pelo `Font.Design` e pelo peso.
enum PanelTemplate: String, CaseIterable, Identifiable {
    case sinal, clinica, terminal, vitrine, sol

    static let `default` = PanelTemplate.sinal

    var id: String { rawValue }

    /// Identificador desconhecido volta ao padrão.
    static func from(_ id: String?) -> PanelTemplate { PanelTemplate(rawValue: id ?? "") ?? .default }

    var label: String {
        switch self {
        case .sinal: return "Sinal"
        case .clinica: return "Clínica"
        case .terminal: return "Terminal"
        case .vitrine: return "Vitrine"
        case .sol: return "Sol"
        }
    }

    var fit: String {
        switch self {
        case .sinal: return "Salão grande, gente andando"
        case .clinica: return "Saúde, idosos, baixa visão"
        case .terminal: return "TV na parede, pouca luz"
        case .vitrine: return "Lanchonete, pedidos"
        case .sol: return "Ambiente muito claro"
        }
    }

    var style: PanelStyle { PanelStyle.of(self) }
}

struct PanelStyle {
    var dark: Bool
    var design: Font.Design
    var displayWeight: Font.Weight
    var bg: Color
    var fg: Color
    var muted: Color
    var surface: Color
    var line: Color
    var headerBg: Color
    var headerFg: Color
    var headerLine: Color
    var headerLineWidth: CGFloat
    var heroBg: Color
    var heroFg: Color
    var destBg: Color
    var destFg: Color
    var accent: Color
    var accentFg: Color
    var ok: Color
    var wait: Color
    var queues: [Color]
    var radius: CGFloat
    var border: CGFloat
    var upperLabels: Bool

    func queueColor(_ index: Int) -> Color { queues[((index % queues.count) + queues.count) % queues.count] }

    func display(_ size: CGFloat) -> Font { .system(size: size, weight: displayWeight, design: design) }
    func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: design) }
    func label(_ text: String) -> String { upperLabels ? text.uppercased() : text }

    private static func c(_ hex: UInt32) -> Color { Color(UIColor(hex: hex)) }

    static func of(_ template: PanelTemplate) -> PanelStyle {
        switch template {
        // Placa de estrada: azul-noite e amarelo de sinalização.
        case .sinal:
            return PanelStyle(dark: true, design: .rounded, displayWeight: .black,
                              bg: c(0x0C1A2E), fg: .white, muted: c(0xA9B8CC), surface: c(0x15263F), line: c(0x29405F),
                              headerBg: c(0x081322), headerFg: .white, headerLine: c(0xFFC72C), headerLineWidth: 4,
                              heroBg: c(0xFFC72C), heroFg: c(0x0C1A2E), destBg: c(0x0C1A2E), destFg: c(0xFFC72C),
                              accent: c(0xFFC72C), accentFg: c(0x0C1A2E), ok: c(0x3DDC97), wait: c(0xFF9F43),
                              queues: [c(0x4DA3FF), c(0x3DDC97), c(0xFF9F43), c(0xD7A6FF)], radius: 10, border: 0, upperLabels: true)
        // Calma e clara: branco e petróleo.
        case .clinica:
            return PanelStyle(dark: false, design: .default, displayWeight: .bold,
                              bg: c(0xEDF2F4), fg: c(0x0B2530), muted: c(0x4A6470), surface: .white, line: c(0xD3DEE3),
                              headerBg: .white, headerFg: c(0x0B2530), headerLine: c(0xD3DEE3), headerLineWidth: 1,
                              heroBg: .white, heroFg: c(0x0A5A69), destBg: c(0x0A5A69), destFg: .white,
                              accent: c(0x0A6E7E), accentFg: .white, ok: c(0x1E7F4F), wait: c(0xA8510B),
                              queues: [c(0x0A6E7E), c(0x5847C2), c(0xA8510B), c(0xB3245E)], radius: 22, border: 1, upperLabels: false)
        // Quadro de partidas: preto e âmbar.
        case .terminal:
            return PanelStyle(dark: true, design: .monospaced, displayWeight: .bold,
                              bg: c(0x050505), fg: c(0xEDEDED), muted: c(0x8C8C8C), surface: c(0x111111), line: c(0x2A2A2A),
                              headerBg: c(0x050505), headerFg: c(0xFFB81C), headerLine: c(0x2A2A2A), headerLineWidth: 1,
                              heroBg: c(0x111111), heroFg: c(0xFFB81C), destBg: c(0x111111), destFg: .white,
                              accent: c(0xFFB81C), accentFg: c(0x050505), ok: c(0x4ADE80), wait: c(0xFF5C39),
                              queues: [c(0x38BDF8), c(0x4ADE80), c(0xFF5C39), c(0xC084FC)], radius: 3, border: 1, upperLabels: true)
        // Quadro de lanchonete: amarelo-gema e preto.
        case .vitrine:
            return PanelStyle(dark: false, design: .default, displayWeight: .heavy,
                              bg: c(0xFFD23F), fg: c(0x141414), muted: c(0x4D3F0C), surface: .white, line: c(0x141414),
                              headerBg: c(0x141414), headerFg: c(0xFFD23F), headerLine: c(0x141414), headerLineWidth: 0,
                              heroBg: c(0x141414), heroFg: c(0xFFD23F), destBg: .white, destFg: c(0x141414),
                              accent: c(0x141414), accentFg: c(0xFFD23F), ok: c(0x0B7A3B), wait: c(0xC2261B),
                              queues: [c(0xD7261E), c(0x1F5FBF), c(0x0B7A3B), c(0x7B2CBF)], radius: 16, border: 3, upperLabels: true)
        // Contraste máximo: branco, preto e cobalto.
        case .sol:
            return PanelStyle(dark: false, design: .default, displayWeight: .heavy,
                              bg: .white, fg: .black, muted: c(0x333333), surface: c(0xF2F2F2), line: .black,
                              headerBg: .black, headerFg: .white, headerLine: .black, headerLineWidth: 0,
                              heroBg: c(0x0030C8), heroFg: .white, destBg: .black, destFg: .white,
                              accent: c(0x0030C8), accentFg: .white, ok: c(0x00702E), wait: c(0xB00020),
                              queues: [c(0xD9480F), c(0x00702E), c(0xB00020), c(0x6A1B9A)], radius: 0, border: 3, upperLabels: true)
        }
    }
}

/// O som, o visual e o PIN de cada aparelho, guardados só neste aparelho: silenciar a sala não passa pelo servidor.
protocol PanelSettingsStore: AnyObject {
    func soundEnabled(_ deviceId: String) -> Bool
    func setSoundEnabled(_ deviceId: String, _ enabled: Bool)
    /// Volume do painel no app (gongo e voz), de 0,1 a 1; 1 quando nunca foi mexido.
    func panelVolume(_ deviceId: String) -> Float
    func setPanelVolume(_ deviceId: String, _ level: Float)
    func template(_ deviceId: String) -> PanelTemplate
    func setTemplate(_ deviceId: String, _ template: PanelTemplate)
    func sealedPin(_ deviceId: String) -> String?
    /// `nil` apaga (e zera as tentativas).
    func savePin(_ deviceId: String, _ sealed: String?)
    /// Erros e trava do PIN (`PanelPinAttempts.saved`), para fechar o app não zerar a contagem.
    func pinAttempts(_ deviceId: String) -> String?
    func savePinAttempts(_ deviceId: String, _ state: String?)
}

/// Som e visual nas preferências; PIN e tentativas no Keychain, no serviço do aparelho, só neste aparelho e fora do
/// backup (um resumo de 4 números tirado de um backup cairia em segundos). Reinstalar o app apaga os dois.
final class DefaultsPanelSettingsStore: PanelSettingsStore {
    private let defaults: UserDefaults
    private let keychainService: String
    init(defaults: UserDefaults = .standard, keychainService: String = KeychainDeviceConfigStore.productionService) {
        self.defaults = defaults
        self.keychainService = keychainService
    }

    func soundEnabled(_ id: String) -> Bool { defaults.object(forKey: "panel.sound.\(id)") as? Bool ?? true }
    func setSoundEnabled(_ id: String, _ enabled: Bool) { defaults.set(enabled, forKey: "panel.sound.\(id)") }
    func panelVolume(_ id: String) -> Float {
        (defaults.object(forKey: "panel.volume.\(id)") as? NSNumber).map { PanelVolume.clamp($0.floatValue) } ?? 1
    }
    func setPanelVolume(_ id: String, _ level: Float) { defaults.set(PanelVolume.clamp(level), forKey: "panel.volume.\(id)") }
    func template(_ id: String) -> PanelTemplate { .from(defaults.string(forKey: "panel.template.\(id)")) }
    func setTemplate(_ id: String, _ template: PanelTemplate) { defaults.set(template.rawValue, forKey: "panel.template.\(id)") }

    func sealedPin(_ id: String) -> String? {
        // Versões anteriores guardavam nas preferências: passa para o Keychain e apaga de lá.
        if let legacy = defaults.string(forKey: "panel.pin.\(id)") {
            Keychain.write(legacy, service: keychainService, account: "pin.\(id)")
            defaults.removeObject(forKey: "panel.pin.\(id)")
        }
        return Keychain.read(service: keychainService, account: "pin.\(id)")
    }

    func savePin(_ id: String, _ sealed: String?) {
        defaults.removeObject(forKey: "panel.pin.\(id)")
        if let sealed { Keychain.write(sealed, service: keychainService, account: "pin.\(id)") }
        else {
            Keychain.delete(service: keychainService, account: "pin.\(id)")
            savePinAttempts(id, nil)
        }
    }

    func pinAttempts(_ id: String) -> String? { Keychain.read(service: keychainService, account: "pin.attempts.\(id)") }
    func savePinAttempts(_ id: String, _ state: String?) {
        if let state { Keychain.write(state, service: keychainService, account: "pin.attempts.\(id)") }
        else { Keychain.delete(service: keychainService, account: "pin.attempts.\(id)") }
    }
}

final class MemoryPanelSettingsStore: PanelSettingsStore {
    private var sound: [String: Bool] = [:]
    private var templates: [String: PanelTemplate] = [:]
    private var pins: [String: String] = [:]
    private var attempts: [String: String] = [:]

    func pinAttempts(_ id: String) -> String? { attempts[id] }
    func savePinAttempts(_ id: String, _ state: String?) { attempts[id] = state }

    func soundEnabled(_ id: String) -> Bool { sound[id] ?? true }
    func setSoundEnabled(_ id: String, _ enabled: Bool) { sound[id] = enabled }
    private var volumes: [String: Float] = [:]
    func panelVolume(_ id: String) -> Float { volumes[id] ?? 1 }
    func setPanelVolume(_ id: String, _ level: Float) { volumes[id] = PanelVolume.clamp(level) }
    func template(_ id: String) -> PanelTemplate { templates[id] ?? .default }
    func setTemplate(_ id: String, _ template: PanelTemplate) { templates[id] = template }
    func sealedPin(_ id: String) -> String? { pins[id] }
    func savePin(_ id: String, _ sealed: String?) {
        pins[id] = sealed
        if sealed == nil { attempts[id] = nil }
    }
}
