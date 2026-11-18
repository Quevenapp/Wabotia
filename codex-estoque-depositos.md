# Porte do Estoque — depósitos, abertura, transferência e produto

Estado: **parcial, 7 dos 10 RPCs portados**. Nenhuma alteração em esquema,
harness, migrações, recursos Cloudflare ou outros domínios. Sem commit, push,
troca de branch, rede, vitest ou wrangler.

## Função por função

| RPC | Estado |
| --- | --- |
| `erp_stock_warehouse_save` | Portado: criação/edição do Catálogo pela porta pública, configuração do depósito, versões, hash e recibo. |
| `erp_stock_opening_warehouses` | Portado: vínculos existentes, ordenação, limpeza de texto e acesso de administrador. |
| `erp_stock_opening_page` | Não portado: depende de `erp_stock.opening_rows`, que chama `erp_cutover.stock_observation_id`; não há implementação/porta pública dessa função do Origin. |
| `erp_stock_opening_command` | Portado: recibo original, estado atual das adoções e controle de autoria. |
| `erp_stock_opening_batch` | Não portado: mesma dependência externa de `opening_rows`. |
| `erp_stock_opening_apply` | Não portado: mesma dependência externa de `opening_rows`. |
| `erp_stock_transfer_positions` | Portado: saldos, reservas, elegibilidade, sugestões de preço/custo e lotes disponíveis. |
| `erp_stock_transfer_batch` | Portado: transação por lote, comandos derivados, versões, recibo e transferência opcional de lote. |
| `erp_stock_movement_amend` | Portado: revisões de preço/custo/nota sem reescrever entradas, acesso ao documento e casas decimais de entrada. |
| `erp_stock_product_create` | Portado: produto pela porta pública do Catálogo e saldo inicial na mesma transação. |

## Arquivos

- `src/erp/domains/stock/rpc/warehouses.ts`: adiciona `warehouse_save` e usa `catalog/public.ts::mutate`; preserva a guarda de versão/configuração por comando.
- `src/erp/domains/stock/rpc/opening.ts`: duas leituras de abertura e auxiliares de acesso, texto, depósito e recibos.
- `src/erp/domains/stock/rpc/transfers.ts`: duas RPCs de transferência e `entrySuggestions`, reutilizando lançamentos, reservas, custos e camada de lotes existentes.
- `src/erp/domains/stock/rpc/movement-amend.ts`: RPC de revisão do movimento.
- `src/erp/domains/stock/rpc/product-create.ts`: RPC de criação com saldo inicial.
- `src/erp/domains/stock/rpc/launch.ts`: exporta as validações existentes `price105` e `entryPriceCheck` para o ajuste.
- `src/erp/domains/stock/rpc/erp_stock_post.ts`: exporta a implementação física existente como `postPhysical025`.
- `src/erp/domains/stock/index.ts`: registra os quatro arquivos novos.
- `src/erp/domains/stock/public.ts`: expõe auxiliares já implementados e utilizados pelo fecho destes RPCs.
- `src/erp/domains/stock/stubs.generated.ts` e trecho `stock` de `src/erp/domains/ownership.generated.json`: regenerados; somente mudanças do Estoque mantidas.
- `tests/erp/stock/warehouses.test.mjs`: casos de gravação do depósito.
- `tests/erp/stock/opening.test.mjs`: leituras de depósitos vinculados e recibos existentes, incluindo adoção zero.
- `tests/erp/stock/transfers.test.mjs`: posições, lote de transferência, versões, atomicidade, preços e lotes físicos.
- `tests/erp/stock/movement-amend.test.mjs`: revisões, repetição, recusas e preferência de casas decimais.
- `tests/erp/stock/product-create.test.mjs`: criação, rollback, repetição, conflitos, papéis e releitura de saldos/movimentos.
- `tests/erp-painel-rotas.test.ts`: a ação ainda sem motor passa a usar `POST /v1/estoque/checkin/notas/:id/recebidos` (`erp_stock_checkin_save`). Conferida a validação do corpo e chamada direta ao RPC em `stock-checkin.mjs`, `stock.mjs` e `index.mjs` da erp-api.
- `web/erp/motor.ts`: sem mudança necessária; nenhuma entrada de `MOTOR_PENDING` corresponde a uma tela liberada por este porte.

