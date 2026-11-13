import SwiftUI
import UIKit

/// Auxiliares da área de bots: rótulos/cores de estado da execução, leitura do `result`
/// (texto puro ou JSON {text, attachments, links}) e download autenticado de anexos.
enum BotsSupport {
    static func statusTitle(_ status: String) -> String {
        switch status {
        case "queued": return "Na fila"
        case "starting": return "Iniciando"
        case "running": return "Em execução"
        case "cancelling": return "Cancelando"
        case "cancelled": return "Cancelada"
        case "completed": return "Concluída"
        case "failed": return "Falhou"
        case "unknown": return "Sem confirmação"
        default: return status
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "completed": return Theme.ok
        case "failed": return Theme.danger
        case "cancelled": return Theme.muted
        case "cancelling", "unknown": return Theme.warn
        case "queued", "starting", "running": return Theme.bot
        default: return Theme.textSecondary
        }
    }

    /// Texto curto enquanto a execução não termina.
    static func progressHint(_ status: String) -> String {
        switch status {
        case "queued": return "Aguardando na fila…"
        case "starting": return "Iniciando o bot…"
        case "running": return "O bot está trabalhando…"
        case "cancelling": return "Cancelando…"
        default: return "Aguardando…"
        }
    }

    /// Estados em que `POST /bot-runs/{id}/cancel` faz sentido.
    static func isCancellable(_ status: String) -> Bool { ["queued", "starting", "running"].contains(status) }

    struct ParsedResult {
        var text: String
        var attachments: [String]
        var links: [String]
    }

    /// O `result` pode ser texto puro ou JSON produzido pelo Hermes: {text, attachments:[mediaId], links:[...]}.
    /// A lista GET /bot-runs não traz `attachments` calculado; por isso também lemos do JSON.
    static func parse(_ run: BotRun) -> ParsedResult {
        let raw = run.result ?? ""
        var text = raw
        var attachments = run.attachments ?? []
        var links: [String] = []
        if let data = raw.data(using: .utf8), let value = try? JSONDecoder().decode(JSONValue.self, from: data), let object = value.objectValue, !object.isEmpty {
            if let t = object["text"]?.stringValue { text = t }
            else if let o = object["output"]?.stringValue { text = o }
            else if let m = object["message"]?.stringValue { text = m }
            if attachments.isEmpty, let list = object["attachments"]?.arrayValue {
                attachments = list.compactMap { $0.stringValue }
            }
            links = object["links"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        }
        return ParsedResult(text: text.trimmingCharacters(in: .whitespacesAndNewlines), attachments: attachments, links: links)
    }

    /// Baixa um anexo privado com Authorization e grava em arquivo temporário para visualizar/compartilhar.
    @MainActor
    static func download(mediaId: String, profileId: String) async throws -> URL {
        let api = AppContainer.shared.api
        let request = api.authorizedRequest(api.mediaURL(profileId: profileId, mediaId: mediaId, inline: false))
        let (data, response) = try await api.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, code: "no_response", message: "Sem resposta do servidor.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? JSONDecoder.wabotia.decode(APIErrorBody.self, from: data).error
            let fallback = http.statusCode == 401 ? "Sessão expirada. Entre novamente." : "Não foi possível baixar o anexo (HTTP \(http.statusCode))."
            throw APIError(status: http.statusCode, code: parsed?.code ?? "http_\(http.statusCode)", message: parsed?.message ?? fallback, requestId: parsed?.request_id)
        }
        let suggested = response.suggestedFilename ?? "anexo"
        let safeName = suggested.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bot-attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("\(mediaId.prefix(8))-\(safeName)")
        try data.write(to: file, options: .atomic)
        return file
    }
}

/// Chip de estado da execução.
struct BotRunStatusBadge: View {
    let status: String

    var body: some View {
        Pill(text: BotsSupport.statusTitle(status), color: BotsSupport.statusColor(status))
    }
}

/// Resultado de uma execução: estado, texto, erro, anexos e "Copiar resposta".
struct BotRunResultView: View {
    let run: BotRun
    let profileId: String
    var showCopy = true

    private var parsed: BotsSupport.ParsedResult { BotsSupport.parse(run) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                BotRunStatusBadge(status: run.status)
                Spacer()
                Text(TicketsSupport.shortDate(run.updated ?? run.created)).font(.caption).foregroundStyle(Theme.textSecondary)
            }
            if run.isFinal {
                if !parsed.text.isEmpty {
                    Text(parsed.text).font(.body).textSelection(.enabled)
                } else if run.status == "completed" {
                    Text("O bot concluiu sem texto de resposta.").font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                if let error = run.error, !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.danger)
                }
                if run.status == "unknown" {
                    Text("Não foi possível confirmar o resultado. Confira em Execuções no painel.").font(.footnote).foregroundStyle(Theme.warn)
                }
                ForEach(parsed.links, id: \.self) { link in
                    if let url = URL(string: link) {
                        Link(destination: url) { Label(link, systemImage: "link").font(.footnote).lineLimit(1) }
                    }
                }
                ForEach(parsed.attachments, id: \.self) { id in
                    BotAttachmentView(mediaId: id, profileId: profileId)
                }
                if showCopy, run.status == "completed", !parsed.text.isEmpty {
                    Button {
                        UIPasteboard.general.string = parsed.text
                    } label: {
                        Label("Copiar resposta", systemImage: "doc.on.doc")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(BotsSupport.progressHint(run.status)).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }
}

/// Anexo gerado pelo bot: baixa com Authorization, mostra prévia de imagem e compartilha (ShareLink).
struct BotAttachmentView: View {
    let mediaId: String
    let profileId: String
    @State private var fileURL: URL?
    @State private var image: UIImage?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            HStack(spacing: 12) {
                Image(systemName: "paperclip")
                Text(fileURL?.lastPathComponent ?? "Anexo").font(.footnote).lineLimit(1)
                Spacer()
                if busy {
                    ProgressView()
                } else if let fileURL {
                    AppShareLink(item: fileURL) {
                        Label("Compartilhar", systemImage: "square.and.arrow.up").labelStyle(.iconOnly)
                    }
                } else {
                    Button("Baixar") { download() }.buttonStyle(.bordered).controlSize(.small)
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(Theme.danger)
            }
        }
        .padding(10)
        .background(Color.black.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
    }

    private func download() {
        busy = true
        error = nil
        Task { @MainActor in
            do {
                let url = try await BotsSupport.download(mediaId: mediaId, profileId: profileId)
                fileURL = url
                image = UIImage(contentsOfFile: url.path)
            } catch {
                self.error = TicketsSupport.failure(error)
            }
            busy = false
        }
    }
}
