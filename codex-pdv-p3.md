# PDV P3 — devolução

Implementado `public.erp_pos_return_execute` conforme a migração 292, que substitui a 206. A busca em todas as migrações não encontrou redefinição posterior do RPC nem dos ajudantes usados por ele.

## Alterações por arquivo

- `src/erp/domains/pos/rpc/return.ts`: novo RPC registrado. Inclui validações e recusas com SQLSTATE/mensagem, recibo e repetição, conflito de comando, auditoria, limite de 20 devoluções, rateio com `Dec`/`bigint` e restante na última devolução do item. Reintegra estoque via `invokeRpc("erp_stock_post")`, reembolsa via `invokeRpc("erp_finance_cash_execute")` e usa `documentTitleRows(db, posting)` e `titlesMarkReturned(ctx, actor, command, titles, source)` pelo `finance/public.ts`. Parcelas abertas ficam Devolvido somente ao completar a venda; parcelas parcialmente recebidas bloqueiam. JSON e hashes usam a ordenação de `jsonbText`.
- `src/erp/domains/pos/internal.ts`: recebeu o ajudante comum `erp_pos.step`, sem mudança na fórmula MD5.
- `src/erp/domains/pos/rpc/sale.ts`: somente moveu `step()` para o arquivo comum e passou a importá-lo.
- `src/erp/domains/pos/index.ts`: importa o RPC de devolução.
- `tests/erp/pos/return-diff.test.mjs`: sete casos diferenciais abrangem devolução parcial/total, restante e frete, 20 devoluções, limite do recebido, parcelas Devolvido, baixa parcial com rollback, efeitos pendentes, perfis, repetição/conflito, auditoria e validações de ausência/null/tipos.
- `tests/erp/pos/gate.test.mjs`: inclui `erp_pos_return_execute` na lista de RPCs portados.
- `codex-pdv-p3.md`: este relato.

## Funções portadas e reutilizadas

Nova função portada: `public.erp_pos_return_execute` (292). `erp_pos.step` (204) foi compartilhada. Reutilizados os portes existentes de `access`, `keys`, `txt`, `uid`, `int`, `today`, `usable_session`, `sale_view`, `returned` e `returns_view`, com seus ajudantes transitivos. As definições relevantes desses ajudantes permanecem nas migrações 204 e 206.

## Verificação

Todos os comandos abaixo terminaram com código 0:

- `npx tsc --noEmit`: sem erros.
- `node --no-warnings --test tests/erp/fagoo/pos-returned-titles-sql.test.mjs`: passou.
- `node --no-warnings --test tests/erp/pos/return-diff.test.mjs`: passou.
- `node --no-warnings --test tests/erp/pos/gate.test.mjs`: passou.
- `node --no-warnings --test --test-concurrency=3 "tests/erp/pos/**/*.test.mjs" tests/erp/fagoo/pos-*.test.mjs tests/erp/fagoo/documents-document-scope-effects-sql.test.mjs`: 8 arquivos passaram, zero falhas.

`git diff --check` passou. A verificação adicional `node scripts/check-encoding.mjs` não concluiu: o ambiente recusou seu subprocesso `git ls-files` com `spawnSync git EPERM`. A inspeção direta com `file` identificou os sete arquivos de código/testes/relato como texto UTF-8, sem indicação de BOM ou CRLF.

## Desvios, limites e dúvidas

Nenhum desvio deliberado do oráculo e nenhuma divergência observada de hash/ID ou arquitetura. A definição 292 não contém `exception when`: não foi introduzido `attempt()`; as recusas desfazem a transação da chamada. Ela também não chama `erp_finance_execute` diretamente.

Não foram alterados os originais do Fagoo, harness, outros domínios, migrações, `reads.ts` ou `settings.ts`. Não foram criados recursos Cloudflare. Não foram executados Vitest, Wrangler, comandos de rede, commit, push ou troca de branch. Testes fora da suíte solicitada ficaram de fora. Nenhuma função pública faltante e nenhuma dúvida pendente.
