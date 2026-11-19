import SwiftUI

/// Prévia e confirmação A7. O servidor seleciona mensagens públicas e exclui notas e dados laterais.
@MainActor
struct EmailTranscriptSheet: View {
    @StateObject private var model: EmailTranscriptViewModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var workspace = Workspace.shared

    init(conversationId: String, options: TranscriptOptions) {
        _model = StateObject(wrappedValue: EmailTranscriptViewModel.restore(conversationId: conversationId, options: options))
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Enviar conversa por e-mail") { if !model.busy { dismiss() } }
            Form {
                if let result = model.result {
                    Section("Resultado") {
                        Text(result.statusLabel)
                        Text(result.to_masked)
                        if result.duplicate { Text("Esta tentativa já foi registrada; nenhum novo envio foi solicitado.") }
                        if result.status == "unknown" || !["sent", "failed"].contains(result.status) {
                            Text("Confira o resultado com a equipe. O aplicativo não repetirá o envio automaticamente.")
                        } else {
                            Button("Preparar outro envio") { model.startAnotherRequest() }
                        }
                    }
                } else if !model.options.available {
                    Section { Text(model.options.reason ?? "Envio de conversa por e-mail indisponível.") }
                } else {
                    selection
                    if let preview = model.preview { confirmation(preview) }
                    if let error = model.error { Section { InlineError(text: error) } }
                    if model.indeterminate {
                        Section { Text("Resultado indeterminado. Confira com a equipe antes de solicitar outro envio.") }
                    } else if model.attempt != nil {
                        Section {
                            Text("A resposta não chegou. Consulte a mesma tentativa com a mesma chave, sem iniciar outro envio.")
                            Button("Consultar esta tentativa") { Task { await model.send() } }.disabled(model.busy)
                        }
                    } else if model.preview == nil {
                        Section {
                            Button("Gerar prévia") { Task { await model.loadPreview() } }
                                .disabled(!model.validSelection || model.busy)
                        }
                    }
                }
                if model.busy { Section { ProgressView("Aguarde…") } }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .interactiveDismissDisabled(model.busy)
        .onChange(of: workspace.now) { _ in model.objectWillChange.send() }
    }

    private var selection: some View {
        Section("Destino e período") {
            Picker("Enviar para", selection: $model.destination) {
                ForEach(model.destinations, id: \.self) { value in
                    Text(value == "self" ? "Meu e-mail" : value == "contact" ? "E-mail do contato" : "Digitar endereço").tag(value)
                }
            }
            if model.destination == "custom" {
                TextField("Endereço de e-mail", text: $model.address)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never).disableAutocorrection(true)
            }
            Picker("Período", selection: $model.range) {
                ForEach(model.ranges, id: \.self) { value in
                    Text(value == "session" ? "Este atendimento" : "Intervalo de datas").tag(value)
                }
            }
            if model.range == "dates" {
                DatePicker("De", selection: $model.from, displayedComponents: [.date, .hourAndMinute])
                DatePicker("Até", selection: $model.to, displayedComponents: [.date, .hourAndMinute])
            }
            Text("Até \(model.options.limits.maxMessages) mensagens. Notas internas e anexos não são enviados; os anexos aparecem apenas como descrição permitida.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
        }
        .disabled(model.busy || model.attempt != nil)
    }

    @ViewBuilder private func confirmation(_ preview: TranscriptPreview) -> some View {
        Section("Conferir antes de enviar") {
            HStack { Text("Destinatário"); Spacer(); Text(preview.recipient).multilineTextAlignment(.trailing) }
            Text("De \(model.date(preview.period.from)) até \(model.date(preview.period.to))")
            Text("\(preview.messageCount) mensagens · \(preview.size.textChars) caracteres de texto · \(preview.size.htmlChars) de HTML")
            ForEach(Array(preview.warnings.enumerated()), id: \.offset) { item in Text(item.element) }
            if model.needsRecipientConfirmation {
                TextField("Digite o endereço exibido para confirmar", text: $model.confirmedRecipient)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never).disableAutocorrection(true)
                    .disabled(model.busy || model.attempt != nil)
            }
            if model.needsCustomerRequest {
                Toggle("O cliente solicitou este envio", isOn: $model.customerRequested)
                    .disabled(model.busy || model.attempt != nil)
            }
            if model.expired, model.attempt == nil {
                Text("A prévia expirou. Gere outra para conferir os dados novamente.")
                Button("Atualizar prévia") { Task { await model.loadPreview() } }.disabled(model.busy)
            } else if model.attempt == nil {
                Button("Confirmar e enviar") { Task { await model.send() } }
                    .disabled(!model.canConfirm || model.busy)
            }
        }
    }
}

@MainActor
final class EmailTranscriptViewModel: ObservableObject {
    @Published private(set) var options: TranscriptOptions
    @Published var destination: String { didSet { selectionChanged() } }
    @Published var address = "" { didSet { selectionChanged() } }
    @Published var range: String { didSet { selectionChanged() } }
    @Published var from = Date().addingTimeInterval(-86_400) { didSet { selectionChanged() } }
    @Published var to = Date() { didSet { selectionChanged() } }
    @Published var confirmedRecipient = ""
    @Published var customerRequested = false
    @Published private(set) var preview: TranscriptPreview?
    @Published private(set) var attempt: TranscriptAttempt?
    @Published private(set) var result: TranscriptSendResult?
    @Published private(set) var busy = false
    @Published private(set) var indeterminate = false
    @Published private(set) var error: String?
    private let conversationId: String
    private let profileId: String
    private let sessionToken: String?
    private let api: APIClient
    private var previewRequest: TranscriptPreviewRequest?
    private var previewKey: String?

