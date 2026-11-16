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
| 5 | Motor mínimo e diferencial | **passou** para `erp_reference_search` e `erp_stock_post`; **`erp_document_save` não portado** (190 funções, 180 KB: tamanho de domínio, não de prova). Complemento do portão: chamada entre domínios com o mesmo `command_id` e validação pesada de jsonb (**passou**, zero divergência), mapa de fechos dos 612 RPCs e produtividade medida (abaixo) |
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

Portão aprovado com `erp_reference_search` + `erp_stock_post`;
`erp_document_save` é a primeira tarefa de Documentos. Os três complementos
pedidos para manter o portão válido estão em "Portão: o que o
`erp_stock_post` não exercita", "Mapa de fechos" e "Produtividade medida".

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
| Paridade | `tests/erp/schema-parity.test.mjs` (`npm run test:erp`) | 7 de 7, ~25 s |
| No objeto | `tests/erp-do-schema.test.ts` | 430 tabelas, 786 índices, 296 gatilhos SQLite; 23.062 linhas escritas; 6,4 MB; ~0,95 s locais na primeira chamada |

Conversão (contagens de `src/erp/schema/report.generated.json`):

| O quê | Resultado |
|---|---|
| Colunas | 3.784 com codec; nenhuma sem tipo. `numeric` sem escala (20): decididas coluna a coluna pela evidência (tabela abaixo) |
| `bigint` | INTEGER com `CHECK(abs(x) <= 2^53-1)`, lido como número (contadores, centavos) |
| `numeric(p≤15)` / `(16–18)` / `(>18)` | `dec`: INTEGER escalado, lido como número / `dec_i64`: INTEGER escalado lido como TEXT / `dec_text`: **decimal exato em TEXT** (o i64 não comporta 30 dígitos) |
| CHECK | 996 traduzidos para SQL e **provados por comportamento**: 10.469 avaliações com os mesmos valores nos dois motores, zero divergência (89 valores que o próprio Postgres recusa no tipo ficam de fora). 233 com regex viram `RegExp` em TS, conferidos contra o `~` do Postgres. **222 pendentes**, com motivo (aritmética decimal, `lower`/`upper`, funções do Fagoo, tempo relativo, arrays): validação em TS no porte do domínio |
| UNIQUE / PK | 201 / 430, iguais |
| FK | 512 mantidas; 327 para `auth.users`/`storage` removidas (ator do Wabotia e R2); **22 `DEFERRABLE` viram imediatas** (prova 1): o porte confere a ordem de escrita |
| Índices | 231 criados (104 parciais traduzidos), 16 colunas normalizadas ou calculadas pelo motor (`fold`, `lower`, funções do Fagoo), 1 GIN descartado |
| Gatilhos | **148 gerados em SQL** (só lançam erro: `RAISE(ABORT,'<sqlstate>:<mensagem>')`, um por evento); **240 pendentes** (PL/pgSQL; 12 são gatilhos de restrição adiados, que viram conferência no fim da transação em TS) |
| Padrões | constantes no DDL; `now()`/`clock_timestamp()`, `gen_random_uuid()` e 7 expressões preenchidos pelo motor (`columns.generated.ts`) |
| Semeadura | 30 tabelas, 7.586 linhas (municípios, CNAE, países, definições de preferência…), aplicada com FKs adiadas e `foreign_key_check` antes do fim da transação |

### As 20 colunas `numeric` sem escala

Decisão em `scripts/erp/overrides.mjs`, com o motivo em cada entrada; prova em
`tests/erp/numeric-boundary.test.mjs` (fronteiras de cada coluna pelo
`numeric` do Postgres e pelo codec do SQLite, e o caminho real do Fagoo:
`erp_catalog_save` com preço `99999999999999.9999999999`, igual nos dois
motores). **Nenhuma ficou como "assumido"**: todas têm CHECK ou função do
Fagoo que fixa a escala.

| Coluna | Codec, escala | Evidência |
|---|---|---|
| `erp_catalog.product.price` | `dec_text`, 10 | CHECK `< 1e14`, `= trunc(x,10)`; `erp_catalog.unit_price(v,14)`; o teste do Fagoo grava `99999999999999.9999999999` |
| `erp_catalog.product_supplier.purchase_price` | `dec_text`, 10 | idem (CHECK `< 1e14`, trunc 10) |
| `erp_catalog.product_supplier.cost_price` | `dec_text`, 10 | idem |
| `erp_pricing.price_list_item.custom_price` | `dec_text`, 10 | idem |
| `erp_stock.movement_detail.unit_price` | `dec_text`, 10 | idem |
| `erp_stock.movement_detail.unit_cost` | `dec_text`, 10 | idem |
| `erp_documents.item.unit_price` | `dec_text`, 10 | CHECK `< 1e10`, trunc 10: 20 dígitos, acima do i64 |
| `erp_fiscal_invoices.invoice_item.unit_price` | `dec_text`, 10 | CHECK `< 1e11`, trunc 10: 21 dígitos |
| `erp_stock.checkin_item.unit_price` | `dec_text`, 10 | CHECK `< 1e11`, trunc 10 |
| `erp_fiscal_invoices.invoice_item.quantity` | `dec`, 4 | CHECK `> 0`, `< 1e11`, trunc 4 (15 dígitos: cabe no número) |
| `erp_fiscal_invoices.invoice_order_item.quantity` | `dec`, 4 | idem |
| `erp_stock.checkin_item.quantity` | `dec`, 4 | idem |
| `erp_stock.checkin_item.received` | `dec`, 4 | CHECK `>= 0`, `< 1e11`, trunc 4 |
| `erp_stock.checkin_item.issue_quantity` | `dec`, 4 | CHECK `> 0`, `< 1e11`, trunc 4, `≤ quantity` |
| `erp_stock.checkin_event.quantity` | `dec`, 4 | sem CHECK; herda de `checkin_item.quantity/received` (as funções copiam e formatam `::numeric(24,4)`) |
| `erp_stock.checkin_event.previous` | `dec`, 4 | sem CHECK; valor anterior da mesma coluna de `checkin_item` |
| `erp_stock_mirror.observation.physical` | `dec_text`, até 12 | gravada a partir de `erp_stock_mirror.number()`: `abs < 1e24`, `min_scale ≤ 12`, `trim_scale` |
| `erp_stock_mirror.observation.virtual` | `dec_text`, até 12 | idem |
| `erp_stock_mirror.observation.physical_delta` | `dec_text`, até 12 | diferença de duas leituras (até 2e24) |
| `erp_stock_mirror.observation.virtual_delta` | `dec_text`, até 12 | idem |

**Teto do i64:** com 10 casas, ±922 milhões; os preços do Fagoo chegam a 14
inteiros + 10 casas (24 dígitos). Escala menor quebraria o próprio teste do
Fagoo (10 casas são exigidas), então os 9 preços e as 4 observações do
espelho viram `dec_text`. **Achado de quebra:** as 3 colunas tipadas
`numeric(30,10)` (`product_cost_history.cost_price` e `.purchase_price`,
`item_cost_applied.unit_cost`) também estouravam o i64 na regra anterior
(`dec_i64` para precisão > 15); a regra agora é `dec_i64` só até 18 dígitos e
`dec_text` acima.

