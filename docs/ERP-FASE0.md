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
| 5 | Motor mínimo e diferencial | **passou** para `erp_reference_search` e `erp_stock_post`; **`erp_document_save` não portado** (190 funções, 180 KB: tamanho de domínio, não de prova) |
| 6 | Costura (`createHandler` sem alteração, rota real) | **passou** |
| 7 | Medições | **passou** com ressalvas: `erp_document_save` não medido (proxy: `erp_stock_post` com 100 itens); CPU de produção só na instalação de teste |
| 8 | Backup | **passou** (dump e restauração); recuperação por bookmark **não deu para provar** no local |

**Veredito do portão:** a instância extra, o `transactionSync` e o
diferencial são viáveis; nenhuma parada foi necessária. O porte em massa
pode começar, com quatro condições: `--minify` obrigatório no pacote (e a
versão ponte), relatórios pesados fora da transação de escrita (teto de
linhas lidas e jobs em fatias), o `erp_document_save` como primeira tarefa do
domínio Documentos sobre o harness pronto, e a confirmação na instalação de
teste (CPU real, limites e bookmark).

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

## Prova 5 — motor mínimo e diferencial

**Motor** (`src/erp/engine/`, só TypeScript apagável: o Node dos testes
importa direto):

| Arquivo | O quê |
|---|---|
| `driver.ts` | `SqlDriver` síncrono; `storageDriver(ctx.storage)` no objeto |
| `errors.ts` | `ErpError(code, message)` com o SQLSTATE do Postgres; `fromSqlite` traduz `RAISE(ABORT,'<sqlstate>:<msg>')` e restrições |
| `dec.ts` | decimal exato em BigInt na escala da coluna, arredondamento metade para longe do zero |
| `time.ts` | relógio monotônico em µs, dia em America/Sao_Paulo pelo `Intl`, texto de `timestamptz` do jsonb, argumento `date` com os códigos do Postgres (22007 formato, 22008 data inexistente) |
| `json.ts` | `jsonbText`: o texto canônico do `jsonb` (chaves por tamanho e bytes, `", "` e `": "`), para o hash de pedido igual ao do Fagoo |
| `receipt.ts` | recibo de comando (mesmo ator e hash devolve o gravado; senão 40001) |
| `registry.ts` | `registerRpc`, `callRpc`: uma transação por RPC, contexto no lugar de `set_config` |
| `rpc-endpoint.ts` | `/erp-rpc/<nome>` no objeto |
| `dump.ts` | backup (prova 8) |

**Portados** (`src/erp/domains/`): `reference/rpc/erp_reference_search.ts`;
`stock/rpc/erp_stock_post.ts` + `stock/internal.ts` (fecho de 27 funções,
13 em PL/pgSQL: validação, hash do pedido, comando idempotente, movimento,
saldo com versão, lançamentos, `movement_dto`, e os gatilhos de guarda
`guard_negative_insert`, `guard_reserved_balance`, `capture_stock`,
`reverse_lot_entries` na camada de tabela); `access/public.ts` e
`sync/public.ts` (o que os dois usam de acesso e do espelho).

**Harness** (`tests/erp/harness/`): `dual-fixture.mjs` (mesma interface das
62 fixtures do Fagoo: `rpc`, `scalar`, `db`, `users`, `catalog`),
`state-compare.mjs` (resposta e tabelas; correspondência de ids gerados;
tempo e identity mascarados; erros por código e mensagem), `node-driver.mjs`
(o mesmo contrato do objeto sobre `node:sqlite`, recusando BigInt e booleano
como parâmetro, como o objeto). RPC não portado roda só no Postgres e o
estado é espelhado; RPC portado roda nos dois, compara e realinha.

| Teste (`npm run test:erp`, 15 de 15) | Resultado |
|---|---|
| `tests/erp/fagoo/stock-adversarial.test.mjs` (cópia de `tools/migration/test_stock_adversarial.mjs`, 5 asserções originais) | **passa nos dois motores**, estado igual tabela a tabela depois de cada `erp_stock_post` |
| `tests/erp/fagoo/reference-search.test.mjs` (consultas do teste "PRF-296, CTT-045, VND-042" do `plataforma-h-sql`) | passa nos dois motores, mais 13 buscas com acento, prefixo, dígitos e limites |
| `tests/erp/stock-post-diff.test.mjs` (aleatório, semente fixa) | 200 chamadas: 138 aceitas, 62 recusadas em 12 erros diferentes; 680 tabelas comparadas; zero divergência. ~3,8 ms por chamada no motor contra ~10,9 ms no PGlite (Node local) |

