# Retirada do Hermes — passo 2

O servidor deixa de executar bots externos e de oferecer MCP HTTP. Permanecem a API v1, run.create, os bots IA diretos, as ferramentas dos módulos em processo, QR, Zernio e as atualizações automáticas.

## Arquivos e contagem de linhas

Contagem contra HEAD por `git diff --numstat`, somada às linhas dos seis arquivos novos de implementação/testes/migração. Não inclui este relatório: **1645 linhas adicionadas, 7319 removidas, redução líquida de 5674 linhas**, em 83 arquivos.

Foram excluídos integralmente 11 arquivos, totalizando **4.529 linhas**: servidor (`hermes-link.ts`: 334; `cloudflare.ts`: 601; `mcp.ts`: 1.319), painel/guia (`HermesMcpPanel.tsx`: 288; `hermes-install.tsx`: 548) e seis testes/fixtures exclusivos (1.439). As outras 2.790 linhas removidas correspondem a trechos retirados ou substituídos nos arquivos mantidos.

| Arquivo | Adicionadas | Removidas | Alteração |
| --- | ---: | ---: | --- |
| `docs/API.md` | 7 | 49 | Remove o MCP HTTP e contratos retirados; documenta o escopo interno e a execução IA. |
| `docs/ATUALIZACOES.md` | 8 | 0 | Entrada da retirada, remoção automática local e revogação manual dos recursos Cloudflare. |
| `migrations/0094_retira_cloudflare.sql` | 39 | 0 | Copia metadados sem segredos, apaga credenciais, pausa/marca conexões e esvazia jobs. |
| `src/ai-provider.ts` | 2 | 2 | Atualiza o comentário do provedor direto. |
| `src/bot-actions/actions.ts` | 2 | 47 | Remove o cabeçalho/assinatura de execução externa; usa a API interna. |
| `src/bot-actions/customer.ts` | 4 | 4 | Preserva o ator preso à conversa e passa a importar a API interna. |
| `src/cloudflare.ts` | 0 | 601 | Arquivo removido: preparação e jobs Cloudflare do Hermes. |
| `src/connection-removal.ts` | 69 | 5 | Caminho interno idempotente para o cron, com isolamento de falhas; mantém a autorização da API. |
| `src/coordinator.ts` | 3 | 10 | Vínculo antigo responde 410; remove jobs Cloudflare e sua contagem. O alarme de atendimento não consulta remoções pendentes. |
| `src/engine.ts` | 26 | 263 | Remove execução, sondagem, transcrição e artefatos externos; preserva processRun IA. |
| `src/erp/emissor/README.md` | 1 | 1 | Remove referência textual ao Hermes na descrição da integração. |
| `src/erp/hub.ts` | 2 | 2 | Corrige comentário que apontava para o arquivo de vínculo removido. |
| `src/hermes-link.ts` | 0 | 334 | Arquivo removido: vínculo do plugin. |
| `src/index.ts` | 16 | 99 | Remove rotas retiradas e campos do sistema/aplicações; monta a API interna, mantém QR e liga a limpeza ao scheduled. |
| `src/integrations.ts` | 4 | 321 | Remove requisições, artefatos e descoberta externos; mantém IA/Zernio/QR, mídia e templates. |
| `src/internal-api.ts` | 69 | 0 | Extrai a chamada em processo e o nonce privado para os bots internos. |
| `src/line-service.ts` | 4 | 4 | Retira o canal legado e seleciona somente bots IA. |
| `src/maintenance.ts` | 0 | 11 | Remove ações cloudflare.*; preserva atualizações. |
| `src/mcp.ts` | 0 | 1319 | Arquivo removido: transporte e catálogo do MCP HTTP. |
| `src/modules/api.ts` | 2 | 2 | Atualiza comentários; mantém onMcpTool. |
| `src/modules/forms/forms.ts` | 1 | 1 | Corrige comentário do envio por bot interno. |
| `src/modules/mensalidade/mensalidade.ts` | 1 | 2 | Atualiza comentário das ferramentas internas. |
| `src/modules/queue-tools.ts` | 1 | 1 | Atualiza comentário das ferramentas internas. |
| `src/modules/suporte/store.ts` | 31 | 32 | Elimina releituras com RETURNING e abre a sessão em lote atômico; preserva o prazo e restringe a atualização à área. |
| `src/number-router.ts` | 1 | 1 | Não reaproveita escopos internos antigos ao gravar permissões da aplicação. |
| `src/openapi.ts` | 5 | 5 | Atualiza enum de conexão e descrições. |
| `src/queue.ts` | 3 | 3 | Retira o canal legado dos filtros. |
| `src/router-openapi.ts` | 1 | 1 | Descreve bots internos na política de número. |
| `src/security.ts` | 2 | 1 | Ignora bound/all na autenticação por chave. |
| `src/service-templates.ts` | 3 | 3 | Retira o canal legado dos filtros e referências aos bots externos. |
| `src/service.ts` | 72 | 118 | Recusa conexões retiradas, religamento pendente e escopos internos; especialistas IA; remove reconcile e preserva nomes dos bots em lote atômico. |
| `src/team.ts` | 4 | 48 | Remove sondagem remota e uso de presença externa. |
| `src/transport.ts` | 1 | 1 | Retira o canal legado do transporte. |
| `src/visibility.ts` | 3 | 26 | Preserva BOUND_SCOPE/isBound/boundAllows; remove wholeAreaPending e atualiza comentário. |
| `src/web-steps.ts` | 1 | 1 | Retira o canal legado; preserva o comentário de conversations:bound. |
| `tests/api.test.ts` | 17 | 22 | Troca fixture por IA e adapta timeout e supressão após tomada humana. |
| `tests/application-internal-scopes.test.ts` | 218 | 0 | Novos testes de escopos, autenticação antiga, falsificação de cabeçalhos e run.create IA com mock. |
| `tests/artifacts.test.ts` | 0 | 122 | Teste exclusivo do código retirado, removido. |
| `tests/bot-actions.test.ts` | 1 | 45 | Remove apenas casos do cabeçalho assinado/MCP retirado. |
| `tests/bot-attendant-ator.test.ts` | 1 | 1 | Mantém cobertura do ator interno com o novo import. |
| `tests/bot-tools-agenda.test.ts` | 5 | 3 | Exercita ganchos em processo e mantém cobertura de permissões/módulo desligado. |
| `tests/bot-tools-verticais.test.ts` | 3 | 3 | Troca o transporte removido pelo fixture de ferramentas em processo. |
| `tests/connection-removal.test.ts` | 4 | 4 | Adapta a fixture de bot para IA; mantém casos de remoção legada. |
| `tests/entrega.test.ts` | 2 | 2 | Espera 404 para a rota MCP removida; demais restrições ficam. |
| `tests/erp-bot-via.test.ts` | 1 | 1 | Mantém cobertura do ator/via com o novo import. |
| `tests/hermes-link.test.ts` | 0 | 493 | Teste exclusivo do vínculo retirado, removido. |
| `tests/jev.test.ts` | 19 | 24 | Mock de IA com todos os campos estruturados obrigatórios, preservando ordem e interpretação antes do JEV. |
| `tests/m6-conferencia.test.ts` | 4 | 4 | Usa ferramentas dos módulos em processo. |
| `tests/maintenance.test.ts` | 3 | 271 | Retira casos da preparação Cloudflare; preserva os de atualizações. |
| `tests/mensalidade-mp.ts` | 35 | 14 | Sincroniza alarmes antes/depois do webhook e antes de retirar o mock, mantendo o HTTP e os ganchos reais. |
| `tests/mcp-bound-key.test.ts` | 0 | 240 | Teste do perfil de chave MCP retirado; nova cobertura de recusa/filtragem em application-internal-scopes. |
| `tests/mcp-fixture.ts` | 0 | 37 | Fixture do MCP HTTP removido; substituído por module-tools-fixture. |
| `tests/mcp-path-safety.test.ts` | 0 | 180 | Removido: testava exclusivamente checkedCall de src/mcp.ts. |
| `tests/mcp.test.ts` | 0 | 367 | Testes do MCP HTTP removido. |
| `tests/menu-hierarchy.test.ts` | 10 | 2 | O bot desligado pertence a uma conexão IA; mantém todas as asserções de árvore e visibilidade. |
| `tests/module-contract.test.ts` | 15 | 30 | Mantém disponibilidade, esquema e recusa por módulo desligado em processo. |
| `tests/module-tools-fixture.ts` | 75 | 0 | Helper para autenticar e exercitar declarações dos módulos pela API em processo. |
| `tests/pedido-api.test.ts` | 12 | 31 | Mantém consultas e proteção de cliente/conversa sem MCP HTTP. |
| `tests/retira-cloudflare.test.ts` | 543 | 0 | Novos testes da migração, pausa, remoção/repetição/falha parcial, recusas e rotas retiradas; inclui scheduled real em duas áreas. |
| `tests/service-center-fixture.ts` | 7 | 5 | Bot padrão de testes passa a usar conexão IA. |
| `tests/service-team.test.ts` | 17 | 41 | Fixture IA e presença local sem sondagem/rede. |
| `tests/suporte-compra.test.ts` | 10 | 1 | Mantém todos os cenários e asserções; acrescenta ausência de alarme pendente após confirmação, estorno e reenvio. |
| `tests/suporte-sessions.test.ts` | 106 | 0 | Três casos novos: ida única e retorno persistido, rollback da abertura e isolamento entre áreas. |
| `tests/web-steps.test.ts` | 10 | 41 | Exercita envio/listagem pela API v1 com gatilho bot. |
| `web/admin/ApplicationsPage.tsx` | 0 | 80 | Remove WholeAreaKeys, escolha bound/all e painel MCP. |
| `web/admin/BotsPage.tsx` | 15 | 17 | Filtra bots IA e atualiza especialistas/instruções. |
| `web/admin/ConnectionDialog.tsx` | 11 | 142 | Somente tipos atuais; padrão ai; remove campos externos. |
| `web/admin/ConnectionsPage.tsx` | 72 | 226 | Remove plugin/pareamento/Docker; mantém retirada e mostra recursos/pendência de remoção. |
| `web/admin/HermesMcpPanel.tsx` | 0 | 288 | Painel removido. |
| `web/admin/OverviewPage.tsx` | 3 | 6 | Atualiza orientações para bots internos. |
| `web/admin/RecordsPages.tsx` | 2 | 26 | Remove o diálogo de vincular execução remota; mantém reconciliação de entregas. |
| `web/admin/TemplatesPage.tsx` | 1 | 1 | Botão de configuração passa a apontar para provedor de IA. |
| `web/ConnectionDiagnostics.tsx` | 7 | 36 | Remove descoberta e diagnóstico específicos do Hermes. |
| `web/EmailSection.tsx` | 1 | 3 | Não recebe mais account_id da preparação retirada. |
| `web/hermes-install.tsx` | 0 | 548 | Guia interativo removido após retirada do último import. |
| `web/lib/demo.ts` | 3 | 3 | Demonstração usa conexão IA. |
| `web/NumberPolicyEditor.tsx` | 1 | 1 | Descreve o atendimento por bots internos. |
| `web/ServicePanels.tsx` | 3 | 6 | Seleção de bot de menu restrita à IA e texto correspondente. |
| `web/SetupWizard.tsx` | 10 | 45 | Remove botão e orientações de conexão Hermes. |
| `web/site/Install.tsx` | 4 | 5 | Exceção solicitada: substitui o passo importado por texto curto de Conexões. |
| `web/SystemPanel.tsx` | 1 | 579 | Remove preparação/deploy Hermes; mantém atualizações e EmailSection. |
| `web/team/TeamArea.tsx` | 3 | 3 | Atualiza textos e apresentação dos bots internos. |
| `web/workspace-navigation.ts` | 2 | 2 | Atualiza rótulo e descrição de Conexões. |

