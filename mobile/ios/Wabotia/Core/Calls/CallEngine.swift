import Foundation
import AVFoundation
import WebRTC

/// Motor WebRTC **só áudio** para as ligações da Meta Calling API.
/// Produz/consome o SDP que o servidor Wabotia repassa (`session: {sdp_type, sdp}`), sempre com a
/// coleta ICE completa (até 12 s) antes de devolver a sessão, como exige docs/API.md.
/// O áudio do sistema é gerenciado pelo CallKit quando disponível (`useManualAudio`); sem CallKit,
/// `enableAudioWithoutCallKit()` configura o AVAudioSession diretamente.
final class CallEngine: NSObject {
    enum EngineError: LocalizedError {
        case microphoneDenied
        case notPrepared
        case iceTimeout
        case invalidSession
        case webrtc(String)

        var errorDescription: String? {
            switch self {
            case .microphoneDenied: return "Permita o uso do microfone em Ajustes para fazer e atender ligações."
            case .notPrepared: return "O áudio da ligação não foi preparado."
            case .iceTimeout: return "A rede demorou a preparar o áudio. Verifique sua conexão."
            case .invalidSession: return "A sessão de áudio recebida é inválida."
            case .webrtc(let message): return message
            }
        }
    }

    enum ConnectionState { case new, connecting, connected, disconnected, failed, closed }

    /// Chamado fora da main thread; quem assina deve saltar para o MainActor.
    var onConnectionState: ((ConnectionState) -> Void)?

    private static let factory: RTCPeerConnectionFactory = {
        _ = RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    private static let offerAnswerConstraints = RTCMediaConstraints(
        mandatoryConstraints: [
            kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueTrue,
            kRTCMediaConstraintsOfferToReceiveVideo: kRTCMediaConstraintsValueFalse,
        ],
        optionalConstraints: nil
    )

    private let rtcSession = RTCAudioSession.sharedInstance()
    private var peer: RTCPeerConnection?
    private var localTrack: RTCAudioTrack?
    private let lock = NSLock()
    private var gatheringContinuation: CheckedContinuation<Bool, Never>?
    /// Identifica a coleta ICE em andamento: o timeout de uma coleta anterior não pode resolver a atual.
    private var gatheringGeneration = 0
    private var gatheringTimeout: DispatchWorkItem?

    private(set) var isMuted = false
    private(set) var isSpeakerOn = false
    var isPrepared: Bool { peer != nil }

    // MARK: Permissão

    static func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    // MARK: Ciclo de vida

    /// Pede o microfone e cria a RTCPeerConnection com uma trilha de áudio local. Sem vídeo nem data channel.
    func prepare() async throws {
        guard await Self.requestMicrophonePermission() else { throw EngineError.microphoneDenied }
        if peer != nil { return }

        // O CallKit (ou `enableAudioWithoutCallKit`) decide quando o áudio começa.
        rtcSession.useManualAudio = true
        rtcSession.isAudioEnabled = false

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherOnce
        config.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        let pcConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        // O retorno é `nullable` nas versões recentes do stasel/WebRTC; a anotação explícita compila nos dois casos.
        let created: RTCPeerConnection? = Self.factory.peerConnection(with: config, constraints: pcConstraints, delegate: self)
        guard let pc = created else {
            throw EngineError.webrtc("Não foi possível criar a conexão de áudio.")
        }
        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = Self.factory.audioTrack(with: source, trackId: "wabotia_audio0")
        _ = pc.add(track, streamIds: ["wabotia_stream0"])
        peer = pc
        localTrack = track
        isMuted = false
        isSpeakerOn = false
    }

    /// Cria a oferta, aplica como descrição local e devolve `{sdp_type:"offer", sdp}` com ICE completo.
    func createOffer() async throws -> CallSession {
        guard let pc = peer else { throw EngineError.notPrepared }
        let sdp = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            pc.offer(for: Self.offerAnswerConstraints) { sdp, error in
                if let sdp { continuation.resume(returning: sdp) }
                else { continuation.resume(throwing: EngineError.webrtc("Não foi possível criar a oferta de áudio. \(error?.localizedDescription ?? "")")) }
            }
        }
        try await setLocal(sdp, on: pc)
        return try await gatheredSession(pc, type: "offer")
    }