O diferencial pegou, até ficar verde: a regra do `numeric(18,6)` (abaixo); o
fuso do oráculo (PGlite herda o da máquina; produção é UTC); 22008 × 22007 em
data inexistente; e a ordem das conferências (o tipo do argumento falha antes
do corpo da função, antes até do acesso). Também separou o que **não** é
divergência: o identity do Postgres não reaproveita números de transações
desfeitas, o `rowid` do SQLite reaproveita (ninguém deve depender do valor).

**`erp_document_save` não foi portado.** Fecho medido por
`scripts/erp/call-graph.mjs`: 190 funções (114 em PL/pgSQL), 180 KB, escreve
em 25 tabelas; só o núcleo (`normalize`, `normalize_core`, `permission_keys`,
`validate_data`, `document_product`, `extension_data`, `write_fields`,
`transitions`) passa de 70 KB. É o domínio Documentos, não uma prova. Fica
como a primeira tarefa da sessão de Documentos, sobre o harness pronto.

## Prova 6 — costura (`tests/erp-do-api.test.ts`)

`/api/v1/profiles/:profile/erp/*` (`src/index.ts`, uma rota; pessoa com
acesso à área) → `src/erp/api/local-fetch.ts` → `createHandler` da erp-api
**sem alteração** (`src/erp/fagoo/workers/erp-api`, copiada por
`scripts/erp/copy-fagoo.mjs` com as dependências que ela alcança: 229
arquivos, 3,0 MB, mais `@xmldom/xmldom` 0.9.12) com `fetchImpl` local:
`/rest/v1/rpc/<nome>` → objeto `/erp-rpc/<nome>`; `/auth/v1/user` → o ator do
Wabotia; `/storage/v1` → 501 até o R2.

| Verificação | Resultado |
|---|---|
| `GET …/erp/v1/plataforma/referencias/cnae?q=4744`, municípios, país inválido | 200, 200, 400 |
| `POST …/erp/v1/estoque/movimentos` (rota de escrita do Fagoo) | lança no motor; saldo `2.500000`, versão 1 |
| Pessoa da área sem vínculo `erp_access` | 403 (42501 traduzido pela erp-api) |
| Latência local Worker → erp-api → objeto → motor | primeira 53 ms; depois p50 9 ms, p95 12 ms |

O vínculo `erp_access.membership` foi semeado no teste: o sincronismo com
Pessoas e os papéis `erp:<papel>` são da fase 3.

## Prova 7 — medições (workerd local)

| Medida | Valor | Observação |
|---|---|---|
| `erp_stock_post`, 50 itens | 26–40 ms | proxy do `erp_document_save` (não portado) |
| `erp_stock_post`, 100 itens (máximo) | 36–61 ms | ~110 KB de banco por chamada |
| Carga de 100 mil lançamentos | 400 mil linhas escritas (com índices), ~5–6 s | |
| Relatório: saldo por produto e depósito sobre 100 mil linhas | **1,6–1,8 s**, 100.300 linhas lidas | segura o escritor único: relatório pesado precisa de teto (`rowsRead`) e job em fatias |
| Relatório: extrato de um produto, página de 50 | 21–28 ms, 3.013 linhas lidas | |
| Banco com 100 mil lançamentos | 53 MB | 10 GB por empresa |
| Salto Worker → objeto (`/erp-ping`) | p50 3–4 ms, p95 4–6 ms | |
| Primeira chamada (aplica esquema + semeadura) | 0,86–0,95 s | uma vez por área |
| Bundle sem `--minify` | 8,9 MB → **13,4 MB** (gzip 1,7 → 2,6 MB) | base: `main` + módulos de vendas |
| Bundle com `--minify` | 4,7 MB → **7,8 MB** (gzip 1,3 → 2,1 MB) | |
| Partida (`wrangler check startup`, CPU ativa) | 177 ms → 243 ms sem minify; 186 ms com minify | |

