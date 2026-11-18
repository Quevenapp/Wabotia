# Porte dos componentes do item — relato completo

Atualizado em 18/11/2026, após nova leitura da tarefa e de `.codex-verificacao.log`. Os dois RPCs estão portados; TypeScript, Estoque e paridade passaram novamente nesta retomada. A verificação externa completa continua com uma falha no painel: o cenário escolhido pelo teste usa uma rota removida. A correção preparada foi conferida novamente, mas não aplicada porque o item 4 da tarefa proíbe expressamente alterar esse teste. A exceção específica foi apresentada nesta conversa, com o patch e as asserções preservadas; até esta atualização, sem resposta. Portanto, a tarefa completa ainda tem essa pendência.

## Implementação entregue

- `src/erp/domains/stock/rpc/item-components.ts`: implementa `erp_stock_item_components`, `erp_stock_item_components_save`, `itemComponentsDto`, a guarda de gravação dos componentes e a gravação de auditoria/recibo.
- `src/erp/domains/stock/index.ts`: registra o novo arquivo. Conferência em execução contra ownership: **108/108 RPCs do Estoque registrados**.
- Fonte: `202610200280_stock_item_components.sql`, com as alterações posteriores de visibilidade/autoridade em `202610220007_document_mirror_guards.sql`. A busca em todas as migrações confirmou essas últimas definições; o DTO permanece na migração 280.
- A leitura retorna estrutura vigente ou edição específica do item, versões, quantidades/total, saldo visível conforme o papel e motivo de bloqueio.
- O save valida entrada, acesso, documento/item, estrutura e componentes; aplica CAS do documento e da edição dos componentes; grava, substitui ou restaura a estrutura original. Mantém recibo idempotente, conflito de comando entre famílias e auditoria `kit_components`.
- Os cálculos usam decimais exatos, incluindo limites de precisão e total `numeric(30,12)`. Uma falha desfaz a transação.
- `editable` é chamada exclusivamente por `../../documents/public.ts`. A atualização do documento e suas guardas/gatilhos passam por `documents.updateDocument`, também pela porta pública.

## Garantias de gatilhos

`scripts/erp/overrides/stock.mjs` declara 14 coberturas com `where` e `test`:

1. `erp_stock__item_component.guard_stock_item_component`: versão inicial 1, avanço unitário, identidade preservada e comando novo.
2. `erp_stock__item_component.aa_mirror_authority`: autoridade na inserção, atualização e exclusão.
3. `erp_stock__item_component_command.aa_mirror_authority`: autoridade antes do recibo; sua imutabilidade já está em SQL.
4. `erp_documents__audit.aa_mirror_authority`: autoridade antes da auditoria.
5. `erp_documents__document.aa_mirror_authority`: identidade e autoridade pela camada pública de Documentos.
6. `erp_documents__document.ab_origin_effects`: preservação dos campos protegidos por efeitos; o save altera versão e metadados.
7. `erp_documents__document.guard_trash`: documento excluído é recusado, com rollback dos componentes.
8. `erp_documents__document.protect_document_finance`: guarda financeira pela camada pública.
9. `erp_documents__document.protect_document_stock`: bloqueio com lançamento ativo e guarda de Estoque.
10. `erp_documents__document.protect_purchase_receipt_document`: preservação do documento com recebimento ativo.
11. `erp_documents__document.protect_reserved_document`: bloqueio com reserva ativa e guarda de Estoque.
12. `erp_documents__document.zz_origin_sync`: captura pelo caminho público, respeitando o desvio existente de Origin desligado.
13. `erp_documents__document.commission_operation_capture`: captura adiada por atualização.
14. `erp_documents__document.cost_apply_capture`: captura adiada de custo, na ordem da transação.

O teto `triggers_pending` em `tests/erp/schema-parity.test.mjs` caiu de **202 para 188**. Os demais tetos não foram aumentados.

## Cobertura diferencial

`tests/erp/stock/compositions.test.mjs` substitui o TODO por oito testes novos, somando 13 com os cinco anteriores. Usa `dualFixture`, `f.rpc` e comparações internas `f.dual` para as guardas. Cobre:

- Leitura, inserção, alteração e restauração em pedidos de venda e ordens de serviço; releitura pela mesma RPC e por `erp_document_stock_preview` do mesmo documento.
- Replay, inclusive de recibo antigo depois da restauração; conflito por conteúdo/ator, comandos de outras famílias e conflitos das versões do documento e dos componentes do item.
- Cada erro `22023`: consulta inválida, entrada inválida, operação sem mudança e componente indisponível; limites, duplicados, tipos, UUID, quantidade e campos desconhecidos.
- Papéis admin, consulta, vendas, financeiro, estoque, fiscal e inativo; visibilidade do saldo e permissão de escrita.
- As oito situações recusadas por `editable` que existem nos tipos aceitos pelo save. `completed` só existe em propostas: testada como `locked` no DTO diferencial e como tipo de documento recusado pelo save.
- Produto simples, estrutura ausente, modo somente produto, lançamento/reserva/nota fiscal ativos, lixeira, documento espelhado e edição antiga vinculada a outro produto.
- Auditoria, imutabilidade, autoridade, ordenação dos componentes, precisão, overflow com rollback e quantidade nula no espelho.

Nenhum TODO permanece em `tests/erp/stock`. Não houve contorno de divergência por ID/hash gerado na mesma chamada, nem alteração do harness.

