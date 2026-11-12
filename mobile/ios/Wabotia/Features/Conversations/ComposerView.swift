import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

/// Composer da conversa: "+" (anexos), campo arredondado multilinha com câmera, e botão redondo que é
/// microfone com o campo vazio e enviar com texto. Mantém voz com prévia, localização, contato, nota interna,
/// tipo automático/documento, progresso de upload e pedido pendente com a mesma Idempotency-Key.
struct ComposerView: View {
    @ObservedObject var vm: ConversationViewModel
    var onMenu: () -> Void
    var onTicket: () -> Void

    @ObservedObject private var workspace = Workspace.shared
    @StateObject private var recorder = VoiceRecorder()
    @State private var showAttach = false
    @State private var pendingPick: AttachOption?
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var fileTypes: [UTType] = [.item]
    @State private var showLocation = false
    @State private var showContactChoice = false
    @State private var showContactPicker = false
    @State private var showManualContact = false
    @State private var importing = false
    @State private var localError: String?
    @State private var noteMode = false
    @State private var sendAfterRecording = false
    @State private var levels: [CGFloat] = []
    @FocusState private var focused: Bool

    private var draftEmpty: Bool { vm.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasMedia: Bool { !vm.attachments.isEmpty || vm.voice != nil }
    private var showsMic: Bool {
        vm.can("voice") && draftEmpty && vm.attachments.isEmpty && vm.voice == nil && vm.location == nil && vm.contactDraft == nil && vm.editing == nil && vm.pending == nil && !noteMode
    }

    var body: some View {
        VStack(spacing: 6) {
            if let error = vm.actionError ?? localError ?? recorder.error {
                banner(text: error, color: Theme.danger, icon: "exclamationmark.triangle.fill") { vm.actionError = nil; localError = nil; recorder.error = nil }
            }
            if let info = vm.info {
                banner(text: info, color: Theme.textSecondary, icon: "info.circle.fill") { vm.info = nil }
            }
            if let pending = vm.pending { pendingBanner(pending) }
            if vm.window?.isClosed == true, !noteMode {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: "lock.fill").font(.system(size: 11, weight: .semibold)).padding(.top, 2)
                    Text("Fora da janela de 24h. A mensagem fica na fila até o cliente escrever.").font(Theme.font(12, .medium)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.muted.opacity(0.16)))
            }
            if noteMode {
                strip(icon: "lock.fill", color: Theme.noteText, title: "Nota interna", text: "Só a equipe vê. O cliente não recebe.") { noteMode = false }
            }
            if let q = vm.quote {
                strip(icon: "arrowshape.turn.up.left.fill", color: Theme.brand, title: "Respondendo a \(vm.authorLabel(q))", text: q.text.isEmpty ? "Anexo" : q.text) { vm.quote = nil }
            }
            if vm.editing != nil {
                strip(icon: "pencil", color: Theme.warn, title: "Editando mensagem", text: "Até 15 min após o envio.") { vm.cancelEdit() }
            }
            if !vm.attachments.isEmpty { attachmentsStrip }
            if let v = vm.voice { voiceStrip(v) }
            if let l = vm.location {
                strip(icon: "mappin.circle.fill", color: Theme.ok, title: l.name.isEmpty ? "Localização" : l.name, text: l.address.isEmpty ? String(format: "%.5f, %.5f", l.latitude, l.longitude) : l.address) { vm.location = nil }
            }
            if let c = vm.contactDraft {
                strip(icon: "person.crop.circle.fill", color: Theme.tickRead, title: c.name, text: ConversationFormatting.phone(c.phone)) { vm.contactDraft = nil }
            }
            if recorder.isRecording || recorder.processing { recordingBar } else { inputRow }
            if let p = vm.progress { progressLine(p) }
            if importing { progressLine("Preparando arquivos…") }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .background(Theme.bar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ThinDivider() }
        .sheet(isPresented: $showAttach, onDismiss: runPendingPick) {
            AttachSheet(options: attachOptions) { option in
                pendingPick = option
                showAttach = false
            }
        }
        .sheet(isPresented: $showPhotos) {
            PhotoLibraryPicker(limit: max(1, 10 - vm.attachments.count)) { items in
                showPhotos = false
                guard !items.isEmpty else { return }
                importing = true
                Task {
                    for item in items where vm.attachments.count < 10 {
                        if let a = await AttachmentFactory.from(photoResult: item) { vm.addAttachment(a) }
                    }
                    importing = false
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: fileTypes, allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                for url in urls where vm.attachments.count < 10 {
                    if let a = AttachmentFactory.from(fileURL: url) { vm.addAttachment(a) }
                    else { localError = "Não foi possível ler \(url.lastPathComponent)." }
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(onPicked: { a in vm.addAttachment(a) }, onDone: { showCamera = false })
                .ignoresSafeArea()
        }
        // Localização/contato e arquivos são excludentes (o servidor rejeita anexo com type location/contacts).
        .sheet(isPresented: $showLocation) { LocationSheet { vm.setLocation($0) } }
        .sheet(isPresented: $showContactPicker) {
            ContactPickerView(onPicked: { vm.setContactDraft($0) }, onDone: { showContactPicker = false })
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showManualContact) { ManualContactSheet(initial: vm.contactDraft) { vm.setContactDraft($0) } }
        .confirmationDialog("Compartilhar contato", isPresented: $showContactChoice, titleVisibility: .visible) {
            Button("Dos meus contatos") { showContactPicker = true }
            Button("Digitar nome e telefone") { showManualContact = true }
            Button("Cancelar", role: .cancel) {}
        } message: { if hasMedia { Text("Os anexos escolhidos serão removidos: contato é enviado sem arquivos.") } }
        .onChange(of: recorder.duration) { _ in
            guard recorder.isRecording else { return }
            levels.append(CGFloat(recorder.level))
            if levels.count > 60 { levels.removeFirst(levels.count - 60) }
        }
        .onChange(of: vm.editing) { editing in if editing != nil { noteMode = false; focused = true } }
        .onChange(of: vm.quote) { quote in if quote != nil { focused = true } }
        #if DEBUG
        .onAppear {
            switch DemoMode.takeSheet("attach", "note", "recording") {
            case "attach": showAttach = true
            case "note": noteMode = true; vm.draft = "Cliente prefere contato por telefone depois das 18h."
            case "recording": levels = (0..<34).map { CGFloat(0.25 + 0.7 * abs(sin(Double($0) * 0.9))) }; demoRecording = true
            default: break
            }
        }
        #endif
    }

    #if DEBUG
    @State private var demoRecording = false
    #else
    private let demoRecording = false
    #endif

    // MARK: Linha principal

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if demoRecording { recordingBar } else {
                Button {
                    focused = false
                    showAttach = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 21, weight: .medium))
                        .foregroundStyle(Theme.brand)
                        .frame(width: 38, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(vm.composerLocked || vm.editing != nil)
                .opacity(vm.composerLocked || vm.editing != nil ? 0.4 : 1)
                .accessibilityLabel("Anexar")

                HStack(alignment: .bottom, spacing: 0) {
                    field
                    if draftEmpty, vm.editing == nil, !noteMode, vm.allows("image") {
                        Button {
                            focused = false
                            if CameraPicker.isAvailable { showCamera = true } else { localError = "Este aparelho não tem câmera disponível." }
                        } label: {
                            Image(systemName: "camera")
                                .font(.system(size: 18))
                                .foregroundStyle(Theme.textSecondary)
                                .frame(width: 40, height: 40)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.composerLocked)
                        .accessibilityLabel("Câmera")
                    }
                }
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(noteMode ? Theme.bubbleNote : Theme.field))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.divider, lineWidth: 1))

                actionButton
            }
        }
    }

    @ViewBuilder private var field: some View {
        let placeholder = vm.editing != nil ? "Novo texto da mensagem" : (noteMode ? "Escreva a nota interna" : "Mensagem")
        if #available(iOS 16, *) {
            AppMultilineField(placeholder, text: $vm.draft, lines: 1...5, font: Theme.font(16))
                .focused($focused)
                .disabled(vm.composerLocked)
                .padding(.leading, 14)
                .padding(.trailing, 6)
                .padding(.vertical, 9)
                .frame(minHeight: 40)
        } else {
            AppMultilineField(placeholder, text: $vm.draft, lines: 1...5, font: Theme.font(16))
                .focused($focused)
                .disabled(vm.composerLocked)
                .padding(.leading, 9)
                .padding(.trailing, 2)
                .padding(.vertical, 1)
                .frame(minHeight: 40)
        }
    }

    @ViewBuilder private var actionButton: some View {
        if vm.busy {
            ProgressView().frame(width: 40, height: 40)
        } else if showsMic {
            roundButton("mic.fill", color: Theme.brand, label: "Gravar mensagem de voz") {
                focused = false
                levels = []
                sendAfterRecording = false
                Haptics.medium()
                Task {
                    await recorder.start { result in
                        Haptics.light()
                        guard let result else { return }
                        vm.setVoice(result)
                        if sendAfterRecording { vm.send() }
                    }
                }
            }
        } else if noteMode {
            roundButton("lock.fill", color: Theme.noteText, label: "Salvar nota interna", disabled: draftEmpty) {
                Task { if await vm.sendNote() { noteMode = false } }
            }
        } else {
            roundButton(vm.editing != nil ? "checkmark" : "paperplane.fill", color: Theme.brand, label: vm.pending != nil ? "Tentar novamente" : (vm.editing != nil ? "Salvar edição" : "Enviar"), disabled: !vm.canSend) {
                vm.send()
            }
        }
    }

    private func roundButton(_ icon: String, color: Color, label: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.onBrand)
                .frame(width: 40, height: 40)
                .background(Circle().fill(color))
                .opacity(disabled ? 0.4 : 1)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(disabled)
        .accessibilityLabel(label)
    }

    // MARK: Anexos

    private var attachOptions: [AttachOption] {
        var list: [AttachOption] = []
        if vm.allows("image") || vm.allows("video") { list += [.gallery, .camera] }
        if vm.allows("document") { list.append(.document) }
        if vm.allows("audio") { list.append(.audio) }
        if vm.can("location") { list.append(.location) }
        if vm.can("contacts") { list.append(.contact) }
        list += [.menu, .ticket, .note]
        return list
    }

    private func runPendingPick() {
        guard let pick = pendingPick else { return }
        pendingPick = nil
        switch pick {
        case .gallery: showPhotos = true
        case .camera:
            if CameraPicker.isAvailable { showCamera = true } else { localError = "Este aparelho não tem câmera disponível." }
        case .document: fileTypes = [.item]; showFiles = true
        case .audio: fileTypes = [.audio]; showFiles = true
        case .location: showLocation = true
        case .contact: showContactChoice = true
        case .menu: onMenu()
        case .ticket: onTicket()
        case .note: noteMode = true; focused = true
        }
    }

    // MARK: Gravação

    private var recordingBar: some View {
        HStack(spacing: 8) {
            if recorder.processing {
                ProgressView()
                Text("Preparando áudio…").font(Theme.font(14)).foregroundStyle(Theme.textSecondary)
                Spacer()
            } else {
                Button { Task { await recorder.cancel() } } label: {
                    Image(systemName: "trash").font(.system(size: 18)).foregroundStyle(Theme.danger).frame(width: 40, height: 40).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("Descartar gravação")
                HStack(spacing: 6) {
                    Circle().fill(Theme.danger).frame(width: 9, height: 9).opacity(0.45 + 0.55 * Double(recorder.level))
                    Text(VoiceRecorder.format(demoRecording ? 7 : recorder.duration)).font(Theme.font(15, .semibold)).monospacedDigit().foregroundStyle(Theme.danger)
                    HStack(alignment: .center, spacing: 2) {
                        ForEach(Array(levels.suffix(34).enumerated()), id: \.offset) { _, level in
                            Capsule().fill(Theme.textSecondary).frame(width: 2.5, height: 3 + 20 * level)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 26, alignment: .trailing)
                    .clipped()
                }
                .padding(.horizontal, 12)
                .frame(height: 40)
                .background(Capsule().fill(Theme.field))
                Button { sendAfterRecording = false; Task { await recorder.stop() } } label: {
                    Image(systemName: "stop.fill").font(.system(size: 14)).foregroundStyle(Theme.danger)
                        .frame(width: 36, height: 36).background(Circle().fill(Theme.danger.opacity(0.14)))
                }
                .buttonStyle(.plain).accessibilityLabel("Parar e ouvir antes de enviar")
                roundButton("paperplane.fill", color: Theme.brand, label: "Enviar mensagem de voz") {
                    sendAfterRecording = true
                    Task { await recorder.stop() }
                }
            }
        }
        .frame(minHeight: 40)
    }

    private func voiceStrip(_ v: VoiceRecording) -> some View {
        HStack(spacing: 10) {
            LocalAudioPreview(url: v.url)
            VStack(alignment: .leading, spacing: 1) {
                Text(v.isVoice ? "Mensagem de voz" : "Áudio (M4A)").font(Theme.font(14, .semibold)).foregroundStyle(Theme.textPrimary)
                Text("\(VoiceRecorder.format(v.duration)) · \(ConversationFormatting.bytes(v.size))" + (v.isVoice ? "" : " · enviado como áudio comum"))
                    .font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            closeButton("Descartar áudio") { vm.discardVoice() }.disabled(vm.composerLocked)
        }
        .padding(.leading, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.field))
    }

    // MARK: Faixas auxiliares

    private var attachmentsStrip: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vm.attachments) { a in
                        ZStack(alignment: .topTrailing) {
                            VStack(spacing: 2) {
                                if let t = a.thumbnail {
                                    Image(uiImage: t).resizable().scaledToFill().frame(width: 62, height: 62).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                } else {
                                    Image(systemName: a.kind == "video" ? "video.fill" : (a.kind == "audio" ? "waveform" : "doc.fill"))
                                        .font(.system(size: 22)).foregroundStyle(Theme.textSecondary)
                                        .frame(width: 62, height: 62)
                                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.field))
                                }
                                Text(a.name).font(Theme.font(10)).foregroundStyle(Theme.textPrimary).lineLimit(1).frame(width: 66)
                                Text(a.sizeLabel).font(Theme.font(10)).foregroundStyle(Theme.textSecondary)
                            }
                            Button { vm.attachments.removeAll { $0.id == a.id } } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(Color.white, Color.black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .offset(x: 5, y: -5)
                            .disabled(vm.composerLocked)
                            .accessibilityLabel("Remover \(a.name)")
                        }
                    }
                }
                .padding(.vertical, 5)
                .padding(.horizontal, 2)
            }
            HStack(spacing: 6) {
                Button { vm.sendKind = vm.sendKind == .document ? .auto : .document } label: {
                    Pill(text: vm.sendKind == .document ? "Enviar como documento" : "Tipo automático", color: Theme.brand, icon: vm.sendKind == .document ? "doc.fill" : "wand.and.stars")
                }
                .buttonStyle(.plain)
                .accessibilityHint("Alterna entre tipo automático e enviar como documento")
                Text("Foto até 5 MB · vídeo e áudio até 16 MB").font(Theme.font(11)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
        }
    }

    private func strip(icon: String, color: Color, title: String, text: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            color.frame(width: 3).clipShape(Capsule())
            Image(systemName: icon).font(.system(size: 13, weight: .semibold)).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Theme.font(13, .semibold)).foregroundStyle(color).lineLimit(1)
                Text(text).font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            closeButton("Remover", action: remove).disabled(vm.composerLocked)
        }
        .padding(.leading, 8)
        .frame(minHeight: 44)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.field))
    }

    private func closeButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSecondary)
                .frame(width: 24, height: 24).background(Circle().fill(Theme.muted.opacity(0.2)))
                .frame(width: 40, height: 40).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func progressLine(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().scaleEffect(0.8)
            Text(text).font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
    }

    private func pendingBanner(_ p: PendingRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Envio sem confirmação (\(p.summary)).", systemImage: "clock.arrow.circlepath").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textPrimary)
            Text("Tentar de novo reutiliza o mesmo pedido: nada é enviado em dobro.").font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
            HStack(spacing: 14) {
                Button("Tentar de novo") { vm.send() }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand).disabled(vm.busy)
                Button("Abandonar pedido") { vm.abandonPending() }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.danger).disabled(vm.busy)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.warn.opacity(0.14)))
    }

    private func banner(text: String, color: Color, icon: String, dismiss: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.system(size: 13)).foregroundStyle(color).padding(.top, 2)
            Text(text).font(Theme.font(13)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSecondary).frame(width: 28, height: 28) }
                .buttonStyle(.plain)
                .accessibilityLabel("Dispensar aviso")
        }
        .padding(.leading, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.12)))
    }
}

