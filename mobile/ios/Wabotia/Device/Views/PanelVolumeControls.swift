import MediaPlayer
import SwiftUI
import UIKit

/// O som do painel nos ajustes do aparelho: o volume de mídia do iPad (o controle do sistema, `MPVolumeView`, que o
/// app não pode mexer sozinho), o volume do painel no app e o aviso de som baixo. O botão "Testar som" fica logo abaixo.
struct PanelVolumeControls: View {
    @ObservedObject var vm: DeviceViewModel
    @ObservedObject var system: SystemVolume

    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Volume do \(device)").font(Theme.font(16)).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    if let level = system.level {
                        Text(PanelVolume.percent(level)).font(Theme.font(15)).foregroundStyle(Theme.textSecondary).monospacedDigit()
                    }
                }
                SystemVolumeSlider()
                    .frame(height: 34)
                    .accessibilityIdentifier("device.systemVolume")
                Text("É o volume de mídia do \(device), o mesmo dos botões laterais: o app não pode mudá-lo sozinho. Com o painel aberto, os botões laterais também o sobem. Com fone ou caixa Bluetooth ligados, o som sai por eles.")
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Volume do painel").font(Theme.font(16)).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Text(PanelVolume.percent(vm.panelVolume)).font(Theme.font(15)).foregroundStyle(Theme.textSecondary).monospacedDigit()
                }
                Slider(value: Binding(get: { Double(vm.panelVolume) }, set: { vm.setPanelVolume(Float($0)) }),
                       in: Double(PanelVolume.range.lowerBound)...Double(PanelVolume.range.upperBound), step: 0.05) { editing in
                    if !editing { vm.testSound() }
                }
                .tint(Theme.brand)
                .accessibilityLabel("Volume do painel")
                .accessibilityValue(PanelVolume.percent(vm.panelVolume))
                .accessibilityIdentifier("device.volume")
                Text("Gongo e voz, dentro do volume do \(device). Em 100% o painel fala no máximo que o \(device) permite.")
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            if PanelVolume.isLow(system: system.level, panel: vm.panelVolume) {
                DeviceNotice(text: lowText, color: Theme.danger)
                    .accessibilityIdentifier("device.lowVolume")
            }
        }
        .padding(14)
        .overlay(alignment: .bottom) { Theme.cardDivider.frame(height: 1).padding(.leading, 14) }
    }

    private var lowText: String {
        if let level = system.level, level < PanelVolume.lowThreshold {
            return "Som baixo: o volume do \(device) está em \(PanelVolume.percent(level)). Suba pelos botões laterais ou no controle acima, ou a recepção quase não vai ouvir."
        }
        return "Som baixo: suba o volume do painel acima, ou a recepção quase não vai ouvir."
    }
}

/// O controle de volume do sistema (mexe no volume de mídia, como os botões laterais). No simulador não aparece.
private struct SystemVolumeSlider: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        view.tintColor = UIColor(Theme.brand)
        return view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}
