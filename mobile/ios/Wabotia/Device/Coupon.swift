import Foundation
import SwiftUI
import ThermalPrinterKit
import Printher

/// O que vai no cupom; separado da senha para o teste montar sem rede.
struct CouponData: Equatable {
    var header: String
    var queueName: String
    var code: String
    var preferential: Bool
    /// Milissegundos Unix.
    var issuedAt: Int64
    var ahead: Int
    /// `nil` quando a fila não mostra estimativa (`wait_mode: off`): o cupom fala só das pessoas à frente.
    var waitMinutes: Int?
    /// `https://wa.me/...?text=SENHA N023 AB12CD`; liga a senha ao WhatsApp do cliente.
    var whatsappLink: String?
    /// Documento, endereço e telefone do estabelecimento, abaixo do nome.
    var headerLines: [String] = []
    /// Rodapé do estabelecimento, no fim do cupom.
    var footerLines: [String] = []
    /// `false` tira "pessoas à sua frente" do cupom.
    var showPosition = true

    /// Com o cupom da área (`QueueOverview.coupon`, servidor com `queue_coupon`), ele manda: cabeçalho do
    /// estabelecimento só quando vier (nulo = sem cabeçalho, nem o nome do aparelho), posição se ligada, rodapé se
    /// vier. Servidor antigo, sem `coupon`: o cupom de antes, com o estabelecimento de `GET /establishment` (ou o nome
    /// do aparelho, `header`). O QR sai sempre que o servidor manda `whatsapp_link`; ele já o anula com o QR
    /// desligado ou sem linha de WhatsApp com número.
    static func of(_ ticket: QueueTicket, header: String, establishment: Establishment? = nil, coupon: QueueCoupon? = nil) -> CouponData {
        var data = CouponData(
            header: establishment?.displayName ?? header,
            queueName: ticket.queueName ?? "",
            code: ticket.code ?? "",
            preferential: ticket.isPreferential,
            issuedAt: ticket.createdAt ?? Int64(Date().timeIntervalSince1970 * 1000),
            ahead: ticket.ahead ?? 0,
            waitMinutes: ticket.waitMinutes,
            whatsappLink: ticket.whatsappLink.flatMap { $0.hasPrefix("https://") ? $0 : nil },
            headerLines: establishment?.headerLines ?? [],
            footerLines: establishment?.footerLines ?? []
        )
        if let coupon {
            let shop = coupon.establishment
            data.header = shop?.displayName ?? ""
            data.headerLines = shop?.headerLines ?? []
            data.footerLines = Establishment(footer: coupon.footer).footerLines
            data.showPosition = coupon.position ?? true
        }
        return data
    }
}

/// As linhas do cupom, em texto: o que o teste confere, o que a tela mostra e o que o cupom imprime.
enum CouponText {
    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        f.dateFormat = "dd/MM/yyyy HH:mm"
        return f
    }()

    static func type(_ data: CouponData) -> String { data.preferential ? "PREFERENCIAL" : "NORMAL" }

    static func issued(_ data: CouponData) -> String {
        "Emitida em \(clock.string(from: Date(timeIntervalSince1970: TimeInterval(data.issuedAt) / 1000)))"
    }

    static func position(_ data: CouponData) -> String {
        let wait = data.waitMinutes.map { " · cerca de \($0) min" } ?? ""
        switch data.ahead {
        case ...0: return "Você é o próximo"
        case 1: return "1 pessoa à sua frente\(wait)"
        default: return "\(data.ahead) pessoas à sua frente\(wait)"
        }
    }

    /// Abaixo do QR; combina com a mensagem que o servidor deixa escrita ("Aperte ENVIAR para ser chamado pelo WhatsApp.").
    static let whatsapp = "Aponte a câmera do celular para o QR e aperte ENVIAR no WhatsApp: avisamos quando for a sua vez"
}

/// O cupom da senha (porta do `SenhaTicketReceipt` do Android): empresa, fila, tipo, número em corpo triplo, hora,
/// pessoas à frente e o QR do WhatsApp. Largura, página de código e corte vêm do `ReceiptLayout` (perfil da impressora).
final class SenhaTicketReceipt: ThermalReceiptPayload {
    private var data: CouponData?

    init(_ data: CouponData) { self.data = data }

