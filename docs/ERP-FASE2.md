# ERP — contrato integrado da fase 2

A área possui nove chaves. `erp` significa **Cadastro de clientes**; o botão
de navegação permanece **ERP**. Todas começam desligadas. A migração aditiva
`0133_erp_parts.sql` replica o estado existente de `erp` nas cinco novas
partes, sem sobrescrever escolhas, reiniciar revisões ou alterar o SQLite do
ERP. As tabelas continuam existindo mesmo quando uma parte está desligada.

## Módulos e dependências

| Chave | Nome | Dependências diretas |
|---|---|---|
| `erp` | Cadastro de clientes | — |
| `erp-produtos` | Produtos e serviços | Cadastro de clientes |
| `erp-vendas` | Vendas | Produtos e serviços |
| `erp-compras` | Compras | Produtos e serviços |
| `erp-estoque` | Estoque | Produtos e serviços |
| `erp-financeiro` | Financeiro | Cadastro de clientes |
| `erp-fiscal` | Fiscal | Cadastro de clientes |
| `erp-cobranca` | Cobrança bancária | Financeiro |
| `erp-pdv` | Caixa / PDV | Vendas, Financeiro, Estoque |

Somente Base declara os seis papéis anteriores. Chave não concede papel,
permissão nem MFA. Ligar dependentes expõe seus requisitos; desligar uma
parte com dependentes exige a confirmação de cascata. A gravação do conjunto
é um único batch, com eventos posteriores.

## Regras de operação

Desligar suspende operação nova com `409 module_disabled`. Uma venda ou
compra pode continuar sem Estoque e/ou Financeiro: postagem e `autoFinance`
são pulados antes de exigir referências dessas integrações. Efeitos já
gravados conservam flags e guardas. Estornos configurados continuam possíveis;
sem efeito ativo, retornam `skipped`, com `reason: part_disabled` quando cabível.

Comissão nova exige Financeiro e origem comercial. Confirmação, edição,
troca de vendedor e produtores indiretos não recalculam comissão suspensa.
Cancelamento explícito pode compensar a operação anterior. Captura de custo
e margem exigem Vendas + Compras + Estoque. Custo histórico não é apagado;
fonte suspensa não deve produzir margem corrente.

Religar não recompõe o passado. Leitura e replay não completam efeitos
pulados; `parts` não entra no hash do comando. Uma nova ação explícita usa
estado e preferências atuais, podendo executar automação antes suspensa.
O painel avisa antes da confirmação. Não há corte contábil novo.

Campos de partes suspensas são preservados se omitidos ou reenviados
idênticos. Alteração e limpeza por `null` são recusadas pelo servidor.
Cópia não transporta vínculos operacionais indisponíveis. Parcelas,
vencimentos e condições comerciais permanecem utilizáveis; contas,
categorias, tarifas e comissão obedecem ao Financeiro. O limite operacional
de crédito fica suspenso; proteções históricas de unidade e tipo continuam.

As operações compostas usam requisitos compartilhados: recebimento físico
exige Compras + Estoque; reserva exige Vendas + Estoque; composição, lotes e
inventário exigem Produtos + Estoque; XML comercial exige Fiscal, Produtos
e dono; lançamento de nota exige Fiscal + destino e, se vinculada a pedido,
Compras. Agrupamento novo exige Financeiro e a origem de cada item. Títulos
antigos continuam liquidáveis no Financeiro com Vendas desligado.

## Manutenção de efeitos históricos

`GET /v1/sistema/manutencao-efeitos?type=…&id=…` consulta vínculos,
bloqueadores, ações reversas e a versão da origem quando existente. Postagens
financeiras de notas incluem IDs e versões atuais dos títulos; remessas
incluem a sequência como texto. São somente leituras de tabelas existentes.

`POST` aceita uma ação enumerada e os argumentos da operação original:
alvo, versões, prévia, motivo e comando. Não aceita RPC livre, SQL, partes,
papel ou bypass. O escopo temporário permite apenas a cadeia de compensação
vinculada à origem. Administrador pode acessar origem desligada pela Base;
demais acessos continuam sujeitos aos papéis e permissões originais.