**Pacote:** sem `--minify`, o módulo de 13,4 MB em base64 (~17,8 MB) mais os
estáticos (~6,4 MB) passa do teto de 24 MB; com `--minify`, ~16,8 MB.
`--minify` é obrigatório desde já, e cada domínio portado soma.

## Prova 8 — backup (`tests/erp-do-backup.test.ts`)

`/erp-backup` grava uma tabela por NDJSON gzip em
`erp-backups/<área>/<instante>/` no `MEDIA`, com `manifest.json` (versão e
hash do esquema; linhas e SHA-256 por tabela); `/erp-restore {prefix}`
restaura numa instância nova, numa transação, recriando os gatilhos e
conferindo as FKs.

| Medida (dados sintéticos: 20 produtos, 30 lançamentos, semeadura) | Valor |
|---|---|
| Tabelas / linhas | 39 / 7.771 |
| Backup (gzip) | 126 KB, ~0,4–0,6 s |
| Restauração | ~1,3 s; **mesmos SHA-256 em todas as tabelas**, saldos iguais, ledger continua imutável |
| `getCurrentBookmark()` | responde (texto de 59 caracteres) |
| `getBookmarkForTime()` | **"storage back-end does not implement point-in-time recovery"** no local |

Recuperação no tempo (30 dias): fica documentada — `getBookmarkForTime(t)` e
`onNextSessionRestoreBookmark(b)` + reinício do objeto — e precisa da
instalação de teste para ser provada. O dump inteiro numa invocação é um
retrato consistente; para bancos grandes vira job em fatias com manutenção
ligada (escritas 503).

## Regras de conversão que mudaram (PLANO-FAGOO-MOTOR.md, seção 3)

1. **i64 sempre lido como TEXT.** Lido como número, 2^53+1 vira 2^53 sem erro.
2. **BigInt nunca vai como parâmetro** (o objeto recusa): vai como string; a
   coluna `STRICT` converte.
3. **Nada de FK adiada.** Sem correção, o commit reinicia o objeto e desfaz a
   invocação inteira (não lança). O gerador não emite `DEFERRABLE` (as 22 FKs
   adiadas do Postgres viram imediatas); onde adiar for preciso (semeadura,
   restauração), `PRAGMA foreign_key_check` e lançar antes do fim.
4. **Profundidade de expressão 100**: cadeias longas de `OR`/`+` viram
   `json_each` ou TS.
5. **`numeric(16–18, s)` é i64 lido como TEXT**, não "INTEGER com
   CHECK ≤ 2^53": `numeric(18,6)` chega a 999999999999.999999 (10^18
   escalado), e o Fagoo testa esse teto. `numeric(≤15)` continua número.
6. **Tipos de argumento antes de tudo**: uuid/date inválidos falham antes do
   corpo do RPC (22P02, 22007, 22008), como no Postgres.
7. **`LIKE '%…%'`** com consulta do usuário vira `instr()` (padrão > 50 bytes
   estoura).
8. **Identity**: o valor exato pode diferir do Postgres (o SQLite reaproveita
   o número de uma transação desfeita); só a ordem e a existência valem.
9. **`PRAGMA user_version` e `sqlite_version()`** não são autorizados:
   versão em `erp_meta`.
10. Mantidas com prova: `transactionSync` aninhado = savepoint (os 48
   `when others` cabem em `try { transactionSync }`), `STRICT`,
   `RAISE(ABORT)`, índices parciais, colunas geradas, `->>`, `json_each`, 100
   parâmetros, `lower`/`NOCASE` só ASCII (coluna normalizada em TS).

## Estimativa revisada por domínio

Medida do porte: `erp_stock_post` (21 KB de PL/pgSQL sem a lista constante de
permissões) virou ~450 linhas de TS: **~21 linhas por KB**, contra as ~35 que
a estimativa do plano supunha (115 mil linhas para 3,3 MB). Somam-se ao porte
das funções: os 240 gatilhos pendentes (guardas em TS), os 227 CHECKs
pendentes e a adaptação dos testes que usam SQL direto.

