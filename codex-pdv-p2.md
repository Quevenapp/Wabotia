# PDV P2 — relato completo atualizado em 18/11/2026

O critério de pronto **não foi atingido**. O porte está implementado, mas a suíte diferencial continua falhando. Nesta nova verificação, reli a tarefa e o log externo, conferi as fórmulas de hash e reproduzi tanto o caso mínimo quanto a falha de um teste original do Fagoo. A causa isolada no caso mínimo é a comparação literal de hashes que incorporam UUIDs gerados independentemente pelos dois motores dentro da mesma chamada. Não apliquei uma alteração de produção para mascarar essa diferença e não considero a correção solicitada concluída.

A tarefa determina: “Se um teste do Fagoo falhar por uma diferença arquitetural inevitável, não altere a asserção: pare e explique no relato”. Também limita alterações a `src/erp/domains/pos/` e `tests/erp/pos/`. O tratamento necessário na infraestrutura de comparação fica em `tests/erp/harness/`, fora desse escopo. Por isso, interrompi a implementação após confirmar o bloqueio.

## Implementação existente

### `src/erp/domains/pos/rpc/sale.ts`

Registra `public.erp_pos_sale_execute` com as quatro operações:

- `sale_save`: criação e edição de pré-venda, CAS da venda e do documento, validações de itens, pagamentos, consumidor, caixa, mesa e lista de preço.
- `sale_finish`: criação opcional na mesma transação, transição do pedido para Atendido, estoque e contas conforme o papel, motivos dos efeitos pendentes e baixa automática elegível.
- `sale_cancel`: validações de estado, papel, NFC-e e devoluções; estorno de baixas, contas e estoque; cancelamento do pedido e atualização dos efeitos.
- `sale_transfer`: transferência de mesa com controle habilitado, CAS e recusa de mesa ocupada.

Funções portadas e fontes do oráculo:

| Função | Migração |
| --- | --- |
| `erp_pos.step` | `202610200204_pos_core.sql` |
| `erp_pos.cents` | `202610200204_pos_core.sql` |
| `erp_pos.amount_text` | `202610200205_pos_sales.sql` |
| `erp_pos.document_version` | `202610200205_pos_sales.sql` |
| `erp_pos.sale_write` | última definição em `202610200242_pos_price_list.sql` |
| `erp_pos.sale_effects` | última definição em `202610200267_document_scope_effects.sql` |
| `erp_pos.sale_cancel` | `202610200205_pos_sales.sql` |
| `public.erp_pos_sale_execute` | `202610200205_pos_sales.sql` |

As migrações 289 e 292 foram consultadas na implementação anterior; não substituem esses escritores de venda. Os ajudantes do P1 são reutilizados.

O comando grava recibo em `erp_pos__command`, confere ator e hash para repetição/conflito e grava auditoria em `erp_pos__audit`. A serialização usa `jsonbText`; validações distinguem chave ausente e JSON null. Dinheiro e quantidades usam `bigint`/`Dec`, sem cálculo monetário em ponto flutuante. Não há divisão numeric nova nesse fluxo; `amount_text` formata centavos na escala 2.

As integrações usam `invokeRpc`: `erp_document_save`, `erp_document_transition`, `erp_pricing_product_lists`, prévias/lançamentos/estornos de estoque e financeiro e `erp_finance_execute`. A leitura de títulos usa `finance/public.ts`; não há importação do `internal.ts` de outro domínio.

O ajudante `attempt` representa os blocos SQL de exceção com transação aninhada/savepoint. Em falha, restaura configurações locais e a fila de gatilhos adiados, preservando sequências não transacionais. Captura os SQLSTATE previstos e conserva o motivo de recusa. A validação integral desse comportamento ainda está bloqueada pelo diferencial.

### Outros arquivos

- `src/erp/domains/pos/index.ts`: importa `./rpc/sale.ts`.
- `tests/erp/pos/sale-diff.test.mjs`: oito testes diferenciais; exige explicitamente que o RPC esteja registrado.
- `codex-pdv-p2.md`: este relato consolidado, substituindo o anterior.

Nenhuma mudança no P1 (`reads.ts`, `settings.ts`), em outros domínios, no harness, no schema, em `deviations.ts`, nas migrações ou nas asserções originais do Fagoo. Nesta nova verificação não alterei produção nem testes; atualizei as evidências locais e este relato completo. O registro do RPC, seu porte e os oito testes diferenciais já estavam presentes ao iniciar esta rodada.