Liquidação, cobrança protegida, reserva, recebimento, agrupamento, saldo
insuficiente e versão divergente continuam sendo bloqueadores reais. A tela
recusa executar se faltar versão ou prévia necessária. Desligar uma chave
não apaga vínculos nem elimina essas proteções.

## Transporte e entrega de estado

`parts.ts` define nove booleanos; somente `false` desliga na compatibilidade
do motor direto. Toda entrada de produção exige mapa completo e
`partsControl: {profile, revision, expires_at}`. Corpo comercial e cabeçalho
externo não autorizam partes. Fotografia ausente/inválida responde
`503 erp_parts_unavailable`; revisão superada responde `409 erp_parts_stale`.

O lote de autenticação inclui pessoas, aplicações e a fotografia das partes.
A consulta de pessoas contém uma linha de controle independente de haver
pessoas: `identityPartsState` a consome e `personOf` não a projeta como membro.
O instante da leitura vem do SELECT. O envelope conserva também a privacidade
cadastral e a identidade técnica restrita do cadastro único, que precisa só
de Base. O objeto não consulta D1. O RPC aplica a fotografia ao KV na mesma
ida, antes de efeitos e de armazenamento; a leitura autenticada de metadados
continua em um batch D1 e um RPC.

Comandos, modelos e cron entregam `/erp-parts` e confirmam apenas a revisão
recebida. `erp_sync` expõe revisão corrente, entregue e `pending|applied`.
Uma entrega RPC sem ACK D1 pode continuar indicada como pendente até a
reconciliação seguinte. `applied` não garante execução de tarefa. A validade
máxima é seis minutos; cron renova a cada cinco minutos. Perda, duplicação,
revisões fora de ordem e revalidações entre unidades estão descritas em
[ERP-AGENDADOR.md](ERP-AGENDADOR.md).

## Consultas e painel

Ausência não vira zero: DTOs usam `null`, omitem capacidades e acrescentam
`unavailable_parts` apenas no modo dividido. Flags de existência histórica
permanecem verdadeiras. Parsers mantêm validações de seções disponíveis.
Relatórios, etiquetas, listas, transições e tarefas resolvem também suas
definições persistidas; o corpo não pode trocar a fonte real.

Menu, URL, favoritos, abas, ações e prefetch usam requisitos completos.
Somente Base abre diretamente Clientes. Extensões nativas isoladas não
montam o ERP portado; sem gestão disponível há estado vazio e acesso a
Módulos. Favoritos indisponíveis permanecem salvos. A demonstração usa as
mesmas definições dos nove módulos, com as cinco novas partes e PDV ligados,
Fiscal e Cobrança desligados. Os grupos nativos precedem os grupos portados.

As famílias `a1`, `fiscal-authorization` (incluindo `reviewed`),
`fiscal-danfe`, `fiscal-reconciliation`, `fiscal-signed`, `fiscal-unsigned` e
`fiscal-wsdl` pertencem ao Fiscal. A classificação não instala seus serviços
externos: Fiscal ligado não promete disponibilidade de emissão. Endereços
desconhecidos continuam 404; os aliases antigos de contexto de PDV e check-in
resolvem para os destinos atuais com seus requisitos completos.

## Modelos e limites da entrega

Modelos aceitam IDs embutidos com hífen, exigem o fechamento transitivo e
mostram todas as ativações na prévia. Seleção incompleta acusa conflito;
não ativa dependências escondidas nem sobrescreve alterações locais.
Cobrança e PDV continuam opções explícitas. Processos e projetos permanecem
tipos de trabalho; Mesas exige Pedido e Jurídico exige OS.

Não há integração operacional automática `os`/`pedido` → financeiro,
estoque ou fiscal por aplicar um modelo. A OS comercial antiga continua em
Vendas; seus dados não são migrados ao módulo nativo `os`. Não foram criadas
recorrências financeiras, recomposição comercial, nova classe de Durable
Object ou novo recurso Cloudflare. Não há transação distribuída D1/SQLite;
a unidade síncrona iniciada conclui com a fotografia que recebeu.

## Pontos de manutenção e aceitação

- `parts.ts`, `parts-requirements.ts`: tipos, dependências e requisitos por
  entidade, campo, preferência, relatório, notificação e destino.