`dec_text` guarda o mesmo texto de `numeric::text` (`engine/dec.ts`
`decText`): `numeric(p,s)` arredonda e completa até `s` casas; `numeric` puro
conserva as casas de entrada, como o Postgres (`1.2345000000` volta
`1.2345000000`). Comparação, soma e teto ficam em TS (`compareDec`, `exact`);
no SQL só o sinal (`>= 0`, `> 0`) e o formato viram CHECK. As quantidades de
escala 4 em `dec` perdem a escala de exibição de entrada (`2.5` volta
`2.5000`): as funções do Fagoo formatam a saída com `::numeric(24,4)`, e o
porte faz igual. O motor recusa casas a mais (CHECK `trunc`) em vez de
arredondar.

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

| Teste (`npm run test:erp`, 35 de 35) | Resultado |
|---|---|
| `tests/erp/fagoo/stock-adversarial.test.mjs` (cópia de `tools/migration/test_stock_adversarial.mjs`, 5 testes originais) | **passa nos dois motores**, estado igual tabela a tabela depois de cada `erp_stock_post` |
| `tests/erp/fagoo/stock-sql.test.mjs` (cópia de `tools/migration/test_stock_sql.mjs`, 11 testes; só os auxiliares trocados) | **11 de 11** nos dois motores; 1 com asserções adaptadas (abaixo) |
| `tests/erp/cross-domain.test.mjs` | chamada entre domínios com o mesmo `command_id` e `validate_data` aleatório (abaixo) |
| `tests/erp/numeric-boundary.test.mjs`, `tests/erp/deviations.test.mjs` | as 20 colunas `numeric`; desvios deliberados |
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

### Portão: o que o `erp_stock_post` não exercita (`tests/erp/cross-domain.test.mjs`)

Caso real e pequeno do oráculo: `erp_documents.auto_products` (a parte do
`erp_document_save` que cadastra produto a partir do item livre) chama
`erp_catalog.document_product` com o comando **do documento**. Portados com
o fecho (24 funções, 22 KB, 13 em PL/pgSQL): `catalog/public.ts`
(`documentProduct`), `catalog/internal.ts` (`validate_data` inteiro, das
três entidades; `unit_price`; `next_product_code` com EAN; camada de tabela
de `record` e `product` com os gatilhos `zz_origin_sync` e
`items_per_box_follow`; `dto`, `data`, `product_detail_data`),
`documents/internal.ts` (`autoProducts`), `documents/public.ts` (`allowed`),
`preferences/public.ts` (`get`). O harness ganhou `f.dual(nome, pg, motor)`
(qualquer função, não só RPC) e `inTransaction` no motor.

**Por que o recibo precisa de escopo.** O catálogo grava o recibo em
`erp_catalog.command`, a mesma tabela do `erp_catalog_save`, com id
`md5('document-auto-product:' || comando || ':' || posição)`. O teste usa
o mesmo id primeiro num `erp_catalog_save` e depois como comando do
documento com três itens novos: ficam quatro recibos, sem colisão. Sem o
escopo, o segundo item acharia o recibo do primeiro (hash diferente → 40001)
e o `erp_catalog_save` anterior seria tomado por repetição. Regra para o
porte: **recibo de comando vindo de outro domínio leva escopo** (`scopedCommand`
em `catalog/public.ts`; o Fagoo também usa coluna `scope` em
`erp_fiscal_invoices.command` e `erp_pos.command`).

| Caso (nos dois motores, resposta e tabelas comparadas) | Resultado |
|---|---|
| 5 itens: 3 novos (um com preço `99999999999999.9999999999`, um serviço com preço numérico), 1 pelo código sem caixa, 1 já com produto | iguais; 3 produtos, auditoria, recibos, fila do Origin |
| Repetição do mesmo documento | mesmos produtos, nada novo |
| Mesmo comando e posição com outro conteúdo | 40001 `erp_catalog_command_conflict` nos dois |
| Compra (preço fora do cadastro); vendas tentando compra | iguais; 42501 nos dois |
| 10 itens inválidos (nome, texto, controle, preço com 11 casas, negativo, zero à esquerda, 15 inteiros, tipo, código) | mesma recusa e mensagem |
| `validate_data` isolado: 400 objetos aleatórios (contatos, produtos, depósitos; metade só com valores válidos) | **zero divergência**: 145 aceitos, 12 recusas diferentes |

Primeira execução já verde (a única falha foi do próprio teste). Uma
mutação proposital (tirar o `btrim`) é pegue pelo diferencial em 60 objetos.

## Mapa de fechos (`scripts/erp/closure-map.mjs`, `docs/erp-closure-map.json`)

612 RPCs que a erp-api chama (581 por nome literal, o resto pelos 8
prefixos montados em tempo de execução, como `erp_stock_reservation_${…}`).
Domínio do RPC pelo prefixo do nome (9 sem prefixo conhecido: pelo schema
dominante do fecho). Dono de função interna: o domínio do seu schema.

| Domínio | RPCs | Código alcançável (KB) | Maiores fechos (funções, KB) |
|---|---|---|---|
| Referências | 1 | 3 | `erp_reference_search` (5, 3) |
| Empresa | 21 | 42 | `erp_company_save_identity` (10, 9) |
| Acesso | 20 | 88 | `erp_activity_list` (15, 34); `erp_access_user_controls_save` (10, 15) |
| Catálogo | 101 | 421 | `erp_catalog_product_price_adjust` (79, 107); `erp_catalog_product_variation_add` (67, 93); `erp_catalog_save` (65, 88) |
| Documentos | 63 | 296 | `erp_document_proposal_version` (182, 173); `erp_document_save` (181, 170); `erp_document_checkout_save` (186, 163) |
| Estoque | 108 | 419 | `erp_stock_product_create` (82, 102); `erp_stock_product_compose` (70, 95); `erp_stock_reservation_apply` (102, 90) |
| Financeiro | 63 | 414 | `erp_finance_reconciliation_execute` (58, 67); `erp_document_finance_post` (94, 66) |
| PDV | 9 | 64 | `erp_pos_sale_execute` (290, 312); `erp_pos_return_execute` (97, 105) |
| CNAB | 55 | 169 | `erp_cnab_itau_net_credit_settle` (64, 76); `erp_cnab_operational_settle` (61, 71) |
| Fiscal | 59 | 334 | `erp_fiscal_invoice_import` (122, 152); `erp_fiscal_invoice_partial_create` (98, 102) |
| Preferências, home, plataforma, anexos | 73 | 318 | `erp_preferences_import_batch` (371, 429); `erp_home_business_panel` (69, 66) |
| Origin | 39 | 210 | `erp_sync_pull` (191, 208); `erp_sync_remote_deleted` (76, 47) |
| **Total** | **612** | **2.782** (1.895 funções; de 3.226 KB de funções `erp`) | |

Distribuição: 237 RPCs com fecho ≤ 10 KB, 525 ≤ 30 KB, 599 ≤ 100 KB; só 3
passam de 200 KB (`import_batch`, `pos_sale_execute`, `sync_pull`), e são
despachantes que alcançam vários domínios.

**Funções compartilhadas (dono único).** 1.317 funções internas alcançadas;
500 usadas por RPCs de dois ou mais domínios, 381 sem contar os
despachantes (Preferências e Origin). As mais usadas:

| Função | Dono | Domínios | RPCs |
|---|---|---|---|
| `erp_access.permission_keys`, `permission_parent`, `permitted` | Acesso | 10–11 | 359–362 |
| `erp_preferences.get` | Preferências | 9 | 201 |
| `erp_sync.enabled`, `applying`, `enqueue` | Origin (núcleo da fila) | 9 | 78–81 |
| `erp_catalog.contact_scope`, `contact_visible_to`, `fold`, `unit_price`, `data`, `dto`, `validate_data`, `write_fields` | Catálogo | 7–8 | 20–142 |
| `erp_documents.allowed`, `require_access`, `require_role`, `contact_usable`, `os_permitted` | Documentos | 8 | 75–114 |
| `erp_finance.require_access`, `keys`, `permission_key`, `document_seller`, `commission_seller` | Financeiro | 7 | 32–127 |
| `erp_access.resources_for_role` | Acesso | 7 | 122 |
| `erp_document_mirror.visible`, `require_visible`, `guard_effect` | Origin (guardas do espelho) | 7 | 44–74 |
| `erp_sync.capture_catalog`, `capture_finance`, `origin_effects`, `guard_zero_title` | Origin (gatilhos de captura) | 7 | 29–42 |
| `erp_stock.require_access` | Estoque | 6 | 95 |
| `erp_documents.normalize` (12 KB), `normalize_core` (8,5 KB) | Documentos | 4 | 6 |

**Onde a heurística erra:**
- **Superestima:**
  - Gatilhos de toda tabela escrita. A versão refinada já só conta o gatilho cujo evento bate. Mesmo assim, `insert … on conflict do update` puxa os gatilhos de UPDATE: no `document_product`, 4 das 24 funções (17%) nunca rodam, porque o id é novo.
  - Funções genéricas contam inteiras: `validate_data`, `data` e `write_fields` servem três entidades, e o produto usa ~60%.
  - Ramos mortos para a chamada: o estorno e a importação do espelho no `stock_post`.
  - Despachantes: `import_batch`, `sync_pull` e `home_business_panel` somam todos os ramos.
  - Nomes sobrecarregados entram todos (3 nomes).
  - Ingênuo contra refinado: 12.313 contra 11.801 funções somadas, só −4%. O excesso grande está nos ramos, não nos gatilhos.
- **Subestima:**
  - SQL dinâmico (`execute`), em 26 funções.
  - Funções em expressão de índice (`erp_catalog.fold`, nas colunas `__fold`).
  - Padrões de coluna e CHECKs que chamam funções.
  - Código das RLS (sai do porte).

**Ordem dos domínios.** O mapa confirma o começo, Referências → Empresa →
Acesso → Catálogo: Empresa e Acesso só dependem do núcleo; Catálogo usa de
Fiscal só listas de leitura (aba fiscal do contato, 17 KB) e de Estoque a
composição (`composition_apply_values`). Mas **depois do Catálogo a ordem do
plano (Documentos antes de Estoque e Financeiro) não se mantém**: Documentos
usa 63 KB de Estoque (lançamento e prévia de estoque do documento) e 42 KB
de Financeiro, enquanto Estoque usa 6 KB de Documentos e Financeiro 9 KB.
Proposta:

0. **Núcleo transversal, um dono, antes dos domínios**:
   - De Acesso: `permission_keys`, `permitted`, `resources_for_role`.
   - `erp_preferences.get`.
   - A fila do Origin: `enabled`, `applying`, `enqueue`. Cada `capture_*` vai com o domínio da sua tabela.
   - As guardas do espelho de documentos: `visible`, `require_visible`, `guard_effect`.
   - Já começado: `access/public.ts`, `sync/public.ts`, `preferences/public.ts`.
1. Referências → Empresa → Acesso.
2. Catálogo e preços.
3. **Estoque e Financeiro**, em paralelo. A ligação entre eles é a comissão no documento lançado: 13 funções.
4. **Documentos**, com `erp_document_save` e `normalize` como primeira tarefa.
5. Fiscal (depende de Catálogo e Financeiro) e CNAB (depende de Financeiro), em paralelo.
6. PDV (depende de Financeiro, Documentos e Estoque).
7. Preferências (importações, relatórios, painel da home) + contrato de integração externa (fila de alterações, vínculo de ids, trava de posse; "Origin fora" abaixo).

## Produtividade medida

| Medida | `erp_stock_post` | `document_product` + `auto_products` |
|---|---|---|
| Fecho | 27 funções, 13 em PL/pgSQL, 28 KB (21 KB sem a lista constante de permissões, que virou arquivo gerado) | 24 funções, 13 em PL/pgSQL, 22 KB |
| TS do domínio (linhas de código, sem comentário) | 468 (`stock_post.ts`, `stock/internal.ts`, `access/public.ts`, `sync/public.ts`) | 517 (`catalog/*`, `documents/*`, `preferences/public.ts`) |
| Densidade | **22 linhas por KB** | **23,5 linhas por KB** (inclui ramos de contatos e depósitos de `validate_data`) |
| Motor comum (uma vez) | 226 linhas (`engine/`) | +15 (`inTransaction`, `arrow`, `jsonbKeys`) |
| Linhas de dialeto (decimal, `CAST`, tipo de argumento, jsonb canônico, ordem, tempo) | 49 (10%) | 69 (13%) |
| Divergências achadas pelo diferencial até ficar verde | 4 (regra do `numeric(18,6)`, fuso, 22008 × 22007, ordem das conferências) | 0 na primeira execução |

**Testes originais (os do Fagoo que exercitam o `erp_stock_post`):**
- `test_stock_adversarial.mjs`: 6 testes. 5 passam sem mudar asserção; 1 descartado (grants).
- `test_stock_sql.mjs`: 12 testes.
  - 10 passam sem mudar asserção.
  - 1 adaptado: o contrato HTTP esperava a projeção só da migração 009, que o próprio Fagoo diz para conferir em outro teste.
  - 1 descartado (RLS e grants).
- **Total: 15 de 18 passam com as asserções originais, 1 adaptado e 2 descartados por não existirem no motor.**
- A adaptação é mecânica e só nos auxiliares:
  - criar o banco → `dualFixture()`;
  - `select public.rpc(...)` → `f.rpc`;
  - SQL direto de escrita → `db.query` + `f.sync()`.
- Os outros 34 arquivos de teste do Fagoo que citam `erp_stock_post` o usam como preparo de outros domínios e entram com eles.

**Quanto foi mecânico.**
- **Por linha:** ~87–90% é tradução um para um (cada `if`, `insert`, `select` do PL/pgSQL vira uma linha de TS); 10–13% é dialeto.
- **Por tempo:** o que custou foram os pontos de julgamento. No `stock_post` eles viraram regras do motor e ajudantes (`dec.ts`, `dateArgError`, `jsonbText`). O `document_product` já saiu verde na primeira execução, com 400 objetos aleatórios.
- O tempo do porte agora é dominado por ler o fecho e preparar os testes (quase todos dependem de `erp_catalog_save` e de SQL direto), não pelo dialeto.

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
   **Acima de 18 dígitos** (`numeric(30,10)`, preços de 14+10) o i64 estoura:
   decimal exato em TEXT (`dec_text`), conta em TS.
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

Base, agora medida:
- **Densidade:** dois portes, 22 e 23,5 linhas de TS por KB de PL/pgSQL; a conta usa 23 (22–24). O plano supunha ~35.
- **Volume:** o código **alcançável** pelos 612 RPCs da erp-api, por domínio dono (mapa de fechos): união dos fechos, cada função contada uma vez. São 2.782 KB, não os 3,3 MB de todas as funções; o resto não é alcançado pela API.
- **Por que superestima pouco:** a união não conta duas vezes, e um ramo "morto" para um RPC costuma ser usado por outro (por exemplo, o ramo de contatos do `validate_data`).
- **Por que subestima:** fica de fora o SQL dinâmico de 26 funções.
- **Fora da conta:**
  - os 222 CHECKs pendentes (~1–2 mil linhas de validação);
  - a adaptação dos testes;
  - as listas constantes, que viram arquivos gerados.

