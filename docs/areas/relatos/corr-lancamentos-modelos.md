| Achado | Veredito | O que mudou / evidência | Teste |
|---|---|---|---|
| 1 — Recuperação de lançamentos | Não é real atualmente | Integração já corrigiu: `src/coordinator.ts:231` permite retomar; `entries/store.ts:222` chama novamente `commitChild`. | Recuperação pelo Coordinator passou no script local. |
| 1 — Recuperação de modelos | Confirmado e não corrigido | Depende de outra peça. Permanecem bloqueio no Coordinator, descarte do identificador em `area-templates/index.ts:68` e `preview_stale` em `engine.ts:195`. | Confirmado por leitura; falha não reproduzida em execução. |
| 2 — Menus embutidos / afastamento de seleção | Confirmado e corrigido | [engine.ts](/Volumes/Dev/wabotia/codex/corr-lancamentos-modelos/src/area-templates/engine.ts:128) respeita a seleção, preserva menus existentes e permite inclusão posterior. | Dois casos acrescentados em `tests/os-area-templates.test.ts`: seleção posterior e OS desligada. |
| 3 — Expectativas provisórias de `501` | Não é real atualmente | `tests/os-entries.test.ts:113` e `:125` já verificam persistência real e `404 type_not_found`. | Acrescentei rollback transacional com `commitChild` real, sem alterar os casos existentes. |
| Suspeita — Ator de módulo | Confirmado e corrigido | [store.ts](/Volumes/Dev/wabotia/codex/corr-lancamentos-modelos/src/modules/os/entries/store.ts:17) aplica visibilidade pública também a `actor.module`. | Acrescentado caso pela API entre módulos: paginação, soma e recusa de arquivamento interno. |
| Afastamento — Resumo histórico | Confirmado e não corrigido | Complemento intencional documentado em `entries/README.md:74`; padrão exclui originais corrigidos. | Acrescentado caso: total vigente `2000`, histórico `3000`. |
| Afastamento — Versão do manifesto | Confirmado e não corrigido | Mantida proteção contra downgrade e alteração sem incrementar versão (`engine.ts:163`), já declarada na entrega A. | Caso existente em `tests/os-area-templates.test.ts:326`. |

Passaram: `npx tsc --noEmit`, `node scripts/check-os-integration.mjs` — 17 modelos, recuperação e orçamento D1 —, verificações de codificação, conflitos e `git diff --check`. Arquivos alterados sem CRLF. **Os cinco testes novos aguardam Vitest externo**; não executei Vitest nem Wrangler.

Mudanças que ficaram para outras peças:

- **F0 — `src/coordinator.ts`:** permitir retomada de `area-template.apply` com recibo incompleto, após existir recuperação durável.
- **F0 — `src/service.ts`:** persistir referência, resultado e publicações pendentes no mesmo lote da configuração; recuperar eventos com chaves estáveis.
- **Continuação em A:** encaminhar o identificador em `index.ts` e recuperar a operação confirmada em `engine.ts` antes de revalidar a prévia. Alterar apenas A não resolve o caminho completo.

Sem migração, recurso Cloudflare, commit, push ou troca de branch. Pendência de contrato: formalizar o resumo histórico e a política de versões.