- `blocks.ts`: famílias, métodos, alternativas, aliases e rotas conhecidas.
  `tests/erp/fixtures/route-blocks.json` preserva as 764 entradas originais,
  expandidas em 983 combinações; as entradas locais adicionais têm testes próprios.
- `engine/parts-gate.ts`: classificação explícita de todo RPC registrado,
  referências persistidas e escopo finito de manutenção.
- `modules/erp/parts-state.ts`, `identity.ts`, `parts-control.ts`: leitura,
  transporte, monotonicidade, TTL e confirmação de revisão.
- `schema/deviations.ts`: `ERP_PART_BEHAVIORS` é catálogo informativo; não
  integra `ERP_DEVIATIONS`, o gerador nem substituições no Postgres.
- `dual-fixture.mjs`: partes explicitamente ligadas no diferencial.
  `f2-paridade.test.mjs` compara também a ausência com o mapa completo,
  incluindo respostas, erros e todas as tabelas SQLite.
- `f2-aceite.test.mjs`: matriz de postagem, parsers, cadastro técnico,
  privacidade, replay, manutenção HTTP e versões dos vínculos históricos.
- `tests/f2-aceite.test.ts`: demonstração real, lote D1/envelope/KV, aplicação,
  sistema e recusa pública de referência persistida suspensa.

As demais suítes `f2-*` cobrem rollback, comissão, custo, preservação,
alarmes, migração, entrega perdida/duplicada/fora de ordem, modelos e
navegação. O aceite final exige `check`, `build`, `test:erp`, `test:erp:painel`
e Vitest inteiros verdes. Nesta máquina Vitest, Wrangler e verificações que
dependem de rede ficam a cargo do script do orquestrador; testes escritos
não equivalem a testes executados.

## Relato consolidado do aceite — 19/11/2026

Este relato inclui as alterações que já estavam na árvore quando esta rodada
começou e as correções posteriores ao log `.codex-verificacao.log`. **O aceite
integral ainda não está comprovado.** O último resultado externo disponível
é de **278 arquivos aprovados, 14 reprovados, 2.961 casos aprovados e 28
reprovados**. Esse resultado antecede a correção do transporte desta rodada;
não é uma contagem de falhas da árvore atual. Vitest não foi executado nesta rodada.

Não houve commit, acesso à rede, migração nova, modificação de DDL/semente,
alteração do oráculo ou aumento do orçamento do pacote inicial. Nenhum caso
antigo foi excluído, pulado ou teve suas asserções afrouxadas. As mudanças de
preparação dos testes antigos estão enumeradas abaixo.

### Causas encontradas e correções

1. **Segunda ida ao D1.** `erpIdentity` já transportava a fotografia consistente
   lida junto com a autenticação, mas `erpApi` a substituía por uma nova leitura.
   A API agora reutiliza o envelope completo e válido para aquela área. A
   obtenção no D1 permanece para chamadas internas sem fotografia válida.
   As revalidações de privacidade cadastral foram preservadas; a otimização de
   uma ida ao D1 continua restrita às leituras de metadados previstas.
2. **Identidade técnica do cadastro sem marca de portão.** Uma chamada direta
   de `localFetch` com a identidade técnica, sem o coletor opcional `gate`,
   deixava de enviar `GATE_HEADER` e era recusada por `erp_customer_bridge_scope`.
   O transporte agora exige o portão também para esse ator. A lista finita de
   RPCs, os campos administrativos, a ausência de MFA/elevação e a privacidade
   continuam conferidos no objeto. `identity.ts` e `rpc-endpoint.ts` foram
   relidos; não foi aberto fallback de autorização para envelopes incompletos.
3. **404 indevido em rotas conhecidas.** O compilador dos padrões substituía
   apenas letras minúsculas em parâmetros. `:commandId`, por exemplo, virava
   `[^/]+Id`, exigindo um sufixo literal que um UUID real não possui. Agora
   reconhece o nome inteiro, inclusive camelCase e números. A aceitação percorre
   os padrões afetados, seus métodos e a recusa de segmentos extras.
4. **Hospedeiro ainda restrito às quatro chaves antigas.** O runtime não
   invalidava chamadas quando uma das cinco partes novas mudava e dependia de
   a casca ter instalado o contexto. Agora publica as nove partes, possui seu
   próprio contexto e o renova antes de liberar a posse anterior. A equivalência
   de contextos compara as nove autorizações efetivas, não a ordem das chaves
   nem módulos nativos irrelevantes. Um contexto encerrado continua recusando
   callbacks antigos; um hospedeiro novo pode estabelecer autorização nova.
