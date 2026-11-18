A causa da falha é uma corrida de relógio em [tests/os-integration-scenarios.ts:1092](/Volumes/Dev/wabotia/codex/corr-api-apps/tests/os-integration-scenarios.ts:1092): duas chamadas a `now()` podem produzir `remind_at > due_at`. A API rejeita corretamente esse corpo com `400 invalid_task`.

Preparei a [correção pontual](/tmp/corr-api-apps-d1-clock.patch), usando um único instante para prazo e lembrete. **Ainda não a apliquei:** esse arquivo está fora da peça autorizada; a pergunta de autorização permanece pendente.

| Achado | Veredito | O que mudou / pendência | Teste |
|---|---|---|---|
| 1. `/stage` rejeita ações anunciadas do embutido | Confirmado e não corrigido | O servidor continua exigindo snapshot personalizado. Correção pertence ao motor. | Conferência de `stages.ts:61` e `work-types.ts:106`. |
| 2. Operações sensíveis documentadas nas rotas comuns | Confirmado e corrigido | OpenAPI, API.md e TRABALHOS.md documentam famílias privadas, corpos e permissões. | Cobertura dos descritores e separação de corpos comuns/privados. |
| 3. `/status` exclui `received` | Confirmado e corrigido | Esquema aceita o destino personalizado e explica as restrições do embutido. | Aceitação de `received` e rejeição dos destinos incompatíveis. |
| 4. Histórico personalizado incompatível | Confirmado e corrigido no contrato; não corrigido na apresentação móvel | Esquema aceita eventos novos; fixtures distinguem detalhe e `/history`. Apps ainda mostram códigos como `os.task.created`. | Validação dos dois formatos e caracterização móvel da limitação. |
| 5. Apps oferecem orçamento desativado | Confirmado e não corrigido | Acrescentada fixture inicial de lavanderia sem orçamento; código de produção móvel está fora da peça. | Caracterização de `canEditQuote` incorretamente verdadeiro em `received`. |
| 6. Paginação e busca fictícias | Confirmado e corrigido | Simuladores respeitam busca, limite e cursor; segunda página distinta; listas sem histórico ou facetas não solicitadas. | Conteúdo, ausência de duplicação, contagens globais e busca vazia. |
| 7. Exemplos inconsistentes | Confirmado e corrigido | Exemplos específicos para criação e cliente; transições, ordenação e cursor corrigidos. | Projeção pública, estado/versão inicial e coerência das listas. |
| 8. Leituras omitidas | Confirmado e corrigido | Publicados `my-tasks` e `entries/summary`, filtros, autorização e soma textual exata. | Conferência dos descritores e esquemas. |
| 9. MIME incorreto no download | Confirmado e corrigido | Downloads documentam os MIME permitidos e preservam `no-store`. | Comparação com `DOCUMENT_MIME_TYPES`, nas famílias comum e privada. |
| 10. Erros ausentes | Confirmado e corrigido | Acrescentados `template_not_found` e `document_not_ready` nas operações correspondentes. | Verificação das descrições e exemplos de erro. |
| Falha atual do cenário D1 | Confirmado e não corrigido no arquivo | Patch pronto; preserva asserções, 12 tarefas e tetos D1. Aguarda autorização de escopo. | Reprodução determinística confirma falha com duas leituras e sucesso com instante único. |

Não há suspeitas adicionais na revisão. Os afastamentos contratuais referentes à documentação, `/status`, rotas adicionais e fixtures foram tratados; permanecem a execução de `/stage` do embutido e as limitações móveis acima.

Mudanças que ficam para outras peças:

- **Motor:** em [stages.ts:61](/Volumes/Dev/wabotia/codex/corr-api-apps/src/modules/os/stages.ts:61), resolver transições virtuais do embutido pelas operações legadas correspondentes, preservando suas regras e efeitos.
- **Android/iOS:** nos respectivos `ServiceOrderClient.kt` e `ServiceOrderClient.swift`, apresentar eventos novos com rótulos legíveis e condicionar orçamento à capacidade confirmada da definição fixada.
- **corr-f0, ou esta rodada mediante autorização:** aplicar o patch do cenário D1.

**Verificação:** TypeScript passou com `npx --no-install tsc --noEmit` em modo offline; `git diff --check`, comparação dos oito pares de fixtures e análise sintática Swift passaram. Android e testes nativos completos não foram executados. O log externo registra **356 aprovados e 1 falha**, incluindo **15/15 do OpenAPI aprovados**; não comprova aprovação integral após a correção proposta.

Sem commit, rede, execução de Vitest ou migração nesta rodada.