## Cobertura escrita

Os oito testes novos exercitam:

1. Criação/edição, CAS da venda e do pedido, repetição de recibo antigo, conflito de comando/ator e auditoria.
2. Finalização com `sale_id: null`, efeitos pendentes para vendas, baixa à vista para admin, troco, repetição, cancelamento e recusa por papel.
3. Cancelamento sem efeitos e recusa financeira de cancelamento de venda de serviço.
4. Transferência de mesa, mesa ocupada, CAS e repetição.
5. Data fora de hoje, consumidor ausente, caixa obrigatório, estoque negativo e pagamentos incompatíveis.
6. Preço base e preço da lista para vendedor sem permissão de edição, com recusa fora da lista.
7. JSON null, chaves ausentes, tipos inválidos e precisão de quantidade/preço configurada nas preferências.
8. Falha tardia de baixa por gatilho equivalente nos dois bancos, para conferir rollback, saldo, recibo e preservação da venda/contas.

Cobertura escrita não significa cobertura aprovada: quando uma chamada diferencial falha, as asserções seguintes daquele teste não são executadas.

## Causa da falha e reprodução

### Caso mínimo

Arquivo: `tests/erp/pos/sale-diff.test.mjs:59`; chamada que falha na linha 61.

Teste: `sale_finish com id nulo cria e finaliza: vendas deixa efeitos pendentes; admin recebe à vista`.

Reproduzido nesta rodada, junto ao teste original indicado abaixo, com:

```sh
node --no-warnings --test --experimental-test-isolation=none --test-name-pattern='sale_finish com id nulo|the chosen Lista' tests/erp/pos/sale-diff.test.mjs tests/erp/fagoo/pos-price-list-sql.test.mjs
```

Resultado da execução conjunta: **2 testes, 0 aprovados, 2 falhas**, saída 1, sem cancelamentos ou testes ignorados. No caso mínimo, a comparação da resposta passou. A comparação das tabelas apontou somente `erp_documents__command`, com duas linhas em cada banco. A análise estrutural do JSON da divergência confirmou que o único campo diferente foi `request_hash`.

O fluxo cria um pedido e chama `erp_document_transition` antes de encerrar a chamada externa. A fórmula do hash inclui `id: p_id`, além de operação, ator, tipo, versão, situação e motivo:

- Oráculo: `202610200239_document_permissions_approval.sql:333`.
- Motor: `src/erp/domains/documents/rpc/erp_document_transition.ts:125`.

Cada banco gera seu próprio UUID para o pedido. A bijeção do comparador alinha os UUIDs visíveis, mas não transforma um SHA-256 que já incorporou o UUID. Isso produz hashes diferentes mesmo com os demais campos alinhados. O POS apenas chama o RPC; alterar essa fórmula, remover o identificador ou substituir IDs em produção deixaria de ser um porte fiel.

### Teste original do Fagoo

Arquivo: `tests/erp/fagoo/pos-price-list-sql.test.mjs:26`.

Teste: `the chosen Lista de preço reaches the pedido de venda (body and read), none stays none`.

Reproduzido sem modificar o arquivo, no comando conjunto acima. Falhou na primeira finalização, na linha 27. A resposta novamente passou pela comparação. As quatro tabelas exibidas foram `erp_documents__audit` (4 linhas em cada banco), `erp_documents__command` (2), `erp_finance__audit` (4) e `erp_finance__command` (3). No recibo de documentos, o único campo diferente foi `request_hash`; no recibo financeiro divergiram `request_hash` e `result.record.group_id`. As auditorias também mostraram UUIDs sem correspondência. A baixa automática calcula hash com o UUID do título recém-criado. O harness limita a mensagem às primeiras quatro divergências; não é possível concluir daí que não existam outras.

O harness possui tratamento declarado para certos hashes com IDs novos em `derived-ids.mjs`, por exemplo os de lançamento financeiro de documento. Não há declaração para os hashes de transição/baixa deste fluxo POS. Além da diferença literal, hashes não alinhados interferem no casamento por estrutura dos UUIDs das tabelas relacionadas (`state-compare.mjs`), ampliando o diagnóstico com IDs sem correspondência. O caso mínimo isola o problema sem os efeitos de estoque e financeiro.