## Internas que saíram do stub

`commandTaken`, `compositionOwnStock`, `negativeAllowed`, `invoiceScreen`,
`ledgerOrigin` e `postPhysical025`. As implementações já existiam no Estoque;
foram expostas em `public.ts`, e o gerador retirou os seis stubs.

Internas implementadas nesta entrega que não tinham stub compartilhado:
`entrySuggestions`, `openingAccess`, `openingText`, `openingWarehouseDto` e
`openingCurrent` (inclui a montagem de `opening_receipt_dto`). Guardas de
cadastro, saldo, reserva e lote permanecem nas camadas de escrita existentes.

## Dependência externa e limites

Não foi encontrado um stub `notPorted` de outro domínio que impeça os sete
RPCs implementados. O bloqueio das outras três é uma **porta ausente**:
`erp_cutover.stock_observation_id(jsonb)` não existe em nenhum `public.ts`.
O gerador exclui explicitamente `erp_cutover` como Origin, por isso nem gera
um stub para ela. Sua fonte é a migração local
`202610160087_origin_stock_observations.sql`; `opening_rows` a utiliza para
validar os IDs do produto observado e da lista de depósitos.

A regra da tarefa permite chamadas externas só por `public.ts` e proíbe
alterar outro domínio. Foi solicitada orientação sobre reproduzir a validação
no Estoque ou manter o bloqueio; sem resposta, mantidas as três RPCs sem
registro. Não foi substituída a observação por uma lista vazia nem criada uma
implementação parcial que anuncie sucesso. Assim, o critério de conclusão de
10 RPCs **não foi atingido**.

Neste checkout, `catalog.json` traz assinatura/metadados dos RPCs e
`function_source` nos gatilhos, não nos objetos desses dez RPCs. Os corpos
foram conferidos nas migrações locais, incluindo a redefinição de
transferências da 258 e a revisão de movimento da 277.

## Diferença documentada no diferencial

Na criação com saldo inicial, os hashes internos de `erp_stock.command` e
`erp_stock.ledger_command` incluem o UUID do produto recém-criado, que é
aleatório e diferente em cada motor. O teste declara somente essas duas
colunas por `registerOpaqueHash`, API já existente do harness, com o motivo.
O hash externo de `supply_command` continua literal; recibos, estado das
tabelas, repetição e conflitos continuam comparados. Nenhum arquivo do
harness foi alterado. Não há desvio de regra de negócio deliberado.

## Verificação

- `npx tsc --noEmit`: passou na rodada final, sem diagnósticos.
- `node --no-warnings --test tests/erp/schema-parity.test.mjs`: passou (1 arquivo, zero falhas).
- `node --no-warnings scripts/erp/closure-map.mjs --fns --json output/closure-fns.json` e `node scripts/erp/gen-ownership.mjs`: passaram; restauradas as saídas fora do Estoque.
- `git diff --check`: passou.
- `node scripts/check-encoding.mjs`: não concluiu, pois `spawnSync git` recebeu `EPERM` no ambiente. Verificação direta dos 18 arquivos alterados passou: UTF-8 estrito, sem BOM, LF e sem U+FFFD.
- `node --no-warnings --test --test-concurrency=3 "tests/erp/stock/**/*.test.mjs"`: passou, 19 arquivos, 19 aprovados, zero falhas/skip/todo, 195,6 s.
- `verifica.sh`/vitest do painel: não executados, conforme a regra da máquina; ficam para o script externo. Não há `verifica.sh` neste checkout.

As falhas intermediárias foram corrigidas (campos de lote da versão 258,
preparação dos dados dos testes e hashes sobre UUID novo); não foram apagadas
asserções para esconder divergências. A cobertura dos três RPCs bloqueados
não foi criada como se fossem portados: o harness espelha RPC sem registro,
o que daria uma falsa impressão de paridade.
