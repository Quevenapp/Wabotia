import UIKit

/// Quais orientações a tela aceita agora. O `Info.plist` declara retrato e paisagem (iPhone) e todas (iPad); quem
/// restringe em tempo de execução é `AppDelegate.application(_:supportedInterfaceOrientationsFor:)`, que lê daqui:
///
/// - iPhone, app de atendimento: só retrato (como sempre foi).
/// - iPhone, modo aparelho (totem, painel de chamadas, híbrido): retrato ou paisagem, à escolha de quem instala.
/// - iPad: todas, nos dois modos (o iPad em pé ou deitado vira totem ou TV).
enum OrientationPolicy {
    /// Ligado enquanto a tela do modo aparelho está aberta.
    private(set) static var deviceMode = false

    static func mask(idiom: UIUserInterfaceIdiom = UIDevice.current.userInterfaceIdiom, deviceMode: Bool = OrientationPolicy.deviceMode) -> UIInterfaceOrientationMask {
        if idiom == .pad { return .all }
        return deviceMode ? .allButUpsideDown : .portrait
    }

    /// Entra ou sai do modo aparelho e pede ao sistema para reavaliar a orientação (ao sair, o iPhone volta ao retrato).
    @MainActor
    static func setDeviceMode(_ on: Bool) {
        guard deviceMode != on else { return }
        deviceMode = on
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if #available(iOS 16, *) {
            for scene in scenes {
                scene.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
                if !on, UIDevice.current.userInterfaceIdiom != .pad {
                    scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in }
                }
            }
        } else {
            if !on, UIDevice.current.userInterfaceIdiom != .pad {
                UIDevice.current.setValue(UIInterfaceOrientation.portrait.rawValue, forKey: "orientation")
            }
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}