5. **Resposta de prefetch exportada pelo adaptador substituído no teste.** A
   proteção de resposta foi extraída para `web/management/context-response.ts`
   e compartilhada pela casca e pelo transporte. Isso conserva um único corpo
   de implementação e a proteção após os cabeçalhos, inclusive a invalidação
   de `ok` e da leitura do corpo após aborto.
6. **Parte declarada ignorada numa exceção de destino.** `erpPartEnabled`
   conferia apenas o destino, permitindo que a combinação parte Fiscal +
   destino genérico de tags passasse com Fiscal desligado. Agora verifica
   também os requisitos da parte declarada. O agrupamento legado Resultados
   continua sem criar uma chave adicional.
7. **Objeto do modelo Assistência técnica trocado no registro.** A publicação
   criava uma cópia com versão 2; o objeto exportado ainda dizia versão 1. A
   versão publicada agora pertence à própria definição, e o catálogo registra
   a mesma referência. Nenhum tipo de trabalho ou concessão foi acrescentado.
8. **Checagem assíncrona antes do transporte.** `panelRequestAllowed` fazia
   `import()` a cada requisição, mesmo com o classificador já importado pelo
   painel. A requisição ainda não tinha chegado ao transporte quando o
   hospedeiro suspendia ou trocava de identidade. Isso explica os sinais de
   aborto ausentes e as respostas simuladas destinadas a uma geração sendo
   consumidas pela seguinte nos testes de hospedagem. A checagem agora é
   síncrona e usa o mesmo resolvedor. O sinal combinado é capturado antes de
   qualquer espera e conferido antes do envio e depois da resposta. Um 401
   cancelado não aciona a expiração. A leitura do corpo também fica vinculada
   à geração da requisição, inclusive se a suspensão ocorrer após os cabeçalhos.
   A comprovação local usa novos casos `node:test`, sem executar Vitest.
9. **Acesso à manutenção na entrada somente cadastral.** Foi incluído um
   atalho nas preferências da Base, além da entrada já existente na casa e do
   vínculo em documentos. Assim, abrir diretamente Clientes não exige conhecer
   a URL de manutenção quando a origem comercial estiver desligada.

### Alterações por arquivo

Os caminhos desta tabela são relativos à raiz do repositório. Ela descreve o
conjunto final da tarefa, inclusive o trabalho anterior a esta rodada.

