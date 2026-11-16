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

/// O que o QR do pedido traz: o servidor da loja (o entregador não digita endereço nenhum) e o código de uso único.
struct CourierScan: Equatable {
    var server: URL
    var code: String
    var demo = false
    /// O texto lido, inteiro (a troca aceita a URL ou só o código).
    var raw = ""

    /// O host do servidor, como a confirmação mostra.
    var host: String { server.host.map { h in server.port.map { "\(h):\($0)" } ?? h } ?? "" }

    static func parse(_ raw: String) -> CourierScan? {
        if case .success(let scan) = CourierQR.read(raw) { return scan }
        return nil
    }
}

/// A leitura do QR do entregador, isolada (formato da F em `fix/credencial-qr`): `https://<endereço público>/api/public/c/<código>`
/// (ou `/c/<código>`, dos QRs já impressos), com o código de 32 caracteres do alfabeto `[2-9A-HJ-NP-Za-km-np-z]`. Só
/// https, nunca endereço de rede local. O servidor é o host do QR.
enum CourierQR {
    enum Refusal: Error, Equatable {
        /// Não é um QR de pedido do Wabotia (outro site, outro formato).
        case notAnOrder
        /// `http://` ou outro esquema sem criptografia.
        case insecure
        /// IP de rede local, `localhost`, `.local`.
        case localAddress

        var message: String {
            switch self {
            case .notAnOrder: return "Este QR não é de um pedido."
            case .insecure: return "Este QR usa um endereço sem segurança (http). Peça à loja o QR do Wabotia."
            case .localAddress: return "Este QR aponta para um endereço da rede local, não para o servidor da loja. Peça à loja o QR do Wabotia."
            }
        }
    }

    static let codeLength = 32
    static let alphabet = Set("23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz")
    /// Hosts da demonstração (as lojas fictícias); só valem com o modo entregador da demonstração.
    static let demoHostSuffix = ".demo.wabotia.localhost"

    static func read(_ raw: String) -> Result<CourierScan, Refusal> {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: text), let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), !host.isEmpty else {
            return .failure(.notAnOrder)
        }
        guard c.user == nil, c.password == nil else { return .failure(.notAnOrder) }
        // `/api/public/c/<código>` (formato novo) ou `/c/<código>` (QRs já impressos); o caminho do QR não é reaproveitado:
        // a leitura pública sempre vai a `/api/public/c/<código>` no mesmo host.
        let parts = c.path.split(separator: "/").map(String.init)
        guard let code = parts.last, isCode(code), parts.dropLast() == ["c"] || parts.dropLast() == ["api", "public", "c"] else {
            return .failure(.notAnOrder)
        }
        guard scheme == "https" else { return .failure(scheme == "http" ? .insecure : .notAnOrder) }
        let demo = host.hasSuffix(demoHostSuffix)
        if !demo, isLocal(host) { return .failure(.localAddress) }
        var origin = URLComponents()
        origin.scheme = "https"
        origin.host = host
        origin.port = c.port
        guard let server = origin.url else { return .failure(.notAnOrder) }
        return .success(CourierScan(server: server, code: code, demo: demo, raw: text))
    }

    static func isCode(_ s: String) -> Bool { s.count == codeLength && s.allSatisfy(alphabet.contains) }

    /// `localhost`, `.local`, `.localhost`, IPv4 privado/loopback/link-local e IPv6 local.
    static func isLocal(_ host: String) -> Bool {
        let h = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" || h.hasSuffix(".localhost") || h.hasSuffix(".local") || h.hasSuffix(".internal") { return true }
        let octets = h.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4, h.split(separator: ".").count == 4 {
            switch (octets[0], octets[1]) {
            case (10, _), (127, _), (0, _), (169, 254), (192, 168): return true
            case (172, let b) where (16...31).contains(b): return true
            case (100, let b) where (64...127).contains(b): return true
            default: return false
            }
        }
        if h.contains(":") {
            let lower = h.lowercased()
            return lower == "::1" || lower == "::" || lower.hasPrefix("fe80") || lower.hasPrefix("fc") || lower.hasPrefix("fd")
        }
        return false
    }
}

/// Leitura pública do QR, sem gastar o código: `GET https://<servidor do QR>/c/<código>` com `Accept: application/json`.
struct CourierPreview: Codable, Equatable {
    var valid: Bool
    var store: String?
    var server: String?
    var expiresAt: Int64?
}

/// Um QR lido, esperando o "Continuar" do entregador.
struct CourierPending: Equatable {
    var scan: CourierScan
    var store: String
}

