import Foundation
import AVFoundation
import CallKit

/// Quem cuida do áudio do WebRTC quando o CallKit ativa/desativa a sessão do sistema.
protocol CallAudioHandler: AnyObject {
    func configureAudioSession()
    func audioSessionDidActivate(_ session: AVAudioSession)
    func audioSessionDidDeactivate(_ session: AVAudioSession)
}

/// CXProvider (só áudio) e CXCallController para que o sistema trate a ligação como chamada:
/// gerencia a sessão de áudio, mostra a chamada na tela bloqueada e respeita interrupções.
/// Uma única chamada por vez. Se qualquer pedido falhar, quem chama segue com AVAudioSession direto.
final class CallKitManager: NSObject {
    static let shared = CallKitManager()

    private let provider: CXProvider
    private let controller = CXCallController()
    private(set) var currentUUID: UUID?
    private var endingLocally = false

    weak var audioHandler: CallAudioHandler?
    /// A pessoa encerrou pela interface do sistema (ou o provedor foi reiniciado). Chamado na main thread.
    var onEndRequested: (() -> Void)?
    /// Silenciar/ativar pelo sistema. Chamado na main thread.
    var onMuteRequested: ((Bool) -> Void)?

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic, .phoneNumber]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    var hasActiveCall: Bool { currentUUID != nil }

    // MARK: Relatar chamadas

    /// Chamada de saída: CXStartCallAction. Lança se o sistema recusar.
    func reportOutgoing(handle: String, displayName: String) async throws -> UUID {
        if currentUUID != nil { await end() }
        let uuid = UUID()
        let action = CXStartCallAction(call: uuid, handle: makeHandle(handle))
        action.isVideo = false
        action.contactIdentifier = displayName
        endingLocally = false
        try await request(CXTransaction(action: action))
        currentUUID = uuid
        let update = CXCallUpdate()
        update.localizedCallerName = displayName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportCall(with: uuid, updated: update)
        return uuid
    }

    /// Chamada recebida que a pessoa já escolheu atender dentro do app: informa ao sistema
    /// (reportNewIncomingCall) e em seguida responde com CXAnswerCallAction para ele ativar o áudio.
    func reportIncomingAndAnswer(handle: String, displayName: String) async throws -> UUID {
        if currentUUID != nil { await end() }
        let uuid = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = makeHandle(handle)
        update.localizedCallerName = displayName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        endingLocally = false
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            provider.reportNewIncomingCall(with: uuid, update: update) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: ()) }
            }
        }
        currentUUID = uuid
        do {
            try await request(CXTransaction(action: CXAnswerCallAction(call: uuid)))
        } catch {
            provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
            currentUUID = nil
            throw error
        }
        return uuid
    }

    func markConnecting() {
        guard let uuid = currentUUID else { return }
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: nil)
    }

    func markConnected() {
        guard let uuid = currentUUID else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: nil)
    }

    /// Encerramento pedido pelo app (CXEndCallAction). Se o sistema recusar, apenas relata o fim.
    func end() async {
        guard let uuid = currentUUID else { return }
        endingLocally = true
        do {
            try await request(CXTransaction(action: CXEndCallAction(call: uuid)))
        } catch {
            provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
        }
        currentUUID = nil
        endingLocally = false
    }

    /// A outra parte (ou o servidor) encerrou: relata sem transação.
    func reportEnded(reason: CXCallEndedReason) {
        guard let uuid = currentUUID else { return }
        provider.reportCall(with: uuid, endedAt: nil, reason: reason)
        currentUUID = nil
    }

    // MARK: Internos

    private func makeHandle(_ value: String) -> CXHandle {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        let isPhone = !trimmed.isEmpty && trimmed.allSatisfy { $0.isNumber || $0 == "+" }
        return CXHandle(type: isPhone ? .phoneNumber : .generic, value: trimmed.isEmpty ? "WhatsApp" : trimmed)
    }

    private func request(_ transaction: CXTransaction) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            controller.request(transaction) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: ()) }
            }
        }
    }
}

// MARK: - CXProviderDelegate (fila nil = main queue)

extension CallKitManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        currentUUID = nil
        let handler = onEndRequested
        DispatchQueue.main.async { handler?() }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        audioHandler?.configureAudioSession()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        audioHandler?.configureAudioSession()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let local = endingLocally
        currentUUID = nil
        action.fulfill()
        if !local {
            let handler = onEndRequested
            DispatchQueue.main.async { handler?() }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let handler = onMuteRequested
        let muted = action.isMuted
        DispatchQueue.main.async { handler?(muted) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        action.fail()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        audioHandler?.audioSessionDidActivate(audioSession)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        audioHandler?.audioSessionDidDeactivate(audioSession)
    }
}
