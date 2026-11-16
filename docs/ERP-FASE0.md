# ERP (Fagoo) no Wabotia — fase 0: as provas

Portão do porte em massa (PLANO-FAGOO.md; roteiro em PLANO-FAGOO-MOTOR.md,
seção 7). Branch `feat/erp-motor`, a partir do `origin/main` `4ea7864`.
Ambiente das provas: Windows 11, Node 22.23, `@cloudflare/vitest-plugin`
1.5.1 (workerd local de `wrangler` 4.157.0, `compatibility_date`
2026-11-04). **Local não é produção:** o workerd é o mesmo motor, mas os
limites configurados pela Cloudflare em produção só se confirmam na
instalação de teste (sessão K).

| # | Prova | Resultado |
|---|---|---|
| 1 | Sonda de dialeto no objeto `erp:` | **passou**, com 4 regras de conversão alteradas |

## Prova 1 — sonda de dialeto (`tests/erp-do-dialect.test.ts`)

Código rodado dentro de uma instância `idFromName("erp:" + uid())` da classe
`Coordinator`, com `state.storage.sql` e `state.storage.transactionSync`
(`runInDurableObject` do `cloudflare:test`). As asserções fixam o
comportamento observado; `ERP_PROBE_PRINT=1 npx vitest run
tests/erp-do-dialect.test.ts --disableConsoleIntercept` imprime tudo.

| Item | Observado | Regra |
|---|---|---|
| `STRICT` | Texto não numérico e real em `INTEGER` são recusados (`SQLITE_CONSTRAINT_DATATYPE`); `'42'` vira inteiro 42 | Mantida: tabelas `STRICT` |
| Gatilho `RAISE(ABORT,'código')` | Lança `"<código>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"`; a linha não muda | Mantida; o motor extrai o código pelo prefixo antes de `": SQLITE_"` |
| Índice parcial | `UNIQUE … WHERE status='open'` recusa o segundo aberto; o plano usa o índice | Mantida |
| Coluna gerada | `VIRTUAL` e `STORED` funcionam em `STRICT` | Mantida |
| `->>`, `->`, `json_each` | `->>` devolve texto/número SQL, `->` o JSON; `IN (SELECT value FROM json_each(?))` com 10.000 itens num parâmetro | Mantida: listas por `json_each(?)` |
| `CHECK(json_valid(x))` | Funciona | Mantida |
| `transactionSync` aninhado | **Funciona como savepoint**: a de dentro que lança desfaz só a sua parte; a de fora continua e grava; a de fora que lança desfaz tudo; devolve o valor da função | Mantida. Os 48 `exception when others` podem virar `try { transactionSync(...) } catch` |
| `BEGIN`, `SAVEPOINT` em SQL | Recusados ("use transactionSync") | Mantida |
| i64 gravado como texto | `'9007199254740993'` (2^53+1) é gravado exato; `CAST(v AS TEXT)` devolve exato | Mantida |
| i64 lido como número | **Perde precisão sem erro**: 2^53+1 volta 9007199254740992 | **Mudou:** toda coluna i64 (`numeric(30,10)`, custos) é **sempre** lida por `CAST(… AS TEXT)`; o driver recusa `SELECT *` em tabela com coluna i64 (codec por coluna gerado) |
| `BigInt` como parâmetro | **Recusado** ("Cannot convert a BigInt value to a number") | **Mudou:** `Dec`/BigInt viram string no parâmetro; o `STRICT` converte para inteiro |
| `SUM` acima de i64 | `integer overflow: SQLITE_ERROR` | Mantida: soma lida como `CAST(SUM(x) AS TEXT)`; estouro vira erro 22003 |
| FKs | `PRAGMA foreign_keys` = 1 por padrão; violação imediata falha **na instrução** (o resto da invocação fica) | Mantida |
| FKs adiadas (`defer_foreign_keys` ou `DEFERRABLE INITIALLY DEFERRED`) | Corrigidas dentro da transação: passam. **Sem correção: o commit não lança; o objeto é reiniciado e desfaz a invocação inteira** ("Durable Object was reset and rolled back to its last known good state") | **Mudou:** o gerador **não emite `DEFERRABLE`**; o motor não liga `defer_foreign_keys`, salvo num RPC que comprovadamente precisa, e aí roda `PRAGMA foreign_key_check` antes de sair da transação e lança (provado: desfaz só a transação) |
| Parâmetros | 100 passam; 101: `too many SQL variables` | Mantida (lotes de até 100; listas por `json_each`) |
| Profundidade de expressão | `?+?+…` com 101 termos: `Expression tree is too large (maximum depth 100)` | **Nova:** o conversor quebra cadeias longas de `OR`/`+`/`CASE` (por exemplo filtros montados) em `IN (json_each)` ou em TS |
| `LIKE`/`GLOB` | Padrão de 50 bytes passa; maior: `LIKE or GLOB pattern too complex` | Mantida: busca por `instr()` em coluna normalizada |
| Argumentos de função | `json_array` com 40 argumentos passou no local | Mantida a regra conservadora de 32 (o limite documentado de produção), sem prova contrária em produção |
| Texto de 2 MB numa linha | Grava | Mantida (limite de 8 MB por valor) |
| `cursor.rowsRead`/`rowsWritten` | Disponíveis | Mantida: teto de linhas lidas por RPC |
| `RETURNING`, `ON CONFLICT … DO UPDATE`, janelas, `WITH RECURSIVE`, `floor`/`ceil`, `unixepoch` | Funcionam | — |
| `lower`/`upper`, `COLLATE NOCASE` | Só ASCII (`lower('ÁÉÇ')` = `ÁÉÇ`; `'Ação' = 'AÇÃO' COLLATE NOCASE` falso) | Mantida: coluna normalizada em TS |
| `PRAGMA user_version` | `not authorized` | Mantida: versão do esquema em `erp_meta` |
