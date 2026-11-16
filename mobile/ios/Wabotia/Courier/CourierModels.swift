import Foundation

// Modo entregador sem login: o entregador escaneia o QR do pedido, o servidor entrega uma credencial só daquela entrega,
// e ela é revogada quando a entrega termina (docs/ENTREGA.md; o contrato do acesso sem login ainda está sendo fechado
// com o servidor — os nomes de rota e de campo ficam todos em `CourierRoutes` e nos `CodingKeys` daqui).

/// Coordenada em graus.
struct CourierCoordinate: Codable, Equatable {
    var lat: Double
    var lng: Double

    /// Distância em metros (haversine).
    func distance(to other: CourierCoordinate) -> Double {
        let r = 6_371_000.0
        let dLat = (other.lat - lat) * .pi / 180, dLng = (other.lng - lng) * .pi / 180
        let a = sin(dLat / 2) * sin(dLat / 2) + cos(lat * .pi / 180) * cos(other.lat * .pi / 180) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * r * atan2(sqrt(a), sqrt(1 - a))
    }
}

/// O que o QR do pedido traz: o servidor (o entregador não digita endereço nenhum) e o código de uso único.
struct CourierScan: Equatable {
    var server: URL
    var code: String
    var demo = false

    /// Códigos da demonstração (o "QR" que a demonstração lê sozinha).
    static let demoPrefix = "DEMO-ENTREGA-"

    /// Aceita o link do QR (`https://<servidor>/<…>/<código>` ou `?code=`) e, na demonstração, `DEMO-ENTREGA-<n>`.
    /// Endereço sem https só no build de depuração (mesma regra da tela Servidor).
    static func parse(_ raw: String, allowCleartext: Bool = SessionStore.allowsCleartext) -> CourierScan? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.uppercased().hasPrefix(demoPrefix) {
            return CourierScan(server: DemoMode.serverURL, code: text.uppercased(), demo: true)
        }
        guard let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(), let host = components.host, !host.isEmpty,
              scheme == "https" || (scheme == "http" && allowCleartext) else { return nil }
        let fromQuery = components.queryItems?.first { ["code", "c", "token"].contains($0.name.lowercased()) }?.value
        let fromPath = components.path.split(separator: "/").last.map(String.init)
        guard let code = (fromQuery ?? fromPath)?.trimmingCharacters(in: .whitespaces), code.count >= 6,
              code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        guard let server = origin.url else { return nil }
        return CourierScan(server: server, code: code)
    }
}

/// A credencial de UMA entrega, recebida ao trocar o código do QR. Várias entregas = várias credenciais.
struct CourierGrant: Codable, Equatable, Identifiable {
    var deliveryId: String
    var server: String
    var token: String
    var profileId: String?
    var label: String
    var demo = false
    var id: String { deliveryId }
}

/// Ritmo do GPS e do envio, mandado pelo servidor (`app`); vale sempre o último recebido.
struct CourierRhythm: Codable, Equatable {
    var sampleSeconds: Double? = 15
    var uploadSeconds: Double? = 60
    var nearUploadSeconds: Double? = 30
    var staleMinutes: Double? = 5
    var maxBatch: Int? = 200

    static let standard = CourierRhythm()

    /// Intervalo entre lotes: o curto perto do destino; abaixo de 15 % de bateria, o dobro (docs/ENTREGA.md, Bateria).
    func uploadInterval(near: Bool, battery: Int?) -> TimeInterval {
        let base = near ? (nearUploadSeconds ?? 30) : (uploadSeconds ?? 60)
        let low = (battery ?? 100) < 15
        return max(5, base) * (low ? 2 : 1)
    }

    var batchLimit: Int { min(max(maxBatch ?? 200, 1), 200) }
}

/// Previsão de chegada (linha reta no servidor).
struct CourierEta: Codable, Equatable {
    var minutes: Int?
    var at: Int64?
    var distanceM: Double?
}

/// A entrega como o entregador a vê.
struct CourierDelivery: Codable, Equatable, Identifiable {
    var id: String
    var label: String?
    /// `assigned`, `en_route`, `delivered`, `cancelled`.
    var status: String?
    var storeName: String?
    var customerName: String?
    var addressText: String?
    var destination: CourierCoordinate?
    var items: [String]?
    var paymentText: String?
    var eta: CourierEta?
    var arriving: Bool?
    var app: CourierRhythm?

