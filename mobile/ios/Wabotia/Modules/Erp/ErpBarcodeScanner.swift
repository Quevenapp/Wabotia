import AVFoundation
import SwiftUI
import UIKit

/// Leitura do código de barras pela câmera, com o leitor do próprio sistema (AVFoundation, sem dependência nova):
/// EAN-13, EAN-8, UPC-E, Code 128, Code 39, ITF-14 e QR. A folha fecha no primeiro código lido.
struct ErpBarcodeSheet: View {
    let onCode: (String) -> Void
    let onClose: () -> Void
    @State private var problem: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Ler código de barras", subtitle: "Aponte a câmera para o código do produto", onClose: onClose)
            ZStack {
                if let problem {
                    EmptyStateView(title: "Câmera indisponível", systemImage: "camera.fill", message: problem)
                } else {
                    ErpBarcodeCamera(onCode: onCode, onProblem: { problem = $0 })
                        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12).stroke(Theme.accent, lineWidth: 3).frame(height: 140).padding(.horizontal, 32)
                        )
                        .padding(16)
                        .accessibilityLabel("Visor da câmera para o código de barras")
                }
            }
            .frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
    }
}

/// O visor da câmera; `onProblem` diz por que não abriu (sem permissão ou sem câmera).
struct ErpBarcodeCamera: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onProblem: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onProblem = onProblem
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        var onProblem: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: configure()
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async { granted ? self.configure() : self.onProblem?(ErpText.cameraDenied) }
                }
            default: onProblem?(ErpText.cameraDenied)
            }
        }

        private func configure() {
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
                onProblem?(ErpText.noCamera)
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { onProblem?(ErpText.noCamera); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            let wanted: [AVMetadataObject.ObjectType] = [.ean13, .ean8, .upce, .code128, .code39, .itf14, .qr]
            output.metadataObjectTypes = wanted.filter { output.availableMetadataObjectTypes.contains($0) }
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if session.isRunning { DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() } }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !delivered, let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, let value = ErpText.barcode(code) else { return }
            delivered = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if session.isRunning { DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() } }
            onCode?(value)
        }
    }
}
