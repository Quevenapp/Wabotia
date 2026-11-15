import Foundation
import CryptoKit
import Security

/*
 O núcleo do painel e do totem, sem tela, para ser testado: o formato das chamadas na TV, o que falar entre duas
 leituras, o PIN de saída e as regras do cartão da senha. Porta do Android (`device/core`), que veio do Senhapp. A
 fila nunca é decidida aqui: ordem, número e espera vêm do servidor.
 */

/// Uma chamada como a TV a mostra.
struct StationCall: Equatable, Identifiable {
    var ticketId: String
    var publicNumber: String
    /// `calling` enquanto aparece como chamada.
    var status: String = "calling"
    var stationLabel: String?
    var queueName: String?
    var calledAt: String?
    var recalls: Int = 0
    var queueId: String?
    /// Posição em `recent_calls` (0 = a mais recente).
    var recentRank: Int?
    var lastCalledAt: String?
    var at: Int64?

    var id: String { "\(ticketId)#\(recalls)" }
}

extension CallFrame {
    /// O formato dos quadros do painel, já como "chamando".
    func stationCall(rank: Int? = nil) -> StationCall {
        let stamp = at.map(String.init)
        return StationCall(
            ticketId: ticketId,
            publicNumber: code ?? "",
            stationLabel: counterName,
            queueName: queueName,
            calledAt: stamp,
            recalls: max((callCount ?? 1) - 1, 0),
            queueId: queueId,
            recentRank: rank,
            lastCalledAt: stamp,
            at: at
        )
    }
}

extension QueueOverview {
    /// As chamadas recentes na ordem do servidor (a mais recente primeiro).
    var stationCalls: [StationCall] { (recentCalls ?? []).enumerated().map { $0.element.stationCall(rank: $0.offset) } }

    /// O totem só oferece filas ativas com o canal `kiosk`.
    var kioskQueues: [QueueInfo] { (queues ?? []).filter(\.kiosk) }
}

/// Ordem das chamadas na TV (porta de `PanelTotem.kt` do Vinki).
enum PanelCalls {
    /// A chamada mais recente primeiro: posição em `recent_calls`, depois a hora.
    static func mostRecentFirst(_ a: StationCall, _ b: StationCall) -> Bool {
        let ra = a.recentRank ?? Int.max, rb = b.recentRank ?? Int.max
        if ra != rb { return ra < rb }
        let ta = a.at ?? Int64(a.lastCalledAt ?? a.calledAt ?? "") ?? 0
        let tb = b.at ?? Int64(b.lastCalledAt ?? b.calledAt ?? "") ?? 0
        return ta > tb
    }

    static func ordered(_ calls: [StationCall]) -> [StationCall] { calls.sorted(by: mostRecentFirst) }

    static func onScreen(_ calls: [StationCall]) -> [StationCall] { ordered(calls.filter { $0.status == "calling" || $0.status == "acknowledged" }) }

    /// Quantas chamadas anteriores cabem ao lado da principal.
    static let othersOnScreen = 6
}

struct PanelAnnouncement: Equatable {
    var chime: Bool
    var spoken: [String]
    /// A senha chamada ou rechamada por último neste anúncio: a que o destaque mostra.
    var latest: StationCall?

    static let silent = PanelAnnouncement(chime: false, spoken: [], latest: nil)
}

/// O que o painel fala entre duas leituras do estado (porta do `PanelCallAnnouncer` do QRSenha). A fala usa só o número
/// público e o rótulo do balcão, que já estão na tela: nenhum nome, telefone ou dado de quem retirou a senha.
final class PanelCallAnnouncer {
    static let maxSpokenPerCycle = 3
    static let silentBurstThreshold = 8
    static let historyLimit = 64

    private var announced: [String] = []
    private var announcedSet: Set<String> = []
    /// `true` depois da primeira leitura: antes dela, nada se fala.
    private(set) var primed = false

    /// Marca as chamadas atuais como já vistas, sem falar. A primeira leitura passa por aqui: senão o painel recitaria
    /// as chamadas antigas cada vez que a tela abre.
    func prime(_ calls: [StationCall]) {
        for call in calls { _ = remember(key(call)) }
        primed = true
    }

    /// O que falar agora. `chime` liga sempre que há chamada nova, mesmo quando a fala se cala pela rajada.
    func announce(_ calls: [StationCall]) -> PanelAnnouncement {
        if !primed {
            prime(calls)
            return .silent
        }
        let pending = calls.filter { $0.status == "calling" && remember(key($0)) }
        if pending.isEmpty { return .silent }
        // A volta da rede depois de uma queda traz a fila inteira de uma vez; falar tudo deixaria o painel recitando
        // senhas por um minuto. A fala vai na ordem da chamada e, no limite, fica com as mais recentes.
        let chronological = Array(PanelCalls.ordered(pending).reversed())
        if pending.count >= Self.silentBurstThreshold {
            return PanelAnnouncement(chime: true, spoken: [], latest: chronological.last)
        }
        return PanelAnnouncement(
            chime: true,
            spoken: chronological.suffix(Self.maxSpokenPerCycle).map(Self.announcementText),
            latest: chronological.last
        )
    }

    /// A mesma senha chamada de novo volta a ser falada: a rechamada soma `call_count`.
    private func key(_ call: StationCall) -> String { "\(call.ticketId)@\(call.calledAt ?? "")#\(call.recalls)" }

    /// `true` quando a chave ainda não tinha sido anunciada.
    private func remember(_ key: String) -> Bool {
        guard !announcedSet.contains(key) else { return false }
        announced.append(key)
        announcedSet.insert(key)
        if announced.count > Self.historyLimit {
            announcedSet.remove(announced.removeFirst())
        }
        return true
    }