**Sem o Origin** (item 17). O alcançável é recontado sem as funções que saem
(lista do mapa de poda, `sessao-N-origin-poda.md`). O Origin tinha 214 KB
próprios; o resto que sai fica dentro dos domínios nativos (`map_origin`,
`origin_mirror_*`, `stock_opening_*`, `history_*`). Ao todo saem 62 RPCs que
a erp-api chama, 23 deles registrados em domínios nativos.

| # | Domínio | Plano (mil linhas) | Revisão anterior | Com o Origin | **Sem o Origin (mil linhas)** | Observação |
|---|---|---|---|---|---|---|
| 0 | Núcleo transversal | — | — | — | (dentro de Acesso e Preferências) | acesso, `preferences.get`; já começado |
| 1 | Referências | 0,1 | 0,1 | 0,1 | 0,1 | `erp_reference_search` portado |
| 2 | Empresa | 1,7 | 1,2 | 1,0 | 1,0 | 42 KB |
| 3 | Acesso e atividade | 3,4 | 2,5 | 1,9 | 2,0 | 88 KB, menos a lista de permissões gerada |
| 4 | Catálogo, contatos, preços | 16 | 11 | 9,7 | 8,6 | 374 KB; saem 40 KB (importação revisada, categorias e exclusões do Origin) |
| 5 | Estoque | 15 | 10 | 9,6 | 9,0 | 390 KB; saem 26 KB (saldo de abertura do Origin, espelho) |
| 6 | Financeiro | 16 | 11 | 9,5 | 9,3 | 402 KB |
| 7 | Documentos | 13 | 10–13 | 6,8 | 6,8 | 294 KB: o fecho do `erp_document_save` é em boa parte de Estoque, Financeiro e Catálogo |
| 8 | Fiscal do lado ERP | 12 | 8 | 7,7 | 7,0 (~4,5 sem A1/SEFAZ) | 304 KB; saem 27 KB (espelho fiscal, XMLs sincronizados) |
| 9 | CNAB e boleto | 6,4 | 4,5 | 3,9 | 3,9 | 167 KB |
| 10 | PDV | 2,4 | 1,8 | 1,5 | 1,5 | 64 KB próprios; o `pos_sale_execute` (312 KB de fecho) reúsa os outros |
| 11 | Preferências, home, plataforma, anexos | 12 | 8,5 | 7,3 | 6,1 | 264 KB |
| 12 | Contrato de integração externa (era Origin) | 16 | 11 | 4,8 | **~0,5** | o genérico: ~15 KB dos 214 KB do Origin (~7%); o resto vai para o componente externo |
| | Sem domínio (funções auxiliares) | | | | 1,0 | 44 KB |
| | **Total** | **~115 (90–140)** | **~80 (65–100)** | **~64 (61–67)** | **~57 (54–59); com CHECKs e folga, 54–66** | |

Ainda fora da conta:
- **Cinco famílias de RPC montadas por concatenação** escapam do mapa de fechos; duas são do núcleo (`erp_finance_transfer_*`, `erp_service_event_*`).
- **Regras nativas que moram em schemas do Origin** e precisam mudar de lugar (+~0,5 mil linhas): `native_item_required`, a imutabilidade em `guard_document`, o ramo nativo de `visible`, `guard_zero_title`.

Ritmo com o harness pronto: o `document_product` (22 KB, 24 funções) saiu
com o fecho inteiro e diferencial verde na primeira execução, numa fração
de sessão. O gargalo é o caminho crítico de dependências (núcleo →
Catálogo → Estoque/Financeiro → Documentos) e a preparação dos testes
(quase todos usam `erp_catalog_save` e SQL direto).

## Casas decimais nas telas e desvios deliberados do oráculo

Decisão do usuário: banco e motor com a precisão do Fagoo; nas telas,
padrão de 2 casas para preço e quantidade, configurável por empresa.

**Onde ficam hoje os padrões no Fagoo.** Existe preferência para a
quantidade **e** para o preço. São preferências da empresa, página
"Empresa › Geral":

| Chave | Padrão | Faixa |
|---|---|---|
| `empresa.decimais_quantidade` | 6 | 0–10; acima de 6 vale 6 |
| `empresa.decimais_preco_saida` | 10 | 0–10 |
| `empresa.decimais_preco_entrada` | 10 | 0–10 |
| `empresa.decimais_peso` | 3 | 0–5 |

O padrão está escrito em três lugares:
1. **Banco:** `erp_preferences.definition.default_value`, semeado por `202610200115_erp_preferences.sql` (linhas 206–208). Nossa semeadura (`seed.generated.ts`) vem daí.
2. **Definição da tela:** `packages/erp-domain/src/preferences/pages/empresa-geral.mjs`, com os mesmos padrões e a nota de onde cada uma se aplica.
3. **Recuos quando a preferência falta:**
   - preço: `coalesce(…, 10)` nas funções das migrações 164, 199, 239, 287 e 277;
   - quantidade: `least(greatest(coalesce(…, 6), 0), 6)` na 287;
   - frontend: `settings?.quantity_decimals ?? 6` em `apps/erp/src/lib/document-seller-rules.ts`.

Duas coisas não guardam padrão:
- A migração `202610160057_unit_price_precision.sql` não define preferência: ela só alarga a escala do preço (`numeric` + CHECK de 10 casas).
- `standalone-defaults.sql` não cita casas.

**Atenção — não é só exibição.**
- No Fagoo essas preferências **limitam a entrada também no servidor**:
  - o `erp_document_save` recusa preço com mais casas que a preferência (164/287);
  - a quantidade, idem (287);
  - o lançamento de estoque, o preço de entrada (277).
- O editor confere igual.
- A exibição só compacta o decimal (tira zeros à direita, `compactDocumentDecimal`); não existe "mostrar com N casas" para preço e quantidade. Só o peso usa `roundedDecimal` com as casas da preferência.

Mudar o padrão para 2 faz o servidor recusar 3 casas ou mais até a empresa subir o valor. Se a intenção é só a tela, o caminho é outro: uma preferência nova, só de exibição. As duas opções estão no aviso à orquestração.

**Mecanismo registrado (`src/erp/schema/deviations.ts`).**
- **O que entra na lista:** só valores iniciais semeados (referência e preferências), cada um com motivo e decisão.
- **Gerador:** confere cada item contra o oráculo e para se o Fagoo mudar o valor. Só os itens com `applied: true` trocam a semeadura.
- **Diferencial:** `dualFixture` aplica os mesmos itens no Postgres antes de começar. Os dois motores rodam com o valor do Wabotia, e a semeadura diferente não vira divergência.
- **Prova:** `tests/erp/deviations.test.mjs`.
- **Primeiro item:** `telas-2-casas`, com `decimais_preco_saida` 10 → 2, `decimais_preco_entrada` 10 → 2 e `decimais_quantidade` 6 → 2.
- **Situação: aplicado** (opção (a) do usuário: "casas decimais usamos apenas 02", "pode deixar padrão 02 casas"). `decimais_peso` fica em 3.
- **O preço de entrada também vai a 2.** Conferido antes de aplicar: o limite só vale no que se digita.
  - Onde vale:
    - preço do pedido de compra (`erp_documents.check_preference_rules`);
    - preço e custo do lançamento e do balanço de estoque (`erp_stock.entry_price_check`, que arredonda a entrada e recusa se mudar).
  - Onde não vale: a importação de XML de nota de entrada (`erp_fiscal_invoice_import`, `vUnCom` com até 10 casas), o recebimento de compra e o custo médio não passam por ele.
  - Um lançamento manual de estoque preenchido com o custo de uma nota de 4 casas precisa ser arredondado por quem digita, ou a empresa sobe a preferência.
