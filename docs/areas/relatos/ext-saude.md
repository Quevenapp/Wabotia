Implementei a extensão em **19 arquivos novos**, sem alterar arquivos existentes.

- `definition.ts` e `model.ts`: dependência de `os`, papéis clínicos, bloqueio integral do bot e validações.
- `access.ts` e `store.ts`: autorização, criptografia, auditoria, pacientes/animais, evoluções, adendos, prescrições e exames.
- `documents.ts`, `export.ts` e `retention.ts`: anexos sensíveis, exportação auditada e descarte condicionado à guarda.
- `saude.ts`: descritores para integração.
- `SaudePage.tsx` e `saude.css`: painel clínico e controles do responsável técnico.
- Migrações `0109–0111`: tabelas e proteções aditivas.
- `tests/saude-*`: fixture e três suítes.
- `check-saude.mjs` e `SAUDE.md`: verificação offline e guia.

**Verificações:** `npx tsc --noEmit`, `node scripts/check-saude.mjs` e `git diff --check` passaram. Vitest e Wrangler não foram executados; os testes dependem da verificação externa.

As **linhas exatas de registro, por arquivo**, estão em [SAUDE.md:154](/Volumes/Dev/wabotia/codex/ext-saude/docs/SAUDE.md:154). Não foram aplicadas.

Afastei-me do desenho usando registros clínicos unificados, papéis por área e metadados próprios de anexos sobre o transporte binário da F0. Isso evita histórico e eventos comuns do motor. O descarte é explícito e retomável.

Ficaram fora receita legal, certificado digital, habilitação profissional, acesso por paciente, entrega a representantes e alterações no backup. Permanecem pendentes a definição institucional do prazo de guarda e a medição de exportações grandes.