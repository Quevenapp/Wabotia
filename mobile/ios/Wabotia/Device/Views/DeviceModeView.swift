import SwiftUI
import UIKit

/// Abertura do modo aparelho: o real (credencial no Keychain) ou o da demonstração (em memória).
struct DeviceLaunch: Identifiable, Equatable {
    let id = UUID()
    var demo: Bool
    var serverURL: String?
    /// Só nos atalhos de depuração: o papel já escolhido.
    var role: DeviceRole? = nil
}

/// O modo aparelho ocupa o app inteiro, fora do login: parear com o Wabotia, escolher o papel (e os ajustes), a tela do
/// papel (totem, painel de chamadas ou híbrido) e a impressora. Ajustes e saída ficam atrás da engrenagem e do PIN.
struct DeviceModeView: View {
    @StateObject private var vm: DeviceViewModel
    let onFinish: () -> Void
    @State private var printer = false
    @State private var settings = false

    init(launch: DeviceLaunch, onFinish: @escaping () -> Void) {
        _vm = StateObject(wrappedValue: DeviceViewModel(services: launch.demo ? .demo(role: launch.role) : .live(serverURL: launch.serverURL)))
        self.onFinish = onFinish
    }

    /// Para os testes de interface e as telas de depuração: o modelo já montado.
    init(vm: DeviceViewModel, onFinish: @escaping () -> Void) {
        _vm = StateObject(wrappedValue: vm)
        self.onFinish = onFinish
    }

    var body: some View {
        Group {
            if vm.finished {
                Theme.background.ignoresSafeArea()
            } else if let config = vm.config {
                if config.role == nil || settings {
                    DeviceSettingsScreen(vm: vm, onPrinter: { printer = true }, onDone: config.role != nil ? { settings = false } : nil)
                } else {
                    DevicePanelScreen(vm: vm, onSettings: { settings = true })
                }
            } else {
                DevicePairingScreen(vm: vm, onBack: onFinish)
            }
        }
        .sheet(isPresented: $printer) { PrinterScreen { printer = false } }
        .onAppear { OrientationPolicy.setDeviceMode(true) }
        .onDisappear {
            vm.close()
            OrientationPolicy.setDeviceMode(false)
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onChange(of: vm.finished) { finished in if finished { onFinish() } }
        #if DEBUG
        .task { await runDebugAction() }
        #endif
    }

    #if DEBUG
    /// `WABOTIA_DEMO_ACTION` (só depuração): a ação feita sozinha para conferir a tela por print.
    private func runDebugAction() async {
        guard vm.demo, let action = DemoMode.action else { return }
        for _ in 0..<60 where vm.overview == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        switch action {
        case "choose": vm.chooseQueue("dq-geral")
        case "issue":
            vm.chooseQueue("dq-geral")
            vm.issue(preferential: true)
        case "settings": settings = true
        default: break
        }
    }
    #endif
}

// MARK: - Parear

private struct DevicePairingScreen: View {
    @ObservedObject var vm: DeviceViewModel
    let onBack: () -> Void
    @State private var url = ""
    @State private var name = ""

    var body: some View {
        let code = vm.pairing.userCode
        AuthScaffold(
            title: code == nil ? "Painel ou totem" : "Aprove no Wabotia",
            subtitle: code == nil ? "Este aparelho vira um totem de senhas, um painel de chamadas ou os dois." : "Digite este código no painel do Wabotia."
        ) {
            if vm.demo {
                DeviceNotice(text: "Demonstração: o código é aprovado sozinho em alguns segundos e nada sai do aparelho.", color: Theme.warn)
            }
            if let code {
                VStack(spacing: 12) {
                    Text(code).font(.system(size: 44, weight: .black, design: .monospaced)).foregroundStyle(Theme.textPrimary)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .accessibilityIdentifier("device.code")
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Esperando a aprovação…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .card(padding: 20)
                Text("No painel do Wabotia, um administrador abre Integrações → Parear Senhapp, digita o código e aprova só “Ler a fila” e “Emitir senhas (totem)”. O código vale 10 minutos.")
                    .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                SecondaryButton(title: "Cancelar", action: vm.cancelPairing)
            } else {
                AuthField(label: "Servidor") {
                    Text("https://").foregroundStyle(Theme.textSecondary)
                    TextField("wabotia.suaempresa.com.br", text: $url)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(vm.pairing.busy || vm.demo)
                        .accessibilityIdentifier("device.url")
                }
                AuthField(label: "Nome deste aparelho") {
                    TextField("Totem da entrada", text: $name)
                        .disabled(vm.pairing.busy)
                        .onChange(of: name) { value in if value.count > 80 { name = String(value.prefix(80)) } }
                        .accessibilityIdentifier("device.name")
                }
                PrimaryButton(title: "Gerar código", busy: vm.pairing.busy,
                              disabled: url.trimmingCharacters(in: .whitespaces).isEmpty || name.trimmingCharacters(in: .whitespaces).isEmpty) {
                    vm.startPairing(url: url, name: name)
                }
                .accessibilityIdentifier("device.start")
                Text("O aparelho recebe uma credencial própria, separada de qualquer conta de pessoa. Ele só lê a fila e emite senhas; chamar senhas fica no guichê, dentro do app.")
                    .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                Button("Voltar", action: onBack)
                    .font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                    .frame(maxWidth: .infinity, minHeight: Theme.touch)
            }
            if let error = vm.pairing.error { InlineError(text: error).accessibilityIdentifier("device.error") }
        }
        .onAppear {
            if url.isEmpty { url = vm.serverURL.flatMap { URL(string: $0)?.host } ?? "" }
            if vm.demo, name.isEmpty { name = "Totem da recepção" }
        }
    }
}

/// Aviso colorido curto (demonstração, permissões a mais).
struct DeviceNotice: View {
    let text: String
    var color: Color = Theme.warn

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill").foregroundStyle(color)
            Text(text).font(Theme.font(14)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.14)))
    }
}