## Migração e remoção

A 0094 usa apenas operações de dados: preserva todas as tabelas e a classe Coordinator. Primeiro guarda hostnames, criação, nomes e IDs numa lista fechada em `profiles.settings.retired_cloudflare`; depois apaga credenciais de conexão, pausa/marca as conexões, apaga os segredos da preparação e esvazia os jobs. Não copia objetos resources/spec inteiros, tokens, client_secret ou credenciais.

O `scheduled` de `src/index.ts` executa `removePendingConnections` por `waitUntil`, com uma busca global de conexões pausadas e marcadas. A função mantém o filtro opcional por área para chamadas internas. O cron continua acordando os Coordinators, mas os alarmes de atendimento não pagam uma consulta extra pela retirada. Cada conexão é tratada separadamente. O caminho interno desliga referências e execuções e reutiliza a exclusão de conexão de bots, preservando histórico e podendo retomar após falha. A API continua exigindo pessoa administradora e não pode definir a marca interna. Conexões marcadas recusam religamento com 409.

O aviso do painel usa o campo settings da resposta existente de status; continua aparecendo depois da exclusão da conexão. Lista os recursos e orienta revogar aplicação Access, service token, túnel e registros DNS na conta Cloudflare. O token independente das atualizações permanece.

## Onde o nome “mcp” sobrevive

