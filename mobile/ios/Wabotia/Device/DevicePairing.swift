import Foundation

/// O pareamento do modo aparelho, do código à credencial (RFC 8628, docs/PAREAMENTO.md): pede o código com
/// `client=senhapp` e só as permissões de ler e emitir, consulta no intervalo pedido (nunca abaixo de 5 s num servidor
/// real), soma 5 s a cada `slow_down` e devolve a configuração do aparelho quando o administrador aprova.
struct DevicePairingFlow {
    let pairing: QueuePairing
    /// O piso do intervalo entre consultas (5 s no Vinki; a demonstração responde mais rápido).
    var minimumInterval: TimeInterval = 5
    var sleep: (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    var now: () -> Date = Date.init

    static let expiredMessage = "O código expirou. Toque em Gerar código de novo."
    static let missingReadMessage = "O administrador não liberou a leitura da fila. Revogue este acesso no painel e pareie de novo com “Ler a fila” marcado."

    /// - Parameter onCode: chamado assim que o código chega, para a tela mostrá-lo enquanto o administrador aprova.
    func run(baseURL: String, name: String, demo: Bool, onCode: (PairingStart) -> Void) async throws -> DeviceConfig {
        let base = QueueHTTP.normalize(baseURL)
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let start = try await pairing.start(baseURL: base, instanceName: trimmed)
        onCode(start)
        let until = now().addingTimeInterval(TimeInterval(start.expiresIn ?? 600))
        var wait = max(TimeInterval(start.interval ?? 5), minimumInterval)
        while now() < until {
            try await sleep(wait)
            let answer: PairingToken
            do {
                answer = try await pairing.poll(baseURL: base, deviceCode: start.deviceCode)
            } catch let error as QueueError {
                if error.code == "slow_down" { wait += 5; continue }
                if error.retryable { continue }
                throw error
            }
            if let interval = answer.interval { wait = max(wait, TimeInterval(interval)) }
            guard answer.status == "connected", let token = answer.accessToken, let profile = answer.profileId else { continue }
            let config = DeviceConfig(
                deviceId: DeviceConfig.newDeviceId(),
                baseUrl: base,
                token: token,
                profileId: profile,
                name: trimmed,
                role: nil,
                scopes: answer.scopes,
                demo: demo
            )
            guard config.allows(DeviceScopes.read) else {
                throw QueueError(status: 0, code: "missing_read_scope", message: Self.missingReadMessage)
            }
            return config
        }
        throw QueueError(status: 0, code: "expired_token", message: Self.expiredMessage)
    }

    /// O texto para a tela de pareamento.
    static func message(for error: Error) -> String {
        guard let error = error as? QueueError else { return error.localizedDescription }
        switch error.code {
        case "access_denied": return "O administrador recusou este aparelho. Gere outro código se foi engano."
        case "expired_token": return expiredMessage
        case QueueError.network: return "Sem conexão com o Vinki. Confira a rede e o endereço."
        default: return error.message
        }
    }
}
