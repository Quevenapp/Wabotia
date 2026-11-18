Corrigi cinco achados; um já estava resolvido na junção. Dois dependem de arquivo fora da peça.

| Achado | Veredito | O que mudou | Teste |
|---|---|---|---|
| 1 — Resposta ambígua cancela trabalho | Confirmado e corrigido | `stage-replies.ts`: distingue decisões simultâneas e exige identificação do fluxo. | Regressões de texto, números e botões. |
| 2 — `/stage` rejeita embutido | Confirmado e corrigido | `stages.ts`, `store.ts`, `motor-routes.ts`: encaminham às operações legadas, preservando efeitos e permitindo recuperação. | Todas as transições anunciadas, garantia, histórico e repetição HTTP. |
| 3 — Recuperação bloqueada | Não é real atualmente | Já corrigido em [coordinator.ts:231](/Volumes/Dev/wabotia/codex/corr-motor/src/coordinator.ts:231). | Acrescentada regressão HTTP específica de `os.stage`. |
| 4 — Aprovação encerrada intercepta orçamento | Confirmado e corrigido | `stage-replies.ts`: somente aprovação pendente captura resposta sem `ETAPA`. | Quatro estados encerrados. |
| 5 — Decisão ignora autorização de mensagem | Confirmado e corrigido | `motor-routes.ts` e `stages.ts`: propagam `notifyCustomer`. | Aplicação sem atendimento, incluindo recuperação. |
| 6 — Expansão excede transporte | Confirmado e corrigido | `store.ts` e `stages.ts`: limitam mensagens personalizadas com reticências, preservando Unicode. | Expansão ASCII/emoji, lembretes e pedido de aprovação. |
| 7 — Opções escondidas | Confirmado e não corrigido | Dependência de `src/web-steps.ts`, fora da peça. | Conferência dos limites no código. |
| 8 — Texto limitado a 300 | Confirmado e não corrigido | Mesma dependência externa. | Conferência da validação e renderização. |
| Suspeita sobre `model.ts` | Não é real | [model.ts:1](/Volumes/Dev/wabotia/codex/corr-motor/src/modules/os/model.ts:1) está idêntico a `0b280f7`. | Comparação Git sem diferenças. |

As regressões foram adicionadas somente em [os-work-types.test.ts](/Volumes/Dev/wabotia/codex/corr-motor/tests/os-work-types.test.ts) e [os-compatibility.test.ts](/Volumes/Dev/wabotia/codex/corr-motor/tests/os-compatibility.test.ts). Os afastamentos do contrato correspondem aos mesmos vereditos acima.

Passaram: `npx tsc --noEmit`, checagem TypeScript adicional dos dois testes, `node scripts/check-os-integration.mjs`, guardas de codificação/conflitos e `git diff --check`. Arquivos com LF. **As regressões novas aguardam execução externa; não rodei Vitest nem Wrangler.**

Ficou para integração fora desta peça:

- **Achado 7:** em `src/web-steps.ts`, aceitar seleção com 1–32 opções; depois ajustar `forms.ts` para usar seleção e converter respostas em todo esse intervalo.
- **Achado 8:** em `src/web-steps.ts`, preservar `max_length` opcional na definição, validação e renderização, mantendo os padrões legados quando ausente; depois propagá-lo em `forms.ts`.

Sem migração, commit, push ou troca de branch. Sem dúvidas adicionais.