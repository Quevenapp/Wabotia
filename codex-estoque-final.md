# Estoque — porte final (relato consolidado, 18/11/2026)

18 RPCs implementadas e registradas; 2 interrompidas por dependência de Documentos. O fechamento **continua reprovado**: as duas divergências de id/hash novo foram reproduzidas e dependem da sessão dona do harness congelado. As correções anteriores de instantes não finitos no espelho permanecem válidas, com regressões diferenciais aprovadas. Nesta nova retomada, a causa da reprovação externa foi confirmada; não foi aplicada uma correção artificial em produção nem alterada a comparação para tornar a suíte verde. Nenhum teste existente foi removido, pulado, enfraquecido ou adaptado para aceitar essas divergências; nenhum arquivo de `tests/erp/harness/` foi alterado.

## Função por função

| RPC | Situação |
| --- | --- |
| `erp_stock_composition_get` | Portada; diferencial passou, incluindo kit virtual. |
| `erp_stock_composition_components` | Portada; busca, exclusão, acesso e validações. |
| `erp_stock_composition_launch` | Portada; lançamento físico/virtual, replay, comando, versão e precisão. |
| `erp_stock_composition_launches` | Portada; leitura dos movimentos e linhas. |
| `erp_stock_composition_export` | Portada; ordenação, paginação e excluídos. |
| `erp_stock_product_compose` | Portada; criação, atualização, estrutura, recibo, CAS e sincronização de valores. |
| `erp_stock_item_components` | **Não portada:** `erp_stock.item_components_dto` chama `erp_documents.editable`, ainda stub em `documents/public.ts`. |
| `erp_stock_item_components_save` | **Não portada:** depende do mesmo DTO e stub. Nenhum registro parcial foi criado. |
| `erp_document_stock_get` | Portada; documento, itens e histórico de lançamentos. |
| `erp_document_stock_list` | Portada; busca, elegibilidade e paginação. |
| `erp_stock_document_warehouse_preview` | Portada; depósito escolhido, validações e CAS. |
| `erp_stock_document_warehouse_post` | Portada; lançamento, auditorias, replay e conflitos. |
| `erp_stock_purchase_suggestion` | Portada; vendas, compras pendentes, reservas, preços e relatório. |
| `erp_stock_purchase_receive_preview` | Portada; reutiliza conferência de recebimentos com depósito escolhido. |
| `erp_stock_purchase_receive` | Implementada; diferencial pendente em `current.document.chain_hash`, descrito abaixo. |
| `erp_stock_purchase_reverse_all` | Portada; estorno de recebimento existente, replay, conflito e versão passaram. |
| `erp_stock_report_purchase_orders` | Portada; agrupamento por fornecedor/produto, filtros, totais e papéis. |
| `erp_stock_mirror_list` | Portada; posições locais, filtros e cobertura. Corrigido o fallback do carimbo quando o staging contém `infinity`/`-infinity`; paginação do cenário com múltiplos depósitos permanece interrompida pela divergência do projetor. |
| `erp_stock_mirror_product_summary` | Portada; vínculo, depósito sem vínculo e observação. |
| `erp_stock_mirror_project` | Implementada; projeção simples/repetição/atualização/remoção passaram. Corrigida a recusa de fontes com instantes não finitos; testado também replay da versão máxima segura. Pendente a identidade de observações em múltiplos depósitos. |

A dependência bloqueadora é exclusivamente `erp_documents.editable`, exportada como `notPorted("erp_documents.editable")` em `src/erp/domains/documents/stubs.generated.ts`. Foi respeitado o acesso entre domínios apenas pelo `public.ts`.

As definições foram extraídas do catálogo PGlite após aplicar todas as migrações congeladas, portanto incluem as últimas redefinições. Não houve edição de migrações ou de esquema.

## Arquivos