// MARK: - Papel e ajustes

private struct DeviceSettingsScreen: View {
    @ObservedObject var vm: DeviceViewModel
    let onPrinter: () -> Void
    let onDone: (() -> Void)?
    @State private var pinSheet = false
    @State private var confirmLeave = false

    var body: some View {
        if let config = vm.config {
            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    IconButton(systemName: "chevron.left", label: onDone == nil ? "Sair do modo aparelho" : "Voltar à tela") {
                        if let onDone { onDone() } else { confirmLeave = true }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        Text(onDone == nil ? "O que este aparelho faz?" : "Ajustes deste aparelho").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                        Text(config.name).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                    Spacer()
                }
                .padding(.trailing, 16)
                .background(Theme.bar.ignoresSafeArea(edges: .top))
                .overlay(alignment: .bottom) { ThinDivider() }
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let notice = vm.notice { DeviceNotice(text: notice) }
                        SectionCard(title: "Papel") {
                            ForEach(DeviceRole.allCases) { role in
                                RoleRow(role: role, selected: config.role == role, enabled: !role.totem || config.canIssue,
                                        divider: role != DeviceRole.allCases.last) { vm.chooseRole(role) }
                            }
                        }
                        if config.role != nil {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("VISUAL DA TELA").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary).padding(.horizontal, 14)
                                TemplatePicker(selected: vm.template, onPick: vm.setTemplate)
                            }
                        }
                        SectionCard(title: "Aparelho") {
                            if config.role?.panel == true {
                                CardRow(icon: "speaker.wave.2.fill", iconColor: Theme.brand, title: "Voz das chamadas", subtitle: "Gongo e a senha falada duas vezes") {
                                    Toggle("", isOn: Binding(get: { vm.soundEnabled }, set: vm.setSound)).labelsHidden()
                                }
                                Button(action: vm.testSound) {
                                    CardRow(icon: "play.fill", iconColor: Theme.ticket, title: "Testar som", subtitle: "“Senha N 1. Guichê 1.”")
                                }
                                .buttonStyle(.plain)
                            }
                            if config.role?.totem == true {
                                Button(action: onPrinter) {
                                    CardRow(icon: "printer.fill", iconColor: Theme.muted, title: "Impressora do cupom", subtitle: "Bluetooth ou Wi-Fi", chevron: true)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("device.printer")
                            }
                            Button { pinSheet = true } label: {
                                CardRow(icon: vm.pinSet ? "lock.fill" : "lock.open.fill", iconColor: vm.pinSet ? Theme.ok : Theme.warn,
                                        title: vm.pinSet ? "Trocar o PIN de saída" : "Criar PIN de saída",
                                        subtitle: "Sem o PIN, ninguém abre estes ajustes nem sai da tela do aparelho", chevron: true, divider: vm.pinSet)
                            }
                            .buttonStyle(.plain)
                            if vm.pinSet {
                                Button(action: vm.removePin) { CardRow(icon: "lock.open", iconColor: Theme.muted, title: "Remover o PIN", divider: false) }
                                    .buttonStyle(.plain)
                            }
                        }
                        SectionCard(title: "Conexão") {
                            CardRow(icon: "globe", iconColor: vm.revoked || vm.offline ? Theme.danger : Theme.ok,
                                    title: URL(string: config.baseUrl)?.host ?? config.baseUrl, subtitle: connectionText)
                            Button { confirmLeave = true } label: {
                                CardRow(icon: "rectangle.portrait.and.arrow.right", iconColor: Theme.danger, title: vm.demo ? "Sair da demonstração" : "Desfazer pareamento",
                                        subtitle: vm.demo ? nil : "O aparelho esquece a credencial e avisa o Wabotia", titleColor: Theme.danger, divider: false)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("device.unpair")
                        }
                        if let onDone {
                            PrimaryButton(title: "Voltar à tela", action: onDone)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .sheet(isPresented: $pinSheet) { PinCreateSheet(onCreate: vm.createPin) }
            .confirmationDialog(vm.demo ? "Sair da demonstração?" : "Desfazer pareamento?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button(vm.demo ? "Sair" : "Desfazer", role: .destructive, action: vm.unpair)
                Button("Cancelar", role: .cancel) {}
            } message: {
                Text(vm.demo ? "O aparelho volta à tela inicial do Wabotia." : "O aparelho esquece o vínculo e avisa o Wabotia. Para voltar a ser painel ou totem, pareie de novo.")
            }
        }
    }

    private var connectionText: String {
        if vm.demo { return "Demonstração: dados fictícios, nada sai do aparelho" }
        if vm.revoked { return "Credencial revogada no servidor" }
        if vm.offline { return "Sem conexão agora" }
        if vm.live { return "Ao vivo (WebSocket)" }
        return "Conectado (consulta a cada 5 s)"
    }
}

private struct RoleRow: View {
    let role: DeviceRole
    let selected: Bool
    let enabled: Bool
    let divider: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            CardRow(icon: role.icon, iconColor: enabled ? Theme.brand : Theme.muted, title: role.label,
                    subtitle: enabled ? role.detail : "Sem permissão de emitir senhas neste pareamento", divider: divider) {
                if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.brand).accessibilityLabel("Escolhido") }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityIdentifier("role.\(role.rawValue)")
    }
}