// MARK: - Folha "+"

enum AttachOption: String, Identifiable {
    case gallery, camera, document, audio, location, contact, menu, ticket, note
    var id: String { rawValue }

    var title: String {
        switch self {
        case .gallery: return "Galeria"
        case .camera: return "Câmera"
        case .document: return "Documento"
        case .audio: return "Áudio"
        case .location: return "Localização"
        case .contact: return "Contato"
        case .menu: return "Menu"
        case .ticket: return "Protocolo"
        case .note: return "Nota interna"
        }
    }
    var icon: String {
        switch self {
        case .gallery: return "photo.fill.on.rectangle.fill"
        case .camera: return "camera.fill"
        case .document: return "doc.fill"
        case .audio: return "headphones"
        case .location: return "mappin.and.ellipse"
        case .contact: return "person.fill"
        case .menu: return "list.bullet"
        case .ticket: return "doc.text.fill"
        case .note: return "lock.fill"
        }
    }
    var color: Color {
        switch self {
        case .gallery: return Theme.bot
        case .camera: return Theme.danger
        case .document: return Theme.tickRead
        case .audio: return Theme.warn
        case .location: return Theme.ok
        case .contact: return Theme.muted
        case .menu: return Theme.brand
        case .ticket: return Theme.ticket
        case .note: return Theme.noteText
        }
    }
}

