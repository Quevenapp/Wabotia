import SwiftUI
import UIKit
import AVFoundation

/// Câmera para a foto de um item do checklist (só foto, sem galeria: a foto tem de ser tirada na hora).
struct WorkCameraPicker: UIViewControllerRepresentable {
    var onPicked: (UIImage) -> Void
    var onDone: () -> Void

    /// Sem câmera (simulador) ou acesso negado nos Ajustes: o item com foto não pode ser marcado pelo app.
    static var canUse: Bool {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return false }
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        return status != .denied && status != .restricted
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked, onDone: onDone) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPicked: (UIImage) -> Void
        let onDone: () -> Void
        init(onPicked: @escaping (UIImage) -> Void, onDone: @escaping () -> Void) {
            self.onPicked = onPicked
            self.onDone = onDone
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = (info[.editedImage] ?? info[.originalImage]) as? UIImage { onPicked(image) }
            onDone()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone() }
    }
}

/// A foto pronta para enviar: JPEG com o lado maior até 1600 px, qualidade 0,8 (menos, se passar de 10 MB).
enum WorkPhoto {
    static let maxSide: CGFloat = 1600
    static let maxBytes = 10 * 1024 * 1024

    static func targetSize(_ size: CGSize, maxSide: CGFloat = maxSide) -> CGSize {
        let longest = max(size.width, size.height)
        guard longest > maxSide, longest > 0 else { return CGSize(width: size.width.rounded(), height: size.height.rounded()) }
        let scale = maxSide / longest
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    static func jpeg(_ image: UIImage) -> Data? {
        let target = targetSize(image.size)
        guard target.width > 0, target.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        for quality in [0.8, 0.6, 0.4] as [CGFloat] {
            if let data = resized.jpegData(compressionQuality: quality), data.count < maxBytes { return data }
        }
        return nil
    }
}