- **Segundo desvio aplicado:** `origin-fora`, com `erp_sync.settings.enabled=false` (ver "Origin fora").

## Blocos do ERP: o módulo e os opcionais (PLANO-FAGOO.md, item 16)

**Módulos** (`src/modules/erp/definition.ts`):
- `erp` é desligado de fábrica e atende a rota `/erp`; desligado, responde `409 module_disabled` pelo portão comum.
- `erp-fiscal`, `erp-cobranca` e `erp-pdv` também nascem desligados e têm `requires: ["erp"]`.
- Navegação: um item `erp` no trilho, o mesmo id do painel em `web/lib/routes.ts`.
- Não existe `erp-origin`.

**Portão dos opcionais** (`src/erp/blocks.ts`):
- O bloco sai do caminho da erp-api, depois de `new URL()`; o prefixo mais longo vence e, sem prefixo, a rota é do núcleo.
- Bloco desligado responde 409 antes do objeto; "externo" (Origin, autoatualização, MCP e OAuth do Fagoo) responde 404.
- O inventário das rotas classificadas está em `tests/erp/fixtures/route-blocks.json`, e `tests/erp/blocks.test.mjs` prova os prefixos rota a rota:

| Bloco | Rotas | Exemplos de caminho que engana |
|---|---|---|
| núcleo | 499 | `/estoque/lotes/origem` e `/duplicacao-documentos/…/origin` são nativos |
| fiscal | 118 | `/documentos/sales_orders/notas-fiscais`, `/cadastros/notas-fiscais`, `/estoque/notas-fiscais`, `/estoque/checkin`, `/financeiro/notas*`, `/plataforma/novas-nfes`, `/records/nfe` |
| cobrança | 53 | `/financeiro/remessa-candidatos`, `/financeiro/remessas`, `/financeiro/retornos` |
| PDV | 16 | `/preferencias/vendas-frente-caixa` |
| externo | 78 | `/estoque/espelho`, `/notas-fiscais/origin`, `/mcp` (chama o handler por dentro e pularia o portão) |

Três casos o caminho não separa:
- `GET /notas-fiscais` lista o espelho do Origin por padrão: o painel manda `origin=brufap`.
- Páginas de preferências misturam chaves de outros blocos, como `boletos_*` em `financas-receber` e `gerar_nfe` em `vendas-vendas`.
- `account_set_default` com `target=boleto`.

Esses ficam para o domínio dono resolver no corpo.

**Divergências com o painel** (`web/erp/blocks.ts` da M):
- **Borderôs:** o painel põe em cobrança, mas são baixas em lote do financeiro (`erp_finance_bordero_*`), sem CNAB. Proposta: núcleo.
- **`/checkin-recebimentos`:** o painel põe no núcleo, com ⚠. O check-in sempre parte de uma nota de entrada, então a proposta é fiscal; o recebimento pelo pedido de compra (`/recebimentos-compras`) segue no núcleo.
- **Partes fiscais dentro de telas do núcleo**, que o painel precisa esconder no 409:
  - no editor de contato, `/notas-fiscais/naturezas`;
  - a estimativa de tributos e a nota parcial do pedido;
  - o relatório de notas de entrada;
  - o lançamento financeiro da nota;
  - o card "Novas NF-es";
  - etiquetas e tags de nota.

**Onde núcleo e opcionais se cruzam:** nenhum RPC do núcleo precisa de um opcional para funcionar.

| Cruzamento | Tamanho | Com o opcional desligado |
|---|---|---|
| Núcleo lê tabelas fiscais: saldo faturado do pedido, vínculo nota ↔ pedido, telas do financeiro por nota, natureza padrão do contato | 115 RPCs, só leitura | Tabelas vazias (ou dados antigos): leitura vazia, guardas seguem |
| Núcleo escreve nota fiscal: só a importação em lote por planilha (`erp_preferences_import_batch`) | 1 RPC | Esse ramo recusa com `module_disabled` (a fazer no domínio Preferências) |
| Estoque lançado por nota (`erp_stock_invoice_*`, `erp_stock_checkin_*`) | ~20 RPCs | Ficam no bloco fiscal (portão); sem notas não há o que lançar |
| Núcleo lê `cnab.billing_title` (guarda do título com boleto, tela do título) e `cnab.profile` (conta) | 23 RPCs | Sem boletos: leitura vazia; título com boleto antigo segue protegido |
| Núcleo lê `pos.settings` (documento) e `pos.audit`/`pos.sale` (atividade) | 69 RPCs | Valores padrão, sem efeito |
| Baixa de título por retorno CNAB (`erp_cnab_operational_settle` → `erp_finance_execute`) | opcional → núcleo | Rota 409; o título é baixado à mão no financeiro |
| Nota fiscal lança estoque e financeiro (`erp_fiscal_invoice_execute` → `invoice_auto_finance`, postagem de estoque) | opcional → núcleo | Sem nota, sem esse efeito; o pedido lança estoque e financeiro pelas próprias rotas |
| Venda do PDV (`erp_pos_sale_execute` → `erp_document_save`, estoque, caixa) | opcional → núcleo | Rota 409 |
| PDV e NFC-e | o PDV não chama função fiscal; só lê o estado da nota | Sem o Fiscal, o PDV vende sem documento fiscal (como o plano quer) |

Regra para os domínios: guarda sobre dado de um bloco continua valendo com o
bloco desligado. Desligar não apaga dados, e um título com boleto registrado
não pode ser estornado só porque a cobrança foi desligada.

**Criação sob demanda** (`tests/erp-do-module.test.ts`):
- Com o módulo desligado: 409, e nenhuma instância `erp:<área>`. Nem o cron do Worker (`scheduled`, que só acorda as áreas) nem o alarme da área a criam.
- Ligado: o primeiro uso cria a instância e aplica o esquema.
- Desligado de novo: 409, e os dados ficam.

**Partida do Worker.** O motor, o esquema gerado, a semeadura e a erp-api
são carregados por import dinâmico (`src/erp/hub-engine.ts`,
`src/erp/api/local-fetch.ts`). Vão no pacote de todos, mas só são avaliados
na primeira chamada do ERP. Medida local (`wrangler check startup`, CPU ativa,
`--minify`, 3 rodadas alternadas):

| Pacote | Tamanho (gzip) | CPU de partida, 3 rodadas | Mediana |
|---|---|---|---|
| Sem o ERP | 4.544 KiB (1.308) | 189, 203, 195 ms | **195 ms** |
| ERP avaliado na partida (antes, imports estáticos) | 7.811 KiB (2.076) | 361, 320, 286 ms | **320 ms** (+125) |
| ERP sob demanda (atual) | 7.830 KiB (2.089) | 212, 129, 215 ms | **212 ms** (+17) |

- **Custo que fica para todos:** o pacote, que vai de 4,5 para 7,8 MB, e ~17 ms de partida, só para analisar o código.
- **Custo que sai:** os ~110 ms de avaliar o esquema (DDL de 528 KB, semeadura de 437 KB), o motor e a erp-api, que passam para a primeira chamada do ERP da instância.
- **Proposta para o resto:** o DDL e a semeadura podem sair do pacote de vez, num blob estático lido do R2 ou dos assets no primeiro uso, porque não são código. Isso tira ~1 MB do pacote e da análise. Só vale se o teto do pacote apertar; hoje há folga com `--minify` (prova 7).
- **A confirmar na instalação de teste:** o "Worker Startup Time" que o deploy imprime.

