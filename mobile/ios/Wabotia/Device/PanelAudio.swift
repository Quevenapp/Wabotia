import AVFoundation
import Foundation

/// O som do painel: o gongo e a voz. Quem decide o que falar é o `PanelCallAnnouncer`.
protocol PanelCallAudio: AnyObject {
    /// Gongo curto: sinaliza a chamada mesmo sem voz instalada.
    func chime()
    /// Fala o texto já montado (fica na fila depois do que estiver sendo falado).
    func speak(_ text: String)
    /// Corta a fala pendente (som desligado, tela fechada).
    func stop()
}

/// Sem áudio: nos testes, no totem (que não anuncia) e onde o aparelho não tem som.
final class SilentPanelAudio: PanelCallAudio {
    func chime() {}
    func speak(_ text: String) {}
    func stop() {}
}

/// Voz com `AVSpeechSynthesizer` em pt-BR e um gongo gerado no próprio app (dois tons com decaimento, sem arquivo de
/// som). A sessão de áudio é `.playback`: o painel fala mesmo com a chave de silêncio do iPhone ligada, como uma TV.
final class SpeechPanelAudio: NSObject, PanelCallAudio, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private let voice = AVSpeechSynthesisVoice(language: "pt-BR")
    private var player: AVAudioPlayer?
    /// A próxima fala espera o gongo terminar.
    private var chimeUntil = Date.distantPast

    override init() {
        super.init()
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        player = try? AVAudioPlayer(data: Self.chimeWAV())
        player?.prepareToPlay()
        synthesizer.delegate = self
        #if DEBUG
        // Para conferir pelo console do aparelho (`devicectl … --console`) que a voz é a de pt-BR.
        print("[Vinki] voz do painel: \(voice.map { "\($0.language) \($0.name)" } ?? "pt-BR não instalada")")
        #endif
    }

    #if DEBUG
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        print("[Vinki] fala iniciada (\(utterance.voice?.language ?? "?")): \(utterance.speechString)")
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        print("[Vinki] fala concluída: \(utterance.speechString)")
    }
    #endif

    deinit { stop() }

    func chime() {
        guard let player else { return }
        player.currentTime = 0
        player.play()
        chimeUntil = Date().addingTimeInterval(player.duration)
        #if DEBUG
        print("[Vinki] gongo")
        #endif
    }

    func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
        utterance.postUtteranceDelay = 0.35
        let wait = chimeUntil.timeIntervalSinceNow
        if wait > 0, !synthesizer.isSpeaking { utterance.preUtteranceDelay = wait + 0.1 }
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        player?.stop()
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