| Arquivo | Alteração |
|---|---|
| `src/erp/schema/deviations.ts` | Catálogo informativo `ERP_PART_BEHAVIORS`, com condição, regra, motivo e referências a testes; separado de `ERP_DEVIATIONS`. |
| `src/erp/schema/structural.ts` | Registro estrutural das nove partes, envelope/KV, manutenção e ausência de mudança no esquema ERP. |
| `tests/erp/harness/dual-fixture.mjs` | Diferencial com as nove partes explicitamente ligadas. |
| `tests/erp/unico/f2-paridade.test.mjs` | Separação dos catálogos, ausência versus mapa completo, igualdade de DTOs/erros/tabelas e execução diferencial no Postgres local. |
| `tests/erp/unico/f2-aceite.test.mjs` | Inventário de rotas/RPCs, parâmetros camelCase, transporte/privacidade/cadastro técnico, matriz de postagem, parsers, replay e manutenção HTTP de efeitos históricos com versões. |
| `tests/f2-aceite.test.ts` | Demonstração real, navegação, batch D1/envelope/KV, aplicação, sistema e referência persistida suspensa. Escrito para a verificação externa, sem execução Vitest local. |
| `src/modules/erp/identity.ts` | Fotografia adiantada na consulta de pessoas do lote de autenticação; linha de controle independente da existência de pessoas, sem projetá-la como membro. |
| `src/modules/erp/parts-state.ts` | Decodificação compartilhada da fotografia e envelope aplicado pelo próprio RPC, conservando revisão/validade e ACK separado das entregas explícitas. |
| `src/erp/api/local-fetch.ts` | Uso da fotografia autenticada, transporte de partes e privacidade, portão obrigatório do cadastro técnico e bloqueio de partes também no armazenamento. |
| `src/erp/blocks.ts` | Famílias fiscais adicionais, aliases legados, rotas conhecidas e reconhecimento completo de parâmetros de rota. |
| `src/erp/parts-requirements.ts` | Alias `/visao-geral` na Base no resolvedor compartilhado. |
| `src/erp/engine/parts-gate.ts` | Inspeção somente de leitura com versão da origem, versões atuais dos títulos de nota e sequência da remessa. |
| `web/erp/modules.ts` | Uso do alias comum e conferência conjunta da parte declarada e do destino. |
| `web/erp/fetch-port.ts` | Comparação efetiva das nove autorizações, posse compartilhada, proteção de resposta extraída, checagem síncrona antes do envio e aborto da geração também antes de processar 401 e ao ler o corpo. |
| `web/erp/host-runtime.tsx` | Publicação/invalidação das nove partes e posse do contexto pelo hospedeiro. Este é o consumidor extraído de `mount.tsx` pela frente da casa única, cujo trecho de hospedagem é tratado em B16. |
| `web/erp/ErpArea.tsx` | Usa e reexporta a proteção compartilhada de resposta sem depender da exportação do adaptador de transporte. |
| `web/management/context-response.ts` | Implementação compartilhada da revogação de respostas já recebidas. |
| `web/erp/app/lib/origin-menu.ts` | Atalho para manutenção nas preferências da Base, sem reclassificar os itens legados. |
| `web/erp/app/components/ErpEffectMaintenance.tsx` | Consome versões dos títulos e sequência de remessa; conserva a recusa quando faltam dados obrigatórios. |
| `web/erp/test/f2-parts.test.mjs` | Aceitação de versões na manutenção, contexto encerrado, revogação/retomada, corpo de prefetch e atalho da Base; regressões novas de envio imediato, 401 antigo, troca de identidade com dois hospedeiros e suspensão após os cabeçalhos. A contagem de chamadas aguarda a revalidação de permissões terminar, mantendo a asserção de zero envio da operação suspensa. |
| `web/erp/blocks.test.mjs` | Registra as famílias fiscais na fotografia aditiva e confere sua recusa por parte desligada, preservando os cortes externos e o inventário antigo. |
| `web/erp/ORIGEM.json` | Registra as adaptações reais do painel e os arquivos novos; não altera os hashes de origem para esconder divergência. |
| `web/lib/demo.ts` | Estado explícito das cinco novas partes; catálogo de módulos com nomes, descrições e dependências reais; Fiscal/Cobrança permanecem desligados e PDV ligado. |
| `src/area-templates/index.ts` | Registra diretamente a definição publicada de Assistência técnica. |
| `src/area-templates/models/assistencia-tecnica.ts` | Versão 2 na definição publicada, correspondente à adaptação da fase 2. |
| `tests/erp-module-helper.ts` | Preparação comum `enableErpParts` e `ERP_CORE_TEST_MODULES`, equivalente à migração do núcleo antigo. |
| `tests/c-hospedagem.test.ts` | Somente preparação dos módulos de hospedagem, suspensão e retomada. |
| `tests/c-telas.test.ts` | Somente preparação do núcleo completo para as telas antigas. |
| `tests/erp-do-api.test.ts` | Somente ativação das partes usadas pela prova de leitura/escrita real. |
| `tests/erp-do-cnab-gate.test.ts` | Somente preparação das dependências do CNAB. |
| `tests/erp-do-hops.test.ts` | Somente preparação das partes usadas pela prova de uma ida ao objeto. |
| `tests/erp-do-module.test.ts` | Somente preparação da instalação antiga com núcleo completo. |
| `tests/erp-do-pdv-gate.test.ts` | Somente preparação das dependências do PDV. |
| `tests/erp-painel-rotas.test.ts` | Somente preparação das partes consumidas pelas rotas do painel. |
| `tests/erp-storage.test.ts` | Somente preparação das dependências ao ligar Cobrança; os usos antigos sem fotografia permanecem pendentes. |
| `tests/f1-erp-bridge.test.ts` | Somente o caso que consulta listas comerciais/financeiras liga essas partes; os casos do cadastro técnico continuam somente com Base. |
| `tests/management-navigation.test.ts` | Somente preparação de partes nos cenários de papéis Consulta e Financeiro. |
| `tests/management-ported.test.ts` | Somente preparação do antigo núcleo completo nos cenários de política portada. |
| `docs/ERP-FASE0.md` | Referência ao contrato final das partes e ao catálogo informativo. |
| `docs/ERP-AGENDADOR.md` | Estado explícito, TTL, revisões, entrega/ACK, cron, alarmes e limites de consistência. |
| `docs/ERP-FASE2.md` | Contrato integrado, manutenção, limites de A7/A8 e este relato consolidado. |

