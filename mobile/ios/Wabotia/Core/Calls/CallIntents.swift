import Foundation

/// Intenção pendente entre telas. A aba Ligações marca aqui a chamada que a pessoa tocou em "Atender"
/// antes de empilhar `Route.call`; a CallView consome o valor ao abrir e inicia o atendimento.
/// Sem a marca (abertura por push, deep link ou histórico) a CallView mostra Atender/Recusar.
enum CallIntents {
    /// Lida e escrita apenas na main thread (SwiftUI e view models @MainActor).
    static var answerCallId: String?
}