    // Só memória da sessão: fechar a folha após perda de resposta não perde a chave da tentativa.
    private static var drafts: [String: EmailTranscriptViewModel] = [:]
    private static var draftToken: String?
    static func restore(conversationId: String, options: TranscriptOptions) -> EmailTranscriptViewModel {
        let container = AppContainer.shared
        if draftToken != container.session.token { drafts.removeAll(); draftToken = container.session.token }
        let key = "\(container.api.baseURL.absoluteString)|\(container.profileId ?? "")|\(conversationId)"
        if let draft = drafts[key] { draft.options = options; return draft }
        let draft = EmailTranscriptViewModel(conversationId: conversationId, options: options)
        drafts[key] = draft
        return draft
    }

    init(conversationId: String, options: TranscriptOptions) {
        self.conversationId = conversationId
        self.options = options
        let container = AppContainer.shared
        profileId = container.profileId ?? ""
        sessionToken = container.session.token
        api = container.api
        destination = options.destinations.first(where: { ["self", "contact", "custom"].contains($0) }) ?? ""
        range = options.ranges.first(where: { ["session", "dates"].contains($0) }) ?? ""
    }

    var destinations: [String] { options.destinations.filter { ["self", "contact", "custom"].contains($0) } }
    var ranges: [String] { options.ranges.filter { ["session", "dates"].contains($0) } }
    var validSelection: Bool {
        options.available && destinations.contains(destination) && ranges.contains(range)
            && (destination != "custom" || !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && (range != "dates" || from < to)
    }
    var needsRecipientConfirmation: Bool { destination != "self" || preview?.requiresConfirmation == true }
    var needsCustomerRequest: Bool { destination == "contact" || preview?.requiresCustomerRequest == true }
    var expired: Bool { (preview?.expiresAt ?? 0) <= Workspace.shared.nowMillis }
    var canConfirm: Bool {
        guard validSelection, let preview, !expired, !preview.previewToken.isEmpty, attempt == nil else { return false }
        return (!needsRecipientConfirmation || confirmedRecipient.trimmingCharacters(in: .whitespacesAndNewlines) == preview.recipient)
            && (!needsCustomerRequest || customerRequested)
    }
    private var currentSession: Bool {
        let container = AppContainer.shared
        return container.profileId == profileId && container.session.token == sessionToken && container.api.baseURL == api.baseURL
    }
    private func selectionChanged() {
        guard attempt == nil else { return }
        preview = nil; previewRequest = nil; previewKey = nil
        confirmedRecipient = ""; customerRequested = false; error = nil
    }
    func date(_ millis: Int64) -> String {
        Date(timeIntervalSince1970: Double(millis) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    func loadPreview() async {
        guard !busy, attempt == nil, validSelection, currentSession else { return }
        let body = TranscriptPreviewRequest(
            destination: TranscriptDestination(kind: destination, address: destination == "custom" ? address.trimmingCharacters(in: .whitespacesAndNewlines) : nil),
            range: TranscriptRange(kind: range, from: range == "dates" ? Int64(from.timeIntervalSince1970 * 1000) : nil, to: range == "dates" ? Int64(to.timeIntervalSince1970 * 1000) : nil)
        )
        if previewRequest != body || previewKey == nil || (preview != nil && expired) {
            previewRequest = body; previewKey = APIClient.newIdempotencyKey()
        }
        busy = true; error = nil; preview = nil; confirmedRecipient = ""; customerRequested = false
        defer { busy = false }
        do {
            let response = try await api.emailPreview(profileId, conversation: conversationId, body, key: previewKey!)
            guard currentSession else { return }
            preview = response
        } catch { handle(error) }
    }

    func send() async {
        guard !busy, !indeterminate, result == nil, currentSession, options.available else { return }
        let isReplay = attempt != nil
        if attempt == nil {
            guard canConfirm, let preview else { return }
            let body = TranscriptSendRequest(previewToken: preview.previewToken,
                confirmedRecipient: needsRecipientConfirmation ? preview.recipient : nil,
                customerRequested: needsCustomerRequest ? customerRequested : nil)
            attempt = TranscriptAttempt.reusing(attempt, body: body)
        }
        guard let attempt else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let response = try await api.emailTranscript(profileId, conversation: conversationId, attempt.body, key: attempt.key)
            guard currentSession else { return }
            result = response // Inclui unknown: nenhum retry automático, nenhuma nova chave.
        } catch {
            if let failure = error as? APIError {
                if ["operation_unknown", "provider_unknown", "idempotency_conflict"].contains(failure.code) {
                    indeterminate = true
                } else if isReplay {
                    // A primeira chamada pode ter enviado antes da queda. Um 4xx no replay
                    // (token expirado/permissão revogada) não prova que ela não enviou.
                    indeterminate = true
                } else if failure.isDefinitiveWriteRejection {
                    self.attempt = nil; preview = nil; previewKey = nil
                }
            }
            handle(error)
        }
    }

    func startAnotherRequest() {
        guard !busy, let result, ["sent", "failed"].contains(result.status) else { return }
        self.result = nil; attempt = nil; indeterminate = false
        selectionChanged()
    }

    private func handle(_ failure: Error) {
        guard currentSession else { return }
        if let failure = failure as? APIError, failure.isUnauthorized { AppContainer.shared.handleUnauthorized() }
        error = APIError.describe(failure)
    }
}
