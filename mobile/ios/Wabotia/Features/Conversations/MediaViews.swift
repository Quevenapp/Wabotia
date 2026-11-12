import SwiftUI
import AVKit
import AVFoundation
import QuickLook
import UIKit

/// Item para `.sheet(item:)`/`.fullScreenCover(item:)` com um arquivo local.
struct LocalFileItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// Imagem privada (exige Authorization): miniatura via MediaLoader; toque abre o visualizador com zoom e compartilhar.
struct AuthenticatedImageView: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    var width: CGFloat = 240
    @State private var image: UIImage?
    @State private var failed = false
    @State private var showViewer = false

    private var height: CGFloat {
        guard let image, image.size.width > 0 else { return width * 0.7 }
        return min(max(width * image.size.height / image.size.width, 90), 300)
    }

    var body: some View {
        Group {
            if let image {
                Button { showViewer = true } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: width, height: height)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Foto. Abrir em tela cheia")
                .fullScreenCover(isPresented: $showViewer) { ImageViewerView(file: file, profileId: profileId, image: image) }
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.black.opacity(0.08))
                    if failed {
                        VStack(spacing: 6) {
                            Image(systemName: "photo").font(.system(size: 24))
                            Text("Imagem indisponível").font(Theme.font(12))
                        }
                        .foregroundStyle(Theme.textSecondary)
                    } else {
                        ProgressView()
                    }
                }
                .frame(width: width, height: width * 0.7)
            }
        }
        .task(id: file.id) {
            guard image == nil else { return }
            do {
                let data = try await MediaLoader.shared.data(mediaId: file.id, profileId: profileId, api: container.api)
                if let ui = UIImage(data: data) { image = ui } else { failed = true }
            } catch { failed = true }
        }
    }
}

/// Visualizador em tela cheia com zoom (pinça) e compartilhar.
struct ImageViewerView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    let file: MediaFile
    let profileId: String
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var shareURL: URL?

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            GeometryReader { geo in
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(
                        MagnificationGesture()
                            .onChanged { value in scale = max(1, min(6, lastScale * value)) }
                            .onEnded { _ in lastScale = scale; if scale <= 1 { offset = .zero; lastOffset = .zero } }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                guard scale > 1 else { return }
                                offset = CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height)
                            }
                            .onEnded { _ in lastOffset = offset }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation { if scale > 1 { scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero } else { scale = 2.5; lastScale = 2.5 } }
                    }
            }
            .ignoresSafeArea()
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.white)
                        .frame(width: Theme.touch, height: Theme.touch).background(Circle().fill(Color.white.opacity(0.18)))
                }
                .accessibilityLabel("Fechar")
                Spacer()
                if let shareURL {
                    AppShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.white)
                            .frame(width: Theme.touch, height: Theme.touch).background(Circle().fill(Color.white.opacity(0.18)))
                    }
                    .accessibilityLabel("Compartilhar")
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
        }
        .task {
            shareURL = try? await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: container.api)
        }
    }
}

/// Cartão de vídeo com botão de play: abre um player autenticado (AVURLAsset com cabeçalho Authorization).
struct VideoAttachmentView: View {
    let file: MediaFile
    let profileId: String
    var width: CGFloat = 240
    @State private var show = false

    var body: some View {
        Button { show = true } label: {
            ZStack {
                LinearGradient(colors: [Color(light: 0x34454E, dark: 0x1B262C), Color(light: 0x111B21, dark: 0x0B141A)], startPoint: .top, endPoint: .bottom)
                Image(systemName: "play.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Color.white)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(Color.black.opacity(0.45)))
                VStack {
                    Spacer()
                    HStack(spacing: 4) {
                        Image(systemName: "video.fill").font(.system(size: 10))
                        Text(file.size > 0 ? file.sizeLabel : "Vídeo").font(Theme.font(11, .medium))
                        Spacer()
                    }
                    .foregroundStyle(Color.white.opacity(0.9))
                    .padding(8)
                }
            }
            .frame(width: width, height: width * 0.62)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Vídeo. Reproduzir")
        .sheet(isPresented: $show) { VideoPlayerSheet(file: file, profileId: profileId) }
    }
}

struct VideoPlayerSheet: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    let file: MediaFile
    let profileId: String
    @State private var player: AVPlayer?
    @State private var shareURL: URL?

    var body: some View {
        AppNavigationStack {
            Group {
                if let player {
                    VideoPlayer(player: player).ignoresSafeArea(edges: .bottom)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fechar") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if let shareURL { AppShareLink(item: shareURL) { Image(systemName: "square.and.arrow.up") } }
                }
            }
            .onAppear {
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                let p = AVPlayer(playerItem: AVPlayerItem(asset: AuthenticatedAsset.make(file: file, profileId: profileId, api: container.api)))
                player = p
                p.play()
            }
            .onDisappear { player?.pause(); player = nil }
            .task { shareURL = try? await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: container.api) }
        }
    }
}