- `src/modules/api.ts`, `src/modules/hooks.ts` e `src/bot-actions/customer.ts`: contratos `onMcpTool`, `ModuleMcpTool`, registro/listagem e consumidor interno. São chamadas em processo dos bots IA; os nomes foram preservados.
- `src/modules/agenda/agenda.ts`, `mensalidade/mensalidade.ts`, `os/os.ts`, `pedido/pedido.ts`, `reserva/reserva.ts`, `suporte/suporte.ts` e `src/modules/queue-tools.ts`: declarações desses ganchos e comentários sobre eles.
- `src/erp/blocks.ts`, `src/erp/api/local-fetch.ts`, `src/erp/schema/structural.ts` e `src/erp/domains/catalog/rpc/erp_catalog_product_list.ts`: bloqueio/documentação histórica do MCP separado do Fagoo; não são o endpoint retirado.
- `src/erp/fagoo/workers/erp-api/src/mcp.mjs`, `src/erp/fagoo/workers/erp-api/src/index.mjs` e `src/erp/fagoo/MANIFEST.json`: código copiado e MCP próprio do Fagoo, explicitamente fora do escopo e intocados.
- Testes dos módulos, fixture `module-tools-fixture.ts` e testes de retirada/entrega: referências aos ganchos internos ou verificação de 404 em `/api/mcp`.
- Documentação histórica fora dos dois arquivos autorizados, plugin, conectores, scripts e textos do site permanecem para o próximo passo. Seus nomes MCP/Hermes não significam que o servidor HTTP ainda exista.