/// Os cinco visuais em miniatura, cada um com a própria paleta.
private struct TemplatePicker: View {
    let selected: PanelTemplate
    let onPick: (PanelTemplate) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
            ForEach(PanelTemplate.allCases) { template in
                let s = template.style
                Button { onPick(template) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("N023").font(s.display(22)).foregroundStyle(s.heroFg)
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: min(s.radius, 8)).fill(s.heroBg))
                            Spacer()
                            if template == selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(s.accent == s.bg ? s.fg : s.accent) }
                        }
                        Text(template.label).font(s.text(16, .bold)).foregroundStyle(s.fg)
                        Text(template.fit).font(s.text(12)).foregroundStyle(s.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
                    .background(RoundedRectangle(cornerRadius: 14).fill(s.bg))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(template == selected ? Theme.brand : Theme.divider, lineWidth: template == selected ? 3 : 1))
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("Visual \(template.label)\(template == selected ? ", escolhido" : "")")
            }
        }
    }
}

// MARK: - PIN

private struct PinCreateSheet: View {
    let onCreate: (String, String) -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var pin = ""
    @State private var again = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "PIN de saída") { dismiss() }
            Text("Quem passa na frente do totem ou da TV não abre os ajustes nem sai da tela sem o PIN.")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            PinField(label: "PIN (4 números)", value: $pin)
            PinField(label: "Repita o PIN", value: $again)
            if let error { InlineError(text: error) }
            PrimaryButton(title: "Salvar", disabled: pin.count != 4 || again.count != 4) {
                error = onCreate(pin, again)
                if error == nil { dismiss() }
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
    }
}

private struct PinField: View {
    let label: String
    @Binding var value: String

    var body: some View {
        AuthField(label: label) {
            SecureField("••••", text: $value)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .onChange(of: value) { v in
                    let digits = String(v.filter(\.isNumber).prefix(4))
                    if digits != v { value = digits }
                }
        }
    }
}

/// Pede o PIN antes de abrir os ajustes ou sair da tela do aparelho.
private struct UnlockSheet: View {
    @ObservedObject var vm: DeviceViewModel
    let onUnlocked: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var pin = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Digite o PIN") { dismiss() }
            PinField(label: "PIN", value: $pin)
            if let error = vm.pinError { InlineError(text: error) }
            PrimaryButton(title: "Entrar", disabled: pin.count != 4) {
                if vm.unlock(pin) {
                    dismiss()
                    onUnlocked()
                } else {
                    pin = ""
                }
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .onAppear { vm.pinError = nil }
    }
}

// MARK: - Painel, totem e híbrido

private struct DevicePanelScreen: View {
    @ObservedObject var vm: DeviceViewModel
    let onSettings: () -> Void
    @State private var unlocking = false

