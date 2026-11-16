import MapKit
import SwiftUI
import UIKit

/// Abertura do modo entregador: o de verdade (credenciais no Keychain) ou o da demonstração.
struct CourierLaunch: Identifiable, Equatable {
    let id = UUID()
    var demo: Bool
}

/// O modo entregador ocupa o app inteiro, fora do login, como o modo aparelho: as entregas lidas pelo QR, cada uma com
/// a rota, a conversa e o fim. Quando a última sai (entregue, cancelada ou revogada), volta à primeira tela.
struct CourierModeView: View {
    @StateObject private var vm: CourierViewModel
    let onFinish: (String?) -> Void
    @State private var scanning = false
    @State private var confirmLeave = false
    /// A entrega aberta na pilha.
    @State private var opened: String?
    @Environment(\.openURL) private var openURL

    init(launch: CourierLaunch, onFinish: @escaping (String?) -> Void) {
        _vm = StateObject(wrappedValue: CourierViewModel(services: launch.demo ? .demo() : .live()))
        self.onFinish = onFinish
    }

    init(vm: CourierViewModel, onFinish: @escaping (String?) -> Void) {
        _vm = StateObject(wrappedValue: vm)
        self.onFinish = onFinish
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if vm.demo { DemoBanner { vm.leave() } }
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let notice = vm.notice { DeviceNotice(text: notice, color: Theme.brand) }
                        if vm.grants.isEmpty {
                            emptyState
                        } else {
                            ForEach(vm.ordered) { d in
                                NavigationLink(tag: d.id, selection: $opened) { CourierDeliveryView(vm: vm, id: d.id) } label: { CourierDeliveryCard(delivery: d) }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("courier.delivery.\(d.id)")
                            }
                            SecondaryButton(title: "Escanear outro pedido", icon: "qrcode.viewfinder") { scanning = true }
                                .accessibilityIdentifier("courier.scanMore")
                        }
                        Button(vm.demo ? "Sair da demonstração" : "Sair do modo entregador") { confirmLeave = true }
                            .font(Theme.font(15, .semibold)).foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, minHeight: Theme.touch)
                    }
                    .padding(16)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Entregas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { scanning = true } label: { Image(systemName: "qrcode.viewfinder") }
                        .accessibilityLabel("Escanear pedido")
                }
            }
        }
        .navigationViewStyle(.stack)
        .sheet(isPresented: $scanning) { CourierScanView(vm: vm) { scanning = false } }
        .sheet(isPresented: Binding(get: { vm.disclosureFor != nil }, set: { if !$0 { vm.declineDisclosure() } })) {
            CourierDisclosureSheet(demo: vm.demo, onContinue: vm.acceptDisclosure, onDecline: vm.declineDisclosure)
        }
        .alert("Localização desligada", isPresented: Binding(get: { vm.locationDenied }, set: { _ in })) {
            Button("Abrir Ajustes") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
            Button("Agora não", role: .cancel) {}
        } message: {
            Text("Para compartilhar a previsão de chegada, permita a localização \"Durante o uso do app\" em Ajustes → Wabotia → Localização.")
        }
        .confirmationDialog(vm.demo ? "Sair da demonstração?" : "Sair do modo entregador?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Sair", role: .destructive) { vm.leave() }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text(vm.grants.isEmpty ? "O app volta à primeira tela." : "As entregas abertas saem deste aparelho; para voltar a uma delas, escaneie o QR de novo.")
        }
        .onAppear {
            vm.open()
            // Entrou para escanear: a câmera já abre.
            if vm.grants.isEmpty { scanning = true }
            #if DEBUG
            runDebugAction()
            #endif
        }
        .onDisappear { vm.close() }
        .onChange(of: vm.finished) { finished in if finished { onFinish(vm.notice) } }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "shippingbox.fill").font(.system(size: 44)).foregroundStyle(Theme.brand)
            Text("Escaneie o QR do pedido").font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
            Text("O QR fica na comanda ou na tela da loja. Cada pedido lido vira uma entrega aqui; você pode levar vários ao mesmo tempo. Sem conta: o acesso vale só até a entrega terminar.")
                .font(Theme.font(14)).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(title: "Escanear pedido", icon: "qrcode.viewfinder") { scanning = true }
                .accessibilityIdentifier("courier.scan")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    #if DEBUG
    /// `WABOTIA_DEMO_ACTION` no modo entregador da demonstração: `scan` lê um pedido, `two` lê dois, `detail` abre a
    /// entrega, `disclosure` mostra o aviso de localização, `route` sai para a rota (aceitando o aviso), `chat` sai e
    /// manda uma mensagem à loja, `deliver` sai e entrega depois de 15 s.
    private func runDebugAction() {
        guard vm.demo, let action = DemoMode.action, vm.grants.isEmpty else { return }
        Task { @MainActor in
            scanning = false
            await vm.scanned("DEMO-ENTREGA-1")
            if action == "two" { await vm.scanned("DEMO-ENTREGA-2") }
            guard ["route", "chat", "deliver", "detail", "disclosure"].contains(action), let id = vm.grants.first?.deliveryId else { return }
            opened = id
            if action == "detail" { return }
            try? await Task.sleep(nanoseconds: 800_000_000)
            vm.startRoute(id)
            if action == "disclosure" { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            vm.acceptDisclosure()
            if action == "chat" { _ = await vm.send(id, .store, "Saindo agora!") }
            if action == "deliver" {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                await vm.delivered(id)
            }
        }
    }
    #endif
}

