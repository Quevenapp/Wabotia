# Porte do check-in e estoque da nota fiscal

As 16 RPCs foram implementadas e registradas. Fontes finais: migrações 147 (check-in), 181 (itens/responsáveis), 259 (estoque da nota e finalizar lançando) e 295 (conversão de unidades). Nenhum bloqueio por stub de outro domínio.

| Função pública | Situação |
| --- | --- |
| `erp_stock_checkin_get` | Portada |
| `erp_stock_checkin_save` | Portada |
| `erp_stock_checkin_issue` | Portada |
| `erp_stock_checkin_batch` | Portada |
| `erp_stock_checkin_restart` | Portada |
| `erp_stock_checkin_finish` | Portada |
| `erp_stock_checkin_finish_post` | Portada |
| `erp_stock_checkin_post_preview` | Portada |
| `erp_stock_invoice_flags` | Portada |
| `erp_stock_invoice_get` | Portada |
| `erp_stock_invoice_preview` | Portada |
| `erp_stock_invoice_post` | Portada |
| `erp_stock_invoice_reverse_preview` | Portada |
| `erp_stock_invoice_reverse` | Portada |
| `erp_stock_invoice_units` | Portada |
| `erp_stock_invoice_unit_save` | Portada |

## Arquivos

- `src/erp/domains/stock/rpc/checkin.ts`: consulta, quantidades recebidas, pendências, lote, reinício, finalização e integração ao lançamento. Preserva cópia da nota, CAS, recibos, histórico, item recusado e conferência finalizada.
- `src/erp/domains/stock/rpc/invoice-stock.ts`: flags, histórico, prévias, lançamento/estorno e fatores por fornecedor. Quantidades calculadas com BigInt; conversões inexatas recusadas; composição na saída usa o auxiliar existente. Ordenação textual com `pgCompareText`.
- `src/erp/domains/stock/index.ts`: importa os dois módulos.
- `tests/erp/stock/checkin.test.mjs` e `invoice-stock.test.mjs`: 16 cenários com `dualFixture`/`f.rpc` e verificação explícita de que as 16 RPCs estão registradas. Cobrem caminhos felizes, erros de validação, papéis, replay/conflito de comando, CAS, nota alterada/fechada/vazia, recusados, unidades, kits, referências/reservas, estorno e releituras por saldos/movimentos. Também conferem overflow da soma por produto e campos nulos de pedidos em edição.
- `tests/erp/stock/invoice-fixture.mjs`: semeadura de notas/itens, no padrão usado pelos testes do Fiscal, sem modificar o harness.
- `scripts/erp/overrides/stock.mjs`: declara as garantias dos quatro gatilhos de escrita cumpridas pelo código.
- `tests/erp/schema-parity.test.mjs`: reduz o teto de gatilhos pendentes de 221 para 217, sem alterar os demais tetos.
- `tests/erp-painel-rotas.test.ts`: troca a escrita pendente por `erp_stock_item_components_save`, via POST `/v1/estoque/composicoes/itens/{id}`. Conferido em `stock-compositions.mjs`: valida o corpo e chama o RPC diretamente.
- `web/erp/motor.ts`: nenhuma alteração necessária; check-in já não constava de `MOTOR_PENDING`, e as leituras iniciais das telas fiscais continuam pendentes.

## Internas e stubs

Implementadas em funções ou etapas dos novos módulos:

- Check-in: `checkin_requested`, `checkin_item_state`, `checkin_items`, `checkin_dto`, `checkin_begin`, `checkin_advance`, `checkin_result`, `checkin_current`, `checkin_post_lines`, `checkin_post_begin`.
- Nota: `invoice_label`, `invoice_posting_dto`, `invoice_day`, `invoice_summary`, `invoice_reserved`, `invoice_block`, `invoice_preview_data`, `invoice_reverse_preview_data`, `invoice_replay`, `invoice_lock`, `unit_key`, `invoice_supplier`, `invoice_unit_rule`, `invoice_units_dto`.
- Reutilizadas as funções já portadas de acesso/DTO da lista de check-in, flags/referências, composição, postagem, compensação de saldo, comandos derivados e custo.
- Garantidos pelos escritores: `guard_checkin`, `guard_checkin_item`, `guard_invoice_posting`, `guard_unit_conversion`. Recibos e eventos continuam protegidos também pelos gatilhos imutáveis já presentes no SQLite.

**Internas retiradas de `stubs.generated.ts`: nenhuma.** As internas novas acima não constavam dos stubs compartilhados desta base. As dependências necessárias já portadas foram reutilizadas; não foi necessário implementar função de outro domínio. `closure-map` e `gen-ownership` foram executados; os arquivos gerados permaneceram sem diferenças, inclusive fora do Estoque.

## Paridade e validação

Nenhuma divergência deliberada do oráculo foi introduzida. O cabeçalho do teste de check-in registra a convenção existente: o contrato compara código/mensagem, sem o campo PostgreSQL `DETAIL`. Não foram alterados o harness, desvios, esquema, migrações, configuração Cloudflare ou limites globais.

Validações executadas:

- `npx tsc --noEmit`: passou, inclusive na conferência final.
- `node --no-warnings --test --test-concurrency=3 "tests/erp/stock/**/*.test.mjs"`: passou, 21 arquivos, zero falhas.
- Testes direcionados dos dois módulos, incluindo os cenários adicionais, overflow e campos nulos: passaram.
- `node --no-warnings --test tests/erp/schema-parity.test.mjs`: passou; repetido com o teto reduzido, também passou.
- `node scripts/erp/closure-map.mjs --fns --json output/closure-fns.json` e `node scripts/erp/gen-ownership.mjs`: passaram.
- Conferência adicional temporária com a API do `node:test`: confirmou 14 cenários individuais aprovados; os dois casos posteriores (overflow e campos nulos) passaram nas respectivas rodadas direcionadas. Scripts de diagnóstico removidos; logs locais em `output/`.
- `git diff --check` e `node scripts/check-conflict-markers.mjs`: passaram.
- `node scripts/check-encoding.mjs`: não concluiu, por `spawnSync git EPERM` do ambiente. A checagem direta dos arquivos alterados confirmou UTF-8 válido, sem BOM, sem CR e sem caracteres corrompidos.

Vitest e Wrangler não foram executados, conforme a regra da máquina. `verifica.sh` não está presente nesta pasta; a validação do painel e a verificação externa ficam para o script da máquina. Nenhum commit, push ou troca de branch. Sem dúvidas de regra de negócio em aberto.