| # | Domínio | Plano (mil linhas) | Revisado (mil linhas) | Observação |
|---|---|---|---|---|
| 1 | Referências | 0,1 | 0,1 | `erp_reference_search` já portado |
| 2 | Empresa | 1,7 | 1,2 | |
| 3 | Acesso e atividade | 3,4 | 2,5 | `access/public.ts` começado |
| 4 | Catálogo, contatos, preços | 16 | 11 | `erp_catalog_save` é pré-requisito de quase todo teste |
| 5 | Documentos | 13 | 10–13 | `erp_document_save` sozinho é ~3–5 mil |
| 6 | Estoque | 15 | 10 | `erp_stock_post` já portado |
| 7 | Financeiro | 16 | 11 | |
| 8 | PDV | 2,4 | 1,8 | |
| 9 | CNAB e boleto | 6,4 | 4,5 | |
| 10 | Fiscal do lado ERP | 12 | 8 | sem o bloco A1/SEFAZ (decisão 7) |
| 11 | Preferências, home, plataforma, anexos | 12 | 8,5 | |
| 12 | Origin | 16 | 11 | |
| | **Total** | **~115 (90–140)** | **~80 (65–100)** | mais ~5 mil de guardas e validações pendentes |

Ritmo observado com o harness pronto: um RPC difícil de ~30 KB com o fecho
inteiro, teste original e diferencial aleatório verdes, em poucas horas de
uma sessão. O gargalo é a preparação dos testes: quase todos usam
`erp_catalog_save` e SQL direto, então Catálogo (4) é o caminho crítico.

## Para as sessões de domínio

- **Rodar:** `npm run test:erp` (Node: paridade do esquema, diferencial e
  testes do Fagoo); `npx vitest run tests/erp-do-*.test.ts` (no workerd:
  dialeto, instância, esquema, costura, medidas, backup).
  `ERP_ENGINE=pg` roda um teste só no Postgres (como era no Fagoo);
  `ERP_DIFF_N`/`ERP_DIFF_SEED` controlam o diferencial aleatório.
- **Portar um RPC:** `scripts/erp/call-graph.mjs <rpc> --source` mostra o
  fecho e o corpo de cada função no oráculo. Escreva
  `src/erp/domains/<domínio>/rpc/<rpc>.ts` com `registerRpc("<rpc>", fn)` e
  importe em `src/erp/domains/index.ts`; ajudantes do domínio em
  `internal.ts`; o que outro domínio usa, só por `public.ts` (exemplos:
  `access/public.ts`, `sync/public.ts`). Gatilhos do Postgres viram funções
  da camada de tabela chamadas por quem escreve (`stock/internal.ts`:
  `ensureBalance`, `updateBalance`, `insertEntry`); os que só lançam erro já
  estão em SQL gerado.
- **Testes originais:** copie para `tests/erp/fagoo/`, troque a criação do
  banco por `dualFixture()` e as chamadas SQL de RPC por `f.rpc`; asserções
  iguais; testes de `grant`/RLS saem (declare no cabeçalho). Acrescente um
  diferencial aleatório com mutações de um campo (`stock-post-diff`).
- **Esquema:** `scripts/erp/gen-sqlite.mjs` (decisões em
  `scripts/erp/overrides.mjs`, por domínio); `tests/erp/schema-parity.test.mjs`
  tem tetos para pendências (CHECK 227, gatilhos 240): baixe ao portar.
  `src/erp/schema/` e `src/erp/engine/` congelam depois da fase 0, com um
  dono; mudança no gerador sobe `ERP_DDL_VERSION`.
- **Regras do dialeto:** as dez acima, e `docs/ERP-FASE0.md`, prova 1.

## O que a instalação de teste (sessão K) precisa confirmar

Nada foi implantado. Quando a orquestração pedir: CPU real de
`erp_stock_post` (100 itens) e do relatório de 100 mil linhas
(`observability` do Worker), os limites de produção (argumentos de função,
tamanho de instrução), `getBookmarkForTime` e restauração por bookmark,
`locationHint: "sam"` e o tempo de partida do pacote com `--minify`.