/// A credencial de UMA entrega, recebida ao trocar o código do QR. Várias entregas = várias credenciais, cada uma com o
/// próprio servidor (lojas diferentes ao mesmo tempo).
struct CourierGrant: Codable, Equatable, Identifiable {
    var deliveryId: String
    var server: String
    var token: String
    var profileId: String?
    var label: String
    var demo = false
    /// Validade da credencial (ms); depois disso o servidor responde 401.
    var expiresAt: Int64?
    /// A loja, como a leitura pública do QR mostrou.
    var storeName: String? = nil
    var id: String { deliveryId }

    var host: String { URL(string: server)?.host ?? server }
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

/// O resumo do pedido para conferir e cobrar (`order` de `…/courier`; nulo fora do módulo Pedido).
struct CourierOrder: Codable, Equatable {
    struct Line: Codable, Equatable {
        var name: String?
        var quantity: Double?
        var options: [String]?
        var note: String?
    }
    struct Payment: Codable, Equatable {
        var methodLabel: String?
        var status: String?
        var statusLabel: String?
        var paid: Bool?
        var changeForCents: Int?
    }
    var lines: [Line]?
    var totalCents: Int?
    var customerNote: String?
    var payment: Payment?
}

/// Estado da conversa na entrega: a última mensagem e se dá para escrever ao cliente (janela de 24 h).
struct CourierChatState: Codable, Equatable {
    var lastSeq: Int?
    var customerOpen: Bool?
}

/// A entrega como o entregador a vê (`GET …/entrega/deliveries/{id}/courier`): sem telefone nem notas internas.
struct CourierDelivery: Codable, Equatable, Identifiable {
    var id: String
    var label: String?
    /// `pending`, `assigned`, `en_route`, `delivered`, `cancelled`.
    var status: String?
    var statusLabel: String?
    /// Só o primeiro nome.
    var customerName: String?
    var addressText: String?
    var destination: CourierCoordinate?
    var eta: CourierEta?
    var arriving: Bool?
    var order: CourierOrder?
    var chat: CourierChatState?
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

    /// "2× X-Bacon (bacon extra) — sem cebola".
    var items: [String] {
        (order?.lines ?? []).map { line in
            let q = line.quantity.map { $0 == $0.rounded() ? "\(Int($0))× " : "\($0)× " } ?? ""
            let options = (line.options ?? []).isEmpty ? "" : " (\((line.options ?? []).joined(separator: ", ")))"
            let note = (line.note ?? "").isEmpty ? "" : " — \(line.note ?? "")"
            return "\(q)\(line.name ?? "Item")\(options)\(note)"
        }
    }

    /// "Dinheiro · a receber R$ 28,00 · troco para R$ 50,00", ou "Pix · pago".
    var paymentText: String? {
        guard let p = order?.payment else { return nil }
        var parts = [p.methodLabel ?? "Pagamento"]
        if p.paid == true { parts.append("pago") } else if let total = order?.totalCents { parts.append("a receber \(Money.format(total))") }
        if let change = p.changeForCents, change > 0 { parts.append("troco para \(Money.format(change))") }
        return parts.joined(separator: " · ")
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
    /// Conversa: quando muda, o app busca `…/messages?after=`.
    var chat: CourierChatState?
}

/// Com quem o entregador conversa: o canal da mensagem (`store` ou `customer`).
enum CourierPeer: String, Codable, CaseIterable, Identifiable {
    case store, customer
    var id: String { rawValue }
    var title: String { self == .store ? "Loja" : "Cliente" }
}

/// Uma mensagem da conversa da entrega (os dois canais vêm juntos, em ordem de `seq`).
struct CourierMessage: Codable, Equatable, Identifiable {
    var seq: Int
    /// `store` ou `customer`.
    var channel: String
    /// `courier` (eu), `store` ou `customer`.
    var sender: String
    var authorName: String?
    var text: String
    var created: Int64?

    var id: Int { seq }
    var mine: Bool { sender == "courier" }
    var peer: CourierPeer { channel == CourierPeer.customer.rawValue ? .customer : .store }
}

/// `GET …/messages?after=<seq>`: até 100 por chamada.
struct CourierMessagesPage: Codable, Equatable {
    var data: [CourierMessage]
    var lastSeq: Int?
    var customerOpen: Bool?
    var open: Bool?
}

/// A troca do QR: a credencial e o que a entrega já mostra.
struct CourierClaim: Equatable {
    var grant: CourierGrant
    var delivery: CourierDelivery?
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
