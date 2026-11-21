import SwiftUI
import UIKit

/// Cobre o app quando ele deixa de estar ativo (seletor de apps, Central de Controle, segundo plano): a miniatura do
/// seletor e o retrato que o iOS tira ao ir para segundo plano mostram só a marca, nunca a conversa aberta nem a tela
/// do pagador com CPF/CNPJ. É uma janela própria acima de tudo, para cobrir também as folhas abertas.
/// O modo aparelho (totem e painel) não é coberto: ele só mostra a fila pública.
@MainActor
final class PrivacyShield {
    static let shared = PrivacyShield()
    private var windows: [ObjectIdentifier: UIWindow] = [:]

    /// Quando cobrir; o padrão olha o `AppContainer`.
    var shouldCover: () -> Bool = { AppContainer.shared.deviceLaunch == nil }

    /// Chamado pela mudança de `scenePhase` do app (na thread principal, antes do retrato do segundo plano).
    func update(_ phase: ScenePhase) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes {
            if phase == .active { uncover(scene) } else { cover(scene) }
        }
    }

    func cover(_ scene: UIWindowScene) {
        guard shouldCover() else { return }
        let key = ObjectIdentifier(scene)
        if let window = windows[key] { window.isHidden = false; return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        // A mesma aparência (clara, escura ou do sistema) escolhida no app.
        window.overrideUserInterfaceStyle = scene.windows.first { $0.windowLevel == .normal }?.overrideUserInterfaceStyle ?? .unspecified
        let host = UIHostingController(rootView: PrivacyCover())
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.isHidden = false
        windows[key] = window
        #if DEBUG
        print("[Vinki] privacidade: app coberto (fora de primeiro plano)")
        #endif
    }

    func uncover(_ scene: UIWindowScene) {
        let key = ObjectIdentifier(scene)
        windows[key]?.isHidden = true
        windows[key] = nil
    }
}

/// Só a marca, no fundo do app.
private struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 14) {
                BrandTile(size: 76)
                Text("Vinki").font(Theme.font(22, .bold)).foregroundStyle(Theme.brand)
            }
        }
        .accessibilityHidden(true)
    }
}