    /// Aplica a oferta remota, cria a resposta e devolve `{sdp_type:"answer", sdp}` com ICE completo.
    func createAnswer(for offer: CallSession) async throws -> CallSession {
        guard let pc = peer else { throw EngineError.notPrepared }
        guard offer.sdp_type == "offer", offer.sdp.hasPrefix("v=0") else { throw EngineError.invalidSession }
        try await setRemote(RTCSessionDescription(type: .offer, sdp: offer.sdp), on: pc)
        let sdp = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            pc.answer(for: Self.offerAnswerConstraints) { sdp, error in
                if let sdp { continuation.resume(returning: sdp) }
                else { continuation.resume(throwing: EngineError.webrtc("Não foi possível criar a resposta de áudio. \(error?.localizedDescription ?? "")")) }
            }
        }
        try await setLocal(sdp, on: pc)
        return try await gatheredSession(pc, type: "answer")
    }

    /// Aplica a resposta remota de uma ligação que nós iniciamos.
    func applyAnswer(_ answer: CallSession) async throws {
        guard let pc = peer else { throw EngineError.notPrepared }
        guard answer.sdp_type == "answer", answer.sdp.hasPrefix("v=0") else { throw EngineError.invalidSession }
        try await setRemote(RTCSessionDescription(type: .answer, sdp: answer.sdp), on: pc)
    }

    func setMuted(_ muted: Bool) {
        isMuted = muted
        localTrack?.isEnabled = !muted
    }

    /// Viva-voz: AVAudioSession.overrideOutputAudioPort, sob o lock do RTCAudioSession.
    func setSpeaker(_ on: Bool) throws {
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
        isSpeakerOn = on
    }

    /// Encerra a conexão e libera o microfone. `deactivateAudio` só quando o CallKit não está cuidando da sessão.
    func close(deactivateAudio: Bool) {
        finishGathering(completed: false)
        localTrack?.isEnabled = false
        peer?.close()
        peer = nil
        localTrack = nil
        rtcSession.isAudioEnabled = false
        isMuted = false
        isSpeakerOn = false
        if deactivateAudio {
            rtcSession.lockForConfiguration()
            try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            rtcSession.unlockForConfiguration()
        }
    }

    // MARK: Sessão de áudio

    /// Sem CallKit: configura .playAndRecord/.voiceChat, ativa a sessão e liga o áudio do WebRTC.
    func enableAudioWithoutCallKit() {
        configureAudioSession()
        rtcSession.lockForConfiguration()
        try? AVAudioSession.sharedInstance().setActive(true)
        rtcSession.unlockForConfiguration()
        rtcSession.audioSessionDidActivate(AVAudioSession.sharedInstance())
        rtcSession.isAudioEnabled = true
    }

    // MARK: Internos

    private func setLocal(_ sdp: RTCSessionDescription, on pc: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp) { error in
                if let error { continuation.resume(throwing: EngineError.webrtc("Falha ao preparar o áudio local: \(error.localizedDescription)")) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func setRemote(_ sdp: RTCSessionDescription, on pc: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp) { error in
                if let error { continuation.resume(throwing: EngineError.webrtc("Falha ao aplicar o áudio remoto: \(error.localizedDescription)")) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    /// Aguarda `iceGatheringState == .complete` por até 12 s e devolve a descrição local completa.
    private func gatheredSession(_ pc: RTCPeerConnection, type: String) async throws -> CallSession {
        if pc.iceGatheringState != .complete {
            let completed = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                lock.lock()
                gatheringTimeout?.cancel()
                gatheringGeneration += 1
                let generation = gatheringGeneration
                gatheringContinuation = continuation
                let timeout = DispatchWorkItem { [weak self] in
                    self?.finishGathering(completed: false, generation: generation)
                }
                gatheringTimeout = timeout
                lock.unlock()
                if pc.iceGatheringState == .complete {
                    finishGathering(completed: true)
                    return
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 12, execute: timeout)
            }
            guard completed else { throw EngineError.iceTimeout }
        }
        guard let local = pc.localDescription else { throw EngineError.webrtc("Sem descrição local de áudio.") }
        return CallSession(sdp_type: type, sdp: local.sdp)
    }

    /// Resolve a coleta atual. Com `generation` (timeout), só resolve se ainda for a mesma coleta;
    /// o timer é cancelado sempre que a coleta termina, para não abortar uma coleta posterior.
    private func finishGathering(completed: Bool, generation: Int? = nil) {
        lock.lock()
        if let generation, generation != gatheringGeneration {
            lock.unlock()
            return
        }
        let continuation = gatheringContinuation
        gatheringContinuation = nil
        gatheringTimeout?.cancel()
        gatheringTimeout = nil
        lock.unlock()
        continuation?.resume(returning: completed)
    }

    private func notify(_ state: ConnectionState) {
        guard let handler = onConnectionState else { return }
        DispatchQueue.main.async { handler(state) }
    }
}

// MARK: - CallAudioHandler (CallKit)

extension CallEngine: CallAudioHandler {
    /// .playAndRecord + .voiceChat no AVAudioSession compartilhado (o mesmo que o RTCAudioSession observa).
    func configureAudioSession() {
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
        } catch {
            // Mantém a configuração atual; o CallKit ainda ativa a sessão.
        }
    }

    func audioSessionDidActivate(_ session: AVAudioSession) {
        rtcSession.audioSessionDidActivate(session)
        rtcSession.isAudioEnabled = true
    }

    func audioSessionDidDeactivate(_ session: AVAudioSession) {
        rtcSession.isAudioEnabled = false
        rtcSession.audioSessionDidDeactivate(session)
    }
}

// MARK: - RTCPeerConnectionDelegate

extension CallEngine: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        switch newState {
        case .new: notify(.new)
        case .checking: notify(.connecting)
        case .connected, .completed: notify(.connected)
        case .disconnected: notify(.disconnected)
        case .failed: notify(.failed)
        case .closed: notify(.closed)
        default: break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete { finishGathering(completed: true) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