## Origin fora: poda e linha de corte (PLANO-FAGOO.md, item 17)

Detalhe em `sessao-N-origin-poda.md` (pasta de notas da orquestração).

**Premissa corrigida:** no oráculo o Origin está **ligado**.
- A migração `202610220009` cria `erp_sync.settings.enabled` com padrão `true`, então a fila do Origin era gravada nos dois motores.
- O desvio `origin-fora` (aplicado) deixa a sincronização desligada na semeadura e no oráculo do diferencial.

**O que sai:**
- **90 das 430 tabelas** do esquema gerado:
  - 72 tabelas e 2 visões em 16 schemas, incluindo `erp_fiscal_mirror` e `erp_integration`;
  - 16 tabelas de proveniência dentro de schemas nativos, como `erp_catalog.origin`, `erp_documents.origin_mirror`, `erp_finance.origin_import_origin`, `erp_fiscal_invoices.origin_item_*` e `erp_stock.opening_*`. Nenhuma FK nativa aponta para elas.
- **408 das 2.368 funções** (606 KB). 62 delas são RPCs que a erp-api chama.

**O que fica como constante:**
- `document.origin` e `authority` = 'brufap';
- `invoice_tag.origin`;
- `title.origin_zero_source_id` (sempre nulo).

`erp_catalog.product.origin` é a origem do ICMS: nativa.

**`MODULE_OWNED_BY_ORIGIN`** não existe no SQL: a erp-api traduz três 42501
(`index.mjs:201`), todos ligados a `authority='origin'`.

**Funções nativas que leem o estado do Origin: 151.** Só ~40 pedem poda de verdade:
- **68:** só tiram a linha `require_visible`;
- **23:** trocam `report_coverage` por uma constante.

**Linha de corte (proposta, não implementada):**

| Fica no ERP, genérico, sem "origin" | Como | Tabelas / funções |
|---|---|---|
| Fila de alterações para integrações | Hoje: 10 gatilhos AFTER capturam 9 entidades × 4 operações numa fila coalescida, entrega pelo menos uma vez, aluguel de 10 min. Proposta: registro de mudanças no próprio SQLite do ERP, na mesma transação, com cursor e `ack` por integração. As escritas feitas pela chave da própria integração ficam de fora, o que substitui `erp_sync.applying`. Uma projeção fina para os eventos `erp.*` do D1 é opcional; o D1 sozinho não serve como fila, porque não é atômico com o SQLite | 2 / ~6 |
| Vínculo de ids externos | `integration_link(integração, entidade, id externo ↔ registro)`; a idempotência já vem do `command_id` nativo | 1 / ~3 |
| Trava de posse por bloco | `integration_ownership(bloco)` conferida no despacho de RPC: escrita local num bloco que a integração controla responde 409; leitura não muda. Afeta as escritas de catálogo (48 RPCs), documentos (22), financeiro (22), estoque (41) e, com o financeiro, CNAB (18) | 1 / ~3 |

**O que se perde em relação aos espelhos do Fagoo:**
- os valores do Bling ao lado dos nativos;
- a granularidade por registro;
- a trava que depende do conteúdo do Bling.

O componente pode empurrar uma marca para o vínculo.

**O diferencial com o Origin desligado:**
- Prova toda resposta nativa e as regras que mudaram de lugar.
- Com o oráculo em `enabled=true`, prova ainda que o conjunto (entidade, registro, operação) da fila do Fagoo está contido no registro de mudanças.
- Não compara: carga útil, aluguel, aplicadores do pull, vínculo e semântica da trava.

**Vai para o componente externo (90 tabelas, 408 funções):**

| Grupo | Tabelas | Funções |
|---|---|---|
| Coletor da API do Bling | 12 | 50 |
| Staging | 11 | 20 |
| Capturas de preço | 6 | 24 |
| `browser_job` | 9 | 44 |
| Espelhos | 31 | 74 |
| Mão dupla | 10 | 73 |
| Conferências e virada | 0 | 43 |
| Importações revisadas | 11 | 80 |

Também saem:
- 18 arquivos da erp-api (210 KB);
- o worker `origin-sync` (29 arquivos, 186 KB);
- 12 arquivos do erp-domain;
- ~19 telas.

**Avaliação franca.** O contrato genérico (4 tabelas, 10–15 funções, ~500
linhas) cobre ~7% das linhas do domínio 12; os outros ~93% são reescritos no
componente, não portados.

O que não sai do ERP sem reescrita:
- **Gravar "como Origin":**
  - documento sem número, contato ou total, com situação `source_unknown`;
  - troca de `authority`;
  - título de valor zero;
  - adoção de saldo observado, com negativo permitido;
  - número do Bling no documento.
- **Leituras nativas que juntam dado bruto do Bling:**
  - notas do Bling na lista e nos relatórios fiscais;
  - histórico de item;
  - atividade;
  - bloqueio de CNAB;
  - `origin_stock`.

**Insumos do painel (sessão M) e decisões**

1. **Trava de posse.** No banco também não existe trava por bloco: só por registro.
   - O documento espelho (`authority='origin'`) é barrado por `guard_document`/`guard_item` e pelo `guard_effect` em 31 tabelas de efeito. Entre elas estão os lançamentos de estoque e os títulos do documento espelho. O estoque e o financeiro nativos ficam livres.
   - O documento convertido no Bling é barrado por `erp_sync.origin_locked`, que lê o payload do Bling.
   - O título importado tem campos travados (`erp_finance.guard_origin_import_title`). É travado por registro, sem ramo próprio no painel: a recusa aparece como conflito comum.

   Por isso o painel bate com o banco. Uma trava de **bloco** para estoque e financeiro na convivência é funcionalidade nova, e de pequeno porte:
   - a tabela `integration_ownership(block)`;
   - a conferência no despacho de RPC, com a classificação de escrita por RPC que já existe no inventário de rotas;
   - o erro 409 e os testes;
   - ao todo, ~0,3–0,5 mil linhas.

   **Não dá para deixar só no componente.** Ele não impede edição local no ERP; só o ERP pode recusar. Proposta: entra no contrato genérico na última etapa, valendo para os quatro blocos. A trava por registro do título importado vira uma marca no vínculo externo, com o mesmo conjunto de campos.
2. **Saldo de abertura.** `opening_command`, `opening_receipt` e `erp_stock_opening_{apply,batch,command,page,warehouses}` saem com o Origin.
   - Só servem à adoção do saldo do Bling: exigem um depósito do Origin vinculado (FK para `erp_warehouse_import.binding`).
   - Não viram abertura genérica. A empresa nova lança pelo "Lançamentos de estoque" (`erp_stock_post`, ajuste com data) ou pela planilha.
   - O importador externo lê o saldo atual e lança a diferença com a versão (`expected_version`), na data que quiser.
3. **Espelhos com dados próprios do Origin.** A lista do motor bate com a do painel:

| Painel | RPCs que saem |
|---|---|
| `DocumentMirrorView`, `DocumentOriginTotals` | `erp_document_mirror_project` |
| `OriginMirrorPanel` (contato e produto) | `erp_catalog_origin_mirror_get` |
| `StockOriginMirror` | `erp_stock_mirror_list`, `_project`, `_product_summary` |
| `OriginProductDeletions` | `erp_catalog_origin_deletions`, `_deletion_apply` |
| `OriginCatalogSync` | `erp_catalog_import_sources`, `_preview`, `_apply` |
| `OriginCategorySync` | `erp_catalog_origin_categories`, `_categories_sync` |
| `FiscalMirrorCoverage` | `erp_fiscal_mirror_project` |
| `FiscalOriginInvoiceView` | `erp_fiscal_invoice_origin_get`, `erp_synced_xml_list`, `_object`, `erp_history_xml`, `_xml_object` |

   - **Os outros RPCs que saem** batem com as telas que a M já removeu: `erp_cutover_*`, `erp_origin_*` (importação financeira, prontidão de vendas e compras, histórico de vendas, depósitos, observações de estoque, progresso), `erp_sync_*`, `erp_read_records`, `erp_history_backups` e `erp_itau_legacy_readiness`. São 62 RPCs ao todo.
   - **Campos que ficam como constante**, para não mudar a forma das respostas:
     - `origin_stock` na lista de produtos: `null`;
     - a cobertura dos relatórios: a constante `native_effects_only`;
     - `document.origin`/`authority`: `'brufap'`.

     O painel pode tirá-los quando quiser.

**O que o componente externo precisa da API do ERP** (detalhe em `sessao-N-rotas-blocos.md`):
- **Bloqueio:** `erpApi` recusa ator que não é pessoa, então nenhuma chave de aplicação chega ao ERP hoje (fase 3: escopos). Além disso, `/importacoes/*` é só de administrador no SQL.
- **Rotas de escrita que já existem** (todas exigem `command_id`):
  - contatos e produtos: um por chamada, ou lote de 50 em `/importacoes`, com upsert por documento ou código;
  - depósitos: só a rota legada `/cadastros/warehouses` aceita código;
  - saldo de abertura: `/estoque/movimentos`, que tem data, mas lança diferença conferida pela versão;
  - documentos e títulos em aberto: um por chamada;
  - XML de nota: `/notas-fiscais/importar`, que é do bloco fiscal.
- **Lacunas:**
  - nenhum id externo nas rotas públicas;
  - número do documento só com as preferências `*.editar_numero`; em pedido e OS, número usado vira o próximo livre sem aviso;
  - documento já fechado não entra sem disparar estoque e financeiro;
  - título nasce sem marca de pago (a baixa é outra chamada) e sem `original_due_on`;
  - saldo inicial no cadastro do produto sem data.
- **Só o Origin faz hoje:**
  - documento com número e situação originais, sem efeitos (`erp_sync.pull_document`);
  - título já pago na data histórica;
  - histórico de vendas fechado.
- **Proposta para o motor:** uma via de importação de administrador com referência externa e upsert, número, situação inicial sem efeitos, títulos baixados e saldo absoluto datado. A versão menor é estender `/importacoes/*` com essas colunas.

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
- **Antes de portar, o mapa:** `docs/erp-closure-map.json` diz o domínio de
  cada RPC, o fecho e as funções compartilhadas com dono. Função de outro
  domínio se usa pelo `public.ts` do dono; se ainda não existe, porte-a lá
  (não copie). Recibo de comando vindo de outro domínio leva escopo
  (`scopedCommand`).
- **Testes originais:** copie para `tests/erp/fagoo/`, troque a criação do
  banco por `dualFixture()`, as chamadas SQL de RPC por `f.rpc` e o SQL
  direto de escrita por `db.query` + `f.sync()`; asserções iguais; testes de
  `grant`/RLS saem (declare no cabeçalho). Função interna (não RPC) se
  compara com `f.dual(nome, pg, () => inTransaction(f.driver, ctx => …))`.
  Acrescente um diferencial aleatório (`stock-post-diff`,
  `cross-domain.test.mjs`).
- **Decimais:** escala por coluna em `columns.generated.ts`; `dec_text`
  (decimal em TEXT, acima de 18 dígitos) compara e soma em TS
  (`compareDec`, `exact`, `decText`), nunca no SQL.
- **Desvios do Fagoo:** só valores semeados, em
  `src/erp/schema/deviations.ts`, com motivo; nunca regra de negócio.
- **Esquema:** `scripts/erp/gen-sqlite.mjs` (decisões em
  `scripts/erp/overrides.mjs`, por domínio); `tests/erp/schema-parity.test.mjs`
  tem tetos para pendências (CHECK 222, gatilhos 240): baixe ao portar.
  `src/erp/schema/` e `src/erp/engine/` congelam depois da fase 0, com um
  dono; mudança no gerador sobe `ERP_DDL_VERSION`.
- **Regras do dialeto:** as dez acima, e `docs/ERP-FASE0.md`, prova 1.

## Roteiro da instalação de teste (sessão K)

Nada foi implantado. As sondas (`src/erp/probe.ts`) existem só com
`ERP_PROBES=1` no deploy, para administrador e com o módulo `erp` ligado na
área. `scripts/erp/staging-check.mjs` faz o resto:
- cria uma área nova, "ERP conferência … (apagar)", sem tocar a dos aparelhos;
- liga o `erp` nela e roda tudo com dados sintéticos;
- no fim apaga o objeto `erp:` da área e desliga o módulo. Não há rota para apagar área: a área vazia fica.

**O que implantar.**
- A instalação de teste hoje roda `feat/cupom-senha` (`e5d6db1`) para os aparelhos.
- Proposta: um branch de junção `staging/erp-conferencia` = `feat/cupom-senha` (`e5d6db1`) + `feat/erp-motor` no commit das sondas ou depois.
- A junção não tem conflito: `git merge-tree --write-tree origin/feat/cupom-senha feat/erp-motor` dá uma árvore limpa. Ainda não rodei os testes nessa árvore.
- O ERP nasce desligado em todas as áreas, então os aparelhos não veem diferença.

```
git fetch origin
git switch -c staging/erp-conferencia origin/feat/cupom-senha
git merge --no-ff origin/feat/erp-motor
npm run check
npx vitest run tests/erp-do-*.test.ts
npm run test:erp
```

**Passos.**
1. **Deploy com a configuração da instalação de teste:**
   `npx wrangler deploy --minify --var ERP_PROBES:1 --config <wrangler da instalação de teste>`.
   - Anote o **"Worker Startup Time"** e o tamanho total e gzip que o wrangler imprime: essa é a partida com `--minify` em produção.
   - Sem `--minify`, o pacote passa de 24 MB (prova 7).
2. **Conferência:**
   `node scripts/erp/staging-check.mjs --url https://<instalação de teste> --tail --config <wrangler da instalação de teste>`.
   - Usa o administrador de `.smoke.local.json` (o mesmo do `scripts/smoke.mjs`).
   - O `--tail` soma a CPU real (`cpuTime`) por chamada. Sem ele, leia em Workers → Observabilidade, filtrando por `/erp-probe/`.
   - O resultado sai em `output/staging-check-<instante>.json`.
3. **Comparar com o local:**

