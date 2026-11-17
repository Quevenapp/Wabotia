import MapKit
import SwiftUI

/// Uma entrega: destino no mapa, rota pelo app de mapas, previsão, itens e pagamento, conversa com a loja e com o
/// cliente, e as ações (Iniciar rota, Entreguei, Não consegui entregar).
struct CourierDeliveryView: View {
    @ObservedObject var vm: CourierViewModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelivered = false
    @State private var cancelSheet = false

    var body: some View {
        Group {
            if let d = vm.deliveries[id] {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let store = vm.store(id) {
                            Label("\(store) · \(vm.grant(id)?.host ?? "")", systemImage: "building.2.fill")
                                .font(Theme.font(13, .semibold)).foregroundStyle(Theme.brand)
                                .accessibilityIdentifier("courier.detail.store")
                        }
                        if d.enRoute {
                            DeviceNotice(text: "Compartilhando sua localização com \(vm.store(id) ?? "a loja") e com o cliente — \(d.displayLabel). Mantenha o app aberto durante a entrega.",
                                         color: Theme.brand)
                                .accessibilityIdentifier("courier.sharing")
                        }
                        if let notice = vm.notice { DeviceNotice(text: notice) }
                        if let target = d.destination { CourierMap(destination: target, courier: d.enRoute ? vm.lastPoint?.coordinate : nil) }
                        destination(d)
                        conversation
                        order(d)
                        actions(d)
                    }
                    .padding(16)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            } else {
                // Saiu do aparelho (entregue, cancelada ou revogada): volta à lista.
                Color.clear.onAppear { dismiss() }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.deliveries[id]?.displayLabel ?? "Entrega")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Confirmar a entrega?", isPresented: $confirmDelivered, titleVisibility: .visible) {
            Button("Entreguei") { Task { await vm.delivered(id) } }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("A loja e o cliente são avisados, o compartilhamento da localização para e o acesso a esta entrega termina.")
        }
        .sheet(isPresented: $cancelSheet) {
            CourierCancelSheet { reason in
                cancelSheet = false
                Task { await vm.cancel(id, reason: reason) }
            } onClose: { cancelSheet = false }
        }
    }

    private func destination(_ d: CourierDelivery) -> some View {
        SectionCard(title: "Destino") {
            CardRow(icon: "person.fill", iconColor: Theme.brand, title: d.customerName ?? "Cliente",
                    subtitle: d.addressText?.replacingOccurrences(of: "\n", with: " · "))
            if let notice = vm.addressNotice(d.id) {
                // Sem cidade (ou não achado no mapa): o entregador confirma antes de sair procurando.
                CardRow(icon: "exclamationmark.triangle.fill", iconColor: Theme.warn, title: "Confira o endereço", subtitle: notice)
                    .accessibilityIdentifier("courier.addressNotice")
            }
            if let eta = d.etaText {
                CardRow(icon: "clock.fill", iconColor: Theme.ok, title: "Previsão: \(eta)", subtitle: d.arriving == true ? "O cliente foi avisado de que você está chegando" : "Calculada pelo Wabotia em linha reta")
            }
            Button { openRoute(d) } label: {
                CardRow(icon: "arrow.triangle.turn.up.right.diamond.fill", iconColor: Theme.ticket, title: "Abrir rota no Mapas", chevron: true, divider: false)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("courier.route")
        }
    }

    private var conversation: some View {
        SectionCard(title: "Conversar", footer: "As mensagens vão pelo Wabotia: o cliente recebe no WhatsApp da loja, sem ver o seu número.") {
            ForEach(CourierPeer.allCases) { peer in
                NavigationLink { CourierChatView(vm: vm, id: id, peer: peer) } label: {
                    CardRow(icon: peer == .store ? "building.2.fill" : "person.crop.circle.fill", iconColor: peer == .store ? Theme.warn : Theme.brand,
                            title: peer == .store ? "Falar com a loja" : "Falar com o cliente",
                            subtitle: peer == .customer && !vm.customerOpen(id) ? "Indisponível: o cliente não escreve há mais de 24 h" : vm.messages(id, peer).last?.text,
                            chevron: true, divider: peer == .store) {
                        if let n = vm.unread[vm.chatKey(id, peer)], n > 0 { CountBadge(count: n, color: Theme.accent) }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("courier.chat.\(peer.rawValue)")
            }
        }
    }

    @ViewBuilder
    private func order(_ d: CourierDelivery) -> some View {
        if d.order != nil {
            SectionCard(title: "Pedido") {
                ForEach(Array(d.items.enumerated()), id: \.offset) { _, item in
                    CardRow(icon: "bag.fill", iconColor: Theme.muted, title: item)
                }
                if let note = d.order?.customerNote, !note.isEmpty {
                    CardRow(icon: "text.bubble.fill", iconColor: Theme.ticket, title: "Observação do cliente", subtitle: note)
                }
                if let payment = d.paymentText { CardRow(icon: "banknote.fill", iconColor: Theme.ok, title: payment, divider: false) }
            }
        }
    }

    @ViewBuilder
    private func actions(_ d: CourierDelivery) -> some View {
        let busy = vm.busy.contains(id)
        VStack(spacing: 10) {
            if d.enRoute {
                PrimaryButton(title: "Entreguei", icon: "checkmark.circle.fill", busy: busy, color: Theme.ok) { confirmDelivered = true }
                    .accessibilityIdentifier("courier.delivered")
            } else {
                PrimaryButton(title: "Iniciar rota", icon: "location.fill", busy: busy) { vm.startRoute(id) }
                    .accessibilityIdentifier("courier.start")
                Text("Ao iniciar, o Wabotia avisa o cliente e passa a mostrar a previsão de chegada.")
                    .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            Button("Não consegui entregar") { cancelSheet = true }
                .font(Theme.font(15, .semibold)).foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
                .disabled(busy)
        }
    }

    /// A rota no app de mapas do sistema: pelas coordenadas, ou pelo endereço quando ainda não há destino no mapa.
    private func openRoute(_ d: CourierDelivery) {
        let options = [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving]
        if let target = d.destination {
            let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: target.lat, longitude: target.lng)))
            item.name = d.customerName ?? d.displayLabel
            item.openInMaps(launchOptions: options)
        } else if let address = d.addressText?.replacingOccurrences(of: "\n", with: ", "),
                  let query = address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                  let url = URL(string: "http://maps.apple.com/?daddr=\(query)&dirflg=d") {
            UIApplication.shared.open(url)
        }
    }
}

