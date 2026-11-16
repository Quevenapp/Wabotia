import SwiftUI
import UIKit

/// O que trava o iPad ou iPhone no app de verdade. O PIN só guarda os botões do app; o gesto de Início é do sistema e
/// só o **Acesso Guiado** (ou o Modo de App Único de um aparelho gerenciado por MDM) o bloqueia.
///
/// - Aparelho supervisionado com o app liberado no perfil MDM (`autonomousSingleAppModePermittedAppIDs`):
///   `requestGuidedAccessSession(enabled: true)` trava sem diálogo, e o app destrava ao sair do modo aparelho.
/// - Qualquer outro aparelho: o pedido volta `false` sem mostrar nada, e os ajustes do aparelho ensinam a ligar o
///   Acesso Guiado (Ajustes → Acessibilidade → Acesso Guiado, depois três cliques no botão lateral).
@MainActor
final class GuidedAccessStatus: ObservableObject {
    @Published private(set) var enabled = UIAccessibility.isGuidedAccessEnabled
    /// A trava atual foi pedida pelo app (MDM): só essa o app desfaz.
    private(set) var startedByApp = false
    private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(forName: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.update() }
        }
    }

    deinit { observer.map(NotificationCenter.default.removeObserver) }

    private func update() {
        enabled = UIAccessibility.isGuidedAccessEnabled
        if !enabled { startedByApp = false }
        #if DEBUG
        print("[Wabotia] aparelho: Acesso Guiado \(enabled ? "ligado" : "desligado")")
        #endif
    }

    /// Trava sem diálogo onde o MDM permite; nos demais aparelhos não acontece nada.
    func requestLock() {
        guard !UIAccessibility.isGuidedAccessEnabled else { update(); return }
        UIAccessibility.requestGuidedAccessSession(enabled: true) { [weak self] ok in
            Task { @MainActor in
                if ok { self?.startedByApp = true }
                self?.update()
                #if DEBUG
                print("[Wabotia] aparelho: trava pelo app (Modo de App Único) \(ok ? "aceita" : "não autorizada neste aparelho")")
                #endif
            }
        }
    }

    /// Ao sair do modo aparelho: desfaz só a trava que o próprio app pediu.
    func releaseLock() {
        guard startedByApp else { return }
        UIAccessibility.requestGuidedAccessSession(enabled: false) { [weak self] _ in
            Task { @MainActor in self?.update() }
        }
    }
}

/// Cartão dos ajustes do aparelho: diz se o app está travado e, se não, como travar.
struct GuidedAccessCard: View {
    @ObservedObject var status: GuidedAccessStatus

    static let steps = "Para ninguém sair do app pelo gesto de Início: em Ajustes → Acessibilidade → Acesso Guiado, ligue e defina um código. Depois, na tela do painel ou do totem, clique três vezes no botão lateral (ou no de Início) e toque em Iniciar."
    static let mdm = "Em iPads gerenciados por MDM, o Modo de App Único trava o app sem esses passos."

    var body: some View {
        SectionCard(title: "Travar na tela") {
            if status.enabled {
                CardRow(icon: "lock.shield.fill", iconColor: Theme.ok, title: "Acesso Guiado ligado",
                        subtitle: "O gesto de Início não sai do app. Para sair, clique três vezes no botão lateral.", divider: false)
            } else {
                CardRow(icon: "exclamationmark.shield.fill", iconColor: Theme.warn, title: "O app ainda não está travado",
                        subtitle: "Sem o Acesso Guiado, quem está na frente da tela sai do app pelo gesto de Início, mesmo com PIN.")
                VStack(alignment: .leading, spacing: 8) {
                    Text(Self.steps)
                    Text(Self.mdm).foregroundStyle(Theme.textSecondary)
                }
                .font(Theme.font(14)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 12)
            }
        }
        .accessibilityIdentifier("device.guidedAccess")
    }
}