    func receiptBytes(layout: ReceiptLayout) -> Data? {
        guard let d = data, let big = ThermalTextSize(widthMultiplier: 3, heightMultiplier: 3) else { return nil }
        let center: UInt8 = 1
        var out = Data()
        if !d.header.trimmingCharacters(in: .whitespaces).isEmpty {
            out.append(layout.text(layout.wrap(d.header) + "\n", alignment: center, bold: true, size: .normal))
        }
        for line in d.headerLines { out.append(layout.text(layout.wrap(line) + "\n", alignment: center, bold: false, size: .normal)) }
        if !d.queueName.trimmingCharacters(in: .whitespaces).isEmpty {
            out.append(layout.text(layout.wrap(d.queueName) + "\n", alignment: center, bold: false, size: .normal))
        }
        out.append(layout.text("SENHA \(CouponText.type(d))\n", alignment: center, bold: true, size: .normal))
        // Corpo triplo: a senha se lê de longe e é o que a pessoa compara com o painel.
        out.append(layout.text(layout.wrap(d.code, size: big) + "\n", alignment: center, bold: true, size: big))
        out.append(layout.text(CouponText.issued(d) + "\n", alignment: center, bold: false, size: .normal))
        if d.showPosition {
            out.append(layout.text(layout.wrap(CouponText.position(d)) + "\n", alignment: center, bold: false, size: .normal))
        }
        // Um link longo demais para a largura do papel (texto do wa.me comprido) não vira QR: a senha sai mesmo assim,
        // sem o QR, em vez de o cupom inteiro falhar.
        if let link = d.whatsappLink, let qr = layout.qr(payload: link) {
            out.append(qr)
            out.append(layout.text(layout.wrap(CouponText.whatsapp) + "\n", alignment: center, bold: false, size: .normal))
        }
        for line in d.footerLines { out.append(layout.text(layout.wrap(line) + "\n", alignment: center, bold: false, size: .normal)) }
        out.append(layout.finish())
        return out
    }

    func clear() { data = nil }
}

/// O que o totem diz do cupom da senha que acabou de mandar.
enum TicketPrint: Equatable {
    case printing
    case printed
    /// Não saiu, ou talvez tenha saído: quando a transmissão começou e não terminou (`indeterminate`), a segunda via
    /// pede confirmação humana, para não saírem dois papéis com a mesma senha.
    case failed(message: String, reprintNeedsConfirmation: Bool)
    /// Nenhuma impressora escolhida neste aparelho: a senha fica só na tela.
    case noPrinter

    static func of(_ result: ThermalPrintResult) -> TicketPrint {
        switch result {
        case .delivered: return .printed
        case let .failed(message, delivery): return .failed(message: message, reprintNeedsConfirmation: delivery == .indeterminate)
        }
    }

    var isFailure: Bool { if case .failed = self { return true } else { return false } }
}

/// Quem imprime o cupom: a impressora do kit no app, um falso nos testes.
@MainActor
protocol CouponPrinting: AnyObject {
    var hasPrinter: Bool { get }
    func print(_ data: CouponData) async -> TicketPrint
}

#if DEBUG
/// Atalho de depuração `WABOTIA_DEVICE_PRINT=off`: nada vai à impressora; o cupom é registrado no console.
@MainActor
final class NoCouponPrinter: CouponPrinting {
    var hasPrinter: Bool { false }
    func print(_ data: CouponData) async -> TicketPrint {
        Swift.print("[Wabotia] aparelho: cupom sem imprimir (WABOTIA_DEVICE_PRINT=off): cabeçalho \"\(data.header)\" \(data.headerLines), posição \(data.showPosition ? CouponText.position(data) : "desligada"), rodapé \(data.footerLines), QR \(data.whatsappLink == nil ? "não" : "sim")")
        return .noPrinter
    }
}
#endif

/// A impressora térmica deste aparelho: uma só configuração do kit para o app inteiro (a escolhida fica no Keychain do
/// kit, só neste aparelho). Resultado incerto nunca reimprime sozinho.
@MainActor
final class WabotiaPrinting: CouponPrinting {
    static let shared = WabotiaPrinting()

    /// Criada na primeira vez que alguém precisa dela (abrir o kit custa ler o Keychain e readotar a impressora).
    private(set) lazy var configuration = ThermalPrinterConfiguration()

    var hasPrinter: Bool { !configuration.coordinator.adoptedPrinters.isEmpty }

    func print(_ data: CouponData) async -> TicketPrint {
        guard hasPrinter else { return .noPrinter }
        return TicketPrint.of(await configuration.coordinator.print(SenhaTicketReceipt(data)))
    }

    /// A superfície do kit com as cores do Wabotia (mobile/DESIGN.md), claras e escuras.
    static let theme = ThermalPrinterTheme(
        primary: Theme.brand,
        primarySurface: Color(light: 0xE7F5F1, dark: 0x103A33),
        background: Theme.background,
        surface: Theme.surface,
        text: Theme.textPrimary,
        secondaryText: Theme.textSecondary,
        success: Theme.ok,
        warning: Theme.warn,
        danger: Theme.danger
    )
}

/// A tela de impressora do kit (Bluetooth LE e Wi-Fi local no iOS), com o tema do Wabotia e um topo para voltar.
struct PrinterScreen: View {
    let onClose: () -> Void
    @ObservedObject private var printer = WabotiaPrinting.shared.configuration

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Impressora do cupom").font(Theme.font(17, .semibold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Button("Pronto", action: onClose).font(Theme.font(16, .semibold)).foregroundStyle(Theme.brand)
                    .frame(minHeight: Theme.touch)
            }
            .padding(.horizontal, 16)
            .background(Theme.bar.ignoresSafeArea(edges: .top))
            .overlay(alignment: .bottom) { ThinDivider() }
            ThermalPrinterView(printer: printer, theme: WabotiaPrinting.theme)
        }
        .background(Theme.background.ignoresSafeArea())
    }
}
