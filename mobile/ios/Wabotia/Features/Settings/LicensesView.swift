import SwiftUI

/// O que o app embute de terceiros e a licença de cada um (inventário em mobile/ios/LICENSES-IOS.md). Os textos são os
/// arquivos oficiais de cada projeto, copiados para `Resources/Licenses` e lidos do pacote do app.
struct OpenSourceComponent: Identifiable, Equatable {
    let id: String
    let name: String
    let detail: String
    let license: String
    /// Nome do arquivo em `Resources/Licenses` (sem `.txt`); `nil` quando não há texto a distribuir.
    let file: String?

    var text: String? {
        guard let file, let url = Bundle.main.url(forResource: file, withExtension: "txt") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    static let all: [OpenSourceComponent] = [
        OpenSourceComponent(id: "wabotia", name: "Wabotia (este app)", detail: "Código dos apps em mobile/",
                            license: "MIT", file: "Wabotia-LICENSE"),
        OpenSourceComponent(id: "firebase", name: "Firebase iOS SDK", detail: "FirebaseMessaging, FirebaseCore, FirebaseCoreInternal e FirebaseInstallations (avisos)",
                            license: "Apache 2.0", file: "firebase-ios-sdk-LICENSE"),
        OpenSourceComponent(id: "googledatatransport", name: "GoogleDataTransport", detail: "Dependência do Firebase",
                            license: "Apache 2.0", file: "GoogleDataTransport-LICENSE"),
        OpenSourceComponent(id: "googleutilities", name: "GoogleUtilities", detail: "Dependência do Firebase, com IsAppEncrypted (MIT, Landon J. Fuller)",
                            license: "Apache 2.0 e MIT", file: "GoogleUtilities-LICENSE"),
        OpenSourceComponent(id: "promises", name: "Promises (FBLPromises)", detail: "Dependência do Firebase",
                            license: "Apache 2.0", file: "promises-LICENSE"),
        OpenSourceComponent(id: "nanopb", name: "nanopb", detail: "Dependência do Firebase",
                            license: "zlib", file: "nanopb-LICENSE"),
    ]
}

/// Ajustes → Licenças.
struct LicensesView: View {
    let onClose: () -> Void

    var body: some View {
        NavigationView {
            List {
                Section {
                    ForEach(OpenSourceComponent.all) { c in
                        NavigationLink { LicenseTextView(component: c) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.name).font(Theme.font(16)).foregroundStyle(Theme.textPrimary)
                                Text("\(c.license) · \(c.detail)").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                            }
                            .padding(.vertical, 2)
                        }
                        .accessibilityIdentifier("licenses.\(c.id)")
                    }
                } footer: {
                    Text("Fontes, ícones e sons: o app usa a fonte e os símbolos do sistema (SF Pro e SF Symbols, da Apple) e a voz do iOS; o gongo do painel é gerado pelo próprio app. Nada disso vem de terceiros embutido no app. A impressão térmica usa o ThermalPrinterKit, componente próprio.")
                }
            }
            .navigationTitle("Licenças")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("OK", action: onClose) }
            }
        }
        .navigationViewStyle(.stack)
    }
}

private struct LicenseTextView: View {
    let component: OpenSourceComponent

    var body: some View {
        ScrollView {
            Text(component.text ?? "Texto da licença indisponível.")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(component.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
