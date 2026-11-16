import CoreLocation
import Foundation
import UIKit

/// Situação da permissão de localização, do jeito que o modo entregador precisa.
enum CourierLocationAuth: Equatable { case notDetermined, allowed, denied }

/// A fonte das posições: o GPS de verdade ou a simulação da demonstração.
@MainActor
protocol CourierLocating: AnyObject {
    var authorization: CourierLocationAuth { get }
    var onPoint: ((CourierPoint) -> Void)? { get set }
    var onAuthorization: ((CourierLocationAuth) -> Void)? { get set }
    func requestPermission()
    /// `near`: alta precisão (perto do destino); longe, equilíbrio entre precisão e bateria.
    func start(near: Bool, toward destination: CourierCoordinate?)
    func stop()
    /// Nível da bateria, de 0 a 100 (`nil` quando o sistema não informa).
    var battery: Int? { get }
}

/// GPS com a permissão **Quando em uso** e nada em segundo plano: a posição só é lida com o app aberto na entrega
/// (sem `UIBackgroundModes` de localização, sem "Sempre"). Distância mínima de 25 m entre leituras.
@MainActor
final class SystemCourierLocation: NSObject, CourierLocating, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    var onPoint: ((CourierPoint) -> Void)?
    var onAuthorization: ((CourierLocationAuth) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.distanceFilter = 25
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = true
        UIDevice.current.isBatteryMonitoringEnabled = true
    }

    var authorization: CourierLocationAuth { Self.map(manager.authorizationStatus) }

    nonisolated static func map(_ status: CLAuthorizationStatus) -> CourierLocationAuth {
        switch status {
        case .authorizedWhenInUse, .authorizedAlways: return .allowed
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestPermission() { manager.requestWhenInUseAuthorization() }

    func start(near: Bool, toward destination: CourierCoordinate?) {
        manager.desiredAccuracy = near ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        manager.startUpdatingLocation()
    }

    func stop() { manager.stopUpdatingLocation() }

    var battery: Int? {
        let level = UIDevice.current.batteryLevel
        return level < 0 ? nil : Int((level * 100).rounded())
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = Self.map(manager.authorizationStatus)
        Task { @MainActor in self.onAuthorization?(status) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let points = locations.map {
            CourierPoint(t: Int64($0.timestamp.timeIntervalSince1970 * 1000), lat: $0.coordinate.latitude, lng: $0.coordinate.longitude,
                         accuracy: $0.horizontalAccuracy, speed: $0.speed >= 0 ? $0.speed : nil)
        }
        Task { @MainActor in points.forEach { self.onPoint?($0) } }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

/// Demonstração: o "entregador" anda em direção ao destino a cada `step` segundos, sem pedir a permissão do sistema e
/// sem ler o GPS (a posição é inventada e nada sai do aparelho).
@MainActor
final class SimulatedCourierLocation: CourierLocating {
    var onPoint: ((CourierPoint) -> Void)?
    var onAuthorization: ((CourierLocationAuth) -> Void)?
    private(set) var authorization: CourierLocationAuth = .notDetermined
    private var task: Task<Void, Never>?
    private var position = CourierCoordinate(lat: -23.5505, lng: -46.6333)
    private let step: TimeInterval
    /// Metros por passo.
    private let stride: Double
    let battery: Int? = 76

    init(step: TimeInterval = 3, stride: Double = 220) {
        self.step = step
        self.stride = stride
    }

    func requestPermission() {
        authorization = .allowed
        onAuthorization?(.allowed)
    }

    func start(near: Bool, toward destination: CourierCoordinate?) {
        task?.cancel()
        let target = destination
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled, let self {
                if let target {
                    let d = self.position.distance(to: target)
                    let f = d <= self.stride ? 1 : self.stride / d
                    self.position = CourierCoordinate(lat: self.position.lat + (target.lat - self.position.lat) * f,
                                                      lng: self.position.lng + (target.lng - self.position.lng) * f)
                }
                self.onPoint?(CourierPoint(t: Int64(Date().timeIntervalSince1970 * 1000), lat: self.position.lat, lng: self.position.lng, accuracy: 12, speed: 8))
                try? await Task.sleep(nanoseconds: UInt64(self.step * 1_000_000_000))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