/// Destino e, durante a rota, a posição do entregador.
struct CourierMap: View {
    let destination: CourierCoordinate
    let courier: CourierCoordinate?
    @State private var region: MKCoordinateRegion

    init(destination: CourierCoordinate, courier: CourierCoordinate?) {
        self.destination = destination
        self.courier = courier
        _region = State(initialValue: MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: destination.lat, longitude: destination.lng),
                                                         span: MKCoordinateSpan(latitudeDelta: 0.04, longitudeDelta: 0.04)))
    }

    private struct Pin: Identifiable {
        let id: String
        let coordinate: CLLocationCoordinate2D
        let courier: Bool
    }

    private var pins: [Pin] {
        var list = [Pin(id: "destino", coordinate: CLLocationCoordinate2D(latitude: destination.lat, longitude: destination.lng), courier: false)]
        if let courier { list.append(Pin(id: "entregador", coordinate: CLLocationCoordinate2D(latitude: courier.lat, longitude: courier.lng), courier: true)) }
        return list
    }

    var body: some View {
        Map(coordinateRegion: $region, annotationItems: pins) { pin in
            MapAnnotation(coordinate: pin.coordinate) {
                Image(systemName: pin.courier ? "bicycle.circle.fill" : "mappin.circle.fill")
                    .font(.system(size: 30)).foregroundStyle(pin.courier ? Theme.brand : Theme.danger)
                    .background(Circle().fill(Color.white).padding(4))
                    .accessibilityLabel(pin.courier ? "Você" : "Destino")
            }
        }
        .frame(height: 220)
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }
}

/// "Não consegui entregar": o motivo vai à loja.
struct CourierCancelSheet: View {
    let onConfirm: (String) -> Void
    let onClose: () -> Void
    @State private var choice = "Cliente ausente"
    @State private var other = ""
    private let reasons = ["Cliente ausente", "Endereço não encontrado", "Cliente recusou o pedido", "Outro motivo"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Não consegui entregar", onClose: onClose)
            ForEach(reasons, id: \.self) { reason in
                Button { choice = reason } label: {
                    HStack {
                        Image(systemName: choice == reason ? "largecircle.fill.circle" : "circle").foregroundStyle(Theme.brand)
                        Text(reason).font(Theme.font(16)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                    }
                    .frame(minHeight: Theme.touch)
                }
                .buttonStyle(.plain)
            }
            if choice == "Outro motivo" {
                TextField("Conte o que aconteceu", text: $other)
                    .padding(12).background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            }
            PrimaryButton(title: "Avisar a loja", color: Theme.danger,
                          disabled: choice == "Outro motivo" && other.trimmingCharacters(in: .whitespaces).isEmpty) {
                onConfirm(choice == "Outro motivo" ? other.trimmingCharacters(in: .whitespaces) : choice)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
    }
}
