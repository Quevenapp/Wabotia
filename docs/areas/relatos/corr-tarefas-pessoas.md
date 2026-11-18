Corrigi os achados locais. **A corrida de privacidade permanece pendente**, pois exige alteração fora desta peça.

| Achado | Veredito | O que mudou | Teste |
|---|---|---|---|
| 1 — Corrida de privacidade; seção 6 | Confirmado e não corrigido | Enfileiramento ainda precede a conferência da versão. Depende de `corr-f0`. | Confirmado por inspeção; concorrência não executada. |
| 2 — Lembretes bloqueados; continuidade F0 | Confirmado e corrigido | `tasks/reminders.ts`: cursor durável por área no R2 existente, com avanço e novas tentativas. | Dez impedidos seguidos de notificável; recuperação de falhas. |
| 3 — Troca de responsável repete aviso | Confirmado e corrigido | `tasks/store.ts` e `tasks/reminders.ts`: responsável interno não reinicia nem altera a deduplicação do aviso ao cliente. | Troca antes/depois da marcação; aviso à equipe preservado. |
| 4 — Horário UTC | Confirmado e corrigido | `tasks/reminders.ts`: português e `America/Sao_Paulo`. | Dois horários próximos da meia-noite. |
| 5 — Modelo de outra etapa bloqueia | Confirmado e corrigido | `tasks/stages.ts`: verificações operacionais somente na etapa atual; validação estrutural mantida para todas. | Sigilo, responsável removido, destinatário e estrutura inválida. |
| 6 — Expectativa antiga de 501 | Não é real atualmente | Já exige 409 em `tests/os-tasks.test.ts:130`. Acrescentei cobertura do motor real. | Filho, histórico, atividade e repetição idempotente. |
| 7 — Mock não comprova atomicidade | Confirmado e corrigido | `tests/os-people.test.ts`: falha por gatilho dentro da transação real; mock identificado apenas como propagação de erro. | Reversão de filho, histórico e pai; recuperação posterior. |
| Suspeita — Reentrada de etapa | Não é real como defeito demonstrado | `tasks/stages.ts:55` identifica cada entrada pela versão; não existe regra normativa contrária. | Comportamento preservado no teste existente. |
| Suspeita — Orçamento completo ausente | Não é real atualmente | Cobertura já existe em `tests/os-integration-scenarios.ts:1169`. | Ensaio local: **163/800 instruções**. |
| Contrato — Rotas privadas | Confirmado e não corrigido | Divergência documental; mantive a proteção das operações privadas. | Consumidor web já utiliza `private-tasks`. |

Os testes novos estão em `tests/os-tasks.test.ts` e `tests/os-people.test.ts`; **aguardam Vitest externo**.

Executei com sucesso: `npx tsc --noEmit`, `node scripts/check-os-integration.mjs`, `node scripts/check-encoding.mjs` e `git diff --check`. O ensaio mediu **45/200 instruções nos filhos**.

Mudanças para outras peças:

- **corr-f0 — `src/coordinator.ts`:** serializar `runModuleSchedules` com os comandos do mesmo Coordinator, cobrindo seleção até enfileiramento; testar reclassificação, conclusão, cancelamento e arquivamento concorrentes.
- **corr-api-apps/especificação:** atualizar `docs/areas/CONTRATO-MOTOR.md`, documentação pública e OpenAPI para explicitar `private-tasks` e a recusa de dados sensíveis nas operações comuns.

Sem migrações, recursos novos, alterações em testes legados ou operações Git de escrita. Dúvida normativa restante: geração de tarefas por reentrada; comportamento atual preservado.