## Causa da falha externa e correção preparada

O fim de `.codex-verificacao.log` registra **108 testes do Estoque aprovados**, **7 testes de paridade aprovados** e, depois, **8 testes do painel aprovados e 1 falho**.

O teste `ação de tela sem motor (0A000) avisa a casca em vez de só falhar`, em `tests/erp-painel-rotas.test.ts`, envia `POST /v1/importacao-cadastros/products/apply`. O prefixo `/v1/importacao-cadastros` está no bloco `externo` em `src/erp/blocks.ts`. `erpApi`, em `src/erp/api/local-fetch.ts`, devolve **404 `erp_route_removed` antes de chamar o RPC**. Portanto, a chamada não chega a `erp_catalog_import_apply` e não pode produzir o **502 `ERP_UPSTREAM_UNAVAILABLE`** esperado pelo teste. Trata-se de incompatibilidade entre o cenário do teste e a classificação atual da rota, independente dos dois RPCs do Estoque.

A correção proposta está em `output/estoque-painel-correcao-proposta.patch` (artefato local em diretório ignorado; não aplicado). Troca somente a ação por `controller.fiscalDraft`, com `POST /v1/rascunhos-fiscais` e corpo válido de criação. O setup existente habilita `erp-fiscal`; `erp_fiscal_draft_execute` ainda não está registrado. Permanecem intactas as asserções de `AccessError`, status **502**, código **ERP_UPSTREAM_UNAVAILABLE** e exatamente um aviso da casca, assim como o tempo-limite.

Um diagnóstico local, novamente executado nesta retomada sem rede e sem Vitest, verificou a classificação das duas rotas, passou o corpo proposto pelo parser real `parseFiscalDraftRoute` e executou `executeFiscalDraftRoute` com o registro real de RPCs: recebeu **0A000 `rpc_not_ported:erp_fiscal_draft_execute`**. Também conferiu os **108/108 RPCs do Estoque registrados**, comparados com ownership. Isso valida a escolha da ação, mas não substitui a execução integrada do painel no Worker.

O item 4 da tarefa diz: “Não mexa nele, a não ser que esta tarefa porte essa função (não porta).” Por isso o teste permanece inalterado, aguardando a exceção solicitada. Reabrir a rota removida em produção mudaria uma decisão explícita da instalação e não é a correção proposta. **A falha do painel ainda não está resolvida na árvore de trabalho.**

## Verificação desta retomada

| Verificação | Resultado |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` (binário local, equivalente ao `npx tsc --noEmit`, sem possibilidade de download) | Passou, código de saída 0 |
| `node --no-warnings --test --test-concurrency=3 "tests/erp/stock/**/*.test.mjs"` | Passou; TAP local reportou 25 arquivos, zero falhas, cancelamentos, skips ou TODO; 107,6 s |
| `node --no-warnings --test tests/erp/schema-parity.test.mjs` | Passou; TAP local reportou o arquivo aprovado, zero falhas, cancelamentos, skips ou TODO; 13,7 s |
| `node --no-warnings scripts/erp/closure-map.mjs --fns --json output/closure-fns.json` | Passou |
| `node --no-warnings scripts/erp/gen-ownership.mjs` | Passou; nenhuma diferença adicional mantida nos gerados; outros domínios preservados |
| Registro das RPCs e diagnóstico da rota substituta | Passou |
| `git diff --check`, marcadores de conflito e conferência direta de codificação dos arquivos alterados/novos | Passaram; UTF-8 sem BOM/U+FFFD/mojibake, com LF |
| `node scripts/check-encoding.mjs` | Não concluiu: `spawnSync git EPERM` na área restrita; a conferência direta acima cobre os arquivos desta entrega, não substitui a guarda global |
| `git apply --check output/estoque-painel-correcao-proposta.patch` | Passou; apenas conferência, sem aplicar o patch |

Nesta retomada foram usados os comandos exigidos, com isolamento padrão. As contagens externas de 108 testes de Estoque e 7 de paridade vêm do log fornecido, não de uma nova execução externa. Na retomada anterior, registrada neste mesmo relato, execuções adicionais sem isolamento mostraram 13 testes de composições e 7 de paridade aprovados; elas não foram repetidas agora. Uma busca em `tests/erp/stock` confirmou novamente a ausência de TODO.

Logs desta retomada: `/tmp/estoque-retomada-tsc.log`, `/tmp/estoque-retomada-stock.log`, `/tmp/estoque-retomada-schema.log`, `/tmp/estoque-retomada-closure.log`, `/tmp/estoque-retomada-ownership.log` e `/tmp/estoque-retomada-diagnostico.log`. O log do TypeScript está vazio porque o comando terminou sem diagnósticos, com código 0.

## Escopo e pendência

As alterações de implementação continuam limitadas aos dois arquivos de Estoque, seus overrides, o teste de composições e a redução do teto de paridade, além deste relato. Esta retomada confirmou o diagnóstico e refez as verificações; não mudou a implementação nem os testes existentes. Harness, esquema, migrações, Wrangler, outros domínios e teste do painel foram preservados. Sem rede, Vitest, commit, push ou troca de branch. O Vitest mencionado no diagnóstico foi executado pela verificação externa fornecida, não nesta retomada.

Falta autorizar a exceção pontual ao item 4, aplicar o patch preparado e obter nova verificação externa do painel. Não se declara a verificação completa aprovada enquanto isso não ocorrer.
