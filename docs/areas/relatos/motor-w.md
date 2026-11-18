Implementei as telas da W, preservando as telas legadas da OS.

- `web/modules/os/`: cliente tipado, lista por tipo/etapa, detalhe com abas paginadas, prazos, editor, campos restritos e conversa.
- `web/admin/area-templates/`: catálogo, prévia, aplicação e importação/exportação.
- Rotas, `AdminArea`, navegação e menus: integração por tipo.
- `tests/os-web-work.test.ts`: 14 testes novos; existentes intactos.

**Verificação:** `npx tsc --noEmit` e `npm run build` passaram. Build com avisos de chunks e React Router. Escopo, UTF-8/LF e `git diff --check` conferidos. Vitest e Wrangler não executados.

**Pendências:** confirmar a API agregada de “Meus prazos”, integrar os nomes no trilho/Mais e validar os fluxos com os servidores das demais tarefas.

O [relato por arquivo, com linhas exatas para o integrador e todas as diferenças/lacunas do contrato](/Volumes/Dev/wabotia/codex/motor-w/web/modules/os/W-ENTREGA.md) está no repositório.

Sem commit, push, troca de branch, migração ou alteração nos arquivos centrais.