    /// `A024` vira `A 24`, para o sintetizador ler "senha A vinte e quatro", que é como a senha se fala no balcão.
    static func spokenTicketNumber(_ publicNumber: String) -> String {
        let value = publicNumber.trimmingCharacters(in: .whitespaces).uppercased()
        let letters = value.prefix { $0.isLetter && $0.isASCII }
        let digits = value.dropFirst(letters.count)
        guard (1...4).contains(letters.count), (1...6).contains(digits.count), digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return value }
        let number = digits.drop { $0 == "0" }
        return "\(letters.map(String.init).joined(separator: " ")) \(number.isEmpty ? "0" : String(number))"
    }

    static func announcementText(_ call: StationCall) -> String {
        let number = spokenTicketNumber(call.publicNumber)
        let desk = call.stationLabel?.trimmingCharacters(in: .whitespaces) ?? ""
        return desk.isEmpty ? "Senha \(number)." : "Senha \(number). \(desk)."
    }
}

/// O PIN do painel e do totem: quem passa na frente da tela não tira o painel do ar nem o cala. É deste aparelho, não do
/// servidor: protege os botões, não a credencial. Quatro números, digitados em pé na frente da TV. Guarda-se só o
/// resumo com sal.
enum PanelPin {
    static let length = 4

    /// O que está errado com o PIN escolhido, ou `nil` quando serve.
    static func problem(_ pin: String) -> String? {
        guard pin.count == length, pin.allSatisfy({ $0.isASCII && $0.isNumber }) else { return "O PIN tem \(length) números." }
        let digits = pin.compactMap { $0.wholeNumberValue }
        let repeated = Set(digits).count == 1
        let steps = Set(zip(digits, digits.dropFirst()).map { $1 - $0 })
        let sequence = steps == [1] || steps == [-1]
        return repeated || sequence ? "Escolha um PIN menos óbvio." : nil
    }

    /// `sal:resumo`, os dois em Base64; o PIN nunca é guardado.
    static func seal(_ pin: String) -> String {
        var salt = Data(count: 16)
        let ok = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        if ok != errSecSuccess { salt = Data(UUID().uuidString.utf8.prefix(16)) }
        return "\(salt.base64EncodedString()):\(digest(salt, pin).base64EncodedString())"
    }

    static func matches(_ pin: String, sealed: String) -> Bool {
        let parts = sealed.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let salt = Data(base64Encoded: String(parts[0])), let expected = Data(base64Encoded: String(parts[1])) else { return false }
        let actual = digest(salt, pin)
        // Comparação em tempo constante.
        guard actual.count == expected.count else { return false }
        return zip(actual, expected).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// Muitas voltas: quatro números são 10 mil tentativas, e o resumo barato cairia em um instante.
    private static func digest(_ salt: Data, _ pin: String) -> Data {
        var value = salt + Data(pin.utf8)
        for _ in 0..<20_000 { value = Data(SHA256.hash(data: salt + value)) }
        return value
    }
}

/// Cinco erros seguidos travam o PIN por 30 segundos; um acerto zera.
final class PanelPinAttempts {
    static let maxFailures = 5
    static let lockSeconds: TimeInterval = 30
    private let clock: () -> Date
    private var failures = 0
    private var lockedUntil = Date.distantPast

    init(clock: @escaping () -> Date = Date.init) { self.clock = clock }

    var locked: Bool { clock() < lockedUntil }

    /// Conta um erro; devolve até quando fica travado, quando trava.
    @discardableResult
    func fail() -> Date? {
        failures += 1
        guard failures >= Self.maxFailures else { return nil }
        failures = 0
        lockedUntil = clock().addingTimeInterval(Self.lockSeconds)
        return lockedUntil
    }

    func succeed() { failures = 0 }
}

/// O destino da chamada em duas partes: o rótulo pequeno ("Guichê") e o valor grande ("3"). O número curto no fim é o
/// que a pessoa procura na sala; sem ele, o destino inteiro vira o valor e o rótulo diz a direção.
enum PanelDestination {
    struct Parts: Equatable { var label: String; var value: String; var long: Bool }

    static func split(_ stationLabel: String?) -> Parts {
        let text = stationLabel?.trimmingCharacters(in: .whitespaces) ?? ""
        if text.isEmpty { return Parts(label: "Dirija-se ao", value: "Balcão", long: true) }
        if let cut = text.lastIndex(of: " ") {
            let token = String(text[text.index(after: cut)...])
            if (1...3).contains(token.count), token.contains(where: \.isNumber) {
                return Parts(label: String(text[..<cut]).trimmingCharacters(in: .whitespaces), value: token, long: false)
            }
        }
        return Parts(label: "Dirija-se ao", value: text, long: text.count > 3)
    }
}

/// A cor da fila (0 a 3) vem só da letra, para a mesma fila ter a mesma cor no totem, no painel e no híbrido. As
/// iniciais mais comuns no balcão têm lugar fixo, para Caixa e Geral, ou Geral e Preferencial, nunca dividirem a cor.
enum PanelQueueLetter {
    private static let common: [Character] = Array("AGCPENRB")

    static func of(_ publicNumber: String) -> Character? {
        guard let first = publicNumber.first, first.isLetter else { return nil }
        return Character(first.uppercased())
    }

    static func colorIndex(_ letter: Character?) -> Int {
        guard let letter = letter.map({ Character($0.uppercased()) }) else { return 0 }
        if let fixed = common.firstIndex(of: letter) { return fixed % 4 }
        return Int(letter.unicodeScalars.first?.value ?? 0) % 4
    }
}

/// Quanto tempo o cartão da senha fica no totem: menos com o cupom na mão, mais sem papel (para fotografar).
func issuedCardSeconds(printed: Bool) -> TimeInterval { printed ? 20 : 60 }