### Preparações alteradas em testes antigos

Não foram alteradas as asserções dos arquivos abaixo. As linhas indicam a
preparação na árvore atual; imports dos ajudantes também foram ajustados.

| Arquivo | Linhas de preparação |
|---|---|
| `tests/c-hospedagem.test.ts` | 81, 97, 117, 215, 225 |
| `tests/c-telas.test.ts` | 156 |
| `tests/erp-do-api.test.ts` | 47 |
| `tests/erp-do-cnab-gate.test.ts` | 41 |
| `tests/erp-do-hops.test.ts` | 27 |
| `tests/erp-do-module.test.ts` | 68 |
| `tests/erp-do-pdv-gate.test.ts` | 37 |
| `tests/erp-painel-rotas.test.ts` | 204 |
| `tests/erp-storage.test.ts` | 127, 301 |
| `tests/f1-erp-bridge.test.ts` | 381 — apenas o cenário de listas comerciais/financeiras |
| `tests/management-navigation.test.ts` | 175, 180 |
| `tests/management-ported.test.ts` | 75, 131, 191 |

`tests/erp-identity.test.ts`, `tests/c-fronteira-erp.test.ts` e
`tests/c-cadastro.test.ts` permanecem sem alterações. A mudança anterior em
`web/erp/blocks.test.mjs` é a exceção expressamente pedida no Acréscimo 3:
classificação fiscal passa a existir, mantendo a prova de recusa.

### Verificação desta rodada

<!-- F2_VALIDATION_RESULTS -->
| Comando | Resultado | Evidência local |
|---|---|---|
| `npm run check` | Aprovado, saída 0: marcadores, UTF-8, CSS e TypeScript. | `.f2-check-current.log` |
| `npm run build` | Aprovado, saída 0; avisos de diretivas de dependências do React Router. | `.f2-build-current.log` |
| `npm run test:erp:painel` | **2.236 aprovados, zero falhas, zero cancelados, zero pulados**, saída 0. Inclui os três novos casos, orçamento inicial, manifesto e textos de tela. | `.f2-painel-current.log` |
| `node --test tests/erp/blocks.test.mjs tests/erp/unico/f2-aceite.test.mjs tests/erp/unico/f2-paridade.test.mjs` | **17 aprovados, zero falhas, zero pulados**, saída 0, incluindo diferencial contra Postgres local. | `.f2-motor-current.log` |
| `npm run test:erp` — rodada anterior | **1.026 aprovados, zero falhas, zero pulados, 1 TODO preexistente**; 1.027 casos contabilizados. Não repetido integralmente nesta rodada: não houve mudança no motor, no oráculo ou no diferencial; o aceite focal foi repetido. | `.f2-erp-final.log` |
| `git diff --check` | Aprovado, saída vazia e código 0. | Saída local. |
| Vitest / Worker Cloudflare | **Não executado**, por instrução explícita. O último resultado externo é 278 arquivos/2.961 casos aprovados e 14 arquivos/28 casos reprovados; antecede a correção do transporte desta rodada. | `.codex-verificacao.log` |

O TODO já consta no `HEAD`, em
`tests/erp/fagoo/finance-invoice-postings-sql.test.mjs:282`, no caso
“248 pedido de compra Em aberto lança contas and still moves on to Em andamento”.
O arquivo e essa marcação não foram alterados. Não foi criado TODO para
ocultar falha nesta tarefa. O ciclo integral anterior do motor levou cerca de
16 minutos e 18 segundos, sem casos cancelados.