enum AuthenticatedAsset {
    /// AVURLAsset que envia o cabeçalho Authorization (players não aceitam URLRequest).
    static func make(file: MediaFile, profileId: String, api: APIClient) -> AVURLAsset {
        let url = api.mediaURL(profileId: profileId, mediaId: file.id, inline: true)
        return AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": api.authorizationHeaders])
    }
}

/// Player de áudio/voz embutido na bolha: play, onda com progresso, duração e velocidade.
struct AudioPlayerView: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    let isVoice: Bool
    var outgoing = false
    var width: CGFloat = 230
    @StateObject private var model = AudioPlayerModel()

    /// Alturas fixas da onda, derivadas do id (a mesma mensagem sempre tem o mesmo desenho).
    private var bars: [CGFloat] {
        var seed: UInt32 = 2166136261
        for byte in file.id.utf8 { seed = (seed ^ UInt32(byte)) &* 16777619 }
        return (0..<28).map { _ in
            seed = seed &* 1664525 &+ 1013904223
            return 0.25 + 0.75 * CGFloat((seed >> 16) & 0xFF) / 255
        }
    }

    var body: some View {
        let tint = isVoice ? (outgoing ? Theme.brand : Theme.accent) : Theme.textSecondary
        HStack(spacing: 8) {
            Button {
                if model.player == nil {
                    model.prepare(asset: AuthenticatedAsset.make(file: file, profileId: profileId, api: container.api))
                }
                model.toggle()
            } label: {
                Image(systemName: model.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.onBrand)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(tint))
                    .frame(width: 40, height: Theme.touch)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.playing ? "Pausar áudio" : "Reproduzir áudio")
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 2) {
                    ForEach(Array(bars.enumerated()), id: \.offset) { index, level in
                        Capsule()
                            .fill(Double(index) / Double(bars.count) < model.progress ? tint : Theme.muted.opacity(0.5))
                            .frame(width: 2.5, height: 4 + 18 * level)
                    }
                }
                .frame(height: 24)
                HStack(spacing: 6) {
                    Image(systemName: isVoice ? "mic.fill" : "music.note").font(.system(size: 9)).foregroundStyle(tint)
                    Text(model.started ? model.timeLabel : (file.size > 0 ? file.sizeLabel : (isVoice ? "Mensagem de voz" : "Áudio")))
                        .font(Theme.font(11)).monospacedDigit().foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            Button { model.cycleRate() } label: {
                Text(model.rateLabel)
                    .font(Theme.font(11, .bold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 34, height: 22)
                    .background(Capsule().fill(Color.black.opacity(0.08)))
                    .frame(height: Theme.touch)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Velocidade \(model.rateLabel)")
        }
        .frame(width: width, alignment: .leading)
        .onDisappear { model.stop() }
    }
}

@MainActor
final class AudioPlayerModel: ObservableObject {
    @Published var playing = false
    @Published var started = false
    @Published var progress: Double = 0
    @Published var timeLabel = "0:00"
    @Published private(set) var rate: Float = 1
    private(set) var player: AVPlayer?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?

    var rateLabel: String { rate == 1 ? "1x" : (rate == 1.5 ? "1,5x" : "2x") }

    func prepare(asset: AVURLAsset) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        let item = AVPlayerItem(asset: asset)
        let p = AVPlayer(playerItem: item)
        player = p
        observer = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            let current = time.seconds
            Task { @MainActor in
                guard let self, let item = self.player?.currentItem else { return }
                let total = item.duration.seconds
                if total.isFinite, total > 0 {
                    self.progress = max(0, min(1, current / total))
                    self.timeLabel = "\(VoiceRecorder.format(current)) / \(VoiceRecorder.format(total))"
                } else {
                    self.timeLabel = VoiceRecorder.format(current)
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.playing = false
                self?.progress = 0
                self?.player?.seek(to: .zero)
            }
        }
    }

    func toggle() {
        guard let player else { return }
        started = true
        if playing { player.pause(); playing = false } else { player.playImmediately(atRate: rate); playing = true }
    }

    /// 1x → 1,5x → 2x → 1x.
    func cycleRate() {
        rate = rate == 1 ? 1.5 : (rate == 1.5 ? 2 : 1)
        if playing { player?.rate = rate }
    }

    func stop() {
        player?.pause()
        if let observer, let player { player.removeTimeObserver(observer) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        observer = nil
        endObserver = nil
        player = nil
        playing = false
    }
}

