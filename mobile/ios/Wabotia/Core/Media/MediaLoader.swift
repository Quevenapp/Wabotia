import Foundation
import UniformTypeIdentifiers

/// Baixa anexos privados (exigem Authorization) e guarda os bytes em memória e em disco (Caches/media/{id}).
/// Documentos podem ser materializados em arquivo temporário com o nome original para QuickLook/ShareLink.
actor MediaLoader {
    static let shared = MediaLoader()

    private var memory: [String: Data] = [:]
    private var memoryBytes = 0
    private let memoryLimit = 48 * 1024 * 1024
    private var inflight: [String: Task<Data, Error>] = [:]
    private let directory: URL

    init() {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        directory = base.appendingPathComponent("media", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func diskPath(_ mediaId: String) -> URL {
        directory.appendingPathComponent(mediaId.replacingOccurrences(of: "/", with: "_"))
    }

    /// Bytes do anexo, do cache quando possível. Erros de rede/HTTP viram `APIError`.
    func data(mediaId: String, profileId: String, api: APIClient) async throws -> Data {
        if let d = memory[mediaId] { return d }
        let path = diskPath(mediaId)
        if let d = try? Data(contentsOf: path) {
            remember(mediaId, d)
            return d
        }
        if let running = inflight[mediaId] { return try await running.value }
        let request = api.authorizedRequest(api.mediaURL(profileId: profileId, mediaId: mediaId, inline: false))
        let task = Task<Data, Error> {
            let (d, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, code: "no_response", message: "Sem resposta do servidor.") }
            if http.statusCode == 401 {
                await MainActor.run { AppContainer.shared.handleUnauthorized() }
                throw APIError(status: 401, code: "unauthorized", message: "Sessão expirada. Entre novamente.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let parsed = try? JSONDecoder.wabotia.decode(APIErrorBody.self, from: d).error
                throw APIError(status: http.statusCode, code: parsed?.code ?? "http_\(http.statusCode)", message: parsed?.message ?? "Não foi possível baixar o anexo (HTTP \(http.statusCode)).", requestId: parsed?.request_id)
            }
            return d
        }
        inflight[mediaId] = task
        defer { inflight[mediaId] = nil }
        let d = try await task.value
        remember(mediaId, d)
        try? d.write(to: path, options: .atomic)
        return d
    }

    /// Arquivo temporário com o nome original (para abrir/compartilhar documentos, imagens e vídeos).
    func fileURL(for file: MediaFile, profileId: String, api: APIClient) async throws -> URL {
        let bytes = try await data(mediaId: file.id, profileId: profileId, api: api)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wabotia-media/\(file.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(Self.safeFileName(file))
        if !FileManager.default.fileExists(atPath: url.path) { try bytes.write(to: url, options: .atomic) }
        return url
    }

    func clear() {
        memory = [:]
        memoryBytes = 0
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func remember(_ id: String, _ d: Data) {
        guard d.count <= 12 * 1024 * 1024 else { return }
        if memoryBytes + d.count > memoryLimit {
            memory = [:]
            memoryBytes = 0
        }
        memory[id] = d
        memoryBytes += d.count
    }

    /// Nome seguro para o sistema de arquivos, com extensão coerente com o tipo MIME.
    static func safeFileName(_ file: MediaFile) -> String {
        var name = file.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let forbidden = CharacterSet(charactersIn: "/\\:*?\"<>|\u{0}")
        name = String(name.unicodeScalars.map { forbidden.contains($0) ? "_" : Character($0) })
        if name.isEmpty || name == "." || name == ".." { name = "anexo" }
        if (name as NSString).pathExtension.isEmpty, let ext = extensionFor(mimeType: file.type) { name += "." + ext }
        return String(name.prefix(120))
    }

    static func extensionFor(mimeType: String) -> String? {
        let mime = mimeType.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? mimeType
        if mime == "audio/ogg" { return "ogg" }
        return UTType(mimeType: mime)?.preferredFilenameExtension
    }
}

extension MediaFile {
    var mimeBase: String { type.split(separator: ";").first.map { String($0).trimmingCharacters(in: .whitespaces).lowercased() } ?? type.lowercased() }
    var isImage: Bool { mimeBase.hasPrefix("image/") }
    var isVideo: Bool { mimeBase.hasPrefix("video/") }
    var isAudio: Bool { mimeBase.hasPrefix("audio/") }
    var isDocument: Bool { !isImage && !isVideo && !isAudio }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: size, countStyle: .file) }
}