Não é uma falha exclusiva da área restrita: `.codex-verificacao.log`, fornecido após a execução externa, também apresenta essas divergências e termina com **45 testes, 15 aprovados e 30 falhas**. Como esse arquivo contém apenas o fim do log, não atribuo todas as 30 falhas à mesma causa sem os respectivos detalhes.

## Verificações e resultados

| Verificação | Resultado |
| --- | --- |
| TypeScript desta rodada: `./node_modules/.bin/tsc --noEmit` | Aprovado, saída 0, sem diagnósticos; executável local, sem rede |
| Comando completo exigido, nesta rodada | Saída 1; runner reportou 7 arquivos com `ERR_TEST_FAILURE`, sem detalhes internos; não é a contagem de casos individuais |
| Reprodução conjunta nesta rodada, sem isolamento de processos | 2 testes, 0 aprovados, 2 falhas; saída 1 |
| Caso mínimo nessa reprodução | Única diferença nas tabelas: hash do recibo de transição |
| Teste original nessa reprodução | Divergência de hashes/UUIDs nas tabelas; resposta comparada sem divergências |
| Verificação externa fornecida pelo usuário | 45 testes, 15 aprovados, 30 falhas |
| `git diff --check` | Aprovado |

Comando completo executado:

```sh
node --no-warnings --test --test-concurrency=3 "tests/erp/pos/**/*.test.mjs" tests/erp/fagoo/pos-*.test.mjs tests/erp/fagoo/documents-document-scope-effects-sql.test.mjs
```

O uso de `--experimental-test-isolation=none` nas reproduções serviu para expor os detalhes que o runner padrão não apresentou; não modifica asserções ou comparações. Esses resultados não substituem a aprovação da suíte completa.

Evidências preservadas em `tests/erp/pos/` (logs locais ignorados pelo Git):

- `.sale-current-suite.log`: comando completo desta rodada, 7 arquivos com falha reportada.
- `.sale-current-isolated.log`: reprodução conjunta desta rodada, com os dois diagnósticos detalhados.
- `.sale-recheck-suite.log`: comando completo da retomada anterior.
- `.sale-recheck-isolado.log`: caso mínimo da retomada anterior.
- `.sale-recheck-fagoo.log`: teste original isolado da retomada anterior.
- `.sale-diff.log`, `.sale-fagoo.log` e `.sale-fagoo-detail.log`: logs anteriores, preservados.

Histórico preservado do relato anterior: `npx tsc --noEmit` havia passado; o diferencial novo teve 2 aprovados e 6 falhas antes dos ajustes de preparação/expectativas dos casos de parcelas, arredondamento da lista e precisão configurável; o teste original de limite de desconto passou naquela rodada. Na retomada imediatamente anterior, os dois casos acima também falharam quando executados separadamente. Esses registros históricos não são uma aprovação atual da suíte.

## Desvios, limites e trabalho pendente

Não introduzi desvio deliberado da regra de negócio nem normalização adicional para fazer a suíte passar. O mecanismo de savepoint é a adaptação de execução necessária para reproduzir os blocos PL/pgSQL de exceção.

Para desbloquear a comparação, é necessário trabalho separado no harness para reconhecer hashes dependentes de IDs criados dentro da mesma chamada. Uma correção precisa verificar a integridade dos hashes em cada motor, sua associação ao comando e a comparação literal de hashes com IDs já compartilhados; não basta ignorar `request_hash` globalmente ou declarar indiscriminadamente todos os recibos como hashes opacos. Deve rejeitar adulterações de ator, operação, versão, motivo e identificador, além de manter a comparação de resposta, auditoria e estado. Essa correção não foi implementada, pois a tarefa explicitamente exclui essa pasta. Trocar a geração de IDs ou a fórmula do recibo em produção também contrariaria o porte fiel.

Depois disso, ainda será necessário executar a suíte completa e corrigir qualquer divergência real restante. Não estão comprovados integralmente a baixa automática, os cancelamentos com efeitos e o rollback tardio: os testes param antes de suas últimas asserções. Também falta demonstrar que todos os testes originais de POS e de escopo de documentos passam com o escritor registrado.

`erp_pos_return_execute` e os demais escritores não pedidos continuam fora deste porte; as devoluções permanecem no fluxo de oráculo/espelho quando o RPC não está portado.

Não houve commit, push, troca de branch, rede, instalação de dependências, Vitest ou enfraquecimento de testes.