- `src/erp/domains/stock/rpc/compositions.ts`: seis RPCs de composição e a interna pública `erpStockProductCompose`.
- `src/erp/domains/stock/rpc/document-stock-read.ts`: quatro RPCs de leitura/depósito de documento.
- `src/erp/domains/stock/rpc/purchases.ts`: cinco RPCs de compras, com aritmética decimal em BigInt.
- `src/erp/domains/stock/rpc/mirror.ts`: três RPCs do espelho, visão local, resumo e projetor; não chama a rede nem cria recursos.
- `stock/rpc/document-stock.ts`: expõe ajudantes de acesso/recibo/auditoria; importa `updateDocument` pelo `documents/public.ts`.
- `stock/rpc/purchase-receipts.ts`, `dashboards.ts`, `reports.ts`: expõem ajudantes existentes necessários ao grupo novo.
- `stock/composition.ts`: chama as funções do Catálogo pelo `public.ts`.
- `stock/index.ts`, `stock/public.ts`: registros e exportação pública.
- `stock/stubs.generated.ts`, `domains/ownership.generated.json`: regenerados; só mudou a propriedade do Estoque (`erpStockProductCompose`).
- `tests/erp/stock/{compositions,document-stock-read,purchases,mirror}.test.mjs`: um diferencial por grupo. `final-fixture.mjs` prepara documentos. As duas RPCs bloqueadas estão explicitadas em um TODO, sem testar pelo fallback do oráculo como se estivessem portadas.
- `scripts/erp/overrides/stock.mjs`: 13 garantias adicionais de gatilhos.
- `tests/erp/schema-parity.test.mjs`: teto de gatilhos de **217 para 204**.
- `tests/erp-painel-rotas.test.ts`: a escrita sem motor usa `POST /v1/importacao-cadastros/products/apply`, diretamente em `erp_catalog_import_apply`, sem leitura prévia. A busca por `registerRpc("erp_catalog_import_apply"` em `src/erp/` não encontrou registro. A rota mantém o erro genérico esperado pelo aviso da casca.
- `web/erp/motor.ts`: sem mudança; `MOTOR_PENDING` não contém telas do Estoque a remover.

## Gatilhos declarados

Cada entrada tem `where` e `test` no override. Os testes incluem os comandos normais e provas diferenciais das guardas de autoridade, lixeira, reserva e mistura com recebimentos.

1. `erp_stock__composition.guard_stock_composition`: versão inicial 1, avanço unitário, identidade e comando novo.
2. `erp_stock__composition_item.guard_stock_composition_item`: itens somente da nova versão/comando, versões antigas preservadas.
3. `erp_stock__composition_command.guard_stock_composition_command`: recibo de estrutura do mesmo produto, ator e comando.
4. `erp_stock__document_posting.aa_mirror_authority`: recusa autoridade Origin.
5. `erp_stock__document_posting.guard_trash`: recusa documento na lixeira.
6. `erp_stock__document_posting.protect_purchase_receipt_legacy`: impede misturar lançamento integral com recebimentos por item.
7. `erp_stock__document_posting.protect_reserved_posting`: reserva ativa exige consumo.
8. `erp_stock__document_posting.post_stock_document_lots`: aplica os lotes da cópia, em ordem produto/lote.
9. `erp_stock__document_posting.immutable_document_stock_posting`: somente estorno válido, versão +1, preservando identidade e cópia.
10. `erp_stock__document_audit.aa_mirror_authority`: protege auditoria.
11. `erp_purchase_receipts__receipt.aa_mirror_authority`: protege recebimento.
12. `erp_purchase_receipts__reversal.aa_mirror_authority`: protege estorno.
13. `erp_purchase_receipts__command.aa_mirror_authority`: protege recibo de comando.

As garantias de lançamento, saldos e lotes continuam nas camadas existentes reutilizadas. Os gatilhos imutáveis que já são SQL gerado não foram redeclarados como pendentes. O projetor usa somente tabelas existentes do espelho.

## Diagnóstico da verificação externa atual

O fim de `.codex-verificacao.log` mostra **101 testes, 98 aprovados, 2 falhas e 1 TODO**, em 73,2 s. O trecho fornecido contém a divergência de compras; a segunda falha, no espelho, foi reproduzida na execução detalhada atual. Ambas coincidem com os bloqueios declarados anteriormente e não são estouros de tempo. O relato anterior ainda citava as contagens e os hashes de uma rodada mais antiga; essas evidências foram atualizadas abaixo.

O comando detalhado desta rodada executou os dois arquivos sem isolamento de processos, para obter as mensagens que o relatório por arquivo não exibe neste ambiente. Foram **12 testes: 10 aprovados e 2 falhas**, sem testes pulados ou TODO. Não houve mudança de asserções, normalização adicional, troca de RPC ou registro de hash no teste.

A tarefa determina expressamente que divergências somente por id/hash criado na chamada sejam documentadas para a sessão dona, sem alterar `tests/erp/harness/` nem contornar a comparação. Por isso, as duas falhas continuam ativas. A correção necessária é na declaração/comparação de identidades pelo harness, fora do escopo autorizado desta sessão. A ausência de `erp_documents.editable` também foi reconfirmada.

## Correções de produção já incluídas no porte

Na conferência do projetor contra `202610220001_stock_origin_mirror.sql`, foram encontrados e corrigidos dois defeitos adicionais:

1. `erp_stock_mirror.project_one` exige `isfinite(s.observed_at)` (linha 92). O motor não verificava essa condição e lia o instante i64 como número. Com `infinity`/`-infinity`, o driver falhava antes da validação; o RPC registrava erro do projetor e mantinha a pendência para nova tentativa. Agora lê `observed_at` com `CAST(... AS TEXT)`, reconhece os dois sentinelas e grava `SOURCE_IDENTITY_INVALID`, removendo a pendência sem criar observação, como o Fagoo.
2. `erp_stock_mirror.current_position` só usa `sr.last_seen_at` se ele for finito (linha 166). A leitura do motor omitia essa guarda e também tentava ler os sentinelas como número, causando `XX000`. Agora lê o carimbo do staging como texto e conserva `o.observed_at` quando necessário.

Foram acrescentados quatro testes em `tests/erp/stock/mirror.test.mjs`: identidade/instante inválido, rejeição de quebra final em depósito/quantidade, versão máxima segura com replay e fallback do carimbo do staging. Todos passaram. Os dois cenários de instantes não finitos falharam antes da correção; logs em `output/stock-final/resume-regression-before.log` e `output/stock-final/resume-stamp-before.log`. As falhas originais de múltiplos depósitos e recebimento permanecem ativas.

## Divergências preservadas

### Recebimento: hash de UUID criado na chamada

RPC: `erp_stock_purchase_receive`. Caminho da resposta: `$.current.document.chain_hash`.

Reprodução atual em `output/stock-final/recheck-detail.log`:

- Postgres: `b9677b565369390d5655fd1fbe17bbe9b586466df22a5f3aa4214bd894a715e3`.
- SQLite: `65c307068e1e7af290651b2154e16cb1bca15d309e3d8eed5fafe953991a81db`.

No log externo fornecido, os valores eram respectivamente `517d39f2a778a7674445c9f260149d32974bb7b023dc0ebcef7f81a1a9705b2e` e `5934cecd2f266f00875885bc3b750938b7a6eb0646d254a2e52e5990570433d1`.

Fonte: `tests/erp/oracle/migrations/202610160090_purchase_receipts.sql:50`, função `erp_purchase_receipts.chain_hash`:

```sql
select encode(sha256(convert_to(coalesce(jsonb_agg(
  jsonb_build_array(r.id,r.command_id,r.preview_hash,r.document_version,
                   x.id,x.command_id,x.preview_hash,x.document_version)
  order by r.id),'[]')::text,'UTF8')),'hex')
```

`r.id` é o UUID do recibo recém-inserido. A migração `202610200184_stock_document_warehouse.sql:129` publica `erp_stock_purchase_receive` como wrapper de `erp_purchase_receipts.apply_warehouse`, que devolve `current(d.id)`. O registro congelado `tests/erp/harness/volatile-hashes.mjs` declara `chain_hash` apenas para `erp_purchase_receipts_receive` e `erp_purchase_receipts_reverse`; o novo nome público não está declarado. Esta é a causa específica de o RPC antigo passar e o novo falhar usando a mesma implementação interna. A função retorna o hash pela interna `current`; a igualdade do UUID na resposta não torna automaticamente iguais os hashes derivados. Os valores mudam a cada rodada. O teste mantém a comparação original e falha nesse ponto; as asserções posteriores desse cenário não são alcançadas. O estorno/replay foi exercitado também em teste independente com recebimento preparado pela RPC existente.

### Projetor: chave de observação criada na chamada

RPC: `erp_stock_mirror_project`. Coluna: `erp_stock_mirror.position.observation_id` (`erp_stock_mirror__position` no SQLite).

Reprodução atual em `output/stock-final/recheck-detail.log`, produto de origem `201`:

| Depósito de origem | Postgres | SQLite |
| --- | --- | --- |
| `3` | `8` | `7` |
| `4` | `7` | `8` |

Fonte: `tests/erp/oracle/migrations/202610220001_stock_origin_mirror.sql:114–132`, interna `erp_stock_mirror.project_one`:

```sql
for w in select distinct warehouse_source_id from (...) x loop
  insert into erp_stock_mirror.observation (...) values (...) returning id into oid;
  insert into erp_stock_mirror.position(...,observation_id) values(...,oid)
    on conflict(product_source_id,warehouse_source_id)
    do update set observation_id=excluded.observation_id;
end loop;
```

