# Atribuições de terceiros

A licença do projeto está em [LICENSE](LICENSE) (servidor e painel web,
AGPL-3.0), com as exceções de [mobile/LICENSE](mobile/LICENSE) e
[connectors/LICENSE](connectors/LICENSE) (MIT); o resumo está em
[NOTICE](NOTICE). Ela não substitui licenças, marcas, avisos ou condições de
materiais de terceiros. Materiais de terceiros mantêm as próprias licenças.

## Código derivado

| Material | Origem | Licença |
| --- | --- | --- |
| Regras de atendimento e extensão de entrada exclusiva | WABABOTAI | [MIT](LICENSES/MIT-WABABOTAI.txt) |
| Hermes Agent | NousResearch; serviço externo, não distribuído aqui | MIT |

## Pacotes npm

As dependências do servidor e do painel, com versões e integridade, estão em
[package-lock.json](package-lock.json); as do gateway de notificações, em
[push-gateway/package-lock.json](push-gateway/package-lock.json); as do
conector QR, em [connectors/qr/package-lock.json](connectors/qr/package-lock.json).
Cada pacote traz o próprio texto de licença em `node_modules/<pacote>`.
Inventário de licenças com os textos encontrados: pendente (o Fagoo usa
`tools/qa/audit-distribution.mjs`, que entra com o código dele).

## Fontes

| Fonte | Onde | Licença |
| --- | --- | --- |
| Anton, Archivo, Atkinson Hyperlegible, B612, Lexend, Overpass | App Android (`mobile/android/app/src/main/res/font`), painel do aparelho | SIL OFL 1.1 |

**Pendência:** o comentário de `PanelTheme.kt` cita os textos das licenças
em `assets/licencas-fontes`, mas essa pasta não está no repositório. A OFL
exige o texto da licença junto com a fonte distribuída: os arquivos precisam
entrar com o app.

### Painel do ERP (entra com o código do Fagoo)

Quando o painel do ERP (`web/erp/`) entrar, acrescentar, a partir de
`THIRD_PARTY_NOTICES.md` do Fagoo:

| Fonte | Origem e versão | Licença |
| --- | --- | --- |
| Manrope | Fontsource variable 5.3.0; família de Mikhail Sharanda e colaboradores | SIL OFL 1.1 (texto em `web/erp/app/fonts/Manrope-OFL.txt`) |
| Source Sans 3 | Fontsource variable 5.3.1; Adobe | SIL OFL 1.1 (texto em `web/erp/app/fonts/SourceSans3-OFL.txt`) |

Pacotes de origem, sem alteração:

- https://registry.npmjs.org/@fontsource-variable/manrope/-/manrope-5.3.0.tgz
- https://registry.npmjs.org/@fontsource-variable/source-sans-3/-/source-sans-3-5.3.1.tgz

## Arquivos de ferramentas

| Material | Licença |
| --- | --- |
| Gradle Wrapper (`mobile/android/gradlew`, `gradlew.bat`) | Apache-2.0 (cabeçalho preservado) |
