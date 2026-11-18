Criei somente arquivos novos de teste:

- `ServiceOrderMotorCompatibilityTest.kt` e `ServiceOrderMotorCompatibilityTests.swift`: decodificação, estado de base, ações antigas, contagens esparsas, cursor e numeração.
- Em ambos os diretórios de fixtures: `motor-builtin-quoted.json`, `motor-builtin-approved.json`, `motor-custom-order.json`, `motor-mixed-page.json` e `motor-empty-page.json`.

Deixei desativadas as contraprovas de número textual, cursor objeto, contagens por etapa, etapa em `status`/`next_statuses`, comprovante de `approved` e, no iOS, histórico de orçamento enviado.

Verificações: `npx tsc --noEmit`, verificador de conflitos e `git diff --check` passaram. Os 10 JSON são válidos; pares Android/iOS idênticos; arquivos com LF e sem BOM.

Não rodei nem compilei os testes móveis; revisei a sintaxe manualmente. Produção e testes existentes permaneceram intactos.

**Registros para o integrador:** nenhum.

**Desvio/pendência:** fixtures construídas pelo contrato/F0, sem captura das respostas reais de M/O. Essa comparação fica para a integração. Sem outras dúvidas.