/// Documento: ícone por tipo, nome, tamanho e baixar; toque abre (QuickLook) e depois oferece compartilhar.
struct DocumentAttachmentView: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    var width: CGFloat = 240
    @State private var downloading = false
    @State private var localURL: URL?
    @State private var preview: LocalFileItem?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Button { Task { await open() } } label: {
                    HStack(spacing: 10) {
                        VStack(spacing: 0) {
                            Image(systemName: style.icon).font(.system(size: 17, weight: .semibold))
                            Text(style.tag).font(.system(size: 8, weight: .heavy))
                        }
                        .foregroundStyle(Theme.onBrand)
                        .frame(width: 38, height: 44)
                        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(style.color))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.name.isEmpty ? "Documento" : file.name)
                                .font(Theme.font(14, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                            Text(file.size > 0 ? file.sizeLabel : "Toque para baixar").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Documento \(file.name). Abrir")
                if downloading {
                    ProgressView().frame(width: 32, height: 32)
                } else if let localURL {
                    AppShareLink(item: localURL) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.brand).frame(width: 32, height: Theme.touch)
                    }
                    .accessibilityLabel("Compartilhar documento")
                } else {
                    Button { Task { await open() } } label: {
                        Image(systemName: "arrow.down.circle").font(.system(size: 22)).foregroundStyle(Theme.textSecondary).frame(width: 32, height: Theme.touch)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Baixar documento")
                }
            }
            .padding(7)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.black.opacity(0.05)))
            if let error { Text(error).font(Theme.font(11)).foregroundStyle(Theme.danger) }
        }
        .frame(width: width, alignment: .leading)
        .sheet(item: $preview) { item in QuickLookPreview(url: item.url).ignoresSafeArea() }
    }

    private var style: (icon: String, tag: String, color: Color) {
        let m = file.mimeBase
        let ext = (file.name as NSString).pathExtension.uppercased()
        if m == "application/pdf" { return ("doc.richtext.fill", "PDF", Theme.danger) }
        if m.contains("spreadsheet") || m.contains("excel") || m == "text/csv" { return ("tablecells.fill", ext.isEmpty ? "XLS" : String(ext.prefix(4)), Theme.ok) }
        if m.contains("presentation") || m.contains("powerpoint") { return ("rectangle.on.rectangle", ext.isEmpty ? "PPT" : String(ext.prefix(4)), Theme.warn) }
        if m.contains("word") || m.hasPrefix("text/") { return ("doc.text.fill", ext.isEmpty ? "DOC" : String(ext.prefix(4)), Theme.ticket) }
        if m.contains("zip") || m.contains("compressed") { return ("doc.zipper", ext.isEmpty ? "ZIP" : String(ext.prefix(4)), Theme.muted) }
        return ("doc.fill", ext.isEmpty ? "ARQ" : String(ext.prefix(4)), Theme.muted)
    }

    private func open() async {
        error = nil
        if localURL == nil {
            downloading = true
            do { localURL = try await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: container.api) }
            catch { self.error = APIError.describe(error) }
            downloading = false
        }
        if let localURL { preview = LocalFileItem(url: localURL) }
    }
}

/// QLPreviewController embrulhado para abrir documentos baixados.
struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ uiViewController: UINavigationController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// Decide a visualização de um anexo pelo tipo MIME.
struct AttachmentView: View {
    let file: MediaFile
    let profileId: String
    var isVoiceMessage = false
    var outgoing = false
    var width: CGFloat = 240

    var body: some View {
        if file.isImage { AuthenticatedImageView(file: file, profileId: profileId, width: width) }
        else if file.isVideo { VideoAttachmentView(file: file, profileId: profileId, width: width) }
        else if file.isAudio { AudioPlayerView(file: file, profileId: profileId, isVoice: isVoiceMessage || file.mimeBase == "audio/ogg", outgoing: outgoing, width: min(width, 240)) }
        else { DocumentAttachmentView(file: file, profileId: profileId, width: width) }
    }
}