O laço do Fagoo não tem `ORDER BY`. O motor usa uma ordem de texto determinística com `pgCompareText`. O comparador normaliza a coluna identity primária, mas não estabelece a correspondência dos IDs numéricos em `position.observation_id`: compara essas referências literalmente. A sessão dona precisa tratar a correspondência da observação com sua referência, preservando a verificação de produto, depósito, versão e conteúdo. Não foi imitada a ordem incidental do plano Postgres nem alterado o teste para ignorar a coluna. A falha interrompe as asserções posteriores de múltiplos depósitos/paginação desse cenário.

## Verificação atual

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit` passou, sem diagnósticos; `output/stock-final/recheck-tsc.log`. É o compilador local solicitado pela tarefa, sem usar `npx` ou permitir download.
- `node --no-warnings --test --test-concurrency=3 "tests/erp/stock/**/*.test.mjs"`: **23 arquivos passaram e 2 falharam**, em 113,2 s; `output/stock-final/recheck-stock.log`. Falhas em `mirror.test.mjs` e `purchases.test.mjs`. Este relatório contabiliza arquivos; o TODO das duas RPCs bloqueadas permanece em composição. A contagem detalhada da verificação externa é 98 aprovados, 2 falhas e 1 TODO.
- Diagnóstico: `node --no-warnings --test --experimental-test-isolation=none --test-concurrency=1 tests/erp/stock/purchases.test.mjs tests/erp/stock/mirror.test.mjs`: **10 passaram, 2 falharam**, em 28,9 s; `output/stock-final/recheck-detail.log`. Compras: 4 passaram e 1 falhou em `current.document.chain_hash`. Espelho: 6 passaram e 1 falhou em `position.observation_id`. As quatro regressões anteriores passaram.
- `node --no-warnings --test tests/erp/schema-parity.test.mjs`: passou; `output/stock-final/recheck-schema.log`. Teto de gatilhos mantido em **204**.
- `node scripts/erp/gen-ownership.mjs`: executado novamente com diretório temporário de saída e entradas locais, sem rede. Os artefatos de Estoque gerados são idênticos aos do workspace; outros domínios não foram regravados no workspace. Evidência: `output/stock-final/recheck-ownership.log`; script local de reprodução: `output/stock-final/recheck-ownership.mjs`. O mapa `output/closure-fns.json` já havia sido gerado na implementação inicial.
- Painel: preservado o ajuste para `POST /v1/importacao-cadastros/products/apply`. Na rodada anterior, o parser local produziu `erp_catalog_import_apply` e a ausência de registro foi confirmada em execução. Nesta rodada foram relidos o ajuste e o fluxo. Isso não substitui o teste integrado.
- `git diff --check` e `node scripts/check-conflict-markers.mjs`: passaram.
- `node scripts/check-encoding.mjs`: continua bloqueado por `spawnSync git EPERM`. Conferência direta dos 22 arquivos alterados/novos passou em UTF-8 estrito, sem BOM nem caractere de substituição.
- O verificador `/home/bruno/wabotia/tarefas/estoque-final.verifica.sh` executa tsc, Estoque, paridade e Vitest do painel. Não foi executado integralmente porque a instrução vigente proíbe Vitest. As três etapas permitidas foram executadas separadamente. O fechamento permanece reprovado na etapa de Estoque.
- Nenhum commit, acesso à rede, Vitest, Wrangler, alteração de timeout global, esquema, migração, Durable Object ou harness. Nesta rodada, não houve alteração final no código de produção ou nos testes; foi atualizado este relato consolidado.

## Pendências e limites do fechamento

1. **Documentos:** portar/exportar `erp_documents.editable` para desbloquear `erp_stock_item_components` e `erp_stock_item_components_save`. O stub permanece confirmado; ambas continuam sem registro parcial.
2. **Sessão dona do harness:** declarar o hash criado na chamada de `erp_stock_purchase_receive` e a correspondência entre observações novas e `position.observation_id`. A tarefa determina expressamente: “não contorne no teste e não mexa em `tests/erp/harness/`”. Não se alterou o comportamento de produção para copiar UUID aleatório do oráculo ou imitar a ordem incidental de um plano SQL.
3. **Verificação externa:** após resolver os bloqueios, executar o verificador, inclusive o teste de painel em sessão autorizada a usar Vitest.
4. **Cobertura:** os cenários interrompidos pelas duas divergências não alcançam todas as asserções posteriores. Estorno/replay/versão com um recebimento estão cobertos por teste independente; a atomicidade de estorno com vários recebimentos ainda não foi validada. A cobertura de todos os ramos `22023` e de todas as combinações de papel não foi demonstrada como exaustiva.

A tarefa não pode ser declarada concluída nem a suíte verde nas restrições atuais. Este documento consolida todo o porte e suas pendências, não apenas as alterações desta retomada.
