import SwiftUI
import CallKit

/// Tela da ligação em tela cheia (mobile/DESIGN.md, seção 10): fundo `brandStrong` em degradê, avatar grande,
/// estado, cronômetro e botões redondos. Usada empilhada (`Route.call`) e em fullScreenCover (ligação
/// anunciada por push), por isso tem o próprio botão de fechar.
///
/// Receber: claim → oferta SDP → answer (ICE completo) → pre_accept e accept com a mesma sessão.
/// Ligar: exige conversa assumida e `capabilities.calls`; oferta → POST /calls → GET /calls/{id}?session=1
/// a cada 2,5 s até aplicar a resposta. Keepalive a cada 20 s. Sair da tela encerra a chamada.
struct CallView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @StateObject private var vm: CallViewModel
    @State private var pulse = false
    let conversationId: String
    let callId: String?

    init(conversationId: String, callId: String?) {
        self.conversationId = conversationId
        self.callId = callId
        _vm = StateObject(wrappedValue: CallViewModel(conversationId: conversationId, callId: callId))
    }

    private var ringingLike: Bool { [CallViewModel.Phase.incoming, .waitingAnswer, .preparing].contains(vm.phase) }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.brand, Theme.brandStrong, Color(light: 0x04352F, dark: 0x02211D)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 0) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Color.white)
                            .frame(width: Theme.touch, height: Theme.touch)
                            .background(Circle().fill(Color.white.opacity(0.16)))
                    }
                    .buttonStyle(.plain)
                    .opacity(vm.isLive ? 0 : 1)
                    .disabled(vm.isLive)
                    .accessibilityLabel("Fechar")
                    Spacer()
                    HStack(spacing: 5) {
                        Image(systemName: "lock.fill").font(.system(size: 10))
                        Text("Ligação de voz do WhatsApp").font(Theme.font(12, .medium))
                    }
                    .foregroundStyle(Color.white.opacity(0.75))
                    Spacer()
                    Color.clear.frame(width: Theme.touch, height: Theme.touch)
                }
                .padding(.horizontal, 12)
                .padding(.top, 6)

                ScrollView {
                    VStack(spacing: 14) {
                        header
                        messages
                        if vm.phase == .outgoingIdle { outgoingSection }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity)
                }

                controls
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                    .padding(.bottom, 20)
            }
        }
        .appNavigationBarHidden(true)
        .navigationBarBackButtonHidden(true)
        .interactiveDismissDisabled(vm.isLive)
        .task { await vm.load() }
        .onAppear {
            guard !UIAccessibility.isReduceMotionEnabled else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { pulse = true }
        }
        .onChange(of: vm.isLive) { live in SwipeBack.disabled = live }
        .onDisappear {
            SwipeBack.disabled = false
            vm.leave()
        }
        .alert("Confirmar encerramento", isPresented: $vm.showReconcileConfirm) {
            Button("Confirmar", role: .destructive) { Task { await vm.reconcile() } }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Você conferiu no WhatsApp que esta ligação terminou? Só confirme depois de verificar; a ligação será marcada como encerrada.")
        }
    }

    // MARK: Cabeçalho

    private var header: some View {
        VStack(spacing: 8) {
            ZStack {
                if ringingLike {
                    Circle().stroke(Color.white.opacity(0.35), lineWidth: 2).frame(width: 112, height: 112)
                        .scaleEffect(pulse ? 1.45 : 1).opacity(pulse ? 0 : 1)
                }
                AvatarView(name: vm.title, seed: conversationId, size: 108, ring: Theme.brandStrong)
                    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 3))
            }
            .frame(height: 150)
            Text(vm.title).font(Theme.font(26, .bold)).foregroundStyle(Color.white).multilineTextAlignment(.center)
            if let subtitle = vm.subtitle {
                Text(ConversationFormatting.phone(subtitle)).font(Theme.font(15)).foregroundStyle(Color.white.opacity(0.75))
            }
            HStack(spacing: 8) {
                if vm.phase == .preparing || vm.phase == .loading { ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .white)) }
                Text(vm.statusText).font(Theme.font(17, .semibold)).foregroundStyle(statusColor)
            }
            .padding(.top, 4)
            if vm.phase == .inCall, vm.call?.status == "active" {
                Text(CallLabels.elapsed(vm.elapsed)).font(Theme.font(30, .light, design: .monospaced)).foregroundStyle(Color.white)
            }
            if let direction = vm.call?.direction, !direction.isEmpty {
                Text(CallLabels.direction(direction)).font(Theme.font(12)).foregroundStyle(Color.white.opacity(0.65))
            }
        }
    }

    private var statusColor: Color {
        switch vm.call?.status ?? "" {
        case "active": return Theme.accent
        case "unknown", "missed", "failed", "rejected": return Color(light: 0xFFD27A, dark: 0xFFD27A)
        default: return Color.white.opacity(0.9)
        }
    }

    private var messages: some View {
        VStack(spacing: 8) {
            if let note = vm.note { bannerText(note, icon: "info.circle.fill", strong: false) }
            if let error = vm.error { bannerText(error, icon: "exclamationmark.triangle.fill", strong: true) }
            if let permission = vm.permissionText { bannerText(permission, icon: "checkmark.shield.fill", strong: false) }
        }
    }

    private func bannerText(_ text: String, icon: String, strong: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.system(size: 13)).padding(.top, 2)
            Text(text).font(Theme.font(14)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.white)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(strong ? Theme.danger.opacity(0.55) : Color.white.opacity(0.14)))
    }

    // MARK: Ligar (saída)

    private var outgoingSection: some View {
        VStack(spacing: 10) {
            if let reason = vm.cannotCallReason { bannerText(reason, icon: "lock.fill", strong: false) }
            if vm.retryStartAvailable {
                bannerText("O pedido de ligação não foi confirmado pela rede. Repetir reutiliza o mesmo pedido.", icon: "clock.arrow.circlepath", strong: false)
                HStack(spacing: 10) {
                    lightButton("Tentar novamente") { Task { await vm.retryStart() } }
                    lightButton("Abandonar pedido") { vm.abandonStart() }
                }
                .disabled(vm.busy)
            } else {
                HStack(spacing: 10) {
                    lightButton("Verificar permissão") { Task { await vm.checkPermission() } }
                    lightButton("Pedir permissão") { Task { await vm.requestPermission() } }
                }
                .disabled(vm.busy || !vm.isOwned)
                .opacity(vm.isOwned ? 1 : 0.5)
            }
        }
    }

    private func lightButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Theme.font(14, .semibold)).foregroundStyle(Color.white).lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Capsule().fill(Color.white.opacity(0.18)))
        }
        .buttonStyle(PressScaleStyle())
    }

    // MARK: Controles

    @ViewBuilder
    private var controls: some View {
        switch vm.phase {
        case .loading, .preparing:
            ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .white)).frame(maxWidth: .infinity, minHeight: 96)
        case .incoming:
            HStack {
                Spacer()
                CallControlButton(title: "Recusar", systemImage: "phone.down.fill", fill: Theme.danger, disabled: vm.busy) { Task { await vm.reject() } }
                Spacer()
                Spacer()
                CallControlButton(title: "Atender", systemImage: "phone.fill", fill: Theme.accent, disabled: vm.busy) { Task { await vm.answer() } }
                Spacer()
            }
        case .outgoingIdle:
            if !vm.retryStartAvailable {
                CallControlButton(title: "Ligar", systemImage: "phone.fill", fill: Theme.accent, disabled: vm.busy || !vm.canCall) { Task { await vm.start() } }
            }
        case .waitingAnswer, .inCall:
            if vm.call?.status == "unknown" {
                VStack(spacing: 14) {
                    HStack(spacing: 36) { muteButton; speakerButton }
                    lightButton("Confirmar encerramento") { vm.showReconcileConfirm = true }.disabled(vm.busy)
                }
            } else {
                HStack(alignment: .top, spacing: 28) {
                    muteButton
                    CallControlButton(title: "Encerrar", systemImage: "phone.down.fill", fill: Theme.danger, disabled: vm.busy) { Task { await vm.terminate() } }
                    speakerButton
                }
            }
        case .ended, .unavailable:
            lightButton("Fechar") { dismiss() }
        }
    }

    private var muteButton: some View {
        CallControlButton(title: vm.isMuted ? "Ativar microfone" : "Mudo", systemImage: vm.isMuted ? "mic.slash.fill" : "mic.fill", active: vm.isMuted, disabled: !vm.hasLocalAudio) { vm.toggleMute() }
    }

    private var speakerButton: some View {
        CallControlButton(title: "Viva-voz", systemImage: vm.isSpeakerOn ? "speaker.wave.3.fill" : "speaker.wave.2.fill", active: vm.isSpeakerOn, disabled: !vm.hasLocalAudio) { vm.toggleSpeaker() }
    }
}