Na primeira execução focal desta rodada, a redução de esperas revelou uma
corrida no teste novo de contagem de chamadas: a revalidação de permissões
após a retomada ainda estava em voo. O teste agora espera essa revalidação
terminar antes de contar as chamadas da operação suspensa; conserva todas as
asserções e acrescenta a comprovação de permissões prontas. A primeira versão
do novo caso de envio imediato também tentava repetir uma verificação já
satisfeita pelo cache; sua preparação passou a iniciar a primeira verificação.
Nenhum teste Vitest antigo foi alterado nesta rodada.
<!-- /F2_VALIDATION_RESULTS -->

### Pedidos à base e decisões pendentes

Há uma correção de produção identificada **fora da matriz autorizada**:
`src/access.ts:routeAccess` devolve `erp-fiscal` como item de acesso para as
rotas do emissor/cofre. Os papéis continuam somente em `erp`, portanto uma
pessoa com `erp:consulta` é recusada antes de chegar ao leitor do emissor.
O ajuste proposto mapeia os proprietários das nove partes para o item de
acesso `erp`; o portão de ativação continua verificando a parte proprietária.
A proposta concreta está em [f2-access.patch](/private/tmp/f2-access.patch), ainda não aplicada.
Foi solicitada autorização porque a [Parte B da tarefa](/Volumes/Dev/wabotia/tarefas/f2-aceite.md:700) afirma: “Os arquivos citados como
evidência fora da matriz são somente leitura.”

O patch de acesso foi novamente conferido com `git apply --check` e a exceção
foi solicitada nesta rodada; sem resposta, não está aplicado. Essa é uma
regressão de produção, não uma expectativa obsoleta de teste.

A regra do Acréscimo do orquestrador permite nos testes antigos somente
alterar a preparação que liga módulos, para os casos que antes ligavam só
`erp` e consumiam outras partes. O [Acréscimo do orquestrador](/Volumes/Dev/wabotia/tarefas/f2-aceite.md:73) diz: “não pode alterar as asserções, nem
o que o teste confere, nem apagar caso”. Essa autorização não cobre trocar
expectativas de proprietários, cardinalidade, códigos HTTP, cron ou envelopes
internos. A exceção para adequar esses contratos, mantendo os casos e suas
proteções, foi solicitada nesta rodada e permanece sem resposta. Os casos
abaixo não foram afrouxados para apresentar a suíte verde.

### Destino das 28 falhas do último log externo

A contagem é do log recebido, não uma previsão do resultado após a correção.
A coluna final distingue regressão tratada, contrato incompatível e defeito
fora da matriz. Cada um dos 14 arquivos reprovados está representado.

