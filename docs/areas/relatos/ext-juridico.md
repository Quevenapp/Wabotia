Implementado em **20 arquivos novos**, sem alterar arquivos existentes.

- `src/modules/juridico/`: calendários, contagem, tarefas sensíveis, memórias, recálculo, conferência e avisos.
- `web/modules/juridico/`: tela Prazos, cadastro de calendários e simulação.
- Migrações `0106–0108`: persistência e proteção das tarefas.
- `tests/juridico-*.test.ts`: regras, isolamento, papéis, privacidade e avisos.

O **relato por arquivo e as linhas exatas de registro para o integrador** estão em [JURIDICO.md](/home/bruno/wabotia/codex/ext-juridico/docs/JURIDICO.md:74). Os registros não foram aplicados.

Verificações aprovadas: `npx tsc --noEmit`, `node scripts/juridico-check.mjs` e `git diff --check`. O script conferiu cálculo, migrações em SQLite, proteções e UTF-8/LF. Vitest e Wrangler não foram executados.

Desvios do rascunho: avisos na caixa interna do painel, acesso por área e regras preservadas em cada memória. Consulta aos tribunais ficou somente documentada. Pendem integração, testes externos e validação visual; o advogado deve conferir a aplicabilidade dos calendários/regras e a suficiência dos avisos internos.