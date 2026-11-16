# Licenças do app iOS

A pasta `mobile/` é MIT (texto em `Wabotia/Resources/Licenses/Wabotia-LICENSE.txt`, copiado do `LICENSE` MIT do
repositório). Nenhuma biblioteca GPL ou AGPL entra nos apps. Ajustes → **Licenças** mostra os textos abaixo, que vão no
pacote do app (`Wabotia/Resources/Licenses`, conferido por `LicensesTests`).

## Bibliotecas linkadas no app

Levantamento de 16/11/2026: produtos do Swift Package Manager efetivamente linkados (os pacotes que só aparecem no
`Package.resolved` do Firebase, como gRPC, abseil, leveldb e GoogleAppMeasurement, não entram no app).

| Componente | Versão resolvida | Licença | Texto no app |
|---|---|---|---|
| Firebase iOS SDK (FirebaseMessaging, FirebaseCore, FirebaseCoreInternal, FirebaseInstallations) | 11.15.0 | Apache 2.0 | `firebase-ios-sdk-LICENSE.txt` |
| GoogleDataTransport | 10.1.1 | Apache 2.0 | `GoogleDataTransport-LICENSE.txt` |
| GoogleUtilities (AppDelegateSwizzler, Environment, Logger, NSData, Network, Reachability, UserDefaults), com `third_party/IsAppEncrypted` | 8.1.5 | Apache 2.0; IsAppEncrypted MIT (Landon J. Fuller) | `GoogleUtilities-LICENSE.txt` (o arquivo oficial já traz os dois) |
| Promises (FBLPromises) | 2.4.1 | Apache 2.0 | `promises-LICENSE.txt` |
| nanopb | 2.30910.1 | zlib | `nanopb-LICENSE.txt` |
| ThermalPrinterKit e Printher | caminho local | componente próprio | — |

Os textos são os arquivos `LICENSE`/`LICENSE.txt` oficiais de cada pacote, copiados das cópias baixadas pelo Swift
Package Manager nas versões acima. Nenhum desses pacotes tem arquivo `NOTICE`. Ao atualizar o Firebase, confira os
produtos linkados (`*.bundle` dentro de `Wabotia.app`) e copie de novo os `LICENSE` das versões novas.

## Fontes, ícones e sons

- **Fontes:** nenhuma embutida; o app usa a fonte do sistema (SF Pro).
- **Ícones:** SF Symbols do sistema; o ícone do app é próprio.
- **Sons:** nenhum arquivo; o gongo do painel é gerado pelo próprio app (`PanelAudio.chimeWAV`) e a voz é a do iOS.
