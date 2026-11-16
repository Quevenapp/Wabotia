import XCTest
@testable import Wabotia

/// Cada componente listado em Ajustes → Licenças tem o texto oficial no pacote do app.
final class LicensesTests: XCTestCase {
    func testEveryComponentShipsItsLicenseText() throws {
        for c in OpenSourceComponent.all {
            let text = try XCTUnwrap(c.text, "\(c.name): o texto da licença precisa estar no pacote do app")
            XCTAssertGreaterThan(text.count, 500, c.name)
        }
        let byId = Dictionary(uniqueKeysWithValues: OpenSourceComponent.all.map { ($0.id, $0) })
        XCTAssertTrue(byId["firebase"]?.text?.contains("Apache License") == true)
        XCTAssertTrue(byId["googleutilities"]?.text?.contains("Landon J. Fuller") == true, "o IsAppEncrypted (MIT) vai junto")
        XCTAssertTrue(byId["nanopb"]?.text?.contains("Petteri Aimonen") == true)
        XCTAssertTrue(byId["wabotia"]?.text?.hasPrefix("MIT License") == true, "mobile/ continua MIT")
    }

    func testNoCopyleftComponent() {
        for c in OpenSourceComponent.all {
            XCTAssertFalse(c.license.uppercased().contains("GPL"), "\(c.name): nada GPL/AGPL nos apps")
            XCTAssertFalse(c.text?.contains("GNU GENERAL PUBLIC LICENSE") ?? false, c.name)
            XCTAssertFalse(c.text?.contains("GNU AFFERO") ?? false, c.name)
        }
    }
}
