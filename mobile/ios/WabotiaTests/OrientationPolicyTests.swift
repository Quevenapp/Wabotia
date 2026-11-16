import XCTest
import ThermalPrinterKit
@testable import Wabotia

final class OrientationPolicyTests: XCTestCase {
    func testIPhoneServiceAppStaysPortrait() {
        XCTAssertEqual(OrientationPolicy.mask(idiom: .phone, deviceMode: false), .portrait)
    }

    func testIPhoneDeviceModeAllowsLandscape() {
        let mask = OrientationPolicy.mask(idiom: .phone, deviceMode: true)
        XCTAssertTrue(mask.contains(.landscapeLeft))
        XCTAssertTrue(mask.contains(.landscapeRight))
        XCTAssertTrue(mask.contains(.portrait))
    }

    func testIPadAllowsEverythingInBothModes() {
        XCTAssertEqual(OrientationPolicy.mask(idiom: .pad, deviceMode: false), .all)
        XCTAssertEqual(OrientationPolicy.mask(idiom: .pad, deviceMode: true), .all)
    }

    /// O kit entra no app como pacote local: o tipo público do resultado da impressão está ao alcance.
    func testThermalPrinterKitIsLinked() {
        let result: ThermalPrintResult = .failed(message: "x", delivery: .notSent)
        XCTAssertNotEqual(result, .delivered)
    }
}