A busca `rg -ni hermes src --glob '!src/erp/fagoo/**'` encontra somente mensagens “Hermes retirado”, filtros SQL de tipos legados e o comentário histórico do Coordinator.

## Verificação externa atual e correções acumuladas

O `.codex-verificacao.log` atual é o fim da execução iniciada às 09:19:13, com duração de **1259,97 segundos**. Registra **188 arquivos aprovados e 1 reprovado; 1424 testes aprovados e 2 reprovados (1426 no total)**. As duas falhas são timeouts de 5000 ms em `tests/suporte-compra.test.ts`: **M8, troca da forma/estorno**, e **N-6 (a), documento cadastrado antes do pagamento**. Não são a exceção permitida de `erp-do-schema` e não foram ignoradas. O trecho não contém o início de `npm run check`, portanto não comprova seu resultado. Os avisos de restrição de chave estrangeira aparecem antes de `erp-do-dialect`, que terminou aprovado; o resumo não os atribui aos dois timeouts.

### Correções das rodadas anteriores, mantidas

A rodada anterior havia registrado 4 arquivos/testes reprovados e 1421 testes aprovados. O resumo atual só reprova Suporte; as quatro falhas anteriores não reaparecem nele:

1. **Renomeação (`atendimento-ajustes`)**: a remoção da descoberta externa havia apagado também a persistência de `config.bot_names`, que o contrato de renomeação ainda exige. `bot.update` volta a guardar o nome na conexão. A gravação do bot e da configuração ocorre no mesmo lote, depois das validações, preservando os demais nomes e campos. O teste original ficou intacto.
2. **Orçamento D1 (`d1-budget`)**: a chamada a `removePendingConnections` na abertura de cada alarme acrescentava um SELECT mesmo sem conexão pendente: **72 instruções para um teto de 71**. A limpeza passou ao `scheduled` existente, com uma única busca global por disparo. O alarme perde exatamente essa instrução; o teste e seu teto de 71 ficaram intactos. O resumo externo atual já não aponta falha nesse arquivo; não informa a contagem exata de instruções.
3. **Interpretação antes do JEV (`jev`)**: o mock migrado do Hermes omitira `capability_id`, `menu_id`, `protocol_number`, `category_id` e `clarification`. O provedor Anthropic interno valida esses campos, obrigatórios e anuláveis; a resposta era recusada antes de chegar ao JEV. A fixture agora os fornece como `null`. Mantive as asserções de ordem IA → JEV, interpretação enviada, texto final e conclusão; o esquema do provedor não foi relaxado.
4. **Árvore de menus (`menu-hierarchy`)**: a fixture inseria um bot desligado vinculado à conexão Zernio da linha. A regra atual exige bot IA, então o cadastro do menu falhava antes de testar a visibilidade. A fixture ganha uma conexão IA ativa própria e mantém o bot desligado. Todas as asserções de árvore no editor, ramo oculto e filtros de linha permanecem.

O teste de `scheduled` em `tests/retira-cloudflare.test.ts` chama o cron real, remove conexões marcadas de duas áreas, preserva as linhas atuais, confere o despertar dos Coordinators e repete o cron. Só o despertar dos objetos é simulado. O log atual registra **10 testes aprovados nesse arquivo**.