/// Botão redondo dos controles da ligação.
private struct CallControlButton: View {
    let title: String
    let systemImage: String
    /// Cor cheia (atender, encerrar). Sem ela o botão é translúcido e fica branco quando `active`.
    var fill: Color? = nil
    var active = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: systemImage)
                    .font(.system(size: 25, weight: .semibold))
                    .foregroundStyle(fill == nil && active ? Theme.brandStrong : Color.white)
                    .frame(width: 68, height: 68)
                    .background(Circle().fill(fill ?? (active ? Color.white : Color.white.opacity(0.18))))
                Text(title).font(Theme.font(12, .medium)).foregroundStyle(Color.white.opacity(0.9)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(minWidth: 84)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(title)
    }
}

// MARK: - View model

@MainActor
final class CallViewModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        /// Ligação recebida aguardando Atender/Recusar.
        case incoming
        /// Sem ligação: tela de permissões e botão Ligar.
        case outgoingIdle
        /// Microfone, CallKit e SDP em preparação.
        case preparing
        /// Ligação realizada aguardando o cliente atender (aplica a answer quando chegar).
        case waitingAnswer
        /// Ligação em andamento (ou `unknown` aguardando confirmação).
        case inCall
        case ended
        /// Ligação de outro atendente ou não encontrada.
        case unavailable
    }

    let conversationId: String
    let initialCallId: String?

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var call: Call?
    @Published private(set) var detail: ConversationDetail?
    @Published var error: String?
    @Published var note: String?
    @Published private(set) var busy = false
    @Published private(set) var isMuted = false
    @Published private(set) var isSpeakerOn = false
    @Published private(set) var elapsed = 0
    @Published private(set) var permissionText: String?
    @Published var showReconcileConfirm = false
    @Published private(set) var retryStartAvailable = false

    private let engine = CallEngine()
    private let callKit = CallKitManager.shared
    private var usingCallKit = false
    private var activeCallId: String?
    private var answerApplied = false
    private var startedAt: Date?
    private var left = false
    private var pollTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?

    // Chaves de idempotência por intenção: a mesma chave é reutilizada ao repetir a mesma ação.
    private var pendingStart: (key: String, body: CallStart)?
    private let claimKey = APIClient.newIdempotencyKey()
    private let preAcceptKey = APIClient.newIdempotencyKey()
    private let acceptKey = APIClient.newIdempotencyKey()
    private let rejectKey = APIClient.newIdempotencyKey()
    private let terminateKey = APIClient.newIdempotencyKey()
    private let reconcileKey = APIClient.newIdempotencyKey()
    private var permissionKey: String?

    private struct FlowError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    private struct MissingOffer: Error {}

    init(conversationId: String, callId: String?) {
        self.conversationId = conversationId
        self.initialCallId = callId
    }

    private var container: AppContainer { AppContainer.shared }
    private var api: APIClient? { container.session.serverURL == nil ? nil : container.api }
    private var profile: String? { container.profileId }
    private var meId: String? { container.user?.id }

    // MARK: Estado derivado

    var title: String { detail?.displayName ?? "Ligação" }
    var subtitle: String? {
        guard let detail else { return nil }
        if let phone = detail.conversation.phone, !phone.isEmpty, phone != detail.displayName { return phone }
        return nil
    }
    var initial: String { String(title.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased() }

    var isOwned: Bool { detail?.conversation.isOwned(by: meId) ?? false }
    var canCall: Bool { isOwned && (detail?.can("calls") ?? false) && activeCallId == nil }
    var isLive: Bool { activeCallId != nil && (call?.isLive ?? false) }
    var hasLocalAudio: Bool { engine.isPrepared }

    var cannotCallReason: String? {
        guard let detail else { return nil }
        if !detail.can("calls") { return "Este canal não oferece ligações de voz. Ligações exigem WhatsApp direto pela Meta com Calling API habilitada." }
        if !isOwned { return "Assuma a conversa para ligar." }
        return nil
    }

    var statusText: String {
        switch phase {
        case .loading: return "Carregando…"
        case .incoming: return CallLabels.status("ringing")
        case .outgoingIdle: return canCall ? "Pronto para ligar" : "Ligação de voz"
        case .preparing: return CallLabels.status("preaccepted")
        case .waitingAnswer, .inCall, .ended: return CallLabels.status(call?.status)
        case .unavailable: return "Indisponível"
        }
    }

    var statusColor: Color {
        switch call?.status ?? "" {
        case "active": return .green
        case "unknown", "missed", "failed", "rejected": return .orange
        default: return .primary
        }
    }

    // MARK: Carga inicial

    func load() async {
        guard !left, let api, let profile else { return }
        callKit.audioHandler = engine
        callKit.onEndRequested = { Task { @MainActor [weak self] in await self?.systemEnded() } }
        callKit.onMuteRequested = { muted in Task { @MainActor [weak self] in self?.setMuted(muted) } }
        engine.onConnectionState = { state in Task { @MainActor [weak self] in self?.connectionChanged(state) } }

        do {
            detail = try await api.conversation(profile, id: conversationId)
        } catch {
            fail(error)
        }
        if let id = initialCallId {
            do {
                call = try await api.call(profile, id: id)
            } catch {
                fail(error)
                phase = .unavailable
                return
            }
        }
        decidePhase()
        if let id = initialCallId, CallIntents.answerCallId == id {
            CallIntents.answerCallId = nil
            if phase == .incoming { await answer() }
        }
    }

    private func decidePhase() {
        guard let call else {
            phase = initialCallId == nil ? .outgoingIdle : .unavailable
            return
        }
        if !call.isLive {
            phase = .ended
            return
        }
        if call.status == "ringing", call.direction == "inbound", call.actor == nil || call.actor == meId {
            phase = .incoming
            return
        }
        if call.actor == meId {
            // Ligação nossa já em andamento (tela reaberta): acompanha o estado e permite encerrar.
            activeCallId = call.id
            if call.status == "active" {
                startedAt = call.started.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? Date()
                startTimer()
            }
            phase = ["dialing", "connecting"].contains(call.status) ? .waitingAnswer : .inCall
            startMonitoring(needSession: call.direction == "outbound" && engine.isPrepared)
            return
        }
        phase = .unavailable
        error = "Outro atendente já assumiu esta ligação."
    }

    // MARK: Receber

    func answer() async {
        guard let api, let profile, let ringing = call, phase == .incoming, !busy else { return }
        busy = true
        error = nil
        note = nil
        phase = .preparing
        do {
            try await engine.prepare()
            let claimed = try await api.claimCall(profile, id: ringing.id, key: claimKey)
            activeCallId = ringing.id
            call = claimed
            let offer = try await awaitOffer(api: api, profile: profile, id: ringing.id, claimed: claimed)
            await setupCallKit(incoming: true)
            let answer = try await engine.createAnswer(for: offer)
            // O áudio só segue depois do accept; pre_accept estabelece a mídia antes.
            engine.setMuted(true)
            _ = try await api.preAcceptCall(profile, id: ringing.id, session: answer, key: preAcceptKey)
            _ = try await api.acceptCall(profile, id: ringing.id, session: answer, key: acceptKey)
            engine.setMuted(false)
            isMuted = false
            call?.status = "active"
            startedAt = Date()
            callKit.markConnected()
            phase = .inCall
            note = "Ligação atendida."
            startTimer()
            startMonitoring(needSession: false)
        } catch is MissingOffer {
            // A ligação ficou assumida por nós. Repetir Atender reenvia o claim com a mesma chave (o servidor
            // devolve a resposta registrada, sem sessão) e volta a consultar GET /calls/{id}?session=1.
            engine.close(deactivateAudio: !usingCallKit)
            note = nil
            error = "A oferta de áudio ainda não chegou. Toque em Atender novamente para continuar aguardando."
            activeCallId = nil
            phase = .incoming
        } catch {
            // Falha ao preparar/atender: libera o áudio e recusa a ligação assumida, como no painel.
            engine.close(deactivateAudio: !usingCallKit)
            if usingCallKit { await callKit.end(); usingCallKit = false }
            if let id = activeCallId {
                _ = try? await api.rejectCall(profile, id: id, key: rejectKey)
            }
            fail(error)
            await refreshCall()
            decidePhase()
            if phase == .incoming, activeCallId != nil { activeCallId = nil }
        }
        busy = false
    }

    /// Oferta SDP da ligação recebida. O webhook `connect` da Meta pode chegar logo depois do claim; como o
    /// claim é idempotente (repetir devolve a mesma resposta sem sessão), a oferta é buscada em
    /// GET /calls/{id}?session=1 (permitido porque a ligação já é nossa) a cada 1 s, por até 10 s.
    private func awaitOffer(api: APIClient, profile: String, id: String, claimed: Call) async throws -> CallSession {
        if let session = claimed.session, session.sdp_type == "offer" { return session }
        note = "Aguardando a oferta de áudio…"
        for _ in 0..<10 {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            if left { throw CancellationError() }
            let fresh: Call
            do {
                fresh = try await api.call(profile, id: id, session: true)
            } catch is URLError {
                continue // falha transitória da consulta: tenta de novo no próximo segundo
            }
            if !fresh.isLive {
                call = fresh
                note = nil
                throw FlowError(message: "A ligação terminou antes de ser atendida.")
            }
            if let session = fresh.session, session.sdp_type == "offer" {
                call = fresh
                note = nil
                return session
            }
        }
        throw MissingOffer()
    }

    /// Recusar = claim + reject (mesmas chaves ao repetir).
    func reject() async {
        guard let api, let profile, let ringing = call, phase == .incoming, !busy else { return }
        busy = true
        error = nil
        do {
            _ = try await api.claimCall(profile, id: ringing.id, key: claimKey)
            _ = try await api.rejectCall(profile, id: ringing.id, key: rejectKey)
            call?.status = "rejected"
            activeCallId = nil
            phase = .ended
            note = "Ligação recusada."
        } catch {
            fail(error)
        }
        busy = false
    }

    // MARK: Ligar

    func checkPermission() async {
        guard let api, let profile, !busy else { return }
        busy = true
        error = nil
        do {
            let result = try await api.callPermission(profile, conversation: conversationId)
            permissionText = Self.describePermission(result)
        } catch {
            fail(error)
        }
        busy = false
    }

    func requestPermission() async {
        guard let api, let profile, !busy else { return }
        busy = true
        error = nil
        let key = permissionKey ?? APIClient.newIdempotencyKey()
        permissionKey = key
        do {
            _ = try await api.requestCallPermission(profile, conversation: conversationId, key: key)
            permissionKey = nil
            note = "Pedido de permissão entrou na fila. Aguarde a resposta do cliente."
        } catch {
            if !(error is URLError) { permissionKey = nil }
            fail(error)
        }
        busy = false
    }

    func start() async {
        guard phase == .outgoingIdle, canCall, !busy else { return }
        busy = true
        error = nil
        note = nil
        permissionText = nil
        phase = .preparing
        do {
            try await engine.prepare()
            await setupCallKit(incoming: false)
            let offer = try await engine.createOffer()
            pendingStart = (key: APIClient.newIdempotencyKey(), body: CallStart(conversation_id: conversationId, session: offer))
            try await submitStart()
        } catch {
            if retryStartAvailable {
                // Falha de rede: mantém áudio, sessão e chave para repetir o mesmo pedido.
                phase = .outgoingIdle
            } else {
                await discardOutgoingAttempt()
                phase = .outgoingIdle
            }
            fail(error)
        }
        busy = false
    }

    func retryStart() async {
        guard pendingStart != nil, !busy else { return }
        busy = true
        error = nil
        phase = .preparing
        do {
            try await submitStart()
        } catch {
            if !retryStartAvailable { await discardOutgoingAttempt() }
            phase = .outgoingIdle
            fail(error)
        }
        busy = false
    }

    func abandonStart() {
        pendingStart = nil
        retryStartAvailable = false
        error = nil
        note = "Pedido de ligação abandonado."
        engine.close(deactivateAudio: !usingCallKit)
        let ck = callKit
        if usingCallKit { usingCallKit = false; Task { await ck.end() } }
        phase = .outgoingIdle
    }

    private func submitStart() async throws {
        guard let api, let profile, let pending = pendingStart else { return }
        do {
            let created = try await api.startCall(profile, pending.body, key: pending.key)
            pendingStart = nil
            retryStartAvailable = false
            call = created
            activeCallId = created.id
            if created.status == "failed" {
                await discardOutgoingAttempt()
                error = created.error ?? "Ligação não confirmada."
                phase = .ended
            } else if created.status == "unknown" {
                engine.close(deactivateAudio: !usingCallKit)
                error = created.error ?? "Sem confirmação da Meta. Não inicie outra ligação; aguarde ou confirme o encerramento."
                phase = .inCall
                startMonitoring(needSession: false)
            } else {
                note = "Aguardando o cliente atender."
                phase = .waitingAnswer
                callKit.markConnecting()
                startMonitoring(needSession: true)
            }
        } catch {
            if error is URLError {
                retryStartAvailable = true
            } else {
                pendingStart = nil
                retryStartAvailable = false
            }
            throw error
        }
    }

    private func discardOutgoingAttempt() async {
        pendingStart = nil
        retryStartAvailable = false
        engine.close(deactivateAudio: !usingCallKit)
        if usingCallKit { usingCallKit = false; await callKit.end() }
    }

    // MARK: Durante a ligação

    func toggleMute() { setMuted(!isMuted) }

    func setMuted(_ muted: Bool) {
        guard engine.isPrepared else { return }
        engine.setMuted(muted)
        isMuted = muted
    }

    func toggleSpeaker() {
        do {
            try engine.setSpeaker(!isSpeakerOn)
            isSpeakerOn = engine.isSpeakerOn
        } catch {
            self.error = "Não foi possível alternar o viva-voz."
        }
    }

    func terminate() async {
        guard let api, let profile, let id = activeCallId, !busy else { return }
        busy = true
        error = nil
        do {
            _ = try await api.terminateCall(profile, id: id, key: terminateKey)
            call?.status = "completed"
            await finishLocally(reason: .remoteEnded)
            note = "Ligação encerrada."
        } catch {
            // A consulta periódica confirma o estado; repetir Encerrar reutiliza a mesma chave.
            fail(error)
        }
        busy = false
    }

    func reconcile() async {
        guard let api, let profile, let id = activeCallId ?? call?.id, !busy else { return }
        busy = true
        error = nil
        do {
            _ = try await api.reconcileCall(profile, id: id, key: reconcileKey)
            call?.status = "completed"
            await finishLocally(reason: .remoteEnded)
            note = "Encerramento confirmado."
        } catch {
            fail(error)
        }
        busy = false
    }

    /// Chamado pelo .onDisappear: para tudo e encerra a ligação no servidor (sem repetir em caso de falha).
    func leave() {
        guard !left else { return }
        left = true
        pollTask?.cancel()
        keepaliveTask?.cancel()
        timerTask?.cancel()
        let shouldTerminate = isLive && call?.status != "unknown" && call?.actor == meId
        let id = activeCallId
        let key = terminateKey
        let client = api
        let p = profile
        engine.close(deactivateAudio: !usingCallKit)
        engine.onConnectionState = nil
        if callKit.audioHandler === engine {
            callKit.onEndRequested = nil
            callKit.onMuteRequested = nil
        }
        let ck = callKit
        let hadCallKit = usingCallKit
        usingCallKit = false
        Task {
            if hadCallKit { await ck.end() }
            if shouldTerminate, let id, let client, let p {
                _ = try? await client.terminateCall(p, id: id, key: key)
            }
        }
    }

    // MARK: Internos

    private func setupCallKit(incoming: Bool) async {
        let conversation = detail?.conversation
        let handle = conversation?.phone ?? conversation?.external_id ?? conversationId
        let name = detail?.displayName ?? "Cliente"
        do {
            if incoming {
                _ = try await callKit.reportIncomingAndAnswer(handle: handle, displayName: name)
            } else {
                _ = try await callKit.reportOutgoing(handle: handle, displayName: name)
            }
            usingCallKit = true
        } catch {
            // Sem CallKit (recusado pelo sistema): segue com AVAudioSession direto.
            usingCallKit = false
            engine.enableAudioWithoutCallKit()
        }
    }

    private func startMonitoring(needSession: Bool) {
        pollTask?.cancel()
        keepaliveTask?.cancel()
        answerApplied = !needSession
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce()
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
        }
        keepaliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                if Task.isCancelled { return }
                await self?.keepaliveOnce()
            }
        }
    }

    private func pollOnce() async {
        guard let api, let profile, let id = activeCallId else { return }
        let wantSession = !answerApplied && call?.direction == "outbound"
        do {
            let fresh = try await api.call(profile, id: id, session: wantSession)
            if Task.isCancelled || left { return }
            if let session = fresh.session, session.sdp_type == "answer", !answerApplied {
                answerApplied = true
                do {
                    try await engine.applyAnswer(session)
                } catch {
                    self.error = "Não foi possível conectar o áudio. Encerre a ligação e confira a rede."
                }
            }
            call = fresh
            if !fresh.isLive {
                await finishLocally(reason: fresh.status == "failed" ? .failed : .remoteEnded)
                return
            }
            if fresh.status == "active" {
                if startedAt == nil {
                    startedAt = fresh.started.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? Date()
                    callKit.markConnected()
                    startTimer()
                }
                if phase == .waitingAnswer { phase = .inCall }
            } else if fresh.status == "unknown", phase == .waitingAnswer {
                phase = .inCall
            }
        } catch {
            if let apiError = error as? APIError, apiError.isUnauthorized { container.handleUnauthorized() }
            // Falhas transitórias da consulta não substituem o erro atual nem repetem ações.
        }
    }

    private func keepaliveOnce() async {
        guard let api, let profile, let id = activeCallId, call?.isLive ?? false else { return }
        do {
            _ = try await api.keepaliveCall(profile, id: id)
        } catch {
            if let apiError = error as? APIError, apiError.isUnauthorized { container.handleUnauthorized() }
        }
    }

    private func refreshCall() async {
        guard let api, let profile, let id = call?.id ?? initialCallId else { return }
        if let fresh = try? await api.call(profile, id: id) { call = fresh }
    }

    private func startTimer() {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                if let self, let started = self.startedAt { self.elapsed = Int(Date().timeIntervalSince(started)) }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    /// Encerra áudio, CallKit e acompanhamento depois que a ligação terminou (localmente ou no servidor).
    private func finishLocally(reason: EndReason) async {
        pollTask?.cancel()
        keepaliveTask?.cancel()
        timerTask?.cancel()
        engine.close(deactivateAudio: !usingCallKit)
        if usingCallKit {
            usingCallKit = false
            switch reason {
            case .remoteEnded: await callKit.end()
            case .failed: callKit.reportEnded(reason: .failed)
            }
        }
        isMuted = false
        isSpeakerOn = false
        activeCallId = nil
        phase = .ended
    }

    private enum EndReason { case remoteEnded, failed }

    /// Encerrada pela interface do sistema (tela bloqueada, CallKit) ou provedor reiniciado.
    private func systemEnded() async {
        guard !left else { return }
        usingCallKit = false
        if isLive, call?.status != "unknown" {
            await terminate()
        } else {
            engine.close(deactivateAudio: true)
        }
    }

    private func connectionChanged(_ state: CallEngine.ConnectionState) {
        guard !left, activeCallId != nil else { return }
        switch state {
        case .failed:
            error = "A rede não conectou o áudio. Encerre a ligação e verifique firewall, VPN ou acesso UDP."
        case .disconnected:
            note = "Áudio instável. Aguardando a rede…"
        case .connected:
            if note == "Áudio instável. Aguardando a rede…" { note = nil }
        default:
            break
        }
    }

    private func fail(_ error: Error) {
        if let apiError = error as? APIError, apiError.isUnauthorized {
            container.handleUnauthorized()
            return
        }
        self.error = APIError.describe(error)
    }

    /// Resume GET /conversations/{id}/call-permission como no painel: estado da permissão e se `start_call` pode ser feito.
    static func describePermission(_ result: JSONValue) -> String {
        let status = result["permission"]?["status"]?.stringValue ?? ""
        let statusText: String
        switch status {
        case "no_permission": statusText = "Ainda não concedida"
        case "temporary": statusText = "Temporária"
        case "permanent": statusText = "Permanente"
        case "": statusText = "Consultar novamente"
        default: statusText = status
        }
        let actions = result["actions"]?.arrayValue ?? []
        let canStart = actions.contains { $0["action_name"]?.stringValue == "start_call" && $0["can_perform_action"]?.boolValue == true }
        let canRequest = actions.contains { $0["action_name"]?.stringValue == "send_call_permission_request" && $0["can_perform_action"]?.boolValue == true }
        var text = "Permissão Meta: \(statusText) · \(canStart ? "Pode ligar agora" : "Aguarde a autorização ou o fim do limite.")"
        if !canStart && !canRequest { text += " Pedido de permissão indisponível no momento." }
        return text
    }
}
