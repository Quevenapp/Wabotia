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

/// O modo aparelho ocupa o app inteiro, fora do login: parear com o Vinki, escolher o papel (e os ajustes), a tela do
/// papel (totem, painel de chamadas ou híbrido) e a impressora. Os ajustes ficam atrás da engrenagem e do PIN; sair do
/// app pelo gesto de Início só o Acesso Guiado (ou o Modo de App Único por MDM) impede (`GuidedAccessStatus`).
struct DeviceModeView: View {
    @StateObject private var vm: DeviceViewModel
    @StateObject private var guided = GuidedAccessStatus()
    let onFinish: () -> Void
    @State private var printer = false
    @State private var settings = false
    /// Último toque nos ajustes destravados: sem uso por alguns minutos, eles fecham e a tela do papel volta.
    @State private var settingsTouched = Date()
    @Environment(\.scenePhase) private var scenePhase

    /// Ajustes destravados sem nenhum toque por esse tempo voltam à tela do papel.
    static let settingsIdleSeconds: TimeInterval = 120

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
                    DeviceSettingsScreen(vm: vm, guided: guided, onPrinter: { printer = true }, onDone: config.role != nil ? { settings = false } : nil)
                        .simultaneousGesture(TapGesture().onEnded { settingsTouched = Date() })
                        .task(id: settingsTouched) {
                            // Ajustes esquecidos abertos: voltam sozinhos à tela do papel, que pede o PIN de novo.
                            guard settings, !printer else { return }
                            try? await Task.sleep(nanoseconds: UInt64(Self.settingsIdleSeconds * 1_000_000_000))
                            if !Task.isCancelled { closeSettings() }
                        }
                } else {
                    DevicePanelScreen(vm: vm, onSettings: { settingsTouched = Date(); settings = true })
                        // Aparelho gerenciado (MDM) com o app liberado: trava no app sem diálogo. Nos outros, nada acontece.
                        .onAppear { if !vm.demo { guided.requestLock() } }
                }
            } else {
                DevicePairingScreen(vm: vm, onBack: onFinish)
            }
        }
        .sheet(isPresented: $printer) { PrinterScreen { printer = false } }
        // A busca de impressora pode demorar: o relógio dos ajustes recomeça quando ela fecha.
        .onChange(of: printer) { _ in settingsTouched = Date() }
        .onAppear { OrientationPolicy.setDeviceMode(true) }
        .onDisappear {
            vm.close()
            guided.releaseLock()
            OrientationPolicy.setDeviceMode(false)
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onChange(of: vm.finished) { finished in
            if finished {
                guided.releaseLock()
                onFinish()
            }
        }
        // Ir para segundo plano fecha os ajustes destravados: quem volta ao app encontra a tela do papel.
        .onChange(of: scenePhase) { phase in if phase == .background { closeSettings() } }
        #if DEBUG
        .task { await runDebugAction() }
        #endif
    }

    /// Fecha os ajustes (e a impressora) quando o papel já está escolhido; sem papel não há tela para onde voltar.
    private func closeSettings() {
        guard settings, vm.config?.role != nil else { return }
        printer = false
        settings = false
    }

    #if DEBUG
    /// `WABOTIA_DEMO_ACTION` (só depuração): a ação feita sozinha para conferir a tela por print.
    private func runDebugAction() async {
        if !vm.demo {
            await runRealDeviceDebug()
            return
        }
        guard let action = DemoMode.action else { return }
        for _ in 0..<60 where vm.overview == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        switch action {
        case "choose": vm.chooseQueue("dq-geral")
        case "issue":
            vm.chooseQueue("dq-geral")
            vm.issue(preferential: true)
        case "settings": settings = true
        case "printer":
            settings = true
            printer = true
        case "unpair": vm.unpair()
        default: break
        }
    }

    /// `WABOTIA_DEVICE_*` (só depuração): pareia com o servidor de verdade, escolhe o papel e faz uma ação, registrando
    /// tudo no console. A aprovação do código é de quem administra o servidor (no painel ou pelo script de teste).
    private func runRealDeviceDebug() async {
        guard DemoMode.deviceServer != nil || DemoMode.deviceRole != nil || DemoMode.deviceAction != nil else { return }
        if vm.config == nil, let server = DemoMode.deviceServer {
            vm.startPairing(url: server, name: DemoMode.deviceName ?? "Aparelho de teste")
        }
        for _ in 0..<1200 where vm.config == nil { try? await Task.sleep(nanoseconds: 500_000_000) }
        guard vm.config != nil else { return }
        if let role = DemoMode.deviceRole.flatMap(DeviceRole.init(rawValue:)), vm.config?.role != role {
            vm.chooseRole(role)
            print("[Vinki] aparelho: papel \(role.rawValue)")
        }
        for _ in 0..<100 where vm.overview == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        switch DemoMode.deviceAction {
        case "issue":
            if let queue = vm.overview?.kioskQueues.first {
                vm.chooseQueue(queue.id)
                vm.issue(preferential: false)
            }
        case "settings": settings = true
        case "printer":
            settings = true
            printer = true
        case "unpair": vm.unpair()
        case "drop":
            // Reconexão: corta o WebSocket duas vezes, 20 s depois de ele abrir.
            for _ in 0..<2 {
                for _ in 0..<600 where !vm.live { try? await Task.sleep(nanoseconds: 100_000_000) }
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                vm.debugDropSocket()
            }
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
            title: code == nil ? "Painel ou totem" : "Aprove no Vinki",
            subtitle: code == nil ? "Este aparelho vira um totem de senhas, um painel de chamadas ou os dois." : "Digite este código no painel do Vinki."
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
                Text("No painel do Vinki, um administrador abre Integrações → Parear Senhapp, digita o código e aprova só “Ler a fila” e “Emitir senhas (totem)”. O código vale 10 minutos.")
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
    @ObservedObject var guided: GuidedAccessStatus
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
                            // Em todo papel, para quem procura a impressora achá-la: no Painel ela já fica pronta para quando
                            // o papel virar Totem ou Painel híbrido, os que imprimem o cupom.
                            if let role = config.role {
                                Button(action: onPrinter) {
                                    CardRow(icon: "printer.fill", iconColor: role.totem ? Theme.brand : Theme.muted, title: "Impressora do cupom",
                                            subtitle: role.totem ? "Bluetooth ou Wi-Fi" : "O Painel de chamadas não imprime: o cupom sai no Totem e no Painel híbrido",
                                            chevron: true)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("device.printer")
                            }
                            Button { pinSheet = true } label: {
                                CardRow(icon: vm.pinSet ? "lock.fill" : "lock.open.fill", iconColor: vm.pinSet ? Theme.ok : Theme.warn,
                                        title: vm.pinSet ? "Trocar o PIN dos ajustes" : "Criar PIN dos ajustes",
                                        subtitle: "Sem o PIN, ninguém abre estes ajustes nem desfaz o pareamento", chevron: true, divider: vm.pinSet)
                            }
                            .buttonStyle(.plain)
                            if vm.pinSet {
                                Button(action: vm.removePin) { CardRow(icon: "lock.open", iconColor: Theme.muted, title: "Remover o PIN", divider: false) }
                                    .buttonStyle(.plain)
                            }
                        }
                        if config.role != nil { GuidedAccessCard(status: guided) }
                        SectionCard(title: "Conexão") {
                            CardRow(icon: "globe", iconColor: vm.revoked || vm.offline ? Theme.danger : Theme.ok,
                                    title: URL(string: config.baseUrl)?.host ?? config.baseUrl, subtitle: connectionText)
                            Button { confirmLeave = true } label: {
                                CardRow(icon: "rectangle.portrait.and.arrow.right", iconColor: Theme.danger, title: vm.demo ? "Sair da demonstração" : "Desfazer pareamento",
                                        subtitle: vm.demo ? nil : "O aparelho esquece a credencial e avisa o Vinki", titleColor: Theme.danger, divider: false)
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
            .sheet(isPresented: $pinSheet, onDismiss: { vm.suggestPin = false }) { PinCreateSheet(onCreate: vm.createPin) }
            .onChange(of: vm.suggestPin) { suggest in if suggest { pinSheet = true } }
            .confirmationDialog(vm.demo ? "Sair da demonstração?" : "Desfazer pareamento?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button(vm.demo ? "Sair" : "Desfazer", role: .destructive, action: vm.unpair)
                Button("Cancelar", role: .cancel) {}
            } message: {
                Text(vm.demo ? "O aparelho volta à tela inicial do Vinki." : "O aparelho esquece o vínculo e avisa o Vinki. Para voltar a ser painel ou totem, pareie de novo.")
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
            SheetHeader(title: "PIN dos ajustes") { dismiss() }
            Text("Quem passa na frente do totem ou da TV não abre estes ajustes nem desfaz o pareamento sem o PIN. Para ninguém sair do app pelo gesto de Início, ligue também o Acesso Guiado (Ajustes → Acessibilidade).")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            PinField(label: "PIN (4 ou 6 números)", value: $pin)
            PinField(label: "Repita o PIN", value: $again)
            if let error { InlineError(text: error) }
            PrimaryButton(title: "Salvar", disabled: !PanelPin.validLength(pin) || again.count != pin.count) {
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
                    let digits = String(v.filter(\.isNumber).prefix(PanelPin.maxLength))
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
            PrimaryButton(title: "Entrar", disabled: !PanelPin.validLength(pin)) {
                if vm.unlock(pin) {
                    dismiss()
                    onUnlocked()
                } else {
                    pin = ""
                }
            }
            Text(vm.demo ? "Esqueceu o PIN? Na demonstração, feche e abra o app de novo." : "Esqueceu o PIN? Um administrador revoga este aparelho no Vinki (Integrações). Os ajustes passam a abrir sem PIN para desfazer o pareamento e parear de novo.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
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
                        PanelHeaderBar(name: config.name, role: vm.demo ? "Vinki · demonstração" : "Vinki", title: role.panel ? "Chamadas" : "Retire sua senha") {
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
                                Text(vm.revoked ? "Este aparelho foi desconectado do Vinki. Dirija-se ao balcão." : "Sem conexão com o Vinki: o totem não emite senhas agora. Dirija-se ao balcão.")
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
            #if DEBUG
            .task {
                // WABOTIA_DEMO_ACTION=pin (só depuração): cria o PIN 2580, toca na engrenagem e erra o PIN uma vez.
                guard vm.demo, DemoMode.action == "pin" else { return }
                _ = vm.createPin("2580", confirmation: "2580")
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guarded()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                _ = vm.unlock("1111")
            }
            #endif
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
                    Text(vm.notice ?? "Sem conexão com o Vinki. Tentando de novo…").multilineTextAlignment(.center)
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

    /// Ajustes e saída passam pelo PIN quando há um (menos com a credencial revogada, que não vale mais nada).
    private func guarded() {
        if vm.settingsNeedPin { unlocking = true } else { onSettings() }
    }
}

/// Barra de início e afins escondidas no iOS 16+ (no 15, só a barra de status some).
private struct HideSystemOverlays: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 16, *) { content.persistentSystemOverlays(.hidden) } else { content }
    }
}