    var body: some View {
        if let config = vm.config, let role = config.role {
            let s = vm.template.style
            GeometryReader { geo in
                let base = min(max(min(geo.size.width, geo.size.height) * 0.023, 11), 30)
                let landscape = geo.size.width > geo.size.height
                ZStack {
                    s.bg.ignoresSafeArea()
                    VStack(spacing: 0) {
                        PanelHeaderBar(name: config.name, role: vm.demo ? "Wabotia · demonstração" : "Wabotia", title: role.panel ? "Chamadas" : "Retire sua senha") {
                            Text(connectionLabel).font(s.text(base * 0.8, .semibold))
                                .foregroundStyle(vm.offline || vm.revoked ? Color.red : s.headerFg)
                                .accessibilityIdentifier("device.connection")
                            Button { guarded() } label: {
                                Image(systemName: "gearshape").font(.system(size: base * 1.2)).foregroundStyle(s.headerFg)
                                    .frame(width: Theme.touch, height: Theme.touch)
                            }
                            .accessibilityLabel("Ajustes deste aparelho")
                            .accessibilityIdentifier("device.settings")
                        }
                        VStack(spacing: base * 0.7) {
                            if (vm.offline || vm.revoked) && role.totem {
                                Text(vm.revoked ? "Este aparelho foi desconectado do Wabotia. Dirija-se ao balcão." : "Sem conexão com o Wabotia: o totem não emite senhas agora. Dirija-se ao balcão.")
                                    .font(s.text(base)).foregroundStyle(Color.white)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(base * 0.7)
                                    .background(Color(UIColor.systemRed))
                                    .accessibilityIdentifier("device.offline")
                            } else if let notice = vm.notice {
                                Text(notice).font(s.text(base * 0.95)).foregroundStyle(s.wait).frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityIdentifier("device.notice")
                            }
                            content(role: role, config: config, landscape: landscape)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                        .padding(base * 0.9)
                    }
                    if role.panel, let call = vm.spotlight { CallSpotlight(call: call) }
                    if let queue = vm.choosing {
                        TypeChoiceOverlay(queue: queue, onChoose: vm.issue(preferential:), onCancel: vm.cancelChoice)
                    }
                    if vm.busy { ProgressView().scaleEffect(1.6).tint(s.fg) }
                }
                .environment(\.panelStyle, s)
                .environment(\.panelBase, base)
                .animation(.quick, value: vm.spotlight)
            }
            .statusBarHidden(true)
            .modifier(HideSystemOverlays())
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
            .sheet(isPresented: $unlocking) { UnlockSheet(vm: vm, onUnlocked: onSettings) }
            .accessibilityIdentifier("device.panel")
        }
    }

    @ViewBuilder
    private func content(role: DeviceRole, config: DeviceConfig, landscape: Bool) -> some View {
        let blocked = vm.busy || vm.offline || vm.revoked
        if let overview = vm.overview {
            let issuedCard = vm.issued.map { ticket in
                IssuedTicketCard(ticket: ticket, print: vm.couponPrint, header: config.name, onReprint: vm.reprint(confirmed:), onDone: vm.clearIssued)
            }
            if let issuedCard, role.totem, !(role.panel && landscape) {
                ScrollView { issuedCard }
            } else if role == .hybrid {
                let totem = Group {
                    if let issuedCard { ScrollView { issuedCard } } else { TotemBoard(queues: overview.kioskQueues, blocked: blocked, onChoose: vm.chooseQueue) }
                }
                if landscape {
                    HStack(spacing: 16) {
                        totem.frame(maxWidth: .infinity)
                        CallBoard(calls: overview.stationCalls).frame(maxWidth: .infinity)
                    }
                } else {
                    VStack(spacing: 16) {
                        CallBoard(calls: overview.stationCalls)
                        totem
                    }
                }
            } else if role == .totem {
                TotemBoard(queues: overview.kioskQueues, blocked: blocked, onChoose: vm.chooseQueue)
            } else {
                CallBoard(calls: overview.stationCalls)
            }
        } else {
            VStack(spacing: 12) {
                if vm.offline {
                    Text(vm.notice ?? "Sem conexão com o Wabotia. Tentando de novo…").multilineTextAlignment(.center)
                } else {
                    ProgressView()
                    Text("Lendo a fila…")
                }
            }
            .font(vm.template.style.text(18))
            .foregroundStyle(vm.template.style.muted)
        }
    }

    private var connectionLabel: String {
        if vm.revoked { return "● desconectado" }
        if vm.offline { return "● sem conexão" }
        if vm.live || vm.demo { return "● ao vivo" }
        return "● conectando"
    }

    /// Ajustes e saída passam pelo PIN quando há um.
    private func guarded() {
        if vm.pinSet { unlocking = true } else { onSettings() }
    }
}

/// Barra de início e afins escondidas no iOS 16+ (no 15, só a barra de status some).
private struct HideSystemOverlays: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 16, *) { content.persistentSystemOverlays(.hidden) } else { content }
    }
}