| Medida | Local (workerd) | Em produção (K, 16/11, `e5d6db1` + `a39dc06`) |
|---|---|---|
| CPU do `erp_stock_post` com 100 itens | 36–61 ms | até 39 ms |
| CPU do relatório de saldo (100 mil linhas) | 1,6–1,8 s | 299–437 ms |
| Primeira chamada (esquema + semeadura) | 0,86–0,95 s | 427 ms de CPU |
| Partida do Worker / pacote minificado | — | 62 ms / 7,8 MB (2,1 MB gzip) |
| Parâmetros por instrução | 100 (101 recusa) | igual |
| Profundidade de expressão | 100 | igual |
| Padrão LIKE | 50 bytes | igual |
| Tamanho de instrução | < 100.000 bytes | igual |
| Argumentos de função | — | não medido; a sonda `limits` passou a medir (`function_args`, `json_object_pairs`) |
| `getBookmarkForTime` | não implementado no local | atrasa 45–90 s (abaixo) |
| Colo do objeto com `locationHint: "sam"` | — | IAD (abaixo) |
| Costura (GET referências, p50/p95) | 9/12 ms | 573/659 ms no cliente (rede do Dell; rpc no objeto 5–14 ms) |

4. **Fim:** novo deploy **sem** `ERP_PROBES`, ou volta ao `feat/cupom-senha`, para as sondas sumirem.

### Achados da conferência na Cloudflare

1. **Dois 500 no roteiro** (marca B do bookmark, `37f1c34c-506c-44e0-8256-a0a95fa0c17e`; desligar o módulo na limpeza, `8336a4a1-f261-4e4c-b3ed-6be7b73b321b`). Não reproduziram com tail. O que o código diz:
   - **A marca B.** A sonda devolve 502 quando o objeto responde com erro. Um 500 na marca B quer dizer que o `erpFetch` lançou: a exceção veio do stub, sem resposta do objeto.
     - Segundo a documentação, o stub lança em erro transitório da infraestrutura (`.retryable`), em sobrecarga (`.overloaded`) e no reinício do objeto. Depois de uma exceção, o stub fica "quebrado".
     - Na hora da marca B, o objeto vinha de 80 mil linhas escritas e de instruções de 1 MB recusadas pela sonda de limites. O primeiro campo do bookmark (a geração do objeto) avançou por ociosidade.
     - Hipótese mais provável: um reinício do objeto entre as duas marcas, e a chamada pegou o objeto no meio do reinício.
   - **O desligamento.** O comando passa pelo objeto da área, não pelo `erp:`: é o `mutate` do `module.set`, que grava no D1 e emite o `module.changed`. Quase certamente não é o ERP. Uma corrida com o `wipe` (`deleteAll` no `erp:`) não se sustenta, porque são objetos diferentes.
   - **Para fechar a causa:** os dois `request_id` na Observabilidade (Workers → Logs) da instalação de teste, com a exceção e o `$workers.outcome`. É com a K, dona da instalação.
   - **Proposta, independente da causa:** a costura (`erpFetch`) tenta de novo **uma vez**, com stub novo, quando a exceção tem `.retryable` e não `.overloaded`.
     - Só para leitura, ou para RPC com `p_command_id`: o recibo do comando torna o repetir idempotente.
     - Todo o resto, inclusive sobrecarga, sai como 503 `erp_unavailable` com `Retry-After`, e não como 500.
     - São ~40 linhas e um teste. Fica para quando a orquestração aprovar.
2. **`locationHint: "sam"` não põe o objeto no Brasil.** A documentação diz duas coisas:
   - "sam" é aceito, mas Durable Objects ainda não nascem na América do Sul. O objeto nasce no **leste da América do Norte**, o que bate com o IAD e com os tempos da K.
   - Só o primeiro `get()` de um objeto respeita o hint, e o objeto não muda de lugar depois de criado. O `erpStub` passa o hint em toda chamada, o que é inofensivo.

   A latência do Brasil ao IAD (~120–150 ms por ida e volta) é piso de toda chamada do ERP, enquanto a Cloudflare não abrir DO na América do Sul. Atenuantes do nosso lado:
   - uma chamada ao objeto por pedido da erp-api (já é assim);
   - o painel junta leituras.

   **Como medir de verdade:**
   - a sonda `location` já devolve o colo da saída do objeto (`cdn-cgi/trace`) e o `worker_colo`;
   - acrescentar a medida de uma chamada vazia ao objeto, com o tempo dentro do objeto e no Worker, vinda de um Worker em GRU, dá o RTT Worker → objeto;
   - repetir em áreas novas, porque o lugar é escolhido na criação de cada objeto.
3. **`getBookmarkForTime` atrasa de 45 a 90 s.**
   - A restauração por tempo leva a um estado consistente, mas **anterior** ao instante pedido. A recuperação "no minuto" é aproximada e para trás.
   - Para um ponto exato, o comando de administrador guarda **bookmarks nomeados** (`getCurrentBookmark`) antes das operações de risco: atualização de esquema, importação em massa, restauração de backup. A restauração usa o nome.
   - A recuperação por tempo fica para acidente sem marca, com o aviso do atraso na tela.
4. **Acabamento (feito):**
   - a sonda `limits` mede argumentos de função (`max` com 100/127/128/1000 e `json_object` com 63/64/500 pares);
   - o `staging-check.mjs` faz logout no fim e, no Windows, encerra a árvore do `wrangler tail` (`taskkill /T /F`);
   - o teste de alarme do `erp-do-instance` tem tempo-limite de 60 s;
   - o cache do oráculo (`output/erp-oracle/*.tgz`) é escrito num arquivo próprio e troca de nome de forma atômica, sem `Z_BUF_ERROR` entre testes paralelos.

## Divisão em sessões (opinião)

Concordo com a proposta:
- **N:** núcleo transversal, Referências, Empresa e Acesso;
- **P:** Catálogo;
- **depois:** Estoque e Financeiro em paralelo, e então Documentos.

**O que cada sessão recebe pronto** (`feat/erp-motor`, `3532328` em diante):
- `public.ts` de todos os domínios, com stubs 0A000;
- registro de RPC por domínio;
- overrides por domínio;
- `docs/ERP-PORTE.md` com os donos;
- o harness;
- o Origin desligado.

**O que destrava o paralelismo:**
- **Testes de quem ainda não foi portado:** o RPC não portado roda só no Postgres e é espelhado no SQLite. Os testes de um domínio funcionam mesmo antes do Catálogo ou dos outros: o `erp_catalog_save` da preparação roda no oráculo.
- **O que de fato bloqueia** é o código portado chamar uma função compartilhada em stub. Por isso cada sessão começa pelas funções do seu `public.ts` que outros domínios usam (`ownership.generated.json`, `public_functions`), antes dos RPCs.
- **A minha parte:** `permissionKeys` e `resourcesForRole` (Acesso), que quase todo domínio chama.

**Quantas sessões ao mesmo tempo:**
- **3 de domínio, mais a N** como dona do motor e da integração. Por exemplo P (Catálogo), Estoque e Financeiro.
- **Acima disso o custo de coordenação passa o ganho:**
  - as funções compartilhadas se concentram em Acesso, Catálogo, Documentos e Financeiro;
  - cada pedido de mudança no motor passa por mim;
  - o caminho crítico (núcleo → Catálogo → Estoque/Financeiro → Documentos) não encurta com mais gente.
- **Uma 4ª sessão só faz sentido em Fiscal ou CNAB**, que dependem pouco dos outros, depois que o Financeiro tiver o seu `public.ts`.

**Integração:**
- Cada sessão trabalha no seu branch a partir do `feat/erp-motor` e o atualiza com frequência.
- Arquivos gerados (`ownership.generated.json`, `stubs.generated.ts`, `seed`, `ddl`) não se fundem à mão: regeneram-se depois da junção.
- Os tetos de pendência de `schema-parity` são um arquivo só: quem fecha domínio baixa o teto no seu branch, e eu concilio ao integrar.