### Timeouts de Suporte: evidência e correção desta rodada

O log informa apenas o estouro do prazo, sem o ponto de execução onde ele ocorreu. Não há evidência nele de falha funcional nas asserções. O diagnóstico offline reproduziu integralmente as operações dos dois cenários, com funções reais de produção, migrations reais, SQLite em memória e Mercado Pago simulado. Encontrou dois fatores concretos:

- **Idas desnecessárias ao banco:** `openSession` fechava, inseria e relia a sessão em três chamadas; `updateSession` gravava e relia em duas; a atualização da compra também era relida. Antes da correção, o fluxo M8 medido fazia **624 idas / 681 instruções** e N-6 fazia **352 idas / 383 instruções**. Uma simulação de 8 ms por ida fez M8 durar aproximadamente **5,23 s**, sem qualquer alarme, reproduzindo a sensibilidade ao prazo de 5 s.
- **Alarme automático concorrendo com o condutor manual dos testes:** o webhook real agenda o Coordinator para 1 s depois. `drain` já sincroniza o alarme antes de processar a caixa de entrada, mas o helper do Mercado Pago deixava o agendamento entre webhooks e depois da última confirmação. Uma pausa controlada de 1,2 s após o webhook acionou o alarme e acrescentou **35 idas / 36 instruções** no diagnóstico. Essa concorrência depende do tempo da execução, não do conteúdo das asserções.

Correções:

1. `src/modules/suporte/store.ts` usa `RETURNING *` para devolver a sessão/compra gravada. Fechar a sessão anterior e abrir a próxima agora é um único lote atômico. Se o INSERT falhar, a anterior continua ativa. A atualização conserva a extensão de validade e inclui o perfil no filtro.
2. `tests/mensalidade-mp.ts` guarda o perfil das contas criadas pela fixture e reutiliza `quietCoordinator` antes/depois dos webhooks e na limpeza, antes de retirar o mock. A chamada HTTP assinada, a consulta ao provedor simulado, a confirmação, o estorno e os ganchos continuam sendo exercitados; as rotinas periódicas continuam sendo chamadas explicitamente pelos testes que as verificam. Nenhum alarme de produção foi alterado.
3. As asserções originais e o timeout de 5000 ms de `suporte-compra` permanecem. Foram acrescentadas verificações de alarme pendente nulo. `suporte-sessions.test.ts` acrescenta três casos para orçamento de chamadas, valores persistidos/prazo, rollback e isolamento entre áreas.

Depois da alteração, os mesmos diagnósticos mediram **593 idas / 653 instruções em M8** e **341 idas / 373 instruções em N-6**. A redução conjunta foi de **42 idas e 38 instruções**. Com a sincronização, a pausa de 1,2 s não gerou alarme nem consultas. Compra única, cancelamento da cobrança substituída, estorno, encerramento da liberação, troca de pacote, vínculo do pagador e aviso único à equipe foram preservados.

**Limite da conclusão:** esses resultados demonstram a remoção de trabalho redundante e da concorrência involuntária da fixture. Não identificam retrospectivamente a instrução exata em que cada teste externo estourou, nem garantem um tempo de parede sob qualquer carga. O ensaio com 8 ms ficou perto de 5 s mesmo após a redução; não serve como garantia de folga. A confirmação dos dois timeouts exige nova execução no Worker/D1, fora desta área, respeitando a proibição de Vitest nesta sessão.

## Verificações e limites

Executado nesta rodada:

- `./node_modules/.bin/tsc --noEmit`: passou na versão final, sem diagnósticos. Usa o compilador já instalado, equivalente a `npx tsc --noEmit`, sem resolução de pacote pela rede.
- `npm run check`: **não concluiu**. A guarda de codificação parou em `spawnSync git EPERM`, limitação do sandbox. O comando não executa Vitest nem precisa de rede. O arquivo gerado de build permanece ignorado pelo Git.
- `node scripts/check-conflict-markers.mjs`, `node scripts/erp-scope-css.mjs --check` e `git diff --check`: passaram.
- A mesma guarda de codificação, em cópia temporária que recebe a lista obtida previamente pelo Git, passou para **3739 arquivos de texto**, incluindo novos arquivos. As validações não foram alteradas e os scripts do projeto ficaram intactos.
- Sintaxe e resolução de imports relativos de **687 arquivos TypeScript de src/tests**: passaram. Isso inclui testes que o tsconfig principal não verifica; não é uma execução deles nem uma checagem completa dos seus tipos.
- Diagnósticos offline dos dois fluxos completos de compra, do alarme agendado após webhook e das sessões: passaram. Para sessões, conferiram o retorno igual ao persistido, uma ida por abertura/atualização, validade preservada, nenhuma alteração por área errada e rollback com colisão de chave no INSERT.
- Conferência de escopo: nenhuma diferença nas migrations 0001–0092, Wrangler, Fagoo, mobile, web/erp, conectores, plugin público, scripts ou Landing. A migration nova é a 0094, sem uso de 0093. `hermes-install.tsx` não tem import remanescente; `cloudflare-prerequisites.tsx` ainda é usado pelo Install. A busca de Hermes em src continua limitada às exceções previstas.

