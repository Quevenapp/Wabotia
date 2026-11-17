import AVFoundation
import Foundation

/// O som do painel: o gongo e a voz. Quem decide o que falar é o `PanelCallAnnouncer`.
protocol PanelCallAudio: AnyObject {
    /// Gongo curto: sinaliza a chamada mesmo sem voz instalada.
    func chime()
    /// Fala o texto já montado (fica na fila depois do que estiver sendo falado). `done` vem no fim da fala, também
    /// quando ela é cortada: é por ele que a tela acompanha a voz (`PanelCallQueue`).
    func speak(_ text: String, done: @escaping () -> Void)
    /// Corta a fala pendente (som desligado, tela fechada).
    func stop()
    /// Volume do painel, de 0 a 1, dentro do volume de mídia do aparelho (que o app não pode mudar sozinho).
    func setVolume(_ level: Float)
}

extension PanelCallAudio {
    func speak(_ text: String) { speak(text, done: {}) }
}

/// Sem áudio: nos testes, no totem (que não anuncia) e onde o aparelho não tem som.
final class SilentPanelAudio: PanelCallAudio {
    func chime() {}
    func speak(_ text: String, done: @escaping () -> Void) { done() }
    func stop() {}
    func setVolume(_ level: Float) {}
}

/// A sessão de áudio do painel: `.playback` fala mesmo com a chave de silêncio ligada, como uma TV.
enum PanelAudioSession {
    static func activate() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
    }
}

/// O que a tela diz do volume: o do painel no app vezes o de mídia do aparelho.
enum PanelVolume {
    /// O controle do app vai de 10% a 100%: zero pareceria som quebrado; para calar há o interruptor da voz.
    static let range: ClosedRange<Float> = 0.1...1
    /// Abaixo disso (volume efetivo), a recepção quase não ouve: a tela avisa "som baixo".
    static let lowThreshold: Float = 0.3

    static func clamp(_ level: Float) -> Float { min(max(level, range.lowerBound), range.upperBound) }

    /// `system` é `nil` quando o aparelho não informa (simulador): aí só o do app conta.
    static func isLow(system: Float?, panel: Float) -> Bool { (system ?? 1) * panel < lowThreshold }

    static func percent(_ level: Float) -> String { "\(Int((level * 100).rounded()))%" }
}

/// O volume de mídia do aparelho, observado (os botões laterais o mudam a qualquer momento).
@MainActor
final class SystemVolume: ObservableObject {
    @Published private(set) var level: Float?
    private var observation: NSKeyValueObservation?

    func start() {
        guard observation == nil else { return }
        PanelAudioSession.activate()
        let session = AVAudioSession.sharedInstance()
        level = session.outputVolume
        #if DEBUG
        print("[Wabotia] volume de mídia do aparelho: \(PanelVolume.percent(session.outputVolume))")
        #endif
        observation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let value = change.newValue else { return }
            Task { @MainActor in self?.level = value }
        }
    }

    func stop() {
        observation?.invalidate()
        observation = nil
    }
}

/// Voz com `AVSpeechSynthesizer` em pt-BR e um gongo gerado no próprio app (dois tons com decaimento, sem arquivo de
/// som). A sessão de áudio é `.playback`: o painel fala mesmo com a chave de silêncio do iPhone ligada, como uma TV.
final class SpeechPanelAudio: NSObject, PanelCallAudio, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private let voice = AVSpeechSynthesisVoice(language: "pt-BR")
    private var player: AVAudioPlayer?
    /// A próxima fala espera o gongo terminar.
    private var chimeUntil = Date.distantPast
    private var volume: Float = 1

    override init() {
        super.init()
        PanelAudioSession.activate()
        player = try? AVAudioPlayer(data: Self.chimeWAV())
        player?.prepareToPlay()
        synthesizer.delegate = self
        #if DEBUG
        // Para conferir pelo console do aparelho (`devicectl … --console`) que a voz é a de pt-BR.
        print("[Wabotia] voz do painel: \(voice.map { "\($0.language) \($0.name)" } ?? "pt-BR não instalada")")
        #endif
    }

    /// O fim de cada fala, para quem espera por ela.
    private var pending: [ObjectIdentifier: () -> Void] = [:]

    private func finished(_ utterance: AVSpeechUtterance) {
        let done = pending.removeValue(forKey: ObjectIdentifier(utterance))
        DispatchQueue.main.async { done?() }
    }

    #if DEBUG
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        print("[Wabotia] fala iniciada (\(utterance.voice?.language ?? "?")): \(utterance.speechString)")
    }
    #endif

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        #if DEBUG
        print("[Wabotia] fala concluída: \(utterance.speechString)")
        #endif
        finished(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finished(utterance)
    }

    deinit { stop() }

    func chime() {
        guard let player else { return }
        player.currentTime = 0
        player.play()
        chimeUntil = Date().addingTimeInterval(player.duration)
        #if DEBUG
        print("[Wabotia] gongo")
        #endif
    }

    func speak(_ text: String, done: @escaping () -> Void) {
        let utterance = AVSpeechUtterance(string: text)
        pending[ObjectIdentifier(utterance)] = done
        utterance.voice = voice
        utterance.volume = volume
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
        utterance.postUtteranceDelay = 0.35
        let wait = chimeUntil.timeIntervalSinceNow
        if wait > 0, !synthesizer.isSpeaking { utterance.preUtteranceDelay = wait + 0.1 }
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        player?.stop()
        // Quem esperava uma fala cortada não fica preso (o `didCancel` nem sempre vem para as que estavam na fila).
        let waiting = pending.values
        pending = [:]
        DispatchQueue.main.async { waiting.forEach { $0() } }
    }

    func setVolume(_ level: Float) {
        volume = PanelVolume.clamp(level)
        player?.volume = volume
    }

    /// O gongo: dois tons (Mi e Dó) com harmônico e decaimento exponencial, 16 bits mono a 22,05 kHz.
    static func chimeWAV(sampleRate: Int = 22_050) -> Data {
        let notes: [(frequency: Double, start: Double, length: Double)] = [(659.25, 0, 0.9), (523.25, 0.45, 1.2)]
        let total = Int(Double(sampleRate) * 1.7)
        var samples = [Double](repeating: 0, count: total)
        for note in notes {
            let first = Int(note.start * Double(sampleRate))
            let count = min(Int(note.length * Double(sampleRate)), total - first)
            for i in 0..<max(count, 0) {
                let t = Double(i) / Double(sampleRate)
                let envelope = exp(-3.2 * t) * min(1, t * 200)
                let tone = sin(2 * .pi * note.frequency * t) + 0.35 * sin(2 * .pi * note.frequency * 2 * t)
                samples[first + i] += 0.42 * envelope * tone
            }
        }
        var pcm = Data(capacity: total * 2)
        for s in samples {
            var v = Int16(max(-1, min(1, s)) * Double(Int16.max)).littleEndian
            withUnsafeBytes(of: &v) { pcm.append(contentsOf: $0) }
        }
        var wav = Data()
        func append32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        func append16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        wav.append(contentsOf: Array("RIFF".utf8)); append32(UInt32(36 + pcm.count))
        wav.append(contentsOf: Array("WAVE".utf8))
        wav.append(contentsOf: Array("fmt ".utf8)); append32(16); append16(1); append16(1)
        append32(UInt32(sampleRate)); append32(UInt32(sampleRate * 2)); append16(2); append16(16)
        wav.append(contentsOf: Array("data".utf8)); append32(UInt32(pcm.count))
        wav.append(pcm)
        return wav
    }
}