| Arquivo | Casos no log | Diagnóstico e situação atual |
|---|---:|---|
| `area-template-juridico.test.ts` | 2 | Exige ausência de `juridico` em Advogados e Escritório de advocacia; A8 exige ativar Jurídico com OS. Corrigir o produto para satisfazer a asserção contrariaria o modelo contratado. Intacto. |
| `c-fronteira-erp.test.ts`, P11 | 1 | O segundo envelope direto, com `people: null`, omite `parts` e `partsControl`. A6 exige 503; o teste espera a validação de vendedor técnico dentro do motor. Precisa carregar a fotografia na preparação do envelope, conservando `people: null`, a recusa e o rollback. Isso excede a exceção atual de ligar módulos. Intacto. |
| `c-hospedagem.test.ts` | 3 | A espera no classificador foi removida: envio imediato, aborto e 401 antigo têm regressões locais aprovadas. Há ainda uma incompatibilidade posterior no terceiro caso: a linha 291 chama `/v1/cadastros/negado`, rota inexistente, esperando o 403 do transporte simulado. O portão bloqueia essa rota antes do transporte; é preciso autorizar a troca do endereço sintético por uma rota válida, preservando a asserção 403 e a revalidação. Não foi alterado. |
| `c-taxonomias.test.ts` | 3 | Exige Produtos = `erp`, Financeiro somente com Base e 403 para operação de parte desligada; A2/A4/A5 exigem proprietário específico e 409. O caso HTTP interno também omite fotografia e lê `items` do erro 503. Os cenários de recusa e de não mutação precisam permanecer ao atualizar o contrato. Intacto. |
| `erp-cron-scheduled.test.ts` | 1 | Observa `erp_blocks` e só aceita wake no início da hora. A7 usa fotografia revisionada e renovação a cada cinco minutos, inclusive desligamentos. Intacto. |
| `erp-do-emissor-route.test.ts` | 1 | Regressão confirmada em `src/access.ts`: `erp:consulta` é recusado pelo proprietário `erp-fiscal`, embora os papéis pertençam à Base. Patch pronto, fora da matriz, aguardando autorização explícita. |
| `erp-do-instance.test.ts` | 2 | Chama `/erp-wake` sem fotografia. A6 exige falhar fechado; a preparação precisa entregar estado explícito antes de provar o isolamento do D1 e os alarmes. Não foi aberto fallback. Intacto. |
| `erp-do-rpc-system.test.ts` | 1 | Envia apenas `SYSTEM_HEADER`. A6 exige também fotografia. Deve conservar a prova da marca interna, fornecendo o envelope completo no caso autorizado. Intacto. |
| `erp-storage.test.ts` | 2 | Os casos antigos de anexos não fornecem fotografia nem autorização do RPC para o objeto exato; o caso direto espera 415 antes de fornecer autorização válida e recebe 503. Não foi eliminado o portão do R2. As ativações de dependências feitas na rodada anterior foram mantidas; o restante precisa de atualização autorizada da preparação/expectativas. |
| `management-catalog.test.ts` | 5 | Exige prefixo do ID igual ao novo proprietário, todos os itens em `erp`, 43 contribuições e apenas a declaração `erp` contribuindo. A2/A5 preservam IDs, distribuem proprietários e acrescentam manutenção. A projeção legada mantém 43 destinos e a casa tem 44. Intacto. |
| `management-lifecycle.test.ts` | 3 | A revogação da leitura atrasada recebe a correção do transporte e cobertura local. Os outros dois casos exigem seletor para extensões nativas e Produtos com apenas `erp`, contrariando a entrada nativa de A5 e a separação de A2. Intacto. |
| `management-navigation.test.ts` | 1 | Exige seletor com várias extensões nativas, enquanto A5 determina abrir destino nativo elegível sem montar o portado. Intacto nesta rodada; mantém somente os ajustes anteriores de preparação dos papéis Consulta/Financeiro. |
| `management-ported.test.ts` | 2 | A espera antes do envio deixava a resposta simulada destinada à leitura anterior ser consumida pelo `/me` da nova identidade; o caso seguinte herdava a fila de respostas simuladas. O envio síncrono remove essa causa. O novo teste local cobre troca de ator, aborto, descarte do hospedeiro antigo e posse compartilhada. Ainda requer nova execução externa desses casos. |
| `os-integration.test.ts` | 1 | `os-integration-fixture.ts:282` exige `os_work_types.length` e depois OS ligado em todos os modelos. Restaurante de A8 usa `pedido`/`queue`, sem impor OS. Acrescentar OS ao modelo só para satisfazer esse ajudante mudaria o produto. Intacto. |

O log atual já não lista as falhas anteriores de `erp-identity`,
`erp-do-cnab-gate`, `f1-erp-bridge`, `f2-aceite` ou `os-area-templates`.
Isso é evidência do resultado externo recebido, não execução de Vitest
nesta rodada. Não se declara encerrado o aceite enquanto existirem as
incompatibilidades acima e a regressão de acesso não aplicada.

### Fora da entrega e dúvidas

- A aprovação integral exige nova execução externa de Vitest, depois de resolver
  as decisões acima. Não foi usado outro runner para disfarçar essa execução.
- A matriz não autoriza a correção de `src/access.ts`; a proposta não foi aplicada
  sem resposta. Não há autorização presumida pelo silêncio.
- O tratamento das asserções incompatíveis continua pendente: atualizar seus
  contratos mantendo os cenários e as proteções, ou registrar formalmente a
  incompatibilidade com o critério de suíte inteira verde.
- As limitações operacionais de A7/A8 descritas acima permanecem: sem transação
  distribuída, sem recomposição retroativa e sem ponte operacional automática
  de `os`/`pedido` para os domínios do ERP. Ligar Fiscal não instala emissor.
- Não foi feita validação visual em navegador nem chamada a serviço externo.
  Os testes do painel usam controladores, roteadores e componentes locais.
