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
| 2 | Instância `erp:` sem afetar a área | **passou** |
| 3 | Pacote candidato | **passou** (alerta: 18,3 MB sem o ERP) |
| 4 | Esquema completo gerado, paridade, aplicado no objeto | **passou** |

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
| `sqlite_version()` | `not authorized` | Nenhuma (só diagnóstico) |

## Prova 2 — instância `erp:` ao lado da área (`tests/erp-do-instance.test.ts`)

Mudança mínima em `src/coordinator.ts`: `/erp-*` desviado no topo do
`fetch`, antes de `request.json()` e de gravar o perfil; `alarm()` desvia na
primeira linha quando o KV tem `kind="erp"`; uma instância do ERP que recebe
rota da área responde 404. O resto mora em `src/erp/hub.ts`:

- `erpStub(env, área)` = `idFromName("erp:" + área)` com `locationHint: "sam"`;
  `erpFetch` manda a área no cabeçalho `x-erp-profile`.
- Na primeira chamada grava `kind="erp"` e `erp_profile` (nunca `profile`) e
  aplica o esquema. **O objeto enxerga o próprio nome** (`ctx.id.name` =
  `"erp:<área>"`, conferido no workerd local): só a instância com o nome certo
  atende aquela área (`409 erp_wrong_instance`). Sem nome, vale a reserva:
  instância que já gravou `profile` nunca vira ERP. A primeira versão da trava
  (só pelo `profile`) falhava com uma instância de área nunca chamada: o teste
  pegou e a trava passou a ser pelo nome.

| Verificação | Resultado |
|---|---|
| Alarme da instância `erp:` com o D1 contado (`countingEnv`) | **0 instruções** no D1 |
| `inbox` pendente e `outbox` da área depois do alarme do ERP | iguais |
| A área drena a mensagem depois | normal (resposta na `outbox`) |
| KV `profile` na instância do ERP | ausente |
| Tabela `erp_meta` na instância da área | ausente |
| Outra área, instância de área, rota da área, sem cabeçalho | 409, 409, 404, 400 |

Testes de alarme e do vínculo Hermes seguem verdes (`module-schedule`,
`hermes-link`).

## Prova 3 — pacote candidato (`scripts/erp/check-candidate.mjs`)

`node scripts/release.mjs --candidate` (já existia; não alterado) e depois
`node scripts/erp/check-candidate.mjs`, que compila `src/release.ts` sem
alteração e roda `parsePackage` sobre o candidato e `validateInstalledSettings`
sobre a configuração de uma instalação 0.20.0 (DB, MEDIA, COORDINATOR,
ASSETS, MASTER_KEY, `migration_tag` v1). Também compara `wrangler.jsonc` com o
do `origin/main` (bindings, `durable_migrations`, flags): idênticos.

| Medida (com a prova 2, antes do esquema) | Valor |
|---|---|
| Pacote | 18.323.864 bytes (teto atual 20 MB; 24 MB depois da ponte) |
| Módulo principal (sem `--minify`) | 8.918.587 bytes, 1 módulo |
| Estáticos / migrações D1 | 18 / 46 |

**Alerta:** o pacote atual já usa 87% do teto das instalações até a 0.17.0.
O ERP não cabe sem a versão ponte (sessão R). Medição com o ERP na prova 7.

## Prova 4 — esquema completo gerado

| Etapa | Arquivo | Resultado |
|---|---|---|
| Migrações congeladas | `tests/erp/oracle/migrations/` + `MANIFEST.json` | 347 arquivos, 7.809.351 bytes, SHA-256 por arquivo (`freeze-migrations.mjs --check`) |
| Oráculo | `scripts/erp/oracle-db.mjs` | PGlite 0.5.10, 346 migrações (088 pulada) em **10,2 s**; cache do diretório de dados em `output/erp-oracle/` |
| Introspecção | `scripts/erp/introspect.mjs` → `src/erp/schema/catalog.json` (3,6 MB) | 49 schemas, 430 tabelas, 3.784 colunas, 2.933 restrições (sem NOT NULL), 863 índices, 388 gatilhos, 2.368 funções |
| Geração | `scripts/erp/gen-sqlite.mjs` + `overrides.mjs` | 973 instruções; tabelas `STRICT` `schema__tabela` |
| Paridade | `tests/erp/schema-parity.test.mjs` (`npm run test:erp`) | 7 de 7, ~26 s |
| No objeto | `tests/erp-do-schema.test.ts` | 430 tabelas, 786 índices, 296 gatilhos SQLite; 23.062 linhas escritas; 6,4 MB; ~0,95 s locais na primeira chamada |

Conversão (contagens de `src/erp/schema/report.generated.json`):

| O quê | Resultado |
|---|---|
| Colunas | 3.784 com codec; nenhuma sem tipo. `numeric` sem escala (20): escala declarada em `overrides.mjs` (preço 10 casas, quantidade 6) — **decisão a confirmar pelo domínio** |
| `bigint` | INTEGER com `CHECK(abs(x) <= 2^53-1)`, lido como número (contadores, centavos) |
| `numeric(p≤15)` / `(16–18)` / `(>18)` | INTEGER escalado / idem com teto 2^53 / i64 lido como TEXT |
| CHECK | 991 traduzidos para SQL e **provados por comportamento**: 10.397 avaliações com os mesmos valores nos dois motores, zero divergência (89 valores que o próprio Postgres recusa no tipo ficam de fora). 233 com regex viram `RegExp` em TS, conferidos contra o `~` do Postgres. **227 pendentes**, com motivo (aritmética decimal, `lower`/`upper`, funções do Fagoo, tempo relativo, arrays): validação em TS no porte do domínio |
| UNIQUE / PK | 201 / 430, iguais |
| FK | 512 mantidas; 327 para `auth.users`/`storage` removidas (ator do Wabotia e R2); **22 `DEFERRABLE` viram imediatas** (prova 1): o porte confere a ordem de escrita |
| Índices | 231 criados (104 parciais traduzidos), 16 colunas normalizadas ou calculadas pelo motor (`fold`, `lower`, funções do Fagoo), 1 GIN descartado |
| Gatilhos | **148 gerados em SQL** (só lançam erro: `RAISE(ABORT,'<sqlstate>:<mensagem>')`, um por evento); **240 pendentes** (PL/pgSQL; 12 são gatilhos de restrição adiados, que viram conferência no fim da transação em TS) |
| Padrões | constantes no DDL; `now()`/`clock_timestamp()`, `gen_random_uuid()` e 7 expressões preenchidos pelo motor (`columns.generated.ts`) |
| Semeadura | 30 tabelas, 7.586 linhas (municípios, CNAE, países, definições de preferência…), aplicada com FKs adiadas e `foreign_key_check` antes do fim da transação |

A prova por comportamento pegou um erro real do tradutor (`jsonb ? 'chave'`
com JSON nulo: nulo no Postgres, falso no SQLite) e um erro do próprio teste
(decimais escalados passados como texto comparam em ordem alfabética; na
coluna `STRICT` viram inteiro). Os dois corrigidos.
