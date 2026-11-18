Entregue em **23 arquivos novos**, sem alterar arquivos existentes.

- `src/modules/ensino/`: `definition.ts` declara dependência e papéis; `access.ts` protege acessos; `store.ts` gerencia turmas e vínculos; `model.ts` calcula notas; `diary.ts` registra frequência e boletins; `customer.ts` atende responsáveis; `notices.ts` gerencia comunicados; `ensino.ts` e `openapi.ts` exportam os contratos de integração.
- Migrações `0112`, `0113` e `0114`: tabelas aditivas, todas com `profile_id`.
- `web/modules/ensino/`: `EnsinoPage.tsx`, `ClassForm.tsx`, `ResponsiblePage.tsx`, `shared.tsx` e `ensino.css` implementam as telas.
- `tests/ensino-{model,orders,whatsapp}.test.ts` e `ensino-fixture.ts`: testes preparados para o verificador externo.
- `scripts/ensino-verify.mjs`: verificação offline; `docs/ENSINO.md`: guia completo.

**Validação:** `npx tsc --noEmit` passou. O script offline passou nos cálculos, frequência, DDL, chaves compostas, capacidade, rollback e UTF-8/LF. Vitest e Wrangler não foram executados.

As **linhas exatas de registro por arquivo** estão no [guia do integrador](/Volumes/Dev/wabotia/codex/ext-ensino/docs/ENSINO.md:67); não foram aplicadas.

Desvios principais: reaproveitamento de matrículas/pessoas, consulta por credencial temporária e comunicados protegidos com aviso genérico no WhatsApp. Motivos detalhados no [guia](/Volumes/Dev/wabotia/codex/ext-ensino/docs/ENSINO.md:153).

Ficaram fora censo, histórico oficial, PDF, integração financeira/Agenda e calendário automático. Integração real, validação visual e suíte D1/Coordinator permanecem pendentes. Nenhuma dúvida bloqueante; pesos, justificadas e política de guarda dependem da escola.