/// Uma entrega na lista: número, cliente, endereço, situação e previsão.
struct CourierDeliveryCard: View {
    let delivery: CourierDelivery

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(delivery.displayLabel).font(Theme.font(17, .bold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Text(delivery.statusText).font(Theme.font(12, .semibold))
                    .foregroundStyle(delivery.enRoute ? Theme.onBrand : Theme.textSecondary)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Capsule().fill(delivery.enRoute ? Theme.brand : Theme.muted.opacity(0.18)))
            }
            if let customer = delivery.customerName { Text(customer).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary) }
            if let address = delivery.addressText {
                Text(address.replacingOccurrences(of: "\n", with: " · ")).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(2)
            }
            if delivery.enRoute, let eta = delivery.etaText {
                Label(eta, systemImage: "clock").font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14)
        .overlay(alignment: .trailing) { Image(systemName: "chevron.right").foregroundStyle(Theme.muted).padding(.trailing, 14) }
    }
}

/// O aviso em destaque antes de pedir a permissão (docs/ENTREGA.md; Play e App Store pedem a divulgação na tela).
struct CourierDisclosureSheet: View {
    let demo: Bool
    let onContinue: () -> Void
    let onDecline: () -> Void

    static let text = "Durante a entrega, o Wabotia compartilha a sua localização com o estabelecimento e com o cliente deste pedido, para mostrar a previsão de chegada. O compartilhamento começa quando você toca em Iniciar rota e para quando a entrega é concluída ou cancelada. A posição é apagada em até 24 horas."

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "location.circle.fill").font(.system(size: 54)).foregroundStyle(Theme.brand).padding(.top, 28)
            Text("Compartilhar sua localização").font(Theme.font(22, .bold)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.center)
            Text(Self.text).font(Theme.font(15)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            Text(demo ? "Na demonstração a posição é simulada: o app não lê o GPS e nada sai do aparelho."
                      : "O app só lê a localização enquanto está aberto, com a permissão \"Durante o uso do app\". Nunca em segundo plano.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            PrimaryButton(title: "Continuar", action: onContinue).accessibilityIdentifier("courier.disclosure.continue")
            Button("Agora não", action: onDecline).font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .frame(maxWidth: 560)
        .background(Theme.background.ignoresSafeArea())
        .interactiveDismissDisabled()
    }
}
