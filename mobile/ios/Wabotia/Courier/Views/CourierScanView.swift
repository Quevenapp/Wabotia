import AVFoundation
import SwiftUI
import UIKit

/// "Escanear pedido": a câmera lê o QR da comanda; sem câmera (ou sem permissão), o link ou o código pode ser colado ou
/// digitado. Na demonstração há um pedido fictício pronto para ler, para a revisão das lojas testar sem QR.
struct CourierScanView: View {
    @ObservedObject var vm: CourierViewModel
    let onClose: () -> Void
    @State private var manual = ""
    @State private var cameraProblem: String?
    @State private var handled = false

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Escanear pedido", subtitle: vm.demo ? "Demonstração" : nil, onClose: onClose).padding(.horizontal, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if vm.demo {
                        DeviceNotice(text: "Na demonstração não há QR de verdade: toque abaixo para ler um pedido fictício da Lanchonete Exemplo. Leia mais de um para ver várias entregas ao mesmo tempo.",
                                     color: Theme.warn)
                        PrimaryButton(title: "Ler o pedido de demonstração", icon: "qrcode", busy: vm.scanning) {
                            Task { await read("\(CourierScan.demoPrefix)\(vm.grants.count + 1)") }
                        }
                        .accessibilityIdentifier("courier.scanDemo")
                    } else {
                        ZStack {
                            if let cameraProblem {
                                Text(cameraProblem).font(Theme.font(14)).foregroundStyle(Color.white).multilineTextAlignment(.center).padding(20)
                            } else {
                                QRScannerView { text in Task { await read(text) } } onProblem: { cameraProblem = $0 }
                                RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.9), lineWidth: 3).frame(width: 220, height: 220)
                            }
                            if vm.scanning { ProgressView().tint(.white).scaleEffect(1.5) }
                        }
                        .frame(height: 320)
                        .frame(maxWidth: .infinity)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
                        Text("Aponte para o QR da comanda ou da tela da loja.").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                    }
                    if let error = vm.scanError { InlineError(text: error).accessibilityIdentifier("courier.scanError") }
                    AuthField(label: "Ou cole o link do pedido") {
                        TextField("https://…", text: $manual).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    SecondaryButton(title: "Usar este link", busy: vm.scanning, disabled: manual.trimmingCharacters(in: .whitespaces).isEmpty) {
                        Task { await read(manual) }
                    }
                    Text("Sem conta e sem senha: o pedido lido dá acesso só a esta entrega, e o acesso termina quando ela acaba.")
                        .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .onAppear { vm.scanError = nil; handled = false }
    }

    private func read(_ text: String) async {
        guard !handled, !vm.scanning else { return }
        handled = true
        let ok = await vm.scanned(text)
        if ok { onClose() } else { handled = false }
    }
}

/// A câmera traseira lendo QR (AVFoundation). Problemas (sem câmera, permissão negada) vão para `onProblem`.
struct QRScannerView: UIViewRepresentable {
    let onCode: (String) -> Void
    let onProblem: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        let coordinator = context.coordinator
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: coordinator.configure(view, onProblem: onProblem)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted { coordinator.configure(view, onProblem: onProblem) } else { onProblem(Self.denied) }
                }
            }
        default: DispatchQueue.main.async { onProblem(Self.denied) }
        }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) { coordinator.stop() }

    static let denied = "A câmera está desligada para o Wabotia. Permita em Ajustes → Wabotia → Câmera, ou cole o link do pedido abaixo."

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        private let onCode: (String) -> Void
        private var last: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func configure(_ view: PreviewView, onProblem: @escaping (String) -> Void) {
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
                onProblem("Este aparelho não tem câmera disponível. Cole o link do pedido abaixo.")
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { onProblem("Não foi possível usar a câmera. Cole o link do pedido abaixo."); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            view.preview.session = session
            view.preview.videoGravity = .resizeAspectFill
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }

        func stop() {
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, code != last else { return }
            last = code
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode(code)
            // O mesmo QR pode ser lido de novo depois de 3 s (código recusado e corrigido na loja).
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.last = nil }
        }
    }
}