/// Grade de ícones redondos coloridos. Itens sem capacidade na linha não entram em `options`.
struct AttachSheet: View {
    let options: [AttachOption]
    var onPick: (AttachOption) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 4) {
            SheetHeader(title: "Enviar") { dismiss() }
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 14) {
                    ForEach(options) { option in
                        Button { onPick(option) } label: {
                            VStack(spacing: 6) {
                                Image(systemName: option.icon)
                                    .font(.system(size: 21, weight: .medium))
                                    .foregroundStyle(Theme.onBrand)
                                    .frame(width: 54, height: 54)
                                    .background(Circle().fill(option.color))
                                Text(option.title).font(Theme.font(12, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressScaleStyle())
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .appSheetDetents()
    }
}

/// Reproduz a gravação local antes de enviar.
struct LocalAudioPreview: View {
    let url: URL
    @StateObject private var model = LocalAudioModel()

    var body: some View {
        Button {
            model.toggle(url: url)
        } label: {
            Image(systemName: model.playing ? "pause.fill" : "play.fill")
                .font(.system(size: 14)).foregroundStyle(Theme.onBrand)
                .frame(width: 34, height: 34).background(Circle().fill(Theme.brand))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.playing ? "Pausar prévia" : "Ouvir prévia")
        .onDisappear { model.stop() }
    }
}

@MainActor
final class LocalAudioModel: NSObject, ObservableObject {
    @Published var playing = false
    private var player: AVAudioPlayer?
    private var monitor: Task<Void, Never>?

    func toggle(url: URL) {
        if playing { stop(); return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        guard let p = try? AVAudioPlayer(contentsOf: url) else { return }
        player = p
        p.play()
        playing = true
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard let self else { return }
                if self.player?.isPlaying != true { self.stop(); return }
            }
        }
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
        player?.stop()
        player = nil
        playing = false
    }
}
