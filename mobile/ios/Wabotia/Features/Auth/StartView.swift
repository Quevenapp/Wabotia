import SwiftUI

/// Depois do endereço do servidor: entrar com a conta de pessoa (o fluxo de sempre) ou fazer deste aparelho um totem ou
/// painel de chamadas, fora do login, pelo pareamento com código.
struct StartView: View {
    @EnvironmentObject private var container: AppContainer

    var body: some View {
        AuthScaffold(title: "Wabotia", subtitle: container.session.serverURL?.host ?? "Atendimento pelo WhatsApp com a sua equipe e os seus bots.") {
            PrimaryButton(title: "Entrar", icon: "person.crop.circle") { container.loginChosen = true }
                .accessibilityIdentifier("start.login")
            Text("Para quem atende: conversas, protocolos, equipe e o guichê da fila de senhas.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            SecondaryButton(title: "Usar este aparelho como painel ou totem", icon: "tv") { container.openDeviceMode() }
                .padding(.top, 10)
                .accessibilityIdentifier("start.device")
            Text("Para um tablet ou TV na recepção: retirar senha e imprimir o cupom, mostrar as chamadas com voz, ou os dois. Sem conta de pessoa: um administrador aprova o aparelho por um código.")
                .font(Theme.font(13)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            Button("Trocar servidor") { container.onLoggedOut(keepServer: false) }
                .font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.touch)
        }
    }
}
