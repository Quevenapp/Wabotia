# Porte do Estoque — depósitos, abertura, transferência e produto

Estado final: **10 dos 10 RPCs portados**. A continuação completa as três RPCs
de abertura antes bloqueadas e corrige a ordenação da transferência.

## Função por função

| RPC | Estado final |
| --- | --- |
| `erp_stock_warehouse_save` | Portado na entrega anterior; preservado. |
| `erp_stock_opening_warehouses` | Portado na entrega anterior; preservado. |
| `erp_stock_opening_page` | Portado: classificação da fonte e do produto nativo, contagens, filtros e paginação em ordem C. |
| `erp_stock_opening_command` | Portado na entrega anterior; reutilizado para recibo e estado atual das adoções. |
| `erp_stock_opening_batch` | Portado: seleção dos pendentes e hash da prévia vinculando administrador, depósito, data, produto, unidade, versão e quantidade. |
| `erp_stock_opening_apply` | Portado: validação, repetição, conflitos, adoção positiva/zero/negativa, motivos por item e atomicidade. |
| `erp_stock_transfer_positions` | Portado na entrega anterior; preservado. |
| `erp_stock_transfer_batch` | Portado; ordenação das linhas corrigida para `pgCompareText`. |
| `erp_stock_movement_amend` | Portado na entrega anterior; preservado. |
| `erp_stock_product_create` | Portado na entrega anterior; preservado. |

## Arquivos desta continuação

- `src/erp/domains/sync/cutover.ts`: `stockObservationId`, porte de
  `erp_cutover.stock_observation_id(jsonb)` da migração 087; mantém IDs
  textuais exatos, recusa só zeros e limita números a 9007199254740991.
- `src/erp/domains/sync/public.ts`: exporta essa função. O Estoque a acessa
  exclusivamente pela porta pública de Sync.
- `src/erp/domains/stock/rpc/opening.ts`: registra `page`, `batch` e `apply`;
  implementa `opening_day`, `opening_binding`, `opening_number`,
  `opening_rows` com a projeção de `opening_row_dto`, `opening_counts` e
  `opening_preview_hash`; reutiliza as demais internas existentes.
  A FK SQLite do recibo para o comando é imediata: os recibos são preparados
  durante o lote e inseridos depois do comando, na mesma transação.
  O comando derivado usa `md5(...)::uuid`, conservando todos os bits do SQL.
- `src/erp/domains/stock/rpc/opening-source.ts`: lê o JSON armazenado sem
  converter os dígitos decimais para ponto flutuante; conserva escala,
  precisão e texto canônico na validação da observação e no hash.
- `src/erp/domains/stock/rpc/transfers.ts`: substitui `localeCompare` por
  `pgCompareText` na ordenação das linhas de `erp_stock_transfer_batch`.
- `tests/erp/stock/opening.test.mjs`: amplia os testes diferenciais com dados
  em `origin_sync.raw_record`, `erp_warehouse_import.binding` e vínculos do
  Catálogo semeados pelo `f.db`. Cobre acesso só de administrador, entradas,
  datas, observações missing/invalid/available, lista de depósitos, precisão,
  contagens e paginação; adoção positiva/zero/negativa, repetição, conflitos,
  mudança de fonte/unidade/política, movimentos nativos, depósito inativo,
  rollback do lote, instantes infinitos e preservação dos números do JSON.
- `codex-estoque-depositos.md`: atualiza este relato.

## Fonte SQL, Sync e funções fora do escopo

A busca por `create function` e `create or replace function` em todas as
migrações confirmou as últimas definições: `stock_observation_id` na
`202610160087_origin_stock_observations.sql`; abertura e internas na
`202610190100_stock_opening_negative_policy.sql`.

**Nenhuma das dez RPCs ficou de fora.** A última `erp_stock.opening_rows`
chama somente `erp_cutover.stock_observation_id`. Portanto essa é a única
`erp_cutover.*` portada nesta continuação. `stock_observation_row`,
`stock_observation_warehouse`, `stock_observation_product` e
`purchase_observed` não são chamadas pela abertura e não foram portadas.
Continuam fora desta tarefa as RPCs de consulta de observações da Origem.
Não houve dependência necessária em tabela ausente ou stub de outro domínio;
não foi criado substituto para função não portada.

`node scripts/erp/gen-ownership.mjs` foi executado com sucesso e não produziu
diferenças nos arquivos gerados. O gerador existente exclui `erp_cutover`
como Origin; sua classificação não foi alterada. A implementação nova está
em Sync e explicitamente exportada em `sync/public.ts`.

## Verificação

- `npx tsc --noEmit`: passou na rodada final, sem diagnósticos.
- `node --no-warnings --test --test-concurrency=3 "tests/erp/stock/**/*.test.mjs"`: passou; 19 arquivos, 19 aprovados, zero falhas/skip/todo, 144,7 s. O arquivo de abertura contém 11 cenários.
- `node --no-warnings --test tests/erp/schema-parity.test.mjs`: passou, zero falhas.
- `node scripts/erp/gen-ownership.mjs`: passou; nenhuma diferença gerada.
- Teste de abertura em diagnóstico com `--experimental-test-isolation=none`:
  os nove cenários então existentes passaram após corrigir a semeadura do
  produto inativo e a ordem de gravação exigida pela FK SQLite. Na rodada
  seguinte, o caso adicional de timestamp infinito revelou um `SELECT *`
  que ainda lia o inteiro sentinela como número JS; corrigido para projeção
  explícita com inteiros grandes em texto. A suíte final passou com todos
  esses casos mantidos.
- `git diff --check`: passou. Verificação direta dos sete arquivos alterados: UTF-8 estrito, sem BOM, LF, sem U+FFFD.

Nenhum teste foi apagado ou enfraquecido; não foram introduzidas exceções
para comparação de hashes nesta continuação. O teste anterior de criação de
produto conserva suas duas declarações de hash opaco sobre o UUID novo
(`erp_stock.command.request_hash` e `erp_stock.ledger_command.request_hash`).
Permanecem intactos o harness,
esquema, migrações, outros domínios, Durable Objects e limites globais.
Sem rede, vitest, wrangler, commit, push ou troca de branch.

## Fora da execução e dúvidas

Vitest e wrangler ficam para o script externo, conforme as regras da máquina.
Limite preexistente fora do escopo: `engine/args.ts` e `engine/time.ts`
aceitam datas de argumento somente em formato ISO finito. Literais PostgreSQL
como `p_occurred_on = infinity` são recusados pelo conversor compartilhado
com 22007 antes de chegar à guarda de abertura (que no SQL retorna 22023).
Esse conversor não foi alterado. Isso não afeta a leitura de timestamps
infinitos já armazenados na observação, coberta nesta entrega.

Não há dúvida de domínio pendente; o bloqueio anterior foi resolvido pela
porta pública de Sync autorizada nesta tarefa.