Os diagnósticos ficaram em `/tmp/retira-hermes-2-diagnostico/`. O carregador transpila TypeScript e adapta o construtor de Durable Object ao Node; a camada D1 usa SQLite e o agendamento é simulado. Bloqueia imports de Vitest/`cloudflare:test` e qualquer fetch externo sem mock explícito. **Não substitui o runtime Cloudflare**, especialmente os bloqueios de concorrência de Durable Objects e a medição real de tempo. As contagens são dos diagnósticos, não medições oficiais do teste `d1-budget`.

O relato anterior também registra diagnósticos offline de renomeação, IA → JEV, árvore de menus, migração 0094, religamento 409, cron multiárea e preservação do token de atualização. Eles não foram reexecutados nesta rodada; o resumo externo atual só mantém as duas reprovações de Suporte.

Não executei Vitest, Wrangler nem `verifica.sh`. O último resultado da suíte completa continua sendo o log externo acima, anterior às correções desta rodada. Os três novos casos e as asserções adicionais aguardam essa execução. Não declaro a suíte aprovada. Não houve commit, push, mudança de branch, acesso à rede, implantação nem revogação remota de recursos.

## Decisões e dúvidas

1. A tarefa cita sucesso `succeeded`, mas o contrato atual, banco, motor e clientes usam `completed`. Mantive `completed` e o teste exige resposta do mock, conclusão tratada e resultado consultável na API. Mudar o estado público exigiria uma alteração de contrato fora da retirada solicitada.
2. A chamada interna estava no arquivo MCP removido. Extraí somente esse mecanismo para `src/internal-api.ts`, mantendo o nonce privado de uso único e a construção de atores pelo servidor; requisições externas não conseguem fabricar o ator.
3. O preparador antigo guardava IDs em resources e derivava os nomes de spec.tunnel_name/hostnames. A migração reconstrói esses nomes pelos mesmos padrões, com uma lista explícita de campos.
4. Capacidades antigas desligadas pela 0092 podem permanecer guardadas para selecionar um substituto. Toda referência nova, troca de bot ou reativação precisa de bot IA.
5. A marca `remove_pending` não pode ser criada pelo cadastro da API, para o caminho de sistema não contornar as regras normais de exclusão.
6. `web/cloudflare-prerequisites.tsx` permanece: `web/site/Install.tsx` ainda o importa. O passo Hermes importado foi substituído somente pelo texto solicitado; guias e demais textos do site ficam para depois.
7. A limpeza foi ligada diretamente ao `scheduled`, opção permitida pela tarefa, para preservar o orçamento de consultas dos alarmes. A gravação de `bot_names` foi mantida como dado local e tornada atômica com a renomeação, sem restaurar a descoberta externa.
8. Atualizei também os rótulos ainda ligados ao fluxo removido em TemplatesPage, ServicePanels, NumberPolicyEditor e navegação. As duas referências em src/erp fora do Fagoo eram apenas texto/comentário e foram ajustadas para cumprir a busca final.
9. Para tratar os timeouts sem aumentar prazos nem retirar asserções, a correção alcançou a persistência de sessões/compras do Suporte e a sincronização da fixture de pagamentos. Mantive o escopo em eliminar releituras e concorrência acidental; não alterei regras financeiras nem o agendamento de produção.

Ficaram fora: arquivos/áreas protegidos na tarefa, migrations 0001–0092, número 0093 reservado, configuração Wrangler/DO, mobile, web/erp, src/erp/fagoo e a limpeza remota da conta Cloudflare. As correções anteriores permanecem; esta rodada eliminou releituras e alarmes concorrentes identificados nos fluxos de Suporte. A confirmação de que a suíte completa passou depende de um novo log do script externo.