    var displayLabel: String { label?.isEmpty == false ? label! : "Entrega" }
    var enRoute: Bool { status == "en_route" }
    var open: Bool { status == nil || status == "assigned" || status == "en_route" || status == "pending" }

    var statusText: String {
        switch status {
        case "en_route": return arriving == true ? "Chegando" : "A caminho"
        case "delivered": return "Entregue"
        case "cancelled": return "Não entregue"
        default: return "Aguardando saída"
        }
    }

    /// "cerca de 12 min (2,4 km)".
    var etaText: String? {
        guard let eta, let minutes = eta.minutes else { return nil }
        let km = eta.distanceM.map { String(format: " (%.1f km)", $0 / 1000).replacingOccurrences(of: ".", with: ",") } ?? ""
        return minutes <= 1 ? "chegando agora\(km)" : "cerca de \(minutes) min\(km)"
    }
}

/// Um ponto do GPS no formato do lote.
struct CourierPoint: Codable, Equatable {
    var t: Int64
    var lat: Double
    var lng: Double
    var accuracy: Double?
    var speed: Double?

    var coordinate: CourierCoordinate { CourierCoordinate(lat: lat, lng: lng) }
    /// O servidor ignora precisão pior que 300 m e 0,0: nem entram na fila.
    var usable: Bool { !(lat == 0 && lng == 0) && (accuracy ?? 0) <= 300 && (accuracy ?? 0) >= 0 }
}

/// Resposta de cada lote.
struct CourierPositionsReply: Codable, Equatable {
    var active: Bool?
    var status: String?
    var accepted: Int?
    var ignored: Int?
    var lastAt: Int64?
    var eta: CourierEta?
    var arriving: Bool?
    var app: CourierRhythm?
}

/// Com quem o entregador conversa.
enum CourierPeer: String, Codable, CaseIterable, Identifiable {
    case store, customer
    var id: String { rawValue }
    var title: String { self == .store ? "Loja" : "Cliente" }
}

struct CourierMessage: Codable, Equatable, Identifiable {
    var id: String
    /// `courier` (eu), `store` ou `customer`.
    var from: String
    var text: String
    var at: Int64
    var mine: Bool { from == "courier" }
}

/// A fila local de pontos (docs/ENTREGA.md, "Sem sinal"): guarda até 2 horas, manda os mais antigos primeiro em lotes
/// de até 200 e apaga o que o servidor já julgou. Sem rede, nada se perde até a volta; repetir o lote é seguro.
struct PositionQueue: Equatable {
    static let maxAgeMs: Int64 = 2 * 60 * 60 * 1000
    private(set) var points: [CourierPoint] = []

    mutating func add(_ point: CourierPoint, now: Int64) {
        guard point.usable else { return }
        if let last = points.last, point.t <= last.t { return }
        points.append(point)
        points.removeAll { $0.t < now - Self.maxAgeMs }
    }

    func batch(limit: Int = 200) -> [CourierPoint] { Array(points.prefix(max(1, min(limit, 200)))) }

    /// O lote foi processado: o que o servidor aceitou (até `last_at`) e o que ele ignorou (o resto do lote) sai.
    mutating func confirm(sent: [CourierPoint], lastAt: Int64?) {
        let cut = max(lastAt ?? .min, sent.last?.t ?? .min)
        points.removeAll { $0.t <= cut }
    }

    mutating func clear() { points = [] }
    var isEmpty: Bool { points.isEmpty }
}

/// Recusas do servidor que o modo entregador entende.
enum CourierError: Error, Equatable {
    /// Credencial revogada, entrega encerrada ou de outra pessoa: a entrega sai do aparelho.
    case revoked
    /// Código do QR inválido, vencido ou já usado.
    case invalidCode(String)
    case server(String)
    case network

    var message: String {
        switch self {
        case .revoked: return "O acesso a esta entrega terminou."
        case .invalidCode(let text), .server(let text): return text
        case .network: return "Sem conexão com o Wabotia. Tentando de novo…"
        }
    }
}
